//! The Discord webhook client (plan 187 S1): the webhook URL as a secret, the
//! message bodies, and one post or edit with its retries.
//!
//! A webhook URL is a bearer credential: anyone holding it can post into the
//! channel. [`WebhookUrl`] never prints its token, requests are built from its
//! parts, and a `reqwest::Error` (whose text quotes the URL) is never
//! formatted anywhere in this module.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Dev-only: every Discord call goes to this loopback origin instead
/// (`smoke:discord-announce`). Packaged builds refuse it.
pub const API_BASE_ENV_VAR: &str = "VIDEORC_DISCORD_API_BASE_URL";
const DISCORD_ORIGIN: &str = "https://discord.com";
const ACCEPTED_HOSTS: [&str; 4] = [
    "discord.com",
    "discordapp.com",
    "ptb.discord.com",
    "canary.discord.com",
];
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// How long one post or edit keeps retrying before it gives up.
pub const RETRY_BUDGET: Duration = Duration::from_secs(5 * 60);
const RETRY_STEPS: [Duration; 5] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(30),
    Duration::from_secs(60),
];
const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

pub const LIVE_COLOR: u32 = 0xEF4444;
pub const ENDED_COLOR: u32 = 0x71717A;
pub const BRAND_ICON_URL: &str = "https://www.videorc.com/apple-icon.png";
const MAX_BUTTONS: usize = 25;
const BUTTONS_PER_ROW: usize = 5;

// ---------------------------------------------------------------------------
// The webhook URL
// ---------------------------------------------------------------------------

/// A Discord webhook URL, held as its id and token. `Debug` shows only the
/// masked hint.
#[derive(Clone, PartialEq, Eq)]
pub struct WebhookUrl {
    id: String,
    token: String,
}

impl std::fmt::Debug for WebhookUrl {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "WebhookUrl({})", self.hint())
    }
}

/// The paste was not a Discord webhook URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotAWebhookUrl;

impl WebhookUrl {
    /// Accepts `https://{discord.com|discordapp.com|ptb.|canary.}/api[/vN]/webhooks/{id}/{token}`,
    /// ignoring surrounding whitespace, a trailing slash, a query and a fragment.
    pub fn parse(raw: &str) -> Result<Self, NotAWebhookUrl> {
        let url = reqwest::Url::parse(raw.trim()).map_err(|_| NotAWebhookUrl)?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return Err(NotAWebhookUrl);
        }
        let host = url.host_str().ok_or(NotAWebhookUrl)?;
        if !ACCEPTED_HOSTS.contains(&host) {
            return Err(NotAWebhookUrl);
        }
        let segments: Vec<&str> = url
            .path_segments()
            .ok_or(NotAWebhookUrl)?
            .filter(|segment| !segment.is_empty())
            .collect();
        let (id, token) = match segments.as_slice() {
            ["api", "webhooks", id, token] => (*id, *token),
            ["api", version, "webhooks", id, token] if is_api_version(version) => (*id, *token),
            _ => return Err(NotAWebhookUrl),
        };
        let id_ok = !id.is_empty() && id.len() <= 25 && id.bytes().all(|b| b.is_ascii_digit());
        let token_ok = !token.is_empty()
            && token.len() <= 128
            && token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if !id_ok || !token_ok {
            return Err(NotAWebhookUrl);
        }
        Ok(Self {
            id: id.to_string(),
            token: token.to_string(),
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// `…/a1B2`: enough to tell two webhooks apart, never enough to post.
    pub fn hint(&self) -> String {
        let tail: String = self
            .token
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("…/{tail}")
    }

    /// The canonical form kept in the secrets file.
    pub fn to_secret_string(&self) -> String {
        format!("{DISCORD_ORIGIN}/api/webhooks/{}/{}", self.id, self.token)
    }

    fn endpoint(&self, origin: &str) -> String {
        format!("{origin}/api/v10/webhooks/{}/{}", self.id, self.token)
    }
}

fn is_api_version(segment: &str) -> bool {
    segment
        .strip_prefix('v')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

/// The dev-only origin override, resolved once per process.
pub fn api_origin() -> String {
    static RESOLVED: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            let value = std::env::var(API_BASE_ENV_VAR).ok();
            match resolve_api_origin_override(cfg!(debug_assertions), value.as_deref()) {
                Ok(Some(origin)) => {
                    tracing::warn!("[discord] dev override: every Discord call goes to {origin}");
                    Some(origin)
                }
                Ok(None) => None,
                Err(why) => {
                    tracing::warn!("[discord] {why}");
                    None
                }
            }
        })
        .clone()
        .unwrap_or_else(|| DISCORD_ORIGIN.to_string())
}

pub fn resolve_api_origin_override(
    dev_build: bool,
    value: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !dev_build {
        return Err(format!(
            "{API_BASE_ENV_VAR} is refused in packaged builds; Discord calls go to {DISCORD_ORIGIN}."
        ));
    }
    let url = reqwest::Url::parse(value)
        .map_err(|error| format!("{API_BASE_ENV_VAR} is not a URL: {error}"))?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(format!(
            "{API_BASE_ENV_VAR} must be a bare loopback origin such as http://127.0.0.1:4321."
        ));
    }
    Ok(Some(value.trim_end_matches('/').to_string()))
}

