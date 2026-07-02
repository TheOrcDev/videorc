mod account;
mod ai;
mod audio;
mod camera_capture;
mod captions;
mod capture_input;
mod color;
mod compositor;
mod compositor_synthetic;
mod devices;
mod diagnostics;
mod encoder_bridge;
mod entitlements;
mod ffmpeg;
mod ffmpeg_work;
mod fifo;
mod frame_store;
mod live_chat;
mod live_layout;
mod live_pipeline;
mod live_render;
mod live_scene;
mod metal_compositor;
mod mpeg_ts;
mod native_preview_host;
mod oauth;
mod pipeline;
mod preflight;
mod preview_camera;
mod preview_screen;
mod preview_surface;
mod protocol;
mod recording;
mod repair;
mod repair_service;
mod scene;
mod screen_capture;
mod secrets;
mod source_registry;
mod source_status;
mod state;
mod storage;
mod streaming;
mod support_bundle;
mod synthetic_diagnostic;
mod twitch;
mod twitch_chat;
#[cfg(target_os = "macos")]
mod video_toolbox_encoder;
mod videorc_api;
mod x_chat;
mod x_live;
mod youtube;
mod youtube_chat;

use std::convert::Infallible;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{StatusCode, header};
use axum::response::Html;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use compositor::{compositor_status, update_compositor_active_screen, update_compositor_scene};
use encoder_bridge::run_synthetic_encoder_bridge;
use futures_util::stream;
use futures_util::{SinkExt, StreamExt};
use preview_camera::{
    latest_preview_camera_png, preview_camera_status, start_preview_camera, stop_preview_camera,
};
use preview_screen::{
    latest_preview_screen_png, preview_screen_status, start_preview_screen, stop_preview_screen,
};
use preview_surface::{
    create_preview_surface, destroy_preview_surface, preview_surface_status,
    register_preview_surface_resize, take_native_preview_host_commands,
    update_preview_surface_bounds, update_preview_surface_present,
};
use protocol::{
    BackendConnection, BackendHealth, ClientCommand, RecordingState, ServerEvent, ServerResponse,
    ToolStatus,
};
use recording::{
    create_preview_snapshot, idle_status, live_preview_status, preview_file_path, remux_session,
    resume_pending_repair_jobs, shutdown_capture_processes, start_live_preview, start_session,
    stop_live_preview, stop_recording, subscribe_live_preview_frames, update_preview_frame_age,
};
use scene::{
    nudge_source, reorder_sources, reset_source_transform, scene_from_capture_config,
    update_source_transform, update_source_visibility,
};
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::sync::{broadcast, mpsc};
use tokio::time::timeout;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use crate::ffmpeg::{default_ffmpeg_path, resolve_ffmpeg_path_ref};
use crate::oauth::{OAuthCompleteParams, OAuthStartParams, OAuthStartProviderParams};
use crate::preflight::GoLivePreflightParams;
use crate::state::AppState;
use crate::storage::Database;
use crate::streaming::{
    ManualStreamKeyPlan, ManualStreamKeyRefParams, PlatformAccountStatus,
    PlatformAccountValidation, PlatformAccountValidationState, StoreManualStreamKeyParams,
    StoreManualStreamKeyResult, StreamMetadataDraft, StreamPlatform, UpsertPlatformAccount,
    manual_stream_key_previous_secret_ref, manual_stream_key_secret_ref, manual_stream_key_state,
    plan_manual_stream_key_restore, plan_manual_stream_key_store, validate_stream_metadata_draft,
};
use crate::twitch::{
    PreparedTwitchBroadcast, TwitchCategorySearchParams, TwitchCategorySearchRequest,
    TwitchCategorySearchResult, TwitchPrepareParams, TwitchPrepareRequest,
};
use crate::x_live::{XNativeLiveCapability, XNativeLiveCapabilityParams, XPrepareParams};
use crate::youtube::{PreparedYouTubeBroadcast, YouTubePrepareParams, YouTubePrepareRequest};
use crate::youtube::{
    YouTubeBroadcastTransitionParams, YouTubeBroadcastTransitionRequest,
    YouTubeBroadcastTransitionResult,
};
use crate::youtube::{
    YouTubeChannelListParams, YouTubeChannelListRequest, YouTubeChannelListResult,
    YouTubeChannelSelectParams, YouTubeStreamStatusParams, YouTubeStreamStatusRequest,
    YouTubeStreamStatusResult,
};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("videorc_backend=info".parse()?),
        )
        .with_writer(std::io::stderr)
        .init();
    spawn_orphan_watchdog_thread();
    secrets::init_native_secret_store();

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    // OAuth callbacks need a DETERMINISTIC loopback URI: providers like X match
    // redirect URIs exactly (port included), which the random main port can
    // never satisfy. Bind a dedicated well-known port for them.
    let oauth_listener = bind_oauth_callback_listener().await;
    let oauth_callback_port = oauth_listener
        .as_ref()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port());
    let token = Uuid::new_v4().to_string();
    let (events, _) = broadcast::channel(256);
    let database = Database::open_default()?;
    let mut state = AppState::new(token.clone(), port, events, database);
    state.oauth_callback_port = oauth_callback_port;
    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/preview/live.mjpeg", get(live_preview_handler))
        .route("/preview/live.jpg", get(live_preview_frame_handler))
        .route("/preview/camera/live.png", get(live_camera_frame_handler))
        .route("/preview/screen/live.png", get(live_screen_frame_handler))
        .route("/preview/{id}", get(preview_handler))
        .route("/compositor/status", get(compositor_status_handler))
        .route("/oauth/callback", get(oauth_callback_handler))
        .route("/ws", get(ws_handler))
        .with_state(state.clone());

    let ready = backend_connection(port, token);
    println!("READY {}", serde_json::to_string(&ready)?);
    std::io::stdout().flush()?;

    state.emit_log("info", "Videorc backend ready.");
    match (oauth_listener, oauth_callback_port) {
        (Some(oauth_listener), Some(oauth_port)) => {
            let oauth_app = Router::new()
                .route("/oauth/callback", get(oauth_callback_handler))
                .with_state(state.clone());
            state.emit_log(
                "info",
                format!("OAuth callback listener bound on 127.0.0.1:{oauth_port}."),
            );
            tokio::spawn(async move {
                if let Err(error) = axum::serve(oauth_listener, oauth_app).await {
                    tracing::warn!("OAuth callback listener failed: {error}");
                }
            });
        }
        _ => {
            state.emit_log(
                "warn",
                format!(
                    "All OAuth callback ports {OAUTH_CALLBACK_PORT_CANDIDATES:?} are busy; \
                     OAuth redirects fall back to the dynamic main port, which exact-match \
                     providers (X) will reject."
                ),
            );
        }
    }
    // Resume interrupted repair jobs through the idle-only maintenance queue.
    tokio::spawn(resume_pending_repair_jobs(state.clone()));
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(state.clone()))
        .await?;
    Ok(())
}

async fn shutdown_signal(state: AppState) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};

        let mut terminate = signal(SignalKind::terminate()).ok();
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if let Err(error) = result {
                    state.emit_log("warn", format!("Could not listen for Ctrl-C shutdown: {error}"));
                }
            }
            _ = async {
                if let Some(signal) = terminate.as_mut() {
                    signal.recv().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {}
            _ = orphaned_by_parent_exit() => {
                state.emit_log(
                    "warn",
                    "Parent process exited; shutting down so capture devices (camera/mic/screen) are released.",
                );
            }
        }
    }

    #[cfg(not(unix))]
    {
        if let Err(error) = tokio::signal::ctrl_c().await {
            state.emit_log(
                "warn",
                format!("Could not listen for shutdown signal: {error}"),
            );
        }
    }

    state.emit_log(
        "info",
        "Backend shutdown requested; stopping capture processes.",
    );
    shutdown_capture_processes(state).await;
}

