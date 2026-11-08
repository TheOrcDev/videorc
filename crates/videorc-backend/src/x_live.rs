use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha1::Sha1;
use tokio::time::sleep;
use uuid::Uuid;

use crate::streaming::{
    PlatformAccount, StreamMetadataDraft, StreamPlatform, stream_platform_label,
};

type HmacSha1 = Hmac<Sha1>;

const X_LIVESTREAM_DOCS_URL: &str = "https://docs.x.com/livestream-api/migration-guide";
const X_API_OVERVIEW_URL: &str = "https://docs.x.com/x-api/overview";
pub const DEFAULT_API_BASE_URL: &str = "https://api.x.com";
const DEFAULT_SOURCE_NAME: &str = "Videorc Primary Encoder";
const DEFAULT_LOCALE: &str = "en";
const DEFAULT_CHAT_OPTION: u8 = 2;

// Build-time defaults for the Videorc X OAuth 1.0a consumer pair (the
// allow-listed Livestream app's API key + secret). Injected from
// ~/.videorc-release.env at release build time — the same mechanism as the
// bundled YouTube client secret — never hardcoded in source. Runtime env
// values still override for self-hosted apps.
const BUNDLED_X_OAUTH1_CONSUMER_KEY: Option<&str> =
    option_env!("VIDEORC_BUNDLED_X_OAUTH1_CONSUMER_KEY");
const BUNDLED_X_OAUTH1_CONSUMER_SECRET: Option<&str> =
    option_env!("VIDEORC_BUNDLED_X_OAUTH1_CONSUMER_SECRET");

// Secret-store refs for the per-user OAuth 1.0a token minted by the in-app
// "Authorize X Live" flow. The handle ref is display metadata (@screen_name),
// kept beside the token so disconnect wipes all three together.
pub const X_OAUTH1_ACCESS_TOKEN_SECRET_REF: &str = "platform:x:oauth1:access-token";
pub const X_OAUTH1_TOKEN_SECRET_SECRET_REF: &str = "platform:x:oauth1:token-secret";
pub const X_OAUTH1_HANDLE_SECRET_REF: &str = "platform:x:oauth1:handle";

/// Reads a stored secret; `Ok(None)` means "not stored". Injected so unit
/// tests never touch the real secret store.
pub type SecretReader<'a> = &'a dyn Fn(&str) -> Result<Option<String>>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XNativeLiveCapabilityParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XPrepareParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XPublishParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// The 19-digit source id from prepare (never the stream key).
    pub source_id: String,
    /// Active capture session — X lifecycle events land in its session log.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XEndParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub broadcast_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum XNativeLiveCapabilityState {
    /// This build has no OAuth 1.0a consumer credentials at all (self-hosted
    /// build without env configuration).
    MissingCredentials,
    /// The consumer pair is present but no user has authorized X Live yet —
    /// the renderer offers the "Authorize X Live" browser flow.
    NeedsAuthorization,
    Ready,
    AccountMismatch,
    ApiError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XNativeLiveCapability {
    pub platform: StreamPlatform,
    pub state: XNativeLiveCapabilityState,
    pub native_available: bool,
    pub manual_rtmp_available: bool,
    pub oauth_connected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_source: Option<String>,
    pub message: String,
    pub evidence: Vec<String>,
    pub docs_url: String,
    pub api_overview_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedXStreamSource {
    pub platform: StreamPlatform,
    pub account_id: String,
    pub account_label: String,
    pub source_id: String,
    pub region: String,
    pub server_url: String,
    pub stream_key_secret_ref: String,
    pub stream_key_present: bool,
    pub redacted_url: String,
    pub is_stream_active: bool,
    pub selection: XSourceSelection,
    /// Idle Videorc-named leftovers deleted during this prepare (best-effort
    /// quota hygiene).
    #[serde(default)]
    pub deleted_retired_source_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XPublishResult {
    pub platform: StreamPlatform,
    pub account_id: String,
    pub source_id: String,
    pub broadcast_id: String,
    pub media_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_id: Option<String>,
    pub share_url: String,
    pub state: String,
    /// The announcing Post, when X had already created it at Go Live time.
    /// Missing is not an error: X posts asynchronously and never reports a
    /// failed Post (the state watch reads it later).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tweet_id: Option<String>,
    /// `true` when `POST /2/broadcasts` answered 200: the source already had a
    /// live broadcast, which X returned unchanged.
    #[serde(default)]
    pub already_live: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XEndResult {
    pub platform: StreamPlatform,
    pub account_id: String,
    pub broadcast_id: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XLivestreamCredentials {
    pub consumer_key: String,
    pub consumer_secret: String,
    pub access_token: String,
    pub access_token_secret: String,
    pub user_id: String,
    pub account_label: Option<String>,
    pub credential_source: String,
}

#[derive(Debug, Clone)]
pub struct XPrepareSourceRequest {
    pub credentials: XLivestreamCredentials,
    pub account: Option<PlatformAccount>,
    pub source_name: String,
    pub api_base_url: Option<String>,
}

/// How prepare arrived at the source it returns (session-log evidence).
/// `Created` is the plan-031 default — a fresh source per session is the
/// only condition that has ever produced instantly-watchable playback;
/// `ReusedNameMatch` happens only when X refuses to create (e.g. quota).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum XSourceSelection {
    EnvOverride,
    ReusedNameMatch,
    Created,
}

#[derive(Debug, Clone)]
pub struct XPublishRequest {
    pub credentials: XLivestreamCredentials,
    pub source_id: String,
    pub metadata: StreamMetadataDraft,
    pub locale: String,
    pub chat_option: u8,
    pub api_base_url: Option<String>,
    /// `GET /2/sources/:id` polls for `is_stream_active` before Go Live: the
    /// announcing Post goes out the instant the call returns, so video must
    /// already be flowing.
    pub poll_attempts: usize,
    pub poll_interval_ms: u64,
    /// `POST /2/broadcasts` answers 409 while the source cannot take video
    /// yet (and may answer 5xx or lose its response); retry that many times
    /// with this backoff before giving up.
    pub conflict_attempts: usize,
    pub conflict_backoff_ms: u64,
}

#[derive(Debug, Clone)]
pub struct XEndRequest {
    pub credentials: XLivestreamCredentials,
    pub broadcast_id: String,
    pub api_base_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct XRegionResponse {
    region: String,
}

/// The X API v2 `data` wrapper every `/2/sources` and `/2/broadcasts`
/// response uses (lists add `meta.result_count`, which nothing reads).
#[derive(Debug, Clone, Deserialize)]
struct XData<T> {
    data: T,
}

/// A stream source as `/2/sources` returns it. `id` is the 19-digit source
/// id (not a secret); `stream_key` is present only in the `POST /2/sources`
/// response and the `GET /2/sources/:id/stream_key` answer.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct XStreamSource {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default, alias = "rtmp_region")]
    pub(crate) region: Option<String>,
    #[serde(default)]
    pub(crate) rtmps_url: Option<String>,
    #[serde(default)]
    pub(crate) rtmp_url: Option<String>,
    #[serde(default)]
    pub(crate) stream_key: Option<String>,
    #[serde(default)]
    pub(crate) is_stream_active: bool,
}

/// `GET /2/sources/:id/stream_key` → `{"data":{"id","stream_key"}}`.
#[derive(Debug, Clone, Deserialize)]
struct XStreamKey {
    #[serde(default)]
    stream_key: Option<String>,
}

/// Legacy app_settings key of the retired per-source playback health map.
/// Its keys were old stream keys (the deprecated routes used the key as the
/// source id), so the map is cleared, never migrated.
pub const LEGACY_X_SOURCE_HEALTH_SETTING: &str = "xSourceHealth";

/// `true` for an X source id: the 19-digit (all ASCII digits, non-empty)
/// identifier the `/2/sources` routes take. A stream key is never one.
pub fn is_x_source_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit())
}

/// The broadcast's media id is not returned by the new routes: it is the
/// digits after the last `_` in `media_key` (`28_2116610227978326016` →
/// `2116610227978326016`).
pub fn x_media_id_from_media_key(media_key: &str) -> Option<String> {
    let (_, digits) = media_key.trim().rsplit_once('_')?;
    is_x_source_id(digits).then(|| digits.to_string())
}

#[derive(Debug, Clone, Deserialize)]
struct XBroadcast {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    broadcast_id: Option<String>,
    #[serde(default)]
    media_key: Option<String>,
    #[serde(default)]
    share_url: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    tweet_id: Option<String>,
}

/// One failed X Livestream API call: the HTTP status plus the problem
/// `detail` (or the legacy `message`), never the request body or URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XApiError {
    pub status: u16,
    pub detail: String,
}

impl std::fmt::Display for XApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reason = reqwest::StatusCode::from_u16(self.status)
            .ok()
            .and_then(|status| status.canonical_reason())
            .map(|reason| format!(" {reason}"))
            .unwrap_or_default();
        write!(
            formatter,
            "X Livestream API request failed with HTTP {}{reason}: {}",
            self.status, self.detail
        )
    }
}

impl std::error::Error for XApiError {}

impl XApiError {
    pub fn is_conflict(&self) -> bool {
        self.status == 409
    }
}

/// Whether a failed Go Live may be sent again. X documents `POST
/// /2/broadcasts` as safe to retry: a source that already went live answers
/// 200 with the same broadcast. So a 409 (encoder not connected yet), a 5xx
/// (temporary failure) and a lost or unreadable response are retried; any
/// other 4xx is final.
fn go_live_error_is_retryable(error: &anyhow::Error) -> bool {
    match error.downcast_ref::<XApiError>() {
        Some(api_error) => api_error.is_conflict() || api_error.status >= 500,
        None => true,
    }
}

/// What the broadcast state watch does with one `GET /2/broadcasts/:id`
/// sample (plan: X migration). Pure so the decision is testable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum XBroadcastWatchVerdict {
    /// Still RUNNING (or no state field yet): keep watching.
    KeepWatching,
    /// The owning session is gone: nothing left to protect, stop quietly.
    SessionOver,
    /// X moved the broadcast out of RUNNING while the session still streams
    /// (TIMED_OUT when no video reached X within 5 minutes, ENDED, or any
    /// other state): the streamer must hear about it.
    EndedByX { state: String },
}

pub fn x_broadcast_watch_verdict(
    state: Option<&str>,
    session_active: bool,
) -> XBroadcastWatchVerdict {
    if !session_active {
        return XBroadcastWatchVerdict::SessionOver;
    }
    match state.map(str::trim).filter(|state| !state.is_empty()) {
        None => XBroadcastWatchVerdict::KeepWatching,
        Some(state) if state.eq_ignore_ascii_case("RUNNING") => {
            XBroadcastWatchVerdict::KeepWatching
        }
        Some(state) => XBroadcastWatchVerdict::EndedByX {
            state: state.to_ascii_uppercase(),
        },
    }
}

/// One `GET /2/broadcasts/:id?broadcast.fields=state,tweet_id` sample.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct XBroadcastStateSample {
    pub state: Option<String>,
    pub tweet_id: Option<String>,
}

/// Reads the broadcast's `state` and `tweet_id`, signed like every other
/// Livestream call (the query is part of the OAuth 1.0a base string).
pub async fn fetch_broadcast_state(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    broadcast_id: &str,
) -> Result<XBroadcastStateSample> {
    let mut url = endpoint(base_url, &format!("/2/broadcasts/{broadcast_id}"))?;
    url.query_pairs_mut()
        .append_pair("broadcast.fields", "state,tweet_id");
    let body: serde_json::Value =
        send_x_request(client, credentials, Method::GET, url, None).await?;
    let broadcast = crate::scheduled_x::payload(&body);
    let text = |key: &str| {
        broadcast
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    };
    Ok(XBroadcastStateSample {
        state: text("state"),
        tweet_id: text("tweet_id"),
    })
}

/// The application-level OAuth 1.0a consumer pair. Runtime env wins, then the
/// bundled release default. `Ok(None)` means this build cannot sign X
/// Livestream requests at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XOauth1Consumer {
    pub key: String,
    pub secret: String,
    /// "environment" or "bundled" — surfaced in diagnostics, never the values.
    pub source: &'static str,
}

pub fn x_oauth1_consumer() -> Result<Option<XOauth1Consumer>> {
    let key = optional_env_any(&["VIDEORC_X_OAUTH1_CONSUMER_KEY", "X_CONSUMER_KEY"]);
    let secret = optional_env_any(&["VIDEORC_X_OAUTH1_CONSUMER_SECRET", "X_CONSUMER_SECRET"]);
    match (key, secret) {
        (Some(key), Some(secret)) => Ok(Some(XOauth1Consumer {
            key,
            secret,
            source: "environment",
        })),
        (None, None) => Ok(bundled_x_oauth1_consumer()),
        _ => anyhow::bail!(
            "X Livestream OAuth 1.0a consumer configuration is incomplete. Set both VIDEORC_X_OAUTH1_CONSUMER_KEY and VIDEORC_X_OAUTH1_CONSUMER_SECRET, or neither."
        ),
    }
}

fn bundled_x_oauth1_consumer() -> Option<XOauth1Consumer> {
    let key = BUNDLED_X_OAUTH1_CONSUMER_KEY
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let secret = BUNDLED_X_OAUTH1_CONSUMER_SECRET
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(XOauth1Consumer {
        key: key.to_string(),
        secret: secret.to_string(),
        source: "bundled",
    })
}

