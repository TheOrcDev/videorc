use super::*;

fn test_state() -> AppState {
    let (events, _) = broadcast::channel(64);
    AppState::new(
        "test-token".to_string(),
        0,
        events,
        crate::storage::Database::open_in_memory_for_tests(),
    )
}

fn has_null(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => true,
        serde_json::Value::Array(items) => items.iter().any(has_null),
        serde_json::Value::Object(map) => map.values().any(has_null),
        _ => false,
    }
}

#[test]
fn an_empty_row_reads_as_the_defaults() {
    let settings: StoredSettings = serde_json::from_str("{}").unwrap();
    assert_eq!(settings, StoredSettings::default());
    assert!(settings.enabled, "on once a webhook is saved");
    assert!(settings.branding, "branded by default (D5)");
    assert_eq!(settings.ping, DiscordPing::None, "no ping by default (D4)");
    assert_eq!(settings.post_as, PostAs::Automatic);
}

#[test]
fn the_snapshot_never_carries_null() {
    // The renderer's optional fields accept a missing key, never `null`.
    let snapshot = DiscordAnnounceSnapshot {
        webhook_present: false,
        webhook_hint: None,
        webhook_name: None,
        enabled: true,
        ping: DiscordPing::None,
        branding: true,
        post_as: PostAs::Automatic,
        excluded_target_ids: Vec::new(),
        link_overrides: BTreeMap::new(),
        identities: vec![PostAsIdentity {
            post_as: PostAs::Videorc,
            name: "Orc".to_string(),
            platform: None,
            avatar_url: None,
        }],
        last_post: Some(LastPost {
            at: "2026-10-22T18:02:00Z".to_string(),
            message_url: None,
            state: LastPostState::Ended,
        }),
        last_error: None,
    };
    let json = serde_json::to_value(&snapshot).unwrap();
    assert!(!has_null(&json), "{json}");
    assert_eq!(json["ping"], "none");
    assert_eq!(json["postAs"], serde_json::json!({ "kind": "automatic" }));
    assert_eq!(json["lastPost"]["state"], "ended");

    let preview = LinksPreviewResult {
        links: vec![LinkPreview {
            target_id: "t".to_string(),
            label: "TikTok".to_string(),
            link_kind: links::LinkKind::None,
            link: None,
            included: false,
        }],
        sender: None,
    };
    let json = serde_json::to_value(&preview).unwrap();
    assert!(!has_null(&json), "{json}");
    assert_eq!(json["links"][0]["linkKind"], "none");
}

#[test]
fn the_last_message_round_trips() {
    let message = LastMessage {
        webhook_id: "1".to_string(),
        message_id: "2".to_string(),
        channel_id: None,
        session_id: "s".to_string(),
        started_at: Utc::now(),
        last_seen_live_at: Utc::now(),
        ended_at: None,
        live: true,
        posted_at: Utc::now(),
        title: "t".to_string(),
        links: vec![LinkButton {
            label: "Twitch".to_string(),
            url: "https://www.twitch.tv/a".to_string(),
        }],
        branding: true,
        image_filename: None,
    };
    let json = serde_json::to_string(&message).unwrap();
    assert_eq!(serde_json::from_str::<LastMessage>(&json).unwrap(), message);
}

#[test]
fn refusals_read_as_section_sentences() {
    assert_eq!(
        RpcError::from_send(SendError::WebhookGone).message,
        "This webhook was deleted in Discord. Paste a new one."
    );
    assert_eq!(
        RpcError::from_send(SendError::Unreachable).code,
        "discord-unreachable"
    );
    assert_eq!(
        RpcError::from_send(SendError::Rejected {
            status: 403,
            code: None
        })
        .code,
        "discord-rejected"
    );
}

