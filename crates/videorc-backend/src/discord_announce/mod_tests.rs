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

fn meta(id: &str) -> WebhookMeta {
    WebhookMeta {
        id: id.to_string(),
        name: Some(format!("Server {id}")),
        channel_id: format!("c{id}"),
        guild_id: Some(format!("g{id}")),
        hint: "…/a1B2".to_string(),
        verified_at: "2026-10-22T18:00:00Z".to_string(),
        components_refused: false,
        last_error: None,
    }
}

fn last_message(webhook_id: &str, session_id: &str) -> LastMessage {
    LastMessage {
        webhook_id: webhook_id.to_string(),
        message_id: format!("m{webhook_id}"),
        channel_id: None,
        session_id: session_id.to_string(),
        started_at: Utc::now(),
        last_seen_live_at: Utc::now(),
        ended_at: None,
        live: true,
        posted_at: Utc::now(),
        title: "t".to_string(),
        links: Vec::new(),
        branding: true,
        image_filename: None,
    }
}

fn url(id: &str) -> WebhookUrl {
    WebhookUrl::parse(&format!("https://discord.com/api/webhooks/{id}/tok_{id}")).unwrap()
}

#[test]
fn an_empty_row_reads_as_the_defaults() {
    let settings: StoredSettings = serde_json::from_str("{}").unwrap();
    assert_eq!(settings, StoredSettings::default());
    assert!(settings.enabled, "on once a webhook is saved");
    assert!(settings.branding, "branded by default (D5)");
    assert_eq!(settings.ping, DiscordPing::None, "no ping by default (D4)");
    assert_eq!(settings.post_as, PostAs::Automatic);
    assert!(settings.webhooks.is_empty());
}

#[test]
fn a_plan_187_row_folds_its_one_webhook_into_the_list() {
    // Before there were several, the row held `webhook` and a global
    // `lastError`. That webhook keeps working, carrying its failure.
    let row = serde_json::json!({
        "ping": "here",
        "webhook": {
            "id": "1", "name": "Stream alerts", "channelId": "c1", "guildId": "g1",
            "hint": "…/a1B2", "verifiedAt": "2026-10-22T18:00:00Z", "componentsRefused": true
        },
        "lastError": { "code": "unreachable", "at": "2026-10-22T18:03:00Z" }
    });
    let settings = serde_json::from_value::<StoredSettings>(row)
        .unwrap()
        .fold_legacy();
    assert_eq!(settings.webhooks.len(), 1);
    let folded = &settings.webhooks[0];
    assert_eq!(folded.id, "1");
    assert_eq!(folded.name.as_deref(), Some("Stream alerts"));
    assert!(folded.components_refused);
    assert_eq!(
        folded.last_error.as_ref().map(|error| error.code),
        Some(AnnounceErrorCode::Unreachable)
    );
    assert_eq!(settings.ping, DiscordPing::Here, "the shared choices stay");
    assert!(settings.webhook.is_none() && settings.last_error.is_none());

    // Saved again, the row carries the list only.
    let saved = serde_json::to_value(&settings).unwrap();
    assert!(saved.get("webhook").is_none() && saved.get("lastError").is_none());
    assert_eq!(saved["webhooks"][0]["id"], "1");
    assert_eq!(saved["webhooks"][0]["lastError"]["code"], "unreachable");

    // A row that already lists the same webhook never gets it twice.
    let both = serde_json::json!({
        "webhooks": [{ "id": "1", "channelId": "c1", "hint": "…/a1B2", "verifiedAt": "x" }],
        "webhook": { "id": "1", "channelId": "c1", "hint": "…/a1B2", "verifiedAt": "x" },
        "lastError": { "code": "rejected", "at": "2026-10-22T18:03:00Z" }
    });
    let settings = serde_json::from_value::<StoredSettings>(both)
        .unwrap()
        .fold_legacy();
    assert_eq!(settings.webhooks.len(), 1);
    assert!(
        settings.webhooks[0].last_error.is_none(),
        "a stale global error never lands on a listed webhook"
    );

    // Folded in front: it was connected first.
    let older = serde_json::json!({
        "webhooks": [{ "id": "2", "channelId": "c2", "hint": "…/zzzz", "verifiedAt": "x" }],
        "webhook": { "id": "1", "channelId": "c1", "hint": "…/a1B2", "verifiedAt": "x" }
    });
    let settings = serde_json::from_value::<StoredSettings>(older)
        .unwrap()
        .fold_legacy();
    assert_eq!(
        settings
            .webhooks
            .iter()
            .map(|meta| meta.id.as_str())
            .collect::<Vec<_>>(),
        ["1", "2"]
    );
}