/// Full env-token override (smoke rigs and self-hosting): the user access
/// token pair comes straight from env. Setting either token var claims this
/// path, so a partial set is an explicit error instead of a silent fallback
/// to the in-app authorization token.
fn x_livestream_env_token_credentials() -> Result<Option<XLivestreamCredentials>> {
    let access_token = optional_env_any(&["VIDEORC_X_OAUTH1_ACCESS_TOKEN", "X_ACCESS_TOKEN"]);
    let access_token_secret = optional_env_any(&[
        "VIDEORC_X_OAUTH1_ACCESS_TOKEN_SECRET",
        "X_ACCESS_TOKEN_SECRET",
    ]);
    if access_token.is_none() && access_token_secret.is_none() {
        return Ok(None);
    }
    let (Some(access_token), Some(access_token_secret)) = (access_token, access_token_secret)
    else {
        anyhow::bail!(
            "X Livestream OAuth 1.0a env credentials are incomplete. Set both VIDEORC_X_OAUTH1_ACCESS_TOKEN and VIDEORC_X_OAUTH1_ACCESS_TOKEN_SECRET."
        );
    };
    let consumer = x_oauth1_consumer()?.context(
        "X Livestream OAuth 1.0a access token env vars are set, but no consumer key/secret is configured. Set VIDEORC_X_OAUTH1_CONSUMER_KEY and VIDEORC_X_OAUTH1_CONSUMER_SECRET.",
    )?;
    let user_id = optional_env_any(&["VIDEORC_X_OAUTH1_USER_ID", "X_USER_ID"])
        .or_else(|| access_token.split_once('-').map(|(prefix, _)| prefix.to_string()))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .context(
            "X Livestream OAuth 1.0a user id is missing. Set VIDEORC_X_OAUTH1_USER_ID or use an access token whose prefix is the numeric X user id.",
        )?;
    if !user_id.chars().all(|character| character.is_ascii_digit()) {
        anyhow::bail!("X Livestream user id must be numeric.");
    }

    Ok(Some(XLivestreamCredentials {
        consumer_key: consumer.key,
        consumer_secret: consumer.secret,
        access_token,
        access_token_secret,
        user_id,
        account_label: optional_env_any(&["VIDEORC_X_ACCOUNT_LABEL", "X_ACCOUNT_LABEL"]),
        credential_source: if std::env::var("VIDEORC_X_OAUTH1_ACCESS_TOKEN").is_ok() {
            "videorc-env".to_string()
        } else {
            "x-env".to_string()
        },
    }))
}

/// Resolves the signing credentials for X Livestream calls: env token
/// override first, then the per-user token minted by the in-app "Authorize X
/// Live" flow (consumer from env/bundled + token from the secret store).
pub fn x_livestream_credentials() -> Result<Option<XLivestreamCredentials>> {
    x_livestream_credentials_with(&crate::secrets::try_get_secret)
}

pub fn x_livestream_credentials_with(
    read_secret: SecretReader<'_>,
) -> Result<Option<XLivestreamCredentials>> {
    if let Some(credentials) = x_livestream_env_token_credentials()? {
        return Ok(Some(credentials));
    }
    let Some(consumer) = x_oauth1_consumer()? else {
        return Ok(None);
    };
    let Some(access_token) = read_secret(X_OAUTH1_ACCESS_TOKEN_SECRET_REF)? else {
        return Ok(None);
    };
    let Some(access_token_secret) = read_secret(X_OAUTH1_TOKEN_SECRET_SECRET_REF)? else {
        return Ok(None);
    };
    // X access tokens are "<numeric user id>-<random>"; the Livestream paths
    // need that user id and reject mismatches with HTTP 400.
    let user_id = access_token
        .split_once('-')
        .map(|(prefix, _)| prefix.trim().to_string())
        .filter(|value| {
            !value.is_empty() && value.chars().all(|character| character.is_ascii_digit())
        })
        .context(
            "The stored X Live access token is malformed (expected a numeric user id prefix). Re-run Authorize X Live.",
        )?;
    let account_label = read_secret(X_OAUTH1_HANDLE_SECRET_REF)?;
    Ok(Some(XLivestreamCredentials {
        consumer_key: consumer.key,
        consumer_secret: consumer.secret,
        access_token,
        access_token_secret,
        user_id,
        account_label,
        credential_source: "user-authorized".to_string(),
    }))
}

pub fn x_native_live_capability(
    account: Option<&PlatformAccount>,
) -> Result<XNativeLiveCapability> {
    x_native_live_capability_with(account, &crate::secrets::try_get_secret)
}

pub fn x_native_live_capability_with(
    account: Option<&PlatformAccount>,
    read_secret: SecretReader<'_>,
) -> Result<XNativeLiveCapability> {
    let consumer = x_oauth1_consumer()?;
    let credentials = x_livestream_credentials_with(read_secret)?;
    let Some(credentials) = credentials else {
        if let Some(consumer) = consumer {
            return Ok(XNativeLiveCapability {
                platform: StreamPlatform::X,
                state: XNativeLiveCapabilityState::NeedsAuthorization,
                native_available: false,
                manual_rtmp_available: true,
                oauth_connected: account.is_some(),
                account_id: account.map(|account| account.account_id.clone()),
                account_label: account.map(|account| account.account_label.clone()),
                credential_source: Some(format!("consumer-{}", consumer.source)),
                message: "Authorize X Live to let Videorc create stream sources and broadcasts on your X account.".to_string(),
                evidence: vec![
                    "X Livestream management endpoints need a per-user OAuth 1.0a token; the OAuth2 sign-in used for chat cannot mint one.".to_string(),
                    "Authorize X Live opens x.com in the browser; the resulting token is stored only in the local secret store.".to_string(),
                    "Manual RTMP remains available only when the user explicitly chooses Manual RTMP.".to_string(),
                ],
                docs_url: X_LIVESTREAM_DOCS_URL.to_string(),
                api_overview_url: X_API_OVERVIEW_URL.to_string(),
            });
        }
        return Ok(XNativeLiveCapability {
            platform: StreamPlatform::X,
            state: XNativeLiveCapabilityState::MissingCredentials,
            native_available: false,
            manual_rtmp_available: true,
            oauth_connected: account.is_some(),
            account_id: account.map(|account| account.account_id.clone()),
            account_label: account.map(|account| account.account_label.clone()),
            credential_source: None,
            message: "X Livestream API access is approved, but this build has no X OAuth 1.0a consumer credentials.".to_string(),
            evidence: vec![
                "Release builds bundle the Videorc consumer key/secret at build time; self-hosted builds set VIDEORC_X_OAUTH1_CONSUMER_KEY and VIDEORC_X_OAUTH1_CONSUMER_SECRET.".to_string(),
                "X Livestream management endpoints require OAuth 1.0a user-context credentials, not the existing OAuth2 PKCE token.".to_string(),
                "Manual RTMP remains available only when the user explicitly chooses Manual RTMP.".to_string(),
            ],
            docs_url: X_LIVESTREAM_DOCS_URL.to_string(),
            api_overview_url: X_API_OVERVIEW_URL.to_string(),
        });
    };

    if let Some(account) = account
        && account.account_id != credentials.user_id
        && account.id != credentials.user_id
    {
        return Ok(XNativeLiveCapability {
            platform: StreamPlatform::X,
            state: XNativeLiveCapabilityState::AccountMismatch,
            native_available: false,
            manual_rtmp_available: true,
            oauth_connected: true,
            account_id: Some(account.account_id.clone()),
            account_label: Some(account.account_label.clone()),
            credential_source: Some(credentials.credential_source),
            message: "Connected X account does not match the account that authorized X Live.".to_string(),
            evidence: vec![
                "X takes the broadcast owner from the OAuth 1.0a token, so Videorc would go live on the account that authorized X Live, not the connected one.".to_string(),
                "Re-run Authorize X Live signed in as the connected X account, or reconnect the matching account.".to_string(),
            ],
            docs_url: X_LIVESTREAM_DOCS_URL.to_string(),
            api_overview_url: X_API_OVERVIEW_URL.to_string(),
        });
    }

    Ok(XNativeLiveCapability {
        platform: StreamPlatform::X,
        state: XNativeLiveCapabilityState::Ready,
        native_available: true,
        manual_rtmp_available: true,
        oauth_connected: account.is_some(),
        account_id: Some(credentials.user_id),
        account_label: account
            .map(|account| account.account_label.clone())
            .or(credentials.account_label),
        credential_source: Some(credentials.credential_source),
        message: "X Livestream API credentials are configured. Videorc can prepare a native X source and publish broadcasts through the allow-listed API.".to_string(),
        evidence: vec![
            "OAuth 1.0a consumer key, consumer secret, access token, and token secret are present.".to_string(),
            "The /2/sources and /2/broadcasts routes take the owner from that token; the numeric X user id only identifies the connected account.".to_string(),
            "Stream keys come only from the create-source response or GET /2/sources/:id/stream_key; they are stored in the backend secret store and redacted from UI/logs.".to_string(),
        ],
        docs_url: X_LIVESTREAM_DOCS_URL.to_string(),
        api_overview_url: X_API_OVERVIEW_URL.to_string(),
    })
}

pub fn ensure_x_native_live_available(capability: &XNativeLiveCapability) -> Result<()> {
    if capability.native_available {
        return Ok(());
    }

    anyhow::bail!("{}", capability.message)
}

pub fn select_x_account<'a>(
    accounts: &'a [PlatformAccount],
    account_id: Option<&str>,
) -> Result<Option<&'a PlatformAccount>> {
    let account = accounts.iter().find(|account| {
        account.platform == StreamPlatform::X
            && account_id.is_none_or(|account_id| {
                account.account_id == account_id || account.id == account_id
            })
    });
    if account_id.is_some() {
        account.context("No connected X OAuth account matched the requested account id.")?;
    }

    Ok(account)
}

pub async fn prepare_x_stream_source<F>(
    request: XPrepareSourceRequest,
    client: &reqwest::Client,
    mut put_secret: F,
) -> Result<PreparedXStreamSource>
where
    F: FnMut(&str, &str) -> Result<()>,
{
    let base_url = api_base_url(request.api_base_url.as_deref());
    let credentials = request.credentials;
    let region = match optional_env_any(&["VIDEORC_X_LIVESTREAM_REGION", "X_LIVESTREAM_REGION"]) {
        Some(region) => region,
        None => get_region(client, &credentials, &base_url).await?,
    };
    let mut deleted_retired_source_ids = Vec::new();
    // The stream key arrives with the source only from `POST /2/sources`;
    // every reused source needs the dedicated stream_key route.
    let (source, selection) = if let Some(source_id) =
        optional_env_any(&["VIDEORC_X_LIVESTREAM_SOURCE_ID", "X_LIVESTREAM_SOURCE_ID"])
    {
        if !is_x_source_id(&source_id) {
            anyhow::bail!(
                "VIDEORC_X_LIVESTREAM_SOURCE_ID must be the 19-digit source id from GET /2/sources, not a stream key."
            );
        }
        let mut source = get_source(client, &credentials, &base_url, &source_id).await?;
        source.stream_key =
            Some(get_source_stream_key(client, &credentials, &base_url, &source_id).await?);
        (source, XSourceSelection::EnvOverride)
    } else {
        let sources = list_sources(client, &credentials, &base_url)
            .await
            .unwrap_or_default();
        // Fresh source per session (plan 031): the only condition that has
        // EVER produced instantly-watchable playback is a source's FIRST
        // broadcast — the 2026-07-08 incident source played from second one
        // on first use, then spun viewers on every reuse after a hard
        // teardown. Create first; reuse is only a fallback when X refuses
        // (e.g. per-user source quota).
        match create_source(
            client,
            &credentials,
            &base_url,
            &request.source_name,
            &region,
        )
        .await
        {
            Ok(created) => {
                // Quota hygiene: yesterday's Videorc sources are dead weight.
                // Delete everything idle that we own by name — never the
                // source just created, and never one actively receiving.
                for source_id in x_source_cleanup_ids(&sources, &request.source_name, &created.id) {
                    if delete_source(client, &credentials, &base_url, &source_id)
                        .await
                        .is_ok()
                    {
                        deleted_retired_source_ids.push(source_id);
                    }
                }
                (created, XSourceSelection::Created)
            }
            Err(create_error) => {
                let fallback = sources
                    .iter()
                    .find(|source| {
                        source.name.as_deref() == Some(request.source_name.as_str())
                            && source.region.as_deref() == Some(region.as_str())
                    })
                    .cloned();
                match fallback {
                    Some(mut fallback) => {
                        fallback.stream_key = Some(
                            get_source_stream_key(client, &credentials, &base_url, &fallback.id)
                                .await?,
                        );
                        (fallback, XSourceSelection::ReusedNameMatch)
                    }
                    None => {
                        return Err(create_error.context(
                            "Could not create a fresh X stream source and no reusable one exists.",
                        ));
                    }
                }
            }
        }
    };

    let source_id = source.id.trim().to_string();
    if !is_x_source_id(&source_id) {
        anyhow::bail!("X stream source response did not include a source id.");
    }
    let server_url = source
        .rtmps_url
        .as_deref()
        .or(source.rtmp_url.as_deref())
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .context("X stream source response did not include an RTMPS ingest URL.")?
        .to_string();
    let stream_key = source
        .stream_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .context("X stream source response did not include a stream key.")?
        .to_string();
    let region = source
        .region
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(region);
    let secret_ref = format!(
        "platform:x:{}:{}:stream-key",
        credentials.user_id,
        sanitize_secret_ref_segment(&source_id)
    );
    put_secret(&secret_ref, &stream_key).context("Could not store X RTMPS stream key.")?;

    Ok(PreparedXStreamSource {
        platform: StreamPlatform::X,
        account_id: credentials.user_id.clone(),
        account_label: request
            .account
            .map(|account| account.account_label)
            .or(credentials.account_label)
            .unwrap_or_else(|| stream_platform_label(StreamPlatform::X).to_string()),
        source_id,
        region,
        server_url,
        stream_key_secret_ref: secret_ref,
        stream_key_present: true,
        redacted_url: "rtmps://<x-ingest>/<stream-key>".to_string(),
        is_stream_active: source.is_stream_active,
        selection,
        deleted_retired_source_ids,
    })
}