#[test]
fn update_params_refuse_unknown_fields() {
    assert!(
        serde_json::from_value::<UpdateParams>(serde_json::json!({ "url": "x" })).is_err(),
        "the webhook URL never goes through update"
    );
    let params: UpdateParams = serde_json::from_value(serde_json::json!({
        "ping": "everyone",
        "postAs": { "kind": "platform", "accountId": "acct-1" },
        "linkOverride": { "targetId": "t1" }
    }))
    .unwrap();
    assert_eq!(params.ping, Some(DiscordPing::Everyone));
    assert_eq!(params.link_override.unwrap().link, None);
}

#[tokio::test]
async fn update_saves_choices_and_typed_links() {
    let state = test_state();
    let snapshot = update(
        &state,
        UpdateParams {
            ping: Some(DiscordPing::Here),
            branding: Some(false),
            excluded_target_ids: Some(vec!["b".to_string(), "a".to_string(), "a".to_string()]),
            link_override: Some(LinkOverrideChange {
                target_id: "tiktok".to_string(),
                link: Some(" https://www.tiktok.com/@orc/live ".to_string()),
            }),
            ..UpdateParams::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(snapshot.ping, DiscordPing::Here);
    assert!(!snapshot.branding);
    assert_eq!(snapshot.excluded_target_ids, vec!["a", "b"]);
    assert_eq!(
        snapshot.link_overrides.get("tiktok").map(String::as_str),
        Some("https://www.tiktok.com/@orc/live")
    );

    let cleared = update(
        &state,
        UpdateParams {
            link_override: Some(LinkOverrideChange {
                target_id: "tiktok".to_string(),
                link: None,
            }),
            ..UpdateParams::default()
        },
    )
    .await
    .unwrap();
    assert!(cleared.link_overrides.is_empty());
    assert_eq!(cleared.ping, DiscordPing::Here, "untouched fields stay");
}

#[tokio::test]
async fn update_refuses_bad_links_and_floods() {
    let state = test_state();
    let refused = update(
        &state,
        UpdateParams {
            link_override: Some(LinkOverrideChange {
                target_id: "x".to_string(),
                link: Some("javascript:alert(1)".to_string()),
            }),
            ..UpdateParams::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, "discord-invalid-link");
    let flood = update(
        &state,
        UpdateParams {
            excluded_target_ids: Some((0..65).map(|index| index.to_string()).collect()),
            ..UpdateParams::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(flood.code, "invalid-params");
    assert!(load_settings(&state).link_overrides.is_empty());
}

#[tokio::test]
async fn a_pasted_url_that_is_not_discord_is_refused_before_any_request() {
    let state = test_state();
    let refused = save_webhook(
        &state,
        SaveWebhookParams {
            url: "https://example.com/api/webhooks/1/abc".to_string(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, "discord-invalid-url");
    assert_eq!(refused.message, "That isn't a Discord webhook URL.");
}

#[tokio::test]
async fn sessions_without_destinations_send_no_fact() {
    let state = test_state();
    let (sender, mut receiver) = mpsc::channel(4);
    state.discord_announce.facts.set(sender).unwrap();
    let status = RecordingStatus {
        replay_only: false,
        state: RecordingState::Recording,
        session_id: Some("s1".to_string()),
        output_path: None,
        stream_url: None,
        started_at: None,
        audio_tracks: Vec::new(),
        pipeline: None,
        duration_ms: None,
        message: None,
    };
    on_session_started(&state, &status, None);
    assert!(receiver.try_recv().is_err(), "a recording-only session");
    on_youtube_live(&state, "b1", Some(StreamPrivacy::Public));
    assert!(matches!(
        receiver.try_recv(),
        Ok(HookFact::YouTubeLive { .. })
    ));
}

#[test]
fn remote_clients_cannot_reach_the_discord_methods() {
    use crate::backend_authority::{BackendRole, authorize_backend_method};
    for method in [
        "discord.announce.get",
        "discord.announce.update",
        "discord.webhook.save",
        "discord.webhook.remove",
        "discord.webhook.sendTest",
        "discord.links.preview",
    ] {
        assert!(
            authorize_backend_method(BackendRole::Remote, method, false).is_err(),
            "{method}"
        );
        assert!(authorize_backend_method(BackendRole::Renderer, method, false).is_ok());
    }
}
