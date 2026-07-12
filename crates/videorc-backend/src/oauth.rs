use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, OwnedMutexGuard};
use uuid::Uuid;

use crate::storage::PlatformAccountWriteExpectation;
use crate::streaming::{
    PlatformAccountStatus, StreamPlatform, UpsertPlatformAccount, stream_platform_id,
    stream_platform_label,
};

const OAUTH_STATE_TTL_MINUTES: i64 = 10;
const OAUTH_PROVIDER_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const OAUTH_PROVIDER_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const BUNDLED_TWITCH_CLIENT_ID: Option<&str> = option_env!("VIDEORC_BUNDLED_TWITCH_CLIENT_ID");
const BUNDLED_YOUTUBE_CLIENT_ID: Option<&str> = option_env!("VIDEORC_BUNDLED_YOUTUBE_CLIENT_ID");
// The Videorc X OAuth app (public Native App client, PKCE — no secret involved).
// Client IDs are public identifiers; build-time/runtime env still override.
const BUNDLED_X_CLIENT_ID: Option<&str> = match option_env!("VIDEORC_BUNDLED_X_CLIENT_ID") {
    Some(bundled) => Some(bundled),
    None => Some("S0NBMDhTQll6cGp1am5HUFRySE86MTpjaQ"),
};
pub const YOUTUBE_OAUTH_UNAVAILABLE_MESSAGE: &str = "YouTube OAuth is temporarily unavailable while Videorc awaits Google approval. Use Manual RTMP for YouTube for now.";

pub fn provider_oauth_unavailable_message(platform: StreamPlatform) -> Option<&'static str> {
    match platform {
        StreamPlatform::Youtube if !youtube_oauth_enabled() => {
            Some(YOUTUBE_OAUTH_UNAVAILABLE_MESSAGE)
        }
        StreamPlatform::Twitch | StreamPlatform::X | StreamPlatform::Custom => None,
        StreamPlatform::Youtube => None,
    }
}

fn youtube_oauth_enabled() -> bool {
    optional_env("VIDEORC_ENABLE_YOUTUBE_OAUTH")
        .as_deref()
        .is_some_and(env_flag_enabled)
        || option_env!("VIDEORC_BUNDLED_YOUTUBE_OAUTH_ENABLED").is_some_and(env_flag_enabled)
}

fn env_flag_enabled(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes"
    )
}

pub fn provider_http_client() -> reqwest::Client {
    provider_http_client_with_timeout(OAUTH_PROVIDER_REQUEST_TIMEOUT)
}

fn provider_http_client_with_timeout(timeout: std::time::Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(OAUTH_PROVIDER_CONNECT_TIMEOUT.min(timeout))
        .build()
        .expect("static OAuth HTTP client configuration must be valid")
}

const LEGACY_OAUTH_PENDING_STORE_VERSION: u32 = 1;
const REFERENCE_OAUTH_PENDING_STORE_VERSION: u32 = 2;
const CANDIDATE_OAUTH_PENDING_STORE_VERSION: u32 = 3;
const OAUTH_PENDING_STORE_VERSION: u32 = 4;
const MAX_OAUTH_PENDING_STORE_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub struct OAuthSessions {
    state: Mutex<OAuthSessionState>,
    store_path: Option<PathBuf>,
    store_load_error: Option<String>,
    youtube_finalization: std::sync::Arc<Mutex<()>>,
    twitch_finalization: std::sync::Arc<Mutex<()>>,
    x_finalization: std::sync::Arc<Mutex<()>>,
    custom_finalization: std::sync::Arc<Mutex<()>>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    /// True only when the exact durable callback should be retried. Terminal
    /// denial/expiry/unknown-state results are safe for Electron to acknowledge.
    pub retryable: bool,
    pub received_at: String,
}

#[derive(Debug, Default)]
struct OAuthSessionState {
    pending: HashMap<String, PendingOAuthSession>,
    in_flight: HashSet<String>,
    recovery_drivers: HashSet<String>,
}

#[derive(Debug, Clone)]
struct PendingOAuthSession {
    platform: StreamPlatform,
    expires_at: chrono::DateTime<Utc>,
    work: PendingOAuthWork,
}

#[derive(Debug, Clone)]
enum PendingOAuthWork {
    Generic,
    ProviderExchange(PendingOAuthExchange),
    ProviderExchangeStarted(PendingOAuthTokenCheckpoint),
    ProviderToken(PendingOAuthTokenCheckpoint),
    AccountStorage {
        account: Box<UpsertPlatformAccount>,
        checkpoint_secret_ref: Option<String>,
        pkce_verifier_secret_ref: Option<String>,
        candidate_access_secret_ref: Option<String>,
        candidate_refresh_secret_ref: Option<String>,
        superseded_secret_refs: Vec<String>,
        expected_account_state: Option<PlatformAccountWriteExpectation>,
        write_generation: u64,
    },
}

impl PendingOAuthWork {
    fn is_code_less_resumable(&self) -> bool {
        matches!(
            self,
            Self::ProviderExchangeStarted(_) | Self::ProviderToken(_) | Self::AccountStorage { .. }
        )
    }

    fn is_unadvanced(&self) -> bool {
        matches!(self, Self::Generic | Self::ProviderExchange(_))
    }
}