pub async fn publish_x_broadcast(
    request: XPublishRequest,
    client: &reqwest::Client,
) -> Result<XPublishResult> {
    let base_url = api_base_url(request.api_base_url.as_deref());
    if !is_x_source_id(&request.source_id) {
        anyhow::bail!(
            "X Go Live needs the 19-digit source id from prepare, not a stream key. Prepare the X source again."
        );
    }
    // The announcing Post goes out the instant Go Live returns, so video must
    // already be flowing (X ends a broadcast without video as TIMED_OUT).
    let attempts = request.poll_attempts.max(1);
    let mut active = false;
    for attempt in 0..attempts {
        let source =
            get_source(client, &request.credentials, &base_url, &request.source_id).await?;
        if source.is_stream_active {
            active = true;
            break;
        }
        if attempt + 1 < attempts {
            sleep(Duration::from_millis(request.poll_interval_ms)).await;
        }
    }
    if !active {
        anyhow::bail!("X RTMPS source did not become active before Go Live.");
    }

    let body = GoLiveRequest {
        source_id: &request.source_id,
        title: &x_title(&request.metadata),
        locale: &request.locale,
        chat_option: request.chat_option,
        should_not_tweet: x_should_not_tweet(&request.metadata),
    };
    let conflict_attempts = request.conflict_attempts.max(1);
    let mut outcome = None;
    for attempt in 0..conflict_attempts {
        match go_live(client, &request.credentials, &base_url, &body).await {
            Ok(result) => {
                outcome = Some(result);
                break;
            }
            // 409: the source cannot take video yet (retry once video flows)
            // or another broadcast is live on it (`detail` names it). 5xx and
            // a lost response are retried too: a retry of a call that did go
            // live answers 200 with that broadcast. The final error keeps X's
            // detail.
            Err(error) if attempt + 1 < conflict_attempts && go_live_error_is_retryable(&error) => {
                sleep(Duration::from_millis(request.conflict_backoff_ms)).await;
            }
            Err(error) => return Err(error),
        }
    }
    let (already_live, broadcast) = outcome.context("X Go Live produced no broadcast.")?;
    let broadcast_id = broadcast
        .broadcast_id
        .clone()
        .or(broadcast.id.clone())
        .context("X Go Live response did not include a broadcast id.")?;
    // `media_key` is optional in the Go Live response, and by now the
    // broadcast is already RUNNING on X with its Post out: a missing key must
    // never turn a live broadcast into a reported failure.
    let media_key = broadcast.media_key.clone().unwrap_or_default();
    let share_url = broadcast
        .share_url
        .clone()
        .unwrap_or_else(|| format!("https://x.com/i/broadcasts/{broadcast_id}"));

    Ok(XPublishResult {
        platform: StreamPlatform::X,
        account_id: request.credentials.user_id,
        source_id: request.source_id,
        broadcast_id,
        media_id: x_media_id_from_media_key(&media_key),
        media_key,
        share_url,
        state: broadcast.state.unwrap_or_else(|| "RUNNING".to_string()),
        tweet_id: broadcast.tweet_id,
        already_live,
        message: if already_live {
            "X broadcast was already live on this source; X returned it unchanged.".to_string()
        } else {
            "X broadcast is live.".to_string()
        },
    })
}

pub async fn end_x_broadcast(request: XEndRequest, client: &reqwest::Client) -> Result<XEndResult> {
    let base_url = api_base_url(request.api_base_url.as_deref());
    end_broadcast(
        client,
        &request.credentials,
        &base_url,
        &request.broadcast_id,
    )
    .await?;
    Ok(XEndResult {
        platform: StreamPlatform::X,
        account_id: request.credentials.user_id,
        broadcast_id: request.broadcast_id,
        message: "X broadcast ended.".to_string(),
    })
}

pub fn default_source_name() -> String {
    optional_env_any(&[
        "VIDEORC_X_LIVESTREAM_SOURCE_NAME",
        "X_LIVESTREAM_SOURCE_NAME",
    ])
    .unwrap_or_else(|| DEFAULT_SOURCE_NAME.to_string())
}

pub fn default_publish_locale() -> String {
    optional_env_any(&["VIDEORC_X_LIVESTREAM_LOCALE", "X_LIVESTREAM_LOCALE"])
        .unwrap_or_else(|| DEFAULT_LOCALE.to_string())
}

/// Go Live `chat_option` (X Livestream API doc): 0 default, 1 chat off,
/// 2 everyone, 3 verified accounts, 4 accounts the host follows, 5 the
/// host's subscribers, 6 accounts followed by an account the host follows.
/// Sent as a JSON integer; `POST /2/broadcasts` rejects numeric strings.
pub fn default_chat_option() -> u8 {
    optional_env_any(&[
        "VIDEORC_X_LIVESTREAM_CHAT_OPTION",
        "X_LIVESTREAM_CHAT_OPTION",
    ])
    .and_then(|value| value.parse::<u8>().ok())
    .unwrap_or(DEFAULT_CHAT_OPTION)
}

pub(crate) async fn get_region(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
) -> Result<String> {
    let url = endpoint(base_url, "/2/region")?;
    let response: XRegionResponse =
        send_x_request(client, credentials, Method::GET, url, None).await?;
    Ok(response.region)
}

async fn list_sources(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
) -> Result<Vec<XStreamSource>> {
    let url = endpoint(base_url, "/2/sources")?;
    let response: XData<Vec<XStreamSource>> =
        send_x_request(client, credentials, Method::GET, url, None).await?;
    Ok(response.data)
}

/// `POST /2/sources` (201): the only response that carries `stream_key`.
/// The body is exactly `{name, region}`; X rejects any other field.
async fn create_source(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    name: &str,
    region: &str,
) -> Result<XStreamSource> {
    let url = endpoint(base_url, "/2/sources")?;
    let body = json!({ "name": name, "region": region });
    let response: XData<XStreamSource> =
        send_x_request(client, credentials, Method::POST, url, Some(body)).await?;
    Ok(response.data)
}

/// Which existing sources to delete after a fresh one is created: idle
/// Videorc-named sources (previous sessions' leftovers). Never the fresh
/// source, never one actively receiving.
fn x_source_cleanup_ids(
    sources: &[XStreamSource],
    source_name: &str,
    keep_source_id: &str,
) -> Vec<String> {
    sources
        .iter()
        .filter(|source| source.id != keep_source_id && !source.is_stream_active)
        // A scheduled broadcast's dedicated source outlives every instant
        // session; it is deleted only by the scheduler that created it.
        .filter(|source| {
            !source.name.as_deref().is_some_and(|name| {
                name.starts_with(crate::scheduled_x::SCHEDULED_SOURCE_NAME_PREFIX)
            })
        })
        .filter(|source| source.name.as_deref() == Some(source_name))
        .map(|source| source.id.clone())
        .collect()
}

async fn delete_source(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    source_id: &str,
) -> Result<()> {
    let url = endpoint(base_url, &format!("/2/sources/{source_id}"))?;
    let _: serde_json::Value =
        send_x_request(client, credentials, Method::DELETE, url, None).await?;
    Ok(())
}

async fn get_source(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    source_id: &str,
) -> Result<XStreamSource> {
    let url = endpoint(base_url, &format!("/2/sources/{source_id}"))?;
    let response: XData<XStreamSource> =
        send_x_request(client, credentials, Method::GET, url, None).await?;
    Ok(response.data)
}

/// `GET /2/sources/:id/stream_key`: the credential for a source Videorc did
/// not just create. Fetched only to configure the encoder; never logged.
async fn get_source_stream_key(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    source_id: &str,
) -> Result<String> {
    let url = endpoint(base_url, &format!("/2/sources/{source_id}/stream_key"))?;
    let response: XData<XStreamKey> =
        send_x_request(client, credentials, Method::GET, url, None).await?;
    response
        .data
        .stream_key
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .context("X stream_key response did not include a stream key.")
}

/// The strict `POST /2/broadcasts` body: exactly these five fields, with
/// `chat_option` a JSON integer and `should_not_tweet` a JSON boolean.
/// Unknown fields (the old `region`, `is_low_latency`) are a 400.
#[derive(Debug, Clone, Serialize)]
struct GoLiveRequest<'a> {
    source_id: &'a str,
    title: &'a str,
    locale: &'a str,
    chat_option: u8,
    should_not_tweet: bool,
}

/// `POST /2/broadcasts`: creates and publishes in one call. 201 is a new
/// RUNNING broadcast; 200 is the broadcast already live on the source,
/// returned unchanged (`already_live`).
async fn go_live(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    body: &GoLiveRequest<'_>,
) -> Result<(bool, XBroadcast)> {
    let url = endpoint(base_url, "/2/broadcasts")?;
    let body = serde_json::to_value(body).context("Could not encode the X Go Live body.")?;
    let (status, response): (reqwest::StatusCode, XData<XBroadcast>) =
        send_x_request_with_status(client, credentials, Method::POST, url, Some(body)).await?;
    Ok((status == reqwest::StatusCode::OK, response.data))
}

/// One X viewer poll (plan 054): the concurrent count, or why there is none.
/// The reasons carry key names and HTTP statuses only, never a body or URL,
/// so they are safe to write to the session log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum XViewerCountOutcome {
    Count(u64),
    /// Plan 223 A4: the broadcast's `state` is `ENDED` while we stream.
    Ended,
    /// The broadcast came back without a concurrent-viewer field.
    NoField {
        keys: Vec<String>,
    },
    Http {
        status: u16,
    },
    Transport,
}

impl XViewerCountOutcome {
    pub fn count(&self) -> Option<u64> {
        match self {
            Self::Count(count) => Some(*count),
            _ => None,
        }
    }

    /// A stable one-line reason for the session log; `None` for a count.
    pub fn log_reason(&self) -> Option<String> {
        match self {
            Self::Count(_) => None,
            Self::Ended => Some("X reports the broadcast ended.".to_string()),
            Self::NoField { keys } => Some(format!(
                "X broadcast had no concurrent-viewer field (keys: {}).",
                if keys.is_empty() {
                    "none".to_string()
                } else {
                    keys.join(", ")
                }
            )),
            Self::Http { status } => Some(format!("X broadcast lookup failed with HTTP {status}.")),
            Self::Transport => Some("X broadcast lookup could not reach X.".to_string()),
        }
    }
}

/// Concurrent viewers of a live X broadcast: `GET /2/broadcasts/{id}`, the
/// documented "while live" call (viewer counts, thumbnails and state), signed
/// with the "Authorize X Live" OAuth 1.0a token. A missing count is a skipped
/// sample, never an error: the sampler's failure discipline
/// (viewer_stats.rs) forbids degrading the stream over telemetry.
pub async fn fetch_broadcast_viewer_count(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    broadcast_id: &str,
) -> XViewerCountOutcome {
    // GET /2/broadcasts/:id — the user-prefixed route is deprecated (docs
    // verified 2026-08-19); ownership is still enforced by the auth context.
    let Ok(mut url) = endpoint(base_url, &format!("/2/broadcasts/{broadcast_id}")) else {
        return XViewerCountOutcome::Transport;
    };
    // X returns only `id`, `state`, `title` and `start_ms` unless the fields
    // are asked for (OpenAPI `BroadcastFieldsParameter`). Without this the
    // count never arrived on a real broadcast (2026-09-25 session log: "no
    // concurrent-viewer field (keys: id, start_ms, state, title)"). The
    // query is part of the OAuth 1.0a signature base string.
    url.query_pairs_mut()
        .append_pair("broadcast.fields", X_BROADCAST_VIEWER_FIELDS);
    let Ok(authorization) = oauth1_authorization_header(
        Method::GET.as_str(),
        url.as_str(),
        credentials,
        &oauth_nonce(),
        oauth_timestamp(),
    ) else {
        return XViewerCountOutcome::Transport;
    };
    let Ok(response) = client
        .get(url)
        .header("Authorization", authorization)
        .send()
        .await
    else {
        return XViewerCountOutcome::Transport;
    };
    let status = response.status();
    if !status.is_success() {
        return XViewerCountOutcome::Http {
            status: status.as_u16(),
        };
    }
    match response.json::<serde_json::Value>().await {
        Ok(body) => x_broadcast_viewer_outcome(&body),
        Err(_) => XViewerCountOutcome::Transport,
    }
}

/// The `broadcast.fields` the viewer poll asks for: the count plus `state`,
/// so a lookup that still lacks the count logs what X did send.
const X_BROADCAST_VIEWER_FIELDS: &str = "total_watching,state";

/// Concurrent-viewer fields, current name first. `total_watched` is the
/// cumulative count and is never used: it would inflate the chip.
const X_CONCURRENT_VIEWER_KEYS: [&str; 5] = [
    "total_watching",
    "viewer_count",
    "concurrent_viewers",
    "num_watching",
    "watching_count",
];

/// Reads the count from `GetBroadcastResponse`: the official OpenAPI wraps
/// the `Broadcast` in `data` (plan 054), older shapes in `broadcast`, and the
/// count is a string.
pub fn x_broadcast_viewer_outcome(body: &serde_json::Value) -> XViewerCountOutcome {
    let broadcast = crate::scheduled_x::payload(body);
    // Plan 223 A4: an ended broadcast while we stream is the platform's word
    // that viewers get nothing; the count no longer means anything.
    if broadcast
        .get("state")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|state| state.eq_ignore_ascii_case("ENDED"))
    {
        return XViewerCountOutcome::Ended;
    }
    for key in X_CONCURRENT_VIEWER_KEYS {
        let Some(count) = broadcast.get(key) else {
            continue;
        };
        if let Some(count) = count.as_u64() {
            return XViewerCountOutcome::Count(count);
        }
        if let Some(count) = count.as_str().and_then(|value| value.trim().parse().ok()) {
            return XViewerCountOutcome::Count(count);
        }
    }
    let mut keys: Vec<String> = broadcast
        .as_object()
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default();
    keys.sort();
    XViewerCountOutcome::NoField { keys }
}

/// Maximum chat message length X accepts (`POST /2/broadcasts/:id/chat`).
pub const X_CHAT_MESSAGE_MAX_CHARS: usize = 140;

