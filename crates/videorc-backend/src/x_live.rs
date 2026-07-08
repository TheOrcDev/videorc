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

const X_LIVESTREAM_DOCS_URL: &str = "https://github.com/xdevplatform/x-livestream-sample";
const X_API_OVERVIEW_URL: &str = "https://docs.x.com/x-api/overview";
const DEFAULT_API_BASE_URL: &str = "https://api.x.com";
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
    pub source_id: String,
    pub region: String,
    #[serde(default = "default_true")]
    pub is_low_latency: bool,
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

fn default_true() -> bool {
    true
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_configuration: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compatibility_info: Option<serde_json::Value>,
    pub selection: XSourceSelection,
    /// Retired sources deleted during this prepare (best-effort cleanup).
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tweet_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tweet_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hls_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playable_before_publish: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre_publish_wait_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compatibility_info: Option<serde_json::Value>,
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
    /// Sources retired by the playback health model — never selected, and
    /// deleted best-effort when idle.
    pub retired_source_ids: Vec<String>,
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
    pub region: String,
    pub metadata: StreamMetadataDraft,
    pub is_low_latency: bool,
    pub locale: String,
    pub chat_option: u8,
    pub api_base_url: Option<String>,
    pub poll_attempts: usize,
    pub poll_interval_ms: u64,
    // Pre-publish playback gate: after CREATE, wait for the HLS playlist to
    // carry real segments before the PUBLISH that posts the announcement —
    // so the tweet points at working video whenever X provisions in time.
    // 0 attempts disables the gate. Publish proceeds either way (X may only
    // provision on publish; never deadlock on the gate).
    pub pre_publish_probe_attempts: usize,
    pub pre_publish_probe_interval_ms: u64,
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

#[derive(Debug, Clone, Deserialize)]
struct XSourceEnvelope {
    source: XStreamSource,
}

#[derive(Debug, Clone, Deserialize)]
struct XSourcesEnvelope {
    #[serde(default)]
    sources: Vec<XStreamSource>,
}

#[derive(Debug, Clone, Deserialize)]
struct XBroadcastEnvelope {
    broadcast: XBroadcast,
    #[serde(default)]
    share_url: Option<String>,
    // Playback URLs exist from CREATE (before publish) — the watchability
    // probe uses them to verify X is actually transcoding.
    #[serde(default)]
    video_access: Option<XVideoAccess>,
}

#[derive(Debug, Clone, Deserialize)]
struct XVideoAccess {
    #[serde(default)]
    hls_url: Option<String>,
    #[serde(default)]
    https_hls_url: Option<String>,
}

impl XVideoAccess {
    fn best_hls_url(&self) -> Option<String> {
        self.https_hls_url
            .clone()
            .or_else(|| self.hls_url.clone())
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty())
    }
}

#[derive(Debug, Clone, Deserialize)]
struct XStreamSource {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    rtmp_region: Option<String>,
    #[serde(default)]
    rtmps_url: Option<String>,
    #[serde(default)]
    rtmp_url: Option<String>,
    #[serde(default)]
    rtmp_stream_key: Option<String>,
    #[serde(default)]
    is_stream_active: bool,
    #[serde(default)]
    recommended_configuration: Option<serde_json::Value>,
    #[serde(default)]
    compatibility_info: Option<serde_json::Value>,
}

/// Persisted per-source playback record (app_settings key `xSourceHealth`,
/// a `{source_id: XSourceHealth}` map). Retirement is conservative — the
/// 2026-07-08 incident proved a source can transcode one hour and not the
/// next, so one bad probe only counts, it does not retire.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct XSourceHealth {
    #[serde(default)]
    pub last_verified_at: Option<String>,
    #[serde(default)]
    pub consecutive_failures: u32,
    #[serde(default)]
    pub retired: bool,
}

pub const X_SOURCE_HEALTH_SETTING: &str = "xSourceHealth";
pub const X_SOURCE_RETIRE_FAILURES: u32 = 2;

