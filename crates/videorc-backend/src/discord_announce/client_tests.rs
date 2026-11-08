use std::collections::VecDeque;
use std::sync::Mutex;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::any;

use super::*;

const TOKEN: &str = "AbC-def_123456789xyz";

fn webhook() -> WebhookUrl {
    WebhookUrl::parse(&format!(
        "https://discord.com/api/webhooks/123456789/{TOKEN}"
    ))
    .unwrap()
}

fn at() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-10-22T18:02:00Z")
        .unwrap()
        .with_timezone(&Utc)
}

const FAST: RetryPolicy = RetryPolicy {
    steps: &[Duration::from_millis(5)],
    budget: Duration::from_millis(500),
    max_retry_after: Duration::from_millis(20),
};

#[derive(Debug, Clone)]
struct Seen {
    method: Method,
    path: String,
    query: String,
    content_type: String,
    body: Vec<u8>,
}

#[derive(Default)]
struct Fake {
    seen: Mutex<Vec<Seen>>,
    script: Mutex<VecDeque<(u16, String)>>,
}

async fn handle(
    State(fake): State<Arc<Fake>>,
    method: Method,
    Path(rest): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    fake.seen.lock().unwrap().push(Seen {
        method: method.clone(),
        path: rest,
        query: query.unwrap_or_default(),
        content_type: headers
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string(),
        body: body.to_vec(),
    });
    let (status, body) = fake.script.lock().unwrap().pop_front().unwrap_or_else(|| {
        (
            200,
            r#"{"id":"987654321","channel_id":"555","name":"Stream alerts","guild_id":"777"}"#
                .to_string(),
        )
    });
    (
        StatusCode::from_u16(status).unwrap(),
        [("content-type", "application/json")],
        body,
    )
}

async fn serve(script: Vec<(u16, &str)>) -> (String, Arc<Fake>) {
    let fake = Arc::new(Fake::default());
    fake.script.lock().unwrap().extend(
        script
            .into_iter()
            .map(|(status, body)| (status, body.to_string())),
    );
    let app = Router::new()
        .route("/api/v10/{*rest}", any(handle))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (origin, fake)
}

fn never() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

fn view<'a>(links: &'a [LinkButton], sender: Option<&'a Sender>, mood: Mood) -> MessageView<'a> {
    MessageView {
        title: "Building a Discord bot in Rust",
        links,
        mood,
        ping: DiscordPing::Everyone,
        branding: true,
        started_at: at(),
        sender,
        image_filename: None,
        components: true,
    }
}

fn links() -> Vec<LinkButton> {
    vec![
        LinkButton {
            label: "Twitch".to_string(),
            url: "https://www.twitch.tv/orcdev".to_string(),
        },
        LinkButton {
            label: "YouTube".to_string(),
            url: "https://www.youtube.com/watch?v=abc".to_string(),
        },
    ]
}

// --- URL ---

#[test]
fn accepts_discord_webhook_urls() {
    for raw in [
        format!("https://discord.com/api/webhooks/123/{TOKEN}"),
        format!("  https://discordapp.com/api/webhooks/123/{TOKEN}/  "),
        format!("https://ptb.discord.com/api/v10/webhooks/123/{TOKEN}?wait=true"),
        format!("https://canary.discord.com/api/webhooks/123/{TOKEN}#x"),
    ] {
        let parsed = WebhookUrl::parse(&raw).unwrap_or_else(|_| panic!("{raw}"));
        assert_eq!(parsed.id(), "123");
        assert_eq!(
            parsed.to_secret_string(),
            format!("https://discord.com/api/webhooks/123/{TOKEN}")
        );
    }
}

#[test]
fn refuses_anything_else() {
    for raw in [
        "",
        "discord.com/api/webhooks/123/abc",
        "http://discord.com/api/webhooks/123/abc",
        "https://evil.com/api/webhooks/123/abc",
        "https://discord.com.evil.com/api/webhooks/123/abc",
        "https://discord.com/api/webhooks/abc/abc",
        "https://discord.com/api/webhooks/123",
        "https://discord.com/api/webhooks/123/abc/extra",
        "https://discord.com/api/webhooks/123/a$c",
        "https://user:pw@discord.com/api/webhooks/123/abc",
        "https://discord.com:8443/api/webhooks/123/abc",
        "https://discord.com/api/vx/webhooks/123/abc",
    ] {
        assert_eq!(WebhookUrl::parse(raw), Err(NotAWebhookUrl), "{raw}");
    }
}