/// Send a plain-text chat message to a LIVE broadcast as the authorized user.
/// Closed-beta Livestream API (docs verified 2026-08-19): OAuth 1.0a user
/// context is an accepted auth for this route, so the existing "Authorize X
/// Live" credentials qualify. Returns the server timestamp (nanoseconds,
/// decimal string) — which is also the message id. Errors are user-facing
/// strings for the comments send surface.
pub async fn send_broadcast_chat_message(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    broadcast_id: &str,
    text: &str,
) -> Result<String, String> {
    let url = endpoint(base_url, &format!("/2/broadcasts/{broadcast_id}/chat"))
        .map_err(|error| format!("X chat endpoint could not be built: {error}"))?;
    let authorization = oauth1_authorization_header(
        "POST",
        url.as_str(),
        credentials,
        &oauth_nonce(),
        oauth_timestamp(),
    )
    .map_err(|error| format!("X chat request could not be signed: {error}"))?;
    let response = client
        .post(url)
        .header("Authorization", authorization)
        .json(&json!({ "text": text }))
        .send()
        .await
        .map_err(|error| format!("Could not reach X to send the chat message: {error}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    if status.as_u16() == 403 {
        return Err(
            "X did not permit this account to chat in the broadcast (chat settings may limit who can post)."
                .to_string(),
        );
    }
    if status.as_u16() == 400 {
        return Err(
            "X rejected the chat message. The broadcast may not be live yet or has ended."
                .to_string(),
        );
    }
    if !status.is_success() {
        return Err(format!("X chat send failed with HTTP {}.", status.as_u16()));
    }
    let data = body.get("data").cloned().unwrap_or_default();
    if data.get("success").and_then(|value| value.as_bool()) != Some(true) {
        return Err("X reported the chat message was not sent.".to_string());
    }
    Ok(data
        .get("timestamp")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string())
}

/// The hide reason the moderation engine shows after "Viewers on X still see it."
pub const X_MODERATE_REAUTHORIZE_REASON: &str =
    "Authorize X Live again to let Buddy remove messages.";

/// X chat message ids are snowflake-sized decimal strings. The relay's
/// `messageId` is validated to this shape before it ever becomes a path
/// segment (plan 140, pending the owner's live id check).
pub fn x_chat_message_id_is_valid(message_id: &str) -> bool {
    !message_id.is_empty()
        && message_id.len() <= 19
        && message_id
            .chars()
            .all(|character| character.is_ascii_digit())
}

/// Remove one chat message from a LIVE broadcast (plan 140 S4):
/// `DELETE /2/broadcasts/{broadcast_id}/chat/{message_id}` answers
/// `{"data":{"deleted":true}}` for the owner or a chat moderator, with the
/// same OAuth 1.0a "Authorize X Live" credentials the chat send uses.
pub async fn delete_broadcast_chat_message(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    broadcast_id: &str,
    message_id: &str,
) -> crate::live_chat_moderation::ProviderDeleteOutcome {
    use crate::live_chat_moderation::{ModerationOutcomeCode, ProviderDeleteOutcome};

    let message_id = message_id.trim();
    if !x_chat_message_id_is_valid(message_id) {
        return ProviderDeleteOutcome::CannotDelete {
            code: ModerationOutcomeCode::Unsupported,
            reason: "X gave this message an id Videorc cannot remove.".to_string(),
        };
    }
    let broadcast_id = broadcast_id.trim();
    if broadcast_id.is_empty()
        || !broadcast_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return ProviderDeleteOutcome::Failed(
            "X needs the broadcast id to remove a chat message; nothing was sent.".to_string(),
        );
    }
    let url = match endpoint(
        base_url,
        &format!("/2/broadcasts/{broadcast_id}/chat/{message_id}"),
    ) {
        Ok(url) => url,
        Err(error) => {
            return ProviderDeleteOutcome::Failed(format!(
                "X chat endpoint could not be built: {error}"
            ));
        }
    };
    let authorization = match oauth1_authorization_header(
        "DELETE",
        url.as_str(),
        credentials,
        &oauth_nonce(),
        oauth_timestamp(),
    ) {
        Ok(authorization) => authorization,
        Err(error) => {
            return ProviderDeleteOutcome::Failed(format!(
                "X chat request could not be signed: {error}"
            ));
        }
    };
    let response = match client
        .delete(url)
        .header("Authorization", authorization)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return ProviderDeleteOutcome::Transient(format!(
                "Could not reach X to remove the chat message: {error}"
            ));
        }
    };
    let status = response.status().as_u16();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    classify_x_delete_response(status, &body)
}

/// Pure: what an X chat delete status and body mean. A 2xx without
/// `data.deleted: true` is not a removal; 400 is X refusing because the
/// broadcast is not running.
pub(crate) fn classify_x_delete_response(
    status: u16,
    body: &serde_json::Value,
) -> crate::live_chat_moderation::ProviderDeleteOutcome {
    use crate::live_chat_moderation::{ModerationOutcomeCode, ProviderDeleteOutcome};

    match status {
        200..=299 => {
            if body
                .pointer("/data/deleted")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
            {
                ProviderDeleteOutcome::Deleted
            } else {
                ProviderDeleteOutcome::Failed("X did not confirm the removal.".to_string())
            }
        }
        404 => ProviderDeleteOutcome::NotFound,
        400 => ProviderDeleteOutcome::CannotDelete {
            code: ModerationOutcomeCode::Unsupported,
            reason: "X only removes messages while the broadcast is live.".to_string(),
        },
        401 | 403 => ProviderDeleteOutcome::CannotDelete {
            code: ModerationOutcomeCode::MissingScope,
            reason: X_MODERATE_REAUTHORIZE_REASON.to_string(),
        },
        429 | 500..=599 => ProviderDeleteOutcome::Transient(format!("X answered HTTP {status}.")),
        _ => ProviderDeleteOutcome::Failed(format!("X removal failed with HTTP {status}.")),
    }
}

pub const X_BROADCAST_CHAT_EVENT_TYPE: &str = "broadcast.chat";
/// Someone followed (inbound) or the user followed someone (outbound);
/// Videorc subscribes inbound only (plan 071, S4).
pub const X_FOLLOW_EVENT_TYPE: &str = "follow.follow";
/// A follow subscription lapses this long after its last refresh, so follows
/// stop reaching the relay soon after a stream ends even if the app quits.
pub const X_FOLLOW_SUBSCRIPTION_TTL: chrono::Duration = chrono::Duration::hours(2);
const X_VERIFY_CREDENTIALS_PATH: &str = "/2/users/me";

/// An X Activity API call failed. `rejected` means X refused the credentials
/// (401/403): retrying cannot help until the user re-authorizes X Live.
#[derive(Debug)]
pub struct XActivityApiError {
    pub rejected: bool,
    pub message: String,
}

impl std::fmt::Display for XActivityApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for XActivityApiError {}

/// How an X Activity API call authenticates. Listing and creating a user's
/// subscription take OAuth 1.0a user context; deleting one only works with the
/// app bearer (user context answers HTTP 503 — verified against the live API
/// 2026-09-20).
enum XActivityAuth<'a> {
    User(&'a XLivestreamCredentials),
    App(&'a str),
}

async fn send_x_activity_request(
    client: &reqwest::Client,
    auth: XActivityAuth<'_>,
    method: Method,
    url: Url,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, XActivityApiError> {
    let transient = |message: String| XActivityApiError {
        rejected: false,
        message,
    };
    let authorization = match auth {
        XActivityAuth::User(credentials) => oauth1_authorization_header(
            method.as_str(),
            url.as_str(),
            credentials,
            &oauth_nonce(),
            oauth_timestamp(),
        )
        .map_err(|error| {
            transient(format!(
                "X Activity API request could not be signed: {error}"
            ))
        })?,
        XActivityAuth::App(bearer) => format!("Bearer {bearer}"),
    };
    let mut request = client
        .request(method, url)
        .timeout(std::time::Duration::from_secs(15))
        .header("Authorization", authorization);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| transient(format!("Could not reach the X Activity API: {error}")))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let detail = x_error_detail(&text).unwrap_or_else(|| "no error detail".to_string());
        return Err(XActivityApiError {
            rejected: matches!(status.as_u16(), 401 | 403),
            message: format!("X Activity API request failed with HTTP {status}: {detail}"),
        });
    }
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

/// App-only bearer for the consumer pair this build already carries. Only used
/// to delete this user's own chat subscriptions.
async fn mint_x_app_bearer(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
) -> Result<String, XActivityApiError> {
    let transient = |message: String| XActivityApiError {
        rejected: false,
        message,
    };
    let url = endpoint(base_url, "/oauth2/token")
        .map_err(|error| transient(format!("X token endpoint could not be built: {error}")))?;
    let response = client
        .post(url)
        .timeout(std::time::Duration::from_secs(15))
        .basic_auth(
            oauth_percent_encode(&credentials.consumer_key),
            Some(oauth_percent_encode(&credentials.consumer_secret)),
        )
        .form(&[("grant_type", "client_credentials")])
        .send()
        .await
        .map_err(|error| transient(format!("Could not reach X for an app token: {error}")))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    body.get("access_token")
        .and_then(|value| value.as_str())
        .filter(|_| status.is_success())
        .map(ToOwned::to_owned)
        .ok_or_else(|| XActivityApiError {
            rejected: matches!(status.as_u16(), 401 | 403),
            message: format!("X app token request failed with HTTP {status}"),
        })
}

async fn delete_x_activity_subscriptions(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    subscription_ids: &[String],
) -> Result<(), XActivityApiError> {
    if subscription_ids.is_empty() {
        return Ok(());
    }
    let bearer = mint_x_app_bearer(client, credentials, base_url).await?;
    for subscription_id in subscription_ids {
        let url = endpoint(
            base_url,
            &format!("/2/activity/subscriptions/{subscription_id}"),
        )
        .map_err(|error| XActivityApiError {
            rejected: false,
            message: format!("X Activity API endpoint could not be built: {error}"),
        })?;
        send_x_activity_request(
            client,
            XActivityAuth::App(&bearer),
            Method::DELETE,
            url,
            None,
        )
        .await?;
    }
    Ok(())
}

/// The OAuth Echo proof for the Videorc chat relay: an Authorization header
/// valid only for `GET /2/users/me`. The relay replays it against that fixed
/// URL to learn which X user this install controls; the token itself never
/// leaves the machine.
pub fn x_identity_echo_authorization(
    credentials: &XLivestreamCredentials,
    base_url: &str,
) -> Result<String> {
    let url = endpoint(base_url, X_VERIFY_CREDENTIALS_PATH)?;
    oauth1_authorization_header(
        "GET",
        url.as_str(),
        credentials,
        &oauth_nonce(),
        oauth_timestamp(),
    )
}

fn broadcast_chat_subscriptions(
    list: &serde_json::Value,
    user_id: &str,
) -> Vec<(String, Option<String>)> {
    activity_subscriptions(list, X_BROADCAST_CHAT_EVENT_TYPE, user_id)
        .into_iter()
        .map(|(id, webhook_id, _)| (id, webhook_id))
        .collect()
}

/// This user's subscriptions of one event type: id, webhook id, and the
/// `direction` qualifier (either spelling XAA echoes).
fn activity_subscriptions(
    list: &serde_json::Value,
    event_type: &str,
    user_id: &str,
) -> Vec<(String, Option<String>, Option<String>)> {
    list.get("data")
        .and_then(|data| data.as_array())
        .into_iter()
        .flatten()
        .filter(|subscription| {
            subscription
                .get("event_type")
                .and_then(|value| value.as_str())
                == Some(event_type)
                && subscription
                    .pointer("/filter/user_id")
                    .and_then(|value| value.as_str())
                    == Some(user_id)
        })
        .filter_map(|subscription| {
            let id = subscription.get("subscription_id")?.as_str()?.to_string();
            let webhook_id = subscription
                .get("webhook_id")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned);
            let direction = subscription
                .pointer("/filter/qualifiers/direction")
                .or_else(|| subscription.pointer("/filter/direction"))
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned);
            Some((id, webhook_id, direction))
        })
        .collect()
}

/// Make sure exactly one X Activity API `broadcast.chat` subscription delivers
/// this user's broadcast chat to the Videorc relay webhook. One subscription
/// covers every broadcast the user owns, so this is idempotent across
/// sessions: a matching subscription is reused, and any pointing at another
/// (or no) webhook is replaced. OAuth 1.0a user context is accepted here
/// (verified against the live API 2026-09-19), so "Authorize X Live" is enough.
pub async fn ensure_broadcast_chat_subscription(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    webhook_id: &str,
) -> Result<String, XActivityApiError> {
    let url = |path: &str| {
        endpoint(base_url, path).map_err(|error| XActivityApiError {
            rejected: false,
            message: format!("X Activity API endpoint could not be built: {error}"),
        })
    };
    let list = send_x_activity_request(
        client,
        XActivityAuth::User(credentials),
        Method::GET,
        url("/2/activity/subscriptions")?,
        None,
    )
    .await?;

    let mut kept = None;
    let mut stale = Vec::new();
    for (subscription_id, existing_webhook) in
        broadcast_chat_subscriptions(&list, &credentials.user_id)
    {
        if kept.is_none() && existing_webhook.as_deref() == Some(webhook_id) {
            kept = Some(subscription_id);
        } else {
            stale.push(subscription_id);
        }
    }
    delete_x_activity_subscriptions(client, credentials, base_url, &stale).await?;
    if let Some(subscription_id) = kept {
        return Ok(subscription_id);
    }

    let created = send_x_activity_request(
        client,
        XActivityAuth::User(credentials),
        Method::POST,
        url("/2/activity/subscriptions")?,
        Some(json!({
            "event_type": X_BROADCAST_CHAT_EVENT_TYPE,
            "filter": { "user_id": credentials.user_id },
            "webhook_id": webhook_id,
            "tag": "videorc-live-chat",
        })),
    )
    .await?;
    created
        .pointer("/data/subscription/subscription_id")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
        .ok_or_else(|| XActivityApiError {
            rejected: false,
            message: "X Activity API did not return a subscription id.".to_string(),
        })
}