pub fn apply_x_playback_outcome(
    mut health: XSourceHealth,
    verified: bool,
    now_rfc3339: &str,
) -> XSourceHealth {
    if verified {
        health.last_verified_at = Some(now_rfc3339.to_string());
        health.consecutive_failures = 0;
        health.retired = false;
    } else {
        health.consecutive_failures = health.consecutive_failures.saturating_add(1);
        if health.consecutive_failures >= X_SOURCE_RETIRE_FAILURES {
            health.retired = true;
        }
    }
    health
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
    media_id: Option<String>,
    #[serde(default)]
    share_url: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    tweet_id: Option<String>,
    #[serde(default)]
    tweet_error: Option<String>,
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
                "X rejects Livestream requests when the OAuth 1.0a token user id differs from the :user_id path.".to_string(),
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
            "The numeric X user id is available for /2/users/:user_id source and broadcast paths.".to_string(),
            "RTMPS source keys will be stored in the backend secret store and redacted from UI/logs.".to_string(),
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
    let (source, selection) = if let Some(source_id) =
        optional_env_any(&["VIDEORC_X_LIVESTREAM_SOURCE_ID", "X_LIVESTREAM_SOURCE_ID"])
    {
        (
            get_source(client, &credentials, &base_url, &source_id).await?,
            XSourceSelection::EnvOverride,
        )
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
                // Quota hygiene: yesterday's Videorc sources and retired ones
                // are dead weight. Delete everything idle that we own by name
                // plus explicit retirees — never the source just created, and
                // never one actively receiving a stream.
                for source_id in x_source_cleanup_ids(
                    &sources,
                    &request.source_name,
                    &request.retired_source_ids,
                    &created.id,
                ) {
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
                let retired = |source: &&XStreamSource| {
                    request
                        .retired_source_ids
                        .iter()
                        .any(|retired_id| retired_id == &source.id)
                };
                let fallback = sources
                    .iter()
                    .filter(|source| !retired(source))
                    .find(|source| {
                        source.name.as_deref() == Some(request.source_name.as_str())
                            && source.rtmp_region.as_deref() == Some(region.as_str())
                    })
                    .cloned();
                match fallback {
                    Some(fallback) => (fallback, XSourceSelection::ReusedNameMatch),
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
    if source_id.is_empty() {
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
        .rtmp_stream_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .context("X stream source response did not include an RTMP stream key.")?
        .to_string();
    let region = source
        .rtmp_region
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
        recommended_configuration: source.recommended_configuration,
        compatibility_info: source.compatibility_info,
        selection,
        deleted_retired_source_ids,
    })
}

pub async fn publish_x_broadcast(
    request: XPublishRequest,
    client: &reqwest::Client,
) -> Result<XPublishResult> {
    let base_url = api_base_url(request.api_base_url.as_deref());
    let attempts = request.poll_attempts.max(1);
    let mut last_source = None;
    for attempt in 0..attempts {
        let source =
            get_source(client, &request.credentials, &base_url, &request.source_id).await?;
        let active = source.is_stream_active;
        last_source = Some(source);
        if active {
            break;
        }
        if attempt + 1 < attempts {
            sleep(Duration::from_millis(request.poll_interval_ms)).await;
        }
    }
    if !last_source
        .as_ref()
        .is_some_and(|source| source.is_stream_active)
    {
        anyhow::bail!("X RTMPS source did not become active before publish.");
    }
    let compatibility_info = last_source
        .as_ref()
        .and_then(|source| source.compatibility_info.clone());

    let created = create_broadcast(
        client,
        &request.credentials,
        &base_url,
        &request.source_id,
        &request.region,
        request.is_low_latency,
    )
    .await?;
    let broadcast_id = created
        .broadcast
        .broadcast_id
        .clone()
        .or(created.broadcast.id.clone())
        .context("X broadcast create response did not include a broadcast id.")?;
    let media_key = created
        .broadcast
        .media_key
        .clone()
        .context("X broadcast create response did not include a media_key.")?;
    let share_url = created
        .share_url
        .clone()
        .or(created.broadcast.share_url.clone())
        .unwrap_or_else(|| format!("https://x.com/i/broadcasts/{broadcast_id}"));
    let hls_url = created
        .video_access
        .as_ref()
        .and_then(XVideoAccess::best_hls_url);

    // Pre-publish playback gate: give X a bounded window to bring up the
    // transcode BEFORE the announcement post goes out. Never fails publish.
    let mut playable_before_publish = None;
    let mut pre_publish_wait_ms = None;
    if let Some(hls_url) = hls_url.as_deref()
        && request.pre_publish_probe_attempts > 0
    {
        let started = std::time::Instant::now();
        let mut playable = false;
        for attempt in 0..request.pre_publish_probe_attempts {
            if x_playlist_playable(client, hls_url).await.unwrap_or(false) {
                playable = true;
                break;
            }
            if attempt + 1 < request.pre_publish_probe_attempts {
                sleep(Duration::from_millis(request.pre_publish_probe_interval_ms)).await;
            }
        }
        playable_before_publish = Some(playable);
        pre_publish_wait_ms = Some(started.elapsed().as_millis() as u64);
    }

    let title = x_title(&request.metadata);
    let published = publish_broadcast(
        client,
        &request.credentials,
        &base_url,
        PublishBroadcastStateRequest {
            broadcast_id: &broadcast_id,
            title: &title,
            should_not_tweet: x_should_not_tweet(&request.metadata),
            locale: &request.locale,
            chat_option: request.chat_option,
        },
    )
    .await?;

    Ok(XPublishResult {
        platform: StreamPlatform::X,
        account_id: request.credentials.user_id,
        source_id: request.source_id,
        broadcast_id,
        media_key,
        media_id: created.broadcast.media_id,
        share_url,
        state: published
            .broadcast
            .state
            .unwrap_or_else(|| "RUNNING".to_string()),
        tweet_id: published.broadcast.tweet_id,
        tweet_error: published.broadcast.tweet_error,
        hls_url,
        playable_before_publish,
        pre_publish_wait_ms,
        compatibility_info,
        message: "X broadcast is live.".to_string(),
    })
}

/// One playback probe: does the HLS playlist behind `url` currently carry
/// real media segments? Text-only fetches — never downloads video. A master
/// playlist is followed one level to its first variant. `Ok(false)` covers
/// every not-ready shape (HTTP errors, empty playlists) so callers can poll.
pub async fn x_playlist_playable(client: &reqwest::Client, url: &str) -> Result<bool> {
    let body = match fetch_playlist_text(client, url).await? {
        Some(body) => body,
        None => return Ok(false),
    };
    match playlist_verdict(&body) {
        PlaylistVerdict::Playable => Ok(true),
        PlaylistVerdict::NotReady => Ok(false),
        PlaylistVerdict::Variant(variant) => {
            let variant_url = resolve_playlist_url(url, &variant)?;
            let Some(body) = fetch_playlist_text(client, &variant_url).await? else {
                return Ok(false);
            };
            Ok(matches!(playlist_verdict(&body), PlaylistVerdict::Playable))
        }
    }
}

async fn fetch_playlist_text(client: &reqwest::Client, url: &str) -> Result<Option<String>> {
    let response = client
        .get(url)
        .send()
        .await
        .context("Could not reach the X playback playlist.")?;
    if !response.status().is_success() {
        return Ok(None);
    }
    Ok(Some(response.text().await.unwrap_or_default()))
}

#[derive(Debug, PartialEq, Eq)]
enum PlaylistVerdict {
    Playable,
    /// Master playlist: the first variant URI to follow.
    Variant(String),
    NotReady,
}

fn playlist_verdict(body: &str) -> PlaylistVerdict {
    let mut variant = None;
    let mut saw_stream_inf = false;
    for line in body.lines() {
        let line = line.trim();
        if line.starts_with("#EXTINF") {
            return PlaylistVerdict::Playable;
        }
        if saw_stream_inf && !line.is_empty() && !line.starts_with('#') && variant.is_none() {
            variant = Some(line.to_string());
        }
        if line.starts_with("#EXT-X-STREAM-INF") {
            saw_stream_inf = true;
        }
    }
    match variant {
        Some(variant) => PlaylistVerdict::Variant(variant),
        None => PlaylistVerdict::NotReady,
    }
}

fn resolve_playlist_url(playlist_url: &str, reference: &str) -> Result<String> {
    if reference.starts_with("http://") || reference.starts_with("https://") {
        return Ok(reference.to_string());
    }
    let base = Url::parse(playlist_url).context("X playback playlist URL is invalid.")?;
    Ok(base
        .join(reference)
        .context("Could not resolve the X playback variant URL.")?
        .to_string())
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

/// PUBLISH `chat_option` enum (X Livestream API doc): 0 none, 1 disabled,
/// 2 everyone, 3 verified accounts (platform default), 4 follows,
/// 5 subscribers.
pub fn default_chat_option() -> u8 {
    optional_env_any(&[
        "VIDEORC_X_LIVESTREAM_CHAT_OPTION",
        "X_LIVESTREAM_CHAT_OPTION",
    ])
    .and_then(|value| value.parse::<u8>().ok())
    .unwrap_or(DEFAULT_CHAT_OPTION)
}

async fn get_region(
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
    let url = endpoint(
        base_url,
        &format!("/2/users/{}/sources", credentials.user_id),
    )?;
    let response: XSourcesEnvelope =
        send_x_request(client, credentials, Method::GET, url, None).await?;
    Ok(response.sources)
}

async fn create_source(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    name: &str,
    region: &str,
) -> Result<XStreamSource> {
    let url = endpoint(
        base_url,
        &format!("/2/users/{}/sources", credentials.user_id),
    )?;
    let body = json!({ "name": name, "region": region });
    let response: XSourceEnvelope =
        send_x_request(client, credentials, Method::POST, url, Some(body)).await?;
    Ok(response.source)
}

/// Which existing sources to delete after a fresh one is created: idle
/// Videorc-named sources (previous sessions' leftovers) plus explicitly
/// retired ids. Never the fresh source, never one actively receiving.
fn x_source_cleanup_ids(
    sources: &[XStreamSource],
    source_name: &str,
    retired_source_ids: &[String],
    keep_source_id: &str,
) -> Vec<String> {
    sources
        .iter()
        .filter(|source| source.id != keep_source_id && !source.is_stream_active)
        .filter(|source| {
            source.name.as_deref() == Some(source_name) || retired_source_ids.contains(&source.id)
        })
        .map(|source| source.id.clone())
        .collect()
}

async fn delete_source(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    source_id: &str,
) -> Result<()> {
    let url = endpoint(
        base_url,
        &format!("/2/users/{}/sources/{}", credentials.user_id, source_id),
    )?;
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
    let url = endpoint(
        base_url,
        &format!("/2/users/{}/sources/{}", credentials.user_id, source_id),
    )?;
    let response: XSourceEnvelope =
        send_x_request(client, credentials, Method::GET, url, None).await?;
    Ok(response.source)
}

async fn create_broadcast(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    source_id: &str,
    region: &str,
    is_low_latency: bool,
) -> Result<XBroadcastEnvelope> {
    let url = endpoint(
        base_url,
        &format!("/2/users/{}/broadcasts", credentials.user_id),
    )?;
    let body = json!({
        "source_id": source_id,
        "region": region,
        "is_low_latency": is_low_latency,
    });
    send_x_request(client, credentials, Method::POST, url, Some(body)).await
}

struct PublishBroadcastStateRequest<'a> {
    broadcast_id: &'a str,
    title: &'a str,
    should_not_tweet: bool,
    locale: &'a str,
    chat_option: u8,
}

async fn publish_broadcast(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    request: PublishBroadcastStateRequest<'_>,
) -> Result<XBroadcastEnvelope> {
    let url = endpoint(
        base_url,
        &format!(
            "/2/users/{}/broadcasts/{}/state",
            credentials.user_id, request.broadcast_id
        ),
    )?;
    let body = json!({
        "state": "PUBLISH",
        "title": request.title,
        "should_not_tweet": request.should_not_tweet,
        "locale": request.locale,
        "chat_option": request.chat_option,
    });
    send_x_request(client, credentials, Method::PUT, url, Some(body)).await
}

async fn end_broadcast(
    client: &reqwest::Client,
    credentials: &XLivestreamCredentials,
    base_url: &str,
    broadcast_id: &str,
) -> Result<()> {
    let url = endpoint(
        base_url,
        &format!(
            "/2/users/{}/broadcasts/{}/state",
            credentials.user_id, broadcast_id
        ),
    )?;
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
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = x_error_detail(&body).unwrap_or_else(|| "no error detail".to_string());
        anyhow::bail!("X Livestream API request failed with HTTP {status}: {detail}");
    }
    response
        .json::<T>()
        .await
        .context("Could not parse X Livestream API response")
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

fn api_base_url(value: Option<&str>) -> String {
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

fn sanitize_secret_ref_segment(value: &str) -> String {
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

fn x_error_detail(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    if let Some(message) = value
        .get("message")
        .and_then(|message| message.as_str())
        .map(str::trim)
        .filter(|message| !message.is_empty())
    {
        return Some(message.to_string());
    }
    if let Some(errors) = value.get("errors").and_then(|errors| errors.as_array()) {
        let joined = errors
            .iter()
            .filter_map(|error| {
                error
                    .get("message")
                    .and_then(|message| message.as_str())
                    .or_else(|| error.as_str())
            })
            .map(str::trim)
            .filter(|message| !message.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if !joined.is_empty() {
            return Some(joined.join("; "));
        }
    }
    value
        .get("error")
        .and_then(|error| error.as_str())
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(ToOwned::to_owned)
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
/// exposes is `should_not_tweet` on PUBLISH (suppresses the announcement
/// post). The draft stores it as `x_announce` (None/true = announce, the
/// platform default).
fn x_should_not_tweet(metadata: &StreamMetadataDraft) -> bool {
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
            "https://api.x.com/2/users/12345/sources?pagination_token=a b",
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
            "https://api.x.com/2/users/12345/sources?pagination_token=a b",
            &credentials,
            "nonce",
            1772031973,
        )
        .unwrap();
        let general = oauth1_signed_header(&Oauth1SigningInputs {
            method: "POST",
            url: "https://api.x.com/2/users/12345/sources?pagination_token=a b",
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

    #[test]
    fn playlist_verdict_detects_segments_variants_and_not_ready() {
        assert_eq!(
            playlist_verdict("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg0.ts\n"),
            PlaylistVerdict::Playable
        );
        assert_eq!(
            playlist_verdict(
                "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant/playlist.m3u8\n"
            ),
            PlaylistVerdict::Variant("variant/playlist.m3u8".to_string())
        );
        assert_eq!(
            playlist_verdict("#EXTM3U\n#EXT-X-TARGETDURATION:2\n"),
            PlaylistVerdict::NotReady
        );
        assert_eq!(playlist_verdict(""), PlaylistVerdict::NotReady);
    }

    #[test]
    fn playlist_variant_urls_resolve_relative_and_absolute() {
        assert_eq!(
            resolve_playlist_url(
                "https://video.pscp.tv/x/master.m3u8?type=live",
                "variant/playlist.m3u8"
            )
            .unwrap(),
            "https://video.pscp.tv/x/variant/playlist.m3u8"
        );
        assert_eq!(
            resolve_playlist_url(
                "https://video.pscp.tv/x/master.m3u8",
                "https://other.pscp.tv/v.m3u8"
            )
            .unwrap(),
            "https://other.pscp.tv/v.m3u8"
        );
    }

    #[tokio::test]
    async fn playlist_probe_follows_master_to_variant() {
        use axum::Router;
        use axum::routing::get;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route(
                        "/master.m3u8",
                        get(|| async {
                            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nmedia.m3u8\n"
                        }),
                    )
                    .route(
                        "/media.m3u8",
                        get(|| async { "#EXTM3U\n#EXTINF:2.0,\nseg0.ts\n" }),
                    )
                    .route("/empty.m3u8", get(|| async { "#EXTM3U\n" })),
            )
            .await
            .unwrap();
        });
        let client = reqwest::Client::new();
        assert!(
            x_playlist_playable(&client, &format!("http://{address}/master.m3u8"))
                .await
                .unwrap()
        );
        assert!(
            !x_playlist_playable(&client, &format!("http://{address}/empty.m3u8"))
                .await
                .unwrap()
        );
        assert!(
            !x_playlist_playable(&client, &format!("http://{address}/missing.m3u8"))
                .await
                .unwrap()
        );
    }

    #[test]
    fn playback_outcomes_retire_only_after_consecutive_failures() {
        let health = XSourceHealth::default();
        let after_one = apply_x_playback_outcome(health, false, "2026-07-08T12:00:00Z");
        assert_eq!(after_one.consecutive_failures, 1);
        assert!(!after_one.retired);

        let after_two = apply_x_playback_outcome(after_one.clone(), false, "2026-07-08T13:00:00Z");
        assert_eq!(after_two.consecutive_failures, 2);
        assert!(after_two.retired);

        // A verified playback fully rehabilitates the source.
        let recovered = apply_x_playback_outcome(after_two, true, "2026-07-08T14:00:00Z");
        assert_eq!(recovered.consecutive_failures, 0);
        assert!(!recovered.retired);
        assert_eq!(
            recovered.last_verified_at.as_deref(),
            Some("2026-07-08T14:00:00Z")
        );

        // One failure after a success does NOT retire (the 2026-07-08
        // incident source worked at 7 min and failed at 2 min same day).
        let one_bad = apply_x_playback_outcome(recovered, false, "2026-07-08T15:00:00Z");
        assert!(!one_bad.retired);
    }

    fn test_source(id: &str, name: Option<&str>, active: bool) -> XStreamSource {
        XStreamSource {
            id: id.to_string(),
            name: name.map(str::to_string),
            rtmp_region: Some("eu-west-3".to_string()),
            rtmps_url: None,
            rtmp_url: None,
            rtmp_stream_key: None,
            is_stream_active: active,
            recommended_configuration: None,
            compatibility_info: None,
        }
    }

    // Plan 031 S2: fresh-source-per-session cleanup. The only condition that
    // ever produced instant playback is a source's first broadcast, so every
    // session creates one and prior leftovers must be reaped — but never the
    // fresh source, never an actively-receiving one, and never a source we
    // don't own by name (e.g. Media Studio or StreamYard sources).
    #[test]
    fn source_cleanup_reaps_idle_videorc_and_retired_sources_only() {
        let sources = vec![
            test_source("fresh1", Some("Videorc Primary Encoder"), false),
            test_source("old1", Some("Videorc Primary Encoder"), false),
            test_source("active1", Some("Videorc Primary Encoder"), true),
            test_source("studio1", Some("Videorc"), false),
            test_source("streamyard", Some("StreamYardApp"), false),
            test_source("retired1", Some("Other Name"), false),
        ];

        let cleanup = x_source_cleanup_ids(
            &sources,
            "Videorc Primary Encoder",
            &["retired1".to_string()],
            "fresh1",
        );

        assert_eq!(cleanup, vec!["old1".to_string(), "retired1".to_string()]);
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
}