#[derive(Debug, Clone)]
pub struct OAuthCompleteOutcome {
    pub result: OAuthCallbackResult,
    pub exchange: Option<PendingOAuthExchange>,
    pub token_checkpoint: Option<PendingOAuthTokenCheckpoint>,
    pub account_to_store: Option<UpsertPlatformAccount>,
    pub account_storage_commit: Option<PendingOAuthAccountStorageCommit>,
    pub authorization_code: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PendingOAuthAccountStorageCommit {
    pub expected_account_state: Option<PlatformAccountWriteExpectation>,
    pub write_generation: u64,
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
    pub code_verifier_secret_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingOAuthTokenCheckpoint {
    platform: StreamPlatform,
    profile_url: String,
    client_id: String,
    scopes: Vec<String>,
    secret_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pkce_verifier_secret_ref: Option<String>,
    #[serde(default)]
    candidate_access_secret_ref: String,
    #[serde(default)]
    candidate_refresh_secret_ref: String,
}

impl PendingOAuthTokenCheckpoint {
    pub fn secret_ref(&self) -> &str {
        &self.secret_ref
    }

    pub fn candidate_access_secret_ref(&self) -> &str {
        &self.candidate_access_secret_ref
    }

    pub fn candidate_refresh_secret_ref(&self) -> &str {
        &self.candidate_refresh_secret_ref
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExchangedOAuthToken {
    platform: StreamPlatform,
    access_token: String,
    refresh_token: Option<String>,
    scopes: Vec<String>,
    expires_at: Option<String>,
}

impl std::fmt::Debug for ExchangedOAuthToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExchangedOAuthToken")
            .field("platform", &self.platform)
            .field("access_token", &"[redacted]")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "[redacted]"),
            )
            .field("scopes", &self.scopes)
            .field("expires_at", &self.expires_at)
            .finish()
    }
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedOAuthStore {
    version: u32,
    sessions: Vec<PersistedOAuthSession>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedOAuthSession {
    state: String,
    platform: StreamPlatform,
    expires_at: chrono::DateTime<Utc>,
    work: PersistedOAuthWork,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum PersistedOAuthWork {
    Generic,
    ProviderExchange {
        redirect_uri: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code_verifier_secret_ref: Option<String>,
    },
    ProviderExchangeStarted {
        checkpoint: PendingOAuthTokenCheckpoint,
    },
    ProviderToken {
        checkpoint: PendingOAuthTokenCheckpoint,
    },
    AccountStorage {
        account: Box<UpsertPlatformAccount>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkpoint_secret_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pkce_verifier_secret_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        candidate_access_secret_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        candidate_refresh_secret_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        superseded_secret_refs: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_account_state: Option<PlatformAccountWriteExpectation>,
        #[serde(default)]
        write_generation: u64,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyPersistedOAuthStore {
    version: u32,
    sessions: Vec<LegacyPersistedOAuthSession>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyPersistedOAuthSession {
    state: String,
    platform: StreamPlatform,
    expires_at: chrono::DateTime<Utc>,
    work: LegacyPersistedOAuthWork,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum LegacyPersistedOAuthWork {
    Generic,
    ProviderExchange {
        redirect_uri: String,
        code_verifier: Option<String>,
    },
    ProviderExchangeStarted {
        checkpoint: PendingOAuthTokenCheckpoint,
    },
    ProviderToken {
        checkpoint: PendingOAuthTokenCheckpoint,
    },
    AccountStorage {
        account: UpsertPlatformAccount,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkpoint_secret_ref: Option<String>,
    },
}

#[derive(Deserialize)]
struct PersistedOAuthStoreVersion {
    version: u32,
}

#[cfg(test)]
impl Default for OAuthSessions {
    fn default() -> Self {
        Self::new(None)
    }
}

impl OAuthSessions {
    #[cfg(test)]
    pub fn new(store_path: Option<PathBuf>) -> Self {
        Self::new_with_secret_store(store_path, |_, _| Ok(()), |_| Ok(()))
    }

    #[cfg(test)]
    pub fn new_with_secret_cleanup<F>(store_path: Option<PathBuf>, mut delete_secret: F) -> Self
    where
        F: FnMut(&str) -> Result<()>,
    {
        Self::new_with_secret_store(store_path, |_, _| Ok(()), &mut delete_secret)
    }

    pub fn new_with_secret_store<P, D>(
        store_path: Option<PathBuf>,
        mut put_secret: P,
        mut delete_secret: D,
    ) -> Self
    where
        P: FnMut(&str, &str) -> Result<()>,
        D: FnMut(&str) -> Result<()>,
    {
        let (mut pending, store_load_error) = match store_path.as_deref() {
            Some(path) => {
                match load_pending_oauth_sessions(path, &mut put_secret, &mut delete_secret) {
                    Ok(pending) => (pending, None),
                    Err(error) => (HashMap::new(), Some(format!("{error:#}"))),
                }
            }
            None => (HashMap::new(), None),
        };
        if store_load_error.is_none()
            && let Some(path) = store_path.as_deref()
        {
            cleanup_expired_pending_sessions(path, &mut pending, &mut delete_secret);
        }
        Self {
            state: Mutex::new(OAuthSessionState {
                pending,
                in_flight: HashSet::new(),
                recovery_drivers: HashSet::new(),
            }),
            store_path,
            store_load_error,
            youtube_finalization: std::sync::Arc::new(Mutex::new(())),
            twitch_finalization: std::sync::Arc::new(Mutex::new(())),
            x_finalization: std::sync::Arc::new(Mutex::new(())),
            custom_finalization: std::sync::Arc::new(Mutex::new(())),
        }
    }

    fn persist(&self, state: &OAuthSessionState) -> Result<()> {
        self.ensure_store_available()?;
        let Some(path) = self.store_path.as_deref() else {
            return Ok(());
        };
        persist_pending_oauth_sessions(path, &state.pending)
    }

    fn ensure_store_available(&self) -> Result<()> {
        if let Some(error) = self.store_load_error.as_deref() {
            anyhow::bail!(
                "OAuth transaction storage is unavailable; the existing recovery file was preserved: {error}"
            );
        }
        Ok(())
    }

    /// Account-secret publication is a per-platform transaction. Different
    /// providers may finalize concurrently, but two reconnects for the same
    /// provider must observe and supersede credentials in database order.
    pub async fn lock_platform_finalization(
        &self,
        platform: StreamPlatform,
    ) -> OwnedMutexGuard<()> {
        let lock = match platform {
            StreamPlatform::Youtube => &self.youtube_finalization,
            StreamPlatform::Twitch => &self.twitch_finalization,
            StreamPlatform::X => &self.x_finalization,
            StreamPlatform::Custom => &self.custom_finalization,
        };
        lock.clone().lock_owned().await
    }
}

fn cleanup_expired_pending_sessions<F>(
    path: &Path,
    pending: &mut HashMap<String, PendingOAuthSession>,
    delete_secret: &mut F,
) where
    F: FnMut(&str) -> Result<()>,
{
    let now = Utc::now();
    let removable = pending
        .iter()
        .filter(|(_, session)| session.expires_at < now && session.work.is_unadvanced())
        .filter_map(|(state, session)| {
            if pending_secret_refs(&session.work)
                .iter()
                .any(|secret_ref| delete_secret(secret_ref).is_err())
            {
                return None;
            }
            Some(state.clone())
        })
        .collect::<Vec<_>>();
    if removable.is_empty() {
        return;
    }
    let removed = removable
        .into_iter()
        .filter_map(|state| pending.remove(&state).map(|session| (state, session)))
        .collect::<Vec<_>>();
    if persist_pending_oauth_sessions(path, pending).is_err() {
        pending.extend(removed);
    }
}

fn persisted_oauth_work(work: &PendingOAuthWork) -> PersistedOAuthWork {
    match work {
        PendingOAuthWork::Generic => PersistedOAuthWork::Generic,
        PendingOAuthWork::ProviderExchange(exchange) => PersistedOAuthWork::ProviderExchange {
            redirect_uri: exchange.redirect_uri.clone(),
            code_verifier_secret_ref: exchange.code_verifier_secret_ref.clone(),
        },
        PendingOAuthWork::ProviderExchangeStarted(checkpoint) => {
            PersistedOAuthWork::ProviderExchangeStarted {
                checkpoint: checkpoint.clone(),
            }
        }
        PendingOAuthWork::ProviderToken(checkpoint) => PersistedOAuthWork::ProviderToken {
            checkpoint: checkpoint.clone(),
        },
        PendingOAuthWork::AccountStorage {
            account,
            checkpoint_secret_ref,
            pkce_verifier_secret_ref,
            candidate_access_secret_ref,
            candidate_refresh_secret_ref,
            superseded_secret_refs,
            expected_account_state,
            write_generation,
        } => PersistedOAuthWork::AccountStorage {
            account: account.clone(),
            checkpoint_secret_ref: checkpoint_secret_ref.clone(),
            pkce_verifier_secret_ref: pkce_verifier_secret_ref.clone(),
            candidate_access_secret_ref: candidate_access_secret_ref.clone(),
            candidate_refresh_secret_ref: candidate_refresh_secret_ref.clone(),
            superseded_secret_refs: superseded_secret_refs.clone(),
            expected_account_state: expected_account_state.clone(),
            write_generation: *write_generation,
        },
    }
}

fn restore_oauth_work(
    callback_state: &str,
    platform: StreamPlatform,
    work: PersistedOAuthWork,
) -> Result<PendingOAuthWork> {
    Ok(match work {
        PersistedOAuthWork::Generic => PendingOAuthWork::Generic,
        PersistedOAuthWork::ProviderExchange {
            redirect_uri,
            code_verifier_secret_ref,
        } => {
            let config = provider_config(platform)?;
            validate_pkce_secret_ref(
                callback_state,
                platform,
                config.pkce,
                code_verifier_secret_ref.as_deref(),
            )?;
            PendingOAuthWork::ProviderExchange(PendingOAuthExchange {
                platform,
                token_url: config.token_url,
                profile_url: config.profile_url,
                client_id: config.client_id,
                client_secret: config.client_secret,
                redirect_uri,
                scopes: normalized_scopes(&config.scopes),
                code_verifier_secret_ref,
            })
        }
        PersistedOAuthWork::ProviderExchangeStarted { checkpoint } => {
            PendingOAuthWork::ProviderExchangeStarted(restore_token_checkpoint(
                callback_state,
                platform,
                checkpoint,
            )?)
        }
        PersistedOAuthWork::ProviderToken { checkpoint } => PendingOAuthWork::ProviderToken(
            restore_token_checkpoint(callback_state, platform, checkpoint)?,
        ),
        PersistedOAuthWork::AccountStorage {
            account,
            checkpoint_secret_ref,
            pkce_verifier_secret_ref,
            candidate_access_secret_ref,
            candidate_refresh_secret_ref,
            superseded_secret_refs,
            expected_account_state,
            write_generation,
        } => {
            if account.platform != platform {
                anyhow::bail!("Persisted OAuth account platform did not match its session.");
            }
            if checkpoint_secret_ref.as_deref().is_some_and(|secret_ref| {
                secret_ref != pending_token_secret_ref(callback_state, platform)
            }) {
                anyhow::bail!("Persisted OAuth account checkpoint reference was invalid.");
            }
            validate_optional_pkce_secret_ref(
                callback_state,
                platform,
                pkce_verifier_secret_ref.as_deref(),
            )?;
            validate_optional_candidate_secret_ref(
                callback_state,
                platform,
                CandidateSecretKind::Access,
                candidate_access_secret_ref.as_deref(),
            )?;
            validate_optional_candidate_secret_ref(
                callback_state,
                platform,
                CandidateSecretKind::Refresh,
                candidate_refresh_secret_ref.as_deref(),
            )?;
            for secret_ref in &superseded_secret_refs {
                validate_platform_oauth_secret_ref(platform, secret_ref)?;
            }
            if let Some(expected) = expected_account_state.as_ref()
                && write_generation <= expected.generation
            {
                anyhow::bail!("Persisted OAuth account write generation was invalid.");
            }
            PendingOAuthWork::AccountStorage {
                account,
                checkpoint_secret_ref,
                pkce_verifier_secret_ref,
                candidate_access_secret_ref,
                candidate_refresh_secret_ref,
                superseded_secret_refs,
                expected_account_state,
                write_generation,
            }
        }
    })
}

fn restore_persisted_sessions(
    sessions: Vec<PersistedOAuthSession>,
) -> Result<HashMap<String, PendingOAuthSession>> {
    let mut pending = HashMap::with_capacity(sessions.len());
    for session in sessions {
        if session.state.is_empty() || session.state.len() > 2048 {
            anyhow::bail!("OAuth transaction recovery store contains an invalid state.");
        }
        let work = restore_oauth_work(&session.state, session.platform, session.work)
            .context("OAuth transaction recovery store contains an invalid work checkpoint")?;
        let previous = pending.insert(
            session.state,
            PendingOAuthSession {
                platform: session.platform,
                expires_at: session.expires_at,
                work,
            },
        );
        if previous.is_some() {
            anyhow::bail!("OAuth transaction recovery store contains a duplicate state.");
        }
    }
    Ok(pending)
}

fn migrate_legacy_oauth_store<P, D>(
    path: &Path,
    store: LegacyPersistedOAuthStore,
    put_secret: &mut P,
    delete_secret: &mut D,
) -> Result<HashMap<String, PendingOAuthSession>>
where
    P: FnMut(&str, &str) -> Result<()>,
    D: FnMut(&str) -> Result<()>,
{
    if store.version != LEGACY_OAUTH_PENDING_STORE_VERSION {
        anyhow::bail!("OAuth transaction recovery store version is unsupported.");
    }
    let mut newly_protected_refs = Vec::new();
    let migration = (|| {
        let mut sessions = Vec::with_capacity(store.sessions.len());
        for session in store.sessions {
            if session.state.is_empty() || session.state.len() > 2048 {
                anyhow::bail!("OAuth transaction recovery store contains an invalid state.");
            }
            let work = match session.work {
                LegacyPersistedOAuthWork::Generic => PersistedOAuthWork::Generic,
                LegacyPersistedOAuthWork::ProviderExchange {
                    redirect_uri,
                    code_verifier,
                } => {
                    let config = provider_config(session.platform)?;
                    let code_verifier_secret_ref = match (config.pkce, code_verifier) {
                        (true, Some(verifier)) => {
                            validate_pkce_verifier(&verifier)?;
                            let secret_ref =
                                pending_pkce_verifier_secret_ref(&session.state, session.platform);
                            put_secret(&secret_ref, &verifier)
                                .context("Could not protect a migrated OAuth PKCE verifier")?;
                            newly_protected_refs.push(secret_ref.clone());
                            Some(secret_ref)
                        }
                        (true, None) => {
                            anyhow::bail!(
                                "Persisted OAuth provider exchange was missing its PKCE verifier."
                            )
                        }
                        (false, Some(_)) => {
                            anyhow::bail!(
                                "Persisted OAuth provider exchange contained an unexpected PKCE verifier."
                            )
                        }
                        (false, None) => None,
                    };
                    PersistedOAuthWork::ProviderExchange {
                        redirect_uri,
                        code_verifier_secret_ref,
                    }
                }
                LegacyPersistedOAuthWork::ProviderExchangeStarted { checkpoint } => {
                    PersistedOAuthWork::ProviderExchangeStarted { checkpoint }
                }
                LegacyPersistedOAuthWork::ProviderToken { checkpoint } => {
                    PersistedOAuthWork::ProviderToken { checkpoint }
                }
                LegacyPersistedOAuthWork::AccountStorage {
                    account,
                    checkpoint_secret_ref,
                } => PersistedOAuthWork::AccountStorage {
                    account: Box::new(account),
                    checkpoint_secret_ref,
                    pkce_verifier_secret_ref: None,
                    candidate_access_secret_ref: None,
                    candidate_refresh_secret_ref: None,
                    superseded_secret_refs: Vec::new(),
                    expected_account_state: None,
                    write_generation: 0,
                },
            };
            sessions.push(PersistedOAuthSession {
                state: session.state,
                platform: session.platform,
                expires_at: session.expires_at,
                work,
            });
        }
        let pending = restore_persisted_sessions(sessions)?;
        persist_pending_oauth_sessions(path, &pending)
            .context("Could not commit protected OAuth transaction migration")?;
        Ok(pending)
    })();
    if migration.is_err() {
        for secret_ref in newly_protected_refs.iter().rev() {
            let _ = delete_secret(secret_ref);
        }
    }
    migration
}

fn load_pending_oauth_sessions<P, D>(
    path: &Path,
    put_secret: &mut P,
    delete_secret: &mut D,
) -> Result<HashMap<String, PendingOAuthSession>>
where
    P: FnMut(&str, &str) -> Result<()>,
    D: FnMut(&str) -> Result<()>,
{
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => {
            return Err(error).context("Could not read the OAuth transaction recovery store");
        }
    };
    if bytes.is_empty() || bytes.len() > MAX_OAUTH_PENDING_STORE_BYTES {
        anyhow::bail!("OAuth transaction recovery store exceeded its size bound.");
    }
    let version = serde_json::from_slice::<PersistedOAuthStoreVersion>(&bytes)
        .context("OAuth transaction recovery store is malformed")?;
    if version.version == LEGACY_OAUTH_PENDING_STORE_VERSION {
        let legacy = serde_json::from_slice::<LegacyPersistedOAuthStore>(&bytes)
            .context("OAuth transaction recovery store is malformed")?;
        return migrate_legacy_oauth_store(path, legacy, put_secret, delete_secret);
    }
    let store = serde_json::from_slice::<PersistedOAuthStore>(&bytes)
        .context("OAuth transaction recovery store is malformed")?;
    if store.version != REFERENCE_OAUTH_PENDING_STORE_VERSION
        && store.version != CANDIDATE_OAUTH_PENDING_STORE_VERSION
        && store.version != OAUTH_PENDING_STORE_VERSION
    {
        anyhow::bail!("OAuth transaction recovery store version is unsupported.");
    }
    let pending = restore_persisted_sessions(store.sessions)?;
    if store.version < OAUTH_PENDING_STORE_VERSION {
        persist_pending_oauth_sessions(path, &pending)
            .context("Could not commit OAuth candidate-reference migration")?;
    }
    Ok(pending)
}

fn persist_pending_oauth_sessions(
    path: &Path,
    pending: &HashMap<String, PendingOAuthSession>,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| {
            format!(
                "Could not create OAuth transaction dir {}",
                parent.display()
            )
        })?;
    }
    let mut sessions = pending
        .iter()
        .map(|(state, session)| PersistedOAuthSession {
            state: state.clone(),
            platform: session.platform,
            expires_at: session.expires_at,
            work: persisted_oauth_work(&session.work),
        })
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| left.state.cmp(&right.state));
    let payload = serde_json::to_vec(&PersistedOAuthStore {
        version: OAUTH_PENDING_STORE_VERSION,
        sessions,
    })?;
    let temporary_path = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut temporary = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .with_context(|| format!("Could not create {}", temporary_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary_path, std::fs::Permissions::from_mode(0o600))?;
    }
    temporary.write_all(&payload)?;
    temporary.sync_all()?;
    drop(temporary);
    if let Err(error) = crate::atomic_file::replace_file(&temporary_path, path) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(error).with_context(|| format!("Could not commit {}", path.display()));
    }
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

impl OAuthSessions {
    pub async fn start(
        &self,
        params: OAuthStartParams,
        backend_port: u16,
    ) -> Result<OAuthStartResult> {
        self.ensure_store_available()?;
        validate_start_params(&params)?;
        let state = Uuid::new_v4().to_string();
        let redirect_uri = params
            .redirect_uri
            .clone()
            .unwrap_or_else(|| format!("http://127.0.0.1:{backend_port}/oauth/callback"));
        let expires_at = Utc::now() + Duration::minutes(OAUTH_STATE_TTL_MINUTES);
        let auth_url = authorization_url(&params, &state, &redirect_uri);

        let mut session_state = self.state.lock().await;
        session_state.pending.insert(
            state.clone(),
            PendingOAuthSession {
                platform: params.platform,
                expires_at,
                work: PendingOAuthWork::Generic,
            },
        );
        if let Err(error) = self.persist(&session_state) {
            session_state.pending.remove(&state);
            return Err(error);
        }
        drop(session_state);

        Ok(OAuthStartResult {
            platform: params.platform,
            state,
            auth_url,
            redirect_uri,
            expires_at: expires_at.to_rfc3339(),
        })
    }

    #[cfg(test)]
    pub async fn start_provider(
        &self,
        params: OAuthStartProviderParams,
        backend_port: u16,
    ) -> Result<OAuthStartResult> {
        self.start_provider_with_secret_store(params, backend_port, |_, _| Ok(()), |_| Ok(()))
            .await
    }

    pub async fn start_provider_with_secret_store<P, D>(
        &self,
        params: OAuthStartProviderParams,
        backend_port: u16,
        mut put_secret: P,
        _delete_secret: D,
    ) -> Result<OAuthStartResult>
    where
        P: FnMut(&str, &str) -> Result<()>,
        D: FnMut(&str) -> Result<()>,
    {
        self.ensure_store_available()?;
        if matches!(params.platform, StreamPlatform::Custom) {
            anyhow::bail!("Custom RTMP does not support OAuth.");
        }
        if let Some(message) = provider_oauth_unavailable_message(params.platform) {
            anyhow::bail!("{message}");
        }
        let config = provider_config(params.platform)?;
        let state = Uuid::new_v4().to_string();
        let redirect_uri = provider_redirect_uri(
            params.platform,
            params.redirect_uri.as_deref(),
            backend_port,
        )?;
        let expires_at = Utc::now() + Duration::minutes(OAUTH_STATE_TTL_MINUTES);
        let mut extra_params = config.extra_params.clone();
        let mut code_verifier = None;
        let code_verifier_secret_ref = if config.pkce {
            let verifier = pkce_verifier();
            extra_params.insert("code_challenge".to_string(), pkce_s256_challenge(&verifier));
            extra_params.insert("code_challenge_method".to_string(), "S256".to_string());
            let secret_ref = pending_pkce_verifier_secret_ref(&state, params.platform);
            code_verifier = Some(verifier);
            Some(secret_ref)
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

        let mut session_state = self.state.lock().await;
        session_state.pending.insert(
            state.clone(),
            PendingOAuthSession {
                platform: params.platform,
                expires_at,
                work: PendingOAuthWork::ProviderExchange(PendingOAuthExchange {
                    platform: params.platform,
                    token_url: config.token_url,
                    profile_url: config.profile_url,
                    client_id: config.client_id,
                    client_secret: config.client_secret,
                    redirect_uri: redirect_uri.clone(),
                    scopes: normalized_scopes(&config.scopes),
                    code_verifier_secret_ref: code_verifier_secret_ref.clone(),
                }),
            },
        );
        if let Err(error) = self.persist(&session_state) {
            session_state.pending.remove(&state);
            return Err(error);
        }
        drop(session_state);

        // Persist ownership before writing the verifier. If the secret-store
        // write partially commits and reports an error, the durable transaction
        // still owns the exact reference and maintenance can retry its cleanup.
        if let (Some(secret_ref), Some(verifier)) = (
            code_verifier_secret_ref.as_deref(),
            code_verifier.as_deref(),
        ) {
            put_secret(secret_ref, verifier)
                .context("Could not protect the pending OAuth PKCE verifier")?;
        }

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
        let state = params.state.clone();
        let result = self.complete_with_pending(params).await.result;
        if !result.retryable {
            self.finish(&state).await.unwrap();
        }
        result
    }

    pub async fn complete_with_pending(&self, params: OAuthCompleteParams) -> OAuthCompleteOutcome {
        let received_at = Utc::now();
        if let Err(error) = self.ensure_store_available() {
            return OAuthCompleteOutcome {
                result: OAuthCallbackResult {
                    platform: None,
                    state: params.state,
                    status: OAuthCallbackStatus::Failed,
                    code_present: params.code.as_ref().is_some_and(|code| !code.is_empty()),
                    error: None,
                    message: Some(error.to_string()),
                    token_stored: false,
                    account_connected: false,
                    retryable: true,
                    received_at: received_at.to_rfc3339(),
                },
                exchange: None,
                token_checkpoint: None,
                account_to_store: None,
                account_storage_commit: None,
                authorization_code: None,
            };
        }
        let mut session_state = self.state.lock().await;
        let Some(pending) = session_state.pending.get(&params.state).cloned() else {
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
                    retryable: false,
                    received_at: received_at.to_rfc3339(),
                },
                exchange: None,
                token_checkpoint: None,
                account_to_store: None,
                account_storage_commit: None,
                authorization_code: None,
            };
        };

        let code_present = params.code.as_ref().is_some_and(|code| !code.is_empty());
        if session_state.in_flight.contains(&params.state) {
            return OAuthCompleteOutcome {
                result: OAuthCallbackResult {
                    platform: Some(pending.platform),
                    state: params.state,
                    status: OAuthCallbackStatus::Failed,
                    code_present,
                    error: None,
                    message: Some("OAuth callback completion is already in progress.".to_string()),
                    token_stored: false,
                    account_connected: false,
                    retryable: true,
                    received_at: received_at.to_rfc3339(),
                },
                exchange: None,
                token_checkpoint: None,
                account_to_store: None,
                account_storage_commit: None,
                authorization_code: None,
            };
        }

        if pending.expires_at < received_at && pending.work.is_unadvanced() {
            session_state.in_flight.insert(params.state.clone());
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
                    retryable: false,
                    received_at: received_at.to_rfc3339(),
                },
                exchange: None,
                token_checkpoint: None,
                account_to_store: None,
                account_storage_commit: None,
                authorization_code: None,
            };
        }

        let code_less_resume = pending.work.is_code_less_resumable();
        // Once the provider code has been consumed, later callback deliveries
        // (including stale denial/error URLs) are no longer authoritative. The
        // durable checkpoint must reconcile code-less until it is committed.
        let failed = !code_less_resume && (params.error.is_some() || !code_present);
        session_state.in_flight.insert(params.state.clone());
        let status = if failed {
            OAuthCallbackStatus::Failed
        } else {
            OAuthCallbackStatus::Success
        };
        let authorization_code = (!failed
            && matches!(&pending.work, PendingOAuthWork::ProviderExchange(_)))
        .then_some(params.code)
        .flatten();
        let (exchange, token_checkpoint, account_to_store, account_storage_commit) = if failed {
            (None, None, None, None)
        } else {
            match pending.work {
                PendingOAuthWork::Generic => (None, None, None, None),
                PendingOAuthWork::ProviderExchange(exchange) => (Some(exchange), None, None, None),
                PendingOAuthWork::ProviderExchangeStarted(checkpoint)
                | PendingOAuthWork::ProviderToken(checkpoint) => {
                    (None, Some(checkpoint), None, None)
                }
                PendingOAuthWork::AccountStorage {
                    account,
                    expected_account_state,
                    write_generation,
                    ..
                } => (
                    None,
                    None,
                    Some(*account),
                    Some(PendingOAuthAccountStorageCommit {
                        expected_account_state,
                        write_generation,
                    }),
                ),
            }
        };
        OAuthCompleteOutcome {
            result: OAuthCallbackResult {
                platform: Some(pending.platform),
                state: params.state,
                status,
                code_present,
                error: (!code_less_resume).then_some(params.error).flatten(),
                message: (!code_less_resume)
                    .then_some(params.error_description)
                    .flatten()
                    .or_else(|| {
                        (failed && !code_present)
                            .then(|| "OAuth callback did not include a code.".to_string())
                    }),
                token_stored: false,
                account_connected: false,
                retryable: false,
                received_at: received_at.to_rfc3339(),
            },
            exchange,
            token_checkpoint,
            account_to_store,
            account_storage_commit,
            authorization_code,
        }
    }