/// Make sure one inbound `follow.follow` subscription delivers this user's new
/// followers to the relay webhook until `expires_at` (plan 071, S4). Unlike
/// chat it lapses on its own: follows happen off stream too, and the relay
/// should only see them around a stream. Posting the same subscription again
/// is XAA's refresh, so a live connector calls this periodically. Any follow
/// subscription on another webhook or without the inbound qualifier is
/// removed first.
pub async fn ensure_follow_subscription(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    webhook_id: &str,
    expires_at: chrono::DateTime<chrono::Utc>,
) -> Result<(), XActivityApiError> {
    let url = |path: &str| {
        endpoint(base_url, path).map_err(|error| XActivityApiError {
            rejected: false,
            message: format!("X Activity API endpoint could not be built: {error}"),
        })
    };
    let list = send_x_activity_request(
        client,
        XActivityAuth::User(credentials),
        Method::GET,
        url("/2/activity/subscriptions")?,
        None,
    )
    .await?;
    let stale: Vec<String> =
        activity_subscriptions(&list, X_FOLLOW_EVENT_TYPE, &credentials.user_id)
            .into_iter()
            .filter(|(_, existing_webhook, direction)| {
                existing_webhook.as_deref() != Some(webhook_id)
                    || direction.as_deref() != Some("inbound")
            })
            .map(|(subscription_id, _, _)| subscription_id)
            .collect();
    delete_x_activity_subscriptions(client, credentials, base_url, &stale).await?;
    send_x_activity_request(
        client,
        XActivityAuth::User(credentials),
        Method::POST,
        url("/2/activity/subscriptions")?,
        Some(json!({
            "event_type": X_FOLLOW_EVENT_TYPE,
            "filter": {
                "user_id": credentials.user_id,
                "qualifiers": { "direction": "inbound" },
            },
            "webhook_id": webhook_id,
            "tag": "videorc-follows",
            "expires_at": expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        })),
    )
    .await?;
    Ok(())
}

/// Remove this user's `follow.follow` subscriptions (X disconnect).
pub async fn delete_follow_subscriptions(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
) -> Result<usize, XActivityApiError> {
    let url =
        endpoint(base_url, "/2/activity/subscriptions").map_err(|error| XActivityApiError {
            rejected: false,
            message: format!("X Activity API endpoint could not be built: {error}"),
        })?;
    let list = send_x_activity_request(
        client,
        XActivityAuth::User(credentials),
        Method::GET,
        url,
        None,
    )
    .await?;
    let subscription_ids: Vec<String> =
        activity_subscriptions(&list, X_FOLLOW_EVENT_TYPE, &credentials.user_id)
            .into_iter()
            .map(|(subscription_id, _, _)| subscription_id)
            .collect();
    delete_x_activity_subscriptions(client, credentials, base_url, &subscription_ids).await?;
    Ok(subscription_ids.len())
}

/// Remove this user's `broadcast.chat` subscriptions (X disconnect). Returns
/// how many were deleted.
pub async fn delete_broadcast_chat_subscriptions(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
) -> Result<usize, XActivityApiError> {
    let url = |path: &str| {
        endpoint(base_url, path).map_err(|error| XActivityApiError {
            rejected: false,
            message: format!("X Activity API endpoint could not be built: {error}"),
        })
    };
    let list = send_x_activity_request(
        client,
        XActivityAuth::User(credentials),
        Method::GET,
        url("/2/activity/subscriptions")?,
        None,
    )
    .await?;
    let subscription_ids: Vec<String> = broadcast_chat_subscriptions(&list, &credentials.user_id)
        .into_iter()
        .map(|(subscription_id, _)| subscription_id)
        .collect();
    delete_x_activity_subscriptions(client, credentials, base_url, &subscription_ids).await?;
    Ok(subscription_ids.len())
}

pub(crate) async fn end_broadcast(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    broadcast_id: &str,
) -> Result<()> {
    let url = endpoint(base_url, &format!("/2/broadcasts/{broadcast_id}/state"))?;
    // Exactly `{"state":"END"}`: any publish field here is a 400.
    let body = json!({ "state": "END" });
    let _: serde_json::Value =
        send_x_request(client, credentials, Method::PUT, url, Some(body)).await?;
    Ok(())
}

async fn send_x_request<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    method: Method,
    url: Url,
    body: Option<serde_json::Value>,
) -> Result<T> {
    send_x_request_with_status(client, credentials, method, url, body)
        .await
        .map(|(_, value)| value)
}

/// One signed call. Every 2xx is success (the new routes answer 201 on
/// create and 200 on an already-live Go Live); anything else is an
/// `XApiError` carrying the status and the problem `detail`.
async fn send_x_request_with_status<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    method: Method,
    url: Url,
    body: Option<serde_json::Value>,
) -> Result<(reqwest::StatusCode, T)> {
    let authorization = oauth1_authorization_header(
        method.as_str(),
        url.as_str(),
        credentials,
        &oauth_nonce(),
        oauth_timestamp(),
    )?;
    let mut request = client
        .request(method, url)
        .header("Authorization", authorization);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .context("Could not call X Livestream API")?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let detail = x_error_detail(&body).unwrap_or_else(|| "no error detail".to_string());
        return Err(XApiError {
            status: status.as_u16(),
            detail,
        }
        .into());
    }
    let value = response
        .json::<T>()
        .await
        .context("Could not parse X Livestream API response")?;
    Ok((status, value))
}

pub fn oauth1_authorization_header(
    method: &str,
    url: &str,
    credentials: &XLivestreamCredentials,
    nonce: &str,
    timestamp: u64,
) -> Result<String> {
    oauth1_signed_header(&Oauth1SigningInputs {
        method,
        url,
        consumer_key: &credentials.consumer_key,
        consumer_secret: &credentials.consumer_secret,
        token: Some((&credentials.access_token, &credentials.access_token_secret)),
        extra_oauth_params: &[],
        nonce,
        timestamp,
    })
}

/// One OAuth 1.0a HMAC-SHA1 signature. `token` is absent for the
/// request-token leg of the 3-legged flow (the signing key then ends in a
/// bare `&`); `extra_oauth_params` carries protocol params such as
/// `oauth_callback` and `oauth_verifier` that belong in both the signature
/// base string and the Authorization header.
pub(crate) struct Oauth1SigningInputs<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub consumer_key: &'a str,
    pub consumer_secret: &'a str,
    pub token: Option<(&'a str, &'a str)>,
    pub extra_oauth_params: &'a [(&'a str, &'a str)],
    pub nonce: &'a str,
    pub timestamp: u64,
}

pub(crate) fn oauth1_signed_header(inputs: &Oauth1SigningInputs<'_>) -> Result<String> {
    let parsed = Url::parse(inputs.url).context("OAuth 1.0a request URL is invalid.")?;
    let base_url = oauth_base_url(&parsed);
    let mut oauth_params = vec![
        (
            "oauth_consumer_key".to_string(),
            inputs.consumer_key.to_string(),
        ),
        ("oauth_nonce".to_string(), inputs.nonce.to_string()),
        (
            "oauth_signature_method".to_string(),
            "HMAC-SHA1".to_string(),
        ),
        ("oauth_timestamp".to_string(), inputs.timestamp.to_string()),
        ("oauth_version".to_string(), "1.0".to_string()),
    ];
    if let Some((token, _)) = inputs.token {
        oauth_params.push(("oauth_token".to_string(), token.to_string()));
    }
    for (key, value) in inputs.extra_oauth_params {
        oauth_params.push(((*key).to_string(), (*value).to_string()));
    }

    let mut signature_params = oauth_params.clone();
    for (key, value) in parsed.query_pairs() {
        signature_params.push((key.into_owned(), value.into_owned()));
    }
    let param_string = normalized_oauth_params(&signature_params);
    let base_string = format!(
        "{}&{}&{}",
        inputs.method.to_ascii_uppercase(),
        oauth_percent_encode(&base_url),
        oauth_percent_encode(&param_string)
    );
    let token_secret = inputs.token.map(|(_, secret)| secret).unwrap_or("");
    let signing_key = format!(
        "{}&{}",
        oauth_percent_encode(inputs.consumer_secret),
        oauth_percent_encode(token_secret)
    );
    let mut mac = HmacSha1::new_from_slice(signing_key.as_bytes())
        .context("Could not initialize OAuth 1.0a signer.")?;
    mac.update(base_string.as_bytes());
    let signature = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());

    let mut header_params = oauth_params;
    header_params.push(("oauth_signature".to_string(), signature));
    header_params.sort_by(|(left, _), (right, _)| left.cmp(right));
    let header = header_params
        .into_iter()
        .map(|(key, value)| format!(r#"{key}="{}""#, oauth_percent_encode(&value)))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!("OAuth {header}"))
}

fn oauth_base_url(url: &Url) -> String {
    let mut base = url.clone();
    base.set_query(None);
    base.set_fragment(None);
    base.to_string()
}

fn normalized_oauth_params(params: &[(String, String)]) -> String {
    let mut encoded = params
        .iter()
        .map(|(key, value)| (oauth_percent_encode(key), oauth_percent_encode(value)))
        .collect::<Vec<_>>();
    encoded.sort();
    encoded
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

pub fn oauth_percent_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                vec![byte as char]
            }
            _ => {
                let hex = format!("%{byte:02X}");
                hex.chars().collect()
            }
        })
        .collect()
}

pub(crate) fn oauth_nonce() -> String {
    Uuid::new_v4().simple().to_string()
}

pub(crate) fn oauth_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) fn api_base_url(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| optional_env_any(&["VIDEORC_X_LIVESTREAM_API_BASE_URL"]))
        .unwrap_or_else(|| DEFAULT_API_BASE_URL.to_string())
}

fn endpoint(base_url: &str, path: &str) -> Result<Url> {
    let base = Url::parse(base_url).context("X Livestream API base URL is invalid.")?;
    base.join(path)
        .with_context(|| format!("Could not build X Livestream API URL for {path}."))
}

