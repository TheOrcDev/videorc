use super::*;
use crate::live_chat::{LiveChatEventType, LiveChatMessageFragment, live_chat_message_id};
use crate::streaming::StreamPlatform;

fn message(session_id: &str, seq: u32, text: &str) -> LiveChatMessage {
    let provider_message_id = format!("provider-{seq}");
    LiveChatMessage {
        id: live_chat_message_id(
            session_id,
            StreamPlatform::Twitch,
            Some("target-twitch"),
            &provider_message_id,
        ),
        provider_message_id,
        platform: StreamPlatform::Twitch,
        target_id: Some("target-twitch".to_string()),
        session_id: session_id.to_string(),
        author_id: Some(format!("author-{seq}")),
        author_name: format!("Viewer {seq}"),
        author_avatar_url: Some("https://static-cdn.jtvnw.net/user-default-pictures/a.png".into()),
        author_badges: Vec::new(),
        author_roles: Vec::new(),
        published_at: format!("2026-11-09T10:{:02}:{:02}Z", seq / 60, seq % 60),
        received_at: format!("2026-11-09T10:{:02}:{:02}Z", seq / 60, seq % 60),
        message_text: text.to_string(),
        fragments: vec![LiveChatMessageFragment {
            fragment_type: "text".to_string(),
            text: text.to_string(),
            image_url: None,
            zero_width: false,
        }],
        event_type: LiveChatEventType::Message,
        amount_text: None,
        is_deleted: false,
        raw_provider_type: None,
        details: None,
        reply: None,
        first_message: false,
        first_in_session: false,
        author_handle: None,
        author_affiliation: None,
        author_verified: None,
    }
}

fn seed(database: &Database, session_id: &str, count: u32) {
    database.ensure_fake_live_chat_session(session_id).unwrap();
    let messages = (0..count)
        .map(|seq| message(session_id, seq, &format!("message {seq}")))
        .collect::<Vec<_>>();
    database.save_live_chat_messages(&messages).unwrap();
}

#[test]
fn a_history_is_the_saved_transcript_with_its_saved_stats() {
    let database = Database::open_in_memory_for_tests();
    seed(&database, "history-a", 3);
    let cache = CommentsHistoryCache::default();
    let history = history(&cache, &database, "history-a", false).unwrap();
    assert_eq!(history.session_id, "history-a");
    assert_eq!(
        history
            .messages
            .iter()
            .map(|message| message.message_text.as_str())
            .collect::<Vec<_>>(),
        ["message 0", "message 1", "message 2"]
    );
    assert!(history.latest_send_operation.is_none());
    assert!(history.viewers.is_empty());
    assert!(history.audience.is_none());
    // The wire shape the strict contract reads: absent send operation,
    // explicit nulls for the stats a session may lack.
    let json = serde_json::to_value(&history).unwrap();
    assert!(json.get("latestSendOperation").is_none());
    assert!(json["audience"].is_null());
    assert!(json["viewers"].as_array().unwrap().is_empty());
    assert_eq!(json["sessionId"], "history-a");
    assert_eq!(json["messages"].as_array().unwrap().len(), 3);
    if let Some(totals) = &history.chat_totals {
        assert_eq!(totals_session_id(totals), "history-a");
    }
}

#[test]
fn a_finished_session_is_read_from_the_cache_and_a_live_one_never() {
    let database = Database::open_in_memory_for_tests();
    seed(&database, "finished", 2);
    seed(&database, "live", 2);
    let cache = CommentsHistoryCache::default();
    assert_eq!(
        history(&cache, &database, "finished", false)
            .unwrap()
            .messages
            .len(),
        2
    );
    // A message saved later does not show: the cache answers, as main's did.
    database
        .save_live_chat_message(&message("finished", 9, "late"))
        .unwrap();
    assert_eq!(
        history(&cache, &database, "finished", false)
            .unwrap()
            .messages
            .len(),
        2
    );
    // A deleted session leaves the cache; the next read is fresh.
    cache.remove("finished");
    assert_eq!(
        history(&cache, &database, "finished", false)
            .unwrap()
            .messages
            .len(),
        3
    );

    // The running session is read fresh every time and never cached.
    assert_eq!(
        history(&cache, &database, "live", true)
            .unwrap()
            .messages
            .len(),
        2
    );
    database
        .save_live_chat_message(&message("live", 9, "new"))
        .unwrap();
    assert_eq!(
        history(&cache, &database, "live", true)
            .unwrap()
            .messages
            .len(),
        3
    );
    assert_eq!(cache.stats().0, 1, "only the finished session is held");
}

#[test]
fn a_transcript_keeps_the_newest_messages_within_the_message_and_byte_caps() {
    let messages = (0..10)
        .map(|seq| message("bounded", seq, &format!("message {seq}")))
        .collect::<Vec<_>>();
    let (kept, bytes) = bound_transcript(messages.clone(), 4, usize::MAX);
    assert_eq!(
        kept.iter()
            .map(|message| message.message_text.clone())
            .collect::<Vec<_>>(),
        ["message 6", "message 7", "message 8", "message 9"]
    );
    assert_eq!(bytes, serde_json::to_vec(&kept).unwrap().len());

    // Over the byte cap the oldest quarter goes until it fits.
    let one = serde_json::to_vec(&messages[..1]).unwrap().len();
    let (kept, bytes) = bound_transcript(messages.clone(), 10, one * 5);
    assert!(bytes <= one * 5);
    assert_eq!(kept.last().unwrap().message_text, "message 9");
    assert!(kept.len() < 10 && !kept.is_empty());

    let (kept, _) = bound_transcript(messages, 10, 1);
    assert!(kept.is_empty());
}

#[test]
fn the_cache_holds_eight_sessions_and_two_thousand_messages_in_all() {
    let database = Database::open_in_memory_for_tests();
    let cache = CommentsHistoryCache::default();
    for index in 0..10 {
        let session_id = format!("session-{index}");
        seed(&database, &session_id, 1);
        history(&cache, &database, &session_id, false).unwrap();
    }
    let (sessions, messages, _) = cache.stats();
    assert_eq!(sessions, MAX_SESSIONS);
    assert_eq!(messages, MAX_SESSIONS);
    // The least recently read went first.
    assert!(cache.get("session-0").is_none());
    assert!(cache.get("session-1").is_none());
    assert!(cache.get("session-9").is_some());

    // One full transcript evicts the rest, never itself.
    seed(&database, "full", MAX_MESSAGES as u32);
    assert_eq!(
        history(&cache, &database, "full", false)
            .unwrap()
            .messages
            .len(),
        MAX_MESSAGES
    );
    let (sessions, messages, bytes) = cache.stats();
    assert_eq!((sessions, messages), (1, MAX_MESSAGES));
    assert!(bytes <= MAX_BYTES);
    assert!(cache.get("full").is_some());
}
