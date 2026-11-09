//! The community store (plan 225, Phase A): the union of a linked person's
//! accounts, linking and splitting, retention per platform, forgetting, and
//! the backfill.

use std::collections::HashSet;

use chrono::{DateTime, TimeZone, Utc};

use super::*;
use crate::community::{
    CommunityLinkKind, CommunityListFilter, CommunityListParams, CommunityListSort,
    CommunityPersonParams, CommunityPersonStatus, ViewerMilestoneKind,
};
use crate::live_chat::{LiveChatEventDetails, LiveChatEventType, LiveChatMessage, fake_message};
use crate::streaming::StreamPlatform;

fn day(year: i32, month: u32, day: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(year, month, day, 12, 0, 0).unwrap()
}

fn chat(
    session_id: &str,
    platform: StreamPlatform,
    author_id: &str,
    name: &str,
    seq: u32,
    at: DateTime<Utc>,
) -> LiveChatMessage {
    let mut message = fake_message(session_id, platform, None, seq);
    message.author_id = Some(author_id.to_string());
    message.author_name = name.to_string();
    message.published_at = at.to_rfc3339();
    message.received_at = at.to_rfc3339();
    message.message_text = format!("hello #{seq}");
    message
}

fn facts(message: &LiveChatMessage) -> CommunityRowFacts {
    CommunityRowFacts::from_message(message, &HashSet::new()).unwrap()
}

/// A stream the store knows, then one chat row per `(platform, author,
/// name)` in it.
fn stream_with(
    database: &Database,
    session_id: &str,
    at: DateTime<Utc>,
    chatters: &[(StreamPlatform, &str, &str)],
) {
    let platforms: Vec<StreamPlatform> =
        chatters.iter().map(|(platform, _, _)| *platform).collect();
    database
        .community_record_stream(session_id, at, &platforms)
        .unwrap();
    let rows: Vec<CommunityRowFacts> = chatters
        .iter()
        .enumerate()
        .map(|(index, (platform, author, name))| {
            facts(&chat(session_id, *platform, author, name, index as u32, at))
        })
        .collect();
    database.community_record_batch(&rows, at).unwrap();
}

fn person_of(database: &Database, platform: StreamPlatform, author_id: &str) -> CommunityPerson {
    database
        .community_person(
            &CommunityPersonParams {
                platform: Some(platform),
                author_id: Some(author_id.to_string()),
                ..Default::default()
            },
            day(2026, 11, 8),
            3,
        )
        .unwrap()
}

fn lookup(
    database: &Database,
    session_id: &str,
    platform: StreamPlatform,
    author_id: &str,
    now: DateTime<Utc>,
) -> Option<ViewerArrival> {
    let mut arrived = HashSet::new();
    database
        .community_lookup_arrivals(
            session_id,
            &[(platform, author_id.to_string())],
            &HashSet::new(),
            &mut arrived,
            &mut None,
            now,
            3,
            false,
        )
        .unwrap()
        .remove(0)
        .arrival
}

#[test]
fn a_two_account_person_counts_the_union_and_a_split_restores_both_sides() {
    let database = Database::open_in_memory_for_tests();
    // Ada chats on Twitch in three streams and on YouTube in two others.
    stream_with(
        &database,
        "s1",
        day(2026, 10, 1),
        &[(StreamPlatform::Twitch, "t1", "Ada")],
    );
    stream_with(
        &database,
        "s2",
        day(2026, 10, 8),
        &[(StreamPlatform::Twitch, "t1", "Ada")],
    );
    stream_with(
        &database,
        "s3",
        day(2026, 10, 15),
        &[(StreamPlatform::Youtube, "y1", "ada_dev")],
    );
    stream_with(
        &database,
        "s4",
        day(2026, 10, 22),
        &[(StreamPlatform::Twitch, "t1", "Ada")],
    );
    stream_with(
        &database,
        "s5",
        day(2026, 10, 29),
        &[(StreamPlatform::Youtube, "y1", "ada_dev")],
    );
    let twitch = person_of(&database, StreamPlatform::Twitch, "t1");
    let youtube = person_of(&database, StreamPlatform::Youtube, "y1");
    assert_ne!(twitch.id, youtube.id);
    assert_eq!((twitch.streams, twitch.messages), (3, 3));
    assert_eq!((youtube.streams, youtube.messages), (2, 2));
    // Linked by the viewer: one person, the union.
    let kept = database
        .community_link(
            &twitch.id,
            &youtube.id,
            CommunityLinkKind::SelfLink,
            day(2026, 11, 1),
        )
        .unwrap();
    assert_eq!(kept, twitch.id, "the older person keeps its id");
    let ada = person_of(&database, StreamPlatform::Youtube, "y1");
    assert_eq!(ada.id, twitch.id);
    assert_eq!((ada.streams, ada.messages), (5, 5));
    assert_eq!(ada.in_a_row, 5);
    assert_eq!(ada.accounts.len(), 2);
    assert!(ada.regular);
    assert!(ada.youtube);
    assert_eq!(ada.link_events.len(), 1);
    assert_eq!(ada.link_events[0].kind, CommunityLinkKind::SelfLink);
    assert_eq!(ada.link_events[0].account_key, "youtube:y1");
    // The row and the list see one person on two platforms.
    let page = database
        .community_list(
            &CommunityListParams {
                filter: CommunityListFilter::Linked,
                sort: CommunityListSort::Streams,
                ..Default::default()
            },
            day(2026, 11, 8),
            3,
        )
        .unwrap();
    assert_eq!(page.people.len(), 1);
    assert_eq!(
        page.people[0].platforms,
        [StreamPlatform::Twitch, StreamPlatform::Youtube]
    );
    assert_eq!(page.people[0].streams, 5);
    // "Not the same person": every count comes back exactly.
    let split = database
        .community_unlink("youtube:y1", day(2026, 11, 2))
        .unwrap();
    assert_ne!(split, twitch.id);
    let twitch_again = person_of(&database, StreamPlatform::Twitch, "t1");
    let youtube_again = person_of(&database, StreamPlatform::Youtube, "y1");
    assert_eq!(youtube_again.id, split);
    assert_eq!((twitch_again.streams, twitch_again.messages), (3, 3));
    assert_eq!((youtube_again.streams, youtube_again.messages), (2, 2));
    assert_eq!(twitch_again.accounts.len(), 1);
    assert_eq!(youtube_again.accounts.len(), 1);
    assert!(youtube_again.note.is_empty());
    assert_eq!(
        twitch_again
            .link_events
            .iter()
            .filter(|event| event.kind == CommunityLinkKind::Split)
            .count(),
        1
    );
}