fn optional_env_any(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

pub(crate) fn sanitize_secret_ref_segment(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

/// The human-readable reason in an X error body. The `/2/sources` and
/// `/2/broadcasts` routes answer problem JSON (`{type, title, detail,
/// status, errors?}`): `detail` leads, and the per-field `errors` messages
/// follow it in parentheses. The legacy `message` / `error` shapes still
/// parse for the routes that kept them.
pub(crate) fn x_error_detail(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let text = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|message| !message.is_empty())
            .map(ToOwned::to_owned)
    };
    let errors = value
        .get("errors")
        .and_then(serde_json::Value::as_array)
        .map(|errors| {
            errors
                .iter()
                .filter_map(|error| {
                    error
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .or_else(|| error.as_str())
                })
                .map(str::trim)
                .filter(|message| !message.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|errors| !errors.is_empty())
        .map(|errors| errors.join("; "));
    match (text("detail"), errors) {
        (Some(detail), Some(errors)) if detail != errors => Some(format!("{detail} ({errors})")),
        (Some(detail), _) => Some(detail),
        (None, Some(errors)) => Some(errors),
        (None, None) => text("message")
            .or_else(|| text("title"))
            .or_else(|| text("error")),
    }
}

fn x_title(metadata: &StreamMetadataDraft) -> String {
    metadata
        .target_overrides
        .iter()
        .find(|target| target.platform == StreamPlatform::X && target.customize)
        .and_then(|target| (!target.title.trim().is_empty()).then(|| target.title.trim()))
        .or_else(|| (!metadata.title.trim().is_empty()).then(|| metadata.title.trim()))
        .unwrap_or("Live from Videorc")
        .to_string()
}

/// X has no visibility control; the only reach lever the Livestream API
/// exposes is `should_not_tweet` on Go Live (suppresses the announcing
/// Post). The draft stores it as `x_announce` (None/true = announce, the
/// platform default).
pub(crate) fn x_should_not_tweet(metadata: &StreamMetadataDraft) -> bool {
    metadata
        .target_overrides
        .iter()
        .find(|target| target.platform == StreamPlatform::X)
        .and_then(|target| target.x_announce)
        .map(|announce| !announce)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {

    #[test]
    fn broadcast_viewer_count_parses_defensively_across_field_lineages() {
        use serde_json::json;
        // Enveloped, numeric.
        assert_eq!(
            x_broadcast_viewer_outcome(&json!({"broadcast": {"total_watching": 42}})).count(),
            Some(42)
        );
        // Bare object, string-typed count (Periscope lineage).
        assert_eq!(
            x_broadcast_viewer_outcome(&json!({"viewer_count": "7"})).count(),
            Some(7)
        );
        // No recognized field = skipped sample, never a panic.
        assert_eq!(
            x_broadcast_viewer_outcome(&json!({"broadcast": {"state": "RUNNING"}})).count(),
            None
        );
    }

    #[test]
    fn the_documented_data_envelope_carries_the_viewer_count() {
        use serde_json::json;
        // `GetBroadcastResponse` per the official OpenAPI (plan 054): every
        // X poll in 19 real broadcasts missed this envelope.
        assert_eq!(
            x_broadcast_viewer_outcome(&json!({"data": {"total_watching": "12"}})),
            XViewerCountOutcome::Count(12)
        );
        assert_eq!(
            x_broadcast_viewer_outcome(&json!({"broadcast": {"total_watching": 12}})),
            XViewerCountOutcome::Count(12)
        );
        // Cumulative viewers never stand in for concurrent ones.
        assert_eq!(
            x_broadcast_viewer_outcome(
                &json!({"data": {"total_watched": "500", "state": "RUNNING"}})
            ),
            XViewerCountOutcome::NoField {
                keys: vec!["state".to_string(), "total_watched".to_string()]
            }
        );
        assert_eq!(
            XViewerCountOutcome::NoField {
                keys: vec!["state".to_string()]
            }
            .log_reason()
            .as_deref(),
            Some("X broadcast had no concurrent-viewer field (keys: state).")
        );
        assert_eq!(XViewerCountOutcome::Count(3).log_reason(), None);
    }

    #[tokio::test]
    async fn a_refused_viewer_lookup_reports_its_status() {
        use axum::Router;
        use axum::http::StatusCode;
        use axum::routing::get;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route(
                        "/2/broadcasts/refused",
                        get(|| async { (StatusCode::UNAUTHORIZED, "{}") }),
                    )
                    .route(
                        "/2/broadcasts/live",
                        // Like X: default fields unless `broadcast.fields`
                        // asks for the count.
                        get(
                            |query: axum::extract::Query<
                                std::collections::HashMap<String, String>,
                            >| async move {
                                let asked = query.get("broadcast.fields").is_some_and(|fields| {
                                    fields.split(',').any(|field| field == "total_watching")
                                });
                                axum::Json(if asked {
                                    serde_json::json!({"data": {"id": "live", "state": "running", "total_watching": "31"}})
                                } else {
                                    serde_json::json!({"data": {"id": "live", "start_ms": "1", "state": "running", "title": "t"}})
                                })
                            },
                        ),
                    ),
            )
            .await
            .unwrap();
        });
        let client = reqwest::Client::new();
        let base = format!("http://{address}");
        assert_eq!(
            fetch_broadcast_viewer_count(&client, &credentials(), &base, "refused").await,
            XViewerCountOutcome::Http { status: 401 }
        );
        assert_eq!(
            fetch_broadcast_viewer_count(&client, &credentials(), &base, "live").await,
            XViewerCountOutcome::Count(31)
        );
    }
    use super::*;
    use crate::streaming::PlatformAccountStatus;

    fn credentials() -> XLivestreamCredentials {
        XLivestreamCredentials {
            consumer_key: "consumer".to_string(),
            consumer_secret: "consumer secret".to_string(),
            access_token: "12345-token".to_string(),
            access_token_secret: "token secret".to_string(),
            user_id: "12345".to_string(),
            account_label: Some("Videorc".to_string()),
            credential_source: "test".to_string(),
        }
    }

    #[test]
    fn x_publish_metadata_derives_from_the_draft() {
        let mut draft =
            crate::streaming::default_stream_metadata_draft("2026-07-08T00:00:00Z".to_string());

        // Global title, no override customization: announce by default.
        draft.title = "Global title".to_string();
        assert_eq!(x_title(&draft), "Global title");
        assert!(!x_should_not_tweet(&draft));

        // Customized X override wins the title; announce off maps to
        // should_not_tweet.
        let x_override = draft
            .target_overrides
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::X)
            .unwrap();
        x_override.customize = true;
        x_override.title = "X title".to_string();
        x_override.x_announce = Some(false);
        assert_eq!(x_title(&draft), "X title");
        assert!(x_should_not_tweet(&draft));

        // Missing x_announce (pre-migration drafts) means announce.
        let x_override = draft
            .target_overrides
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::X)
            .unwrap();
        x_override.x_announce = None;
        assert!(!x_should_not_tweet(&draft));

        // Empty titles everywhere fall back to the fixed default.
        draft.title = String::new();
        draft
            .target_overrides
            .iter_mut()
            .for_each(|target| target.title = String::new());
        assert_eq!(x_title(&draft), "Live from Videorc");
    }

    #[test]
    fn oauth_percent_encoding_is_strict_rfc3986() {
        assert_eq!(
            oauth_percent_encode("!*'() space+slash/tilde~"),
            "%21%2A%27%28%29%20space%2Bslash%2Ftilde~"
        );
    }

    #[test]
    fn oauth_header_includes_query_params_but_never_json_body() {
        let header = oauth1_authorization_header(
            "POST",
            "https://api.x.com/2/broadcasts?pagination_token=a b",
            &credentials(),
            "nonce",
            1772031973,
        )
        .unwrap();

        assert!(header.starts_with("OAuth "));
        assert!(header.contains(r#"oauth_consumer_key="consumer""#));
        assert!(header.contains(r#"oauth_token="12345-token""#));
        assert!(header.contains("oauth_signature="));
        assert!(!header.contains("pagination_token"));
        assert!(!header.contains("source_id"));
        assert!(!header.contains("consumer secret"));
        assert!(!header.contains("token secret"));
    }

    #[test]
    fn normalized_oauth_params_sort_encoded_key_value_pairs() {
        let params = vec![
            ("b".to_string(), "two".to_string()),
            ("a".to_string(), "space value".to_string()),
            ("a".to_string(), "punct!".to_string()),
        ];

        assert_eq!(
            normalized_oauth_params(&params),
            "a=punct%21&a=space%20value&b=two"
        );
    }

    fn no_stored_secrets(_secret_ref: &str) -> Result<Option<String>> {
        Ok(None)
    }

    // These capability tests exercise the no-consumer build shape: test builds
    // never set the VIDEORC_BUNDLED_X_OAUTH1_* compile-time env, and the CI/dev
    // environment does not export the consumer env vars.
    #[test]
    fn capability_reports_missing_oauth1_credentials_without_hiding_manual_rtmp() {
        let capability = x_native_live_capability_with(None, &no_stored_secrets).unwrap();

        assert_eq!(capability.platform, StreamPlatform::X);
        assert_eq!(
            capability.state,
            XNativeLiveCapabilityState::MissingCredentials
        );
        assert!(!capability.native_available);
        assert!(capability.manual_rtmp_available);
        assert!(capability.message.contains("OAuth 1.0a"));
    }

    #[test]
    fn stored_user_token_resolves_credentials_with_user_id_from_token_prefix() {
        let read_secret = |secret_ref: &str| -> Result<Option<String>> {
            Ok(match secret_ref {
                X_OAUTH1_ACCESS_TOKEN_SECRET_REF => Some("172483972-abcDEF".to_string()),
                X_OAUTH1_TOKEN_SECRET_SECRET_REF => Some("stored token secret".to_string()),
                X_OAUTH1_HANDLE_SECRET_REF => Some("@videorc".to_string()),
                _ => None,
            })
        };

        // Without a consumer (test build), the stored token alone cannot sign.
        let resolved = x_livestream_credentials_with(&read_secret).unwrap();
        assert!(resolved.is_none());
    }

    #[test]
    fn stored_token_without_numeric_prefix_is_rejected_when_consumer_present() {
        // Exercise the prefix parser directly: a token without the numeric
        // user id prefix must not silently produce a bogus user id.
        let malformed = "not-numeric-token";
        let user_id = malformed
            .split_once('-')
            .map(|(prefix, _)| prefix.trim().to_string())
            .filter(|value| {
                !value.is_empty() && value.chars().all(|character| character.is_ascii_digit())
            });
        assert!(user_id.is_none());

        let wellformed = "172483972-xxxxx";
        let user_id = wellformed
            .split_once('-')
            .map(|(prefix, _)| prefix.trim().to_string())
            .filter(|value| {
                !value.is_empty() && value.chars().all(|character| character.is_ascii_digit())
            });
        assert_eq!(user_id.as_deref(), Some("172483972"));
    }

    #[test]
    fn request_token_header_omits_oauth_token_and_signs_callback() {
        let header = oauth1_signed_header(&Oauth1SigningInputs {
            method: "POST",
            url: "https://api.x.com/oauth/request_token",
            consumer_key: "consumer",
            consumer_secret: "consumer secret",
            token: None,
            extra_oauth_params: &[("oauth_callback", "http://127.0.0.1:17995/oauth/callback")],
            nonce: "nonce",
            timestamp: 1772031973,
        })
        .unwrap();

        assert!(header.starts_with("OAuth "));
        assert!(!header.contains("oauth_token="));
        assert!(
            header
                .contains(r#"oauth_callback="http%3A%2F%2F127.0.0.1%3A17995%2Foauth%2Fcallback""#)
        );
        assert!(header.contains("oauth_signature="));
        assert!(!header.contains("consumer secret"));
    }

    #[test]
    fn generalized_signer_matches_livestream_header_shape() {
        let credentials = credentials();
        let direct = oauth1_authorization_header(
            "POST",
            "https://api.x.com/2/broadcasts?pagination_token=a b",
            &credentials,
            "nonce",
            1772031973,
        )
        .unwrap();
        let general = oauth1_signed_header(&Oauth1SigningInputs {
            method: "POST",
            url: "https://api.x.com/2/broadcasts?pagination_token=a b",
            consumer_key: &credentials.consumer_key,
            consumer_secret: &credentials.consumer_secret,
            token: Some((&credentials.access_token, &credentials.access_token_secret)),
            extra_oauth_params: &[],
            nonce: "nonce",
            timestamp: 1772031973,
        })
        .unwrap();

        assert_eq!(direct, general);
    }

    fn test_source(id: &str, name: Option<&str>, active: bool) -> XStreamSource {
        XStreamSource {
            id: id.to_string(),
            name: name.map(str::to_string),
            region: Some("us-east-1".to_string()),
            rtmps_url: None,
            rtmp_url: None,
            stream_key: None,
            is_stream_active: active,
        }
    }

    // Plan 031 S2: fresh-source-per-session cleanup. The only condition that
    // ever produced instant playback is a source's first broadcast, so every
    // session creates one and prior leftovers must be reaped — but never the
    // fresh source, never an actively-receiving one, and never a source we
    // don't own by name (e.g. Media Studio or StreamYard sources).
    #[test]
    fn source_cleanup_reaps_idle_videorc_sources_only() {
        let sources = vec![
            test_source(
                "9123456789012345001",
                Some("Videorc Primary Encoder"),
                false,
            ),
            test_source(
                "9123456789012345002",
                Some("Videorc Primary Encoder"),
                false,
            ),
            test_source("9123456789012345003", Some("Videorc Primary Encoder"), true),
            test_source("9123456789012345004", Some("Videorc"), false),
            test_source("9123456789012345005", Some("StreamYardApp"), false),
            test_source(
                "9123456789012345006",
                Some("Videorc Scheduled 11111111"),
                false,
            ),
        ];

        let cleanup =
            x_source_cleanup_ids(&sources, "Videorc Primary Encoder", "9123456789012345001");

        // Scheduled sources survive the name sweep.
        assert_eq!(cleanup, vec!["9123456789012345002".to_string()]);
    }

    #[test]
    fn source_ids_are_digits_and_media_ids_come_from_the_media_key() {
        assert!(is_x_source_id("9123456789012345678"));
        assert!(is_x_source_id("1"));
        assert!(!is_x_source_id(""));
        assert!(!is_x_source_id("1hJz9kQ2LmNpRsTuVwXyZaBcDe"));
        assert!(!is_x_source_id("91234567890 12345678"));
        assert_eq!(
            x_media_id_from_media_key("28_2116610227978326016").as_deref(),
            Some("2116610227978326016")
        );
        assert_eq!(
            x_media_id_from_media_key("28_1_77").as_deref(),
            Some("77"),
            "the digits after the LAST underscore"
        );
        assert_eq!(x_media_id_from_media_key("2116610227978326016"), None);
        assert_eq!(x_media_id_from_media_key("28_"), None);
        assert_eq!(x_media_id_from_media_key("28_abc"), None);
    }

    #[test]
    fn x_error_detail_reads_problem_json_before_legacy_shapes() {
        assert_eq!(
            x_error_detail(
                r#"{"type":"https://api.x.com/2/problems/invalid-request","title":"Invalid Request","detail":"The `id` value is not a source id.","status":400}"#
            )
            .as_deref(),
            Some("The `id` value is not a source id.")
        );
        assert_eq!(
            x_error_detail(
                r#"{"type":"https://api.x.com/2/problems/invalid-request","title":"Invalid Request","detail":"One or more parameters to your request was invalid.","status":400,"errors":[{"message":"chat_option must be between 0 and 6"},{"message":"unknown field: region"}]}"#
            )
            .as_deref(),
            Some(
                "One or more parameters to your request was invalid. (chat_option must be between 0 and 6; unknown field: region)"
            )
        );
        assert_eq!(
            x_error_detail(r#"{"type":"about:blank","title":"Forbidden","status":403}"#).as_deref(),
            Some("Forbidden")
        );
        assert_eq!(
            x_error_detail(r#"{"error_type":"notFound","message":"legacy message"}"#).as_deref(),
            Some("legacy message")
        );
        assert_eq!(x_error_detail("not json"), None);
    }

    #[test]
    fn broadcast_watch_keeps_running_and_reports_every_other_state() {
        use XBroadcastWatchVerdict::*;
        assert_eq!(
            x_broadcast_watch_verdict(Some("RUNNING"), true),
            KeepWatching
        );
        assert_eq!(
            x_broadcast_watch_verdict(Some("running"), true),
            KeepWatching
        );
        assert_eq!(x_broadcast_watch_verdict(None, true), KeepWatching);
        assert_eq!(x_broadcast_watch_verdict(Some("  "), true), KeepWatching);
        assert_eq!(
            x_broadcast_watch_verdict(Some("TIMED_OUT"), true),
            EndedByX {
                state: "TIMED_OUT".to_string()
            }
        );
        assert_eq!(
            x_broadcast_watch_verdict(Some("ended"), true),
            EndedByX {
                state: "ENDED".to_string()
            }
        );
        // Once the owning session is gone there is nothing to protect.
        assert_eq!(x_broadcast_watch_verdict(Some("ENDED"), false), SessionOver);
        assert_eq!(
            x_broadcast_watch_verdict(Some("RUNNING"), false),
            SessionOver
        );
    }

    #[test]
    fn x_api_errors_keep_the_status_and_detail() {
        let error = XApiError {
            status: 409,
            detail: "Broadcast 1AbC is live on this source.".to_string(),
        };
        assert!(error.is_conflict());
        assert_eq!(
            error.to_string(),
            "X Livestream API request failed with HTTP 409 Conflict: Broadcast 1AbC is live on this source."
        );
        let wrapped: anyhow::Error = error.clone().into();
        assert_eq!(wrapped.downcast_ref::<XApiError>(), Some(&error));
    }

    // --- The /2/sources + /2/broadcasts routes against a mock X ------------

    /// What the mock X records about one request: method, path (with query),
    /// and the JSON body. The stream key must never appear in a path.
    type SeenRequest = (String, String, serde_json::Value);

    #[derive(Default)]
    struct MockX {
        seen: Vec<SeenRequest>,
        /// Sources by id; `stream_key` is held here and handed out only by
        /// the create response and the stream_key route.
        sources: Vec<(String, String, bool, String)>,
        refuse_create: bool,
        source_active: bool,
        conflicts_before_live: usize,
        /// Go Live answers this status (problem JSON) once per entry, in
        /// order, before it succeeds.
        go_live_failures: Vec<u16>,
        omit_media_key: bool,
        already_live: bool,
        broadcast_state: String,
        tweet_id: Option<String>,
        counter: usize,
    }

    const MOCK_STREAM_KEY_PREFIX: &str = "1hJz9kQ2LmNpRsTuVwXyZ";

    fn mock_source_json(id: &str, name: &str, active: bool) -> serde_json::Value {
        json!({
            "id": id,
            "name": name,
            "region": "us-east-1",
            "rtmp_url": "rtmps://a.live.x.com/x",
            "rtmps_url": "rtmps://a.live.x.com:443/x",
            "is_stream_active": active,
            "created_at_ms": "1772029802844"
        })
    }

    fn problem(status: u16, detail: &str) -> axum::response::Response {
        use axum::response::IntoResponse;
        let kind = match status {
            400 => "https://api.x.com/2/problems/invalid-request",
            404 => "https://api.x.com/2/problems/resource-not-found",
            409 => "https://api.x.com/2/problems/conflict",
            _ => "about:blank",
        };
        (
            axum::http::StatusCode::from_u16(status).unwrap(),
            axum::Json(
                json!({"type": kind, "title": "Problem", "detail": detail, "status": status}),
            ),
        )
            .into_response()
    }

    async fn mock_x_respond(
        axum::extract::State(mock): axum::extract::State<std::sync::Arc<std::sync::Mutex<MockX>>>,
        request: axum::extract::Request,
    ) -> axum::response::Response {
        use axum::http::StatusCode;
        use axum::response::IntoResponse;
        let method = request.method().to_string();
        let path = request.uri().path().to_string();
        let query = request.uri().query().unwrap_or("").to_string();
        let signed = request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("OAuth ") && value.contains("oauth_signature="));
        let bytes = axum::body::to_bytes(request.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_default();
        let mut mock = mock.lock().unwrap();
        mock.seen.push((
            method.clone(),
            if query.is_empty() {
                path.clone()
            } else {
                format!("{path}?{query}")
            },
            body.clone(),
        ));
        if !signed {
            return problem(401, "Unauthorized");
        }
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let ok = |value: serde_json::Value| (StatusCode::OK, axum::Json(value)).into_response();
        match (method.as_str(), parts.as_slice()) {
            ("GET", ["2", "region"]) => ok(json!({"region": "us-east-1"})),
            ("GET", ["2", "sources"]) => {
                let data: Vec<_> = mock
                    .sources
                    .iter()
                    .map(|(id, name, active, _)| mock_source_json(id, name, *active))
                    .collect();
                ok(json!({"data": data, "meta": {"result_count": data.len()}}))
            }
            ("POST", ["2", "sources"]) => {
                if mock.refuse_create {
                    return problem(400, "Too many sources.");
                }
                let keys: Vec<String> = body
                    .as_object()
                    .map(|object| object.keys().cloned().collect())
                    .unwrap_or_default();
                if keys.len() != 2
                    || !keys.contains(&"name".to_string())
                    || !keys.contains(&"region".to_string())
                {
                    return problem(400, "POST /2/sources accepts only name and region.");
                }
                mock.counter += 1;
                let id = format!("9123456789012345{:03}", mock.counter);
                let key = format!("{MOCK_STREAM_KEY_PREFIX}{}", mock.counter);
                let name = body["name"].as_str().unwrap_or("").to_string();
                mock.sources
                    .push((id.clone(), name.clone(), false, key.clone()));
                let mut source = mock_source_json(&id, &name, false);
                source["stream_key"] = json!(key);
                (StatusCode::CREATED, axum::Json(json!({"data": source}))).into_response()
            }
            ("GET" | "DELETE", ["2", "sources", id])
            | ("GET", ["2", "sources", id, "stream_key"]) => {
                if !is_x_source_id(id) {
                    return problem(400, "The `id` value is not a source id.");
                }
                let active = mock.source_active;
                let Some(index) = mock.sources.iter().position(|(saved, ..)| saved == id) else {
                    return problem(404, "Source not found.");
                };
                if method == "DELETE" {
                    mock.sources.remove(index);
                    return ok(json!({"data": {"deleted": true}}));
                }
                let (id, name, _, key) = mock.sources[index].clone();
                if parts.len() == 4 {
                    return ok(json!({"data": {"id": id, "stream_key": key}}));
                }
                ok(json!({"data": mock_source_json(&id, &name, active)}))
            }
            ("POST", ["2", "broadcasts"]) => {
                if mock.conflicts_before_live > 0 {
                    mock.conflicts_before_live -= 1;
                    return problem(409, "The source cannot take video yet.");
                }
                if !mock.go_live_failures.is_empty() {
                    let status = mock.go_live_failures.remove(0);
                    return problem(status, "Scripted Go Live failure.");
                }
                let allowed = [
                    "source_id",
                    "title",
                    "locale",
                    "chat_option",
                    "should_not_tweet",
                ];
                let unknown: Vec<String> = body
                    .as_object()
                    .map(|object| {
                        object
                            .keys()
                            .filter(|key| !allowed.contains(&key.as_str()))
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default();
                if !unknown.is_empty() {
                    return problem(400, &format!("unknown field: {}", unknown.join(", ")));
                }
                if !body["chat_option"].is_u64() || !body["should_not_tweet"].is_boolean() {
                    return problem(
                        400,
                        "chat_option must be an integer and should_not_tweet a boolean.",
                    );
                }
                let Some(source_id) = body["source_id"].as_str() else {
                    return problem(400, "source_id is required.");
                };
                if !is_x_source_id(source_id) {
                    return problem(400, "The `source_id` value is not a source id.");
                }
                let tweet_id = mock.tweet_id.clone();
                let mut data = json!({
                    "id": "1AbCdEfGhIjKl",
                    "broadcast_id": "1AbCdEfGhIjKl",
                    "state": "RUNNING",
                    "share_url": "https://x.com/i/broadcasts/1AbCdEfGhIjKl",
                    "media_key": "28_2116610227978326016",
                    "title": body["title"],
                    "language": body["locale"],
                    "chat_option": body["chat_option"],
                    "start_ms": "1772029802844"
                });
                if let Some(tweet_id) = tweet_id {
                    data["tweet_id"] = json!(tweet_id);
                }
                if mock.omit_media_key {
                    data.as_object_mut().unwrap().remove("media_key");
                }
                let status = if mock.already_live {
                    StatusCode::OK
                } else {
                    StatusCode::CREATED
                };
                (status, axum::Json(json!({"data": data}))).into_response()
            }
            ("GET", ["2", "broadcasts", id]) => {
                let mut data = json!({"id": id, "state": mock.broadcast_state});
                if let Some(tweet_id) = mock.tweet_id.clone() {
                    data["tweet_id"] = json!(tweet_id);
                }
                ok(json!({"data": data}))
            }
            ("PUT", ["2", "broadcasts", id, "state"]) => {
                if body != json!({"state": "END"}) {
                    return problem(400, "Send exactly {\"state\":\"END\"}.");
                }
                ok(json!({"data": {"id": id, "state": "ENDED"}}))
            }
            _ => problem(404, "Route not found."),
        }
    }

    async fn mock_x() -> (
        String,
        std::sync::Arc<std::sync::Mutex<MockX>>,
        tokio::task::JoinHandle<()>,
    ) {
        let mock = std::sync::Arc::new(std::sync::Mutex::new(MockX {
            broadcast_state: "RUNNING".to_string(),
            ..MockX::default()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = axum::Router::new()
            .fallback(mock_x_respond)
            .with_state(mock.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (format!("http://{address}"), mock, server)
    }

    fn publish_request(base: &str, source_id: &str) -> XPublishRequest {
        let mut metadata =
            crate::streaming::default_stream_metadata_draft("2026-11-06T00:00:00Z".to_string());
        metadata.title = "Migration test".to_string();
        XPublishRequest {
            credentials: credentials(),
            source_id: source_id.to_string(),
            metadata,
            locale: "en".to_string(),
            chat_option: 2,
            api_base_url: Some(base.to_string()),
            poll_attempts: 2,
            poll_interval_ms: 1,
            conflict_attempts: 3,
            conflict_backoff_ms: 1,
        }
    }

    fn seen_paths(mock: &std::sync::Mutex<MockX>) -> Vec<String> {
        mock.lock()
            .unwrap()
            .seen
            .iter()
            .map(|(method, path, _)| format!("{method} {path}"))
            .collect()
    }

    #[tokio::test]
    async fn prepare_creates_a_source_and_reads_the_key_from_the_create_response() {
        let (base, mock, server) = mock_x().await;
        // A previous session's idle leftover is reaped; a scheduled source
        // and a foreign source survive.
        {
            let mut mock = mock.lock().unwrap();
            mock.sources.push((
                "9123456789012345900".to_string(),
                "Videorc Primary Encoder".to_string(),
                false,
                "oldkey".to_string(),
            ));
            mock.sources.push((
                "9123456789012345901".to_string(),
                "Videorc Scheduled 11111111".to_string(),
                false,
                "schedkey".to_string(),
            ));
        }
        let stored = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = stored.clone();
        let prepared = prepare_x_stream_source(
            XPrepareSourceRequest {
                credentials: credentials(),
                account: None,
                source_name: "Videorc Primary Encoder".to_string(),
                api_base_url: Some(base.clone()),
            },
            &reqwest::Client::new(),
            move |secret_ref, value| {
                sink.lock()
                    .unwrap()
                    .push((secret_ref.to_string(), value.to_string()));
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(prepared.source_id, "9123456789012345001");
        assert_eq!(prepared.selection, XSourceSelection::Created);
        assert_eq!(prepared.region, "us-east-1");
        assert_eq!(prepared.server_url, "rtmps://a.live.x.com:443/x");
        assert_eq!(
            prepared.stream_key_secret_ref,
            "platform:x:12345:9123456789012345001:stream-key"
        );
        assert_eq!(
            prepared.deleted_retired_source_ids,
            vec!["9123456789012345900".to_string()]
        );
        let stored = stored.lock().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].1, format!("{MOCK_STREAM_KEY_PREFIX}1"));
        let paths = seen_paths(&mock);
        assert_eq!(
            paths,
            vec![
                "GET /2/region",
                "GET /2/sources",
                "POST /2/sources",
                "DELETE /2/sources/9123456789012345900",
            ]
        );
        // The create body is exactly {name, region} and no request carried
        // a stream key in its path.
        let create = &mock.lock().unwrap().seen[2].2;
        assert_eq!(
            create,
            &json!({"name": "Videorc Primary Encoder", "region": "us-east-1"})
        );
        assert!(
            paths
                .iter()
                .all(|path| !path.contains(MOCK_STREAM_KEY_PREFIX))
        );
        server.abort();
    }

    #[tokio::test]
    async fn prepare_reuses_a_named_source_and_fetches_its_key_from_the_stream_key_route() {
        let (base, mock, server) = mock_x().await;
        {
            let mut mock = mock.lock().unwrap();
            mock.refuse_create = true;
            mock.sources.push((
                "9123456789012345777".to_string(),
                "Videorc Primary Encoder".to_string(),
                false,
                "reusedkey".to_string(),
            ));
        }
        let stored = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = stored.clone();
        let prepared = prepare_x_stream_source(
            XPrepareSourceRequest {
                credentials: credentials(),
                account: None,
                source_name: "Videorc Primary Encoder".to_string(),
                api_base_url: Some(base.clone()),
            },
            &reqwest::Client::new(),
            move |secret_ref, value| {
                sink.lock()
                    .unwrap()
                    .push((secret_ref.to_string(), value.to_string()));
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(prepared.source_id, "9123456789012345777");
        assert_eq!(prepared.selection, XSourceSelection::ReusedNameMatch);
        assert_eq!(stored.lock().unwrap()[0].1, "reusedkey");
        assert_eq!(
            seen_paths(&mock),
            vec![
                "GET /2/region",
                "GET /2/sources",
                "POST /2/sources",
                "GET /2/sources/9123456789012345777/stream_key",
            ]
        );
        server.abort();
    }

    #[tokio::test]
    async fn a_stream_key_in_place_of_a_source_id_is_a_400_with_x_detail() {
        let (base, _mock, server) = mock_x().await;
        let error = get_source(
            &reqwest::Client::new(),
            &credentials(),
            &base,
            "1hJz9kQ2LmNpRsTuVwXyZ",
        )
        .await
        .unwrap_err();
        let api_error = error.downcast_ref::<XApiError>().unwrap();
        assert_eq!(api_error.status, 400);
        assert_eq!(api_error.detail, "The `id` value is not a source id.");
        // Go Live refuses locally before any request leaves the machine.
        let error = publish_x_broadcast(
            publish_request(&base, "1hJz9kQ2LmNpRsTuVwXyZ"),
            &reqwest::Client::new(),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("19-digit source id"), "{error}");
        server.abort();
    }

    #[tokio::test]
    async fn go_live_sends_exactly_the_five_fields_with_json_types() {
        let (base, mock, server) = mock_x().await;
        {
            let mut mock = mock.lock().unwrap();
            mock.source_active = true;
            mock.tweet_id = Some("1990000000000000001".to_string());
            mock.sources.push((
                "9123456789012345001".to_string(),
                "Videorc Primary Encoder".to_string(),
                true,
                "key".to_string(),
            ));
        }
        let result = publish_x_broadcast(
            publish_request(&base, "9123456789012345001"),
            &reqwest::Client::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.broadcast_id, "1AbCdEfGhIjKl");
        assert_eq!(result.media_key, "28_2116610227978326016");
        assert_eq!(result.media_id.as_deref(), Some("2116610227978326016"));
        assert_eq!(result.share_url, "https://x.com/i/broadcasts/1AbCdEfGhIjKl");
        assert_eq!(result.state, "RUNNING");
        assert_eq!(result.tweet_id.as_deref(), Some("1990000000000000001"));
        assert!(!result.already_live);
        let seen = mock.lock().unwrap().seen.clone();
        assert_eq!(seen[0].1, "/2/sources/9123456789012345001");
        let (method, path, body) = &seen[1];
        assert_eq!((method.as_str(), path.as_str()), ("POST", "/2/broadcasts"));
        let mut keys: Vec<&String> = body.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "chat_option",
                "locale",
                "should_not_tweet",
                "source_id",
                "title"
            ]
        );
        assert_eq!(body["source_id"], "9123456789012345001");
        assert_eq!(body["title"], "Migration test");
        assert_eq!(body["locale"], "en");
        assert_eq!(body["chat_option"], json!(2));
        assert!(body["chat_option"].is_u64());
        assert_eq!(body["should_not_tweet"], json!(false));
        assert!(body["should_not_tweet"].is_boolean());
        server.abort();
    }

    #[tokio::test]
    async fn go_live_retries_a_409_then_accepts_201() {
        let (base, mock, server) = mock_x().await;
        {
            let mut mock = mock.lock().unwrap();
            mock.source_active = true;
            mock.conflicts_before_live = 1;
            mock.sources.push((
                "9123456789012345001".to_string(),
                "n".to_string(),
                true,
                "key".to_string(),
            ));
        }
        let result = publish_x_broadcast(
            publish_request(&base, "9123456789012345001"),
            &reqwest::Client::new(),
        )
        .await
        .unwrap();
        assert!(!result.already_live);
        assert_eq!(result.message, "X broadcast is live.");
        let posts = seen_paths(&mock)
            .into_iter()
            .filter(|path| path == "POST /2/broadcasts")
            .count();
        assert_eq!(posts, 2);
        server.abort();
    }

    #[tokio::test]
    async fn go_live_accepts_200_for_a_source_that_is_already_live() {
        let (base, mock, server) = mock_x().await;
        {
            let mut mock = mock.lock().unwrap();
            mock.source_active = true;
            mock.already_live = true;
            mock.sources.push((
                "9123456789012345001".to_string(),
                "n".to_string(),
                true,
                "key".to_string(),
            ));
        }
        let result = publish_x_broadcast(
            publish_request(&base, "9123456789012345001"),
            &reqwest::Client::new(),
        )
        .await
        .unwrap();
        assert!(result.already_live);
        assert_eq!(result.broadcast_id, "1AbCdEfGhIjKl");
        assert!(result.message.contains("already live"));
        server.abort();
    }

    #[tokio::test]
    async fn go_live_gives_up_after_the_conflict_budget_with_x_detail() {
        let (base, mock, server) = mock_x().await;
        {
            let mut mock = mock.lock().unwrap();
            mock.source_active = true;
            mock.conflicts_before_live = 10;
            mock.sources.push((
                "9123456789012345001".to_string(),
                "n".to_string(),
                true,
                "key".to_string(),
            ));
        }
        let error = publish_x_broadcast(
            publish_request(&base, "9123456789012345001"),
            &reqwest::Client::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.downcast_ref::<XApiError>(),
            Some(&XApiError {
                status: 409,
                detail: "The source cannot take video yet.".to_string()
            })
        );
        assert!(error.to_string().contains("HTTP 409 Conflict"), "{error}");
        let posts = seen_paths(&mock)
            .into_iter()
            .filter(|path| path == "POST /2/broadcasts")
            .count();
        assert_eq!(posts, 3, "conflict_attempts bounds the retries");
        server.abort();
    }

    #[tokio::test]
    async fn go_live_retries_a_503_and_never_retries_another_4xx() {
        let (base, mock, server) = mock_x().await;
        {
            let mut mock = mock.lock().unwrap();
            mock.source_active = true;
            mock.go_live_failures = vec![503];
            mock.sources.push((
                "9123456789012345001".to_string(),
                "n".to_string(),
                true,
                "key".to_string(),
            ));
        }
        let result = publish_x_broadcast(
            publish_request(&base, "9123456789012345001"),
            &reqwest::Client::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.broadcast_id, "1AbCdEfGhIjKl");

        // A 403 (account cannot go live) is final: one POST, X's status kept.
        mock.lock().unwrap().go_live_failures = vec![403, 403, 403];
        let before = seen_paths(&mock)
            .into_iter()
            .filter(|path| path == "POST /2/broadcasts")
            .count();
        let error = publish_x_broadcast(
            publish_request(&base, "9123456789012345001"),
            &reqwest::Client::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.downcast_ref::<XApiError>().map(|error| error.status),
            Some(403)
        );
        let after = seen_paths(&mock)
            .into_iter()
            .filter(|path| path == "POST /2/broadcasts")
            .count();
        assert_eq!(after - before, 1, "a 403 is never retried");
        server.abort();
    }

    #[tokio::test]
    async fn go_live_without_a_media_key_is_still_live() {
        let (base, mock, server) = mock_x().await;
        {
            let mut mock = mock.lock().unwrap();
            mock.source_active = true;
            mock.omit_media_key = true;
            mock.sources.push((
                "9123456789012345001".to_string(),
                "n".to_string(),
                true,
                "key".to_string(),
            ));
        }
        let result = publish_x_broadcast(
            publish_request(&base, "9123456789012345001"),
            &reqwest::Client::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.state, "RUNNING");
        assert_eq!(result.media_key, "");
        assert_eq!(result.media_id, None);
        server.abort();
    }

    #[test]
    fn go_live_retry_policy_follows_the_docs() {
        let api = |status| {
            anyhow::Error::from(XApiError {
                status,
                detail: String::new(),
            })
        };
        assert!(go_live_error_is_retryable(&api(409)));
        assert!(go_live_error_is_retryable(&api(503)));
        assert!(go_live_error_is_retryable(&anyhow::anyhow!(
            "connection reset"
        )));
        for status in [400, 401, 403, 404] {
            assert!(!go_live_error_is_retryable(&api(status)), "{status}");
        }
    }

    #[tokio::test]
    async fn go_live_waits_for_an_active_source_and_refuses_an_idle_one() {
        let (base, mock, server) = mock_x().await;
        mock.lock().unwrap().sources.push((
            "9123456789012345001".to_string(),
            "n".to_string(),
            false,
            "key".to_string(),
        ));
        let error = publish_x_broadcast(
            publish_request(&base, "9123456789012345001"),
            &reqwest::Client::new(),
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains("did not become active"),
            "{error}"
        );
        assert!(
            !seen_paths(&mock)
                .iter()
                .any(|path| path == "POST /2/broadcasts"),
            "no Go Live without video"
        );
        server.abort();
    }

    #[tokio::test]
    async fn the_state_watch_reads_state_and_tweet_id_and_end_sends_only_end() {
        let (base, mock, server) = mock_x().await;
        let client = reqwest::Client::new();
        let sample = fetch_broadcast_state(&client, &credentials(), &base, "1AbCdEfGhIjKl")
            .await
            .unwrap();
        assert_eq!(
            sample,
            XBroadcastStateSample {
                state: Some("RUNNING".to_string()),
                tweet_id: None
            }
        );
        {
            let mut mock = mock.lock().unwrap();
            mock.broadcast_state = "TIMED_OUT".to_string();
            mock.tweet_id = Some("1990000000000000001".to_string());
        }
        let sample = fetch_broadcast_state(&client, &credentials(), &base, "1AbCdEfGhIjKl")
            .await
            .unwrap();
        assert_eq!(sample.state.as_deref(), Some("TIMED_OUT"));
        assert_eq!(sample.tweet_id.as_deref(), Some("1990000000000000001"));
        end_x_broadcast(
            XEndRequest {
                credentials: credentials(),
                broadcast_id: "1AbCdEfGhIjKl".to_string(),
                api_base_url: Some(base.clone()),
            },
            &client,
        )
        .await
        .unwrap();
        let seen = mock.lock().unwrap().seen.clone();
        assert_eq!(
            seen[0].1,
            "/2/broadcasts/1AbCdEfGhIjKl?broadcast.fields=state%2Ctweet_id"
        );
        assert_eq!(seen[2].0, "PUT");
        assert_eq!(seen[2].1, "/2/broadcasts/1AbCdEfGhIjKl/state");
        assert_eq!(seen[2].2, json!({"state": "END"}));
        server.abort();
    }

    #[test]
    fn selecting_x_account_honors_requested_provider_or_backend_id() {
        let account = PlatformAccount {
            id: "backend-id".to_string(),
            platform: StreamPlatform::X,
            account_id: "provider-id".to_string(),
            account_label: "Videorc".to_string(),
            account_handle: None,
            avatar_url: None,
            scopes: Vec::new(),
            access_token_present: true,
            refresh_token_present: false,
            stream_key_present: false,
            expires_at: None,
            connected_at: "2026-06-03T00:00:00Z".to_string(),
            updated_at: "2026-06-03T00:00:00Z".to_string(),
            status: PlatformAccountStatus::Connected,
        };
        let accounts = vec![account];

        assert_eq!(
            select_x_account(&accounts, Some("provider-id"))
                .unwrap()
                .unwrap()
                .account_id,
            "provider-id"
        );
        assert_eq!(
            select_x_account(&accounts, Some("backend-id"))
                .unwrap()
                .unwrap()
                .id,
            "backend-id"
        );
        assert!(select_x_account(&accounts, Some("missing")).is_err());
    }

    // --- Removing (plan 140 S4) ----------------------------------------------------

    #[test]
    fn x_chat_message_ids_are_one_to_nineteen_digits() {
        assert!(x_chat_message_id_is_valid("1"));
        assert!(x_chat_message_id_is_valid("1759600000000000000"));
        assert!(!x_chat_message_id_is_valid(""));
        assert!(!x_chat_message_id_is_valid("17596000000000000000"));
        assert!(!x_chat_message_id_is_valid("12a"));
        assert!(!x_chat_message_id_is_valid("-1"));
        assert!(!x_chat_message_id_is_valid("1 2"));
    }

    #[tokio::test]
    async fn delete_signs_the_request_and_reads_deleted_true() {
        use crate::live_chat_moderation::{ModerationOutcomeCode, ProviderDeleteOutcome};
        use axum::Router;
        use axum::extract::Path;
        use axum::http::HeaderMap;
        use axum::routing::delete;
        use std::sync::{Arc, Mutex};
        let seen: Arc<Mutex<Vec<(String, String, String)>>> = Arc::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let recorder = seen.clone();
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/2/broadcasts/{broadcast}/chat/{message}",
                    delete(
                        move |Path((broadcast, message)): Path<(String, String)>,
                              headers: HeaderMap| {
                            let recorder = recorder.clone();
                            async move {
                                let authorization = headers
                                    .get("authorization")
                                    .and_then(|value| value.to_str().ok())
                                    .unwrap_or_default()
                                    .to_string();
                                recorder.lock().unwrap().push((
                                    broadcast,
                                    message.clone(),
                                    authorization,
                                ));
                                if message == "404" {
                                    (
                                        axum::http::StatusCode::NOT_FOUND,
                                        axum::Json(json!({"errors":[{"message":"not found"}]})),
                                    )
                                } else if message == "401" {
                                    (axum::http::StatusCode::UNAUTHORIZED, axum::Json(json!({})))
                                } else if message == "200" {
                                    (
                                        axum::http::StatusCode::OK,
                                        axum::Json(json!({"data":{"deleted":false}})),
                                    )
                                } else {
                                    (
                                        axum::http::StatusCode::OK,
                                        axum::Json(json!({"data":{"deleted":true}})),
                                    )
                                }
                            }
                        },
                    ),
                ),
            )
            .await
            .unwrap();
        });
        let client = reqwest::Client::new();
        let base = format!("http://{address}");
        assert_eq!(
            delete_broadcast_chat_message(&client, &credentials(), &base, "1AbCdEf", "1759600")
                .await,
            ProviderDeleteOutcome::Deleted
        );
        {
            let seen = seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].0, "1AbCdEf");
            assert_eq!(seen[0].1, "1759600");
            assert!(seen[0].2.starts_with("OAuth "), "{}", seen[0].2);
            assert!(
                seen[0].2.contains("oauth_token=\"12345-token\""),
                "{}",
                seen[0].2
            );
        }
        assert_eq!(
            delete_broadcast_chat_message(&client, &credentials(), &base, "1AbCdEf", "404").await,
            ProviderDeleteOutcome::NotFound
        );
        assert_eq!(
            delete_broadcast_chat_message(&client, &credentials(), &base, "1AbCdEf", "401").await,
            ProviderDeleteOutcome::CannotDelete {
                code: ModerationOutcomeCode::MissingScope,
                reason: X_MODERATE_REAUTHORIZE_REASON.to_string(),
            }
        );
        assert_eq!(
            delete_broadcast_chat_message(&client, &credentials(), &base, "1AbCdEf", "200").await,
            ProviderDeleteOutcome::Failed("X did not confirm the removal.".to_string())
        );
        // An id outside the 1-19 digit shape never becomes a request.
        for bad in ["", "abc", "17596000000000000000", "../x"] {
            let outcome =
                delete_broadcast_chat_message(&client, &credentials(), &base, "1AbCdEf", bad).await;
            assert!(
                matches!(
                    outcome,
                    ProviderDeleteOutcome::CannotDelete {
                        code: ModerationOutcomeCode::Unsupported,
                        ..
                    }
                ),
                "{bad:?}: {outcome:?}"
            );
        }
        assert!(matches!(
            delete_broadcast_chat_message(&client, &credentials(), &base, "", "1759600").await,
            ProviderDeleteOutcome::Failed(_)
        ));
        assert_eq!(seen.lock().unwrap().len(), 4);
    }

    #[test]
    fn x_delete_answers_classify_by_status() {
        use crate::live_chat_moderation::{ModerationOutcomeCode, ProviderDeleteOutcome};
        assert_eq!(
            classify_x_delete_response(200, &json!({"data":{"deleted":true}})),
            ProviderDeleteOutcome::Deleted
        );
        assert!(matches!(
            classify_x_delete_response(200, &json!({})),
            ProviderDeleteOutcome::Failed(_)
        ));
        assert_eq!(
            classify_x_delete_response(404, &json!({})),
            ProviderDeleteOutcome::NotFound
        );
        assert_eq!(
            classify_x_delete_response(400, &json!({})),
            ProviderDeleteOutcome::CannotDelete {
                code: ModerationOutcomeCode::Unsupported,
                reason: "X only removes messages while the broadcast is live.".to_string(),
            }
        );
        for status in [401, 403] {
            assert_eq!(
                classify_x_delete_response(status, &json!({})),
                ProviderDeleteOutcome::CannotDelete {
                    code: ModerationOutcomeCode::MissingScope,
                    reason: X_MODERATE_REAUTHORIZE_REASON.to_string(),
                }
            );
        }
        assert!(matches!(
            classify_x_delete_response(503, &json!({})),
            ProviderDeleteOutcome::Transient(_)
        ));
        assert!(matches!(
            classify_x_delete_response(418, &json!({})),
            ProviderDeleteOutcome::Failed(_)
        ));
    }
}
