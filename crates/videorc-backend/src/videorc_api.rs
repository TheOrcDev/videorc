//! HTTP client for the Videorc web API (videorc.com) — the desktop account auth
//! bridge.
//!
//! Base URL: release/packaged builds are pinned to `https://www.videorc.com` so a
//! stray environment variable can never redirect the user's Bearer token at
//! another host. Dev/debug builds default to a local `videorc-web` at
//! `http://localhost:3000` and may override via `VIDEORC_API_BASE_URL`, so local
//! sign-in testing works out of the box.

use std::path::Path;

use anyhow::{Context, Result, bail};
use reqwest::multipart;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;

pub(crate) const CAPTION_CHUNK_UPLOAD_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(10);
pub(crate) const AI_CAPABILITIES_REQUEST_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(8);
const DESKTOP_AUTH_EXCHANGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// Co-host ticks are synchronous and small, but the server fans one tick out
/// across a model ladder: a slow-but-alive gateway needs headroom beyond the
/// 8 s cadence floor, while a hung tick must still become a retryable failure,
/// never a stalled engine. The scheduler never overlaps ticks, so a 12 s tick
/// simply delays the next one.
pub(crate) const COHOST_TICK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);
const COHOST_TICK_PATH: &str = "/api/ai/cohost/tick";

use crate::cohost::{
    CohostErrorDetail, CohostFlagKind, CohostFlagSeverity, CohostMood, CohostPriority,
    CohostReason, CohostTone,
};
use crate::streaming::StreamPlatform;

use crate::protocol::{
    AiCapabilities, AiJobCreateResponse, AiJobEnvelope, AiJobSnapshot, AiObjectUploadResponse,
    AiObjectUploadTicket, AiQuotaStatus,
};

// WWW is load-bearing: the apex 307-redirects every path to www.videorc.com,
// and reqwest strips Authorization on cross-host redirects — Bearer calls to
// the apex would arrive unauthenticated.
const PRODUCTION_API_BASE_URL: &str = "https://www.videorc.com";
const DEV_API_BASE_URL: &str = "http://localhost:3000";
const API_BASE_URL_ENV: &str = "VIDEORC_API_BASE_URL";

/// The effective Videorc web API base URL for this build.
pub fn api_base_url() -> String {
    resolve_api_base_url(
        cfg!(debug_assertions),
        std::env::var(API_BASE_URL_ENV).ok().as_deref(),
    )
}

fn resolve_api_base_url(dev_build: bool, env_override: Option<&str>) -> String {
    if !dev_build {
        // Packaged builds are pinned — never honor the override in production.
        return PRODUCTION_API_BASE_URL.to_string();
    }
    match env_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(url) => url.trim_end_matches('/').to_string(),
        // Dev defaults to a local videorc-web so sign-in testing is zero-config.
        None => DEV_API_BASE_URL.to_string(),
    }
}

/// The account identity + durable session token obtained by exchanging an
/// encrypted, PKCE-bound desktop authorization code.
pub struct VerifiedSession {
    pub session_token: String,
    pub name: Option<String>,
    pub email: String,
    /// Better Auth `user.image` — the account avatar (Google photo or the
    /// web-uploaded one). Absent for accounts without an avatar.
    pub image: Option<String>,
}

/// The outcome of validating the stored Bearer token via `/api/auth/get-session`.
pub struct SessionRefresh {
    pub status: SessionStatus,
    /// A rotated session token from the `set-auth-token` header, if the server
    /// refreshed it on this request.
    pub rotated_token: Option<String>,
}

pub enum SessionStatus {
    Active {
        name: Option<String>,
        email: String,
        image: Option<String>,
    },
    Unauthorized,
}

pub struct AiAudioJobRequest<'a> {
    pub audio_path: &'a Path,
    pub client_request_id: &'a str,
    pub client_version: &'a str,
    pub diagnostic_summary: Option<&'a str>,
    pub health_events_json: &'a str,
    pub session_client_id: &'a str,
    /// Per-kind generation extras; only sent when the server advertises them.
    pub outputs: Option<&'a [String]>,
    pub tone: Option<&'a str>,
    pub chat_context_json: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiObjectUploadRequest<'a> {
    pub client_request_id: &'a str,
    pub client_version: &'a str,
    pub consent_to_upload_audio: bool,
    pub file_name: &'a str,
    pub mime_type: &'a str,
    pub session_client_id: &'a str,
    pub size_bytes: u64,
    pub workflow_kind: &'a str,
}