#[test]
fn a_manual_link_refuses_x_and_suggestions_never_name_x() {
    let database = Database::open_in_memory_for_tests();
    stream_with(
        &database,
        "s1",
        day(2026, 10, 1),
        &[
            (StreamPlatform::Kick, "k1", "MaxPlays"),
            (StreamPlatform::X, "x1", "max_plays"),
        ],
    );
    stream_with(
        &database,
        "s2",
        day(2026, 10, 2),
        &[(StreamPlatform::Twitch, "t1", "max plays")],
    );
    let kick = person_of(&database, StreamPlatform::Kick, "k1");
    let x = person_of(&database, StreamPlatform::X, "x1");
    let twitch = person_of(&database, StreamPlatform::Twitch, "t1");
    // The Kick and Twitch names match: one suggestion. X is never in one.
    assert_eq!(kick.suggestions.len(), 1);
    assert_eq!(kick.suggestions[0].account_a.account_key, "kick:k1");
    assert_eq!(kick.suggestions[0].account_b.account_key, "twitch:t1");
    assert!(x.suggestions.is_empty());
    assert_eq!(twitch.suggestions.len(), 1);
    assert_eq!(
        database.community_link(&kick.id, &x.id, CommunityLinkKind::Manual, day(2026, 10, 3)),
        Err(CommunityError::XSelfLinkOnly)
    );
    assert_eq!(CommunityError::XSelfLinkOnly.code(), "x-self-link-only");
    assert_eq!(
        database.community_suggestion_accept("kick:k1", "x:x1", day(2026, 10, 3)),
        Err(CommunityError::XSelfLinkOnly)
    );
    // The viewer's own `!link` may join an X account.
    let kept = database
        .community_link(
            &kick.id,
            &x.id,
            CommunityLinkKind::SelfLink,
            day(2026, 10, 3),
        )
        .unwrap();
    assert_eq!(person_of(&database, StreamPlatform::X, "x1").id, kept);
    // "Not the same" dismisses the Kick–Twitch pair for good.
    database
        .community_suggestion_dismiss("twitch:t1", "kick:k1")
        .unwrap();
    assert!(
        person_of(&database, StreamPlatform::Kick, "k1")
            .suggestions
            .is_empty()
    );
    let summary = database
        .community_summary(day(2026, 10, 3), 3, CommunityBackfill::default())
        .unwrap();
    assert_eq!(summary.links_pending, 0);
    assert_eq!(summary.people, 2);
    // A cancelled `!link` waits for the streamer.
    database
        .community_link_cancelled("twitch:t1", "kick:k1", day(2026, 10, 4))
        .unwrap();
    // Dismissed stays dismissed; a fresh pair opens.
    assert!(
        person_of(&database, StreamPlatform::Kick, "k1")
            .suggestions
            .is_empty()
    );
    stream_with(
        &database,
        "s3",
        day(2026, 10, 5),
        &[(StreamPlatform::Youtube, "y9", "Someone")],
    );
    database
        .community_link_cancelled("youtube:y9", "kick:k1", day(2026, 10, 5))
        .unwrap();
    let kick = person_of(&database, StreamPlatform::Kick, "k1");
    assert_eq!(kick.suggestions.len(), 1);
    assert_eq!(
        kick.suggestions[0].reason,
        CommunitySuggestionReason::LinkCancelled
    );
}

#[test]
fn memories_follow_their_account_through_a_split() {
    let database = Database::open_in_memory_for_tests();
    stream_with(
        &database,
        "s1",
        day(2026, 10, 1),
        &[(StreamPlatform::Twitch, "t1", "Bo")],
    );
    stream_with(
        &database,
        "s2",
        day(2026, 10, 2),
        &[(StreamPlatform::Kick, "k1", "bo")],
    );
    let twitch = person_of(&database, StreamPlatform::Twitch, "t1");
    let kick = person_of(&database, StreamPlatform::Kick, "k1");
    let kept = database
        .community_link(
            &twitch.id,
            &kick.id,
            CommunityLinkKind::Manual,
            day(2026, 10, 3),
        )
        .unwrap();
    {
        let conn = database.lock().unwrap();
        for (id, key, text) in [
            ("m1", "twitch:t1", "Learning Rust"),
            ("m2", "kick:k1", "Has a cat called Pixel"),
        ] {
            conn.execute(
                "INSERT INTO community_memories (id, person_id, account_key, text, session_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 's2', ?5, ?5)",
                rusqlite::params![id, kept, key, text, day(2026, 10, 3).to_rfc3339()],
            )
            .unwrap();
        }
    }
    assert_eq!(
        person_of(&database, StreamPlatform::Kick, "k1")
            .memories
            .len(),
        2
    );
    let split = database
        .community_unlink("kick:k1", day(2026, 10, 4))
        .unwrap();
    let twitch = person_of(&database, StreamPlatform::Twitch, "t1");
    let kick = person_of(&database, StreamPlatform::Kick, "k1");
    assert_eq!(kick.id, split);
    assert_eq!(
        twitch
            .memories
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["m1"]
    );
    assert_eq!(
        kick.memories
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["m2"]
    );
    assert!(database.community_memory_delete("m2").unwrap());
    assert!(
        person_of(&database, StreamPlatform::Kick, "k1")
            .memories
            .is_empty()
    );
}