#[test]
fn the_token_never_prints() {
    let webhook = webhook();
    let debug = format!("{webhook:?}");
    assert!(!debug.contains(TOKEN), "{debug}");
    assert_eq!(webhook.hint(), "…/9xyz");
    assert!(debug.contains("…/9xyz"));
    for error in [
        SendError::WebhookGone,
        SendError::MessageGone,
        SendError::Unreachable,
        SendError::Rejected {
            status: 400,
            code: Some(50035),
        },
    ] {
        assert!(!error.describe().contains(TOKEN));
    }
}

#[test]
fn the_dev_origin_override_is_loopback_and_debug_only() {
    assert_eq!(resolve_api_origin_override(true, None), Ok(None));
    assert_eq!(
        resolve_api_origin_override(true, Some("http://127.0.0.1:4321")),
        Ok(Some("http://127.0.0.1:4321".to_string()))
    );
    assert!(resolve_api_origin_override(false, Some("http://127.0.0.1:4321")).is_err());
    assert!(resolve_api_origin_override(true, Some("https://evil.com")).is_err());
    assert!(resolve_api_origin_override(true, Some("http://127.0.0.1")).is_err());
}

// --- Bodies ---

#[test]
fn live_post_body() {
    let links = links();
    let sender = Sender {
        name: "OrcDev".to_string(),
        avatar_url: Some("https://cdn.example/a.png".to_string()),
    };
    let body = message_body(&view(&links, Some(&sender), Mood::Live), false);
    assert_eq!(
        body,
        json!({
            "content": "@everyone Live now: Building a Discord bot in Rust",
            "embeds": [{
                "title": "Building a Discord bot in Rust",
                "url": "https://www.twitch.tv/orcdev",
                "color": LIVE_COLOR,
                "footer": { "text": "Live with Videorc", "icon_url": BRAND_ICON_URL },
                "timestamp": "2026-10-22T18:02:00+00:00"
            }],
            "components": [{
                "type": 1,
                "components": [
                    { "type": 2, "style": 5, "label": "Twitch", "url": "https://www.twitch.tv/orcdev" },
                    { "type": 2, "style": 5, "label": "YouTube", "url": "https://www.youtube.com/watch?v=abc" }
                ]
            }],
            "allowed_mentions": { "parse": ["everyone"] },
            "username": "OrcDev",
            "avatar_url": "https://cdn.example/a.png"
        })
    );
}

#[test]
fn pings_follow_the_picker() {
    let links = links();
    for (ping, content, parse) in [
        (
            DiscordPing::None,
            "Live now: Building a Discord bot in Rust",
            json!([]),
        ),
        (
            DiscordPing::Here,
            "@here Live now: Building a Discord bot in Rust",
            json!(["everyone"]),
        ),
    ] {
        let mut view = view(&links, None, Mood::Live);
        view.ping = ping;
        let body = message_body(&view, false);
        assert_eq!(body["content"], content);
        assert_eq!(body["allowed_mentions"]["parse"], parse);
    }
}

#[test]
fn edits_never_ping_or_change_the_sender() {
    let links = links();
    let sender = Sender {
        name: "OrcDev".to_string(),
        avatar_url: None,
    };
    let body = message_body(&view(&links, Some(&sender), Mood::Live), true);
    assert_eq!(body["allowed_mentions"], json!({ "parse": [] }));
    assert!(body.get("username").is_none());
    assert!(body.get("avatar_url").is_none());
}

#[test]
fn the_test_message_never_pings() {
    let links = links();
    let body = message_body(&view(&links, None, Mood::Test), false);
    assert_eq!(
        body["content"],
        "Test from Videorc: this is how your go-live post will look. Your real post will ping `@everyone`."
    );
    assert_eq!(body["allowed_mentions"], json!({ "parse": [] }));
}