// --- Live Co-host tick wire types (contract v1; field names are load-bearing) ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickRequest {
    pub client_version: String,
    pub session_client_id: String,
    pub tick_seq: u64,
    pub prompt_version: u32,
    pub consent_to_process_chat: bool,
    pub tone: CohostTone,
    pub notes: String,
    pub stream_title: Option<String>,
    pub open_questions: Vec<CohostTickOpenQuestion>,
    pub messages: Vec<CohostTickMessage>,
    pub dropped_messages: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickOpenQuestion {
    pub id: String,
    pub text: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickMessage {
    pub id: String,
    pub platform: StreamPlatform,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<String>>,
    pub text: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickResponse {
    #[serde(default)]
    pub prompt_version: u32,
    #[serde(default)]
    pub questions: Vec<CohostTickQuestion>,
    #[serde(default)]
    pub resolved: Vec<String>,
    #[serde(default)]
    pub flags: Vec<CohostTickFlag>,
    #[serde(default)]
    pub mood: Option<CohostMood>,
    #[serde(default)]
    pub usage: Option<CohostTickUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickQuestion {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub message_ids: Vec<String>,
    #[serde(default)]
    pub askers: Vec<String>,
    #[serde(default)]
    pub platforms: Vec<StreamPlatform>,
    #[serde(default)]
    pub priority: CohostPriority,
    #[serde(default)]
    pub suggested_reply: String,
    #[serde(default)]
    pub from_notes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickFlag {
    pub message_id: String,
    pub kind: CohostFlagKind,
    pub severity: CohostFlagSeverity,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CohostTickUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub model: String,
}

/// Every failed tick outcome: the classification the engine acts on
/// (`kind` → status/backoff, `reason()` → renderer reason) plus the server's
/// own diagnosis (`detail`) that rides `cohost.state` so "AI returned an
/// error" is never the whole story.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CohostApiError {
    pub kind: CohostApiErrorKind,
    pub detail: CohostErrorDetail,
}

/// Classified from the error envelope code first and the HTTP status second.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CohostApiErrorKind {
    /// 401: the stored bearer no longer works (session expired/rotated).
    Unauthorized,
    /// 403 `premium-required` (and any other 403: ops blocklist).
    PremiumRequired,
    /// 400 `consent-required`.
    ConsentRequired,
    /// 400 `prompt-version-unsupported`: this build is behind the server.
    PromptVersionUnsupported,
    /// 400 `invalid-request`: a desktop-side request bug (zod rejection).
    InvalidRequest,
    /// 429 `quota-exhausted` (+ Retry-After seconds when the server sent one).
    QuotaExhausted {
        retry_after: Option<std::time::Duration>,
    },
    /// 503 `ai-gateway-not-configured` | `cohost-disabled`.
    ServerUnconfigured,
    /// 502 `ai-gateway-error` and any other server failure.
    GatewayError,
    /// Transport failure (`network`) or the tick timeout (`timeout`).
    Network,
    /// 200 with a body that does not match the contract.
    MalformedResponse,
}

/// Detail codes the desktop assigns itself when no server envelope exists.
pub const COHOST_DETAIL_CODE_NETWORK: &str = "network";
pub const COHOST_DETAIL_CODE_TIMEOUT: &str = "timeout";
pub const COHOST_DETAIL_CODE_MALFORMED_RESPONSE: &str = "malformed-response";

impl CohostApiError {
    pub fn reason(&self) -> CohostReason {
        match self.kind {
            CohostApiErrorKind::Unauthorized => CohostReason::SessionExpired,
            CohostApiErrorKind::PremiumRequired => CohostReason::PremiumRequired,
            CohostApiErrorKind::ConsentRequired => CohostReason::ConsentRequired,
            CohostApiErrorKind::PromptVersionUnsupported
            | CohostApiErrorKind::ServerUnconfigured => CohostReason::ServerUnconfigured,
            CohostApiErrorKind::QuotaExhausted { .. } => CohostReason::QuotaExhausted,
            CohostApiErrorKind::InvalidRequest
            | CohostApiErrorKind::GatewayError
            | CohostApiErrorKind::MalformedResponse => CohostReason::GatewayError,
            CohostApiErrorKind::Network => CohostReason::Network,
        }
    }

    pub fn message(&self) -> &str {
        &self.detail.message
    }

    /// A transport failure before any HTTP status existed.
    pub fn network(message: impl Into<String>) -> Self {
        Self {
            kind: CohostApiErrorKind::Network,
            detail: CohostErrorDetail::new(COHOST_DETAIL_CODE_NETWORK, message, None),
        }
    }

    /// The request outlived `COHOST_TICK_TIMEOUT`.
    pub fn timeout(message: impl Into<String>) -> Self {
        Self {
            kind: CohostApiErrorKind::Network,
            detail: CohostErrorDetail::new(COHOST_DETAIL_CODE_TIMEOUT, message, None),
        }
    }

    /// A success status whose body does not match the tick contract.
    pub fn malformed_response(status: u16, message: impl Into<String>) -> Self {
        Self {
            kind: CohostApiErrorKind::MalformedResponse,
            detail: CohostErrorDetail::new(
                COHOST_DETAIL_CODE_MALFORMED_RESPONSE,
                message,
                Some(status),
            ),
        }
    }

    pub(crate) fn from_transport(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::timeout(format!(
                "The co-host service did not answer within {} s.",
                COHOST_TICK_TIMEOUT.as_secs()
            ))
        } else {
            Self::network(format!("Could not reach the co-host service: {error}"))
        }
    }
}

/// `Retry-After` as delay-seconds. HTTP-date forms are not parsed; the engine
/// falls back to its default quota pause.
pub(crate) fn parse_retry_after_seconds(value: Option<&str>) -> Option<std::time::Duration> {
    value
        .map(str::trim)
        .and_then(|value| value.parse::<u64>().ok())
        .map(std::time::Duration::from_secs)
}

pub(crate) fn classify_cohost_failure(
    status: u16,
    code: &str,
    message: String,
    retry_after: Option<&str>,
) -> CohostApiError {
    let kind = match code {
        "unauthorized" => CohostApiErrorKind::Unauthorized,
        "premium-required" => CohostApiErrorKind::PremiumRequired,
        "consent-required" => CohostApiErrorKind::ConsentRequired,
        "prompt-version-unsupported" => CohostApiErrorKind::PromptVersionUnsupported,
        "invalid-request" => CohostApiErrorKind::InvalidRequest,
        "quota-exhausted" => CohostApiErrorKind::QuotaExhausted {
            retry_after: parse_retry_after_seconds(retry_after),
        },
        "ai-gateway-not-configured" | "cohost-disabled" => CohostApiErrorKind::ServerUnconfigured,
        _ => match status {
            401 => CohostApiErrorKind::Unauthorized,
            403 => CohostApiErrorKind::PremiumRequired,
            400 => CohostApiErrorKind::InvalidRequest,
            429 => CohostApiErrorKind::QuotaExhausted {
                retry_after: parse_retry_after_seconds(retry_after),
            },
            503 => CohostApiErrorKind::ServerUnconfigured,
            _ => CohostApiErrorKind::GatewayError,
        },
    };
    CohostApiError {
        kind,
        detail: CohostErrorDetail::new(code, message, Some(status)),
    }
}

/// A thin client over the Videorc web API.
#[derive(Clone)]
pub struct VideorcApiClient {
    base_url: String,
    http: reqwest::Client,
}

impl VideorcApiClient {
    pub fn new() -> Result<Self> {
        Ok(Self {
            base_url: api_base_url(),
            http: reqwest::Client::builder()
                .user_agent(concat!("Videorc-Desktop/", env!("CARGO_PKG_VERSION")))
                .build()
                .context("Could not build the Videorc API HTTP client.")?,
        })
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}/{}", self.base_url, path.trim_start_matches('/'))
    }

    async fn get_bearer_json<T: DeserializeOwned>(
        &self,
        path: &str,
        bearer_token: &str,
    ) -> Result<T> {
        let response = self
            .http
            .get(self.endpoint(path))
            .bearer_auth(bearer_token)
            .send()
            .await
            .with_context(|| format!("Could not reach Videorc API path {path}."))?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            bail!("Sign in to use cloud AI.");
        }

        if !response.status().is_success() {
            let status = response.status();
            let message = read_safe_error_message(response).await;
            bail!("Videorc API request failed ({status}): {message}");
        }

        response
            .json()
            .await
            .with_context(|| format!("Could not read Videorc API response for {path}."))
    }

    async fn post_bearer_json<T, B>(&self, path: &str, bearer_token: &str, body: &B) -> Result<T>
    where
        T: DeserializeOwned,
        B: Serialize + ?Sized,
    {
        let response = self
            .http
            .post(self.endpoint(path))
            .bearer_auth(bearer_token)
            .json(body)
            .send()
            .await
            .with_context(|| format!("Could not reach Videorc API path {path}."))?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            bail!("Sign in to use cloud AI.");
        }

        if !response.status().is_success() {
            let status = response.status();
            let message = read_safe_error_message(response).await;
            bail!("Videorc API request failed ({status}): {message}");
        }

        response
            .json()
            .await
            .with_context(|| format!("Could not read Videorc API response for {path}."))
    }

    /// Exchange an encrypted, state + PKCE-bound desktop authorization code for
    /// a durable Better Auth session token and account identity.
    pub async fn verify_desktop_authorization(
        &self,
        code: &str,
        state: &str,
        verifier: &str,
    ) -> Result<VerifiedSession> {
        let response = self
            .http
            .post(self.endpoint("/api/desktop/session/verify"))
            .timeout(DESKTOP_AUTH_EXCHANGE_TIMEOUT)
            .json(&serde_json::json!({
                "code": code,
                "state": state,
                "verifier": verifier,
            }))
            .send()
            .await
            .context("Could not reach the Videorc sign-in service.")?;

        if !response.status().is_success() {
            bail!(
                "Desktop authorization exchange failed ({}).",
                response.status()
            );
        }

        let body: VerifyResponse = response
            .json()
            .await
            .context("Could not read the sign-in response.")?;

        Ok(VerifiedSession {
            session_token: body.session.token,
            name: body.user.name,
            email: body.user.email,
            image: body.user.image,
        })
    }

    /// Validate the stored Bearer token and fetch the current account identity.
    /// A rotated token is captured from the `set-auth-token` response header (the
    /// bearer plugin emits it when the session token is refreshed) so callers can
    /// persist it and avoid a future 401.
    pub async fn get_session(&self, bearer_token: &str) -> Result<SessionRefresh> {
        let response = self
            .http
            .get(self.endpoint("/api/auth/get-session"))
            .bearer_auth(bearer_token)
            .send()
            .await
            .context("Could not reach the Videorc session service.")?;

        let rotated_token = response
            .headers()
            .get("set-auth-token")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Ok(SessionRefresh {
                status: SessionStatus::Unauthorized,
                rotated_token,
            });
        }
        if !response.status().is_success() {
            bail!("Session check failed ({}).", response.status());
        }

        // get-session returns the session object, or null once the token is dead.
        let body: Option<GetSessionResponse> = response
            .json()
            .await
            .context("Could not read the session response.")?;

        let status = match body {
            Some(session) => SessionStatus::Active {
                name: session.user.name,
                email: session.user.email,
                image: session.user.image,
            },
            None => SessionStatus::Unauthorized,
        };
        Ok(SessionRefresh {
            status,
            rotated_token,
        })
    }

    /// Fetch safe client-facing AI capability metadata for the signed-in user.
    pub async fn get_ai_capabilities(&self, bearer_token: &str) -> Result<AiCapabilities> {
        let path = "/api/ai/capabilities";
        let response = self
            .http
            .get(self.endpoint(path))
            .bearer_auth(bearer_token)
            .timeout(AI_CAPABILITIES_REQUEST_TIMEOUT)
            .send()
            .await
            .with_context(|| format!("Could not reach Videorc API path {path}."))?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            bail!("Sign in to use cloud AI.");
        }
        if !response.status().is_success() {
            let status = response.status();
            let message = read_safe_error_message(response).await;
            bail!("Videorc API request failed ({status}): {message}");
        }
        response
            .json()
            .await
            .with_context(|| format!("Could not read Videorc API response for {path}."))
    }

    /// One synchronous Live Co-host tick. Every failure class is mapped to a
    /// `CohostApiError` so the engine can pause/back off with an honest reason.
    pub async fn post_cohost_tick(
        &self,
        bearer_token: &str,
        request: &CohostTickRequest,
    ) -> std::result::Result<CohostTickResponse, CohostApiError> {
        let response = self
            .http
            .post(self.endpoint(COHOST_TICK_PATH))
            .bearer_auth(bearer_token)
            .json(request)
            .timeout(COHOST_TICK_TIMEOUT)
            .send()
            .await
            .map_err(CohostApiError::from_transport)?;

        let status = response.status();
        if status.is_success() {
            return response.json().await.map_err(|error| {
                CohostApiError::malformed_response(
                    status.as_u16(),
                    format!("Could not read the co-host response: {error}"),
                )
            });
        }
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let (code, message) = read_error_code_and_message(response).await;
        Err(classify_cohost_failure(
            status.as_u16(),
            &code,
            message,
            retry_after.as_deref(),
        ))
    }

    /// Fetch safe client-facing AI quota metadata for the signed-in user.
    pub async fn get_ai_quota(&self, bearer_token: &str) -> Result<AiQuotaStatus> {
        self.get_bearer_json("/api/ai/quota", bearer_token).await
    }

    /// Fetch a user-owned AI job snapshot by id.
    pub async fn get_ai_job(&self, bearer_token: &str, job_id: &str) -> Result<AiJobSnapshot> {
        let response: AiJobEnvelope = self
            .get_bearer_json(&format!("/api/ai/jobs/{job_id}"), bearer_token)
            .await?;
        Ok(response.job)
    }

    /// Create a post-recording job by uploading extracted audio as multipart form data.
    pub async fn create_ai_job_from_audio(
        &self,
        bearer_token: &str,
        request: AiAudioJobRequest<'_>,
    ) -> Result<AiJobCreateResponse> {
        let audio = tokio::fs::read(request.audio_path)
            .await
            .with_context(|| format!("Could not read {}", request.audio_path.display()))?;
        let file_part = multipart::Part::bytes(audio)
            .file_name("videorc-audio.m4a")
            .mime_str("audio/mp4")?;
        let mut form = multipart::Form::new()
            .text("clientRequestId", request.client_request_id.to_string())
            .text("clientVersion", request.client_version.to_string())
            .text("consentToUploadAudio", "true")
            .text("healthEventsJson", request.health_events_json.to_string())
            .text("sessionClientId", request.session_client_id.to_string())
            .text("workflowKind", "post-recording-publish-pack")
            .part("audio", file_part);

        if let Some(summary) = request.diagnostic_summary {
            form = form.text("diagnosticSummary", summary.to_string());
        }
        if let Some(outputs) = request.outputs {
            form = form.text("outputs", outputs.join(","));
        }
        if let Some(tone) = request.tone {
            form = form.text("tone", tone.to_string());
        }
        if let Some(chat_context) = request.chat_context_json {
            form = form.text("chatContext", chat_context.to_string());
        }

        let response = self
            .http
            .post(self.endpoint("/api/ai/jobs/from-audio"))
            .bearer_auth(bearer_token)
            .multipart(form)
            .send()
            .await
            .context("Could not create the Videorc AI audio job.")?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            bail!("Sign in to use cloud AI.");
        }

        if !response.status().is_success() {
            let status = response.status();
            let message = read_safe_error_message(response).await;
            bail!("Videorc AI audio job failed ({status}): {message}");
        }

        response
            .json()
            .await
            .context("Could not read the Videorc AI audio job response.")
    }

    /// Transcribe one live-caption chunk (16kHz mono WAV, ~3s). Errors are
    /// split into terminal (premium required, quota exhausted, signed out,
    /// captions disabled — stop the session) and transient (retry/skip).
    pub async fn transcribe_caption_chunk(
        &self,
        bearer_token: &str,
        session_client_id: &str,
        wav: Vec<u8>,
        language: Option<&str>,
    ) -> std::result::Result<CaptionChunkResponse, CaptionChunkFailure> {
        let file_part = multipart::Part::bytes(wav)
            .file_name("videorc-caption-chunk.wav")
            .mime_str("audio/wav")
            .map_err(|error| CaptionChunkFailure::Transient {
                code: None,
                message: format!("Could not build the caption upload: {error}"),
            })?;
        let mut form = multipart::Form::new()
            .text("sessionClientId", session_client_id.to_string())
            .part("audio", file_part);
        if let Some(language) = language {
            form = form.text("language", language.to_string());
        }

        let response = self
            .http
            .post(self.endpoint("/api/ai/captions/chunks"))
            .bearer_auth(bearer_token)
            .multipart(form)
            // A hung upload must become a retryable failure, not a stalled
            // caption loop (R0) — chunks are ~3s of audio, 10s is generous.
            .timeout(CAPTION_CHUNK_UPLOAD_TIMEOUT)
            .send()
            .await
            .map_err(|error| CaptionChunkFailure::Transient {
                code: None,
                message: format!("Could not reach the caption service: {error}"),
            })?;

        let status = response.status();
        if status.is_success() {
            return response
                .json()
                .await
                .map_err(|error| CaptionChunkFailure::Transient {
                    code: None,
                    message: format!("Could not read the caption response: {error}"),
                });
        }

        let (code, message) = read_error_code_and_message(response).await;
        let failure = classify_caption_failure(status.as_u16(), code, message);
        Err(failure)
    }

    /// Mint a short-lived gateway realtime client secret for streaming
    /// captions. `Terminal` failures end the caption session (auth/premium/
    /// quota); `Transient` ones mean "fall back to chunked transcription".
    pub async fn mint_caption_realtime_token(
        &self,
        bearer_token: &str,
        session_client_id: &str,
    ) -> std::result::Result<CaptionRealtimeToken, CaptionChunkFailure> {
        let response = self
            .http
            .post(self.endpoint("/api/ai/captions/realtime-token"))
            .bearer_auth(bearer_token)
            .json(&serde_json::json!({ "sessionClientId": session_client_id }))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| CaptionChunkFailure::Transient {
                code: None,
                message: format!("Could not reach the caption service: {error}"),
            })?;

        let status = response.status();
        if status.is_success() {
            return response
                .json()
                .await
                .map_err(|error| CaptionChunkFailure::Transient {
                    code: None,
                    message: format!("Could not read the streaming token: {error}"),
                });
        }
        let (code, message) = read_error_code_and_message(response).await;
        Err(classify_caption_failure(status.as_u16(), code, message))
    }

    /// Report streamed caption seconds against the monthly allowance.
    /// Best-effort — accounting failures never interrupt captions.
    pub async fn report_caption_usage(
        &self,
        bearer_token: &str,
        session_client_id: &str,
        seconds: u64,
    ) -> Result<()> {
        let response = self
            .http
            .post(self.endpoint("/api/ai/captions/usage"))
            .bearer_auth(bearer_token)
            .json(&serde_json::json!({
                "sessionClientId": session_client_id,
                "seconds": seconds,
            }))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .context("Could not reach the caption usage service.")?;
        if !response.status().is_success() {
            bail!("Caption usage report failed ({}).", response.status());
        }
        Ok(())
    }

    pub async fn request_ai_object_upload(
        &self,
        bearer_token: &str,
        request: &AiObjectUploadRequest<'_>,
    ) -> Result<AiObjectUploadResponse> {
        self.post_bearer_json("/api/ai/objects/upload", bearer_token, request)
            .await
    }

    pub async fn upload_ai_object(
        &self,
        ticket: &AiObjectUploadTicket,
        audio_path: &Path,
    ) -> Result<()> {
        let audio = tokio::fs::read(audio_path)
            .await
            .with_context(|| format!("Could not read {}", audio_path.display()))?;
        let method = match ticket.upload_method.as_str() {
            "POST" => reqwest::Method::POST,
            "PUT" => reqwest::Method::PUT,
            other => bail!("Unsupported AI object upload method: {other}"),
        };
        let mut request = self.http.request(method, &ticket.upload_url).body(audio);
        for (key, value) in &ticket.upload_headers {
            request = request.header(key, value);
        }

        let response = request
            .send()
            .await
            .context("Could not upload the Videorc AI input object.")?;
        if !response.status().is_success() {
            bail!("Videorc AI object upload failed ({}).", response.status());
        }
        Ok(())
    }

    pub async fn create_ai_job(
        &self,
        bearer_token: &str,
        body: &serde_json::Value,
    ) -> Result<AiJobCreateResponse> {
        self.post_bearer_json("/api/ai/jobs", bearer_token, body)
            .await
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionChunkResponse {
    pub text: String,
    pub chunk_seconds: u64,
    pub remaining_seconds: u64,
    #[allow(dead_code)]
    pub monthly_seconds_limit: u64,
    #[serde(default)]
    #[allow(dead_code)]
    pub latency_ms: Option<u64>,
    #[allow(dead_code)]
    pub model: String,
    /// Word timing within this chunk (empty on older web deploys).
    #[serde(default)]
    pub segments: Vec<crate::captions::CaptionSegment>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionRealtimeToken {
    pub token: String,
    pub url: String,
    #[serde(default)]
    pub expires_at: Option<u64>,
    pub model: String,
    #[serde(default)]
    pub remaining_seconds: Option<u64>,
}

#[derive(Debug, Clone)]
pub enum CaptionChunkFailure {
    /// Stop the caption session and surface the reason (premium required,
    /// quota exhausted, signed out, captions disabled).
    Terminal { code: String, message: String },
    /// Skip this chunk; the session keeps going (network blip, 5xx).
    Transient {
        code: Option<String>,
        message: String,
    },
}

fn classify_caption_failure(status: u16, code: String, message: String) -> CaptionChunkFailure {
    let terminal = matches!(
        code.as_str(),
        "cloud-ai-premium-required"
            | "captions-monthly-quota-exhausted"
            | "ai-user-disabled"
            | "ai-disabled"
            | "ai-transcription-not-configured"
            | "captions-config-missing"
            | "unauthorized"
    ) || status == 401
        || status == 403
        || status == 429;
    if terminal {
        CaptionChunkFailure::Terminal { code, message }
    } else {
        CaptionChunkFailure::Transient {
            code: Some(code),
            message: format!("caption chunk failed ({status}): {message}"),
        }
    }
}

async fn read_error_code_and_message(response: reqwest::Response) -> (String, String) {
    let text = response.text().await.unwrap_or_default();
    parse_error_envelope(&text)
}

/// `{ error: { code, message } }` → `(code, message)` with honest fallbacks:
/// `unknown` / `request failed` when the body is not the envelope (HTML from
/// a proxy, an empty body, a different JSON shape) or a part is blank.
pub(crate) fn parse_error_envelope(text: &str) -> (String, String) {
    #[derive(Deserialize)]
    struct ErrorEnvelope {
        error: Option<ErrorBody>,
    }

    #[derive(Deserialize)]
    struct ErrorBody {
        code: Option<String>,
        message: Option<String>,
    }

    let body = serde_json::from_str::<ErrorEnvelope>(text)
        .ok()
        .and_then(|envelope| envelope.error);
    (
        body.as_ref()
            .and_then(|error| error.code.as_deref())
            .map(str::trim)
            .filter(|code| !code.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| "unknown".to_string()),
        body.and_then(|error| error.message)
            .map(|message| message.trim().to_string())
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| "request failed".to_string()),
    )
}

async fn read_safe_error_message(response: reqwest::Response) -> String {
    #[derive(Deserialize)]
    struct ErrorEnvelope {
        error: Option<ErrorBody>,
    }

    #[derive(Deserialize)]
    struct ErrorBody {
        message: Option<String>,
    }

    match response.text().await {
        Ok(text) => serde_json::from_str::<ErrorEnvelope>(&text)
            .ok()
            .and_then(|envelope| envelope.error.and_then(|error| error.message))
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| "request failed".to_string()),
        Err(_) => "request failed".to_string(),
    }
}