#[test]
fn arrivals_come_for_returning_people_only_with_the_milestone_and_back() {
    let database = Database::open_in_memory_for_tests();
    let streamer: HashSet<String> = ["twitch:me".to_string()].into_iter().collect();
    // Four earlier streams for Kim on Twitch.
    for (index, date) in [
        day(2026, 9, 1),
        day(2026, 9, 8),
        day(2026, 9, 15),
        day(2026, 9, 22),
    ]
    .into_iter()
    .enumerate()
    {
        stream_with(
            &database,
            &format!("s{index}"),
            date,
            &[
                (StreamPlatform::Twitch, "kim", "Kim"),
                (StreamPlatform::Twitch, "nightbot", "Nightbot"),
            ],
        );
    }
    // Stream five starts on 2026-11-08 (47 days later).
    let now = day(2026, 11, 8);
    database
        .community_record_stream("s5", now, &[StreamPlatform::Twitch, StreamPlatform::Kick])
        .unwrap();
    let mut arrived = HashSet::new();
    let lookups = database
        .community_lookup_arrivals(
            "s5",
            &[
                (StreamPlatform::Twitch, "kim".to_string()),
                (StreamPlatform::Twitch, "nightbot".to_string()),
                (StreamPlatform::Twitch, "me".to_string()),
                (StreamPlatform::Kick, "newcomer".to_string()),
                (StreamPlatform::Custom, "rtmp".to_string()),
            ],
            &streamer,
            &mut arrived,
            &mut None,
            now,
            3,
            false,
        )
        .unwrap();
    let kim = lookups[0].arrival.clone().expect("Kim returns");
    assert_eq!(kim.streams, 5, "including this stream");
    assert_eq!(kim.in_a_row, 5);
    assert!(kim.regular);
    assert_eq!(kim.away_days, Some(47));
    assert_eq!(
        kim.milestone,
        Some(ViewerMilestone {
            kind: ViewerMilestoneKind::Streams,
            value: 5
        })
    );
    assert_eq!(kim.since.as_deref(), Some("2026-09"));
    assert!(
        kim.platforms.is_empty(),
        "one account: no platforms on the row"
    );
    assert!(lookups[1].arrival.is_none(), "a bot never arrives");
    assert!(lookups[2].arrival.is_none(), "the streamer never arrives");
    assert!(lookups[3].arrival.is_none(), "a first-timer never arrives");
    assert!(lookups[3].person_id.is_none());
    assert!(lookups[4].arrival.is_none(), "custom RTMP has no identity");
    // The same person again in this stream: no second arrival.
    assert!(
        lookup(&database, "s5", StreamPlatform::Twitch, "kim", now).is_none() || {
            let mut again = arrived.clone();
            database
                .community_lookup_arrivals(
                    "s5",
                    &[(StreamPlatform::Twitch, "kim".to_string())],
                    &streamer,
                    &mut again,
                    &mut None,
                    now,
                    3,
                    false,
                )
                .unwrap()[0]
                .arrival
                .is_none()
        }
    );
    // The arrival row's milestone is marked celebrated by the write.
    let mut row = chat("s5", StreamPlatform::Twitch, "kim", "Kim", 1, now);
    row.arrival = Some(kim.clone());
    database
        .community_record_batch(&[facts(&row)], now)
        .unwrap();
    let person = person_of(&database, StreamPlatform::Twitch, "kim");
    assert_eq!(person.milestones, ["streams-5"]);
    assert_eq!(person.streams, 5);
    assert_eq!(person.best_in_a_row, 5);
    // A two-account person gets one arrival whichever account chats first.
    stream_with(
        &database,
        "s6",
        day(2026, 11, 9),
        &[(StreamPlatform::Kick, "kimk", "Kim")],
    );
    let kick = person_of(&database, StreamPlatform::Kick, "kimk");
    database
        .community_link(
            &person.id,
            &kick.id,
            CommunityLinkKind::Manual,
            day(2026, 11, 9),
        )
        .unwrap();
    let later = day(2026, 11, 10);
    database
        .community_record_stream("s7", later, &[StreamPlatform::Twitch, StreamPlatform::Kick])
        .unwrap();
    let mut arrived = HashSet::new();
    let first = database
        .community_lookup_arrivals(
            "s7",
            &[(StreamPlatform::Kick, "kimk".to_string())],
            &streamer,
            &mut arrived,
            &mut None,
            later,
            3,
            false,
        )
        .unwrap();
    let arrival = first[0].arrival.clone().unwrap();
    assert_eq!(
        arrival.platforms,
        [StreamPlatform::Kick, StreamPlatform::Twitch]
    );
    assert_eq!(arrival.streams, 7);
    let second = database
        .community_lookup_arrivals(
            "s7",
            &[(StreamPlatform::Twitch, "kim".to_string())],
            &streamer,
            &mut arrived,
            &mut None,
            later,
            3,
            false,
        )
        .unwrap();
    assert!(
        second[0].arrival.is_none(),
        "the other account: no second arrival"
    );
}

#[test]
fn support_adds_up_and_never_counts_as_attendance() {
    let database = Database::open_in_memory_for_tests();
    database
        .community_record_stream(
            "s1",
            day(2026, 10, 1),
            &[StreamPlatform::Twitch, StreamPlatform::Youtube],
        )
        .unwrap();
    let mut cheer = chat(
        "s1",
        StreamPlatform::Twitch,
        "t1",
        "Ada",
        0,
        day(2026, 10, 1),
    );
    cheer.event_type = LiveChatEventType::Paid;
    cheer.details = Some(LiveChatEventDetails::Cheer { bits: 1500 });
    let mut follow = chat(
        "s1",
        StreamPlatform::Twitch,
        "t2",
        "Bo",
        1,
        day(2026, 10, 1),
    );
    follow.event_type = LiveChatEventType::Follow;
    let mut gift = chat(
        "s1",
        StreamPlatform::Twitch,
        "t2",
        "Bo",
        2,
        day(2026, 10, 1),
    );
    gift.event_type = LiveChatEventType::Membership;
    gift.details = Some(LiveChatEventDetails::Subscription {
        subscription: crate::live_chat::SubscriptionKind::CommunitySubGift,
        tier: None,
        is_prime: false,
        months: None,
        streak_months: None,
        gift_count: Some(3),
        recipient_name: None,
        community_gift_id: None,
    });
    let mut tip = chat(
        "s1",
        StreamPlatform::Youtube,
        "y1",
        "Cy",
        3,
        day(2026, 10, 1),
    );
    tip.event_type = LiveChatEventType::Paid;
    tip.details = Some(LiveChatEventDetails::SuperChat {
        amount_micros: 20_000_000,
        currency: "usd".to_string(),
        amount_display: "$20".to_string(),
        tier: None,
    });
    let rows: Vec<CommunityRowFacts> = [&cheer, &follow, &gift, &tip]
        .iter()
        .map(|m| facts(m))
        .collect();
    database
        .community_record_batch(&rows, day(2026, 10, 1))
        .unwrap();
    let ada = person_of(&database, StreamPlatform::Twitch, "t1");
    assert_eq!(ada.support.bits, 1500);
    assert_eq!(
        (ada.streams, ada.messages),
        (1, 1),
        "a paid message counts as chat"
    );
    let bo = person_of(&database, StreamPlatform::Twitch, "t2");
    assert_eq!(bo.support.gifted_subs, 3);
    assert_eq!(
        (bo.streams, bo.messages),
        (0, 0),
        "follows and gifts are not attendance"
    );
    let cy = person_of(&database, StreamPlatform::Youtube, "y1");
    assert_eq!(cy.support.tips.get("USD"), Some(&20_000_000));
    assert_eq!(
        serde_json::to_value(&cy.support).unwrap(),
        serde_json::json!({ "tips": { "USD": 20000000 } })
    );
}