    /// Commits the point of no return before an authorization code is posted to
    /// the provider. A restarted backend may recover a protected token
    /// checkpoint from this predeclared reference, but it must never post the
    /// same single-use code again when the checkpoint is absent.
    pub async fn stage_exchange_started(
        &self,
        callback_state: &str,
    ) -> Result<PendingOAuthTokenCheckpoint> {
        let mut session_state = self.state.lock().await;
        let current_work = session_state
            .pending
            .get(callback_state)
            .map(|pending| pending.work.clone())
            .with_context(|| "OAuth callback state disappeared before token exchange.")?;
        let (checkpoint, previous_work) = match current_work {
            PendingOAuthWork::ProviderExchange(exchange) => (
                pending_token_checkpoint(callback_state, &exchange),
                PendingOAuthWork::ProviderExchange(exchange),
            ),
            PendingOAuthWork::ProviderExchangeStarted(checkpoint)
            | PendingOAuthWork::ProviderToken(checkpoint) => return Ok(checkpoint),
            PendingOAuthWork::Generic | PendingOAuthWork::AccountStorage { .. } => {
                anyhow::bail!("OAuth callback is not waiting for a provider token exchange.")
            }
        };
        session_state
            .pending
            .get_mut(callback_state)
            .expect("pending OAuth session was just read")
            .work = PendingOAuthWork::ProviderExchangeStarted(checkpoint.clone());
        if let Err(error) = self.persist(&session_state) {
            session_state
                .pending
                .get_mut(callback_state)
                .expect("pending OAuth session was just read")
                .work = previous_work;
            return Err(error);
        }
        Ok(checkpoint)
    }

    /// Stores the raw token response only in the protected secret store, then
    /// advances the transaction file to a reference-only recovery checkpoint.
    /// If the second persistence step fails, retain the in-memory checkpoint;
    /// the on-disk ExchangeStarted state can discover the already-written
    /// secret through the same predeclared reference after a cold restart.
    pub async fn stage_exchanged_token<F>(
        &self,
        callback_state: &str,
        token: ExchangedOAuthToken,
        mut put_secret: F,
    ) -> Result<PendingOAuthTokenCheckpoint>
    where
        F: FnMut(&str, &str) -> Result<()>,
    {
        let mut session_state = self.state.lock().await;
        let checkpoint = match session_state
            .pending
            .get(callback_state)
            .map(|pending| pending.work.clone())
            .with_context(|| "OAuth callback state disappeared after token exchange.")?
        {
            PendingOAuthWork::ProviderExchangeStarted(checkpoint)
            | PendingOAuthWork::ProviderToken(checkpoint) => checkpoint,
            PendingOAuthWork::ProviderExchange(_)
            | PendingOAuthWork::Generic
            | PendingOAuthWork::AccountStorage { .. } => {
                anyhow::bail!("OAuth token exchange was not durably admitted.")
            }
        };
        validate_exchanged_token(&checkpoint, &token)?;
        let payload = serde_json::to_string(&token)
            .context("Could not encode protected OAuth token checkpoint")?;
        put_secret(checkpoint.secret_ref(), &payload)
            .context("Could not store protected OAuth token checkpoint")?;
        session_state
            .pending
            .get_mut(callback_state)
            .expect("pending OAuth session was just read")
            .work = PendingOAuthWork::ProviderToken(checkpoint.clone());
        self.persist(&session_state)?;
        Ok(checkpoint)
    }

    #[cfg(test)]
    pub async fn stage_account_storage(
        &self,
        state: &str,
        account: UpsertPlatformAccount,
    ) -> Result<()> {
        self.stage_account_storage_with_checkpoint(
            state,
            account,
            None,
            Vec::new(),
            PlatformAccountWriteExpectation::absent(0),
        )
        .await
        .map(|_| ())
    }

    pub async fn stage_account_storage_with_checkpoint(
        &self,
        state: &str,
        account: UpsertPlatformAccount,
        checkpoint: Option<&PendingOAuthTokenCheckpoint>,
        superseded_secret_refs: Vec<String>,
        mut expected_account_state: PlatformAccountWriteExpectation,
    ) -> Result<PendingOAuthAccountStorageCommit> {
        let mut session_state = self.state.lock().await;
        for (pending_state, pending) in &session_state.pending {
            if pending_state == state || pending.platform != account.platform {
                continue;
            }
            if let PendingOAuthWork::AccountStorage {
                account: predecessor,
                write_generation,
                ..
            } = &pending.work
                && *write_generation > expected_account_state.generation
            {
                expected_account_state =
                    PlatformAccountWriteExpectation::for_account(predecessor, *write_generation);
            }
        }
        let write_generation = expected_account_state.generation.saturating_add(1);
        let pending = session_state
            .pending
            .get_mut(state)
            .with_context(|| "OAuth callback state disappeared before account storage.")?;
        let previous_work = pending.work.clone();
        for secret_ref in &superseded_secret_refs {
            validate_platform_oauth_secret_ref(account.platform, secret_ref)?;
        }
        pending.work = PendingOAuthWork::AccountStorage {
            account: Box::new(account),
            checkpoint_secret_ref: checkpoint.map(|checkpoint| checkpoint.secret_ref.clone()),
            pkce_verifier_secret_ref: checkpoint
                .and_then(|checkpoint| checkpoint.pkce_verifier_secret_ref.clone()),
            candidate_access_secret_ref: checkpoint
                .map(|checkpoint| checkpoint.candidate_access_secret_ref.clone()),
            candidate_refresh_secret_ref: checkpoint
                .map(|checkpoint| checkpoint.candidate_refresh_secret_ref.clone()),
            superseded_secret_refs,
            expected_account_state: Some(expected_account_state.clone()),
            write_generation,
        };
        if let Err(error) = self.persist(&session_state) {
            if let Some(pending) = session_state.pending.get_mut(state) {
                pending.work = previous_work;
            }
            return Err(error);
        }
        Ok(PendingOAuthAccountStorageCommit {
            expected_account_state: Some(expected_account_state),
            write_generation,
        })
    }

    pub async fn retry(&self, state: &str) -> Result<()> {
        let mut session_state = self.state.lock().await;
        session_state.in_flight.remove(state);
        Ok(())
    }

    pub async fn can_resume_without_code(&self, state: &str) -> Result<bool> {
        self.ensure_store_available()?;
        let session_state = self.state.lock().await;
        Ok(session_state.pending.get(state).is_some_and(|pending| {
            pending.work.is_code_less_resumable() && !session_state.in_flight.contains(state)
        }))
    }

    pub async fn pending_retry_window(&self, state: &str) -> Result<Option<std::time::Duration>> {
        self.ensure_store_available()?;
        let session_state = self.state.lock().await;
        let Some(pending) = session_state.pending.get(state) else {
            return Ok(None);
        };
        let remaining = pending.expires_at.signed_duration_since(Utc::now());
        Ok(Some(if remaining <= Duration::zero() {
            std::time::Duration::ZERO
        } else {
            remaining
                .to_std()
                .context("OAuth retry window exceeded its supported duration")?
        }))
    }

    #[cfg(test)]
    pub async fn resumable_provider_states(&self) -> Result<Vec<String>> {
        self.ensure_store_available()?;
        let session_state = self.state.lock().await;
        let mut states = session_state
            .pending
            .iter()
            .filter(|(state, pending)| {
                pending.work.is_code_less_resumable()
                    && !session_state.in_flight.contains(*state)
                    && !session_state.recovery_drivers.contains(*state)
            })
            .map(|(state, _)| state.clone())
            .collect::<Vec<_>>();
        states.sort();
        Ok(states)
    }

    /// Retries live cleanup for abandoned, unadvanced transactions and claims
    /// every durable advanced transaction for code-less reconciliation. The
    /// supplied clock keeps expiry behavior deterministic in regression tests.
    pub async fn maintain_pending<F>(
        &self,
        now: chrono::DateTime<Utc>,
        mut delete_secret: F,
    ) -> Result<Vec<String>>
    where
        F: FnMut(&str) -> Result<()>,
    {
        self.ensure_store_available()?;
        let mut session_state = self.state.lock().await;
        let removable = session_state
            .pending
            .iter()
            .filter(|(state, pending)| {
                pending.expires_at < now
                    && pending.work.is_unadvanced()
                    && !session_state.in_flight.contains(*state)
            })
            .filter(|(_, pending)| {
                pending_secret_refs(&pending.work)
                    .iter()
                    .all(|secret_ref| delete_secret(secret_ref).is_ok())
            })
            .map(|(state, _)| state.clone())
            .collect::<Vec<_>>();
        let removed = removable
            .into_iter()
            .filter_map(|state| {
                session_state
                    .pending
                    .remove(&state)
                    .map(|pending| (state, pending))
            })
            .collect::<Vec<_>>();
        if !removed.is_empty()
            && let Err(error) = self.persist(&session_state)
        {
            session_state.pending.extend(removed);
            return Err(error);
        }

        let mut states = session_state
            .pending
            .iter()
            .filter(|(state, pending)| {
                pending.work.is_code_less_resumable()
                    && !session_state.in_flight.contains(*state)
                    && !session_state.recovery_drivers.contains(*state)
            })
            .map(|(state, _)| state.clone())
            .collect::<Vec<_>>();
        states.sort();
        session_state
            .recovery_drivers
            .extend(states.iter().cloned());
        Ok(states)
    }

    pub async fn release_recovery_driver(&self, state: &str) {
        self.state.lock().await.recovery_drivers.remove(state);
    }

    pub async fn highest_pending_account_write_generation(&self, platform: StreamPlatform) -> u64 {
        self.state
            .lock()
            .await
            .pending
            .values()
            .filter(|pending| pending.platform == platform)
            .filter_map(|pending| match &pending.work {
                PendingOAuthWork::AccountStorage {
                    write_generation, ..
                } => Some(*write_generation),
                _ => None,
            })
            .max()
            .unwrap_or(0)
    }

    pub async fn finish(&self, state: &str) -> Result<()> {
        let mut session_state = self.state.lock().await;
        session_state.in_flight.remove(state);
        session_state.recovery_drivers.remove(state);
        let removed = session_state.pending.remove(state);
        if let Err(error) = self.persist(&session_state) {
            if let Some(pending) = removed {
                session_state.pending.insert(state.to_string(), pending);
            }
            return Err(error);
        }
        Ok(())
    }

    pub async fn finish_with_secret_cleanup<F>(
        &self,
        state: &str,
        mut delete_secret: F,
    ) -> Result<()>
    where
        F: FnMut(&str) -> Result<()>,
    {
        let pending_secret_refs = {
            let session_state = self.state.lock().await;
            session_state
                .pending
                .get(state)
                .map(|pending| pending_secret_refs(&pending.work))
                .unwrap_or_default()
        };
        for secret_ref in pending_secret_refs {
            if let Err(error) = delete_secret(&secret_ref) {
                self.retry(state).await?;
                return Err(error).context("Could not delete protected OAuth recovery secret");
            }
        }
        self.finish(state).await
    }

    pub async fn finish_superseded_account_storage_with_secret_cleanup<F>(
        &self,
        state: &str,
        current_account_state: &PlatformAccountWriteExpectation,
        mut delete_secret: F,
    ) -> Result<()>
    where
        F: FnMut(&str) -> Result<()>,
    {
        let protected = current_account_state.secret_refs().collect::<HashSet<_>>();
        let secret_refs = {
            let session_state = self.state.lock().await;
            session_state
                .pending
                .get(state)
                .map(|pending| superseded_account_storage_secret_refs(&pending.work))
                .unwrap_or_default()
        };
        for secret_ref in secret_refs {
            if protected.contains(secret_ref.as_str()) {
                continue;
            }
            if let Err(error) = delete_secret(&secret_ref) {
                self.retry(state).await?;
                return Err(error).context("Could not delete superseded OAuth transaction secret");
            }
        }
        self.finish(state).await
    }
}

fn pending_token_checkpoint(
    callback_state: &str,
    exchange: &PendingOAuthExchange,
) -> PendingOAuthTokenCheckpoint {
    PendingOAuthTokenCheckpoint {
        platform: exchange.platform,
        profile_url: exchange.profile_url.clone(),
        client_id: exchange.client_id.clone(),
        scopes: exchange.scopes.clone(),
        secret_ref: pending_token_secret_ref(callback_state, exchange.platform),
        pkce_verifier_secret_ref: exchange.code_verifier_secret_ref.clone(),
        candidate_access_secret_ref: pending_candidate_secret_ref(
            callback_state,
            exchange.platform,
            CandidateSecretKind::Access,
        ),
        candidate_refresh_secret_ref: pending_candidate_secret_ref(
            callback_state,
            exchange.platform,
            CandidateSecretKind::Refresh,
        ),
    }
}