#[test]
fn ended_body_turns_grey_and_says_how_long() {
    let links = links();
    let mut view = view(
        &links,
        None,
        Mood::Ended {
            duration: Some(chrono::TimeDelta::minutes(102)),
        },
    );
    view.image_filename = Some("thumbnail.png");
    let body = message_body(&view, true);
    assert_eq!(
        body["content"],
        "Was live: Building a Discord bot in Rust · 1h 42m"
    );
    assert_eq!(body["embeds"][0]["color"], ENDED_COLOR);
    assert_eq!(body["embeds"][0]["footer"]["text"], "Streamed with Videorc");
    assert_eq!(
        body["embeds"][0]["image"]["url"],
        "attachment://thumbnail.png"
    );
    assert_eq!(
        body["components"][0]["components"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn no_branding_no_footer_and_no_title_uses_the_name() {
    let sender = Sender {
        name: "OrcDev".to_string(),
        avatar_url: None,
    };
    let mut view = view(&[], Some(&sender), Mood::Live);
    view.title = "  ";
    view.branding = false;
    view.ping = DiscordPing::None;
    let body = message_body(&view, false);
    assert_eq!(body["content"], "OrcDev is live now");
    assert_eq!(body["embeds"][0]["title"], "OrcDev is live");
    assert!(body["embeds"][0].get("footer").is_none());
    assert!(body["embeds"][0].get("url").is_none());
}

#[test]
fn refused_buttons_move_the_links_into_the_embed() {
    let links = vec![LinkButton {
        label: "My [site]".to_string(),
        url: "https://example.com/live".to_string(),
    }];
    let mut view = view(&links, None, Mood::Live);
    view.components = false;
    let body = message_body(&view, false);
    assert_eq!(body["components"], json!([]));
    assert_eq!(
        body["embeds"][0]["description"],
        "**Watch:** [My \\[site\\]](https://example.com/live)"
    );
}

#[test]
fn buttons_wrap_at_five_per_row() {
    let links: Vec<LinkButton> = (0..7)
        .map(|index| LinkButton {
            label: format!("L{index}"),
            url: format!("https://example.com/{index}"),
        })
        .collect();
    let body = message_body(&view(&links, None, Mood::Live), false);
    let rows = body["components"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["components"].as_array().unwrap().len(), 5);
    assert_eq!(rows[1]["components"].as_array().unwrap().len(), 2);
}

#[test]
fn usernames_follow_discords_rules() {
    assert_eq!(
        sanitize_username("Orc#Dev: live"),
        Some("OrcDev live".to_string())
    );
    assert_eq!(sanitize_username("@everyone"), None);
    assert_eq!(sanitize_username("here"), None);
    assert_eq!(sanitize_username("My Discord Stream"), None);
    assert_eq!(sanitize_username("   "), None);
    assert_eq!(
        sanitize_username(&"a".repeat(100)).unwrap().chars().count(),
        80
    );
}

#[test]
fn durations_read_naturally() {
    assert_eq!(
        format_duration(chrono::TimeDelta::seconds(30)),
        "under a minute"
    );
    assert_eq!(format_duration(chrono::TimeDelta::minutes(42)), "42m");
    assert_eq!(format_duration(chrono::TimeDelta::minutes(120)), "2h");
    assert_eq!(format_duration(chrono::TimeDelta::minutes(102)), "1h 42m");
}

// --- Requests ---

#[tokio::test]
async fn verify_reads_the_webhook_and_maps_errors() {
    let (origin, fake) = serve(vec![
        (
            200,
            r#"{"id":"123","name":"Stream alerts","channel_id":"555","guild_id":"777"}"#,
        ),
        (404, r#"{"message":"Unknown Webhook","code":10015}"#),
        (503, "{}"),
    ])
    .await;
    let client = http_client().unwrap();
    let info = verify(&client, &origin, &webhook()).await.unwrap();
    assert_eq!(info.name.as_deref(), Some("Stream alerts"));
    assert_eq!(info.channel_id, "555");
    assert_eq!(info.guild_id.as_deref(), Some("777"));
    assert_eq!(
        verify(&client, &origin, &webhook()).await,
        Err(SendError::WebhookGone)
    );
    assert_eq!(
        verify(&client, &origin, &webhook()).await,
        Err(SendError::Unreachable)
    );
    let seen = fake.seen.lock().unwrap();
    assert_eq!(seen[0].method, Method::GET);
    assert_eq!(seen[0].path, format!("webhooks/123456789/{TOKEN}"));
}

#[tokio::test]
async fn execute_waits_for_the_message_and_sends_components() {
    let (origin, fake) = serve(vec![]).await;
    let client = http_client().unwrap();
    let body = json!({ "content": "hi" });
    let posted = execute(&client, &origin, &webhook(), &body, None, FAST, &never())
        .await
        .unwrap();
    assert_eq!(
        posted,
        Posted {
            message_id: "987654321".to_string(),
            channel_id: Some("555".to_string())
        }
    );
    let seen = fake.seen.lock().unwrap();
    assert_eq!(seen[0].method, Method::POST);
    assert_eq!(seen[0].query, "wait=true&with_components=true");
    assert!(seen[0].content_type.starts_with("application/json"));
}

#[tokio::test]
async fn execute_uploads_the_thumbnail_as_multipart() {
    let (origin, fake) = serve(vec![]).await;
    let client = http_client().unwrap();
    let thumbnail = Thumbnail {
        filename: "thumbnail.png".to_string(),
        content_type: "image/png",
        bytes: vec![0x89, b'P', b'N', b'G'],
    };
    execute(
        &client,
        &origin,
        &webhook(),
        &json!({ "content": "hi" }),
        Some(&thumbnail),
        FAST,
        &never(),
    )
    .await
    .unwrap();
    let seen = fake.seen.lock().unwrap();
    assert!(seen[0].content_type.starts_with("multipart/form-data"));
    let raw = String::from_utf8_lossy(&seen[0].body);
    assert!(raw.contains("name=\"payload_json\""));
    assert!(
        raw.contains(r#""attachments":[{"filename":"thumbnail.png","id":0}]"#),
        "{raw}"
    );
    assert!(raw.contains("name=\"files[0]\"; filename=\"thumbnail.png\""));
}

#[tokio::test]
async fn execute_honours_rate_limits_then_succeeds() {
    let (origin, fake) = serve(vec![
        (
            429,
            r#"{"message":"You are being rate limited.","retry_after":0.01,"global":false}"#,
        ),
        (502, "{}"),
    ])
    .await;
    let client = http_client().unwrap();
    let posted = execute(
        &client,
        &origin,
        &webhook(),
        &json!({ "content": "hi" }),
        None,
        FAST,
        &never(),
    )
    .await
    .unwrap();
    assert_eq!(posted.message_id, "987654321");
    assert_eq!(fake.seen.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn execute_gives_up_after_the_budget() {
    let script = vec![(503, "{}"); 400];
    let (origin, _fake) = serve(script).await;
    let client = http_client().unwrap();
    let result = execute(
        &client,
        &origin,
        &webhook(),
        &json!({ "content": "hi" }),
        None,
        RetryPolicy {
            budget: Duration::from_millis(60),
            ..FAST
        },
        &never(),
    )
    .await;
    assert_eq!(result, Err(SendError::Unreachable));
}

#[tokio::test]
async fn execute_stops_retrying_once_cancelled() {
    let (origin, fake) = serve(vec![(503, "{}"), (503, "{}"), (503, "{}")]).await;
    let client = http_client().unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    const SLOW_STEPS: &[Duration] = &[Duration::from_millis(50)];
    let policy = RetryPolicy {
        steps: SLOW_STEPS,
        budget: Duration::from_secs(5),
        max_retry_after: Duration::from_millis(50),
    };
    let cancel = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        flag.store(true, Ordering::Release);
    });
    let result = execute(
        &client,
        &origin,
        &webhook(),
        &json!({}),
        None,
        policy,
        &cancelled,
    )
    .await;
    cancel.await.unwrap();
    assert_eq!(result, Err(SendError::Cancelled));
    assert_eq!(fake.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn execute_maps_permanent_failures() {
    let (origin, _fake) = serve(vec![
        (404, r#"{"message":"Unknown Webhook","code":10015}"#),
        (401, r#"{"message":"Invalid Webhook Token","code":50027}"#),
        (
            400,
            r#"{"message":"Invalid Form Body","code":50035,"errors":{"components":{"_errors":[]}}}"#,
        ),
        (400, r#"{"message":"Invalid Form Body","code":50035,"errors":{"content":{}}}"#),
    ])
    .await;
    let client = http_client().unwrap();
    let mut results = Vec::new();
    for _ in 0..4 {
        results.push(
            execute(
                &client,
                &origin,
                &webhook(),
                &json!({}),
                None,
                FAST,
                &never(),
            )
            .await,
        );
    }
    assert_eq!(
        results,
        vec![
            Err(SendError::WebhookGone),
            Err(SendError::WebhookGone),
            Err(SendError::ComponentsRefused),
            Err(SendError::Rejected {
                status: 400,
                code: Some(50035)
            }),
        ]
    );
}

#[tokio::test]
async fn edit_patches_the_message_and_maps_a_deleted_one() {
    let (origin, fake) = serve(vec![
        (200, r#"{"id":"42"}"#),
        (404, r#"{"message":"Unknown Message","code":10008}"#),
        (404, r#"{"message":"Unknown Webhook","code":10015}"#),
    ])
    .await;
    let client = http_client().unwrap();
    let body = json!({ "content": "Was live" });
    assert_eq!(
        edit(&client, &origin, &webhook(), "42", &body, FAST, &never()).await,
        Ok(())
    );
    assert_eq!(
        edit(&client, &origin, &webhook(), "42", &body, FAST, &never()).await,
        Err(SendError::MessageGone)
    );
    assert_eq!(
        edit(&client, &origin, &webhook(), "42", &body, FAST, &never()).await,
        Err(SendError::WebhookGone)
    );
    assert_eq!(
        edit(&client, &origin, &webhook(), "../x", &body, FAST, &never()).await,
        Err(SendError::MessageGone),
        "a message id is digits only"
    );
    let seen = fake.seen.lock().unwrap();
    assert_eq!(seen.len(), 3);
    assert_eq!(seen[0].method, Method::PATCH);
    assert_eq!(
        seen[0].path,
        format!("webhooks/123456789/{TOKEN}/messages/42")
    );
    assert_eq!(seen[0].query, "with_components=true");
}