#[derive(Deserialize)]
struct VerifyResponse {
    session: VerifySession,
    user: VerifyUser,
}

#[derive(Deserialize)]
struct VerifySession {
    token: String,
}

#[derive(Deserialize)]
struct VerifyUser {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    image: Option<String>,
    email: String,
}

#[derive(Deserialize)]
struct GetSessionResponse {
    user: VerifyUser,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_builds_pin_the_production_base_url() {
        assert_eq!(
            resolve_api_base_url(false, Some("http://localhost:3000")),
            PRODUCTION_API_BASE_URL
        );
        assert_eq!(resolve_api_base_url(false, None), PRODUCTION_API_BASE_URL);
    }

    #[test]
    fn dev_builds_default_to_localhost_and_honor_the_env_override() {
        assert_eq!(
            resolve_api_base_url(true, Some("http://localhost:3000/")),
            "http://localhost:3000"
        );
        assert_eq!(resolve_api_base_url(true, Some("   ")), DEV_API_BASE_URL);
        assert_eq!(resolve_api_base_url(true, None), DEV_API_BASE_URL);
    }

    #[test]
    fn entitlement_capability_request_finishes_before_the_rpc_deadline() {
        assert!(!AI_CAPABILITIES_REQUEST_TIMEOUT.is_zero());
        // Headroom over the 8 s cadence floor (a model ladder can take longer),
        // but well under the updater/RPC deadlines; see cohost.rs for the
        // min-gap interaction test.
        assert_eq!(COHOST_TICK_TIMEOUT.as_secs(), 12);
        assert!(AI_CAPABILITIES_REQUEST_TIMEOUT < std::time::Duration::from_secs(10));
    }