fn pending_token_secret_ref(callback_state: &str, platform: StreamPlatform) -> String {
    let state_digest = URL_SAFE_NO_PAD.encode(Sha256::digest(callback_state.as_bytes()));
    format!(
        "platform:{}:oauth:pending:{state_digest}",
        stream_platform_id(platform)
    )
}

fn pending_pkce_verifier_secret_ref(callback_state: &str, platform: StreamPlatform) -> String {
    let state_digest = URL_SAFE_NO_PAD.encode(Sha256::digest(callback_state.as_bytes()));
    format!(
        "platform:{}:oauth:pending-pkce:{state_digest}",
        stream_platform_id(platform)
    )
}

#[derive(Debug, Clone, Copy)]
enum CandidateSecretKind {
    Access,
    Refresh,
}

impl CandidateSecretKind {
    fn suffix(self) -> &'static str {
        match self {
            Self::Access => "access",
            Self::Refresh => "refresh",
        }
    }
}

fn pending_candidate_secret_ref(
    callback_state: &str,
    platform: StreamPlatform,
    kind: CandidateSecretKind,
) -> String {
    let state_digest = URL_SAFE_NO_PAD.encode(Sha256::digest(callback_state.as_bytes()));
    format!(
        "platform:{}:oauth:candidate:{state_digest}:{}",
        stream_platform_id(platform),
        kind.suffix()
    )
}

fn validate_optional_candidate_secret_ref(
    callback_state: &str,
    platform: StreamPlatform,
    kind: CandidateSecretKind,
    secret_ref: Option<&str>,
) -> Result<()> {
    if secret_ref.is_some_and(|secret_ref| {
        secret_ref != pending_candidate_secret_ref(callback_state, platform, kind)
    }) {
        anyhow::bail!("Persisted OAuth candidate secret reference was invalid.");
    }
    Ok(())
}

fn validate_platform_oauth_secret_ref(platform: StreamPlatform, secret_ref: &str) -> Result<()> {
    let prefix = format!("platform:{}:oauth:", stream_platform_id(platform));
    let Some(suffix) = secret_ref.strip_prefix(&prefix) else {
        anyhow::bail!("Persisted OAuth superseded secret reference targeted another platform.");
    };
    let valid = matches!(suffix, "access" | "refresh")
        || suffix.strip_prefix("candidate:").is_some_and(|candidate| {
            let Some((digest, kind)) = candidate.rsplit_once(':') else {
                return false;
            };
            matches!(kind, "access" | "refresh")
                && digest.len() == 43
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        });
    if !valid {
        anyhow::bail!("Persisted OAuth superseded secret reference was invalid.");
    }
    Ok(())
}

fn validate_pkce_verifier(verifier: &str) -> Result<()> {
    // New verifiers are RFC 7636's minimum 43 characters. Accept the previous
    // 40-character `videorc-<uuid>` shape during recovery so an in-progress
    // authorization can be migrated instead of stranded.
    if !(40..=128).contains(&verifier.len())
        || !verifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~'))
    {
        anyhow::bail!("Protected OAuth PKCE verifier was invalid.");
    }
    Ok(())
}

fn validate_optional_pkce_secret_ref(
    callback_state: &str,
    platform: StreamPlatform,
    secret_ref: Option<&str>,
) -> Result<()> {
    if secret_ref.is_some_and(|secret_ref| {
        secret_ref != pending_pkce_verifier_secret_ref(callback_state, platform)
    }) {
        anyhow::bail!("Persisted OAuth PKCE verifier reference was invalid.");
    }
    Ok(())
}

fn validate_pkce_secret_ref(
    callback_state: &str,
    platform: StreamPlatform,
    pkce_required: bool,
    secret_ref: Option<&str>,
) -> Result<()> {
    validate_optional_pkce_secret_ref(callback_state, platform, secret_ref)?;
    if pkce_required != secret_ref.is_some() {
        anyhow::bail!("Persisted OAuth PKCE verifier reference did not match its provider.");
    }
    Ok(())
}

fn restore_token_checkpoint(
    callback_state: &str,
    platform: StreamPlatform,
    mut checkpoint: PendingOAuthTokenCheckpoint,
) -> Result<PendingOAuthTokenCheckpoint> {
    if checkpoint.platform != platform
        || checkpoint.secret_ref != pending_token_secret_ref(callback_state, platform)
    {
        anyhow::bail!("Persisted OAuth token checkpoint did not match its session.");
    }
    let config = provider_config(platform)?;
    validate_optional_pkce_secret_ref(
        callback_state,
        platform,
        checkpoint.pkce_verifier_secret_ref.as_deref(),
    )?;
    let expected_access =
        pending_candidate_secret_ref(callback_state, platform, CandidateSecretKind::Access);
    if checkpoint.candidate_access_secret_ref.is_empty() {
        checkpoint.candidate_access_secret_ref = expected_access;
    } else if checkpoint.candidate_access_secret_ref != expected_access {
        anyhow::bail!("Persisted OAuth access candidate did not match its session.");
    }
    let expected_refresh =
        pending_candidate_secret_ref(callback_state, platform, CandidateSecretKind::Refresh);
    if checkpoint.candidate_refresh_secret_ref.is_empty() {
        checkpoint.candidate_refresh_secret_ref = expected_refresh;
    } else if checkpoint.candidate_refresh_secret_ref != expected_refresh {
        anyhow::bail!("Persisted OAuth refresh candidate did not match its session.");
    }
    checkpoint.profile_url = config.profile_url;
    checkpoint.client_id = config.client_id;
    checkpoint.scopes = normalized_scopes(&config.scopes);
    Ok(checkpoint)
}

pub fn recover_pkce_verifier<F>(
    exchange: &PendingOAuthExchange,
    mut get_secret: F,
) -> Result<Option<String>>
where
    F: FnMut(&str) -> Result<Option<String>>,
{
    let Some(secret_ref) = exchange.code_verifier_secret_ref.as_deref() else {
        return Ok(None);
    };
    let verifier =
        get_secret(secret_ref)?.with_context(|| "Protected OAuth PKCE verifier is missing.")?;
    validate_pkce_verifier(&verifier)?;
    Ok(Some(verifier))
}

fn pending_secret_refs(work: &PendingOAuthWork) -> Vec<String> {
    match work {
        PendingOAuthWork::ProviderExchange(exchange) => {
            exchange.code_verifier_secret_ref.iter().cloned().collect()
        }
        PendingOAuthWork::ProviderExchangeStarted(checkpoint)
        | PendingOAuthWork::ProviderToken(checkpoint) => {
            let mut refs = vec![
                checkpoint.secret_ref().to_string(),
                checkpoint.candidate_access_secret_ref().to_string(),
                checkpoint.candidate_refresh_secret_ref().to_string(),
            ];
            if let Some(secret_ref) = checkpoint.pkce_verifier_secret_ref.as_ref() {
                refs.push(secret_ref.clone());
            }
            refs
        }
        PendingOAuthWork::AccountStorage {
            account,
            checkpoint_secret_ref,
            pkce_verifier_secret_ref,
            candidate_access_secret_ref,
            candidate_refresh_secret_ref,
            superseded_secret_refs,
            ..
        } => {
            let committed = [
                account.token_secret_ref.as_deref(),
                account.refresh_token_secret_ref.as_deref(),
            ];
            checkpoint_secret_ref
                .iter()
                .chain(pkce_verifier_secret_ref.iter())
                .chain(candidate_access_secret_ref.iter())
                .chain(candidate_refresh_secret_ref.iter())
                .chain(superseded_secret_refs.iter())
                .filter(|secret_ref| {
                    !committed
                        .iter()
                        .flatten()
                        .any(|committed| *committed == secret_ref.as_str())
                })
                .cloned()
                .collect::<HashSet<_>>()
                .into_iter()
                .collect()
        }
        PendingOAuthWork::Generic => Vec::new(),
    }
}

fn superseded_account_storage_secret_refs(work: &PendingOAuthWork) -> Vec<String> {
    let PendingOAuthWork::AccountStorage {
        account,
        checkpoint_secret_ref,
        pkce_verifier_secret_ref,
        candidate_access_secret_ref,
        candidate_refresh_secret_ref,
        superseded_secret_refs,
        ..
    } = work
    else {
        return pending_secret_refs(work);
    };
    checkpoint_secret_ref
        .iter()
        .chain(pkce_verifier_secret_ref.iter())
        .chain(candidate_access_secret_ref.iter())
        .chain(candidate_refresh_secret_ref.iter())
        .chain(superseded_secret_refs.iter())
        .chain(account.token_secret_ref.iter())
        .chain(account.refresh_token_secret_ref.iter())
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect()
}

fn validate_exchanged_token(
    checkpoint: &PendingOAuthTokenCheckpoint,
    token: &ExchangedOAuthToken,
) -> Result<()> {
    if token.platform != checkpoint.platform {
        anyhow::bail!("OAuth token platform did not match its pending transaction.");
    }
    if token.access_token.trim().is_empty() || token.access_token.len() > 32_768 {
        anyhow::bail!("OAuth token checkpoint had an invalid access token.");
    }
    if token
        .refresh_token
        .as_ref()
        .is_some_and(|value| value.len() > 32_768)
        || token.scopes.len() > 128
        || token.scopes.iter().any(|scope| scope.len() > 512)
    {
        anyhow::bail!("OAuth token checkpoint exceeded its structural bounds.");
    }
    Ok(())
}

pub fn recover_exchanged_token<F>(
    checkpoint: &PendingOAuthTokenCheckpoint,
    mut get_secret: F,
) -> Result<ExchangedOAuthToken>
where
    F: FnMut(&str) -> Result<Option<String>>,
{
    let payload = get_secret(checkpoint.secret_ref())?
        .with_context(|| "Protected OAuth token checkpoint is missing.")?;
    if payload.len() > 70_000 {
        anyhow::bail!("Protected OAuth token checkpoint exceeded its size bound.");
    }
    let token = serde_json::from_str::<ExchangedOAuthToken>(&payload)
        .context("Protected OAuth token checkpoint is malformed")?;
    validate_exchanged_token(checkpoint, &token)?;
    Ok(token)
}

pub async fn exchange_authorization_code(
    exchange: &PendingOAuthExchange,
    authorization_code: &str,
    code_verifier: Option<&str>,
    client: &reqwest::Client,
) -> Result<ExchangedOAuthToken> {
    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", authorization_code.to_string()),
        ("redirect_uri", exchange.redirect_uri.clone()),
        ("client_id", exchange.client_id.clone()),
    ];
    if let Some(client_secret) = exchange.client_secret.as_ref() {
        form.push(("client_secret", client_secret.clone()));
    }
    if exchange.code_verifier_secret_ref.is_some() != code_verifier.is_some() {
        anyhow::bail!("OAuth PKCE verifier availability did not match its provider exchange.");
    }
    if let Some(code_verifier) = code_verifier {
        validate_pkce_verifier(code_verifier)?;
        form.push(("code_verifier", code_verifier.to_string()));
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
    let scopes = token
        .scopes()
        .filter(|scopes| !scopes.is_empty())
        .unwrap_or_else(|| exchange.scopes.clone());
    let expires_at = token
        .expires_in
        .and_then(|seconds| Utc::now().checked_add_signed(Duration::seconds(seconds)))
        .map(|expires_at| expires_at.to_rfc3339());
    Ok(ExchangedOAuthToken {
        platform: exchange.platform,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        scopes,
        expires_at,
    })
}

pub async fn account_from_exchanged_token<F>(
    checkpoint: &PendingOAuthTokenCheckpoint,
    token: &ExchangedOAuthToken,
    client: &reqwest::Client,
    mut put_secrets: F,
) -> Result<UpsertPlatformAccount>
where
    F: FnMut(&[(&str, &str)]) -> Result<()>,
{
    validate_exchanged_token(checkpoint, token)?;
    let profile = fetch_provider_profile(
        checkpoint.platform,
        &checkpoint.profile_url,
        &checkpoint.client_id,
        &token.access_token,
        client,
    )
    .await?;

    let access_ref = checkpoint.candidate_access_secret_ref.clone();
    let refresh_token = token
        .refresh_token
        .as_deref()
        .filter(|refresh_token| !refresh_token.trim().is_empty());
    let mut entries = vec![(access_ref.as_str(), token.access_token.as_str())];
    if let Some(refresh_token) = refresh_token {
        entries.push((
            checkpoint.candidate_refresh_secret_ref.as_str(),
            refresh_token,
        ));
    }
    put_secrets(&entries).context("Could not atomically store OAuth credential candidates")?;
    let refresh_ref = refresh_token.map(|_| checkpoint.candidate_refresh_secret_ref.clone());
    Ok(UpsertPlatformAccount {
        platform: checkpoint.platform,
        account_id: profile.account_id,
        account_label: profile.account_label,
        account_handle: profile.account_handle,
        avatar_url: profile.avatar_url,
        scopes: token.scopes.clone(),
        token_secret_ref: Some(access_ref),
        refresh_token_secret_ref: refresh_ref,
        stream_key_secret_ref: None,
        expires_at: token.expires_at.clone(),
        status: PlatformAccountStatus::Connected,
    })
}

#[cfg(test)]
pub async fn exchange_and_store_token<F>(
    exchange: &PendingOAuthExchange,
    authorization_code: &str,
    code_verifier: Option<&str>,
    client: &reqwest::Client,
    put_secrets: F,
) -> Result<UpsertPlatformAccount>
where
    F: FnMut(&[(&str, &str)]) -> Result<()>,
{
    let token =
        exchange_authorization_code(exchange, authorization_code, code_verifier, client).await?;
    let checkpoint = pending_token_checkpoint("compatibility-wrapper", exchange);
    account_from_exchanged_token(&checkpoint, &token, client, put_secrets).await
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
        let body = response.text().await.unwrap_or_default();
        if let Some(detail) = oauth_token_error_detail(&body) {
            anyhow::bail!(
                "{} token refresh failed with HTTP {status}: {detail}",
                stream_platform_label(platform)
            );
        } else {
            anyhow::bail!(
                "{} token refresh failed with HTTP {status}",
                stream_platform_label(platform)
            );
        }
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
        let body = response.text().await.unwrap_or_default();
        if let Some(detail) = provider_error_detail(&body) {
            anyhow::bail!(
                "{} profile lookup failed with HTTP {status}: {detail}",
                stream_platform_label(platform)
            );
        } else {
            anyhow::bail!(
                "{} profile lookup failed with HTTP {status}",
                stream_platform_label(platform)
            );
        }
    }
    let value = response
        .json::<serde_json::Value>()
        .await
        .context("Could not parse OAuth profile response")?;
    parse_provider_profile(platform, value)
}

fn provider_error_detail(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let error = value.get("error")?;
    let message = error
        .get("message")
        .and_then(|message| message.as_str())
        .map(str::trim)
        .filter(|message| !message.is_empty());
    let reason = error
        .get("errors")
        .and_then(|errors| errors.as_array())
        .and_then(|errors| errors.first())
        .and_then(|error| error.get("reason"))
        .and_then(|reason| reason.as_str())
        .map(str::trim)
        .filter(|reason| !reason.is_empty());

    match (reason, message) {
        (Some(reason), Some(message)) => Some(format!("{reason}: {message}")),
        (Some(reason), None) => Some(reason.to_string()),
        (None, Some(message)) => Some(message.to_string()),
        (None, None) => None,
    }
}