#[test]
fn the_last_messages_read_the_plan_187_shape_too() {
    let one = serde_json::to_value(last_message("1", "s1")).unwrap();
    assert_eq!(parse_last_messages(one.clone()).len(), 1, "one object");
    let two = parse_last_messages(serde_json::json!([
        one,
        serde_json::to_value(last_message("2", "s1")).unwrap()
    ]));
    assert_eq!(
        two.iter()
            .map(|message| message.webhook_id.as_str())
            .collect::<Vec<_>>(),
        ["1", "2"]
    );
    assert!(
        parse_last_messages(serde_json::Value::Null).is_empty(),
        "a removal wrote null"
    );
    assert!(parse_last_messages(serde_json::json!([{ "broken": true }])).is_empty());
}

#[test]
fn one_message_is_kept_per_webhook() {
    let mut messages = vec![last_message("1", "s1"), last_message("2", "s1")];
    let mut newer = last_message("1", "s2");
    newer.message_id = "m1-newer".to_string();
    put_last_message(&mut messages, newer);
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].message_id, "m1-newer", "replaced in place");
    assert_eq!(messages[1].webhook_id, "2");
    put_last_message(&mut messages, last_message("3", "s2"));
    assert_eq!(messages.len(), 3);
    forget_last_message(&mut messages, "1");
    assert_eq!(
        messages
            .iter()
            .map(|message| message.webhook_id.as_str())
            .collect::<Vec<_>>(),
        ["2", "3"]
    );
}

#[test]
fn a_webhook_secret_falls_back_to_the_single_secret_for_its_own_id() {
    let secrets: BTreeMap<&str, String> = BTreeMap::from([
        (WEBHOOK_SECRET_REF, url("1").to_secret_string()),
        ("discord.webhook.url.2", url("2").to_secret_string()),
    ]);
    let read = |secret_ref: &str| secrets.get(secret_ref).cloned();
    assert_eq!(webhook_secret_ref("2"), "discord.webhook.url.2");
    assert_eq!(
        resolve_webhook_url("2", read).as_ref().map(WebhookUrl::id),
        Some("2")
    );
    assert_eq!(
        resolve_webhook_url("1", read).as_ref().map(WebhookUrl::id),
        Some("1"),
        "a webhook saved before there were several still resolves"
    );
    assert!(
        resolve_webhook_url("3", read).is_none(),
        "the single secret never answers for another id"
    );
    // A per-id secret holding some other webhook's URL is not trusted either.
    let crossed = |secret_ref: &str| {
        (secret_ref == "discord.webhook.url.4").then(|| url("5").to_secret_string())
    };
    assert!(resolve_webhook_url("4", crossed).is_none());
}

#[test]
fn secret_writes_retire_the_single_secret_only_for_its_own_webhook() {
    let (secret_ref, removals) = secret_writes_for_save(&url("1"), Some("1"));
    assert_eq!(secret_ref, "discord.webhook.url.1");
    assert_eq!(removals, [WEBHOOK_SECRET_REF], "a re-paste moves it");
    let (_, removals) = secret_writes_for_save(&url("2"), Some("1"));
    assert!(
        removals.is_empty(),
        "another webhook leaves the first alone"
    );
    let (_, removals) = secret_writes_for_save(&url("2"), None);
    assert!(removals.is_empty());

    assert_eq!(
        secret_refs_for_remove("1", Some("1")),
        ["discord.webhook.url.1", WEBHOOK_SECRET_REF]
    );
    assert_eq!(
        secret_refs_for_remove("2", Some("1")),
        ["discord.webhook.url.2"]
    );
    assert_eq!(secret_refs_for_remove("2", None), ["discord.webhook.url.2"]);
}