#[test]
fn retention_prunes_youtube_at_thirty_days_and_keeps_twitch_and_the_linked_person() {
    let database = Database::open_in_memory_for_tests();
    // Ada: YouTube on 2026-09-01 and Twitch the same day; linked.
    stream_with(
        &database,
        "s1",
        day(2026, 9, 1),
        &[
            (StreamPlatform::Youtube, "y1", "Ada"),
            (StreamPlatform::Twitch, "t1", "Ada"),
        ],
    );
    let youtube = person_of(&database, StreamPlatform::Youtube, "y1");
    let twitch = person_of(&database, StreamPlatform::Twitch, "t1");
    let kept = database
        .community_link(
            &youtube.id,
            &twitch.id,
            CommunityLinkKind::Manual,
            day(2026, 9, 2),
        )
        .unwrap();
    // Bo: YouTube only, same day. Cy: Twitch only, long ago.
    stream_with(
        &database,
        "s0",
        day(2025, 9, 1),
        &[(StreamPlatform::Twitch, "cy", "Cy")],
    );
    stream_with(
        &database,
        "s2",
        day(2026, 9, 1),
        &[(StreamPlatform::Youtube, "bo", "Bo")],
    );
    // A note on Bo, and a memory from his YouTube words.
    let bo = person_of(&database, StreamPlatform::Youtube, "bo");
    database
        .community_update(&bo.id, Some("Likes cats"), None, day(2026, 9, 2))
        .unwrap();
    {
        let conn = database.lock().unwrap();
        conn.execute(
            "INSERT INTO community_memories (id, person_id, account_key, text, session_id, created_at, updated_at)
             VALUES ('m1', ?1, 'youtube:bo', 'cats', 's2', ?2, ?2)",
            rusqlite::params![bo.id, day(2026, 9, 2).to_rfc3339()],
        )
        .unwrap();
    }
    // Day 29 for the YouTube accounts: they stay. Cy's Twitch account is
    // twelve months past its last chat: it goes.
    assert_eq!(database.community_prune(day(2026, 9, 30)).unwrap(), 1);
    assert_eq!(database.community_account_status("twitch:cy"), None);
    assert_eq!(
        person_of(&database, StreamPlatform::Youtube, "bo").streams,
        1
    );
    // Day 31: every YouTube account older than 30 days goes, with its
    // attendance, memories and (for Bo) the person, note included. Twitch
    // stays, and Ada's person survives on her Twitch account alone.
    let now = day(2026, 10, 2);
    let removed = database.community_prune(now).unwrap();
    assert_eq!(removed, 2);
    assert_eq!(database.community_account_status("youtube:bo"), None);
    assert_eq!(database.community_account_status("youtube:y1"), None);
    let bo_again = person_of(&database, StreamPlatform::Youtube, "bo");
    assert_eq!((bo_again.streams, bo_again.messages), (0, 0));
    assert!(bo_again.note.is_empty());
    assert!(bo_again.memories.is_empty());
    assert!(bo_again.id.is_empty(), "the person is gone");
    {
        let conn = database.lock().unwrap();
        let memories: i64 = conn
            .query_row("SELECT COUNT(*) FROM community_memories", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(memories, 0);
        let youtube_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM community_attendance WHERE account_key LIKE 'youtube:%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(youtube_rows, 0, "nothing about a YouTube account survives");
    }
    let ada = person_of(&database, StreamPlatform::Twitch, "t1");
    assert_eq!(ada.id, kept);
    assert_eq!(ada.accounts.len(), 1);
    assert_eq!((ada.streams, ada.messages), (1, 1));
    assert!(!ada.youtube);
    assert_eq!(
        database
            .community_account_status("twitch:t1")
            .map(|(_, s)| s),
        Some(CommunityPersonStatus::Normal)
    );
    // Nothing else is due.
    assert_eq!(database.community_prune(now).unwrap(), 0);
}

#[test]
fn forgetme_leaves_a_tombstone_that_later_chat_never_revives_until_rememberme() {
    let database = Database::open_in_memory_for_tests();
    stream_with(
        &database,
        "s1",
        day(2026, 10, 1),
        &[
            (StreamPlatform::Twitch, "t1", "Ada"),
            (StreamPlatform::Kick, "k1", "Ada"),
        ],
    );
    let twitch = person_of(&database, StreamPlatform::Twitch, "t1");
    let kick = person_of(&database, StreamPlatform::Kick, "k1");
    let kept = database
        .community_link(
            &twitch.id,
            &kick.id,
            CommunityLinkKind::Manual,
            day(2026, 10, 2),
        )
        .unwrap();
    database
        .community_update(&kept, Some("Rust learner"), None, day(2026, 10, 2))
        .unwrap();
    // `!forgetme` from the Kick account: its attendance goes, the person
    // stays on Twitch with the note.
    assert_eq!(
        database
            .community_forget_account("kick:k1", day(2026, 10, 3))
            .unwrap()
            .as_deref(),
        Some("Ada")
    );
    assert_eq!(
        database.community_account_status("kick:k1").map(|(_, s)| s),
        Some(CommunityPersonStatus::Forgotten)
    );
    let ada = person_of(&database, StreamPlatform::Twitch, "t1");
    assert_eq!(ada.accounts.len(), 1);
    assert_eq!(ada.note, "Rust learner");
    assert_eq!((ada.streams, ada.messages), (1, 1));
    // Later chat from the forgotten account changes nothing: no arrival, no
    // attendance, no new person.
    stream_with(
        &database,
        "s2",
        day(2026, 10, 9),
        &[(StreamPlatform::Kick, "k1", "Ada")],
    );
    assert_eq!(
        database.community_account_status("kick:k1").map(|(_, s)| s),
        Some(CommunityPersonStatus::Forgotten)
    );
    assert!(
        lookup(
            &database,
            "s3",
            StreamPlatform::Kick,
            "k1",
            day(2026, 10, 16)
        )
        .is_none()
    );
    let forgotten = person_of(&database, StreamPlatform::Kick, "k1");
    assert_eq!(forgotten.status, CommunityPersonStatus::Forgotten);
    assert_eq!(forgotten.streams, 0);
    // The list never shows a forgotten person; the summary never counts one.
    let summary = database
        .community_summary(day(2026, 10, 16), 3, CommunityBackfill::default())
        .unwrap();
    assert_eq!(summary.people, 1);
    // `!rememberme` lifts the tombstone: the next chat learns them afresh.
    assert!(database.community_remember_account("kick:k1").unwrap());
    assert!(!database.community_remember_account("kick:k1").unwrap());
    stream_with(
        &database,
        "s3",
        day(2026, 10, 16),
        &[(StreamPlatform::Kick, "k1", "Ada")],
    );
    let fresh = person_of(&database, StreamPlatform::Kick, "k1");
    assert_eq!(fresh.status, CommunityPersonStatus::Normal);
    assert_eq!((fresh.streams, fresh.messages), (1, 1));
    assert_ne!(fresh.id, kept, "a new person, not the old one");
    // `!forgetme` from the last account forgets the person, note and all.
    database
        .community_forget_account("twitch:t1", day(2026, 10, 17))
        .unwrap();
    let gone = person_of(&database, StreamPlatform::Twitch, "t1");
    assert!(gone.id.is_empty());
    assert!(gone.note.is_empty());
    // Forget everyone: nothing is left but the tombstones (F3): Ada's
    // Twitch `!forgetme` outlives the streamer's wipe, with no person.
    database.community_forget_all(day(2026, 10, 17)).unwrap();
    assert_eq!(
        database.community_account_status("twitch:t1"),
        Some((String::new(), CommunityPersonStatus::Forgotten))
    );
    assert_eq!(database.community_account_status("kick:k1"), None);
    stream_with(
        &database,
        "s4",
        day(2026, 10, 18),
        &[(StreamPlatform::Twitch, "t1", "Ada")],
    );
    assert_eq!(
        database.community_account_status("twitch:t1").map(|(_, s)| s),
        Some(CommunityPersonStatus::Forgotten),
        "still never learned again"
    );
    {
        let conn = database.lock().unwrap();
        let people: i64 = conn
            .query_row("SELECT COUNT(*) FROM community_people", [], |row| row.get(0))
            .unwrap();
        assert_eq!(people, 0, "the forgotten account has no person");
    }
    database.community_forget_account("x:gone", day(2026, 10, 18)).unwrap();
    database.community_forget_all(day(2026, 10, 19)).unwrap();
    assert!(
        database.community_export(day(2026, 10, 19)).unwrap().people.iter().all(|person| {
            person.status == "forgotten" && person.accounts.iter().all(|a| a.name.is_empty())
        }),
        "only nameless tombstones export after a wipe"
    );
    assert_eq!(
        database
            .community_summary(day(2026, 10, 17), 3, CommunityBackfill::default())
            .unwrap()
            .people,
        0
    );
    // A `!forgetme` from an account the store never met still keeps it out.
    assert_eq!(
        database
            .community_forget_account("x:never", day(2026, 10, 18))
            .unwrap(),
        None
    );
    assert_eq!(
        database.community_account_status("x:never").map(|(_, s)| s),
        Some(CommunityPersonStatus::Forgotten)
    );
}

#[test]
fn an_unknown_account_is_a_zero_count_person_and_the_note_is_bounded() {
    let database = Database::open_in_memory_for_tests();
    let unknown = database
        .community_person(
            &CommunityPersonParams {
                platform: Some(StreamPlatform::Youtube),
                author_id: Some("UCnew".to_string()),
                name: Some("Newbie".to_string()),
                ..Default::default()
            },
            day(2026, 11, 8),
            3,
        )
        .unwrap();
    assert!(unknown.id.is_empty());
    assert_eq!(unknown.name, "Newbie");
    assert_eq!(unknown.accounts.len(), 1);
    assert_eq!(unknown.accounts[0].account_key, "youtube:UCnew");
    assert_eq!((unknown.streams, unknown.messages), (0, 0));
    assert!(unknown.youtube);
    assert_eq!(
        database.community_person(&CommunityPersonParams::default(), day(2026, 11, 8), 3),
        Err(CommunityError::Invalid(
            "personId, or platform and authorId, are required.".to_string()
        ))
    );
    assert_eq!(
        database.community_person(
            &CommunityPersonParams {
                person_id: Some("nope".to_string()),
                ..Default::default()
            },
            day(2026, 11, 8),
            3
        ),
        Err(CommunityError::NotFound)
    );
    stream_with(
        &database,
        "s1",
        day(2026, 10, 1),
        &[(StreamPlatform::Twitch, "t1", "Ada")],
    );
    let ada = person_of(&database, StreamPlatform::Twitch, "t1");
    let long = "x".repeat(400);
    database
        .community_update(
            &ada.id,
            Some(&long),
            Some(CommunityPersonStatus::Bot),
            day(2026, 10, 2),
        )
        .unwrap();
    let ada = person_of(&database, StreamPlatform::Twitch, "t1");
    assert_eq!(ada.note.chars().count(), 300);
    assert_eq!(ada.status, CommunityPersonStatus::Bot);
    assert!(matches!(
        database.community_update(
            &ada.id,
            None,
            Some(CommunityPersonStatus::Forgotten),
            day(2026, 10, 2)
        ),
        Err(CommunityError::Invalid(_))
    ));
    // A bot never arrives.
    database
        .community_record_stream("s2", day(2026, 10, 8), &[StreamPlatform::Twitch])
        .unwrap();
    assert!(
        lookup(
            &database,
            "s2",
            StreamPlatform::Twitch,
            "t1",
            day(2026, 10, 8)
        )
        .is_none()
    );
    // The wire never carries a null for an absent field.
    let json = serde_json::to_value(&unknown).unwrap();
    for field in [
        "avatarUrl",
        "awayDays",
        "firstSeenAt",
        "lastSeenAt",
        "milestones",
        "memories",
        "suggestions",
        "linkEvents",
    ] {
        assert!(
            json.get(field).is_none(),
            "{field} should be absent, got {:?}",
            json.get(field)
        );
    }
}

/// A3: a fixture database with four platforms and six sessions.
fn backfill_fixture(database: &Database) -> HashSet<String> {
    let sessions = [
        ("b1", day(2026, 8, 1)),
        ("b2", day(2026, 9, 1)),
        ("b3", day(2026, 10, 1)),
        ("b4", day(2026, 10, 15)),
        ("b5", day(2026, 10, 29)),
        ("b6", day(2026, 11, 5)),
    ];
    for (id, started_at) in sessions {
        database.ensure_fake_live_chat_session(id).unwrap();
        let conn = database.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET started_at = ?2 WHERE id = ?1",
            rusqlite::params![id, started_at.to_rfc3339()],
        )
        .unwrap();
    }
    let mut seq = 0u32;
    let mut say = |session: &str,
                   at: DateTime<Utc>,
                   platform: StreamPlatform,
                   author: &str,
                   name: &str,
                   times: u32| {
        for _ in 0..times {
            seq += 1;
            let message = chat(session, platform, author, name, seq, at);
            database.save_live_chat_message(&message).unwrap();
        }
    };
    // Ada on Twitch in every stream; Bo on Kick in four; Cy on X in two;
    // Dee on YouTube in b1 (old, dropped), b5 and b6; the streamer on Twitch.
    for (id, at) in sessions {
        say(id, at, StreamPlatform::Twitch, "ada", "Ada", 3);
        say(id, at, StreamPlatform::Twitch, "me", "Streamer", 1);
    }
    for (id, at) in &sessions[2..] {
        say(id, *at, StreamPlatform::Kick, "bo", "Bo", 2);
    }
    say("b5", day(2026, 10, 29), StreamPlatform::X, "cy", "Cy", 1);
    say("b6", day(2026, 11, 5), StreamPlatform::X, "cy", "Cy", 4);
    say(
        "b1",
        day(2026, 8, 1),
        StreamPlatform::Youtube,
        "dee",
        "Dee",
        5,
    );
    say(
        "b5",
        day(2026, 10, 29),
        StreamPlatform::Youtube,
        "dee",
        "Dee",
        1,
    );
    say(
        "b6",
        day(2026, 11, 5),
        StreamPlatform::Youtube,
        "dee",
        "Dee",
        1,
    );
    ["twitch:me".to_string()].into_iter().collect()
}