pub fn http_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("Videorc-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()
}

// ---------------------------------------------------------------------------
// Message bodies
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DiscordPing {
    #[default]
    None,
    Here,
    Everyone,
}

impl DiscordPing {
    fn mention(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Here => Some("@here"),
            Self::Everyone => Some("@everyone"),
        }
    }
}

/// One link button: a platform label and the public watch URL.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkButton {
    pub label: String,
    pub url: String,
}

/// Who the post appears to come from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Sender {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mood {
    Live,
    Ended { duration: Option<chrono::TimeDelta> },
    Test,
}

/// Everything a post or an edit says.
#[derive(Debug, Clone)]
pub struct MessageView<'a> {
    pub title: &'a str,
    pub links: &'a [LinkButton],
    pub mood: Mood,
    pub ping: DiscordPing,
    pub branding: bool,
    pub started_at: DateTime<Utc>,
    pub sender: Option<&'a Sender>,
    /// The attachment the embed image shows (`attachment://{name}`).
    pub image_filename: Option<&'a str>,
    /// False once Discord refused link buttons for this webhook: the links
    /// go in the embed text instead.
    pub components: bool,
}

/// The JSON body of a post (`for_edit = false`) or an edit. An edit never
/// carries the sender (Discord fixes it at creation) and never pings.
pub fn message_body(view: &MessageView<'_>, for_edit: bool) -> Value {
    let name = view.sender.map(|sender| sender.name.as_str());
    let title = view.title.trim();
    let content = content_line(view, title, name);
    let mut embed = serde_json::Map::new();
    embed.insert(
        "title".into(),
        json!(truncate_chars(&embed_title(title, name, &view.mood), 256)),
    );
    if let Some(first) = view.links.first() {
        embed.insert("url".into(), json!(first.url));
    }
    embed.insert(
        "color".into(),
        json!(match view.mood {
            Mood::Ended { .. } => ENDED_COLOR,
            Mood::Live | Mood::Test => LIVE_COLOR,
        }),
    );
    if !view.components && !view.links.is_empty() {
        embed.insert("description".into(), json!(links_markdown(view.links)));
    }
    if let Some(filename) = view.image_filename {
        embed.insert(
            "image".into(),
            json!({ "url": format!("attachment://{filename}") }),
        );
    }
    if view.branding {
        let text = match view.mood {
            Mood::Ended { .. } => "Streamed with Videorc",
            Mood::Live | Mood::Test => "Live with Videorc",
        };
        embed.insert(
            "footer".into(),
            json!({ "text": text, "icon_url": BRAND_ICON_URL }),
        );
    }
    embed.insert("timestamp".into(), json!(view.started_at.to_rfc3339()));

    let mut body = serde_json::Map::new();
    body.insert("content".into(), json!(truncate_chars(&content, 2000)));
    body.insert("embeds".into(), json!([Value::Object(embed)]));
    body.insert(
        "components".into(),
        if view.components {
            json!(button_rows(view.links))
        } else {
            json!([])
        },
    );
    let pings = !for_edit && matches!(view.mood, Mood::Live) && view.ping != DiscordPing::None;
    body.insert(
        "allowed_mentions".into(),
        if pings {
            json!({ "parse": ["everyone"] })
        } else {
            json!({ "parse": [] })
        },
    );
    if !for_edit && let Some(sender) = view.sender {
        if let Some(username) = sanitize_username(&sender.name) {
            body.insert("username".into(), json!(username));
        }
        if let Some(avatar) = sender
            .avatar_url
            .as_deref()
            .filter(|url| url.starts_with("https://"))
        {
            body.insert("avatar_url".into(), json!(avatar));
        }
    }
    Value::Object(body)
}

