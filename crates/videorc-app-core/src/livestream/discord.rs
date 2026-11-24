//! S3.5b: Destinations → Discord (plan 187: `discord-section.tsx`,
//! `lib/discord-announce.ts`, `hooks/use-discord-announce.ts`) as data.
//!
//! The backend owns the webhooks (their URLs never come back: a hint and
//! Discord's name only) and posts; the page reads `discord.announce.get`
//! and `.changed`, previews the links (`discord.links.preview`) and edits
//! through `discord.announce.update`, `discord.webhook.save`, `.remove` and
//! `.sendTest`. A test post goes to the streamer's own webhook only when
//! they press Send test message; the smokes point it at a fake.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::copy;
use super::targets::Target;

/// `DISCORD_MAX_WEBHOOKS`.
pub const MAX_WEBHOOKS: usize = 3;

pub mod methods {
    pub const GET: &str = "discord.announce.get";
    pub const UPDATE: &str = "discord.announce.update";
    pub const WEBHOOK_SAVE: &str = "discord.webhook.save";
    pub const WEBHOOK_REMOVE: &str = "discord.webhook.remove";
    pub const WEBHOOK_SEND_TEST: &str = "discord.webhook.sendTest";
    pub const LINKS_PREVIEW: &str = "discord.links.preview";
}

/// `discord.announce.changed`.
pub const CHANGED_EVENT: &str = "discord.announce.changed";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LastError {
    pub code: String,
    #[serde(default)]
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LastPost {
    #[serde(default)]
    pub at: String,
    #[serde(default)]
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Webhook {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub hint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_post: Option<LastPost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<LastError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub name: String,
    #[serde(default)]
    pub post_as: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

/// `DiscordAnnounceSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub webhooks: Vec<Webhook>,
    #[serde(default)]
    pub post_as: Value,
    #[serde(default)]
    pub identities: Vec<Identity>,
    #[serde(default)]
    pub ping: String,
    #[serde(default)]
    pub branding: bool,
    #[serde(default)]
    pub excluded_target_ids: Vec<String>,
    #[serde(default)]
    pub link_overrides: Value,
}

/// One link row of the preview (`DiscordLinkPreview`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    pub target_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub link_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    #[serde(default)]
    pub included: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sender {
    #[serde(default)]
    pub name: String,
}

/// `DiscordLinksPreview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    #[serde(default)]
    pub links: Vec<LinkPreview>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<Sender>,
}

/// `discordLinkTargets`: what the backend needs to name and link each
/// destination.
pub fn link_targets(targets: &[Target], raw: &Value) -> Value {
    let rows: Vec<Value> = targets
        .iter()
        .map(|target| {
            let mut row = serde_json::Map::new();
            row.insert("id".into(), Value::String(target.id.clone()));
            row.insert("platform".into(), Value::String(target.platform.clone()));
            row.insert("label".into(), Value::String(target.label.clone()));
            row.insert("authMode".into(), Value::String(target.auth_mode.clone()));
            if let Some(account) = &target.account_id {
                row.insert("accountId".into(), Value::String(account.clone()));
            }
            if let Some(orientation) = &target.output_orientation {
                row.insert(
                    "outputOrientation".into(),
                    Value::String(orientation.clone()),
                );
            }
            let broadcast = raw
                .get("streaming")
                .and_then(|s| s.get("targets"))
                .and_then(Value::as_array)
                .and_then(|list| {
                    list.iter()
                        .find(|t| t.get("id").and_then(Value::as_str) == Some(target.id.as_str()))
                })
                .and_then(|t| t.get("platformBroadcastId"))
                .and_then(Value::as_str);
            if let Some(broadcast) = broadcast {
                row.insert(
                    "platformBroadcastId".into(),
                    Value::String(broadcast.into()),
                );
            }
            Value::Object(row)
        })
        .collect();
    Value::Array(rows)
}

/// `discordWebhookFormatError`: `None` for an empty field or a webhook URL.
pub fn webhook_format_error(raw: &str) -> Option<&'static str> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    let Ok(url) = url::Url::parse(value) else {
        return Some(copy::NOT_A_WEBHOOK);
    };
    let host = url.host_str().unwrap_or_default();
    let hosts = [
        "discord.com",
        "discordapp.com",
        "ptb.discord.com",
        "canary.discord.com",
    ];
    if url.scheme() != "https" || !hosts.contains(&host) || url.port().is_some() {
        return Some(copy::NOT_A_WEBHOOK);
    }
    let segments: Vec<&str> = url.path().split('/').filter(|s| !s.is_empty()).collect();
    let versioned = segments.len() == 5
        && segments[1].starts_with('v')
        && segments[1].len() > 1
        && segments[1][1..].chars().all(|c| c.is_ascii_digit());
    let tail: Vec<&str> = if versioned {
        vec![segments[0], segments[2], segments[3], segments[4]]
    } else {
        segments
    };
    let ok = tail.len() == 4
        && tail[0] == "api"
        && tail[1] == "webhooks"
        && (1..=25).contains(&tail[2].len())
        && tail[2].chars().all(|c| c.is_ascii_digit())
        && (1..=128).contains(&tail[3].len())
        && tail[3]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    (!ok).then_some(copy::NOT_A_WEBHOOK)
}