/// A dedicated OS thread that kills this process when its parent dies. This MUST be
/// a plain thread, not a tokio task: the async watchdog variant below failed in the
/// field because a wedged runtime stops polling exactly when the process most needs
/// to die. Orphaned backends hold the camera/microphone/ScreenCaptureKit and starve
/// fresh app instances (screen layers fall to the synthetic pattern mid-session).
///
/// Unix-only by design. On Windows the supervisor assigns the backend to a Job
/// Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the OS tears the backend
/// (and its ffmpeg children) down when Electron exits — a stronger guarantee than
/// PID polling. See docs/windows-port-plan.md, Phase 1.
fn spawn_orphan_watchdog_thread() {
    #[cfg(unix)]
    {
        // The ppid==1 check alone misses the dev process chain (electron -> cargo
        // -> backend): killing Electron leaves cargo alive as our parent, and the
        // backend survived as a "zombie with a living parent". The supervisor pid
        // (the Electron main process) closes that hole: when it is gone, we go.
        let supervisor_pid = std::env::var("VIDEORC_SUPERVISOR_PID")
            .ok()
            .and_then(|value| value.trim().parse::<i32>().ok())
            .filter(|pid| *pid > 1);
        std::thread::spawn(move || {
            loop {
                let orphaned = std::os::unix::process::parent_id() == 1;
                let supervisor_gone = supervisor_pid.is_some_and(|pid| {
                    let result = unsafe { libc::kill(pid, 0) };
                    result == -1
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                });
                if orphaned || supervisor_gone {
                    // Give the async graceful path a moment, then exit
                    // unconditionally; process teardown releases every capture
                    // device.
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    eprintln!(
                        "{} died; exiting so capture devices are released.",
                        if orphaned {
                            "Parent process"
                        } else {
                            "Supervisor process"
                        }
                    );
                    std::process::exit(1);
                }
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        });
    }
}

fn backend_connection(port: u16, token: String) -> BackendConnection {
    BackendConnection {
        host: "127.0.0.1".to_string(),
        port,
        token,
        pid: std::process::id(),
        parent_pid: current_parent_pid(),
    }
}

#[cfg(unix)]
fn current_parent_pid() -> Option<u32> {
    Some(std::os::unix::process::parent_id())
}

#[cfg(not(unix))]
fn current_parent_pid() -> Option<u32> {
    None
}

/// Resolves when this process is orphaned (its parent died and launchd adopted it).
/// The Electron app normally stops the backend on quit, but force-quits and crashes
/// skip that path — an orphaned backend used to keep the camera/microphone/screen
/// capture running indefinitely (the "camera light stays on" bug).
///
/// Before returning, arm a HARD exit: the graceful path (stop captures, drain axum)
/// can itself wedge — orphans were observed alive minutes after triggering — and an
/// orphan that lingers holds devices and confuses fresh app instances. Ten seconds
/// of grace for cleanup, then the process is gone unconditionally.
#[cfg(unix)]
async fn orphaned_by_parent_exit() {
    loop {
        if std::os::unix::process::parent_id() == 1 {
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_secs(10));
                eprintln!("Orphaned backend cleanup overran its grace period; exiting hard.");
                std::process::exit(1);
            });
            return;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsQuery {
    token: String,
    #[serde(default)]
    max_width: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OAuthCallbackQuery {
    state: String,
    code: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

async fn health_handler(State(state): State<AppState>) -> Json<BackendHealth> {
    let ffmpeg_path = default_ffmpeg_path();
    Json(backend_health(&state, &ffmpeg_path).await)
}

async fn compositor_status_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
) -> impl IntoResponse {
    if query.token != state.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    Json(compositor_status(&state).await).into_response()
}

async fn preview_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    if query.token != state.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    if !id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return StatusCode::BAD_REQUEST.into_response();
    }

    match tokio::fs::read(preview_file_path(&id)).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn live_preview_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
) -> Response {
    if query.token != state.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    diagnostics::PREVIEW_POLL_COUNTS.record_live_mjpeg();
    let receiver = subscribe_live_preview_frames(&state);
    let stream = stream::unfold(receiver, |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(chunk) => {
                    return Some((Ok::<Bytes, Infallible>(Bytes::from(chunk)), receiver));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });

    Response::builder()
        .header(
            header::CONTENT_TYPE,
            "multipart/x-mixed-replace; boundary=videorc",
        )
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn live_camera_frame_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
) -> Response {
    if query.token != state.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    diagnostics::PREVIEW_POLL_COUNTS.record_camera_png();
    match latest_preview_camera_png(&state, query.max_width).await {
        Some(bytes) => (
            [
                (header::CONTENT_TYPE, "image/png"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn live_screen_frame_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
) -> Response {
    if query.token != state.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    diagnostics::PREVIEW_POLL_COUNTS.record_screen_png();
    match latest_preview_screen_png(&state, query.max_width).await {
        Some(bytes) => (
            [
                (header::CONTENT_TYPE, "image/png"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn live_preview_frame_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
) -> Response {
    if query.token != state.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    diagnostics::PREVIEW_POLL_COUNTS.record_live_jpeg();
    match state.preview_latest_frame.read().await.clone() {
        Some(frame) => {
            update_preview_frame_age(
                &state,
                frame.sequence,
                frame.published_at.elapsed().as_millis() as u64,
            )
            .await;
            (
                [
                    (header::CONTENT_TYPE, "image/jpeg"),
                    (header::CACHE_CONTROL, "no-store, no-cache, must-revalidate"),
                    (header::PRAGMA, "no-cache"),
                    (header::EXPIRES, "0"),
                ],
                frame.bytes,
            )
                .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn oauth_callback_handler(
    State(state): State<AppState>,
    Query(query): Query<OAuthCallbackQuery>,
) -> impl IntoResponse {
    let result = complete_oauth_callback(
        &state,
        OAuthCompleteParams {
            state: query.state,
            code: query.code,
            error: query.error,
            error_description: query.error_description,
        },
    )
    .await;
    state.emit_event("platformAccounts.oauth.callback", result.clone());

    let title = match result.status {
        oauth::OAuthCallbackStatus::Success => "Videorc OAuth received",
        oauth::OAuthCallbackStatus::Failed => "Videorc OAuth failed",
        oauth::OAuthCallbackStatus::Expired => "Videorc OAuth expired",
        oauth::OAuthCallbackStatus::UnknownState => "Videorc OAuth state not found",
    };
    Html(format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>\
         <body><h1>{title}</h1><p>You can return to Videorc.</p></body></html>"
    ))
}

async fn complete_oauth_callback(
    state: &AppState,
    params: OAuthCompleteParams,
) -> oauth::OAuthCallbackResult {
    let outcome = state.oauth.complete_with_pending(params).await;
    let mut result = outcome.result;
    let Some(exchange) = outcome.exchange else {
        return result;
    };
    let Some(code) = outcome.authorization_code else {
        return result;
    };

    match oauth::exchange_and_store_token(
        &exchange,
        &code,
        &reqwest::Client::new(),
        secrets::put_secret,
    )
    .await
    {
        Ok(account) => match state.database.upsert_platform_account(account) {
            Ok(_) => {
                result.token_stored = true;
                result.account_connected = true;
                if let Ok(accounts) = state.database.list_platform_accounts() {
                    state.emit_event("platformAccounts.changed", accounts);
                }
            }
            Err(error) => {
                result.status = oauth::OAuthCallbackStatus::Failed;
                result.message = Some(format!("OAuth account storage failed: {error}"));
            }
        },
        Err(error) => {
            result.status = oauth::OAuthCallbackStatus::Failed;
            result.message = Some(format!("OAuth token exchange failed: {error}"));
        }
    }

    result
}

struct FreshPlatformAccessToken {
    access_token: String,
    account: streaming::PlatformAccount,
    refreshed: bool,
}

async fn fresh_platform_access_token(
    state: &AppState,
    credential: &storage::PlatformAccountCredentials,
    client: &reqwest::Client,
) -> Result<FreshPlatformAccessToken> {
    let access_ref = credential
        .token_secret_ref
        .as_deref()
        .context("No OAuth access token is stored for this account.")?;
    let access_token = secrets::get_secret(access_ref).context("Could not read access token.")?;
    if should_refresh_platform_access_token(&credential.account) {
        return refresh_platform_access_token(state, credential, access_ref, client).await;
    }

    Ok(FreshPlatformAccessToken {
        access_token,
        account: credential.account.clone(),
        refreshed: false,
    })
}

async fn refresh_platform_access_token(
    state: &AppState,
    credential: &storage::PlatformAccountCredentials,
    access_ref: &str,
    client: &reqwest::Client,
) -> Result<FreshPlatformAccessToken> {
    let refresh_ref = credential
        .refresh_token_secret_ref
        .as_deref()
        .context("No OAuth refresh token is stored for this account.")?;
    let refresh_token =
        secrets::get_secret(refresh_ref).context("Could not read OAuth refresh token.")?;
    let token =
        oauth::refresh_provider_token(credential.account.platform, &refresh_token, client).await?;

    persist_refreshed_platform_access_token(state, credential, access_ref, refresh_ref, token)
}

fn persist_refreshed_platform_access_token(
    state: &AppState,
    credential: &storage::PlatformAccountCredentials,
    access_ref: &str,
    refresh_ref: &str,
    token: oauth::RefreshedOAuthToken,
) -> Result<FreshPlatformAccessToken> {
    secrets::put_secret(access_ref, &token.access_token)
        .context("Could not store refreshed OAuth access token.")?;
    if let Some(next_refresh_token) = token.refresh_token.as_deref() {
        secrets::put_secret(refresh_ref, next_refresh_token)
            .context("Could not store refreshed OAuth refresh token.")?;
    }

    let mut account = credential.account.clone();
    account.scopes = token.scopes;
    account.expires_at = token.expires_at;
    account.status = PlatformAccountStatus::Connected;
    upsert_validated_account(state, credential, account.clone())?;
    if let Ok(accounts) = state.database.list_platform_accounts() {
        state.emit_event("platformAccounts.changed", accounts);
    }

    Ok(FreshPlatformAccessToken {
        access_token: token.access_token,
        account,
        refreshed: true,
    })
}

fn should_refresh_platform_access_token(account: &streaming::PlatformAccount) -> bool {
    token_expires_soon(account.expires_at.as_deref())
        || account.status == PlatformAccountStatus::NeedsReconnect
}

fn should_keep_account_connected_after_validation_error(
    platform: StreamPlatform,
    error: &anyhow::Error,
) -> bool {
    if platform != StreamPlatform::Youtube {
        return false;
    }

    let message = error.to_string();
    message.contains("quotaExceeded") || is_temporary_provider_validation_error(&message)
}

fn is_temporary_provider_validation_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("could not fetch")
        || normalized.contains("http 429")
        || normalized.contains("http 500")
        || normalized.contains("http 502")
        || normalized.contains("http 503")
        || normalized.contains("http 504")
        || normalized.contains("ratelimitexceeded")
        || normalized.contains("backenderror")
        || normalized.contains("internalerror")
        || normalized.contains("temporarily unavailable")
}

fn should_force_account_reconnect_after_token_error(error: &anyhow::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("no oauth access token")
        || message.contains("no oauth refresh token")
        || message.contains("could not read oauth refresh token")
        || message.contains("could not read access token")
        || message.contains("refresh token is empty")
        || message.contains("invalid_grant")
        || message.contains("invalid grant")
        || message.contains("expired or revoked")
        || message.contains("invalid refresh token")
        || message.contains("refresh token has been revoked")
}

fn platform_validation_after_token_error(
    account: &mut streaming::PlatformAccount,
    error: &anyhow::Error,
) -> PlatformAccountValidation {
    if should_force_account_reconnect_after_token_error(error) {
        account.status = PlatformAccountStatus::NeedsReconnect;
        return platform_validation(
            account,
            PlatformAccountValidationState::NeedsReconnect,
            error.to_string(),
        );
    }

    platform_validation(
        account,
        match account.status {
            PlatformAccountStatus::NeedsReconnect => PlatformAccountValidationState::NeedsReconnect,
            _ => PlatformAccountValidationState::Valid,
        },
        format!("Account token is stored, but provider refresh is temporarily blocked: {error}"),
    )
}

async fn refresh_platform_access_token_after_auth_error(
    state: &AppState,
    credential: &storage::PlatformAccountCredentials,
    client: &reqwest::Client,
    access_error: &anyhow::Error,
) -> Result<FreshPlatformAccessToken> {
    let access_ref = credential
        .token_secret_ref
        .as_deref()
        .context("No OAuth access token is stored for this account.")?;

    match refresh_platform_access_token(state, credential, access_ref, client).await {
        Ok(fresh) => Ok(fresh),
        Err(refresh_error) => {
            let mut account = credential.account.clone();
            account.status = PlatformAccountStatus::NeedsReconnect;
            let _ = upsert_validated_account(state, credential, account);
            if let Ok(accounts) = state.database.list_platform_accounts() {
                state.emit_event("platformAccounts.changed", accounts);
            }
            anyhow::bail!("{access_error}; token refresh retry failed: {refresh_error}");
        }
    }
}

async fn validate_platform_accounts(state: &AppState) -> Vec<PlatformAccountValidation> {
    let credentials = match state.database.list_platform_account_credentials() {
        Ok(credentials) => credentials,
        Err(error) => {
            return vec![PlatformAccountValidation {
                platform: streaming::StreamPlatform::Custom,
                state: PlatformAccountValidationState::NeedsReconnect,
                account_id: None,
                account_label: None,
                scopes: Vec::new(),
                expires_at: None,
                message: format!("Could not load platform accounts: {error}"),
            }];
        }
    };
    let client = reqwest::Client::new();
    let mut changed = false;
    let mut validations = Vec::new();

    for credential in credentials {
        let mut account = credential.account.clone();
        let Some(access_ref) = credential.token_secret_ref.as_deref() else {
            account.status = PlatformAccountStatus::NeedsReconnect;
            changed |= upsert_validated_account(state, &credential, account.clone()).is_ok();
            validations.push(platform_validation(
                &account,
                PlatformAccountValidationState::NeedsReconnect,
                "No access token is stored for this account.",
            ));
            continue;
        };

        let mut fresh = match fresh_platform_access_token(state, &credential, &client).await {
            Ok(fresh) => fresh,
            Err(error) => {
                let validation = platform_validation_after_token_error(&mut account, &error);
                changed |= upsert_validated_account(state, &credential, account.clone()).is_ok();
                validations.push(validation);
                continue;
            }
        };
        account = fresh.account.clone();
        changed |= fresh.refreshed;

        let mut validation =
            oauth::validate_provider_access(account.platform, &fresh.access_token, &client).await;
        if validation.is_err() && !fresh.refreshed {
            let validation_error = validation.expect_err("checked above");
            match refresh_platform_access_token(state, &credential, access_ref, &client).await {
                Ok(refreshed) => {
                    fresh = refreshed;
                    account = fresh.account.clone();
                    changed = true;
                    validation = oauth::validate_provider_access(
                        account.platform,
                        &fresh.access_token,
                        &client,
                    )
                    .await;
                }
                Err(refresh_error) => {
                    account.status = PlatformAccountStatus::NeedsReconnect;
                    changed |=
                        upsert_validated_account(state, &credential, account.clone()).is_ok();
                    validations.push(platform_validation(
                        &account,
                        PlatformAccountValidationState::NeedsReconnect,
                        format!(
                            "Account validation failed: {validation_error}; token refresh retry failed: {refresh_error}"
                        ),
                    ));
                    continue;
                }
            }
        }

        match validation {
            Ok(()) => {
                account.status = PlatformAccountStatus::Connected;
                changed |= upsert_validated_account(state, &credential, account.clone()).is_ok();
                validations.push(platform_validation(
                    &account,
                    if fresh.refreshed {
                        PlatformAccountValidationState::Refreshed
                    } else {
                        PlatformAccountValidationState::Valid
                    },
                    if fresh.refreshed {
                        "Token refreshed and account access is valid."
                    } else {
                        "Account access is valid."
                    },
                ));
            }
            Err(error) => {
                if should_keep_account_connected_after_validation_error(account.platform, &error) {
                    account.status = PlatformAccountStatus::Connected;
                    changed |=
                        upsert_validated_account(state, &credential, account.clone()).is_ok();
                    validations.push(platform_validation(
                        &account,
                        if fresh.refreshed {
                            PlatformAccountValidationState::Refreshed
                        } else {
                            PlatformAccountValidationState::Valid
                        },
                        format!(
                            "Account token is stored, but provider validation is temporarily blocked: {error}"
                        ),
                    ));
                    continue;
                }

                account.status = PlatformAccountStatus::NeedsReconnect;
                changed |= upsert_validated_account(state, &credential, account.clone()).is_ok();
                validations.push(platform_validation(
                    &account,
                    PlatformAccountValidationState::NeedsReconnect,
                    format!("Account validation failed: {error}"),
                ));
            }
        }
    }

    if changed && let Ok(accounts) = state.database.list_platform_accounts() {
        state.emit_event("platformAccounts.changed", accounts);
    }

    validations
}

async fn prepare_youtube_stream_target(
    state: &AppState,
    params: YouTubePrepareParams,
) -> anyhow::Result<PreparedYouTubeBroadcast> {
    let metadata = state.database.stream_metadata_draft()?;
    let validation = validate_stream_metadata_draft(&metadata);
    if !validation.valid {
        let message = validation
            .issues
            .first()
            .map(|issue| issue.message.as_str())
            .unwrap_or("Stream metadata is invalid.");
        anyhow::bail!("{message}");
    }

    let credential = youtube_account_credentials(state, params.account_id.as_deref())?;
    let client = reqwest::Client::new();
    let mut fresh = fresh_platform_access_token(state, &credential, &client).await?;
    let video = params.video;
    let mut prepared = youtube::prepare_youtube_broadcast(
        YouTubePrepareRequest {
            access_token: fresh.access_token.clone(),
            account_id: fresh.account.account_id.clone(),
            account_label: fresh.account.account_label.clone(),
            metadata: metadata.clone(),
            video: video.clone(),
            api_base_url: None,
            scheduled_start_time: None,
        },
        &client,
        secrets::put_secret,
    )
    .await;
    if let Err(error) = prepared.as_ref()
        && !fresh.refreshed
        && youtube::is_youtube_auth_error(error)
        && error
            .to_string()
            .contains("YouTube broadcast creation failed")
    {
        fresh = refresh_platform_access_token_after_auth_error(state, &credential, &client, error)
            .await?;
        prepared = youtube::prepare_youtube_broadcast(
            YouTubePrepareRequest {
                access_token: fresh.access_token.clone(),
                account_id: fresh.account.account_id.clone(),
                account_label: fresh.account.account_label.clone(),
                metadata,
                video,
                api_base_url: None,
                scheduled_start_time: None,
            },
            &client,
            secrets::put_secret,
        )
        .await;
    }
    let prepared = prepared?;

    state
        .database
        .upsert_platform_account(UpsertPlatformAccount {
            platform: fresh.account.platform,
            account_id: fresh.account.account_id,
            account_label: fresh.account.account_label,
            account_handle: fresh.account.account_handle,
            avatar_url: fresh.account.avatar_url,
            scopes: fresh.account.scopes,
            token_secret_ref: credential.token_secret_ref,
            refresh_token_secret_ref: credential.refresh_token_secret_ref,
            stream_key_secret_ref: Some(prepared.stream_key_secret_ref.clone()),
            expires_at: fresh.account.expires_at,
            status: PlatformAccountStatus::Connected,
        })?;
    if let Ok(accounts) = state.database.list_platform_accounts() {
        state.emit_event("platformAccounts.changed", accounts);
    }

    Ok(prepared)
}

async fn transition_youtube_stream_target(
    state: &AppState,
    params: YouTubeBroadcastTransitionParams,
) -> anyhow::Result<YouTubeBroadcastTransitionResult> {
    let credential = youtube_account_credentials(state, params.account_id.as_deref())?;
    let client = reqwest::Client::new();
    let mut fresh = fresh_platform_access_token(state, &credential, &client).await?;
    let mut transition = youtube::transition_youtube_broadcast(
        YouTubeBroadcastTransitionRequest {
            access_token: fresh.access_token.clone(),
            account_id: fresh.account.account_id.clone(),
            broadcast_id: params.broadcast_id.clone(),
            status: params.status,
            api_base_url: None,
        },
        &client,
    )
    .await;
    if let Err(error) = transition.as_ref()
        && !fresh.refreshed
        && youtube::is_youtube_auth_error(error)
    {
        fresh = refresh_platform_access_token_after_auth_error(state, &credential, &client, error)
            .await?;
        transition = youtube::transition_youtube_broadcast(
            YouTubeBroadcastTransitionRequest {
                access_token: fresh.access_token,
                account_id: fresh.account.account_id,
                broadcast_id: params.broadcast_id,
                status: params.status,
                api_base_url: None,
            },
            &client,
        )
        .await;
    }
    transition
}

async fn youtube_stream_status(
    state: &AppState,
    params: YouTubeStreamStatusParams,
) -> anyhow::Result<YouTubeStreamStatusResult> {
    let credential = youtube_account_credentials(state, params.account_id.as_deref())?;
    let client = reqwest::Client::new();
    let mut fresh = fresh_platform_access_token(state, &credential, &client).await?;
    let mut status = youtube::get_youtube_stream_status(
        YouTubeStreamStatusRequest {
            access_token: fresh.access_token.clone(),
            account_id: fresh.account.account_id.clone(),
            stream_id: params.stream_id.clone(),
            api_base_url: None,
        },
        &client,
    )
    .await;
    if let Err(error) = status.as_ref()
        && !fresh.refreshed
        && youtube::is_youtube_auth_error(error)
    {
        fresh = refresh_platform_access_token_after_auth_error(state, &credential, &client, error)
            .await?;
        status = youtube::get_youtube_stream_status(
            YouTubeStreamStatusRequest {
                access_token: fresh.access_token,
                account_id: fresh.account.account_id,
                stream_id: params.stream_id,
                api_base_url: None,
            },
            &client,
        )
        .await;
    }
    status
}

async fn list_youtube_channels(
    state: &AppState,
    params: YouTubeChannelListParams,
) -> anyhow::Result<YouTubeChannelListResult> {
    let credential = youtube_account_credentials(state, params.account_id.as_deref())?;
    let client = reqwest::Client::new();
    let mut fresh = fresh_platform_access_token(state, &credential, &client).await?;
    let mut channels = youtube::list_youtube_channels(
        YouTubeChannelListRequest {
            access_token: fresh.access_token.clone(),
            account_id: fresh.account.account_id.clone(),
            api_base_url: None,
        },
        &client,
    )
    .await;
    if let Err(error) = channels.as_ref()
        && !fresh.refreshed
        && youtube::is_youtube_auth_error(error)
    {
        fresh = refresh_platform_access_token_after_auth_error(state, &credential, &client, error)
            .await?;
        channels = youtube::list_youtube_channels(
            YouTubeChannelListRequest {
                access_token: fresh.access_token,
                account_id: fresh.account.account_id,
                api_base_url: None,
            },
            &client,
        )
        .await;
    }
    channels
}

async fn select_youtube_channel_account(
    state: &AppState,
    params: YouTubeChannelSelectParams,
) -> anyhow::Result<crate::streaming::PlatformAccount> {
    let credential = youtube_account_credentials(state, params.account_id.as_deref())?;
    let client = reqwest::Client::new();
    let mut fresh = fresh_platform_access_token(state, &credential, &client).await?;
    let mut channels = youtube::list_youtube_channels(
        YouTubeChannelListRequest {
            access_token: fresh.access_token.clone(),
            account_id: fresh.account.account_id.clone(),
            api_base_url: None,
        },
        &client,
    )
    .await;
    if let Err(error) = channels.as_ref()
        && !fresh.refreshed
        && youtube::is_youtube_auth_error(error)
    {
        fresh = refresh_platform_access_token_after_auth_error(state, &credential, &client, error)
            .await?;
        channels = youtube::list_youtube_channels(
            YouTubeChannelListRequest {
                access_token: fresh.access_token.clone(),
                account_id: fresh.account.account_id.clone(),
                api_base_url: None,
            },
            &client,
        )
        .await;
    }
    let channels = channels?;
    let selected = youtube::select_youtube_channel(&channels.channels, &params.channel_id)?;
    let stream_key_secret_ref = if selected.channel_id == credential.account.account_id {
        credential.stream_key_secret_ref
    } else {
        None
    };

    let account = state
        .database
        .upsert_platform_account(UpsertPlatformAccount {
            platform: StreamPlatform::Youtube,
            account_id: selected.channel_id,
            account_label: selected.title,
            account_handle: selected.handle,
            avatar_url: selected.avatar_url,
            scopes: fresh.account.scopes,
            token_secret_ref: credential.token_secret_ref,
            refresh_token_secret_ref: credential.refresh_token_secret_ref,
            stream_key_secret_ref,
            expires_at: fresh.account.expires_at,
            status: fresh.account.status,
        })?;
    if let Ok(accounts) = state.database.list_platform_accounts() {
        state.emit_event("platformAccounts.changed", accounts);
    }

    Ok(account)
}

fn youtube_account_credentials(
    state: &AppState,
    account_id: Option<&str>,
) -> anyhow::Result<storage::PlatformAccountCredentials> {
    state
        .database
        .list_platform_account_credentials()?
        .into_iter()
        .find(|credential| {
            credential.account.platform == StreamPlatform::Youtube
                && account_id.is_none_or(|account_id| {
                    credential.account.account_id == account_id
                        || credential.account.id == account_id
                })
        })
        .context("No connected YouTube OAuth account is available.")
}

/// Build the YouTube chat connector config for an enabled OAuth destination (slice 8).
async fn youtube_chat_config(
    state: &AppState,
    target: &crate::streaming::StreamTargetSettings,
) -> Result<youtube_chat::YouTubeChatConfig> {
    let credential = youtube_account_credentials(state, target.account_id.as_deref())?;
    let client = reqwest::Client::new();
    let fresh = fresh_platform_access_token(state, &credential, &client).await?;
    Ok(youtube_chat::YouTubeChatConfig {
        access_token: fresh.access_token,
        live_chat_id: None,
        broadcast_id: target.platform_broadcast_id.clone(),
        target_id: Some(target.id.clone()),
        api_base_url: None,
    })
}

/// Build the Twitch chat connector config for an enabled OAuth destination (slice 8).
fn twitch_chat_config(
    state: &AppState,
    target: &crate::streaming::StreamTargetSettings,
) -> Result<twitch_chat::TwitchChatConfig> {
    let credential = twitch_account_credentials(state, target.account_id.as_deref())?;
    let access_ref = credential
        .token_secret_ref
        .as_deref()
        .context("No Twitch access token is stored.")?;
    let access_token = secrets::get_secret(access_ref)?;
    let client_id = oauth::provider_client_id(StreamPlatform::Twitch)?;
    Ok(twitch_chat::TwitchChatConfig {
        access_token,
        client_id,
        broadcaster_user_id: credential.account.account_id.clone(),
        user_id: credential.account.account_id.clone(),
        target_id: Some(target.id.clone()),
        eventsub_ws_url: None,
        api_base_url: None,
    })
}

/// Start live chat for a freshly-started session: spawn a connector per enabled OAuth
/// destination whose token resolves. Chat failures are logged, never propagated — a chat
/// problem must not fail the stream (slice 8). One destination's failure leaves others alone.
async fn spawn_session_live_chat(
    state: &AppState,
    session_id: &str,
    streaming: &crate::streaming::StreamingSettings,
) {
    use std::collections::HashSet;
    let enabled: HashSet<&str> = streaming
        .enabled_target_ids
        .iter()
        .map(String::as_str)
        .collect();
    let mut params = live_chat::LiveChatStartParams {
        session_id: session_id.to_string(),
        fake: None,
        youtube: None,
        twitch: None,
    };
    for target in &streaming.targets {
        if !enabled.contains(target.id.as_str())
            || target.auth_mode != crate::streaming::StreamAuthMode::Oauth
        {
            continue;
        }
        match target.platform {
            StreamPlatform::Youtube => match youtube_chat_config(state, target).await {
                Ok(config) => params.youtube = Some(config),
                Err(error) => {
                    state.emit_log("warn", format!("YouTube live chat unavailable: {error}"))
                }
            },
            StreamPlatform::Twitch => match twitch_chat_config(state, target) {
                Ok(config) => params.twitch = Some(config),
                Err(error) => {
                    state.emit_log("warn", format!("Twitch live chat unavailable: {error}"))
                }
            },
            _ => {}
        }
    }
    if params.youtube.is_some() || params.twitch.is_some() {
        live_chat::start_live_chat(state, params).await;
    }
}

/// Well-known loopback ports for the OAuth callback listener, tried in order.
/// These are part of the provider-app contract: register ALL of them as
/// `http://127.0.0.1:<port>/oauth/callback` callback URLs in each provider's
/// developer portal so one busy port cannot break OAuth.
const OAUTH_CALLBACK_PORT_CANDIDATES: [u16; 3] = [17995, 27995, 37995];

async fn bind_oauth_callback_listener() -> Option<TcpListener> {
    for candidate in OAUTH_CALLBACK_PORT_CANDIDATES {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", candidate)).await {
            return Some(listener);
        }
    }
    None
}

/// Reads both manual-key slots for a target (current, previous).
fn manual_stream_key_slots(target_id: &str) -> Result<(Option<String>, Option<String>)> {
    let secret_ref = manual_stream_key_secret_ref(target_id)?;
    let previous_ref = manual_stream_key_previous_secret_ref(target_id)?;
    Ok((
        secrets::try_get_secret(&secret_ref)?,
        secrets::try_get_secret(&previous_ref)?,
    ))
}

/// Writes both slots to match a plan (delete when the slot empties).
fn apply_manual_stream_key_plan(target_id: &str, plan: &ManualStreamKeyPlan) -> Result<()> {
    let secret_ref = manual_stream_key_secret_ref(target_id)?;
    let previous_ref = manual_stream_key_previous_secret_ref(target_id)?;
    match plan.next_current.as_deref() {
        Some(value) => secrets::put_secret(&secret_ref, value)?,
        None => secrets::delete_secret(&secret_ref)?,
    }
    match plan.next_previous.as_deref() {
        Some(value) => secrets::put_secret(&previous_ref, value)?,
        None => secrets::delete_secret(&previous_ref)?,
    }
    Ok(())
}

fn store_manual_stream_key(
    params: StoreManualStreamKeyParams,
) -> Result<StoreManualStreamKeyResult> {
    let (current, previous) = manual_stream_key_slots(&params.target_id)?;
    let plan =
        plan_manual_stream_key_store(current.as_deref(), previous.as_deref(), &params.stream_key);
    apply_manual_stream_key_plan(&params.target_id, &plan)?;
    manual_stream_key_state(
        &params.target_id,
        plan.next_current.as_deref(),
        plan.next_previous.as_deref(),
    )
}

fn restore_previous_manual_stream_key(
    params: ManualStreamKeyRefParams,
) -> Result<StoreManualStreamKeyResult> {
    let (current, previous) = manual_stream_key_slots(&params.target_id)?;
    let plan = plan_manual_stream_key_restore(current.as_deref(), previous.as_deref())?;
    apply_manual_stream_key_plan(&params.target_id, &plan)?;
    manual_stream_key_state(
        &params.target_id,
        plan.next_current.as_deref(),
        plan.next_previous.as_deref(),
    )
}

/// Read-only view so the UI can show hints for keys saved before it loaded.
fn inspect_manual_stream_key(
    params: ManualStreamKeyRefParams,
) -> Result<StoreManualStreamKeyResult> {
    let (current, previous) = manual_stream_key_slots(&params.target_id)?;
    manual_stream_key_state(&params.target_id, current.as_deref(), previous.as_deref())
}

async fn search_twitch_categories(
    state: &AppState,
    params: TwitchCategorySearchParams,
) -> anyhow::Result<TwitchCategorySearchResult> {
    let credential = twitch_account_credentials(state, params.account_id.as_deref())?;
    let access_ref = credential
        .token_secret_ref
        .as_deref()
        .context("No Twitch access token is stored.")?;
    let access_token = secrets::get_secret(access_ref)?;
    let client_id = oauth::provider_client_id(StreamPlatform::Twitch)?;

    twitch::search_twitch_categories(
        TwitchCategorySearchRequest {
            access_token,
            client_id,
            query: params.query,
            first: params.first,
            api_base_url: None,
        },
        &reqwest::Client::new(),
    )
    .await
}

async fn prepare_twitch_stream_target(
    state: &AppState,
    params: TwitchPrepareParams,
) -> anyhow::Result<PreparedTwitchBroadcast> {
    let metadata = state.database.stream_metadata_draft()?;
    let validation = validate_stream_metadata_draft(&metadata);
    if !validation.valid {
        let message = validation
            .issues
            .first()
            .map(|issue| issue.message.as_str())
            .unwrap_or("Stream metadata is invalid.");
        anyhow::bail!("{message}");
    }

    let credential = twitch_account_credentials(state, params.account_id.as_deref())?;
    let access_ref = credential
        .token_secret_ref
        .as_deref()
        .context("No Twitch access token is stored.")?;
    let access_token = secrets::get_secret(access_ref)?;
    let client_id = oauth::provider_client_id(StreamPlatform::Twitch)?;

    let prepared = twitch::prepare_twitch_broadcast(
        TwitchPrepareRequest {
            access_token,
            client_id,
            account_id: credential.account.account_id.clone(),
            account_label: credential.account.account_label.clone(),
            metadata,
            api_base_url: None,
        },
        &reqwest::Client::new(),
        secrets::put_secret,
    )
    .await?;

    state
        .database
        .upsert_platform_account(UpsertPlatformAccount {
            platform: credential.account.platform,
            account_id: credential.account.account_id,
            account_label: credential.account.account_label,
            account_handle: credential.account.account_handle,
            avatar_url: credential.account.avatar_url,
            scopes: credential.account.scopes,
            token_secret_ref: credential.token_secret_ref,
            refresh_token_secret_ref: credential.refresh_token_secret_ref,
            stream_key_secret_ref: Some(prepared.stream_key_secret_ref.clone()),
            expires_at: credential.account.expires_at,
            status: PlatformAccountStatus::Connected,
        })?;
    if let Ok(accounts) = state.database.list_platform_accounts() {
        state.emit_event("platformAccounts.changed", accounts);
    }

    Ok(prepared)
}

fn twitch_account_credentials(
    state: &AppState,
    account_id: Option<&str>,
) -> anyhow::Result<storage::PlatformAccountCredentials> {
    state
        .database
        .list_platform_account_credentials()?
        .into_iter()
        .find(|credential| {
            credential.account.platform == StreamPlatform::Twitch
                && account_id.is_none_or(|account_id| {
                    credential.account.account_id == account_id
                        || credential.account.id == account_id
                })
        })
        .context("No connected Twitch OAuth account is available.")
}

fn x_native_live_capability(
    state: &AppState,
    params: XNativeLiveCapabilityParams,
) -> anyhow::Result<XNativeLiveCapability> {
    let accounts = state.database.list_platform_accounts()?;
    let account = x_live::select_x_account(&accounts, params.account_id.as_deref())?;
    Ok(x_live::x_native_live_capability(account))
}

fn prepare_x_native_live(state: &AppState, params: XPrepareParams) -> anyhow::Result<()> {
    let capability = x_native_live_capability(
        state,
        XNativeLiveCapabilityParams {
            account_id: params.account_id,
        },
    )?;
    x_live::ensure_x_native_live_available(&capability)
}

fn upsert_validated_account(
    state: &AppState,
    credential: &storage::PlatformAccountCredentials,
    account: streaming::PlatformAccount,
) -> anyhow::Result<streaming::PlatformAccount> {
    state
        .database
        .upsert_platform_account(UpsertPlatformAccount {
            platform: account.platform,
            account_id: account.account_id,
            account_label: account.account_label,
            account_handle: account.account_handle,
            avatar_url: account.avatar_url,
            scopes: account.scopes,
            token_secret_ref: credential.token_secret_ref.clone(),
            refresh_token_secret_ref: credential.refresh_token_secret_ref.clone(),
            stream_key_secret_ref: credential.stream_key_secret_ref.clone(),
            expires_at: account.expires_at,
            status: account.status,
        })
}

fn platform_validation(
    account: &streaming::PlatformAccount,
    state: PlatformAccountValidationState,
    message: impl Into<String>,
) -> PlatformAccountValidation {
    PlatformAccountValidation {
        platform: account.platform,
        state,
        account_id: Some(account.account_id.clone()),
        account_label: Some(account.account_label.clone()),
        scopes: account.scopes.clone(),
        expires_at: account.expires_at.clone(),
        message: message.into(),
    }
}

fn token_expires_soon(expires_at: Option<&str>) -> bool {
    let Some(expires_at) = expires_at else {
        return false;
    };
    chrono::DateTime::parse_from_rfc3339(expires_at)
        .map(|expires_at| {
            expires_at.with_timezone(&chrono::Utc)
                <= chrono::Utc::now() + chrono::Duration::minutes(5)
        })
        .unwrap_or(true)
}

/// Handles connection-scoped control commands ("events.setExcluded") that
/// mutate this socket's event filter instead of shared app state. Returns None
/// for everything else so the regular dispatcher runs.
fn handle_connection_control(
    excluded_events: &std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    text: &str,
) -> Option<ServerResponse> {
    let command: serde_json::Value = serde_json::from_str(text).ok()?;
    if command.get("method").and_then(|method| method.as_str()) != Some("events.setExcluded") {
        return None;
    }
    let id = command
        .get("id")
        .and_then(|id| id.as_str())
        .unwrap_or_default()
        .to_string();
    let events: std::collections::HashSet<String> = command
        .get("params")
        .and_then(|params| params.get("events"))
        .and_then(|events| events.as_array())
        .map(|events| {
            events
                .iter()
                .filter_map(|event| event.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let excluded: Vec<String> = {
        let mut guard = excluded_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = events;
        let mut list: Vec<String> = guard.iter().cloned().collect();
        list.sort();
        list
    };
    Some(ServerResponse::ok(
        id,
        serde_json::json!({ "excluded": excluded }),
    ))
}

async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if query.token != state.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    ws.on_upgrade(move |socket| websocket_session(socket, state))
        .into_response()
}

async fn websocket_session(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut events = state.events.subscribe();
    let (outgoing_tx, mut outgoing_rx) = mpsc::unbounded_channel::<String>();
    let event_tx = outgoing_tx.clone();
    // Per-connection event exclusions: the renderer mutes the 60Hz
    // compositor.status firehose while the main process drives presents
    // (receiving+decoding those frames leaked Blink buffers at ~1.5MB/s), and
    // unmutes instantly when it must take over as the fallback pump.
    let excluded_events: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
    let exclusions = excluded_events.clone();

    tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            let muted = exclusions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains(&event.event);
            if muted {
                continue;
            }
            match serde_json::to_string(&event) {
                Ok(text) => {
                    if event_tx.send(text).is_err() {
                        break;
                    }
                }
                Err(error) => tracing::error!("Could not serialize event: {error}"),
            }
        }
    });

    let ready_event = ServerEvent::new(
        "backend.ready",
        backend_connection(state.port, state.token.clone()),
    );
    if let Ok(text) = serde_json::to_string(&ready_event) {
        let _ = sender.send(Message::Text(text.into())).await;
    }

    loop {
        tokio::select! {
            Some(text) = outgoing_rx.recv() => {
                if sender.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
            incoming = receiver.next() => {
                let Some(incoming) = incoming else {
                    break;
                };

                match incoming {
                    Ok(Message::Text(text)) => {
                        // Connection-local control messages never reach the
                        // shared dispatcher (the exclusion set is per socket).
                        let response = match handle_connection_control(&excluded_events, text.as_str()) {
                            Some(response) => response,
                            None => handle_text_message(&state, text.as_str()).await,
                        };
                        match serde_json::to_string(&response) {
                            Ok(text) => {
                                if sender.send(Message::Text(text.into())).await.is_err() {
                                    break;
                                }
                            }
                            Err(error) => tracing::error!("Could not serialize response: {error}"),
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(Message::Ping(payload)) => {
                        let _ = sender.send(Message::Pong(payload)).await;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!("WebSocket receive error: {error}");
                        break;
                    }
                }
            }
        }
    }
}

async fn handle_text_message(state: &AppState, text: &str) -> ServerResponse {
    let command = match serde_json::from_str::<ClientCommand>(text) {
        Ok(command) => command,
        Err(error) => {
            return ServerResponse::error(
                "unknown",
                "invalid-json",
                format!("Could not parse command: {error}"),
            );
        }
    };

    match command.method.as_str() {
        "health.ping" => {
            let ffmpeg_path = resolve_ffmpeg_path_ref(
                command
                    .params
                    .get("ffmpegPath")
                    .and_then(|value| value.as_str()),
            );
            ServerResponse::ok(command.id, backend_health(state, &ffmpeg_path).await)
        }
        "account.get" => {
            let session = state.account_session.lock().await;
            ServerResponse::ok(command.id, account::current_account(session.as_ref()))
        }
        "account.sign_out" => {
            account::clear_persisted_account();
            let signed_out = account::signed_out_account();
            *state.account_session.lock().await = Some(signed_out.clone());
            ServerResponse::ok(command.id, signed_out)
        }
        "account.complete_sign_in" => {
            let token = command
                .params
                .get("token")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let resolved = account::complete_sign_in(token, cfg!(debug_assertions)).await;
            *state.account_session.lock().await = Some(resolved.clone());
            ServerResponse::ok(command.id, resolved)
        }
        "account.refresh" => {
            let resolved = account::refresh_account().await;
            *state.account_session.lock().await = Some(resolved.clone());
            ServerResponse::ok(command.id, resolved)
        }
        "entitlements.get" => ServerResponse::ok(command.id, entitlements::current_entitlements()),
        "captions.start" => {
            let language = command
                .params
                .get("language")
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .filter(|value| !value.trim().is_empty());
            match captions::start_captions(state, language).await {
                Ok(status) => ServerResponse::ok(command.id, status),
                Err(error) => {
                    ServerResponse::error(command.id, "captions-start-failed", error.to_string())
                }
            }
        }
        "captions.stop" => ServerResponse::ok(command.id, captions::stop_captions(state).await),
        "captions.status.get" => {
            ServerResponse::ok(command.id, captions::captions_status(state).await)
        }
        "ai.capabilities.get" => match get_ai_capabilities().await {
            Ok(capabilities) => ServerResponse::ok(command.id, capabilities),
            Err(error) => {
                ServerResponse::error(command.id, "ai-capabilities-failed", error.to_string())
            }
        },
        "ai.quota.get" => match get_ai_quota().await {
            Ok(quota) => ServerResponse::ok(command.id, quota),
            Err(error) => ServerResponse::error(command.id, "ai-quota-failed", error.to_string()),
        },
        "ai.jobs.get" => match serde_json::from_value::<protocol::AiJobGetParams>(command.params) {
            Ok(params) => match get_ai_job(&params.job_id).await {
                Ok(job) => ServerResponse::ok(command.id, job),
                Err(error) => {
                    ServerResponse::error(command.id, "ai-job-get-failed", error.to_string())
                }
            },
            Err(error) => ServerResponse::error(command.id, "invalid-params", error.to_string()),
        },
        "devices.list" => {
            let ffmpeg_path = resolve_ffmpeg_path_ref(
                command
                    .params
                    .get("ffmpegPath")
                    .and_then(|value| value.as_str()),
            );
            let devices = devices::list_devices(&ffmpeg_path).await;
            state.emit_event("devices.changed", &devices);
            ServerResponse::ok(command.id, devices)
        }
        "diagnostics.supportBundle.export" => {
            match serde_json::from_value::<support_bundle::SupportBundleExportParams>(
                command.params,
            ) {
                Ok(params) => {
                    let ffmpeg_path = resolve_ffmpeg_path_ref(params.ffmpeg_path.as_deref());
                    match export_support_bundle_for_state(state, params, &ffmpeg_path).await {
                        Ok(result) => ServerResponse::ok(command.id, result),
                        Err(error) => ServerResponse::error(
                            command.id,
                            "support-bundle-export-failed",
                            error.to_string(),
                        ),
                    }
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "diagnostics.stats" => {
            ServerResponse::ok(command.id, current_diagnostics_stats(state).await)
        }
        "diagnostics.preview_baseline.record" => {
            match serde_json::from_value::<protocol::PreviewBaselineParams>(command.params) {
                Ok(params) => {
                    let payload = serde_json::to_string(&params)
                        .unwrap_or_else(|_| "unserializable preview baseline".to_string());
                    state.emit_log(
                        if params.obs_qualified { "info" } else { "warn" },
                        format!("Preview baseline recorded: {payload}"),
                    );
                    ServerResponse::ok(command.id, params)
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "diagnostics.preview_surface.resize" => {
            register_preview_surface_resize(state).await;
            let stats = state.diagnostics.lock().await.clone();
            ServerResponse::ok(command.id, stats)
        }
        "encoder_bridge.synthetic_record" => {
            match serde_json::from_value::<protocol::EncoderBridgeSyntheticParams>(command.params) {
                Ok(params) => match run_synthetic_encoder_bridge(state.clone(), params).await {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "encoder-bridge-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "preview.surface.create" => {
            match serde_json::from_value::<protocol::PreviewSurfaceCreateParams>(command.params) {
                Ok(params) => {
                    let status = create_preview_surface(state.clone(), params).await;
                    ServerResponse::ok(command.id, status)
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "preview.surface.update_bounds" => {
            match serde_json::from_value::<protocol::PreviewSurfaceBoundsParams>(command.params) {
                Ok(params) => {
                    let status = update_preview_surface_bounds(state, params).await;
                    ServerResponse::ok(command.id, status)
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "preview.surface.present" => {
            match serde_json::from_value::<protocol::PreviewSurfacePresentParams>(command.params) {
                Ok(params) => {
                    let status = update_preview_surface_present(state, params).await;
                    ServerResponse::ok(command.id, status)
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "preview.surface.destroy" => {
            let status = destroy_preview_surface(state).await;
            ServerResponse::ok(command.id, status)
        }
        "preview.surface.status" => {
            let status = preview_surface_status(state).await;
            ServerResponse::ok(command.id, status)
        }
        "preview.surface.take_native_host_commands" => {
            let commands = take_native_preview_host_commands(state).await;
            ServerResponse::ok(command.id, commands)
        }
        "compositor.status" => {
            let status = compositor_status(state).await;
            ServerResponse::ok(command.id, status)
        }
        "compositor.scene.update" => {
            match serde_json::from_value::<protocol::CompositorSceneUpdateParams>(command.params) {
                Ok(params) => {
                    let status = update_compositor_scene(state, params).await;
                    ServerResponse::ok(command.id, status)
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "preview.camera.start" => {
            match serde_json::from_value::<protocol::PreviewCameraStartParams>(command.params) {
                Ok(params) => {
                    let status = start_preview_camera(state.clone(), params).await;
                    ServerResponse::ok(command.id, status)
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "preview.camera.stop" => {
            let status = stop_preview_camera(state).await;
            ServerResponse::ok(command.id, status)
        }
        "preview.camera.status" => {
            let status = preview_camera_status(state).await;
            ServerResponse::ok(command.id, status)
        }
        "preview.screen.start" => {
            match serde_json::from_value::<protocol::PreviewScreenStartParams>(command.params) {
                Ok(params) => {
                    let status = start_preview_screen(state.clone(), params).await;
                    ServerResponse::ok(command.id, status)
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "preview.screen.stop" => {
            let status = stop_preview_screen(state).await;
            ServerResponse::ok(command.id, status)
        }
        "preview.screen.status" => {
            let status = preview_screen_status(state).await;
            ServerResponse::ok(command.id, status)
        }
        "audio.meter.sample" => {
            match serde_json::from_value::<protocol::AudioMeterParams>(command.params) {
                Ok(params) => {
                    ServerResponse::ok(command.id, devices::sample_audio_meter(params).await)
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "scene.get" => {
            let scene = state.scene.lock().await.clone();
            ServerResponse::ok(command.id, scene)
        }
        "scene.load_from_capture_config" => {
            match serde_json::from_value::<protocol::SceneConfigParams>(command.params) {
                Ok(params) => {
                    let scene = scene_from_capture_config(params.clone());
                    match live_layout::commit_scene_with_layout(state, &scene, params.layout, None)
                        .await
                    {
                        Ok(status) => ServerResponse::ok(command.id, status),
                        Err(error) => ServerResponse::error(
                            command.id,
                            "scene-commit-failed",
                            error.to_string(),
                        ),
                    }
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "scene.layout.apply_live" => {
            match serde_json::from_value::<protocol::SceneConfigParams>(command.params) {
                Ok(params) => match live_layout::apply_layout_live(state, params).await {
                    Ok(status) => ServerResponse::ok(command.id, status),
                    Err(error) => {
                        ServerResponse::error(command.id, "layout-live-failed", error.to_string())
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "scene.source.device.switch" => {
            match serde_json::from_value::<protocol::SceneConfigParams>(command.params) {
                Ok(params) => {
                    match live_layout::apply_source_device_switch_live(state, params).await {
                        Ok(status) => ServerResponse::ok(command.id, status),
                        Err(error) => ServerResponse::error(
                            command.id,
                            "source-device-switch-failed",
                            error.to_string(),
                        ),
                    }
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "scene.source.transform.update" => {
            match serde_json::from_value::<protocol::SceneTransformUpdateParams>(command.params) {
                Ok(params) => {
                    let result = {
                        let mut guard = state.scene.lock().await;
                        update_source_transform(&mut guard, params)
                    };
                    match result {
                        Ok(scene) => {
                            match live_layout::commit_scene_with_current_layout(state, &scene).await
                            {
                                Ok(status) => ServerResponse::ok(command.id, status),
                                Err(error) => ServerResponse::error(
                                    command.id,
                                    "scene-commit-failed",
                                    error.to_string(),
                                ),
                            }
                        }
                        Err(error) => {
                            ServerResponse::error(command.id, "scene-update-failed", error)
                        }
                    }
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "scene.source.transform.reset" => {
            match serde_json::from_value::<protocol::SceneSourceParams>(command.params) {
                Ok(params) => {
                    let result = {
                        let mut guard = state.scene.lock().await;
                        reset_source_transform(&mut guard, params)
                    };
                    match result {
                        Ok(scene) => {
                            match live_layout::commit_scene_with_current_layout(state, &scene).await
                            {
                                Ok(status) => ServerResponse::ok(command.id, status),
                                Err(error) => ServerResponse::error(
                                    command.id,
                                    "scene-commit-failed",
                                    error.to_string(),
                                ),
                            }
                        }
                        Err(error) => {
                            ServerResponse::error(command.id, "scene-reset-failed", error)
                        }
                    }
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "scene.source.visibility.update" => {
            match serde_json::from_value::<protocol::SceneSourceVisibilityParams>(command.params) {
                Ok(params) => {
                    let result = {
                        let mut guard = state.scene.lock().await;
                        update_source_visibility(&mut guard, params)
                    };
                    match result {
                        Ok(scene) => {
                            match live_layout::commit_scene_with_current_layout(state, &scene).await
                            {
                                Ok(status) => ServerResponse::ok(command.id, status),
                                Err(error) => ServerResponse::error(
                                    command.id,
                                    "scene-commit-failed",
                                    error.to_string(),
                                ),
                            }
                        }
                        Err(error) => {
                            ServerResponse::error(command.id, "scene-visibility-failed", error)
                        }
                    }
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "scene.source.nudge" => {
            match serde_json::from_value::<protocol::SceneSourceNudgeParams>(command.params) {
                Ok(params) => {
                    let result = {
                        let mut guard = state.scene.lock().await;
                        nudge_source(
                            &mut guard,
                            &params.source_id,
                            params.direction_x,
                            params.direction_y,
                            params.large,
                        )
                    };
                    match result {
                        Ok(scene) => {
                            match live_layout::commit_scene_with_current_layout(state, &scene).await
                            {
                                Ok(status) => ServerResponse::ok(command.id, status),
                                Err(error) => ServerResponse::error(
                                    command.id,
                                    "scene-commit-failed",
                                    error.to_string(),
                                ),
                            }
                        }
                        Err(error) => {
                            ServerResponse::error(command.id, "scene-nudge-failed", error)
                        }
                    }
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "scene.sources.reorder" => {
            match serde_json::from_value::<protocol::SceneSourceOrderParams>(command.params) {
                Ok(params) => {
                    let result = {
                        let mut guard = state.scene.lock().await;
                        reorder_sources(&mut guard, params)
                    };
                    match result {
                        Ok(scene) => {
                            match live_layout::commit_scene_with_current_layout(state, &scene).await
                            {
                                Ok(status) => ServerResponse::ok(command.id, status),
                                Err(error) => ServerResponse::error(
                                    command.id,
                                    "scene-commit-failed",
                                    error.to_string(),
                                ),
                            }
                        }
                        Err(error) => {
                            ServerResponse::error(command.id, "scene-reorder-failed", error)
                        }
                    }
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "recording.start_test" => {
            match serde_json::from_value::<protocol::StartSessionParams>(command.params) {
                Ok(params) => match start_session(state.clone(), params).await {
                    Ok(status) => ServerResponse::ok(command.id, status),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "recording-start-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "session.start" => {
            match serde_json::from_value::<protocol::StartSessionParams>(command.params) {
                Ok(params) => {
                    let streaming = params.streaming.clone();
                    match start_session(state.clone(), params).await {
                        Ok(status) => {
                            if let Some(streaming) = streaming.as_ref()
                                && let Some(session_id) = status.session_id.as_deref()
                            {
                                spawn_session_live_chat(state, session_id, streaming).await;
                            }
                            ServerResponse::ok(command.id, status)
                        }
                        Err(error) => ServerResponse::error(
                            command.id,
                            "session-start-failed",
                            error.to_string(),
                        ),
                    }
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "session.stop" => {
            live_chat::stop_live_chat(state).await;
            match stop_recording(state.clone()).await {
                Ok(status) => ServerResponse::ok(command.id, status),
                Err(error) => {
                    ServerResponse::error(command.id, "session-stop-failed", error.to_string())
                }
            }
        }
        "sessions.list" => match state.database.list_sessions(20) {
            Ok(sessions) => ServerResponse::ok(command.id, sessions),
            Err(error) => {
                ServerResponse::error(command.id, "sessions-list-failed", error.to_string())
            }
        },
        "sessions.comments.list" => {
            match serde_json::from_value::<protocol::SessionCommentsListParams>(command.params) {
                Ok(params) => match state.database.list_live_chat_messages(&params.session_id) {
                    Ok(messages) => ServerResponse::ok(command.id, messages),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "session-comments-list-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "platformAccounts.list" => match state.database.list_platform_accounts() {
            Ok(accounts) => ServerResponse::ok(command.id, accounts),
            Err(error) => ServerResponse::error(
                command.id,
                "platform-accounts-list-failed",
                error.to_string(),
            ),
        },
        "liveChat.capability" => match state.database.list_platform_accounts() {
            Ok(accounts) => ServerResponse::ok(command.id, live_chat::chat_capabilities(&accounts)),
            Err(error) => {
                ServerResponse::error(command.id, "live-chat-capability-failed", error.to_string())
            }
        },
        "liveChat.status" => ServerResponse::ok(command.id, live_chat::current_status(state).await),
        "liveChat.start" => {
            match serde_json::from_value::<live_chat::LiveChatStartParams>(command.params) {
                Ok(params) => {
                    ServerResponse::ok(command.id, live_chat::start_live_chat(state, params).await)
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "liveChat.stop" => ServerResponse::ok(command.id, live_chat::stop_live_chat(state).await),
        "liveChat.diagnostics" => {
            ServerResponse::ok(command.id, live_chat::current_diagnostics(state).await)
        }
        "liveChat.clearLocal" => {
            ServerResponse::ok(command.id, live_chat::clear_local_live_chat(state).await)
        }
        "liveChat.xCommentsReadiness" => {
            let has_x_account = state
                .database
                .list_platform_accounts()
                .map(|accounts| {
                    accounts
                        .iter()
                        .any(|account| account.platform == crate::streaming::StreamPlatform::X)
                })
                .unwrap_or(false);
            ServerResponse::ok(command.id, x_chat::x_chat_readiness(has_x_account))
        }
        "platformAccounts.oauth.start" => {
            match serde_json::from_value::<OAuthStartParams>(command.params) {
                Ok(params) => match state.oauth.start(params, state.oauth_redirect_port()).await {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "platform-oauth-start-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "platformAccounts.oauth.startProvider" => {
            match serde_json::from_value::<OAuthStartProviderParams>(command.params) {
                Ok(params) => match state
                    .oauth
                    .start_provider(params, state.oauth_redirect_port())
                    .await
                {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "platform-oauth-provider-start-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "platformAccounts.oauth.complete" => {
            match serde_json::from_value::<OAuthCompleteParams>(command.params) {
                Ok(params) => {
                    let result = complete_oauth_callback(state, params).await;
                    state.emit_event("platformAccounts.oauth.callback", result.clone());
                    ServerResponse::ok(command.id, result)
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "platformAccounts.disconnect" => {
            match serde_json::from_value::<streaming::PlatformAccountPlatformParams>(command.params)
            {
                Ok(params) => match state.database.disconnect_platform_account(params.platform) {
                    Ok(account) => {
                        if let Ok(accounts) = state.database.list_platform_accounts() {
                            state.emit_event("platformAccounts.changed", accounts);
                        }
                        ServerResponse::ok(command.id, account)
                    }
                    Err(error) => ServerResponse::error(
                        command.id,
                        "platform-account-disconnect-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "platformAccounts.validate" => {
            ServerResponse::ok(command.id, validate_platform_accounts(state).await)
        }
        "platformAccounts.refresh" => {
            ServerResponse::ok(command.id, validate_platform_accounts(state).await)
        }
        "platformAccounts.oauth.providerCredentials" => {
            ServerResponse::ok(command.id, oauth::provider_credential_statuses())
        }
        "streamTargets.metadata.get" => match state.database.stream_metadata_draft() {
            Ok(draft) => ServerResponse::ok(command.id, draft),
            Err(error) => {
                ServerResponse::error(command.id, "stream-metadata-get-failed", error.to_string())
            }
        },
        "streamTargets.metadata.update" => {
            match serde_json::from_value::<StreamMetadataDraft>(command.params) {
                Ok(draft) => match state.database.save_stream_metadata_draft(draft) {
                    Ok(saved) => {
                        state.emit_event("streamTargets.metadata.changed", &saved);
                        ServerResponse::ok(command.id, saved)
                    }
                    Err(error) => ServerResponse::error(
                        command.id,
                        "stream-metadata-update-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "streamTargets.metadata.validate" => {
            match serde_json::from_value::<StreamMetadataDraft>(command.params) {
                Ok(draft) => ServerResponse::ok(command.id, validate_stream_metadata_draft(&draft)),
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "streamTargets.manualKey.store" => {
            match serde_json::from_value::<StoreManualStreamKeyParams>(command.params) {
                Ok(params) => match store_manual_stream_key(params) {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "manual-stream-key-store-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "streamTargets.manualKey.restorePrevious" => {
            match serde_json::from_value::<ManualStreamKeyRefParams>(command.params) {
                Ok(params) => match restore_previous_manual_stream_key(params) {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "manual-stream-key-restore-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "streamTargets.manualKey.inspect" => {
            match serde_json::from_value::<ManualStreamKeyRefParams>(command.params) {
                Ok(params) => match inspect_manual_stream_key(params) {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "manual-stream-key-inspect-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "streamTargets.confirmation.validate" => {
            match serde_json::from_value::<GoLivePreflightParams>(command.params) {
                Ok(params) => match (
                    state.database.stream_metadata_draft(),
                    state.database.list_platform_accounts(),
                ) {
                    (Ok(metadata), Ok(accounts)) => ServerResponse::ok(
                        command.id,
                        preflight::validate_go_live_preflight(params, &metadata, &accounts),
                    ),
                    (Err(error), _) => ServerResponse::error(
                        command.id,
                        "stream-metadata-get-failed",
                        error.to_string(),
                    ),
                    (_, Err(error)) => ServerResponse::error(
                        command.id,
                        "platform-account-list-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "streamTargets.youtube.prepare" => {
            match serde_json::from_value::<YouTubePrepareParams>(command.params) {
                Ok(params) => match prepare_youtube_stream_target(state, params).await {
                    Ok(prepared) => ServerResponse::ok(command.id, prepared),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "youtube-prepare-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "streamTargets.youtube.transition" => {
            match serde_json::from_value::<YouTubeBroadcastTransitionParams>(command.params) {
                Ok(params) => match transition_youtube_stream_target(state, params).await {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "youtube-transition-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "streamTargets.youtube.streamStatus" => {
            match serde_json::from_value::<YouTubeStreamStatusParams>(command.params) {
                Ok(params) => match youtube_stream_status(state, params).await {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "youtube-stream-status-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "platformAccounts.youtube.channels" => {
            match serde_json::from_value::<YouTubeChannelListParams>(command.params) {
                Ok(params) => match list_youtube_channels(state, params).await {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "youtube-channels-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "platformAccounts.youtube.selectChannel" => {
            match serde_json::from_value::<YouTubeChannelSelectParams>(command.params) {
                Ok(params) => match select_youtube_channel_account(state, params).await {
                    Ok(account) => ServerResponse::ok(command.id, account),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "youtube-channel-select-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "streamTargets.twitch.searchCategories" => {
            match serde_json::from_value::<TwitchCategorySearchParams>(command.params) {
                Ok(params) => match search_twitch_categories(state, params).await {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "twitch-category-search-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "streamTargets.twitch.prepare" => {
            match serde_json::from_value::<TwitchPrepareParams>(command.params) {
                Ok(params) => match prepare_twitch_stream_target(state, params).await {
                    Ok(prepared) => ServerResponse::ok(command.id, prepared),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "twitch-prepare-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "streamTargets.x.capability" => {
            match serde_json::from_value::<XNativeLiveCapabilityParams>(command.params) {
                Ok(params) => match x_native_live_capability(state, params) {
                    Ok(capability) => ServerResponse::ok(command.id, capability),
                    Err(error) => {
                        ServerResponse::error(command.id, "x-capability-failed", error.to_string())
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "streamTargets.x.prepare" => match serde_json::from_value::<XPrepareParams>(command.params)
        {
            Ok(params) => match prepare_x_native_live(state, params) {
                Ok(()) => ServerResponse::ok(command.id, serde_json::json!({})),
                Err(error) => ServerResponse::error(
                    command.id,
                    "x-native-live-unavailable",
                    error.to_string(),
                ),
            },
            Err(error) => ServerResponse::error(command.id, "invalid-params", error.to_string()),
        },
        "screens.list" => match state.database.list_stream_screens() {
            Ok(screens) => ServerResponse::ok(command.id, screens),
            Err(error) => {
                ServerResponse::error(command.id, "screens-list-failed", error.to_string())
            }
        },
        "screens.active" => match state.database.active_stream_screen() {
            Ok(screen) => ServerResponse::ok(command.id, screen),
            Err(error) => {
                ServerResponse::error(command.id, "screen-active-failed", error.to_string())
            }
        },
        "screens.importImage" => {
            match serde_json::from_value::<protocol::ImportScreenImageParams>(command.params) {
                Ok(params) => {
                    let ffmpeg_path = resolve_ffmpeg_path_ref(params.ffmpeg_path.as_deref());
                    match state
                        .database
                        .import_screen_image(&params.path, &ffmpeg_path)
                    {
                        Ok(screen) => {
                            if let Ok(screens) = state.database.list_stream_screens() {
                                state.emit_event("screens.changed", screens);
                            }
                            ServerResponse::ok(command.id, screen)
                        }
                        Err(error) => ServerResponse::error(
                            command.id,
                            "screen-import-failed",
                            error.to_string(),
                        ),
                    }
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "screens.rename" => {
            match serde_json::from_value::<protocol::RenameScreenParams>(command.params) {
                Ok(params) => match state
                    .database
                    .rename_stream_screen(&params.screen_id, &params.name)
                {
                    Ok(screen) => {
                        if let Ok(screens) = state.database.list_stream_screens() {
                            state.emit_event("screens.changed", screens);
                        }
                        if let Ok(active) = state.database.active_stream_screen()
                            && active.as_ref().map(|active| &active.id) == Some(&screen.id)
                        {
                            state.emit_event("screens.active.changed", active);
                        }
                        ServerResponse::ok(command.id, screen)
                    }
                    Err(error) => {
                        ServerResponse::error(command.id, "screen-rename-failed", error.to_string())
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "screens.delete" => {
            match serde_json::from_value::<protocol::ScreenIdParams>(command.params) {
                Ok(params) => match state.database.delete_stream_screen(&params.screen_id) {
                    Ok(()) => match state.database.list_stream_screens() {
                        Ok(screens) => {
                            state.emit_event("screens.changed", screens.clone());
                            if let Ok(active) = state.database.active_stream_screen() {
                                if active.is_none()
                                    && let Some(recording) = state.recording.lock().await.as_ref()
                                {
                                    let _ = recording.set_active_screen_path(None);
                                }
                                state.emit_event("screens.active.changed", active);
                            }
                            ServerResponse::ok(command.id, screens)
                        }
                        Err(error) => ServerResponse::error(
                            command.id,
                            "screens-list-failed",
                            error.to_string(),
                        ),
                    },
                    Err(error) => {
                        ServerResponse::error(command.id, "screen-delete-failed", error.to_string())
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "screens.reorder" => {
            match serde_json::from_value::<protocol::ReorderScreensParams>(command.params) {
                Ok(params) => match state.database.reorder_stream_screens(&params.screen_ids) {
                    Ok(screens) => {
                        state.emit_event("screens.changed", screens.clone());
                        ServerResponse::ok(command.id, screens)
                    }
                    Err(error) => ServerResponse::error(
                        command.id,
                        "screen-reorder-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "screens.activate" => {
            match serde_json::from_value::<protocol::ScreenIdParams>(command.params) {
                Ok(params) => match state.database.activate_stream_screen(&params.screen_id) {
                    Ok(screen) => {
                        let should_update_compositor = {
                            if let Some(recording) = state.recording.lock().await.as_ref() {
                                if let Err(error) =
                                    recording.set_active_screen_path(Some(&screen.image_path))
                                {
                                    return ServerResponse::error(
                                        command.id,
                                        "screen-activate-failed",
                                        error.to_string(),
                                    );
                                }
                                recording.encoder_bridge.is_some()
                            } else {
                                false
                            }
                        };
                        if should_update_compositor {
                            update_compositor_active_screen(state, Some(screen.clone())).await;
                        }
                        state.emit_event("screens.active.changed", Some(screen.clone()));
                        ServerResponse::ok(command.id, screen)
                    }
                    Err(error) => ServerResponse::error(
                        command.id,
                        "screen-activate-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "screens.clear" => match state.database.clear_active_stream_screen() {
            Ok(()) => {
                let should_update_compositor = {
                    if let Some(recording) = state.recording.lock().await.as_ref() {
                        if let Err(error) = recording.set_active_screen_path(None) {
                            return ServerResponse::error(
                                command.id,
                                "screen-clear-failed",
                                error.to_string(),
                            );
                        }
                        recording.encoder_bridge.is_some()
                    } else {
                        false
                    }
                };
                if should_update_compositor {
                    update_compositor_active_screen(state, None).await;
                }
                state.emit_event(
                    "screens.active.changed",
                    Option::<protocol::StreamScreen>::None,
                );
                ServerResponse::ok(command.id, Option::<protocol::StreamScreen>::None)
            }
            Err(error) => {
                ServerResponse::error(command.id, "screen-clear-failed", error.to_string())
            }
        },
        "session.remux_mp4" => {
            match serde_json::from_value::<protocol::RemuxSessionParams>(command.params) {
                Ok(params) => match remux_session(state.clone(), params).await {
                    Ok(mp4_path) => {
                        ServerResponse::ok(command.id, serde_json::json!({ "mp4Path": mp4_path }))
                    }
                    Err(error) => {
                        ServerResponse::error(command.id, "remux-failed", error.to_string())
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "repair.assess_file" => {
            match serde_json::from_value::<protocol::RepairFileParams>(command.params) {
                Ok(params) => match repair_service::assess_file(state.clone(), params).await {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => ServerResponse::error(command.id, "repair-assess-failed", error),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "repair.repair_file" => {
            match serde_json::from_value::<protocol::RepairFileParams>(command.params) {
                Ok(params) => match repair_service::repair_file(state.clone(), params).await {
                    Ok(status) => ServerResponse::ok(command.id, status),
                    Err(error) => ServerResponse::error(command.id, "repair-failed", error),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "repair.restore_file" => {
            match serde_json::from_value::<protocol::RepairRestoreParams>(command.params) {
                Ok(params) => match repair_service::restore_file(params).await {
                    Ok(restored) => {
                        ServerResponse::ok(command.id, serde_json::json!({ "restored": restored }))
                    }
                    Err(error) => ServerResponse::error(command.id, "repair-restore-failed", error),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "ai.run_post_recording" => {
            match serde_json::from_value::<protocol::RunAiWorkflowParams>(command.params) {
                Ok(params) => match ai::run_ai_workflow(state.clone(), params).await {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => {
                        ServerResponse::error(command.id, "ai-workflow-failed", error.to_string())
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "ai.artifacts.list" => {
            let session_id = command
                .params
                .get("sessionId")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if session_id.is_empty() {
                ServerResponse::error(command.id, "invalid-params", "sessionId is required")
            } else {
                match ai::list_ai_artifacts(state, session_id) {
                    Ok(artifacts) => ServerResponse::ok(command.id, artifacts),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "ai-artifacts-list-failed",
                        error.to_string(),
                    ),
                }
            }
        }
        "ai.publish_pack.export" => {
            match serde_json::from_value::<protocol::ExportPublishPackParams>(command.params) {
                Ok(params) => match ai::export_publish_pack(state.clone(), params).await {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "publish-pack-export-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "preview.snapshot" => {
            match serde_json::from_value::<protocol::PreviewSnapshotParams>(command.params) {
                Ok(params) => match create_preview_snapshot(state.clone(), params).await {
                    Ok(snapshot) => ServerResponse::ok(command.id, snapshot),
                    Err(error) => {
                        ServerResponse::error(command.id, "preview-failed", error.to_string())
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "preview.live.start" => {
            match serde_json::from_value::<protocol::PreviewLiveParams>(command.params) {
                Ok(params) => match start_live_preview(state.clone(), params).await {
                    Ok(status) => ServerResponse::ok(command.id, status),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "preview-live-start-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "preview.live.stop" => match stop_live_preview(state.clone()).await {
            Ok(status) => ServerResponse::ok(command.id, status),
            Err(error) => {
                ServerResponse::error(command.id, "preview-live-stop-failed", error.to_string())
            }
        },
        "preview.live.status" => {
            let status = live_preview_status(state).await;
            ServerResponse::ok(command.id, status)
        }
        "recording.stop" => match stop_recording(state.clone()).await {
            Ok(status) => ServerResponse::ok(command.id, status),
            Err(error) => {
                ServerResponse::error(command.id, "recording-stop-failed", error.to_string())
            }
        },
        "recording.status" => ServerResponse::ok(command.id, current_recording_status(state).await),
        method => ServerResponse::error(
            command.id,
            "unknown-method",
            format!("Unknown backend method: {method}"),
        ),
    }
}

fn stored_ai_session_token() -> Result<String> {
    account::stored_session_token().context("Sign in to use cloud AI.")
}

async fn get_ai_capabilities() -> Result<protocol::AiCapabilities> {
    let token = stored_ai_session_token()?;
    let client = videorc_api::VideorcApiClient::new()?;
    client.get_ai_capabilities(&token).await
}

async fn get_ai_quota() -> Result<protocol::AiQuotaStatus> {
    let token = stored_ai_session_token()?;
    let client = videorc_api::VideorcApiClient::new()?;
    client.get_ai_quota(&token).await
}

async fn get_ai_job(job_id: &str) -> Result<protocol::AiJobSnapshot> {
    let job_id = job_id.trim();
    if job_id.is_empty() {
        anyhow::bail!("jobId is required");
    }
    let token = stored_ai_session_token()?;
    let client = videorc_api::VideorcApiClient::new()?;
    client.get_ai_job(&token, job_id).await
}

async fn backend_health(state: &AppState, ffmpeg_path: &str) -> BackendHealth {
    BackendHealth {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        ffmpeg: ffmpeg_status(ffmpeg_path).await,
        database_path: state.database.path().display().to_string(),
        secret_store_backend: secrets::secret_store_backend_kind().to_string(),
    }
}

async fn current_diagnostics_stats(state: &AppState) -> protocol::DiagnosticStats {
    let stats = state.diagnostics.lock().await.clone();
    let scene_revision = state.compositor.lock().await.status.scene_revision;
    let stats = diagnostics::apply_active_scene_revision(stats, scene_revision);
    let source_registry = state.source_registry.lock().await.snapshot();
    let stats = diagnostics::apply_source_registry_snapshot(stats, source_registry);
    diagnostics::apply_runtime_diagnostics_snapshot(stats, state.ffmpeg_work.snapshot())
}

async fn current_recording_status(state: &AppState) -> protocol::RecordingStatus {
    state
        .recording
        .lock()
        .await
        .as_ref()
        .map(|active| {
            let state = if active.mode == "stream" {
                RecordingState::Streaming
            } else {
                RecordingState::Recording
            };
            active.status(state, None)
        })
        .unwrap_or_else(idle_status)
}

async fn export_support_bundle_for_state(
    state: &AppState,
    params: support_bundle::SupportBundleExportParams,
    ffmpeg_path: &str,
) -> Result<support_bundle::SupportBundleExportResult> {
    let sessions = state.database.list_sessions(20)?;
    support_bundle::export_support_bundle(support_bundle::SupportBundleExportInput {
        output_directory: params.output_directory.map(PathBuf::from),
        database_path: state.database.path().clone(),
        health: backend_health(state, ffmpeg_path).await,
        entitlements: entitlements::current_entitlements(),
        recording: current_recording_status(state).await,
        diagnostics: current_diagnostics_stats(state).await,
        logs: state.recent_logs(200),
        sessions,
    })
}

async fn ffmpeg_status(ffmpeg_path: &str) -> ToolStatus {
    let output = timeout(
        Duration::from_secs(4),
        Command::new(ffmpeg_path)
            .arg("-version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await;

    match output {
        Ok(Ok(output)) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            ToolStatus {
                path: ffmpeg_path.to_string(),
                available: true,
                version: stdout.lines().next().map(|line| line.to_string()),
                message: None,
            }
        }
        Ok(Ok(output)) => ToolStatus {
            path: ffmpeg_path.to_string(),
            available: false,
            version: None,
            message: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        },
        Ok(Err(error)) => ToolStatus {
            path: ffmpeg_path.to_string(),
            available: false,
            version: None,
            message: Some(error.to_string()),
        },
        Err(_) => ToolStatus {
            path: ffmpeg_path.to_string(),
            available: false,
            version: None,
            message: Some("Timed out while checking FFmpeg.".to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::broadcast;

    #[test]
    fn response_shape_omits_empty_error() {
        let response = ServerResponse::ok("abc", json!({ "pong": true }));
        let value = serde_json::to_value(response).unwrap();

        assert_eq!(value["id"], "abc");
        assert_eq!(value["ok"], true);
        assert!(value.get("error").is_none());
    }

    #[test]
    fn connection_control_replaces_the_exclusion_set() {
        let excluded = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::<
            String,
        >::new()));

        // Non-control commands pass through untouched.
        assert!(
            handle_connection_control(&excluded, r#"{"id":"a","method":"recording.start"}"#)
                .is_none()
        );
        assert!(handle_connection_control(&excluded, "not json").is_none());

        let response = handle_connection_control(
            &excluded,
            r#"{"id":"b","method":"events.setExcluded","params":{"events":["compositor.status"]}}"#,
        )
        .expect("control response");
        assert!(response.ok);
        assert!(excluded.lock().unwrap().contains("compositor.status"));

        // An empty list clears the filter (fallback pump resubscribes).
        let response = handle_connection_control(
            &excluded,
            r#"{"id":"c","method":"events.setExcluded","params":{"events":[]}}"#,
        )
        .expect("control response");
        assert!(response.ok);
        assert!(excluded.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn oauth_callback_listener_skips_busy_candidate_ports() {
        // Hold whichever candidate binds first, then confirm a second bind
        // falls through to a DIFFERENT candidate instead of failing. Tolerates
        // external processes already holding some candidates.
        let first = bind_oauth_callback_listener().await;
        let second = bind_oauth_callback_listener().await;
        if let (Some(first), Some(second)) = (&first, &second) {
            let first_port = first.local_addr().unwrap().port();
            let second_port = second.local_addr().unwrap().port();
            assert_ne!(first_port, second_port);
            assert!(OAUTH_CALLBACK_PORT_CANDIDATES.contains(&first_port));
            assert!(OAUTH_CALLBACK_PORT_CANDIDATES.contains(&second_port));
        }
    }

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(16);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    fn platform_account_with_status(
        status: PlatformAccountStatus,
        expires_at: Option<String>,
    ) -> streaming::PlatformAccount {
        streaming::PlatformAccount {
            id: "account-row-id".to_string(),
            platform: StreamPlatform::Youtube,
            account_id: "UC123".to_string(),
            account_label: "OrcDev".to_string(),
            account_handle: Some("@orcdev".to_string()),
            avatar_url: None,
            scopes: vec!["https://www.googleapis.com/auth/youtube".to_string()],
            access_token_present: true,
            refresh_token_present: true,
            stream_key_present: false,
            expires_at,
            connected_at: "2026-06-23T10:00:00Z".to_string(),
            updated_at: "2026-06-23T10:00:00Z".to_string(),
            status,
        }
    }

    #[test]
    fn refresh_policy_recovers_needs_reconnect_accounts_even_before_expiry() {
        let future_expiry = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        assert!(should_refresh_platform_access_token(
            &platform_account_with_status(
                PlatformAccountStatus::NeedsReconnect,
                Some(future_expiry)
            )
        ));
    }

    #[test]
    fn refresh_policy_keeps_connected_future_tokens_until_needed() {
        let future_expiry = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        assert!(!should_refresh_platform_access_token(
            &platform_account_with_status(PlatformAccountStatus::Connected, Some(future_expiry))
        ));
    }

    #[test]
    fn refresh_policy_proactively_refreshes_expiring_connected_tokens() {
        let near_expiry = (chrono::Utc::now() + chrono::Duration::minutes(1)).to_rfc3339();
        assert!(should_refresh_platform_access_token(
            &platform_account_with_status(PlatformAccountStatus::Connected, Some(near_expiry))
        ));
    }

    #[test]
    fn youtube_quota_validation_errors_do_not_force_reconnect() {
        let error = anyhow::anyhow!(
            "YouTube profile lookup failed with HTTP 403 Forbidden: quotaExceeded: quota exhausted"
        );
        assert!(should_keep_account_connected_after_validation_error(
            StreamPlatform::Youtube,
            &error
        ));
    }

    #[test]
    fn youtube_temporary_validation_errors_do_not_force_reconnect() {
        let error =
            anyhow::anyhow!("YouTube profile lookup failed with HTTP 503 Service Unavailable");
        assert!(should_keep_account_connected_after_validation_error(
            StreamPlatform::Youtube,
            &error
        ));
    }

    #[test]
    fn non_quota_youtube_validation_errors_still_force_reconnect() {
        let error = anyhow::anyhow!(
            "YouTube profile lookup failed with HTTP 403 Forbidden: insufficientPermissions"
        );
        assert!(!should_keep_account_connected_after_validation_error(
            StreamPlatform::Youtube,
            &error
        ));
    }

    #[test]
    fn invalid_grant_refresh_errors_still_force_reconnect() {
        let error = anyhow::anyhow!(
            "YouTube token refresh failed with HTTP 400 Bad Request: invalid_grant: Token has been expired or revoked."
        );
        assert!(should_force_account_reconnect_after_token_error(&error));
    }

    #[test]
    fn temporary_refresh_errors_keep_connected_accounts_connected() {
        let error = anyhow::anyhow!("Could not refresh YouTube OAuth token: operation timed out");
        let mut account = platform_account_with_status(PlatformAccountStatus::Connected, None);

        let validation = platform_validation_after_token_error(&mut account, &error);

        assert_eq!(account.status, PlatformAccountStatus::Connected);
        assert_eq!(validation.state, PlatformAccountValidationState::Valid);
        assert!(validation.message.contains("temporarily blocked"));
    }

    #[tokio::test]
    async fn preview_surface_native_host_commands_drain_over_ws() {
        let state = test_state();
        let create = json!({
            "id": "create",
            "method": "preview.surface.create",
            "params": {
                "bounds": {
                    "screenX": 10.0,
                    "screenY": 20.0,
                    "width": 640.0,
                    "height": 360.0,
                    "scaleFactor": 2.0,
                    "screenHeight": 1000.0
                },
                "targetFps": 60,
                "source": "synthetic"
            }
        });
        let create_response = handle_text_message(&state, &create.to_string()).await;
        assert!(create_response.ok);

        let drain = json!({
            "id": "drain",
            "method": "preview.surface.take_native_host_commands"
        });
        let drain_response = handle_text_message(&state, &drain.to_string()).await;
        assert!(drain_response.ok);
        let commands = drain_response.payload.unwrap();

        assert_eq!(commands[0]["kind"], "create");
        assert_eq!(commands[0]["bounds"]["screenX"], 10.0);
        assert_eq!(commands[0]["bounds"]["screenY"], 20.0);
        assert_eq!(commands[0]["bounds"]["width"], 640.0);
        assert_eq!(commands[0]["bounds"]["height"], 360.0);
        assert_eq!(commands[0]["bounds"]["scaleFactor"], 2.0);
        assert_eq!(commands[0]["bounds"]["screenHeight"], 1000.0);

        let empty_response = handle_text_message(&state, &drain.to_string()).await;
        assert!(empty_response.ok);
        assert_eq!(empty_response.payload.unwrap(), json!([]));

        destroy_preview_surface(&state).await;
    }
}