fn run_backfill(
    database: &Database,
    streamer: &HashSet<String>,
    skip_after: Option<usize>,
) -> Vec<(String, DateTime<Utc>)> {
    let sessions = database.community_backfill_sessions().unwrap();
    let now = day(2026, 11, 8);
    for (index, (id, started_at)) in sessions.iter().enumerate() {
        if skip_after.is_some_and(|stop| index >= stop) {
            break;
        }
        database
            .community_backfill_session(id, *started_at, streamer, now)
            .unwrap();
    }
    sessions
}

fn snapshot(database: &Database) -> Vec<(String, String, u32, u64, u32, bool)> {
    let mut rows = Vec::new();
    for (platform, author) in [
        (StreamPlatform::Twitch, "ada"),
        (StreamPlatform::Kick, "bo"),
        (StreamPlatform::X, "cy"),
        (StreamPlatform::Youtube, "dee"),
        (StreamPlatform::Twitch, "me"),
    ] {
        let person = person_of(database, platform, author);
        rows.push((
            person.accounts[0].account_key.clone(),
            person.first_seen_at.clone().unwrap_or_default(),
            person.streams,
            person.messages,
            person.in_a_row,
            person.regular,
        ));
    }
    rows
}

#[test]
fn the_backfill_folds_six_sessions_in_time_order_with_youtube_limited_to_thirty_days() {
    let database = Database::open_in_memory_for_tests();
    let streamer = backfill_fixture(&database);
    let sessions = run_backfill(&database, &streamer, None);
    assert_eq!(
        sessions
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        ["b1", "b2", "b3", "b4", "b5", "b6"],
        "oldest first"
    );
    let ada = person_of(&database, StreamPlatform::Twitch, "ada");
    assert_eq!((ada.streams, ada.messages, ada.in_a_row), (6, 18, 6));
    assert!(ada.regular);
    assert_eq!(
        ada.first_seen_at.as_deref().map(|s| &s[..10]),
        Some("2026-08-01")
    );
    let bo = person_of(&database, StreamPlatform::Kick, "bo");
    assert_eq!((bo.streams, bo.messages, bo.in_a_row), (4, 8, 4));
    let cy = person_of(&database, StreamPlatform::X, "cy");
    assert_eq!((cy.streams, cy.messages, cy.in_a_row), (2, 5, 2));
    assert!(!cy.regular);
    // Dee's August chat is older than 30 days: YouTube keeps the two recent
    // streams only, and "first seen" never reaches back past them.
    let dee = person_of(&database, StreamPlatform::Youtube, "dee");
    assert_eq!((dee.streams, dee.messages), (2, 2));
    assert_eq!(
        dee.first_seen_at.as_deref().map(|s| &s[..10]),
        Some("2026-10-29")
    );
    // The streamer is never a person.
    let me = person_of(&database, StreamPlatform::Twitch, "me");
    assert!(me.id.is_empty());
    let summary = database
        .community_summary(day(2026, 11, 8), 3, CommunityBackfill::default())
        .unwrap();
    assert_eq!(
        (summary.people, summary.streams, summary.regulars),
        (4, 6, 2)
    );
    // A second run changes nothing.
    let before = snapshot(&database);
    run_backfill(&database, &streamer, None);
    assert_eq!(snapshot(&database), before);
    // A resumed run equals an uninterrupted one.
    let resumed = Database::open_in_memory_for_tests();
    let streamer = backfill_fixture(&resumed);
    run_backfill(&resumed, &streamer, Some(3));
    assert_eq!(
        person_of(&resumed, StreamPlatform::Twitch, "ada").streams,
        3
    );
    let sessions = resumed.community_backfill_sessions().unwrap();
    for (id, started_at) in &sessions[3..] {
        resumed
            .community_backfill_session(id, *started_at, &streamer, day(2026, 11, 8))
            .unwrap();
    }
    assert_eq!(snapshot(&resumed), before);
}