fn content_line(view: &MessageView<'_>, title: &str, name: Option<&str>) -> String {
    match &view.mood {
        Mood::Live => {
            let line = live_line(title, name);
            match view.ping.mention() {
                Some(mention) => format!("{mention} {line}"),
                None => line,
            }
        }
        Mood::Test => {
            let mut line =
                "Test from Videorc: this is how your go-live post will look.".to_string();
            if let Some(mention) = view.ping.mention() {
                line.push_str(&format!(" Your real post will ping `{mention}`."));
            }
            line
        }
        Mood::Ended { duration } => {
            let base = if !title.is_empty() {
                format!("Was live: {title}")
            } else if let Some(name) = name {
                format!("{name} was live")
            } else {
                "Was live".to_string()
            };
            match duration {
                Some(duration) => format!("{base} · {}", format_duration(*duration)),
                None => base,
            }
        }
    }
}

fn live_line(title: &str, name: Option<&str>) -> String {
    if !title.is_empty() {
        format!("Live now: {title}")
    } else if let Some(name) = name {
        format!("{name} is live now")
    } else {
        "Live now".to_string()
    }
}

fn embed_title(title: &str, name: Option<&str>, mood: &Mood) -> String {
    if !title.is_empty() {
        return title.to_string();
    }
    match (mood, name) {
        (Mood::Ended { .. }, Some(name)) => format!("{name} was live"),
        (Mood::Ended { .. }, None) => "Was live".to_string(),
        (_, Some(name)) => format!("{name} is live"),
        (_, None) => "Live now".to_string(),
    }
}