    #[test]
    fn endpoint_joins_paths_without_double_slashes() {
        let client = VideorcApiClient {
            base_url: "https://videorc.com".to_string(),
            http: reqwest::Client::new(),
        };
        assert_eq!(
            client.endpoint("/api/auth/one-time-token/verify"),
            "https://videorc.com/api/auth/one-time-token/verify"
        );
        assert_eq!(
            client.endpoint("api/ai/capabilities"),
            "https://videorc.com/api/ai/capabilities"
        );
    }

    #[test]
    fn verify_response_parses_the_session_token_and_user_identity() {
        let json = r#"{"session":{"token":"sess_abc","expiresAt":"2026-07-01T00:00:00Z"},"user":{"id":"u1","name":"Orc Dev","email":"orc@videorc.com"}}"#;
        let parsed: VerifyResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.session.token, "sess_abc");
        assert_eq!(parsed.user.email, "orc@videorc.com");
        assert_eq!(parsed.user.name.as_deref(), Some("Orc Dev"));
    }

    #[test]
    fn ai_capabilities_response_parses_safe_metadata() {
        let json = r#"{
            "entitlement":{"checkedAt":"2026-06-15T12:00:00.000Z","cloudAi":true,"expiresAt":"2026-06-15T12:05:00.000Z","isPremium":true,"subscriptionStatus":"active","tier":"premium"},
            "features":{"cloudAiEnabled":true,"gatewayConfigured":true,"modelTestingEnabled":true,"multipartAudioJobsEnabled":true,"objectBackedJobsEnabled":false,"transcriptJobsEnabled":true,"uploadTicketsEnabled":false},
            "generatedAt":"2026-06-15T12:30:00.000Z",
            "limits":{"dailyJobs":25,"maxAudioBytes":13107200,"maxAudioMegabytes":12.5,"maxOutputTokens":1900,"maxTranscriptCharacters":90000,"monthlyJobs":600},
            "models":{"allowedTextModelCount":2,"allowedTextModelsConfigured":true,"defaultTextModel":"openai/gpt-5.5","fallbackTextModels":["google/gemini"]},
            "objectStorage":{"deleteConfigured":false,"downloadConfigured":false,"provider":null,"providerError":null,"proofConfigured":false,"proofTtlMs":null,"uploadConfigured":false},
            "readiness":{"access":{"cloudAiEntitled":true,"globallyDisabled":false},"gateway":{"configError":null,"configured":true},"objectStorage":{"deleteConfigError":null,"downloadConfigError":null,"proofConfigError":null,"providerError":null,"uploadConfigError":null},"transcription":{"configError":null,"configured":true}},
            "transcription":{"configured":true,"configError":null,"maxAudioBytes":13107200,"maxAudioMegabytes":12.5,"requestTimeoutMs":65000},
            "workflow":{"inputModes":[{"enabled":true,"kind":"transcript"},{"enabled":true,"kind":"multipart-audio"}],"kind":"post-recording-publish-pack","outputs":["summary"]}
        }"#;
        let parsed: AiCapabilities = serde_json::from_str(json).unwrap();
        assert!(parsed.features.cloud_ai_enabled);
        assert_eq!(parsed.workflow.input_modes[1].kind, "multipart-audio");
        assert_eq!(parsed.limits.max_audio_megabytes, Some(12.5));
        assert!(
            parsed.captions.is_none(),
            "older web deployments remain compatible during rollout"
        );
    }

    #[test]
    fn ai_capabilities_captions_readiness_survives_proxy_round_trip() {
        let input = serde_json::json!({
            "captions": {
                "available": true,
                "chunked": {
                    "available": true,
                    "configured": true,
                    "model": "xai/grok-stt"
                },
                "monthlySecondsLimit": 180000,
                "preferredTransport": "realtime",
                "realtime": {
                    "available": true,
                    "configured": true,
                    "disabled": false,
                    "model": "xai/grok-voice-think-fast-1.0"
                },
                "remainingSeconds": 179940,
                "reasonCode": "ready-realtime"
            },
            "entitlement": {
                "checkedAt": "2026-07-11T12:00:00.000Z",
                "cloudAi": true,
                "expiresAt": "2026-07-11T12:05:00.000Z",
                "isPremium": true,
                "subscriptionStatus": "active",
                "tier": "premium"
            },
            "features": {
                "cloudAiEnabled": true,
                "gatewayConfigured": true,
                "modelTestingEnabled": true,
                "multipartAudioJobsEnabled": true,
                "objectBackedJobsEnabled": false,
                "transcriptJobsEnabled": true,
                "uploadTicketsEnabled": false
            },
            "generatedAt": "2026-07-11T12:00:00.000Z",
            "limits": {
                "dailyJobs": 25,
                "maxAudioBytes": 13107200,
                "maxAudioMegabytes": 12.5,
                "maxOutputTokens": 1900,
                "maxTranscriptCharacters": 90000,
                "monthlyJobs": 600
            },
            "models": {
                "allowedTextModelCount": 2,
                "allowedTextModelsConfigured": true,
                "defaultTextModel": "openai/gpt-5.5",
                "fallbackTextModels": ["google/gemini"]
            },
            "objectStorage": {
                "deleteConfigured": false,
                "downloadConfigured": false,
                "provider": null,
                "providerError": null,
                "proofConfigured": false,
                "proofTtlMs": null,
                "uploadConfigured": false
            },
            "readiness": {
                "access": { "cloudAiEntitled": true, "globallyDisabled": false },
                "gateway": { "configError": null, "configured": true },
                "objectStorage": {
                    "deleteConfigError": null,
                    "downloadConfigError": null,
                    "proofConfigError": null,
                    "providerError": null,
                    "uploadConfigError": null
                },
                "transcription": { "configError": null, "configured": true }
            },
            "transcription": {
                "configured": true,
                "configError": null,
                "maxAudioBytes": 13107200,
                "maxAudioMegabytes": 12.5,
                "requestTimeoutMs": 65000
            },
            "workflow": {
                "inputModes": [{ "enabled": true, "kind": "multipart-audio" }],
                "kind": "post-recording-publish-pack",
                "outputs": ["summary"]
            }
        });

        let parsed: AiCapabilities = serde_json::from_value(input.clone()).unwrap();
        let proxied = serde_json::to_value(parsed).unwrap();

        assert_eq!(
            proxied["captions"], input["captions"],
            "the Rust proxy must preserve the complete readiness contract"
        );
    }

    #[test]
    fn ai_quota_response_parses_blocked_access() {
        let json = r#"{
            "access":{"allowed":false,"code":"ai-daily-quota-exhausted","message":"Daily AI quota exhausted.","status":429},
            "entitlement":{"cancelAtPeriodEnd":false,"checkedAt":"2026-06-15T12:00:00.000Z","cloudAi":true,"currentPeriodEnd":"2026-07-15T00:00:00.000Z","expiresAt":"2026-06-15T12:05:00.000Z","isPremium":true,"subscriptionStatus":"active","tier":"premium"},
            "generatedAt":"2026-06-15T23:30:00.000Z",
            "monthly":{"limit":50,"remaining":38,"resetAt":"2026-07-01T00:00:00.000Z","used":12},
            "today":{"limit":2,"remaining":0,"resetAt":"2026-06-16T00:00:00.000Z","used":2}
        }"#;
        let parsed: AiQuotaStatus = serde_json::from_str(json).unwrap();
        assert!(!parsed.access.allowed);
        assert_eq!(
            parsed.access.code.as_deref(),
            Some("ai-daily-quota-exhausted")
        );
        assert_eq!(parsed.today.remaining, 0);
    }

    #[test]
    fn missing_chunk_transcription_config_is_terminal_not_an_infinite_retry() {
        let failure = classify_caption_failure(
            503,
            "ai-transcription-not-configured".to_string(),
            "Live captions are not configured.".to_string(),
        );
        assert!(matches!(
            failure,
            CaptionChunkFailure::Terminal { code, .. }
                if code == "ai-transcription-not-configured"
        ));
    }

    #[test]
    fn realtime_unavailable_remains_eligible_for_chunk_fallback() {
        let failure = classify_caption_failure(
            503,
            "captions-realtime-unavailable".to_string(),
            "Streaming captions are unavailable.".to_string(),
        );
        assert!(matches!(
            failure,
            CaptionChunkFailure::Transient { code: Some(code), .. }
                if code == "captions-realtime-unavailable"
        ));
    }

    #[test]
    fn realtime_kill_switch_remains_eligible_for_chunk_fallback() {
        let failure = classify_caption_failure(
            503,
            "captions-realtime-disabled".to_string(),
            "Streaming captions are temporarily disabled; chunked captions remain available."
                .to_string(),
        );
        assert!(matches!(
            failure,
            CaptionChunkFailure::Transient { code: Some(code), .. }
                if code == "captions-realtime-disabled"
        ));
    }

    #[test]
    fn cohost_failures_classify_by_envelope_code_then_status() {
        use CohostApiErrorKind as Kind;
        let cases: Vec<(u16, &str, Option<&str>, Kind, CohostReason)> = vec![
            (
                401,
                "unauthorized",
                None,
                Kind::Unauthorized,
                CohostReason::SessionExpired,
            ),
            (
                403,
                "premium-required",
                None,
                Kind::PremiumRequired,
                CohostReason::PremiumRequired,
            ),
            (
                400,
                "consent-required",
                None,
                Kind::ConsentRequired,
                CohostReason::ConsentRequired,
            ),
            (
                400,
                "prompt-version-unsupported",
                None,
                Kind::PromptVersionUnsupported,
                CohostReason::ServerUnconfigured,
            ),
            (
                400,
                "invalid-request",
                None,
                Kind::InvalidRequest,
                CohostReason::GatewayError,
            ),
            (
                429,
                "quota-exhausted",
                Some("120"),
                Kind::QuotaExhausted {
                    retry_after: Some(std::time::Duration::from_secs(120)),
                },
                CohostReason::QuotaExhausted,
            ),
            (
                429,
                "unknown",
                Some("Wed, 21 Oct 2026 07:28:00 GMT"),
                Kind::QuotaExhausted { retry_after: None },
                CohostReason::QuotaExhausted,
            ),
            (
                503,
                "ai-gateway-not-configured",
                None,
                Kind::ServerUnconfigured,
                CohostReason::ServerUnconfigured,
            ),
            (
                503,
                "cohost-disabled",
                None,
                Kind::ServerUnconfigured,
                CohostReason::ServerUnconfigured,
            ),
            (
                502,
                "ai-gateway-error",
                None,
                Kind::GatewayError,
                CohostReason::GatewayError,
            ),
            (
                500,
                "unknown",
                None,
                Kind::GatewayError,
                CohostReason::GatewayError,
            ),
            // Ops blocklist: any unknown 403 code is the premium-required class.
            (
                403,
                "ai-user-disabled",
                None,
                Kind::PremiumRequired,
                CohostReason::PremiumRequired,
            ),
            // Status-only fallbacks when the envelope carries no known code.
            (
                401,
                "unknown",
                None,
                Kind::Unauthorized,
                CohostReason::SessionExpired,
            ),
            (
                403,
                "unknown",
                None,
                Kind::PremiumRequired,
                CohostReason::PremiumRequired,
            ),
        ];
        for (status, code, retry_after, kind, reason) in cases {
            let actual = classify_cohost_failure(status, code, "m".to_string(), retry_after);
            assert_eq!(actual.kind, kind, "{status} {code}");
            assert_eq!(actual.reason(), reason, "{status} {code}");
            // The server's own words survive classification verbatim: the
            // raw envelope code (even when the class came from the status),
            // the message, and the HTTP status.
            assert_eq!(
                actual.detail,
                CohostErrorDetail {
                    code: code.to_string(),
                    message: "m".to_string(),
                    status: Some(status),
                },
                "{status} {code}"
            );
            assert_eq!(actual.message(), "m");
        }
        assert_eq!(
            parse_retry_after_seconds(Some(" 42 ")),
            Some(std::time::Duration::from_secs(42))
        );
        assert_eq!(parse_retry_after_seconds(Some("soon")), None);
        assert_eq!(parse_retry_after_seconds(None), None);
    }

    #[test]
    fn cohost_error_envelope_parse_keeps_code_and_message_with_honest_fallbacks() {
        // The 2026-08-23 incident shape: web mis-parsed the gateway reply and
        // answered 502 with this envelope; the desktop must carry both parts.
        assert_eq!(
            parse_error_envelope(
                r#"{"error":{"code":"ai-gateway-error","message":"The co-host tick failed on every configured model."}}"#
            ),
            (
                "ai-gateway-error".to_string(),
                "The co-host tick failed on every configured model.".to_string()
            )
        );
        assert_eq!(
            parse_error_envelope(
                r#"{"error":{"code":"quota-exhausted","message":"  Try later. "}}"#
            ),
            ("quota-exhausted".to_string(), "Try later.".to_string())
        );
        // Missing or blank parts fall back one at a time.
        assert_eq!(
            parse_error_envelope(r#"{"error":{"code":"ai-gateway-error"}}"#),
            ("ai-gateway-error".to_string(), "request failed".to_string())
        );
        assert_eq!(
            parse_error_envelope(r#"{"error":{"code":"  ","message":"Upstream exploded."}}"#),
            ("unknown".to_string(), "Upstream exploded.".to_string())
        );
        assert_eq!(
            parse_error_envelope(r#"{"error":{"message":""}}"#),
            ("unknown".to_string(), "request failed".to_string())
        );
        // Not the envelope at all: a proxy HTML page, an empty body, other JSON.
        for body in ["<html>502 Bad Gateway</html>", "", r#"{"ok":false}"#, "[]"] {
            assert_eq!(
                parse_error_envelope(body),
                ("unknown".to_string(), "request failed".to_string()),
                "{body:?}"
            );
        }
    }

    #[test]
    fn cohost_desktop_side_failures_carry_their_own_detail_codes() {
        let network = CohostApiError::network("Could not reach the co-host service: dns");
        assert_eq!(network.kind, CohostApiErrorKind::Network);
        assert_eq!(network.reason(), CohostReason::Network);
        assert_eq!(network.detail.code, COHOST_DETAIL_CODE_NETWORK);
        assert_eq!(network.detail.status, None);

        let timeout = CohostApiError::timeout("The co-host service did not answer within 12 s.");
        assert_eq!(timeout.kind, CohostApiErrorKind::Network);
        assert_eq!(timeout.reason(), CohostReason::Network);
        assert_eq!(timeout.detail.code, COHOST_DETAIL_CODE_TIMEOUT);
        assert_eq!(timeout.detail.status, None);
        assert_eq!(
            timeout.message(),
            "The co-host service did not answer within 12 s."
        );

        let malformed =
            CohostApiError::malformed_response(200, "Could not read the co-host response: EOF");
        assert_eq!(malformed.kind, CohostApiErrorKind::MalformedResponse);
        assert_eq!(malformed.reason(), CohostReason::GatewayError);
        assert_eq!(malformed.detail.code, COHOST_DETAIL_CODE_MALFORMED_RESPONSE);
        assert_eq!(malformed.detail.status, Some(200));
    }

    #[test]
    fn cohost_tick_response_tolerates_missing_optional_fields() {
        let response: CohostTickResponse = serde_json::from_str(
            r#"{"promptVersion":1,"questions":[{"id":"q_1","text":"What keyboard?"}],"mood":"calm"}"#,
        )
        .unwrap();
        assert_eq!(response.questions.len(), 1);
        assert_eq!(response.questions[0].priority, CohostPriority::Normal);
        assert!(response.questions[0].message_ids.is_empty());
        assert_eq!(response.mood, Some(CohostMood::Calm));
        assert!(response.resolved.is_empty());
        assert!(response.flags.is_empty());
        assert!(response.usage.is_none());
    }
}