#[test]
fn export_and_import_round_trip_and_a_tombstone_wins() {
    let database = Database::open_in_memory_for_tests();
    stream_with(
        &database,
        "s1",
        day(2026, 10, 1),
        &[
            (StreamPlatform::Twitch, "t1", "Ada"),
            (StreamPlatform::Kick, "k1", "Bo"),
        ],
    );
    stream_with(
        &database,
        "s2",
        day(2026, 10, 8),
        &[(StreamPlatform::Twitch, "t1", "Ada")],
    );
    let ada = person_of(&database, StreamPlatform::Twitch, "t1");
    database
        .community_update(&ada.id, Some("Rust"), None, day(2026, 10, 9))
        .unwrap();
    database
        .community_forget_account("kick:k1", day(2026, 10, 9))
        .unwrap();
    let file = database.community_export(day(2026, 10, 10)).unwrap();
    assert_eq!(file.version, EXPORT_VERSION);
    assert_eq!(file.streams.len(), 2);
    let json = serde_json::to_string(&file).unwrap();
    assert!(
        !json.contains("\"Bo\""),
        "a forgotten account exports no name"
    );
    // Into a store where Bo chatted again and Ada has a Kick account too.
    let other = Database::open_in_memory_for_tests();
    stream_with(
        &other,
        "s3",
        day(2026, 10, 11),
        &[
            (StreamPlatform::Kick, "k1", "Bo"),
            (StreamPlatform::Kick, "k2", "ada"),
        ],
    );
    let parsed: CommunityExportFile = serde_json::from_str(&json).unwrap();
    let (people, merged) = other.community_import(&parsed, day(2026, 10, 12)).unwrap();
    assert!(people >= 2);
    assert_eq!(merged, 0, "Ada's Twitch account was new here");
    let ada = person_of(&other, StreamPlatform::Twitch, "t1");
    assert_eq!((ada.streams, ada.messages), (2, 2));
    assert_eq!(ada.note, "Rust");
    assert_eq!(
        other.community_account_status("kick:k1").map(|(_, s)| s),
        Some(CommunityPersonStatus::Forgotten),
        "the tombstone wins"
    );
    // Importing again is a merge, not a double.
    let (_, merged) = other.community_import(&parsed, day(2026, 10, 13)).unwrap();
    assert_eq!(merged, 1);
    assert_eq!(person_of(&other, StreamPlatform::Twitch, "t1").messages, 2);
}