fn button_rows(links: &[LinkButton]) -> Vec<Value> {
    links
        .iter()
        .take(MAX_BUTTONS)
        .collect::<Vec<_>>()
        .chunks(BUTTONS_PER_ROW)
        .map(|row| {
            json!({
                "type": 1,
                "components": row
                    .iter()
                    .map(|link| json!({
                        "type": 2,
                        "style": 5,
                        "label": truncate_chars(&link.label, 80),
                        "url": link.url,
                    }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect()
}

fn links_markdown(links: &[LinkButton]) -> String {
    let joined = links
        .iter()
        .map(|link| format!("[{}]({})", escape_markdown(&link.label), link.url))
        .collect::<Vec<_>>()
        .join(" · ");
    format!("**Watch:** {joined}")
}

fn escape_markdown(text: &str) -> String {
    text.chars()
        .flat_map(|character| {
            let escape = matches!(
                character,
                '[' | ']' | '(' | ')' | '*' | '_' | '~' | '`' | '\\'
            );
            escape.then_some('\\').into_iter().chain([character])
        })
        .collect()
}

/// "1h 42m", "42m", "under a minute".
pub fn format_duration(duration: chrono::TimeDelta) -> String {
    let minutes = duration.num_minutes().max(0);
    match (minutes / 60, minutes % 60) {
        (0, 0) => "under a minute".to_string(),
        (0, minutes) => format!("{minutes}m"),
        (hours, 0) => format!("{hours}h"),
        (hours, minutes) => format!("{hours}h {minutes}m"),
    }
}

/// Discord refuses webhook names with `@ # :` or a code fence, containing
/// "discord" or "clyde", or equal to "everyone"/"here", and over 80
/// characters. Drops the forbidden characters; `None` means "use the
/// webhook's own name".
pub fn sanitize_username(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .replace("```", "")
        .chars()
        .filter(|character| !matches!(character, '@' | '#' | ':') && !character.is_control())
        .collect();
    let cleaned = truncate_chars(cleaned.trim(), 80).trim().to_string();
    let lower = cleaned.to_lowercase();
    if cleaned.is_empty()
        || lower.contains("discord")
        || lower.contains("clyde")
        || lower == "everyone"
        || lower == "here"
    {
        return None;
    }
    Some(cleaned)
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// The webhook's identity, from `GET /webhooks/{id}/{token}` (posts nothing).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct WebhookInfo {
    #[serde(default)]
    pub name: Option<String>,
    pub channel_id: String,
    #[serde(default)]
    pub guild_id: Option<String>,
}

/// A created message: its id plus the channel and server for "View in Discord".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Posted {
    pub message_id: String,
    pub channel_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendError {
    /// 401/404 on the webhook: it was deleted or its token revoked.
    WebhookGone,
    /// 404 on an edit: the message was deleted.
    MessageGone,
    /// 400 naming `components`: this webhook may not send link buttons.
    ComponentsRefused,
    /// Any other 4xx; `code` is Discord's JSON error code.
    Rejected { status: u16, code: Option<u64> },
    /// Network, timeout or 5xx after the retry budget.
    Unreachable,
    /// The caller stopped wanting it (a post after the session ended).
    Cancelled,
}

impl SendError {
    pub fn describe(self) -> String {
        match self {
            Self::WebhookGone => "the webhook was deleted in Discord".to_string(),
            Self::MessageGone => "the message was deleted in Discord".to_string(),
            Self::ComponentsRefused => "Discord refused link buttons".to_string(),
            Self::Rejected { status, code } => match code {
                Some(code) => format!("Discord refused the post (HTTP {status}, code {code})"),
                None => format!("Discord refused the post (HTTP {status})"),
            },
            Self::Unreachable => "Discord couldn't be reached".to_string(),
            Self::Cancelled => "cancelled".to_string(),
        }
    }
}

/// An image sent with a post and shown in its embed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thumbnail {
    pub filename: String,
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

/// What one HTTP attempt decided.
#[derive(Debug, PartialEq, Eq)]
enum Attempt<T> {
    Done(T),
    Retry(Option<Duration>),
    Fail(SendError),
}

/// Checks a pasted webhook before it is stored: one GET, no retries.
pub async fn verify(
    client: &reqwest::Client,
    origin: &str,
    webhook: &WebhookUrl,
) -> Result<WebhookInfo, SendError> {
    let response = match client.get(webhook.endpoint(origin)).send().await {
        Ok(response) => response,
        Err(_) => return Err(SendError::Unreachable),
    };
    let status = response.status().as_u16();
    match status {
        200..=299 => response
            .json::<WebhookInfo>()
            .await
            .map_err(|_| SendError::Unreachable),
        401 | 404 => Err(SendError::WebhookGone),
        429 | 500..=599 => Err(SendError::Unreachable),
        _ => Err(SendError::Rejected {
            status,
            code: discord_error_code(&response.text().await.unwrap_or_default()),
        }),
    }
}

/// How long a post or edit keeps trying. Tests shrink it.
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub steps: &'static [Duration],
    pub budget: Duration,
    pub max_retry_after: Duration,
}

impl RetryPolicy {
    pub const DEFAULT: Self = Self {
        steps: &RETRY_STEPS,
        budget: RETRY_BUDGET,
        max_retry_after: MAX_RETRY_AFTER,
    };
}

/// Posts a new message (`?wait=true` returns it) with the thumbnail as its
/// one attachment. Retries 429/5xx/network within the policy's budget, and
/// stops between attempts once `cancelled` is set.
pub async fn execute(
    client: &reqwest::Client,
    origin: &str,
    webhook: &WebhookUrl,
    body: &Value,
    thumbnail: Option<&Thumbnail>,
    policy: RetryPolicy,
    cancelled: &Arc<AtomicBool>,
) -> Result<Posted, SendError> {
    let url = format!(
        "{}?wait=true&with_components=true",
        webhook.endpoint(origin)
    );
    let url = url.as_str();
    let posted = with_retries(policy, cancelled, move || async move {
        let request = match thumbnail {
            Some(thumbnail) => {
                let mut body = body.clone();
                body["attachments"] = json!([{ "id": 0, "filename": thumbnail.filename }]);
                let Ok(part) = reqwest::multipart::Part::bytes(thumbnail.bytes.clone())
                    .file_name(thumbnail.filename.clone())
                    .mime_str(thumbnail.content_type)
                else {
                    return Attempt::Fail(SendError::Rejected {
                        status: 0,
                        code: None,
                    });
                };
                let form = reqwest::multipart::Form::new()
                    .text("payload_json", body.to_string())
                    .part("files[0]", part);
                client.post(url).multipart(form)
            }
            None => client.post(url).json(body),
        };
        match request.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let retry_after = header_retry_after(&response);
                let text = response.text().await.unwrap_or_default();
                match classify(status, retry_after, &text, SendError::WebhookGone) {
                    Attempt::Done(()) => Attempt::Done(parse_posted(&text)),
                    Attempt::Retry(after) => Attempt::Retry(after),
                    Attempt::Fail(error) => Attempt::Fail(error),
                }
            }
            Err(_) => Attempt::Retry(None),
        }
    })
    .await?;
    posted.ok_or(SendError::Unreachable)
}

/// Edits a message the webhook posted. Attachments are kept (none are sent).
pub async fn edit(
    client: &reqwest::Client,
    origin: &str,
    webhook: &WebhookUrl,
    message_id: &str,
    body: &Value,
    policy: RetryPolicy,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), SendError> {
    if message_id.is_empty() || !message_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(SendError::MessageGone);
    }
    let url = format!(
        "{}/messages/{message_id}?with_components=true",
        webhook.endpoint(origin)
    );
    let url = url.as_str();
    with_retries(policy, cancelled, move || async move {
        match client.patch(url).json(body).send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let retry_after = header_retry_after(&response);
                let text = response.text().await.unwrap_or_default();
                classify(status, retry_after, &text, SendError::MessageGone)
            }
            Err(_) => Attempt::Retry(None),
        }
    })
    .await
}