/// `postAsKey`.
pub fn post_as_key(post_as: &Value) -> String {
    match post_as.get("kind").and_then(Value::as_str) {
        Some("platform") => format!(
            "platform:{}",
            post_as
                .get("accountId")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ),
        Some(kind) => kind.to_string(),
        None => "automatic".to_string(),
    }
}

/// `postAsFromKey`.
pub fn post_as_from_key(key: &str) -> Value {
    if let Some(account) = key.strip_prefix("platform:") {
        return serde_json::json!({ "kind": "platform", "accountId": account });
    }
    match key {
        "videorc" | "webhook" => serde_json::json!({ "kind": key }),
        _ => serde_json::json!({ "kind": "automatic" }),
    }
}

/// `nextExcludedTargetIds`.
pub fn next_excluded(excluded: &[String], target_id: &str, included: bool) -> Vec<String> {
    let mut rest: Vec<String> = excluded
        .iter()
        .filter(|id| *id != target_id)
        .cloned()
        .collect();
    if !included {
        rest.push(target_id.to_string());
    }
    rest
}

/// `discordErrorLine`.
pub fn error_line(code: &str) -> Option<&'static str> {
    match code {
        "webhook-deleted" => Some(copy::WEBHOOK_DELETED_LINE),
        "unreachable" => Some(copy::UNREACHABLE_LINE),
        "rejected" => Some(copy::REJECTED_LINE),
        _ => None,
    }
}

// --- appended to livestream/discord.rs: the section as data ---------------

/// A webhook's test (`TestState`), the page's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Test {
    Sending,
    Sent(Option<String>),
    Failed(String),
}