#[test]
fn a_stream_counts_its_first_timers_and_those_who_stayed_forty_minutes() {
    let database = Database::open_in_memory_for_tests();
    // Ada chatted before; Bo and Kim are new in s2; Kim stays 45 minutes.
    stream_with(
        &database,
        "s1",
        day(2026, 10, 1),
        &[(StreamPlatform::Twitch, "t1", "Ada")],
    );
    let start = day(2026, 10, 8);
    stream_with(
        &database,
        "s2",
        start,
        &[
            (StreamPlatform::Twitch, "t1", "Ada"),
            (StreamPlatform::Twitch, "t2", "Bo"),
            (StreamPlatform::Kick, "k3", "Kim"),
        ],
    );
    let later = start + chrono::Duration::minutes(45);
    database
        .community_record_batch(
            &[facts(&chat(
                "s2",
                StreamPlatform::Kick,
                "k3",
                "Kim",
                9,
                later,
            ))],
            later,
        )
        .unwrap();
    // Bo's second message 10 minutes in: not stayed.
    let soon = start + chrono::Duration::minutes(10);
    database
        .community_record_batch(
            &[facts(&chat(
                "s2",
                StreamPlatform::Twitch,
                "t2",
                "Bo",
                10,
                soon,
            ))],
            soon,
        )
        .unwrap();
    assert_eq!(
        database.community_session_first_timers("s2").unwrap(),
        (2, 1)
    );
    // s1's only chatter was a first-timer there; an unknown stream has none.
    assert_eq!(
        database.community_session_first_timers("s1").unwrap(),
        (1, 0)
    );
    assert_eq!(
        database.community_session_first_timers("nope").unwrap(),
        (0, 0)
    );
}

/// D10: with "Buddy remembers" on, the newest three memories and the
/// streamer's note ride the arrival (for one delivery, never the wire);
/// off, the arrival carries neither.
#[test]
fn memories_and_the_note_ride_the_arrival_only_with_remember_on() {
    let database = Database::open_in_memory_for_tests();
    stream_with(
        &database,
        "s1",
        day(2026, 10, 1),
        &[(StreamPlatform::Twitch, "1", "Ada")],
    );
    let ada = person_of(&database, StreamPlatform::Twitch, "1");
    let at = day(2026, 10, 2);
    let adds = [
        ("Learning Rust".to_string(), "twitch:1".to_string()),
        ("Collects keyboards".to_string(), "twitch:1".to_string()),
    ];
    assert_eq!(
        database
            .community_memories_apply(&ada.id, "s1", &adds, &[], &[], at)
            .unwrap(),
        2
    );
    database
        .community_update(&ada.id, Some("Friend from the Rust meetup"), None, at)
        .unwrap();
    database
        .community_record_stream("s2", day(2026, 11, 8), &[StreamPlatform::Twitch])
        .unwrap();
    let streamer = HashSet::new();
    let lookup_with = |remember: bool| {
        let mut arrived = HashSet::new();
        database
            .community_lookup_arrivals(
                "s2",
                &[(StreamPlatform::Twitch, "1".to_string())],
                &streamer,
                &mut arrived,
                &mut None,
                day(2026, 11, 8),
                3,
                remember,
            )
            .unwrap()
            .remove(0)
            .arrival
            .unwrap()
    };
    let off = lookup_with(false);
    assert!(off.memories.is_empty());
    assert!(off.note.is_none());
    let on = lookup_with(true);
    // Both were learned in the same second: their order between them is
    // the store's to choose.
    let mut remembered = on.memories.clone();
    remembered.sort();
    assert_eq!(remembered, vec!["Collects keyboards", "Learning Rust"]);
    assert_eq!(on.note.as_deref(), Some("Friend from the Rust meetup"));
    // Never on the wire or in SQLite: the serialized arrival has no memories.
    let wire = serde_json::to_value(&on).unwrap();
    assert!(wire.get("memories").is_none() && wire.get("note").is_none());
    // The cap holds: two new and eight in all per person.
    let more: Vec<(String, String)> = (0..5)
        .map(|index| (format!("Fact {index}"), "twitch:1".to_string()))
        .collect();
    assert_eq!(
        database
            .community_memories_apply(&ada.id, "s2", &more, &[], &[], at)
            .unwrap(),
        2,
        "at most two new per pass"
    );
    for _ in 0..3 {
        database
            .community_memories_apply(&ada.id, "s2", &more, &[], &[], at)
            .unwrap();
    }
    assert_eq!(
        person_of(&database, StreamPlatform::Twitch, "1")
            .memories
            .len(),
        8,
        "at most eight in all"
    );
}