#[test]
fn saving_replaces_a_repaste_and_refuses_past_the_cap() {
    let mut settings = StoredSettings::default();
    for id in 1..=MAX_WEBHOOKS {
        settings.upsert_webhook(meta(&id.to_string())).unwrap();
    }
    assert_eq!(settings.webhooks.len(), MAX_WEBHOOKS);

    // The same webhook pasted again (a reset token) replaces it where it is,
    // with its slate wiped.
    settings.webhooks[2].components_refused = true;
    settings.webhooks[2].last_error = Some(AnnounceError {
        code: AnnounceErrorCode::WebhookDeleted,
        at: "x".to_string(),
    });
    let mut repasted = meta("3");
    repasted.hint = "…/new1".to_string();
    settings.upsert_webhook(repasted).unwrap();
    assert_eq!(settings.webhooks.len(), MAX_WEBHOOKS);
    assert_eq!(settings.webhooks[2].hint, "…/new1");
    assert!(!settings.webhooks[2].components_refused);
    assert!(settings.webhooks[2].last_error.is_none());

    let refused = settings.upsert_webhook(meta("11")).unwrap_err();
    assert_eq!(refused.code, "discord-too-many-webhooks");
    assert_eq!(
        refused.message,
        "You can connect up to 10 webhooks. Remove one to add another."
    );
    assert_eq!(settings.webhooks.len(), MAX_WEBHOOKS);

    // Room again once one goes; a new one joins at the end.
    assert_eq!(
        settings.remove_webhook("1").map(|meta| meta.id).as_deref(),
        Some("1")
    );
    settings.upsert_webhook(meta("11")).unwrap();
    assert_eq!(
        settings.webhooks.last().map(|meta| meta.id.as_str()),
        Some("11")
    );
    assert!(settings.remove_webhook("1").is_none(), "already gone");
}

#[test]
fn removing_a_webhook_touches_only_it() {
    let mut settings = StoredSettings::default();
    settings.upsert_webhook(meta("1")).unwrap();
    settings.upsert_webhook(meta("2")).unwrap();
    settings.webhooks[1].last_error = Some(AnnounceError {
        code: AnnounceErrorCode::Rejected,
        at: "x".to_string(),
    });
    settings.remove_webhook("1").unwrap();
    assert_eq!(settings.webhooks.len(), 1);
    assert_eq!(settings.webhooks[0].id, "2");
    assert!(
        settings.webhooks[0].last_error.is_some(),
        "the other webhook's failure stays"
    );
}

#[test]
fn the_newest_sessions_are_kept_with_every_webhook_machine() {
    let active = |session: &str, webhook: &str| Active {
        machine: AnnounceSession::new(session, Utc::now(), Vec::new(), None),
        context: SessionContext {
            webhook: url(webhook),
            webhook_id: webhook.to_string(),
            webhook_name: None,
            sender: None,
            ping: DiscordPing::None,
            branding: true,
            title: String::new(),
            thumbnail: None,
            image_filename: None,
            channel_id: None,
            posted_at: None,
        },
        stopped: Arc::new(AtomicBool::new(false)),
        last_heartbeat: Utc::now(),
    };
    let mut sessions = vec![
        active("s1", "1"),
        active("s1", "2"),
        active("s2", "1"),
        active("s2", "2"),
        active("s3", "1"),
        active("s3", "2"),
    ];
    retain_newest_sessions(&mut sessions, MAX_SESSIONS);
    assert_eq!(
        sessions
            .iter()
            .map(|active| {
                format!(
                    "{}/{}",
                    active.machine.session_id(),
                    active.context.webhook_id
                )
            })
            .collect::<Vec<_>>(),
        ["s2/1", "s2/2", "s3/1", "s3/2"]
    );
    retain_newest_sessions(&mut sessions, MAX_SESSIONS);
    assert_eq!(sessions.len(), 4, "nothing to drop");
    assert_eq!(newest_live_session(&sessions).as_deref(), Some("s3"));
}

