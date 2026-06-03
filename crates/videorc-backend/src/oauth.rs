use std::collections::HashMap;

use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::streaming::{
    PlatformAccountStatus, StreamPlatform, UpsertPlatformAccount, stream_platform_id,
    stream_platform_label,
};

const OAUTH_STATE_TTL_MINUTES: i64 = 10;
const BUNDLED_YOUTUBE_CLIENT_ID: Option<&str> = option_env!("VIDEORC_BUNDLED_YOUTUBE_CLIENT_ID");
const BUNDLED_TWITCH_CLIENT_ID: Option<&str> = option_env!("VIDEORC_BUNDLED_TWITCH_CLIENT_ID");
const BUNDLED_X_CLIENT_ID: Option<&str> = option_env!("VIDEORC_BUNDLED_X_CLIENT_ID");

#[derive(Debug, Default)]
pub struct OAuthSessions {
    pending: Mutex<HashMap<String, PendingOAuthSession>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartParams {
    pub platform: StreamPlatform,
    pub authorization_url: String,
    pub client_id: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redirect_uri: Option<String>,
    #[serde(default)]
    pub extra_params: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartProviderParams {
    pub platform: StreamPlatform,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redirect_uri: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartResult {
    pub platform: StreamPlatform,
    pub state: String,
    pub auth_url: String,
    pub redirect_uri: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthProviderCredentialStatus {
    pub platform: StreamPlatform,
    pub ready: bool,
    pub client_id_present: bool,
    pub client_secret_present: bool,
    pub client_id_source: OAuthCredentialSource,
    pub pkce: bool,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OAuthCredentialSource {
    Bundled,
    Environment,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCompleteParams {
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OAuthCallbackStatus {
    Success,
    Failed,
    Expired,
    UnknownState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCallbackResult {
    pub platform: Option<StreamPlatform>,
    pub state: String,
    pub status: OAuthCallbackStatus,
    pub code_present: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub token_stored: bool,
    pub account_connected: bool,
    pub received_at: String,
}

#[derive(Debug, Clone)]
struct PendingOAuthSession {
    platform: StreamPlatform,
    expires_at: chrono::DateTime<Utc>,
    exchange: Option<PendingOAuthExchange>,
}

#[derive(Debug, Clone)]
pub struct OAuthCompleteOutcome {
    pub result: OAuthCallbackResult,
    pub exchange: Option<PendingOAuthExchange>,
    pub authorization_code: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PendingOAuthExchange {
    pub platform: StreamPlatform,
    pub token_url: String,
    pub profile_url: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    pub code_verifier: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshedOAuthToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub scopes: Vec<String>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone)]
struct OAuthProviderConfig {
    authorization_url: String,
    token_url: String,
    profile_url: String,
    client_id: String,
    client_secret: Option<String>,
    scopes: Vec<String>,
    extra_params: HashMap<String, String>,
    pkce: bool,
}

impl OAuthSessions {
    pub async fn start(
        &self,
        params: OAuthStartParams,
        backend_port: u16,
    ) -> Result<OAuthStartResult> {
        validate_start_params(&params)?;
        let state = Uuid::new_v4().to_string();
        let redirect_uri = params
            .redirect_uri
            .clone()
            .unwrap_or_else(|| format!("http://127.0.0.1:{backend_port}/oauth/callback"));
        let expires_at = Utc::now() + Duration::minutes(OAUTH_STATE_TTL_MINUTES);
        let auth_url = authorization_url(&params, &state, &redirect_uri);

        self.pending.lock().await.insert(
            state.clone(),
            PendingOAuthSession {
                platform: params.platform,
                expires_at,
                exchange: None,
            },
        );

        Ok(OAuthStartResult {
            platform: params.platform,
            state,
            auth_url,
            redirect_uri,
            expires_at: expires_at.to_rfc3339(),
        })
    }

    pub async fn start_provider(
        &self,
        params: OAuthStartProviderParams,
        backend_port: u16,
    ) -> Result<OAuthStartResult> {
        if matches!(params.platform, StreamPlatform::Custom) {
            anyhow::bail!("Custom RTMP does not support OAuth.");
        }
        let config = provider_config(params.platform)?;
        let state = Uuid::new_v4().to_string();
        let redirect_uri = provider_redirect_uri(params.redirect_uri.as_deref(), backend_port)?;
        let expires_at = Utc::now() + Duration::minutes(OAUTH_STATE_TTL_MINUTES);
        let mut extra_params = config.extra_params.clone();
        let code_verifier = if config.pkce {
            let verifier = pkce_verifier();
            extra_params.insert("code_challenge".to_string(), pkce_s256_challenge(&verifier));
            extra_params.insert("code_challenge_method".to_string(), "S256".to_string());
            Some(verifier)
        } else {
            None
        };
        let start_params = OAuthStartParams {
            platform: params.platform,
            authorization_url: config.authorization_url.clone(),
            client_id: config.client_id.clone(),
            scopes: config.scopes.clone(),
            redirect_uri: Some(redirect_uri.clone()),
            extra_params,
        };
        let auth_url = authorization_url(&start_params, &state, &redirect_uri);

        self.pending.lock().await.insert(
            state.clone(),
            PendingOAuthSession {
                platform: params.platform,
                expires_at,
                exchange: Some(PendingOAuthExchange {
                    platform: params.platform,
                    token_url: config.token_url,
                    profile_url: config.profile_url,
                    client_id: config.client_id,
                    client_secret: config.client_secret,
                    redirect_uri: redirect_uri.clone(),
                    scopes: normalized_scopes(&config.scopes),
                    code_verifier,
                }),
            },
        );

        Ok(OAuthStartResult {
            platform: params.platform,
            state,
            auth_url,
            redirect_uri,
            expires_at: expires_at.to_rfc3339(),
        })
    }

    #[cfg(test)]
    pub async fn complete(&self, params: OAuthCompleteParams) -> OAuthCallbackResult {
        self.complete_with_pending(params).await.result
    }

    pub async fn complete_with_pending(&self, params: OAuthCompleteParams) -> OAuthCompleteOutcome {
        let received_at = Utc::now();
        let Some(pending) = self.pending.lock().await.remove(&params.state) else {
            return OAuthCompleteOutcome {
                result: OAuthCallbackResult {
                    platform: None,
                    state: params.state,
                    status: OAuthCallbackStatus::UnknownState,
                    code_present: params.code.as_ref().is_some_and(|code| !code.is_empty()),
                    error: params.error,
                    message: Some("OAuth callback state is not recognized.".to_string()),
                    token_stored: false,
                    account_connected: false,
                    received_at: received_at.to_rfc3339(),
                },
                exchange: None,
                authorization_code: None,
            };
        };

        let code_present = params.code.as_ref().is_some_and(|code| !code.is_empty());
        if pending.expires_at < received_at {
            return OAuthCompleteOutcome {
                result: OAuthCallbackResult {
                    platform: Some(pending.platform),
                    state: params.state,
                    status: OAuthCallbackStatus::Expired,
                    code_present,
                    error: params.error,
                    message: Some(
                        "OAuth callback state expired. Start the connection again.".to_string(),
                    ),
                    token_stored: false,
                    account_connected: false,
                    received_at: received_at.to_rfc3339(),
                },
                exchange: None,
                authorization_code: None,
            };
        }

        let failed = params.error.is_some() || !code_present;
        let status = if failed {
            OAuthCallbackStatus::Failed
        } else {
            OAuthCallbackStatus::Success
        };
        let authorization_code = (!failed).then_some(params.code).flatten();
        OAuthCompleteOutcome {
            result: OAuthCallbackResult {
                platform: Some(pending.platform),
                state: params.state,
                status,
                code_present,
                error: params.error,
                message: params.error_description.or_else(|| {
                    (!code_present).then(|| "OAuth callback did not include a code.".to_string())
                }),
                token_stored: false,
                account_connected: false,
                received_at: received_at.to_rfc3339(),
            },
            exchange: (!failed).then_some(pending.exchange).flatten(),
            authorization_code,
        }
    }
}

pub async fn exchange_and_store_token<F>(
    exchange: &PendingOAuthExchange,
    authorization_code: &str,
    client: &reqwest::Client,
    mut put_secret: F,
) -> Result<UpsertPlatformAccount>
where
    F: FnMut(&str, &str) -> Result<()>,
{
    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", authorization_code.to_string()),
        ("redirect_uri", exchange.redirect_uri.clone()),
        ("client_id", exchange.client_id.clone()),
    ];
    if let Some(client_secret) = exchange.client_secret.as_ref() {
        form.push(("client_secret", client_secret.clone()));
    }
    if let Some(code_verifier) = exchange.code_verifier.as_ref() {
        form.push(("code_verifier", code_verifier.clone()));
    }

    let response = client
        .post(&exchange.token_url)
        .form(&form)
        .send()
        .await
        .with_context(|| {
            format!(
                "Could not exchange OAuth code for {}",
                stream_platform_label(exchange.platform)
            )
        })?;
    if !response.status().is_success() {
        let status = response.status();
        anyhow::bail!("OAuth token exchange failed with HTTP {status}");
    }
    let token = response
        .json::<OAuthTokenResponse>()
        .await
        .context("Could not parse OAuth token response")?;
    if token.access_token.trim().is_empty() {
        anyhow::bail!("OAuth token response did not include an access token.");
    }
    let profile = fetch_provider_profile(
        exchange.platform,
        &exchange.profile_url,
        &exchange.client_id,
        &token.access_token,
        client,
    )
    .await?;

    let platform_id = stream_platform_id(exchange.platform);
    let access_ref = format!("platform:{platform_id}:oauth:access");
    put_secret(&access_ref, &token.access_token)?;
    let refresh_ref = token
        .refresh_token
        .as_deref()
        .filter(|refresh_token| !refresh_token.trim().is_empty())
        .map(|refresh_token| {
            let secret_ref = format!("platform:{platform_id}:oauth:refresh");
            put_secret(&secret_ref, refresh_token)?;
            Ok::<_, anyhow::Error>(secret_ref)
        })
        .transpose()?;
    let scopes = token
        .scopes()
        .filter(|scopes| !scopes.is_empty())
        .unwrap_or_else(|| exchange.scopes.clone());
    let expires_at = token
        .expires_in
        .and_then(|seconds| Utc::now().checked_add_signed(Duration::seconds(seconds)))
        .map(|expires_at| expires_at.to_rfc3339());

    Ok(UpsertPlatformAccount {
        platform: exchange.platform,
        account_id: profile.account_id,
        account_label: profile.account_label,
        account_handle: profile.account_handle,
        avatar_url: profile.avatar_url,
        scopes,
        token_secret_ref: Some(access_ref),
        refresh_token_secret_ref: refresh_ref,
        stream_key_secret_ref: None,
        expires_at,
        status: PlatformAccountStatus::Connected,
    })
}

pub async fn refresh_provider_token(
    platform: StreamPlatform,
    refresh_token: &str,
    client: &reqwest::Client,
) -> Result<RefreshedOAuthToken> {
    if refresh_token.trim().is_empty() {
        anyhow::bail!("Refresh token is empty.");
    }
    let config = provider_config(platform)?;
    let mut form = vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh_token.to_string()),
        ("client_id", config.client_id),
    ];
    if let Some(client_secret) = config.client_secret {
        form.push(("client_secret", client_secret));
    }
    let response = client
        .post(&config.token_url)
        .form(&form)
        .send()
        .await
        .with_context(|| {
            format!(
                "Could not refresh {} OAuth token",
                stream_platform_label(platform)
            )
        })?;
    if !response.status().is_success() {
        let status = response.status();
        anyhow::bail!(
            "{} token refresh failed with HTTP {status}",
            stream_platform_label(platform)
        );
    }
    let token = response
        .json::<OAuthTokenResponse>()
        .await
        .context("Could not parse OAuth refresh response")?;
    if token.access_token.trim().is_empty() {
        anyhow::bail!("OAuth refresh response did not include an access token.");
    }
    let scopes = token
        .scopes()
        .filter(|scopes| !scopes.is_empty())
        .unwrap_or_else(|| config.scopes.clone());
    let expires_at = token
        .expires_in
        .and_then(|seconds| Utc::now().checked_add_signed(Duration::seconds(seconds)))
        .map(|expires_at| expires_at.to_rfc3339());
    Ok(RefreshedOAuthToken {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        scopes,
        expires_at,
    })
}

pub async fn validate_provider_access(
    platform: StreamPlatform,
    access_token: &str,
    client: &reqwest::Client,
) -> Result<()> {
    if access_token.trim().is_empty() {
        anyhow::bail!("Access token is empty.");
    }
    let config = provider_config(platform)?;
    fetch_provider_profile(
        platform,
        &config.profile_url,
        &config.client_id,
        access_token,
        client,
    )
    .await?;
    Ok(())
}

async fn fetch_provider_profile(
    platform: StreamPlatform,
    profile_url: &str,
    client_id: &str,
    access_token: &str,
    client: &reqwest::Client,
) -> Result<ProviderProfile> {
    let request = client.get(profile_url).bearer_auth(access_token);
    let request = if platform == StreamPlatform::Twitch {
        request.header("Client-Id", client_id)
    } else {
        request
    };
    let response = request.send().await.with_context(|| {
        format!(
            "Could not fetch {} account profile",
            stream_platform_label(platform)
        )
    })?;
    if !response.status().is_success() {
        let status = response.status();
        anyhow::bail!(
            "{} profile lookup failed with HTTP {status}",
            stream_platform_label(platform)
        );
    }
    let value = response
        .json::<serde_json::Value>()
        .await
        .context("Could not parse OAuth profile response")?;
    parse_provider_profile(platform, value)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderProfile {
    account_id: String,
    account_label: String,
    account_handle: Option<String>,
    avatar_url: Option<String>,
}

fn parse_provider_profile(
    platform: StreamPlatform,
    value: serde_json::Value,
) -> Result<ProviderProfile> {
    match platform {
        StreamPlatform::Youtube => parse_youtube_profile(value),
        StreamPlatform::Twitch => parse_twitch_profile(value),
        StreamPlatform::X => parse_x_profile(value),
        StreamPlatform::Custom => anyhow::bail!("Custom RTMP does not support OAuth profiles."),
    }
}

fn parse_youtube_profile(value: serde_json::Value) -> Result<ProviderProfile> {
    let channel = value
        .get("items")
        .and_then(|items| items.as_array())
        .and_then(|items| items.first())
        .context("YouTube profile response did not include a channel.")?;
    let account_id = required_json_string(channel.get("id"), "YouTube channel id")?;
    let snippet = channel.get("snippet").unwrap_or(&serde_json::Value::Null);
    let account_label = required_json_string(snippet.get("title"), "YouTube channel title")?;
    let avatar_url = snippet
        .get("thumbnails")
        .and_then(|thumbnails| {
            thumbnails
                .get("high")
                .or_else(|| thumbnails.get("medium"))
                .or_else(|| thumbnails.get("default"))
        })
        .and_then(|thumbnail| thumbnail.get("url"))
        .and_then(|url| url.as_str())
        .map(str::to_string);

    Ok(ProviderProfile {
        account_id,
        account_label,
        account_handle: snippet
            .get("customUrl")
            .and_then(|handle| handle.as_str())
            .map(str::to_string),
        avatar_url,
    })
}

fn parse_twitch_profile(value: serde_json::Value) -> Result<ProviderProfile> {
    let user = value
        .get("data")
        .and_then(|data| data.as_array())
        .and_then(|items| items.first())
        .context("Twitch profile response did not include a user.")?;
    let account_id = required_json_string(user.get("id"), "Twitch user id")?;
    let account_label = required_json_string(user.get("display_name"), "Twitch display name")?;
    let account_handle = user
        .get("login")
        .and_then(|login| login.as_str())
        .map(|login| format!("@{login}"));
    let avatar_url = user
        .get("profile_image_url")
        .and_then(|url| url.as_str())
        .map(str::to_string);

    Ok(ProviderProfile {
        account_id,
        account_label,
        account_handle,
        avatar_url,
    })
}

fn parse_x_profile(value: serde_json::Value) -> Result<ProviderProfile> {
    let user = value
        .get("data")
        .context("X profile response did not include a user.")?;
    let account_id = required_json_string(user.get("id"), "X user id")?;
    let account_label = required_json_string(user.get("name"), "X display name")?;
    let account_handle = user
        .get("username")
        .and_then(|username| username.as_str())
        .map(|username| format!("@{username}"));
    let avatar_url = user
        .get("profile_image_url")
        .and_then(|url| url.as_str())
        .map(str::to_string);

    Ok(ProviderProfile {
        account_id,
        account_label,
        account_handle,
        avatar_url,
    })
}

fn required_json_string(value: Option<&serde_json::Value>, field: &str) -> Result<String> {
    let value = value
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("{field} is missing."))?;
    Ok(value.to_string())
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    scope: Option<OAuthScopeResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum OAuthScopeResponse {
    String(String),
    List(Vec<String>),
}

impl OAuthTokenResponse {
    fn scopes(&self) -> Option<Vec<String>> {
        match self.scope.as_ref()? {
            OAuthScopeResponse::String(scopes) => Some(normalized_scopes(
                &scopes.split(' ').map(str::to_string).collect::<Vec<_>>(),
            )),
            OAuthScopeResponse::List(scopes) => Some(normalized_scopes(scopes)),
        }
    }
}

fn provider_config(platform: StreamPlatform) -> Result<OAuthProviderConfig> {
    match platform {
        StreamPlatform::Youtube => Ok(OAuthProviderConfig {
            authorization_url: "https://accounts.google.com/o/oauth2/v2/auth".to_string(),
            token_url: "https://oauth2.googleapis.com/token".to_string(),
            profile_url: "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true"
                .to_string(),
            client_id: required_credential("VIDEORC_YOUTUBE_CLIENT_ID", BUNDLED_YOUTUBE_CLIENT_ID)?,
            client_secret: optional_env("VIDEORC_YOUTUBE_CLIENT_SECRET"),
            scopes: vec![
                "https://www.googleapis.com/auth/youtube".to_string(),
                "https://www.googleapis.com/auth/youtube.force-ssl".to_string(),
            ],
            extra_params: HashMap::from([
                ("access_type".to_string(), "offline".to_string()),
                ("prompt".to_string(), "consent".to_string()),
            ]),
            pkce: true,
        }),
        StreamPlatform::Twitch => Ok(OAuthProviderConfig {
            authorization_url: "https://id.twitch.tv/oauth2/authorize".to_string(),
            token_url: "https://id.twitch.tv/oauth2/token".to_string(),
            profile_url: "https://api.twitch.tv/helix/users".to_string(),
            client_id: required_credential("VIDEORC_TWITCH_CLIENT_ID", BUNDLED_TWITCH_CLIENT_ID)?,
            client_secret: optional_env("VIDEORC_TWITCH_CLIENT_SECRET"),
            scopes: vec![
                "channel:manage:broadcast".to_string(),
                "channel:read:stream_key".to_string(),
            ],
            extra_params: HashMap::new(),
            pkce: false,
        }),
        StreamPlatform::X => Ok(OAuthProviderConfig {
            authorization_url: "https://x.com/i/oauth2/authorize".to_string(),
            token_url: "https://api.x.com/2/oauth2/token".to_string(),
            profile_url: "https://api.x.com/2/users/me?user.fields=profile_image_url".to_string(),
            client_id: required_credential("VIDEORC_X_CLIENT_ID", BUNDLED_X_CLIENT_ID)?,
            client_secret: optional_env("VIDEORC_X_CLIENT_SECRET"),
            scopes: vec![
                "tweet.read".to_string(),
                "users.read".to_string(),
                "offline.access".to_string(),
            ],
            extra_params: HashMap::new(),
            pkce: true,
        }),
        StreamPlatform::Custom => anyhow::bail!("Custom RTMP does not support OAuth."),
    }
}

fn provider_redirect_uri(redirect_uri: Option<&str>, backend_port: u16) -> Result<String> {
    let value = redirect_uri
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("http://127.0.0.1:{backend_port}/oauth/callback"));
    validate_provider_redirect_uri(&value)?;
    Ok(value)
}

fn validate_provider_redirect_uri(value: &str) -> Result<()> {
    let parsed = reqwest::Url::parse(value).context("OAuth redirect URI is not a valid URL.")?;
    match parsed.scheme() {
        "http" => {
            let host = parsed.host_str().unwrap_or_default();
            if matches!(host, "127.0.0.1" | "localhost") && parsed.path() == "/oauth/callback" {
                return Ok(());
            }
        }
        "videorc" if parsed.host_str() == Some("oauth") && parsed.path() == "/callback" => {
            return Ok(());
        }
        _ => {}
    }

    anyhow::bail!(
        "OAuth provider redirect URI must be loopback http://127.0.0.1:<port>/oauth/callback or videorc://oauth/callback."
    )
}

pub fn provider_client_id(platform: StreamPlatform) -> Result<String> {
    Ok(provider_config(platform)?.client_id)
}

pub fn provider_credential_statuses() -> Vec<OAuthProviderCredentialStatus> {
    vec![
        provider_credential_status(
            StreamPlatform::Youtube,
            "VIDEORC_YOUTUBE_CLIENT_ID",
            "VIDEORC_YOUTUBE_CLIENT_SECRET",
            BUNDLED_YOUTUBE_CLIENT_ID,
            true,
        ),
        provider_credential_status(
            StreamPlatform::Twitch,
            "VIDEORC_TWITCH_CLIENT_ID",
            "VIDEORC_TWITCH_CLIENT_SECRET",
            BUNDLED_TWITCH_CLIENT_ID,
            false,
        ),
        provider_credential_status(
            StreamPlatform::X,
            "VIDEORC_X_CLIENT_ID",
            "VIDEORC_X_CLIENT_SECRET",
            BUNDLED_X_CLIENT_ID,
            true,
        ),
    ]
}

fn provider_credential_status(
    platform: StreamPlatform,
    client_id_env: &str,
    client_secret_env: &str,
    bundled_client_id: Option<&'static str>,
    pkce: bool,
) -> OAuthProviderCredentialStatus {
    let client_id_source = credential_source(optional_env(client_id_env), bundled_client_id);
    let client_id_present = client_id_source != OAuthCredentialSource::Missing;
    let client_secret_present = optional_env(client_secret_env).is_some();
    let ready = client_id_present && (pkce || client_secret_present);
    let label = stream_platform_label(platform);
    OAuthProviderCredentialStatus {
        platform,
        ready,
        client_id_present,
        client_secret_present,
        client_id_source,
        pkce,
        message: if !client_id_present {
            format!("{label} OAuth requires {client_id_env}.")
        } else if !pkce && !client_secret_present {
            format!("{label} OAuth also needs its runtime client secret before connecting.")
        } else {
            match client_id_source {
                OAuthCredentialSource::Environment => {
                    format!("{label} OAuth is using {client_id_env}.")
                }
                OAuthCredentialSource::Bundled => {
                    format!("{label} OAuth is using the bundled Videogre client ID.")
                }
                OAuthCredentialSource::Missing => {
                    unreachable!("client ID presence was checked above")
                }
            }
        },
    }
}

fn required_credential(name: &str, bundled: Option<&'static str>) -> Result<String> {
    optional_env(name)
        .or_else(|| optional_static(bundled))
        .ok_or_else(|| anyhow::anyhow!("{name} is not configured."))
}

fn credential_source(
    runtime: Option<String>,
    bundled: Option<&'static str>,
) -> OAuthCredentialSource {
    if runtime.is_some() {
        OAuthCredentialSource::Environment
    } else if optional_static(bundled).is_some() {
        OAuthCredentialSource::Bundled
    } else {
        OAuthCredentialSource::Missing
    }
}

fn optional_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn optional_static(value: Option<&'static str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn pkce_verifier() -> String {
    format!("videorc-{}", Uuid::new_v4().simple())
}

fn pkce_s256_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn validate_start_params(params: &OAuthStartParams) -> Result<()> {
    if matches!(params.platform, StreamPlatform::Custom) {
        anyhow::bail!("Custom RTMP does not support OAuth.");
    }
    if params.authorization_url.trim().is_empty() {
        anyhow::bail!("OAuth authorization URL is required.");
    }
    if params.client_id.trim().is_empty() {
        anyhow::bail!("OAuth client id is required.");
    }
    Ok(())
}

fn authorization_url(params: &OAuthStartParams, state: &str, redirect_uri: &str) -> String {
    let mut query = vec![
        ("response_type".to_string(), "code".to_string()),
        ("client_id".to_string(), params.client_id.clone()),
        ("redirect_uri".to_string(), redirect_uri.to_string()),
        ("state".to_string(), state.to_string()),
    ];
    let scopes = normalized_scopes(&params.scopes);
    if !scopes.is_empty() {
        query.push(("scope".to_string(), scopes.join(" ")));
    }
    let mut extra = params
        .extra_params
        .iter()
        .filter(|(key, _)| !reserved_oauth_param(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<Vec<_>>();
    extra.sort_by(|left, right| left.0.cmp(&right.0));
    query.extend(extra);

    let separator = if params.authorization_url.contains('?') {
        '&'
    } else {
        '?'
    };
    format!(
        "{}{}{}",
        params.authorization_url.trim(),
        separator,
        query
            .into_iter()
            .map(|(key, value)| format!("{}={}", percent_encode(&key), percent_encode(&value)))
            .collect::<Vec<_>>()
            .join("&")
    )
}

fn reserved_oauth_param(key: &str) -> bool {
    matches!(
        key,
        "response_type" | "client_id" | "redirect_uri" | "state" | "scope"
    )
}

fn normalized_scopes(scopes: &[String]) -> Vec<String> {
    let mut scopes = scopes
        .iter()
        .map(|scope| scope.trim().to_string())
        .filter(|scope| !scope.is_empty())
        .collect::<Vec<_>>();
    scopes.sort();
    scopes.dedup();
    scopes
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Form;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use tokio::net::TcpListener;

    fn start_params() -> OAuthStartParams {
        OAuthStartParams {
            platform: StreamPlatform::Youtube,
            authorization_url: "https://accounts.example.test/oauth".to_string(),
            client_id: "client 123".to_string(),
            scopes: vec![
                "videos.write".to_string(),
                " account.read ".to_string(),
                "videos.write".to_string(),
            ],
            redirect_uri: None,
            extra_params: HashMap::from([
                ("prompt".to_string(), "consent".to_string()),
                ("state".to_string(), "malicious".to_string()),
            ]),
        }
    }

    #[tokio::test]
    async fn start_builds_loopback_auth_url_and_pending_state() {
        let sessions = OAuthSessions::default();
        let result = sessions.start(start_params(), 61234).await.unwrap();

        assert_eq!(result.platform, StreamPlatform::Youtube);
        assert_eq!(result.redirect_uri, "http://127.0.0.1:61234/oauth/callback");
        assert!(
            result
                .auth_url
                .starts_with("https://accounts.example.test/oauth?")
        );
        assert!(result.auth_url.contains("response_type=code"));
        assert!(result.auth_url.contains("client_id=client%20123"));
        assert!(
            result
                .auth_url
                .contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A61234%2Foauth%2Fcallback")
        );
        assert!(result.auth_url.contains(&format!("state={}", result.state)));
        assert!(
            result
                .auth_url
                .contains("scope=account.read%20videos.write")
        );
        assert!(result.auth_url.contains("prompt=consent"));
        assert!(!result.auth_url.contains("malicious"));

        let completed = sessions
            .complete(OAuthCompleteParams {
                state: result.state,
                code: Some("auth-code".to_string()),
                error: None,
                error_description: None,
            })
            .await;
        assert_eq!(completed.status, OAuthCallbackStatus::Success);
        assert_eq!(completed.platform, Some(StreamPlatform::Youtube));
        assert!(completed.code_present);
    }

    #[tokio::test]
    async fn callback_state_can_only_be_used_once() {
        let sessions = OAuthSessions::default();
        let result = sessions.start(start_params(), 61234).await.unwrap();
        let params = OAuthCompleteParams {
            state: result.state,
            code: Some("auth-code".to_string()),
            error: None,
            error_description: None,
        };

        assert_eq!(
            sessions.complete(params.clone()).await.status,
            OAuthCallbackStatus::Success
        );
        assert_eq!(
            sessions.complete(params).await.status,
            OAuthCallbackStatus::UnknownState
        );
    }

    #[tokio::test]
    async fn callback_error_is_reported_as_failed() {
        let sessions = OAuthSessions::default();
        let result = sessions.start(start_params(), 61234).await.unwrap();

        let completed = sessions
            .complete(OAuthCompleteParams {
                state: result.state,
                code: None,
                error: Some("access_denied".to_string()),
                error_description: Some("User cancelled.".to_string()),
            })
            .await;

        assert_eq!(completed.status, OAuthCallbackStatus::Failed);
        assert_eq!(completed.error.as_deref(), Some("access_denied"));
        assert_eq!(completed.message.as_deref(), Some("User cancelled."));
        assert!(!completed.code_present);
    }

    #[test]
    fn provider_redirect_uri_allows_loopback_and_app_protocol_callbacks() {
        assert_eq!(
            provider_redirect_uri(None, 61234).unwrap(),
            "http://127.0.0.1:61234/oauth/callback"
        );
        assert_eq!(
            provider_redirect_uri(Some("videorc://oauth/callback"), 61234).unwrap(),
            "videorc://oauth/callback"
        );
        assert!(provider_redirect_uri(Some("https://example.com/oauth/callback"), 61234).is_err());
        assert!(provider_redirect_uri(Some("videorc://bad/callback"), 61234).is_err());
    }

    #[test]
    fn pkce_challenge_uses_s256_base64url_without_padding() {
        assert_eq!(
            pkce_s256_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[tokio::test]
    async fn token_exchange_stores_secrets_and_returns_public_account_record() {
        async fn token_endpoint(Form(form): Form<HashMap<String, String>>) -> impl IntoResponse {
            if form.get("code").map(String::as_str) != Some("auth-code")
                || form.get("client_id").map(String::as_str) != Some("client-id")
                || form.get("client_secret").map(String::as_str) != Some("client-secret")
                || form.get("code_verifier").map(String::as_str) != Some("verifier")
            {
                return (StatusCode::BAD_REQUEST, "bad form").into_response();
            }
            Json(serde_json::json!({
                "access_token": "access-token-value",
                "refresh_token": "refresh-token-value",
                "expires_in": 3600,
                "scope": "channel:read:stream_key channel:manage:broadcast"
            }))
            .into_response()
        }
        async fn profile_endpoint(headers: axum::http::HeaderMap) -> impl IntoResponse {
            if headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                != Some("Bearer access-token-value")
                || headers
                    .get("client-id")
                    .and_then(|value| value.to_str().ok())
                    != Some("client-id")
            {
                return (StatusCode::UNAUTHORIZED, "bad auth").into_response();
            }
            Json(serde_json::json!({
                "data": [{
                    "id": "twitch-user-123",
                    "login": "orcdev",
                    "display_name": "The Orc Dev",
                    "profile_image_url": "https://static-cdn.jtvnw.net/avatar.png"
                }]
            }))
            .into_response()
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/token", post(token_endpoint))
                    .route("/profile", get(profile_endpoint)),
            )
            .await
            .unwrap();
        });

        let exchange = PendingOAuthExchange {
            platform: StreamPlatform::Twitch,
            token_url: format!("http://{address}/token"),
            profile_url: format!("http://{address}/profile"),
            client_id: "client-id".to_string(),
            client_secret: Some("client-secret".to_string()),
            redirect_uri: "http://127.0.0.1:61234/oauth/callback".to_string(),
            scopes: vec!["fallback".to_string()],
            code_verifier: Some("verifier".to_string()),
        };
        let mut secrets = Vec::new();
        let account = exchange_and_store_token(
            &exchange,
            "auth-code",
            &reqwest::Client::new(),
            |secret_ref, value| {
                secrets.push((secret_ref.to_string(), value.to_string()));
                Ok(())
            },
        )
        .await
        .unwrap();

        assert_eq!(account.platform, StreamPlatform::Twitch);
        assert_eq!(account.account_id, "twitch-user-123");
        assert_eq!(account.account_label, "The Orc Dev");
        assert_eq!(account.account_handle.as_deref(), Some("@orcdev"));
        assert_eq!(
            account.avatar_url.as_deref(),
            Some("https://static-cdn.jtvnw.net/avatar.png")
        );
        assert_eq!(
            account.scopes,
            vec![
                "channel:manage:broadcast".to_string(),
                "channel:read:stream_key".to_string()
            ]
        );
        assert_eq!(
            account.token_secret_ref.as_deref(),
            Some("platform:twitch:oauth:access")
        );
        assert_eq!(
            account.refresh_token_secret_ref.as_deref(),
            Some("platform:twitch:oauth:refresh")
        );
        assert_eq!(
            secrets,
            vec![
                (
                    "platform:twitch:oauth:access".to_string(),
                    "access-token-value".to_string()
                ),
                (
                    "platform:twitch:oauth:refresh".to_string(),
                    "refresh-token-value".to_string()
                )
            ]
        );
    }

    #[test]
    fn parses_youtube_channel_identity() {
        let profile = parse_provider_profile(
            StreamPlatform::Youtube,
            serde_json::json!({
                "items": [{
                    "id": "UC123",
                    "snippet": {
                        "title": "Videogre Channel",
                        "customUrl": "@videogre",
                        "thumbnails": {
                            "high": { "url": "https://yt.example/avatar.jpg" }
                        }
                    }
                }]
            }),
        )
        .unwrap();

        assert_eq!(profile.account_id, "UC123");
        assert_eq!(profile.account_label, "Videogre Channel");
        assert_eq!(profile.account_handle.as_deref(), Some("@videogre"));
        assert_eq!(
            profile.avatar_url.as_deref(),
            Some("https://yt.example/avatar.jpg")
        );
    }

    #[test]
    fn parses_x_user_identity() {
        let profile = parse_provider_profile(
            StreamPlatform::X,
            serde_json::json!({
                "data": {
                    "id": "x-123",
                    "name": "Videogre",
                    "username": "videogre",
                    "profile_image_url": "https://x.example/avatar.jpg"
                }
            }),
        )
        .unwrap();

        assert_eq!(profile.account_id, "x-123");
        assert_eq!(profile.account_label, "Videogre");
        assert_eq!(profile.account_handle.as_deref(), Some("@videogre"));
        assert_eq!(
            profile.avatar_url.as_deref(),
            Some("https://x.example/avatar.jpg")
        );
    }

    #[test]
    fn provider_credential_statuses_cover_native_platforms_without_secret_values() {
        let statuses = provider_credential_statuses();

        assert_eq!(statuses.len(), 3);
        assert!(
            statuses
                .iter()
                .any(|status| status.platform == StreamPlatform::Youtube && status.pkce)
        );
        assert!(
            statuses
                .iter()
                .any(|status| status.platform == StreamPlatform::Twitch && !status.pkce)
        );
        assert!(
            statuses
                .iter()
                .any(|status| status.platform == StreamPlatform::X && status.pkce)
        );
        assert!(
            statuses
                .iter()
                .all(|status| !status.message.contains("CLIENT_SECRET"))
        );
    }

    #[test]
    fn credential_source_prefers_environment_then_bundled_defaults() {
        assert_eq!(
            credential_source(Some("env-client".to_string()), Some("bundled-client")),
            OAuthCredentialSource::Environment
        );
        assert_eq!(
            credential_source(None, Some("bundled-client")),
            OAuthCredentialSource::Bundled
        );
        assert_eq!(
            credential_source(None, Some("   ")),
            OAuthCredentialSource::Missing
        );
        assert_eq!(
            credential_source(None, None),
            OAuthCredentialSource::Missing
        );
    }

    #[test]
    fn non_pkce_provider_status_requires_runtime_client_secret() {
        let status = provider_credential_status(
            StreamPlatform::Twitch,
            "VIDEORC_TEST_TWITCH_CLIENT_ID",
            "VIDEORC_TEST_TWITCH_CLIENT_SECRET",
            Some("bundled-twitch-client"),
            false,
        );

        assert!(status.client_id_present);
        assert!(!status.client_secret_present);
        assert!(!status.pkce);
        assert!(!status.ready);
        assert!(status.message.contains("client secret"));
    }

    #[test]
    fn pkce_provider_status_can_be_ready_without_client_secret() {
        let status = provider_credential_status(
            StreamPlatform::Youtube,
            "VIDEORC_TEST_YOUTUBE_CLIENT_ID",
            "VIDEORC_TEST_YOUTUBE_CLIENT_SECRET",
            Some("bundled-youtube-client"),
            true,
        );

        assert!(status.client_id_present);
        assert!(!status.client_secret_present);
        assert!(status.pkce);
        assert!(status.ready);
    }
}