/// The review of 2026-11-09, F2: a forget leaves no trace. The account's
/// link events go with it (forget, the person's deletion and the prune),
/// and the names in past reports' Community blocks are scrubbed, while the
/// counts stay (the report counts opt-outs, never names them, D13).
#[test]
fn a_forget_takes_the_link_events_and_the_past_reports_names_with_it() {
    use crate::protocol::{
        CohostReportCommunity, CohostReportCommunityMilestone, CohostReportCommunityPerson,
        CohostSessionReport,
    };
    let database = Database::open_in_memory_for_tests();
    stream_with(
        &database,
        "s1",
        day(2026, 10, 1),
        &[
            (StreamPlatform::Twitch, "t1", "Ada"),
            (StreamPlatform::Kick, "k1", "Ada"),
            (StreamPlatform::Twitch, "t2", "Bo"),
        ],
    );
    let twitch = person_of(&database, StreamPlatform::Twitch, "t1");
    let kick = person_of(&database, StreamPlatform::Kick, "k1");
    let kept = database
        .community_link(
            &twitch.id,
            &kick.id,
            CommunityLinkKind::Manual,
            day(2026, 10, 2),
        )
        .unwrap();
    assert_eq!(
        person_of(&database, StreamPlatform::Twitch, "t1")
            .link_events
            .len(),
        1
    );
    // A past report names Ada (Twitch) as a regular and Bo's milestone.
    database.ensure_fake_live_chat_session("s1").unwrap();
    let block = CohostReportCommunity {
        regulars_back: 2,
        regulars: vec![
            CohostReportCommunityPerson {
                name: "Ada".to_string(),
                platform: StreamPlatform::Twitch,
                platforms: vec![StreamPlatform::Kick, StreamPlatform::Twitch],
                streams: 5,
            },
            CohostReportCommunityPerson {
                name: "Bo".to_string(),
                platform: StreamPlatform::Twitch,
                platforms: Vec::new(),
                streams: 4,
            },
        ],
        milestones: vec![CohostReportCommunityMilestone {
            name: "Bo".to_string(),
            platform: StreamPlatform::Twitch,
            milestone: ViewerMilestone {
                kind: ViewerMilestoneKind::Streams,
                value: 5,
            },
        }],
        ..Default::default()
    };
    database
        .upsert_cohost_report(&CohostSessionReport::community_only(
            "s1",
            block,
            &day(2026, 10, 1).to_rfc3339(),
        ))
        .unwrap();
    // `!forgetme` from the Kick account: its link event goes; the report
    // still names Ada on Twitch (a different account) and Bo.
    database
        .community_forget_account("kick:k1", day(2026, 10, 3))
        .unwrap();
    let ada = person_of(&database, StreamPlatform::Twitch, "t1");
    assert_eq!(ada.id, kept);
    assert!(
        ada.link_events.is_empty(),
        "the forgotten account's link event is gone: {:?}",
        ada.link_events
    );
    let report = |database: &Database| {
        database
            .get_cohost_report("s1")
            .unwrap()
            .unwrap()
            .community
            .unwrap()
    };
    assert_eq!(report(&database).regulars.len(), 2);
    // `!forgetme` from the Twitch account: Ada leaves the report by name,
    // the count stays.
    database
        .community_forget_account("twitch:t1", day(2026, 10, 4))
        .unwrap();
    let scrubbed = report(&database);
    assert_eq!(scrubbed.regulars_back, 2, "counts stay");
    assert_eq!(
        scrubbed
            .regulars
            .iter()
            .map(|person| person.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Bo"]
    );
    assert_eq!(scrubbed.milestones.len(), 1);
    {
        let conn = database.lock().unwrap();
        let events: i64 = conn
            .query_row("SELECT COUNT(*) FROM community_link_events", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(events, 0, "no link event outlives its person");
    }
    // "Forget Bo…" scrubs his milestone and his name too.
    let bo = person_of(&database, StreamPlatform::Twitch, "t2");
    database
        .community_forget_person(&bo.id, day(2026, 10, 5))
        .unwrap();
    let scrubbed = report(&database);
    assert!(scrubbed.regulars.is_empty());
    assert!(scrubbed.milestones.is_empty());
    assert_eq!(scrubbed.regulars_back, 2);
    // The prune takes a pruned person's link events too.
    stream_with(
        &database,
        "s2",
        day(2025, 1, 1),
        &[
            (StreamPlatform::Twitch, "old1", "Old"),
            (StreamPlatform::Kick, "old2", "Old"),
        ],
    );
    let a = person_of(&database, StreamPlatform::Twitch, "old1");
    let b = person_of(&database, StreamPlatform::Kick, "old2");
    database
        .community_link(&a.id, &b.id, CommunityLinkKind::Manual, day(2025, 1, 2))
        .unwrap();
    assert_eq!(database.community_prune(day(2026, 10, 6)).unwrap(), 2);
    {
        let conn = database.lock().unwrap();
        let events: i64 = conn
            .query_row("SELECT COUNT(*) FROM community_link_events", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(events, 0);
    }
}

/// The review of 2026-11-09, F4: the arrival lookup rides the delivery
/// path, so a raid must not cost queries per author. 400 fresh authors,
/// half of them known from an earlier stream, are looked up with one
/// statement per table (plus the one-time stream read the session caches),
/// and the answers are the same as before.
#[test]
fn a_raid_of_four_hundred_fresh_authors_costs_one_read_per_table() {
    use rusqlite::trace::{TraceEvent, TraceEventCodes};
    use std::sync::atomic::{AtomicUsize, Ordering};
    static STATEMENTS: AtomicUsize = AtomicUsize::new(0);
    fn count(event: TraceEvent<'_>) {
        if matches!(event, TraceEvent::Stmt(..)) {
            STATEMENTS.fetch_add(1, Ordering::SeqCst);
        }
    }
    let database = Database::open_in_memory_for_tests();
    let known: Vec<(StreamPlatform, String, String)> = (0..200)
        .map(|index| {
            (
                StreamPlatform::Twitch,
                format!("known{index}"),
                format!("Known {index}"),
            )
        })
        .collect();
    let chatters: Vec<(StreamPlatform, &str, &str)> = known
        .iter()
        .map(|(platform, id, name)| (*platform, id.as_str(), name.as_str()))
        .collect();
    stream_with(&database, "s1", day(2026, 10, 1), &chatters);
    stream_with(&database, "s2", day(2026, 10, 8), &chatters);
    database
        .community_record_stream("s3", day(2026, 10, 15), &[StreamPlatform::Twitch])
        .unwrap();
    let mut authors: Vec<(StreamPlatform, String)> = known
        .iter()
        .map(|(platform, id, _)| (*platform, id.clone()))
        .collect();
    authors.extend((0..200).map(|index| (StreamPlatform::Twitch, format!("new{index}"))));
    {
        let conn = database.lock().unwrap();
        conn.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(count));
    }
    let mut arrived = HashSet::new();
    let mut streams = None;
    STATEMENTS.store(0, Ordering::SeqCst);
    let lookups = database
        .community_lookup_arrivals(
            "s3",
            &authors,
            &HashSet::new(),
            &mut arrived,
            &mut streams,
            day(2026, 10, 15),
            3,
            true,
        )
        .unwrap();
    let cold = STATEMENTS.load(Ordering::SeqCst);
    assert!(
        cold <= 8,
        "a raid of 400 cost {cold} statements (streams, accounts, people, live accounts, attendance, memories)"
    );
    assert_eq!(lookups.len(), 400);
    let arrivals = lookups.iter().filter(|l| l.arrival.is_some()).count();
    assert_eq!(arrivals, 200, "every known person arrived once");
    assert!(
        lookups
            .iter()
            .filter(|l| l.key.starts_with("twitch:new"))
            .all(|l| l.person_id.is_none() && l.arrival.is_none())
    );
    let one = lookups
        .iter()
        .find(|l| l.key == "twitch:known7")
        .and_then(|l| l.arrival.as_ref())
        .unwrap();
    assert_eq!((one.streams, one.in_a_row, one.regular), (3, 3, true));
    assert_eq!(arrived.len(), 200);
    assert!(streams.as_ref().is_some_and(|s| s.len() == 3), "cached");
    // Warm: the streams are cached, and nobody arrives twice.
    STATEMENTS.store(0, Ordering::SeqCst);
    let again = database
        .community_lookup_arrivals(
            "s3",
            &authors,
            &HashSet::new(),
            &mut arrived,
            &mut streams,
            day(2026, 10, 15),
            3,
            true,
        )
        .unwrap();
    let warm = STATEMENTS.load(Ordering::SeqCst);
    assert!(warm <= 6, "warm: {warm}");
    assert!(again.iter().all(|l| l.arrival.is_none()));
    {
        let conn = database.lock().unwrap();
        conn.trace_v2(TraceEventCodes::empty(), None);
    }
}