#[test]
fn the_snapshot_never_carries_null() {
    // The renderer's optional fields accept a missing key, never `null`.
    let snapshot = DiscordAnnounceSnapshot {
        webhooks: vec![
            DiscordWebhookSnapshot {
                id: "1".to_string(),
                name: None,
                hint: "…/a1B2".to_string(),
                last_post: Some(LastPost {
                    at: "2026-10-22T18:02:00Z".to_string(),
                    message_url: None,
                    state: LastPostState::Ended,
                }),
                last_error: None,
            },
            DiscordWebhookSnapshot {
                id: "2".to_string(),
                name: Some("Stream alerts".to_string()),
                hint: "…/zzzz".to_string(),
                last_post: None,
                last_error: Some(AnnounceError {
                    code: AnnounceErrorCode::WebhookDeleted,
                    at: "2026-10-22T18:03:00Z".to_string(),
                }),
            },
        ],
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
    };
    let json = serde_json::to_value(&snapshot).unwrap();
    assert!(!has_null(&json), "{json}");
    assert_eq!(json["ping"], "none");
    assert_eq!(json["postAs"], serde_json::json!({ "kind": "automatic" }));
    assert_eq!(json["webhooks"][0]["lastPost"]["state"], "ended");
    assert_eq!(json["webhooks"][1]["lastError"]["code"], "webhook-deleted");
    assert!(
        json["webhooks"][0].get("name").is_none() && json["webhooks"][1].get("lastPost").is_none()
    );

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
fn message_urls_name_the_webhooks_own_server() {
    assert_eq!(
        message_url(&meta("1"), None, "m").as_deref(),
        Some("https://discord.com/channels/g1/c1/m")
    );
    assert_eq!(
        message_url(&meta("1"), Some("thread"), "m").as_deref(),
        Some("https://discord.com/channels/g1/thread/m")
    );
    let mut no_guild = meta("1");
    no_guild.guild_id = None;
    assert!(message_url(&no_guild, None, "m").is_none());
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
    assert_eq!(
        discord_label(Some("Stream alerts")),
        "Discord (Stream alerts)"
    );
    assert_eq!(discord_label(None), "Discord");
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

#[test]
fn webhook_params_name_one_webhook_and_nothing_else() {
    let remove: RemoveWebhookParams =
        serde_json::from_value(serde_json::json!({ "webhookId": "1" })).unwrap();
    assert_eq!(remove.webhook_id, "1");
    assert!(serde_json::from_value::<RemoveWebhookParams>(serde_json::json!({})).is_err());
    assert!(
        serde_json::from_value::<RemoveWebhookParams>(
            serde_json::json!({ "webhookId": "1", "url": "x" })
        )
        .is_err()
    );
    let test: TestParams =
        serde_json::from_value(serde_json::json!({ "targets": [], "webhookId": "2" })).unwrap();
    assert_eq!(test.webhook_id, "2");
    assert!(
        serde_json::from_value::<TestParams>(serde_json::json!({ "targets": [] })).is_err(),
        "a test names its webhook"
    );
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
async fn removing_an_unsaved_webhook_is_refused_without_touching_anything() {
    let state = test_state();
    let refused = remove_webhook(
        &state,
        RemoveWebhookParams {
            webhook_id: "404".to_string(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, "discord-no-webhook");
    assert_eq!(load_settings(&state), StoredSettings::default());
    let empty = remove_webhook(
        &state,
        RemoveWebhookParams {
            webhook_id: String::new(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(empty.code, "invalid-params");
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