fn oauth_token_error_detail(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let error = value
        .get("error")
        .and_then(|error| error.as_str())
        .map(str::trim)
        .filter(|error| !error.is_empty());
    let description = value
        .get("error_description")
        .and_then(|description| description.as_str())
        .map(str::trim)
        .filter(|description| !description.is_empty());

    match (error, description) {
        (Some(error), Some(description)) => Some(format!("{error}: {description}")),
        (Some(error), None) => Some(error.to_string()),
        (None, Some(description)) => Some(description.to_string()),
        (None, None) => None,
    }
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
        StreamPlatform::Youtube => {
            if let Some(message) = provider_oauth_unavailable_message(platform) {
                anyhow::bail!("{message}");
            }
            Ok(youtube_provider_config(required_credential(
                "VIDEORC_YOUTUBE_CLIENT_ID",
                BUNDLED_YOUTUBE_CLIENT_ID,
            )?))
        }
        StreamPlatform::Twitch => Ok(OAuthProviderConfig {
            authorization_url: "https://id.twitch.tv/oauth2/authorize".to_string(),
            token_url: "https://id.twitch.tv/oauth2/token".to_string(),
            profile_url: "https://api.twitch.tv/helix/users".to_string(),
            client_id: required_credential("VIDEORC_TWITCH_CLIENT_ID", BUNDLED_TWITCH_CLIENT_ID)?,
            client_secret: optional_env("VIDEORC_TWITCH_CLIENT_SECRET"),
            scopes: vec![
                "channel:manage:broadcast".to_string(),
                "channel:read:stream_key".to_string(),
                "user:read:chat".to_string(),
                // Comments upgrade S4: sending chat via Helix. Connections made
                // before this scope existed can READ chat but sends classify as
                // reconnect-required until the user reconnects Twitch.
                "user:write:chat".to_string(),
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

fn youtube_provider_config(client_id: String) -> OAuthProviderConfig {
    OAuthProviderConfig {
        authorization_url: "https://accounts.google.com/o/oauth2/v2/auth".to_string(),
        token_url: "https://oauth2.googleapis.com/token".to_string(),
        profile_url: "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true"
            .to_string(),
        client_id,
        client_secret: None,
        scopes: vec!["https://www.googleapis.com/auth/youtube.force-ssl".to_string()],
        extra_params: HashMap::from([
            ("access_type".to_string(), "offline".to_string()),
            ("prompt".to_string(), "consent".to_string()),
        ]),
        pkce: true,
    }
}

fn provider_redirect_uri(
    platform: StreamPlatform,
    redirect_uri: Option<&str>,
    backend_port: u16,
) -> Result<String> {
    let value = redirect_uri
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            // Twitch's dev console accepts the literal `http://localhost` as
            // its ONLY non-HTTPS redirect ("Redirect URIs must use HTTPS
            // protocol" rejects 127.0.0.1 forms). localhost resolves to the
            // same loopback listener — the string just has to match the
            // registered URL exactly. The other providers keep 127.0.0.1
            // (X's registered URLs use it).
            let host = if matches!(platform, StreamPlatform::Twitch) {
                "localhost"
            } else {
                "127.0.0.1"
            };
            format!("http://{host}:{backend_port}/oauth/callback")
        });
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
    let youtube = if youtube_oauth_enabled() {
        provider_credential_status(
            StreamPlatform::Youtube,
            "VIDEORC_YOUTUBE_CLIENT_ID",
            "VIDEORC_YOUTUBE_CLIENT_SECRET",
            BUNDLED_YOUTUBE_CLIENT_ID,
            None,
            true,
            true,
        )
    } else {
        disabled_provider_credential_status(
            StreamPlatform::Youtube,
            YOUTUBE_OAUTH_UNAVAILABLE_MESSAGE,
            true,
        )
    };
    vec![
        youtube,
        // Twitch ships as a PUBLIC client type (dev console setting): no
        // client secret exists, token exchange + refresh use the client id
        // alone. VIDEORC_TWITCH_CLIENT_SECRET stays honoured for confidential
        // setups (smoke accounts, forks running their own app).
        provider_credential_status(
            StreamPlatform::Twitch,
            "VIDEORC_TWITCH_CLIENT_ID",
            "VIDEORC_TWITCH_CLIENT_SECRET",
            BUNDLED_TWITCH_CLIENT_ID,
            None,
            false,
            true,
        ),
        provider_credential_status(
            StreamPlatform::X,
            "VIDEORC_X_CLIENT_ID",
            "VIDEORC_X_CLIENT_SECRET",
            BUNDLED_X_CLIENT_ID,
            None,
            true,
            false,
        ),
    ]
}

pub async fn revoke_youtube_token(token: &str, client: &reqwest::Client) -> Result<()> {
    revoke_youtube_token_at(token, client, "https://oauth2.googleapis.com/revoke").await
}

async fn revoke_youtube_token_at(
    token: &str,
    client: &reqwest::Client,
    revocation_url: &str,
) -> Result<()> {
    if token.trim().is_empty() {
        anyhow::bail!("YouTube OAuth token is empty.");
    }
    let response = client
        .post(revocation_url)
        .form(&[("token", token)])
        .send()
        .await
        .context("Could not contact Google to revoke YouTube access")?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status == reqwest::StatusCode::BAD_REQUEST && body.contains("invalid_token") {
        return Ok(());
    }
    anyhow::bail!("Google rejected YouTube access revocation with HTTP {status}.")
}

fn disabled_provider_credential_status(
    platform: StreamPlatform,
    message: &str,
    pkce: bool,
) -> OAuthProviderCredentialStatus {
    OAuthProviderCredentialStatus {
        platform,
        ready: false,
        client_id_present: false,
        client_secret_present: false,
        client_id_source: OAuthCredentialSource::Missing,
        pkce,
        message: message.to_string(),
    }
}

fn provider_credential_status(
    platform: StreamPlatform,
    client_id_env: &str,
    client_secret_env: &str,
    bundled_client_id: Option<&'static str>,
    bundled_client_secret: Option<&'static str>,
    pkce: bool,
    secret_optional: bool,
) -> OAuthProviderCredentialStatus {
    let client_id_source = credential_source(optional_env(client_id_env), bundled_client_id);
    let client_id_present = client_id_source != OAuthCredentialSource::Missing;
    let client_secret_present =
        optional_env(client_secret_env).is_some() || bundled_client_secret.is_some();
    let ready = client_id_present && (pkce || secret_optional || client_secret_present);
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
        } else if !pkce && !secret_optional && !client_secret_present {
            format!("{label} OAuth also needs its runtime client secret before connecting.")
        } else {
            match client_id_source {
                OAuthCredentialSource::Environment => {
                    format!("{label} OAuth is using {client_id_env}.")
                }
                OAuthCredentialSource::Bundled => {
                    format!("{label} OAuth is using the bundled Videorc client ID.")
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
    let mut entropy = Vec::with_capacity(32);
    entropy.extend_from_slice(Uuid::new_v4().as_bytes());
    entropy.extend_from_slice(Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(entropy)
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

    fn pending_store_path() -> PathBuf {
        std::env::temp_dir().join(format!("videorc-oauth-pending-{}.json", Uuid::new_v4()))
    }

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
    async fn malformed_oauth_store_blocks_overwrite_until_a_clean_restart() {
        let corruptions = [
            b"{\"version\":1,\"sessions\":[".to_vec(),
            br#"{"version":99,"sessions":[]}"#.to_vec(),
            br#"{"version":1,"sessions":[{"state":"","platform":"youtube","expiresAt":"2026-07-12T00:00:00Z","work":{"kind":"generic"}}]}"#.to_vec(),
        ];

        for bytes in corruptions {
            let store_path = pending_store_path();
            std::fs::write(&store_path, &bytes).unwrap();
            let sessions = OAuthSessions::new(Some(store_path.clone()));

            let error = sessions.start(start_params(), 61234).await.unwrap_err();
            assert!(error.to_string().contains("storage is unavailable"));
            assert_eq!(std::fs::read(&store_path).unwrap(), bytes);
            drop(sessions);

            std::fs::remove_file(&store_path).unwrap();
            let restored = OAuthSessions::new(Some(store_path.clone()));
            restored.start(start_params(), 61234).await.unwrap();
            assert!(
                std::fs::read(&store_path)
                    .unwrap()
                    .starts_with(format!("{{\"version\":{OAUTH_PENDING_STORE_VERSION}").as_bytes())
            );
            let _ = std::fs::remove_file(store_path);
        }
    }

    #[tokio::test]
    async fn unreadable_oauth_store_is_not_treated_as_missing() {
        let store_path = pending_store_path();
        std::fs::create_dir(&store_path).unwrap();
        let sessions = OAuthSessions::new(Some(store_path.clone()));

        let error = sessions.start(start_params(), 61234).await.unwrap_err();
        assert!(error.to_string().contains("storage is unavailable"));
        assert!(store_path.is_dir());
        drop(sessions);

        std::fs::remove_dir(&store_path).unwrap();
        let restored = OAuthSessions::new(Some(store_path.clone()));
        restored.start(start_params(), 61234).await.unwrap();
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn provider_pkce_state_survives_a_backend_cold_restart_until_completion() {
        let store_path = pending_store_path();
        let mut protected_secrets = HashMap::new();
        let sessions = OAuthSessions::new(Some(store_path.clone()));
        let started = sessions
            .start_provider_with_secret_store(
                OAuthStartProviderParams {
                    platform: StreamPlatform::X,
                    redirect_uri: Some("videorc://oauth/callback".to_string()),
                },
                61234,
                |secret_ref, value| {
                    protected_secrets.insert(secret_ref.to_string(), value.to_string());
                    Ok(())
                },
                |_| Ok(()),
            )
            .await
            .unwrap();
        let challenge = reqwest::Url::parse(&started.auth_url)
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == "code_challenge")
            .map(|(_, value)| value.into_owned())
            .unwrap();
        let verifier = protected_secrets
            .values()
            .next()
            .expect("PKCE verifier was protected")
            .clone();
        assert_eq!(pkce_s256_challenge(&verifier), challenge);
        assert!(
            !std::fs::read_to_string(&store_path)
                .unwrap()
                .contains(&verifier)
        );
        drop(sessions);

        let restored = OAuthSessions::new(Some(store_path.clone()));
        let outcome = restored
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            })
            .await;
        let exchange = outcome.exchange.expect("provider exchange was restored");
        let restored_verifier = recover_pkce_verifier(&exchange, |secret_ref| {
            Ok(protected_secrets.get(secret_ref).cloned())
        })
        .unwrap()
        .expect("PKCE verifier was restored");
        assert_eq!(restored_verifier, verifier);
        assert!(!outcome.result.retryable);

        restored.retry(&started.state).await.unwrap();
        let retried = restored
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            })
            .await;
        assert!(retried.exchange.is_some());
        restored
            .finish_with_secret_cleanup(&started.state, |secret_ref| {
                protected_secrets.remove(secret_ref);
                Ok(())
            })
            .await
            .unwrap();
        assert!(protected_secrets.is_empty());
        drop(restored);
        assert!(
            OAuthSessions::new(Some(store_path.clone()))
                .state
                .lock()
                .await
                .pending
                .is_empty()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&store_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn legacy_plaintext_pkce_store_migrates_atomically_to_a_validated_secret_reference() {
        let store_path = pending_store_path();
        let state = "legacy-provider-state";
        let verifier = format!("videorc-{}", "a".repeat(32));
        let legacy = serde_json::json!({
            "version": 1,
            "sessions": [{
                "state": state,
                "platform": "x",
                "expiresAt": (Utc::now() + Duration::minutes(10)).to_rfc3339(),
                "work": {
                    "kind": "provider-exchange",
                    "redirect_uri": "videorc://oauth/callback",
                    "code_verifier": verifier,
                }
            }]
        });
        std::fs::write(&store_path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let mut protected_secrets = HashMap::new();

        let sessions = OAuthSessions::new_with_secret_store(
            Some(store_path.clone()),
            |secret_ref, value| {
                protected_secrets.insert(secret_ref.to_string(), value.to_string());
                Ok(())
            },
            |_| Ok(()),
        );
        sessions.ensure_store_available().unwrap();
        let migrated = std::fs::read_to_string(&store_path).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&migrated).unwrap()["version"],
            OAUTH_PENDING_STORE_VERSION
        );
        assert!(migrated.contains("codeVerifierSecretRef"));
        assert!(!migrated.contains(&verifier));
        assert!(!migrated.contains("\"codeVerifier\":"));

        let outcome = sessions
            .complete_with_pending(OAuthCompleteParams {
                state: state.to_string(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            })
            .await;
        let exchange = outcome.exchange.expect("migrated provider exchange");
        assert_eq!(
            recover_pkce_verifier(&exchange, |secret_ref| {
                Ok(protected_secrets.get(secret_ref).cloned())
            })
            .unwrap()
            .as_deref(),
            Some(verifier.as_str())
        );
        sessions
            .finish_with_secret_cleanup(state, |secret_ref| {
                protected_secrets.remove(secret_ref);
                Ok(())
            })
            .await
            .unwrap();
        assert!(protected_secrets.is_empty());
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn reference_store_v2_migrates_predeclared_candidate_refs_to_v3() {
        let store_path = pending_store_path();
        let state = "reference-store-provider-state";
        let checkpoint_ref = pending_token_secret_ref(state, StreamPlatform::X);
        let pkce_ref = pending_pkce_verifier_secret_ref(state, StreamPlatform::X);
        let reference_store = serde_json::json!({
            "version": REFERENCE_OAUTH_PENDING_STORE_VERSION,
            "sessions": [{
                "state": state,
                "platform": "x",
                "expiresAt": (Utc::now() + Duration::minutes(10)).to_rfc3339(),
                "work": {
                    "kind": "provider-exchange-started",
                    "checkpoint": {
                        "platform": "x",
                        "profileUrl": "https://stale.example/profile",
                        "clientId": "stale-client",
                        "scopes": ["stale.scope"],
                        "secretRef": checkpoint_ref,
                        "pkceVerifierSecretRef": pkce_ref,
                    }
                }
            }]
        });
        std::fs::write(&store_path, serde_json::to_vec(&reference_store).unwrap()).unwrap();

        let sessions = OAuthSessions::new(Some(store_path.clone()));
        sessions.ensure_store_available().unwrap();
        let migrated = std::fs::read_to_string(&store_path).unwrap();
        let migrated_json = serde_json::from_str::<serde_json::Value>(&migrated).unwrap();
        assert_eq!(migrated_json["version"], OAUTH_PENDING_STORE_VERSION);
        assert!(migrated.contains(&pending_candidate_secret_ref(
            state,
            StreamPlatform::X,
            CandidateSecretKind::Access,
        )));
        assert!(migrated.contains(&pending_candidate_secret_ref(
            state,
            StreamPlatform::X,
            CandidateSecretKind::Refresh,
        )));
        assert_eq!(
            sessions.resumable_provider_states().await.unwrap(),
            vec![state.to_string()]
        );
        sessions
            .finish_with_secret_cleanup(state, |_| Ok(()))
            .await
            .unwrap();
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn legacy_pkce_migration_failure_preserves_the_original_recovery_file() {
        let store_path = pending_store_path();
        let verifier = format!("videorc-{}", "a".repeat(32));
        let legacy = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "sessions": [{
                "state": "legacy-provider-state",
                "platform": "x",
                "expiresAt": (Utc::now() + Duration::minutes(10)).to_rfc3339(),
                "work": {
                    "kind": "provider-exchange",
                    "redirect_uri": "videorc://oauth/callback",
                    "code_verifier": verifier,
                }
            }]
        }))
        .unwrap();
        std::fs::write(&store_path, &legacy).unwrap();

        let sessions = OAuthSessions::new_with_secret_store(
            Some(store_path.clone()),
            |_, _| anyhow::bail!("injected protected-store failure"),
            |_| Ok(()),
        );

        assert!(sessions.ensure_store_available().is_err());
        assert_eq!(std::fs::read(&store_path).unwrap(), legacy);
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn denial_and_corrupt_pkce_recovery_can_delete_the_protected_verifier() {
        for corrupt_before_completion in [false, true] {
            let store_path = pending_store_path();
            let mut protected_secrets = HashMap::new();
            let sessions = OAuthSessions::new(Some(store_path.clone()));
            let started = sessions
                .start_provider_with_secret_store(
                    OAuthStartProviderParams {
                        platform: StreamPlatform::X,
                        redirect_uri: Some("videorc://oauth/callback".to_string()),
                    },
                    61234,
                    |secret_ref, value| {
                        protected_secrets.insert(secret_ref.to_string(), value.to_string());
                        Ok(())
                    },
                    |_| Ok(()),
                )
                .await
                .unwrap();
            assert_eq!(protected_secrets.len(), 1);

            if corrupt_before_completion {
                protected_secrets
                    .values_mut()
                    .for_each(|value| *value = "corrupt".to_string());
                let outcome = sessions
                    .complete_with_pending(OAuthCompleteParams {
                        state: started.state.clone(),
                        code: Some("single-use-code".to_string()),
                        error: None,
                        error_description: None,
                    })
                    .await;
                assert!(
                    recover_pkce_verifier(
                        &outcome.exchange.expect("provider exchange"),
                        |secret_ref| Ok(protected_secrets.get(secret_ref).cloned())
                    )
                    .is_err()
                );
            } else {
                let denied = sessions
                    .complete_with_pending(OAuthCompleteParams {
                        state: started.state.clone(),
                        code: None,
                        error: Some("access_denied".to_string()),
                        error_description: None,
                    })
                    .await;
                assert_eq!(denied.result.status, OAuthCallbackStatus::Failed);
            }

            sessions
                .finish_with_secret_cleanup(&started.state, |secret_ref| {
                    protected_secrets.remove(secret_ref);
                    Ok(())
                })
                .await
                .unwrap();
            assert!(protected_secrets.is_empty());
            let _ = std::fs::remove_file(store_path);
        }
    }

    #[tokio::test]
    async fn provider_start_persists_pkce_ownership_before_a_failing_secret_write() {
        let store_path = pending_store_path();
        let protected_secrets = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let written = protected_secrets.clone();
        let observed_durable_ref = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = observed_durable_ref.clone();
        let path_at_write = store_path.clone();
        let sessions = OAuthSessions::new(Some(store_path.clone()));

        let error = sessions
            .start_provider_with_secret_store(
                OAuthStartProviderParams {
                    platform: StreamPlatform::X,
                    redirect_uri: Some("videorc://oauth/callback".to_string()),
                },
                61234,
                |secret_ref, value| {
                    let pending_json = std::fs::read_to_string(&path_at_write).unwrap();
                    observed.store(
                        pending_json.contains(secret_ref)
                            && pending_json.contains("codeVerifierSecretRef"),
                        std::sync::atomic::Ordering::SeqCst,
                    );
                    written
                        .lock()
                        .unwrap()
                        .insert(secret_ref.to_string(), value.to_string());
                    anyhow::bail!("injected post-write failure")
                },
                |_| Ok(()),
            )
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("protect the pending OAuth PKCE verifier")
        );
        assert!(observed_durable_ref.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(protected_secrets.lock().unwrap().len(), 1);
        let callback_state = sessions
            .state
            .lock()
            .await
            .pending
            .keys()
            .next()
            .unwrap()
            .clone();
        {
            let mut state = sessions.state.lock().await;
            state.pending.get_mut(&callback_state).unwrap().expires_at = Utc::now();
        }
        sessions
            .maintain_pending(Utc::now() + Duration::seconds(1), |secret_ref| {
                protected_secrets.lock().unwrap().remove(secret_ref);
                Ok(())
            })
            .await
            .unwrap();
        assert!(protected_secrets.lock().unwrap().is_empty());
        assert!(sessions.state.lock().await.pending.is_empty());
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn live_maintenance_retries_expired_cleanup_after_delete_and_persist_failures() {
        let directory =
            std::env::temp_dir().join(format!("videorc-oauth-live-maintenance-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let store_path = directory.join("pending.json");
        let backup_directory = directory.with_extension("backup");
        let mut protected_secrets = HashMap::new();
        let sessions = OAuthSessions::new(Some(store_path.clone()));
        let started = sessions
            .start_provider_with_secret_store(
                OAuthStartProviderParams {
                    platform: StreamPlatform::X,
                    redirect_uri: Some("videorc://oauth/callback".to_string()),
                },
                61234,
                |secret_ref, value| {
                    protected_secrets.insert(secret_ref.to_string(), value.to_string());
                    Ok(())
                },
                |_| Ok(()),
            )
            .await
            .unwrap();
        {
            let mut state = sessions.state.lock().await;
            state.pending.get_mut(&started.state).unwrap().expires_at = Utc::now();
        }
        let maintenance_now = Utc::now() + Duration::seconds(1);

        sessions
            .maintain_pending(maintenance_now, |_| {
                anyhow::bail!("injected delete failure")
            })
            .await
            .unwrap();
        assert!(
            sessions
                .state
                .lock()
                .await
                .pending
                .contains_key(&started.state)
        );
        assert_eq!(protected_secrets.len(), 1);

        std::fs::rename(&directory, &backup_directory).unwrap();
        std::fs::write(&directory, b"blocks pending-store directory recreation").unwrap();
        let persist_error = sessions
            .maintain_pending(maintenance_now, |secret_ref| {
                protected_secrets.remove(secret_ref);
                Ok(())
            })
            .await
            .unwrap_err();
        assert!(persist_error.to_string().contains("OAuth transaction dir"));
        assert!(
            sessions
                .state
                .lock()
                .await
                .pending
                .contains_key(&started.state)
        );
        assert!(protected_secrets.is_empty());

        std::fs::remove_file(&directory).unwrap();
        std::fs::rename(&backup_directory, &directory).unwrap();
        sessions
            .maintain_pending(maintenance_now, |_| Ok(()))
            .await
            .unwrap();
        assert!(sessions.state.lock().await.pending.is_empty());
        assert!(
            !std::fs::read_to_string(&store_path)
                .unwrap()
                .contains(&started.state)
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn same_platform_finalization_is_serialized_without_blocking_other_platforms() {
        let sessions = std::sync::Arc::new(OAuthSessions::new(None));
        let first_x = sessions.lock_platform_finalization(StreamPlatform::X).await;
        let competing = sessions.clone();
        let blocked_x = tokio::spawn(async move {
            competing
                .lock_platform_finalization(StreamPlatform::X)
                .await
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), async {
                while !blocked_x.is_finished() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .is_err(),
            "a second X reconnect must wait for the first commit edge"
        );
        tokio::time::timeout(
            std::time::Duration::from_millis(25),
            sessions.lock_platform_finalization(StreamPlatform::Twitch),
        )
        .await
        .expect("another platform finalizes independently");
        drop(first_x);
        tokio::time::timeout(std::time::Duration::from_millis(100), blocked_x)
            .await
            .expect("same-platform waiter resumes after commit")
            .unwrap();
    }

    #[tokio::test]
    async fn stalled_profile_times_out_and_releases_recovery_and_platform_ownership() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _connection = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let sessions = OAuthSessions::new(None);
        let started = sessions
            .start_provider(
                OAuthStartProviderParams {
                    platform: StreamPlatform::X,
                    redirect_uri: Some("videorc://oauth/callback".to_string()),
                },
                61234,
            )
            .await
            .unwrap();
        let _ = sessions
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            })
            .await;
        let mut checkpoint = sessions
            .stage_exchange_started(&started.state)
            .await
            .unwrap();
        sessions
            .stage_exchanged_token(
                &started.state,
                ExchangedOAuthToken {
                    platform: StreamPlatform::X,
                    access_token: "access-token".to_string(),
                    refresh_token: None,
                    scopes: vec!["users.read".to_string()],
                    expires_at: None,
                },
                |_, _| Ok(()),
            )
            .await
            .unwrap();
        checkpoint.profile_url = format!("http://{address}/stalled-profile");
        let guard = sessions.lock_platform_finalization(StreamPlatform::X).await;
        let error = account_from_exchanged_token(
            &checkpoint,
            &ExchangedOAuthToken {
                platform: StreamPlatform::X,
                access_token: "access-token".to_string(),
                refresh_token: None,
                scopes: vec!["users.read".to_string()],
                expires_at: None,
            },
            &provider_http_client_with_timeout(std::time::Duration::from_millis(40)),
            |_| panic!("timed-out profile must not publish credentials"),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("Could not fetch"));

        sessions.retry(&started.state).await.unwrap();
        drop(guard);
        assert_eq!(
            sessions
                .maintain_pending(Utc::now(), |_| Ok(()))
                .await
                .unwrap(),
            vec![started.state.clone()]
        );
        sessions.release_recovery_driver(&started.state).await;
        assert!(
            sessions
                .can_resume_without_code(&started.state)
                .await
                .unwrap()
        );
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            sessions.lock_platform_finalization(StreamPlatform::X),
        )
        .await
        .expect("timed-out owner must release the platform lock");
        sessions
            .finish_with_secret_cleanup(&started.state, |_| Ok(()))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cold_start_never_resumes_an_unconsumed_provider_exchange_without_its_code() {
        let store_path = pending_store_path();
        let sessions = OAuthSessions::new(Some(store_path.clone()));
        let started = sessions
            .start_provider(
                OAuthStartProviderParams {
                    platform: StreamPlatform::X,
                    redirect_uri: Some("videorc://oauth/callback".to_string()),
                },
                61234,
            )
            .await
            .unwrap();
        drop(sessions);

        let restored = OAuthSessions::new(Some(store_path.clone()));
        assert!(
            restored
                .resumable_provider_states()
                .await
                .unwrap()
                .is_empty()
        );
        let outcome = restored
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: None,
                error: None,
                error_description: None,
            })
            .await;
        assert_eq!(outcome.result.status, OAuthCallbackStatus::Failed);
        assert!(outcome.exchange.is_none());
        assert!(outcome.authorization_code.is_none());
        restored.finish(&started.state).await.unwrap();
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn consumed_provider_code_recovers_from_protected_token_checkpoint_without_reexchange() {
        let store_path = pending_store_path();
        let sessions = OAuthSessions::new(Some(store_path.clone()));
        let started = sessions
            .start_provider(
                OAuthStartProviderParams {
                    platform: StreamPlatform::X,
                    redirect_uri: Some("videorc://oauth/callback".to_string()),
                },
                61234,
            )
            .await
            .unwrap();
        let initial = sessions
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            })
            .await;
        assert!(initial.exchange.is_some());
        sessions
            .stage_exchange_started(&started.state)
            .await
            .unwrap();

        let token = ExchangedOAuthToken {
            platform: StreamPlatform::X,
            access_token: "protected-access-token".to_string(),
            refresh_token: Some("protected-refresh-token".to_string()),
            scopes: vec!["users.read".to_string()],
            expires_at: Some("2026-07-12T01:00:00Z".to_string()),
        };
        let mut protected_secrets = HashMap::new();
        sessions
            .stage_exchanged_token(&started.state, token.clone(), |secret_ref, value| {
                protected_secrets.insert(secret_ref.to_string(), value.to_string());
                Ok(())
            })
            .await
            .unwrap();

        let pending_json = std::fs::read_to_string(&store_path).unwrap();
        for forbidden in [
            "single-use-code",
            "protected-access-token",
            "protected-refresh-token",
        ] {
            assert!(!pending_json.contains(forbidden));
        }
        drop(sessions);

        let restored = OAuthSessions::new(Some(store_path.clone()));
        assert_eq!(
            restored
                .maintain_pending(Utc::now(), |_| {
                    panic!("expired advanced secrets must not be pruned")
                })
                .await
                .unwrap(),
            vec![started.state.clone()]
        );
        assert!(
            restored
                .maintain_pending(Utc::now(), |_| Ok(()))
                .await
                .unwrap()
                .is_empty(),
            "live maintenance must not start a duplicate recovery driver"
        );
        let resumed = restored
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: None,
                error: None,
                error_description: None,
            })
            .await;
        assert!(resumed.exchange.is_none());
        let checkpoint = resumed
            .token_checkpoint
            .expect("protected token checkpoint survives restart");
        let recovered = recover_exchanged_token(&checkpoint, |secret_ref| {
            Ok(protected_secrets.get(secret_ref).cloned())
        })
        .unwrap();
        assert_eq!(recovered, token);

        restored
            .finish_with_secret_cleanup(&started.state, |secret_ref| {
                protected_secrets.remove(secret_ref);
                Ok(())
            })
            .await
            .unwrap();
        assert!(protected_secrets.is_empty());
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn interrupted_exchange_without_checkpoint_never_reposts_single_use_code() {
        let store_path = pending_store_path();
        let sessions = OAuthSessions::new(Some(store_path.clone()));
        let started = sessions
            .start_provider(
                OAuthStartProviderParams {
                    platform: StreamPlatform::X,
                    redirect_uri: Some("videorc://oauth/callback".to_string()),
                },
                61234,
            )
            .await
            .unwrap();
        let initial = sessions
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            })
            .await;
        assert!(initial.exchange.is_some());
        sessions
            .stage_exchange_started(&started.state)
            .await
            .unwrap();
        drop(sessions);

        let restored = OAuthSessions::new(Some(store_path.clone()));
        assert_eq!(
            restored.resumable_provider_states().await.unwrap(),
            vec![started.state.clone()]
        );
        let resumed = restored
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: None,
                error: None,
                error_description: None,
            })
            .await;
        assert!(resumed.exchange.is_none());
        assert!(resumed.authorization_code.is_none());
        assert!(resumed.token_checkpoint.is_some());
        restored
            .finish_with_secret_cleanup(&started.state, |_| Ok(()))
            .await
            .unwrap();
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn provider_transactions_predeclare_distinct_candidate_refs_before_secret_writes() {
        let store_path = pending_store_path();
        let sessions = OAuthSessions::new(Some(store_path.clone()));
        let mut checkpoints = Vec::new();
        for _ in 0..2 {
            let started = sessions
                .start_provider(
                    OAuthStartProviderParams {
                        platform: StreamPlatform::X,
                        redirect_uri: Some("videorc://oauth/callback".to_string()),
                    },
                    61234,
                )
                .await
                .unwrap();
            let outcome = sessions
                .complete_with_pending(OAuthCompleteParams {
                    state: started.state.clone(),
                    code: Some("single-use-code".to_string()),
                    error: None,
                    error_description: None,
                })
                .await;
            assert!(outcome.exchange.is_some());
            checkpoints.push((
                started.state,
                sessions
                    .stage_exchange_started(&outcome.result.state)
                    .await
                    .unwrap(),
            ));
        }

        assert_ne!(
            checkpoints[0].1.candidate_access_secret_ref(),
            checkpoints[1].1.candidate_access_secret_ref()
        );
        assert_ne!(
            checkpoints[0].1.candidate_refresh_secret_ref(),
            checkpoints[1].1.candidate_refresh_secret_ref()
        );
        let pending_json = std::fs::read_to_string(&store_path).unwrap();
        for (_, checkpoint) in &checkpoints {
            assert!(pending_json.contains(checkpoint.candidate_access_secret_ref()));
            assert!(pending_json.contains(checkpoint.candidate_refresh_secret_ref()));
        }
        for (state, _) in checkpoints {
            sessions
                .finish_with_secret_cleanup(&state, |_| Ok(()))
                .await
                .unwrap();
        }
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn crash_after_candidate_write_keeps_every_secret_owned_by_provider_token_checkpoint() {
        let store_path = pending_store_path();
        let mut protected_secrets = HashMap::new();
        let sessions = OAuthSessions::new(Some(store_path.clone()));
        let started = sessions
            .start_provider_with_secret_store(
                OAuthStartProviderParams {
                    platform: StreamPlatform::X,
                    redirect_uri: Some("videorc://oauth/callback".to_string()),
                },
                61234,
                |secret_ref, value| {
                    protected_secrets.insert(secret_ref.to_string(), value.to_string());
                    Ok(())
                },
                |_| Ok(()),
            )
            .await
            .unwrap();
        let _ = sessions
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            })
            .await;
        let checkpoint = sessions
            .stage_exchange_started(&started.state)
            .await
            .unwrap();
        sessions
            .stage_exchanged_token(
                &started.state,
                ExchangedOAuthToken {
                    platform: StreamPlatform::X,
                    access_token: "transient-access".to_string(),
                    refresh_token: Some("transient-refresh".to_string()),
                    scopes: vec!["users.read".to_string()],
                    expires_at: None,
                },
                |secret_ref, value| {
                    protected_secrets.insert(secret_ref.to_string(), value.to_string());
                    Ok(())
                },
            )
            .await
            .unwrap();
        protected_secrets.insert(
            checkpoint.candidate_access_secret_ref().to_string(),
            "candidate-access".to_string(),
        );
        protected_secrets.insert(
            checkpoint.candidate_refresh_secret_ref().to_string(),
            "candidate-refresh".to_string(),
        );
        drop(sessions);

        let restored = OAuthSessions::new(Some(store_path.clone()));
        restored
            .finish_with_secret_cleanup(&started.state, |secret_ref| {
                protected_secrets.remove(secret_ref);
                Ok(())
            })
            .await
            .unwrap();
        assert!(
            protected_secrets.is_empty(),
            "a crash before AccountStorage must not orphan candidate credentials"
        );
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn crash_after_database_commit_preserves_candidates_and_retries_superseded_cleanup() {
        let store_path = pending_store_path();
        let mut protected_secrets = HashMap::new();
        let sessions = OAuthSessions::new(Some(store_path.clone()));
        let started = sessions
            .start_provider_with_secret_store(
                OAuthStartProviderParams {
                    platform: StreamPlatform::X,
                    redirect_uri: Some("videorc://oauth/callback".to_string()),
                },
                61234,
                |secret_ref, value| {
                    protected_secrets.insert(secret_ref.to_string(), value.to_string());
                    Ok(())
                },
                |_| Ok(()),
            )
            .await
            .unwrap();
        let _ = sessions
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            })
            .await;
        let checkpoint = sessions
            .stage_exchange_started(&started.state)
            .await
            .unwrap();
        sessions
            .stage_exchanged_token(
                &started.state,
                ExchangedOAuthToken {
                    platform: StreamPlatform::X,
                    access_token: "transient-access".to_string(),
                    refresh_token: Some("transient-refresh".to_string()),
                    scopes: vec!["users.read".to_string()],
                    expires_at: None,
                },
                |secret_ref, value| {
                    protected_secrets.insert(secret_ref.to_string(), value.to_string());
                    Ok(())
                },
            )
            .await
            .unwrap();
        let old_access = "platform:x:oauth:access".to_string();
        let old_refresh = "platform:x:oauth:refresh".to_string();
        protected_secrets.insert(old_access.clone(), "old-access".to_string());
        protected_secrets.insert(old_refresh.clone(), "old-refresh".to_string());
        protected_secrets.insert(
            checkpoint.candidate_access_secret_ref().to_string(),
            "candidate-access".to_string(),
        );
        protected_secrets.insert(
            checkpoint.candidate_refresh_secret_ref().to_string(),
            "candidate-refresh".to_string(),
        );
        let account = UpsertPlatformAccount {
            platform: StreamPlatform::X,
            account_id: "x-user-1".to_string(),
            account_label: "X User".to_string(),
            account_handle: Some("@x-user".to_string()),
            avatar_url: None,
            scopes: vec!["users.read".to_string()],
            token_secret_ref: Some(checkpoint.candidate_access_secret_ref().to_string()),
            refresh_token_secret_ref: Some(checkpoint.candidate_refresh_secret_ref().to_string()),
            stream_key_secret_ref: None,
            expires_at: None,
            status: PlatformAccountStatus::Connected,
        };
        sessions
            .stage_account_storage_with_checkpoint(
                &started.state,
                account.clone(),
                Some(&checkpoint),
                vec![old_access.clone(), old_refresh.clone()],
                PlatformAccountWriteExpectation::absent(0),
            )
            .await
            .unwrap();
        let database = crate::storage::Database::open_in_memory_for_tests();
        database.upsert_platform_account(account.clone()).unwrap();
        drop(sessions); // crash after SQLite commit, before transient cleanup

        let restored = OAuthSessions::new(Some(store_path.clone()));
        let outcome = restored
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: None,
                error: None,
                error_description: None,
            })
            .await;
        assert_eq!(outcome.account_to_store, Some(account.clone()));
        assert!(
            restored
                .finish_with_secret_cleanup(&started.state, |_| {
                    anyhow::bail!("injected cleanup interruption")
                })
                .await
                .is_err()
        );
        assert!(
            restored
                .state
                .lock()
                .await
                .pending
                .contains_key(&started.state)
        );
        restored
            .finish_with_secret_cleanup(&started.state, |secret_ref| {
                protected_secrets.remove(secret_ref);
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(
            protected_secrets,
            HashMap::from([
                (
                    checkpoint.candidate_access_secret_ref().to_string(),
                    "candidate-access".to_string(),
                ),
                (
                    checkpoint.candidate_refresh_secret_ref().to_string(),
                    "candidate-refresh".to_string(),
                ),
            ]),
            "cleanup must preserve the candidates now referenced by SQLite"
        );
        let stored = database.list_platform_account_credentials().unwrap();
        assert_eq!(stored[0].token_secret_ref, account.token_secret_ref);
        assert_eq!(
            stored[0].refresh_token_secret_ref,
            account.refresh_token_secret_ref
        );
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn stale_account_storage_retry_cannot_roll_back_a_newer_connection() {
        let store_path = pending_store_path();
        let database = crate::storage::Database::open_in_memory_for_tests();
        let mut protected_secrets = HashMap::new();
        let sessions = OAuthSessions::new(Some(store_path.clone()));
        let started_a = sessions.start(start_params(), 61234).await.unwrap();
        let _ = sessions
            .complete_with_pending(OAuthCompleteParams {
                state: started_a.state.clone(),
                code: Some("code-a".to_string()),
                error: None,
                error_description: None,
            })
            .await;
        let a_access = pending_candidate_secret_ref(
            &started_a.state,
            StreamPlatform::Youtube,
            CandidateSecretKind::Access,
        );
        let a_refresh = pending_candidate_secret_ref(
            &started_a.state,
            StreamPlatform::Youtube,
            CandidateSecretKind::Refresh,
        );
        protected_secrets.insert(a_access.clone(), "access-a".to_string());
        protected_secrets.insert(a_refresh.clone(), "refresh-a".to_string());
        let pre_a_access = "platform:youtube:oauth:access".to_string();
        protected_secrets.insert(pre_a_access.clone(), "pre-a-access".to_string());
        let account_a = UpsertPlatformAccount {
            platform: StreamPlatform::Youtube,
            account_id: "account-a".to_string(),
            account_label: "Account A".to_string(),
            account_handle: None,
            avatar_url: None,
            scopes: Vec::new(),
            token_secret_ref: Some(a_access.clone()),
            refresh_token_secret_ref: Some(a_refresh.clone()),
            stream_key_secret_ref: None,
            expires_at: None,
            status: PlatformAccountStatus::Connected,
        };
        let commit_a = sessions
            .stage_account_storage_with_checkpoint(
                &started_a.state,
                account_a.clone(),
                None,
                vec![pre_a_access],
                database
                    .platform_account_write_expectation(StreamPlatform::Youtube)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(matches!(
            database
                .compare_and_upsert_platform_account(
                    account_a.clone(),
                    commit_a.expected_account_state.as_ref(),
                    commit_a.write_generation,
                    true,
                    true,
                    || Ok(()),
                )
                .unwrap(),
            crate::storage::PlatformAccountCasOutcome::Applied(_)
        ));
        assert!(
            sessions
                .finish_with_secret_cleanup(&started_a.state, |_| {
                    anyhow::bail!("injected cleanup failure")
                })
                .await
                .is_err()
        );
        drop(sessions);

        let restored = OAuthSessions::new(Some(store_path.clone()));
        let started_b = restored.start(start_params(), 61234).await.unwrap();
        let _ = restored
            .complete_with_pending(OAuthCompleteParams {
                state: started_b.state.clone(),
                code: Some("code-b".to_string()),
                error: None,
                error_description: None,
            })
            .await;
        let b_access = pending_candidate_secret_ref(
            &started_b.state,
            StreamPlatform::Youtube,
            CandidateSecretKind::Access,
        );
        let b_refresh = pending_candidate_secret_ref(
            &started_b.state,
            StreamPlatform::Youtube,
            CandidateSecretKind::Refresh,
        );
        protected_secrets.insert(b_access.clone(), "access-b".to_string());
        protected_secrets.insert(b_refresh.clone(), "refresh-b".to_string());
        let account_b = UpsertPlatformAccount {
            token_secret_ref: Some(b_access.clone()),
            refresh_token_secret_ref: Some(b_refresh.clone()),
            account_id: "account-b".to_string(),
            account_label: "Account B".to_string(),
            ..account_a.clone()
        };
        let commit_b = restored
            .stage_account_storage_with_checkpoint(
                &started_b.state,
                account_b.clone(),
                None,
                vec![a_access.clone(), a_refresh.clone()],
                database
                    .platform_account_write_expectation(StreamPlatform::Youtube)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(matches!(
            database
                .compare_and_upsert_platform_account(
                    account_b.clone(),
                    commit_b.expected_account_state.as_ref(),
                    commit_b.write_generation,
                    true,
                    true,
                    || Ok(()),
                )
                .unwrap(),
            crate::storage::PlatformAccountCasOutcome::Applied(_)
        ));
        restored
            .finish_with_secret_cleanup(&started_b.state, |secret_ref| {
                protected_secrets.remove(secret_ref);
                Ok(())
            })
            .await
            .unwrap();

        let retry_a = restored
            .complete_with_pending(OAuthCompleteParams {
                state: started_a.state.clone(),
                code: None,
                error: None,
                error_description: None,
            })
            .await;
        let stale = database
            .compare_and_upsert_platform_account(
                retry_a.account_to_store.unwrap(),
                retry_a
                    .account_storage_commit
                    .as_ref()
                    .and_then(|commit| commit.expected_account_state.as_ref()),
                retry_a
                    .account_storage_commit
                    .as_ref()
                    .unwrap()
                    .write_generation,
                true,
                true,
                || Ok(()),
            )
            .unwrap();
        let crate::storage::PlatformAccountCasOutcome::Stale(current) = stale else {
            panic!("older AccountStorage recovery must be stale");
        };
        restored
            .finish_superseded_account_storage_with_secret_cleanup(
                &started_a.state,
                &current,
                |secret_ref| {
                    protected_secrets.remove(secret_ref);
                    Ok(())
                },
            )
            .await
            .unwrap();
        let stored = database.list_platform_account_credentials().unwrap();
        assert_eq!(stored[0].account.account_id, "account-b");
        assert_eq!(
            stored[0].token_secret_ref.as_deref(),
            Some(b_access.as_str())
        );
        assert_eq!(
            protected_secrets,
            HashMap::from([
                (b_access, "access-b".to_string()),
                (b_refresh, "refresh-b".to_string()),
            ])
        );
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn expired_advanced_checkpoint_survives_restart_and_resumes_code_less() {
        let store_path = pending_store_path();
        let mut protected_secrets = HashMap::new();
        let sessions = OAuthSessions::new(Some(store_path.clone()));
        let started = sessions
            .start_provider_with_secret_store(
                OAuthStartProviderParams {
                    platform: StreamPlatform::X,
                    redirect_uri: Some("videorc://oauth/callback".to_string()),
                },
                61234,
                |secret_ref, value| {
                    protected_secrets.insert(secret_ref.to_string(), value.to_string());
                    Ok(())
                },
                |_| Ok(()),
            )
            .await
            .unwrap();
        let _ = sessions
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            })
            .await;
        sessions
            .stage_exchange_started(&started.state)
            .await
            .unwrap();
        let token = ExchangedOAuthToken {
            platform: StreamPlatform::X,
            access_token: "expired-access-token".to_string(),
            refresh_token: Some("expired-refresh-token".to_string()),
            scopes: vec!["users.read".to_string()],
            expires_at: None,
        };
        sessions
            .stage_exchanged_token(&started.state, token, |secret_ref, value| {
                protected_secrets.insert(secret_ref.to_string(), value.to_string());
                Ok(())
            })
            .await
            .unwrap();
        {
            let mut state = sessions.state.lock().await;
            state.pending.get_mut(&started.state).unwrap().expires_at =
                Utc::now() - Duration::seconds(1);
            sessions.persist(&state).unwrap();
        }
        drop(sessions);

        let restored = OAuthSessions::new_with_secret_cleanup(Some(store_path.clone()), |_| {
            panic!("advanced work must not be pruned at transaction expiry")
        });
        assert!(
            restored
                .state
                .lock()
                .await
                .pending
                .contains_key(&started.state)
        );
        assert_eq!(
            restored
                .maintain_pending(Utc::now(), |_| {
                    panic!("expired advanced secrets must not be pruned")
                })
                .await
                .unwrap(),
            vec![started.state.clone()]
        );
        assert!(
            restored
                .maintain_pending(Utc::now(), |_| Ok(()))
                .await
                .unwrap()
                .is_empty(),
            "maintenance claims an advanced checkpoint only once"
        );
        let resumed = restored
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: None,
                error: None,
                error_description: None,
            })
            .await;
        assert_eq!(resumed.result.status, OAuthCallbackStatus::Success);
        assert!(resumed.token_checkpoint.is_some());
        restored
            .finish_with_secret_cleanup(&started.state, |secret_ref| {
                protected_secrets.remove(secret_ref);
                Ok(())
            })
            .await
            .unwrap();
        assert!(protected_secrets.is_empty());
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn protected_checkpoint_cleanup_failure_keeps_transaction_for_retry() {
        let store_path = pending_store_path();
        let sessions = OAuthSessions::new(Some(store_path.clone()));
        let started = sessions
            .start_provider(
                OAuthStartProviderParams {
                    platform: StreamPlatform::X,
                    redirect_uri: Some("videorc://oauth/callback".to_string()),
                },
                61234,
            )
            .await
            .unwrap();
        let _ = sessions
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            })
            .await;
        sessions
            .stage_exchange_started(&started.state)
            .await
            .unwrap();
        sessions
            .stage_exchanged_token(
                &started.state,
                ExchangedOAuthToken {
                    platform: StreamPlatform::X,
                    access_token: "protected-access-token".to_string(),
                    refresh_token: None,
                    scopes: vec!["users.read".to_string()],
                    expires_at: None,
                },
                |_, _| Ok(()),
            )
            .await
            .unwrap();
        sessions.retry(&started.state).await.unwrap();
        let denied = sessions
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: None,
                error: Some("access_denied".to_string()),
                error_description: Some("User cancelled.".to_string()),
            })
            .await;
        assert_eq!(denied.result.status, OAuthCallbackStatus::Success);
        assert!(denied.token_checkpoint.is_some());

        assert!(
            sessions
                .finish_with_secret_cleanup(&started.state, |_| {
                    anyhow::bail!("injected protected-store cleanup failure")
                })
                .await
                .is_err()
        );
        assert!(
            sessions
                .state
                .lock()
                .await
                .pending
                .contains_key(&started.state)
        );
        sessions
            .finish_with_secret_cleanup(&started.state, |_| Ok(()))
            .await
            .unwrap();
        assert!(sessions.state.lock().await.pending.is_empty());
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn exchanged_account_storage_stage_survives_restart_without_reusing_code() {
        let store_path = pending_store_path();
        let sessions = OAuthSessions::new(Some(store_path.clone()));
        let started = sessions.start(start_params(), 61234).await.unwrap();
        let _ = sessions
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            })
            .await;
        let account = UpsertPlatformAccount {
            platform: StreamPlatform::Youtube,
            account_id: "channel-1".to_string(),
            account_label: "Channel".to_string(),
            account_handle: None,
            avatar_url: None,
            scopes: vec!["videos.write".to_string()],
            token_secret_ref: Some("platform:youtube:oauth:access".to_string()),
            refresh_token_secret_ref: None,
            stream_key_secret_ref: None,
            expires_at: None,
            status: PlatformAccountStatus::Connected,
        };
        sessions
            .stage_account_storage(&started.state, account.clone())
            .await
            .unwrap();
        drop(sessions);

        let restored = OAuthSessions::new(Some(store_path.clone()));
        assert_eq!(
            restored.resumable_provider_states().await.unwrap(),
            vec![started.state.clone()]
        );
        let outcome = restored
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: None,
                error: None,
                error_description: None,
            })
            .await;
        assert_eq!(outcome.account_to_store, Some(account));
        assert!(outcome.exchange.is_none());
        restored.finish(&started.state).await.unwrap();
        let _ = std::fs::remove_file(store_path);
    }

    #[tokio::test]
    async fn denied_callback_cannot_be_acknowledged_until_pending_state_removal_is_durable() {
        let directory =
            std::env::temp_dir().join(format!("videorc-oauth-terminal-removal-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let store_path = directory.join("pending.json");
        let sessions = OAuthSessions::new(Some(store_path.clone()));
        let started = sessions.start(start_params(), 61234).await.unwrap();

        let backup_directory = directory.with_extension("backup");
        std::fs::rename(&directory, &backup_directory).unwrap();
        std::fs::write(&directory, b"blocks pending-store directory recreation").unwrap();

        let first = sessions
            .complete_with_pending(OAuthCompleteParams {
                state: started.state.clone(),
                code: None,
                error: Some("access_denied".to_string()),
                error_description: Some("User cancelled.".to_string()),
            })
            .await;
        assert_eq!(first.result.status, OAuthCallbackStatus::Failed);
        assert!(
            sessions
                .finish_with_secret_cleanup(&started.state, |_| Ok(()))
                .await
                .is_err()
        );

        std::fs::remove_file(&directory).unwrap();
        std::fs::rename(&backup_directory, &directory).unwrap();
        let second = sessions
            .complete_with_pending(OAuthCompleteParams {
                state: started.state,
                code: None,
                error: Some("access_denied".to_string()),
                error_description: Some("User cancelled.".to_string()),
            })
            .await;
        assert!(!second.result.retryable);
        sessions
            .finish_with_secret_cleanup(&second.result.state, |_| Ok(()))
            .await
            .unwrap();
        drop(sessions);
        assert!(
            OAuthSessions::new(Some(store_path))
                .state
                .lock()
                .await
                .pending
                .is_empty()
        );
        let _ = std::fs::remove_dir_all(directory);
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
    async fn unknown_state_omits_absent_platform_from_the_wire_result() {
        let result = OAuthSessions::default()
            .complete_with_pending(OAuthCompleteParams {
                state: "unknown-provider-state".to_string(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            })
            .await
            .result;
        let wire = serde_json::to_value(result).unwrap();

        assert_eq!(wire["status"], "unknown-state");
        assert!(wire.get("platform").is_none());
        assert_eq!(wire["retryable"], false);
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

    #[tokio::test]
    async fn youtube_provider_start_is_paused_until_google_approval() {
        let sessions = OAuthSessions::default();

        let error = sessions
            .start_provider(
                OAuthStartProviderParams {
                    platform: StreamPlatform::Youtube,
                    redirect_uri: None,
                },
                61234,
            )
            .await
            .unwrap_err();

        assert!(error.to_string().contains("Google approval"));
    }

    #[test]
    fn provider_redirect_uri_allows_loopback_and_app_protocol_callbacks() {
        assert_eq!(
            provider_redirect_uri(StreamPlatform::Youtube, None, 61234).unwrap(),
            "http://127.0.0.1:61234/oauth/callback"
        );
        // Twitch's console rejects every non-HTTPS redirect EXCEPT the literal
        // http://localhost form — the default must match the registered URL.
        assert_eq!(
            provider_redirect_uri(StreamPlatform::Twitch, None, 61234).unwrap(),
            "http://localhost:61234/oauth/callback"
        );
        assert_eq!(
            provider_redirect_uri(
                StreamPlatform::Youtube,
                Some("videorc://oauth/callback"),
                61234
            )
            .unwrap(),
            "videorc://oauth/callback"
        );
        assert!(
            provider_redirect_uri(
                StreamPlatform::Youtube,
                Some("https://example.com/oauth/callback"),
                61234
            )
            .is_err()
        );
        assert!(
            provider_redirect_uri(
                StreamPlatform::Youtube,
                Some("videorc://bad/callback"),
                61234
            )
            .is_err()
        );
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
            let expected_verifier = "v".repeat(43);
            if form.get("code").map(String::as_str) != Some("auth-code")
                || form.get("client_id").map(String::as_str) != Some("client-id")
                || form.get("client_secret").map(String::as_str) != Some("client-secret")
                || form.get("code_verifier").map(String::as_str) != Some(expected_verifier.as_str())
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

        let verifier = "v".repeat(43);
        let exchange = PendingOAuthExchange {
            platform: StreamPlatform::Twitch,
            token_url: format!("http://{address}/token"),
            profile_url: format!("http://{address}/profile"),
            client_id: "client-id".to_string(),
            client_secret: Some("client-secret".to_string()),
            redirect_uri: "http://127.0.0.1:61234/oauth/callback".to_string(),
            scopes: vec!["fallback".to_string()],
            code_verifier_secret_ref: Some("fixture-pkce-ref".to_string()),
        };
        let mut batches = Vec::new();
        let account = exchange_and_store_token(
            &exchange,
            "auth-code",
            Some(&verifier),
            &reqwest::Client::new(),
            |entries| {
                batches.push(
                    entries
                        .iter()
                        .map(|(secret_ref, value)| {
                            ((*secret_ref).to_string(), (*value).to_string())
                        })
                        .collect::<Vec<_>>(),
                );
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
        let access_ref = pending_candidate_secret_ref(
            "compatibility-wrapper",
            StreamPlatform::Twitch,
            CandidateSecretKind::Access,
        );
        let refresh_ref = pending_candidate_secret_ref(
            "compatibility-wrapper",
            StreamPlatform::Twitch,
            CandidateSecretKind::Refresh,
        );
        assert_eq!(
            account.token_secret_ref.as_deref(),
            Some(access_ref.as_str())
        );
        assert_eq!(
            account.refresh_token_secret_ref.as_deref(),
            Some(refresh_ref.as_str())
        );
        assert_eq!(
            batches.len(),
            1,
            "credential candidates commit as one batch"
        );
        assert_eq!(
            batches[0],
            vec![
                (access_ref, "access-token-value".to_string()),
                (refresh_ref, "refresh-token-value".to_string())
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
                        "title": "Videorc Channel",
                        "customUrl": "@videorc",
                        "thumbnails": {
                            "high": { "url": "https://yt.example/avatar.jpg" }
                        }
                    }
                }]
            }),
        )
        .unwrap();

        assert_eq!(profile.account_id, "UC123");
        assert_eq!(profile.account_label, "Videorc Channel");
        assert_eq!(profile.account_handle.as_deref(), Some("@videorc"));
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
                    "name": "Videorc",
                    "username": "videorc",
                    "profile_image_url": "https://x.example/avatar.jpg"
                }
            }),
        )
        .unwrap();

        assert_eq!(profile.account_id, "x-123");
        assert_eq!(profile.account_label, "Videorc");
        assert_eq!(profile.account_handle.as_deref(), Some("@videorc"));
        assert_eq!(
            profile.avatar_url.as_deref(),
            Some("https://x.example/avatar.jpg")
        );
    }

    #[test]
    fn provider_credential_statuses_cover_native_platforms_without_secret_values() {
        let statuses = provider_credential_statuses();

        assert_eq!(statuses.len(), 3);
        let youtube = statuses
            .iter()
            .find(|status| status.platform == StreamPlatform::Youtube)
            .unwrap();
        assert!(youtube.pkce);
        assert!(!youtube.ready);
        assert!(youtube.message.contains("Google approval"));
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
    fn youtube_verification_config_uses_pkce_and_the_minimum_scope() {
        let config = youtube_provider_config("public-client-id".to_string());

        assert!(config.pkce);
        assert_eq!(config.client_secret, None);
        assert_eq!(
            config.scopes,
            vec!["https://www.googleapis.com/auth/youtube.force-ssl"]
        );
        assert_eq!(
            config.extra_params.get("access_type").map(String::as_str),
            Some("offline")
        );
        assert_eq!(
            config.extra_params.get("prompt").map(String::as_str),
            Some("consent")
        );
        assert!(env_flag_enabled("TRUE"));
        assert!(!env_flag_enabled("0"));
    }

    #[tokio::test]
    async fn youtube_revocation_posts_the_token_without_exposing_it_in_errors() {
        async fn revoke(Form(form): Form<HashMap<String, String>>) -> impl IntoResponse {
            if form.get("token").map(String::as_str) == Some("refresh-token-value") {
                StatusCode::OK
            } else {
                StatusCode::BAD_REQUEST
            }
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/revoke", post(revoke)))
                .await
                .unwrap();
        });

        revoke_youtube_token_at(
            "refresh-token-value",
            &reqwest::Client::new(),
            &format!("http://{address}/revoke"),
        )
        .await
        .unwrap();

        let error = revoke_youtube_token_at(
            "wrong-secret-token",
            &reqwest::Client::new(),
            &format!("http://{address}/revoke"),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("HTTP 400"));
        assert!(!error.contains("wrong-secret-token"));
    }

    #[test]
    fn provider_error_detail_preserves_google_reason_and_message() {
        let detail = provider_error_detail(
            r#"{
              "error": {
                "code": 403,
                "message": "The request cannot be completed because you have exceeded your quota.",
                "errors": [
                  {
                    "domain": "youtube.quota",
                    "reason": "quotaExceeded",
                    "message": "The request cannot be completed because you have exceeded your quota."
                  }
                ]
              }
            }"#,
        );

        assert_eq!(
            detail.as_deref(),
            Some(
                "quotaExceeded: The request cannot be completed because you have exceeded your quota."
            )
        );
    }

    #[test]
    fn oauth_token_error_detail_preserves_google_refresh_rejection() {
        let detail = oauth_token_error_detail(
            r#"{
              "error": "invalid_grant",
              "error_description": "Token has been expired or revoked."
            }"#,
        );

        assert_eq!(
            detail.as_deref(),
            Some("invalid_grant: Token has been expired or revoked.")
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
    fn non_pkce_confidential_provider_status_requires_runtime_client_secret() {
        let status = provider_credential_status(
            StreamPlatform::Twitch,
            "VIDEORC_TEST_TWITCH_CLIENT_ID",
            "VIDEORC_TEST_TWITCH_CLIENT_SECRET",
            Some("bundled-twitch-client"),
            None,
            false,
            false,
        );

        assert!(status.client_id_present);
        assert!(!status.client_secret_present);
        assert!(!status.pkce);
        assert!(!status.ready);
        assert!(status.message.contains("client secret"));
    }

    // Twitch ships as a PUBLIC client type: no secret exists, the client id
    // alone is ready (the runtime secret env still upgrades a confidential
    // setup — both smoke accounts and forks may use one).
    #[test]
    fn secret_optional_provider_is_ready_with_client_id_alone() {
        let status = provider_credential_status(
            StreamPlatform::Twitch,
            "VIDEORC_TEST_TWITCH_CLIENT_ID",
            "VIDEORC_TEST_TWITCH_CLIENT_SECRET",
            Some("bundled-twitch-client"),
            None,
            false,
            true,
        );

        assert!(status.client_id_present);
        assert!(!status.client_secret_present);
        assert!(status.ready);
        assert!(status.message.contains("bundled Videorc client ID"));
    }

    #[test]
    fn pkce_provider_status_can_be_ready_without_client_secret() {
        let status = provider_credential_status(
            StreamPlatform::X,
            "VIDEORC_TEST_X_CLIENT_ID",
            "VIDEORC_TEST_X_CLIENT_SECRET",
            Some("bundled-x-client"),
            None,
            true,
            false,
        );

        assert!(status.client_id_present);
        assert!(!status.client_secret_present);
        assert!(status.pkce);
        assert!(status.ready);
    }

    #[test]
    fn bundled_client_secret_counts_as_present() {
        let status = provider_credential_status(
            StreamPlatform::Youtube,
            "VIDEORC_TEST_YOUTUBE_CLIENT_ID",
            "VIDEORC_TEST_YOUTUBE_CLIENT_SECRET",
            Some("bundled-youtube-client"),
            Some("bundled-youtube-secret"),
            true,
            false,
        );

        assert!(status.client_secret_present);
        assert!(status.ready);
    }
}
