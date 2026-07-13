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
    #[derive(Deserialize)]
    struct ErrorEnvelope {
        error: Option<ErrorBody>,
    }

    #[derive(Deserialize)]
    struct ErrorBody {
        code: Option<String>,
        message: Option<String>,
    }

    let parsed = match response.text().await {
        Ok(text) => serde_json::from_str::<ErrorEnvelope>(&text).ok(),
        Err(_) => None,
    };
    let body = parsed.and_then(|envelope| envelope.error);
    (
        body.as_ref()
            .and_then(|error| error.code.clone())
            .unwrap_or_else(|| "unknown".to_string()),
        body.and_then(|error| error.message)
            .filter(|message| !message.trim().is_empty())
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
}