/// The page's Discord memory.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DiscordMemory {
    pub adding: bool,
    pub paste: String,
    pub paste_pending: bool,
    pub refusal: Option<String>,
    pub tests: std::collections::BTreeMap<String, Test>,
    pub confirm_remove: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookView {
    pub id: String,
    pub name: String,
    pub line: String,
    pub last_post: Option<String>,
    pub view_url: Option<String>,
    pub test_line: Option<String>,
    pub errors: Vec<String>,
    pub test_label: String,
    pub test_enabled: bool,
    pub test_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkView {
    pub target_id: String,
    pub label: String,
    pub context: String,
    pub included: bool,
    pub linkable: bool,
    /// `typed`, `auto`, `at-go-live` or `none`.
    pub kind: String,
    pub link: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscordView {
    pub description: String,
    pub loading: bool,
    pub error: Option<String>,
    pub connected: bool,
    pub paste_label: String,
    pub paste_shown: bool,
    pub paste_cancel: bool,
    pub paste_error: Option<String>,
    pub webhooks: Vec<WebhookView>,
    pub add_enabled: bool,
    pub add_reason: Option<String>,
    pub enabled: bool,
    pub post_as: Vec<(String, String)>,
    pub post_as_selected: i32,
    pub ping: i32,
    pub branding: bool,
    pub links: Vec<LinkView>,
}

/// `formatRelativeTime(at, now)` for "Last post …": "now", "5m", "3h", "2d",
/// then "Oct 2" ("Oct 2, 2025" outside this year) in local time.
pub fn relative(at: &str, now_ms: i64) -> String {
    use chrono::{Datelike, Local, Utc};
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(at) else {
        return String::new();
    };
    let at = at.with_timezone(&Utc);
    let now = chrono::DateTime::from_timestamp_millis(now_ms).unwrap_or_default();
    const MINUTE: i64 = 60_000;
    const HOUR: i64 = 60 * MINUTE;
    const DAY: i64 = 24 * HOUR;
    let elapsed = (now - at).num_milliseconds().max(0);
    if elapsed < 45_000 {
        return "now".into();
    }
    if elapsed < HOUR {
        return format!("{}m", (elapsed / MINUTE).max(1));
    }
    if elapsed < DAY {
        return format!("{}h", elapsed / HOUR);
    }
    if elapsed < 7 * DAY {
        return format!("{}d", elapsed / DAY);
    }
    let local = at.with_timezone(&Local);
    if local.year() == now.with_timezone(&Local).year() {
        local.format("%b %-d").to_string()
    } else {
        local.format("%b %-d, %Y").to_string()
    }
}

pub fn discord_view(
    snapshot: Option<&Snapshot>,
    preview: Option<&Preview>,
    error: Option<&str>,
    memory: &DiscordMemory,
    now_ms: i64,
) -> DiscordView {
    let several = snapshot.is_some_and(|s| s.webhooks.len() > 1);
    let description = copy::discord_description(several);
    let Some(snapshot) = snapshot else {
        return DiscordView {
            description,
            loading: error.is_none(),
            error: error.map(str::to_string),
            connected: false,
            paste_label: String::new(),
            paste_shown: false,
            paste_cancel: false,
            paste_error: None,
            webhooks: Vec::new(),
            add_enabled: false,
            add_reason: None,
            enabled: false,
            post_as: Vec::new(),
            post_as_selected: 0,
            ping: 0,
            branding: false,
            links: Vec::new(),
        };
    };
    let any_deleted = snapshot.webhooks.iter().any(|w| {
        w.last_error
            .as_ref()
            .is_some_and(|e| e.code == "webhook-deleted")
    });
    let full = snapshot.webhooks.len() >= MAX_WEBHOOKS;
    let none = snapshot.webhooks.is_empty();
    let paste_shown = none || (!full && (memory.adding || any_deleted));
    let paste_error = memory
        .refusal
        .clone()
        .or_else(|| webhook_format_error(&memory.paste).map(str::to_string));
    let webhooks = snapshot
        .webhooks
        .iter()
        .map(|w| {
            let deleted = w
                .last_error
                .as_ref()
                .is_some_and(|e| e.code == "webhook-deleted");
            let test = memory.tests.get(&w.id);
            let mut errors: Vec<String> = Vec::new();
            if let Some(line) = w.last_error.as_ref().and_then(|e| error_line(&e.code)) {
                errors.push(line.to_string());
            }
            if let Some(Test::Failed(message)) = test {
                errors.push(message.clone());
            }
            WebhookView {
                id: w.id.clone(),
                name: w.name.clone().unwrap_or_else(|| copy::WEBHOOK.to_string()),
                line: copy::posts_to_channel(&w.hint),
                last_post: w
                    .last_post
                    .as_ref()
                    .map(|post| copy::last_post(&relative(&post.at, now_ms), post.state == "live")),
                view_url: match test {
                    Some(Test::Sent(Some(url))) => Some(url.clone()),
                    _ => w.last_post.as_ref().and_then(|p| p.message_url.clone()),
                },
                test_line: match test {
                    Some(Test::Sent(Some(_))) => Some(copy::TEST_SENT.to_string()),
                    Some(Test::Sent(None)) => {
                        Some(format!("{} {}", copy::TEST_SENT, copy::CHECK_THE_CHANNEL))
                    }
                    _ => None,
                },
                errors,
                test_label: if test == Some(&Test::Sending) {
                    copy::SENDING
                } else {
                    copy::SEND_TEST
                }
                .to_string(),
                test_enabled: test != Some(&Test::Sending) && !deleted,
                test_reason: deleted.then(|| copy::PASTE_NEW_FIRST.to_string()),
            }
        })
        .collect();
    let automatic = post_as_key(&snapshot.post_as) == "automatic";
    let sender = preview
        .and_then(|p| p.sender.as_ref())
        .filter(|_| automatic)
        .map(|s| s.name.clone());
    let mut post_as = vec![(
        "automatic".to_string(),
        match sender {
            Some(name) => copy::automatic_with(&name),
            None => copy::AUTOMATIC.to_string(),
        },
    )];
    post_as.extend(
        snapshot
            .identities
            .iter()
            .map(|identity| (post_as_key(&identity.post_as), identity.name.clone())),
    );
    post_as.push(("webhook".to_string(), copy::WEBHOOK_OWN_NAME.to_string()));
    let selected_key = post_as_key(&snapshot.post_as);
    let post_as_selected = post_as
        .iter()
        .position(|(key, _)| *key == selected_key)
        .map_or(0, |i| i as i32);
    let links = preview
        .map(|p| {
            p.links
                .iter()
                .map(|row| LinkView {
                    target_id: row.target_id.clone(),
                    label: row.label.clone(),
                    context: match row.link_kind.as_str() {
                        "at-go-live" => copy::LINK_AT_GO_LIVE.to_string(),
                        "none" => copy::NO_PUBLIC_LINK.to_string(),
                        _ => row.link.clone().unwrap_or_default(),
                    },
                    included: row.included,
                    linkable: row.link_kind != "none",
                    kind: row.link_kind.clone(),
                    link: row.link.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    DiscordView {
        description,
        loading: false,
        error: error.map(str::to_string),
        connected: !none,
        paste_label: if none {
            copy::WEBHOOK_URL
        } else if any_deleted {
            copy::NEW_WEBHOOK_URL
        } else {
            copy::ANOTHER_WEBHOOK_URL
        }
        .to_string(),
        paste_shown,
        paste_cancel: !none && memory.adding && !any_deleted,
        paste_error,
        webhooks,
        add_enabled: !full,
        add_reason: full.then(|| copy::webhook_cap(MAX_WEBHOOKS)),
        enabled: snapshot.enabled,
        post_as,
        post_as_selected,
        ping: match snapshot.ping.as_str() {
            "here" => 1,
            "everyone" => 2,
            _ => 0,
        },
        branding: snapshot.branding,
        links,
    }
}

/// `FAILURE_TOAST_WINDOW_MS`: how long after it happened a failure is still
/// news worth a toast.
const FAILURE_TOAST_WINDOW_MS: i64 = 10 * 60 * 1000;

/// `DiscordFailureToast`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailureToast {
    pub at: String,
    /// An error toast (deleted, refused) or a warning (unreachable).
    pub error: bool,
    pub title: &'static str,
    pub description: String,
}

/// `discordFailureToast`: the newest failure across the webhooks, never the
/// same one twice, never an old one a settings change carries.
pub fn failure_toast(last: Option<&str>, snapshot: &Snapshot, now_ms: i64) -> Option<FailureToast> {
    let millis = |at: &str| {
        chrono::DateTime::parse_from_rfc3339(at)
            .ok()
            .map(|t| t.timestamp_millis())
    };
    let (name, error) = snapshot
        .webhooks
        .iter()
        .filter_map(|w| w.last_error.as_ref().map(|e| (w.name.as_deref(), e)))
        .max_by_key(|(_, e)| millis(&e.at).unwrap_or(i64::MIN))?;
    if last == Some(error.at.as_str()) {
        return None;
    }
    let at = millis(&error.at)?;
    if now_ms - at > FAILURE_TOAST_WINDOW_MS {
        return None;
    }
    let (is_error, description) = match error.code.as_str() {
        "webhook-deleted" => (true, copy::webhook_deleted_toast(&copy::the_webhook(name))),
        "unreachable" => (false, copy::unreachable_toast(name)),
        "rejected" => (true, copy::rejected_toast(name)),
        _ => return None,
    };
    Some(FailureToast {
        at: error.at.clone(),
        error: is_error,
        title: copy::COULDNT_POST_TO_DISCORD,
        description,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(webhooks: Value) -> Snapshot {
        serde_json::from_value(json!({
            "enabled": true,
            "webhooks": webhooks,
            "postAs": { "kind": "automatic" },
            "ping": "here",
            "branding": true,
        }))
        .expect("a snapshot")
    }

    #[test]
    fn the_section_names_each_webhook_and_its_failure() {
        let snap = snapshot(json!([
            { "id": "a", "name": "Videorc bot", "hint": "…abcd" },
            { "id": "b", "hint": "…wxyz", "lastError": { "code": "webhook-deleted", "at": "2026-11-12T10:00:00Z" } },
        ]));
        let view = discord_view(Some(&snap), None, None, &DiscordMemory::default(), 0);
        assert!(view.connected);
        assert_eq!(view.ping, 1);
        assert_eq!(view.webhooks[0].name, "Videorc bot");
        assert_eq!(view.webhooks[0].line, "Posts to its channel · …abcd");
        assert_eq!(view.webhooks[1].name, "Webhook");
        assert_eq!(
            view.webhooks[1].errors,
            ["This webhook was deleted in Discord. Paste a new one."]
        );
        assert!(!view.webhooks[1].test_enabled);
        // A deleted webhook wants a replacement: the field shows itself.
        assert!(view.paste_shown);
        assert_eq!(view.paste_label, "New webhook URL");
        assert_eq!(view.post_as[0].1, "Automatic");
        assert_eq!(view.post_as.last().unwrap().1, "The webhook's own name");
    }

    #[test]
    fn a_failure_toasts_once_and_never_when_old() {
        let snap = snapshot(json!([
            { "id": "a", "name": "Main", "hint": "…", "lastError": { "code": "unreachable", "at": "2026-11-12T10:00:00Z" } },
        ]));
        let at = chrono::DateTime::parse_from_rfc3339("2026-11-12T10:00:00Z")
            .unwrap()
            .timestamp_millis();
        let toast = failure_toast(None, &snap, at + 1_000).expect("a toast");
        assert!(!toast.error);
        assert_eq!(toast.title, "Couldn't post to Discord");
        assert_eq!(
            toast.description,
            "Discord couldn't be reached for 5 minutes (Main). Your stream is fine."
        );
        assert_eq!(failure_toast(Some(&toast.at), &snap, at + 1_000), None);
        assert_eq!(failure_toast(None, &snap, at + 11 * 60 * 1000), None);
        let deleted = snapshot(json!([
            { "id": "a", "hint": "…", "lastError": { "code": "webhook-deleted", "at": "2026-11-12T10:00:00Z" } },
        ]));
        assert_eq!(
            failure_toast(None, &deleted, at).unwrap().description,
            "The webhook was deleted in Discord. Paste a new one in Destinations → Discord."
        );
        assert_eq!(
            webhook_format_error("https://example.com"),
            Some(copy::NOT_A_WEBHOOK)
        );
        assert_eq!(webhook_format_error(""), None);
        assert_eq!(
            next_excluded(&["x".into()], "twitch", false),
            ["x", "twitch"]
        );
    }
}