async fn with_retries<T, F, Fut>(
    policy: RetryPolicy,
    cancelled: &Arc<AtomicBool>,
    attempt: F,
) -> Result<T, SendError>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Attempt<T>>,
{
    let started = tokio::time::Instant::now();
    let mut step = 0usize;
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(SendError::Cancelled);
        }
        match attempt().await {
            Attempt::Done(value) => return Ok(value),
            Attempt::Fail(error) => return Err(error),
            Attempt::Retry(after) => {
                let wait = after.map_or_else(
                    || policy.steps[step.min(policy.steps.len().saturating_sub(1))],
                    |after| after.min(policy.max_retry_after),
                );
                step += 1;
                if started.elapsed() + wait > policy.budget {
                    return Err(SendError::Unreachable);
                }
                tokio::time::sleep(wait).await;
            }
        }
    }
}

/// `missing` is what a 401/404 means for this request: the webhook for a
/// post, the message for an edit.
fn classify(
    status: u16,
    retry_after: Option<Duration>,
    body: &str,
    missing: SendError,
) -> Attempt<()> {
    match status {
        200..=299 => Attempt::Done(()),
        429 => Attempt::Retry(retry_after.or_else(|| body_retry_after(body))),
        401 | 403 if missing == SendError::MessageGone => Attempt::Fail(SendError::WebhookGone),
        401 => Attempt::Fail(SendError::WebhookGone),
        404 => {
            // Discord's "Unknown Webhook" is 10015; "Unknown Message" 10008.
            match discord_error_code(body) {
                Some(10015) => Attempt::Fail(SendError::WebhookGone),
                _ => Attempt::Fail(missing),
            }
        }
        400 if refuses_components(body) => Attempt::Fail(SendError::ComponentsRefused),
        408 | 500..=599 => Attempt::Retry(None),
        _ => Attempt::Fail(SendError::Rejected {
            status,
            code: discord_error_code(body),
        }),
    }
}

fn parse_posted(body: &str) -> Option<Posted> {
    let value: Value = serde_json::from_str(body).ok()?;
    let message_id = value.get("id")?.as_str()?.to_string();
    Some(Posted {
        message_id,
        channel_id: value
            .get("channel_id")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn header_retry_after(response: &reqwest::Response) -> Option<Duration> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map(Duration::from_secs_f64)
}

fn body_retry_after(body: &str) -> Option<Duration> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get("retry_after")?
        .as_f64()
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map(Duration::from_secs_f64)
}

fn discord_error_code(body: &str) -> Option<u64> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get("code")?
        .as_u64()
}

fn refuses_components(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    value
        .get("errors")
        .is_some_and(|errors| errors.get("components").is_some())
        || value
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| message.to_lowercase().contains("component"))
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
