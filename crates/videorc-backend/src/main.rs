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
mod posters;
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
mod session_ops;
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
mod viewer_stats;
mod x_chat;
mod x_live;
mod x_oauth1;
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
    StoreManualStreamKeyResult, StreamAuthMode, StreamMetadataDraft, StreamPlatform,
    UpsertPlatformAccount, manual_stream_key_previous_secret_ref, manual_stream_key_secret_ref,
    manual_stream_key_state, plan_manual_stream_key_restore, plan_manual_stream_key_store,
    validate_stream_metadata_draft,
};
use crate::twitch::{
    PreparedTwitchBroadcast, TwitchCategorySearchParams, TwitchCategorySearchRequest,
    TwitchCategorySearchResult, TwitchPrepareParams, TwitchPrepareRequest,
};
use crate::x_live::{
    PreparedXStreamSource, XEndParams, XEndRequest, XEndResult, XNativeLiveCapability,
    XNativeLiveCapabilityParams, XPrepareParams, XPrepareSourceRequest, XPublishParams,
    XPublishRequest, XPublishResult,
};
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
    // F-021 root cause: SkyLight ASSERTS (SIGABRT, "CGS_REQUIRE_INIT
    // did_initialize") if a window-server call runs before this process's
    // CoreGraphics connection initializes — SCContentFilter's window init
    // calls SLSGetDisplaysWithRect, and a renderer re-requesting a window
    // capture right after a backend (re)start raced that lazy init and
    // crash-looped. Touch CG once, deterministically, before any command.
    #[cfg(target_os = "macos")]
    {
        let _ = objc2_core_graphics::CGMainDisplayID();
    }
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
    match database.reconcile_orphaned_sessions() {
        Ok(0) => {}
        Ok(reconciled) => tracing::warn!(
            "Marked {reconciled} orphaned 'running' session(s) as failed (previous backend did not shut down cleanly)."
        ),
        Err(error) => tracing::warn!("Could not reconcile orphaned sessions: {error:#}"),
    }
    let mut state = AppState::new(token.clone(), port, events, database);
    state.oauth_callback_port = oauth_callback_port;
    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/preview/live.mjpeg", get(live_preview_handler))
        .route("/preview/live.jpg", get(live_preview_frame_handler))
        .route("/preview/camera/live.png", get(live_camera_frame_handler))
        .route("/preview/screen/live.png", get(live_screen_frame_handler))
        .route("/preview/{id}", get(preview_handler))
        .route("/sessions/{id}/poster", get(session_poster_handler))
        .route("/compositor/status", get(compositor_status_handler))
        .route("/oauth/callback", get(oauth_callback_handler))
        .route("/ws", get(ws_handler))
        .with_state(state.clone());

    let ready = backend_connection(port, token);
    println!("READY {}", serde_json::to_string(&ready)?);
    std::io::stdout().flush()?;

    state.emit_log("info", "Videorc backend ready.");
    // Restore the signed-in account's verified entitlement at boot so a
    // premium user's multistream limits survive an app restart without
    // touching the AI tab first (fail-closed: no stored session -> basic).
    // The persisted SIGNED token restores premium before any network round
    // trip (offline grace until the token's exp); the refresh then re-verifies
    // against the server and rotates the token.
    if account::stored_session_token().is_some()
        && let Some(entitlement_token) = account::stored_entitlement_token()
        && let Err(error) =
            entitlements::hydrate_account_entitlements_from_token(&entitlement_token)
    {
        tracing::info!("Stored entitlement token not restored: {error:#}");
    }
    {
        let entitlement_state = state.clone();
        tokio::spawn(async move { refresh_account_entitlements(&entitlement_state).await });
    }
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

// No rename_all here: these are the providers' own wire names. OAuth
// providers send snake_case query params (`error_description`,
// `oauth_token`, `oauth_verifier`) — camelCasing them silently drops the
// values to None.
#[derive(Debug, Deserialize)]
struct OAuthCallbackQuery {
    // OAuth2 providers echo `state`; OAuth 1.0a (X Live) callbacks instead
    // carry `oauth_token` + `oauth_verifier` (or `denied` on cancel).
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
    oauth_token: Option<String>,
    oauth_verifier: Option<String>,
    denied: Option<String>,
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

/// Serve a session's poster thumbnail (Library rewrite L2). Token-gated like
/// every other media route; 404 until the poster exists.
async fn session_poster_handler(
    State(state): State<AppState>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
    Query(query): Query<WsQuery>,
) -> Response {
    if query.token != state.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match tokio::fs::read(posters::poster_path(&session_id)).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "no-store, no-cache, must-revalidate"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
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
    let result = if let Some(state_param) = query.state {
        complete_oauth_callback(
            &state,
            OAuthCompleteParams {
                state: state_param,
                code: query.code,
                error: query.error,
                error_description: query.error_description,
            },
        )
        .await
    } else {
        complete_x_oauth1_callback(
            &state,
            query.oauth_token,
            query.oauth_verifier,
            query.denied,
        )
        .await
    };
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

/// Completes the X Live 3-legged OAuth 1.0a callback: exchanges the verifier
/// for the user's access token pair and stores it in the secret store. The
/// result rides the same `platformAccounts.oauth.callback` event as OAuth2 so
/// the renderer refresh path is shared.
async fn complete_x_oauth1_callback(
    state: &AppState,
    oauth_token: Option<String>,
    oauth_verifier: Option<String>,
    denied: Option<String>,
) -> oauth::OAuthCallbackResult {
    let received_at = chrono::Utc::now().to_rfc3339();
    let mut result = oauth::OAuthCallbackResult {
        platform: Some(StreamPlatform::X),
        state: String::new(),
        status: oauth::OAuthCallbackStatus::Failed,
        code_present: false,
        error: None,
        message: None,
        token_stored: false,
        account_connected: false,
        received_at,
    };

    if let Some(denied_token) = denied {
        state.x_oauth1.deny(&denied_token).await;
        result.error = Some("access_denied".to_string());
        result.message = Some("X live authorization was denied.".to_string());
        return result;
    }
    let (Some(oauth_token), Some(oauth_verifier)) = (oauth_token, oauth_verifier) else {
        result.status = oauth::OAuthCallbackStatus::UnknownState;
        result.message =
            Some("OAuth callback did not include a state or an X OAuth 1.0a token.".to_string());
        return result;
    };
    result.code_present = true;

    match state
        .x_oauth1
        .complete(&oauth_token, &oauth_verifier, &reqwest::Client::new())
        .await
    {
        Ok(token) => {
            let stored = secrets::put_secret(
                x_live::X_OAUTH1_ACCESS_TOKEN_SECRET_REF,
                &token.access_token,
            )
            .and_then(|()| {
                secrets::put_secret(
                    x_live::X_OAUTH1_TOKEN_SECRET_SECRET_REF,
                    &token.access_token_secret,
                )
            })
            .and_then(|()| match token.screen_name.as_deref() {
                Some(handle) => secrets::put_secret(x_live::X_OAUTH1_HANDLE_SECRET_REF, handle),
                None => secrets::delete_secret(x_live::X_OAUTH1_HANDLE_SECRET_REF),
            });
            match stored {
                Ok(()) => {
                    result.status = oauth::OAuthCallbackStatus::Success;
                    result.token_stored = true;
                    result.message = Some(format!(
                        "X live authorization complete{}.",
                        token
                            .screen_name
                            .as_deref()
                            .map(|handle| format!(" for {handle}"))
                            .unwrap_or_default()
                    ));
                }
                Err(error) => {
                    result.message =
                        Some(format!("Could not store the X live access token: {error}"));
                }
            }
        }
        Err(error) => {
            let message = error.to_string();
            if message.contains("expired") {
                result.status = oauth::OAuthCallbackStatus::Expired;
            } else if message.contains("not pending") {
                result.status = oauth::OAuthCallbackStatus::UnknownState;
            }
            result.message = Some(format!("X live authorization failed: {message}"));
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

fn validate_start_session_oauth_availability(params: &protocol::StartSessionParams) -> Result<()> {
    let Some(streaming) = params
        .streaming
        .as_ref()
        .filter(|streaming| streaming.enabled)
    else {
        return Ok(());
    };
    for target in &streaming.targets {
        let enabled = target.enabled || streaming.enabled_target_ids.contains(&target.id);
        if enabled
            && target.auth_mode == StreamAuthMode::Oauth
            && let Some(message) = oauth::provider_oauth_unavailable_message(target.platform)
        {
            anyhow::bail!("{message}");
        }
    }
    Ok(())
}

async fn prepare_youtube_stream_target(
    state: &AppState,
    params: YouTubePrepareParams,
) -> anyhow::Result<PreparedYouTubeBroadcast> {
    if let Some(message) = oauth::provider_oauth_unavailable_message(StreamPlatform::Youtube) {
        anyhow::bail!("{message}");
    }
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
    if let Some(message) = oauth::provider_oauth_unavailable_message(StreamPlatform::Youtube) {
        anyhow::bail!("{message}");
    }
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
    if let Some(message) = oauth::provider_oauth_unavailable_message(StreamPlatform::Youtube) {
        anyhow::bail!("{message}");
    }
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
    if let Some(message) = oauth::provider_oauth_unavailable_message(StreamPlatform::Youtube) {
        anyhow::bail!("{message}");
    }
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
    if let Some(message) = oauth::provider_oauth_unavailable_message(StreamPlatform::Youtube) {
        anyhow::bail!("{message}");
    }
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
    if let Some(message) = oauth::provider_oauth_unavailable_message(StreamPlatform::Youtube) {
        anyhow::bail!("{message}");
    }
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
    if !credential
        .account
        .scopes
        .iter()
        .any(|scope| scope == live_chat::TWITCH_CHAT_SCOPE)
    {
        anyhow::bail!("Reconnect Twitch to enable live comments.");
    }
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
        platforms: Vec::new(),
        fake: None,
        youtube: None,
        twitch: None,
        x: None,
    };
    for target in &streaming.targets {
        if !enabled.contains(target.id.as_str()) {
            continue;
        }
        match target.platform {
            StreamPlatform::Youtube => {
                if target.auth_mode != crate::streaming::StreamAuthMode::Oauth {
                    continue;
                }
                if !params.platforms.contains(&StreamPlatform::Youtube) {
                    params.platforms.push(StreamPlatform::Youtube);
                }
                match youtube_chat_config(state, target).await {
                    Ok(config) => params.youtube = Some(config),
                    Err(error) => {
                        state.emit_log("warn", format!("YouTube live chat unavailable: {error}"))
                    }
                }
            }
            StreamPlatform::Twitch => match twitch_chat_config(state, target) {
                Ok(config) => {
                    if !params.platforms.contains(&StreamPlatform::Twitch) {
                        params.platforms.push(StreamPlatform::Twitch);
                    }
                    params.twitch = Some(config);
                }
                Err(error) => {
                    if !params.platforms.contains(&StreamPlatform::Twitch) {
                        params.platforms.push(StreamPlatform::Twitch);
                    }
                    state.emit_log("warn", format!("Twitch live chat unavailable: {error}"))
                }
            },
            StreamPlatform::X => {
                if !params.platforms.contains(&StreamPlatform::X) {
                    params.platforms.push(StreamPlatform::X);
                }
            }
            StreamPlatform::Custom => {}
        }
    }
    if !params.platforms.is_empty() {
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

/// Push channel title/category/language for a manual-RTMP Twitch target.
/// Helix channel updates work regardless of ingest path, so a stream-key
/// session with a connected account still gets its metadata applied.
async fn apply_twitch_stream_target_metadata(
    state: &AppState,
    params: TwitchPrepareParams,
) -> anyhow::Result<twitch::TwitchAppliedMetadata> {
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

    twitch::apply_twitch_channel_metadata(
        &TwitchPrepareRequest {
            access_token,
            client_id,
            account_id: credential.account.account_id.clone(),
            account_label: credential.account.account_label.clone(),
            metadata,
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
    x_live::x_native_live_capability(account)
}

/// Kicks off the in-app "Authorize X Live" browser flow (3-legged OAuth
/// 1.0a). The callback lands on the shared loopback OAuth listener.
async fn start_x_live_authorization(
    state: &AppState,
) -> anyhow::Result<x_oauth1::XOauth1StartResult> {
    let consumer = x_live::x_oauth1_consumer()?.context(
        "This build has no X Livestream consumer credentials. Release builds bundle them; self-hosted builds set VIDEORC_X_OAUTH1_CONSUMER_KEY and VIDEORC_X_OAUTH1_CONSUMER_SECRET.",
    )?;
    let callback_url = format!(
        "http://127.0.0.1:{}/oauth/callback",
        state.oauth_redirect_port()
    );
    state
        .x_oauth1
        .start(consumer, &callback_url, &reqwest::Client::new(), None)
        .await
}

async fn prepare_x_native_live(
    state: &AppState,
    params: XPrepareParams,
) -> anyhow::Result<PreparedXStreamSource> {
    let accounts = state.database.list_platform_accounts()?;
    let account = x_live::select_x_account(&accounts, params.account_id.as_deref())?;
    let capability = x_native_live_capability(
        state,
        XNativeLiveCapabilityParams {
            account_id: params.account_id,
        },
    )?;
    x_live::ensure_x_native_live_available(&capability)?;
    let credentials = x_live::x_livestream_credentials()?
        .context("X Livestream OAuth 1.0a credentials are not available. Run Authorize X Live from the Streaming tab.")?;
    let prepared = match x_live::prepare_x_stream_source(
        XPrepareSourceRequest {
            credentials: credentials.clone(),
            account: account.cloned(),
            source_name: x_live::default_source_name(),
            api_base_url: None,
            retired_source_ids: retired_x_source_ids(state),
        },
        &reqwest::Client::new(),
        secrets::put_secret,
    )
    .await
    {
        Ok(prepared) => prepared,
        Err(error) => {
            state.emit_log("error", format!("X source prepare failed: {error}"));
            return Err(error);
        }
    };
    // Prepare runs before the capture session exists — the global log is the
    // durable record (the ring no longer floods with FFmpeg progress spam).
    state.emit_log(
        "info",
        format!(
            "X source prepared: {} ({:?}, region {}){}",
            prepared.source_id,
            prepared.selection,
            prepared.region,
            if prepared.deleted_retired_source_ids.is_empty() {
                String::new()
            } else {
                format!(
                    "; deleted retired source(s) {}",
                    prepared.deleted_retired_source_ids.join(", ")
                )
            }
        ),
    );

    let existing = state
        .database
        .list_platform_account_credentials()?
        .into_iter()
        .find(|credential| credential.account.platform == StreamPlatform::X);
    state
        .database
        .upsert_platform_account(UpsertPlatformAccount {
            platform: StreamPlatform::X,
            account_id: prepared.account_id.clone(),
            account_label: prepared.account_label.clone(),
            account_handle: existing
                .as_ref()
                .and_then(|credential| credential.account.account_handle.clone()),
            avatar_url: existing
                .as_ref()
                .and_then(|credential| credential.account.avatar_url.clone()),
            scopes: existing
                .as_ref()
                .map(|credential| credential.account.scopes.clone())
                .unwrap_or_else(|| vec!["x-livestream-api".to_string()]),
            token_secret_ref: existing
                .as_ref()
                .and_then(|credential| credential.token_secret_ref.clone()),
            refresh_token_secret_ref: existing
                .as_ref()
                .and_then(|credential| credential.refresh_token_secret_ref.clone()),
            stream_key_secret_ref: Some(prepared.stream_key_secret_ref.clone()),
            expires_at: existing
                .as_ref()
                .and_then(|credential| credential.account.expires_at.clone()),
            status: PlatformAccountStatus::Connected,
        })?;
    if let Ok(accounts) = state.database.list_platform_accounts() {
        state.emit_event("platformAccounts.changed", accounts);
    }

    Ok(prepared)
}

async fn publish_x_native_live(
    state: &AppState,
    params: XPublishParams,
) -> anyhow::Result<XPublishResult> {
    let session_id = params.session_id.clone();
    let accounts = state.database.list_platform_accounts()?;
    let account = x_live::select_x_account(&accounts, params.account_id.as_deref())?;
    let capability = x_live::x_native_live_capability(account)?;
    x_live::ensure_x_native_live_available(&capability)?;
    let metadata = state.database.stream_metadata_draft()?;
    let credentials = x_live::x_livestream_credentials()?
        .context("X Livestream OAuth 1.0a credentials are not available. Run Authorize X Live from the Streaming tab.")?;
    let source_id = params.source_id.clone();
    let result = x_live::publish_x_broadcast(
        XPublishRequest {
            credentials,
            source_id: params.source_id,
            region: params.region,
            metadata,
            is_low_latency: params.is_low_latency,
            locale: x_live::default_publish_locale(),
            chat_option: x_live::default_chat_option(),
            api_base_url: None,
            poll_attempts: 10,
            poll_interval_ms: 2_000,
            // Bounded pre-publish playback gate: up to 45s for X to bring up
            // the transcode BEFORE the announcement post goes out.
            pre_publish_probe_attempts: 9,
            pre_publish_probe_interval_ms: 5_000,
        },
        &reqwest::Client::new(),
    )
    .await;

    match &result {
        Ok(published) => {
            log_x_lifecycle(
                state,
                session_id.as_deref(),
                protocol::HealthLevel::Info,
                "x-broadcast-published",
                &format!(
                    "X broadcast {} is live: {}{}{}",
                    published.broadcast_id,
                    published.share_url,
                    match published.playable_before_publish {
                        Some(true) => " (playback verified before the announcement post)",
                        Some(false) =>
                            " (playback was NOT ready before the announcement post; watching)",
                        None => "",
                    },
                    published
                        .tweet_error
                        .as_deref()
                        .map(|error| format!("; announcement post failed: {error}"))
                        .unwrap_or_default()
                ),
            );
            if let Some(compatibility) = published
                .compatibility_info
                .as_ref()
                .filter(|info| x_compatibility_notable(info))
            {
                log_x_lifecycle(
                    state,
                    session_id.as_deref(),
                    protocol::HealthLevel::Warn,
                    "x-source-compatibility",
                    &format!("X ingest compatibility report: {compatibility}"),
                );
            }
            spawn_x_playback_watch(
                state.clone(),
                session_id.clone(),
                source_id,
                published.broadcast_id.clone(),
                published.share_url.clone(),
                published.hls_url.clone(),
                published.playable_before_publish,
            );
        }
        Err(error) => {
            log_x_lifecycle(
                state,
                session_id.as_deref(),
                protocol::HealthLevel::Error,
                "x-publish-failed",
                &format!("X broadcast publish failed: {error}"),
            );
        }
    }

    result
}

async fn end_x_native_live(state: &AppState, params: XEndParams) -> anyhow::Result<XEndResult> {
    let session_id = params.session_id.clone();
    let accounts = state.database.list_platform_accounts()?;
    let account = x_live::select_x_account(&accounts, params.account_id.as_deref())?;
    let capability = x_live::x_native_live_capability(account)?;
    x_live::ensure_x_native_live_available(&capability)?;
    let credentials = x_live::x_livestream_credentials()?
        .context("X Livestream OAuth 1.0a credentials are not available. Run Authorize X Live from the Streaming tab.")?;
    let result = x_live::end_x_broadcast(
        XEndRequest {
            credentials,
            broadcast_id: params.broadcast_id,
            api_base_url: None,
        },
        &reqwest::Client::new(),
    )
    .await;
    match &result {
        Ok(ended) => log_x_lifecycle(
            state,
            session_id.as_deref(),
            protocol::HealthLevel::Info,
            "x-broadcast-ended",
            &format!("X broadcast {} ended.", ended.broadcast_id),
        ),
        Err(error) => log_x_lifecycle(
            state,
            session_id.as_deref(),
            protocol::HealthLevel::Error,
            "x-end-failed",
            &format!("X broadcast end failed: {error}"),
        ),
    }
    result
}

/// X lifecycle evidence: session log when a session exists, global log
/// otherwise — either way it reaches the support bundle.
fn log_x_lifecycle(
    state: &AppState,
    session_id: Option<&str>,
    level: protocol::HealthLevel,
    code: &str,
    message: &str,
) {
    let log_level = match level {
        protocol::HealthLevel::Error => "error",
        protocol::HealthLevel::Warn => "warn",
        protocol::HealthLevel::Info => "info",
    };
    match session_id {
        Some(session_id) => {
            if recording::emit_health_event(state, Some(session_id), level, code, message).is_err()
            {
                state.emit_log(log_level, message);
            }
        }
        None => state.emit_log(log_level, message),
    }
}

fn x_compatibility_notable(info: &serde_json::Value) -> bool {
    ["errors", "warnings"].iter().any(|key| {
        info.get(key)
            .and_then(serde_json::Value::as_array)
            .is_some_and(|entries| !entries.is_empty())
    })
}

fn retired_x_source_ids(state: &AppState) -> Vec<String> {
    x_source_health_map(state)
        .into_iter()
        .filter(|(_, health)| health.retired)
        .map(|(source_id, _)| source_id)
        .collect()
}

fn x_source_health_map(
    state: &AppState,
) -> std::collections::HashMap<String, x_live::XSourceHealth> {
    state
        .database
        .load_setting(x_live::X_SOURCE_HEALTH_SETTING)
        .ok()
        .flatten()
        .unwrap_or_default()
}

fn record_x_playback_outcome(state: &AppState, source_id: &str, verified: bool) {
    let mut map = x_source_health_map(state);
    let health = map.remove(source_id).unwrap_or_default();
    let updated =
        x_live::apply_x_playback_outcome(health, verified, &chrono::Utc::now().to_rfc3339());
    let retired = updated.retired;
    map.insert(source_id.to_string(), updated);
    if let Err(error) = state
        .database
        .save_setting(x_live::X_SOURCE_HEALTH_SETTING, &map)
    {
        state.emit_log(
            "warn",
            format!("Could not persist X source health for {source_id}: {error}"),
        );
    }
    if retired && !verified {
        state.emit_log(
            "warn",
            format!(
                "X source {source_id} retired after {} consecutive sessions without playback; the next Go Live will replace it.",
                x_live::X_SOURCE_RETIRE_FAILURES
            ),
        );
    }
}

const X_PLAYBACK_WATCH_INTERVAL_MS: u64 = 5_000;
const X_PLAYBACK_WATCH_MAX_ATTEMPTS: u32 = 60; // ~5 minutes
const X_PLAYBACK_PENDING_WARN_AFTER_MS: u128 = 90_000;

/// Post-publish playback watch: keeps probing the broadcast's HLS playlist
/// so the broadcaster learns within seconds whether viewers can actually
/// watch — the 2026-07-08 incident streamed 108s to a spinner in silence.
#[allow(clippy::too_many_arguments)]
fn spawn_x_playback_watch(
    state: AppState,
    session_id: Option<String>,
    source_id: String,
    broadcast_id: String,
    share_url: String,
    hls_url: Option<String>,
    playable_before_publish: Option<bool>,
) {
    let Some(hls_url) = hls_url else {
        log_x_lifecycle(
            &state,
            session_id.as_deref(),
            protocol::HealthLevel::Warn,
            "x-playback-unknown",
            "X did not return a playback URL for this broadcast; watchability cannot be verified.",
        );
        return;
    };

    tokio::spawn(async move {
        let client = reqwest::Client::new();
        let published_at = std::time::Instant::now();
        let emit_status = |status: &str, ms_after_publish: Option<u64>| {
            state.emit_event(
                "streamTargets.x.playback",
                serde_json::json!({
                    "sessionId": session_id,
                    "broadcastId": broadcast_id,
                    "shareUrl": share_url,
                    "status": status,
                    "msAfterPublish": ms_after_publish,
                }),
            );
        };

        if playable_before_publish == Some(true) {
            log_x_lifecycle(
                &state,
                session_id.as_deref(),
                protocol::HealthLevel::Info,
                "x-playback-verified",
                &format!(
                    "Viewers can watch your X broadcast (verified before publish): {share_url}"
                ),
            );
            emit_status("verified", Some(0));
            record_x_playback_outcome(&state, &source_id, true);
            return;
        }

        let mut warned_pending = false;
        for _ in 0..X_PLAYBACK_WATCH_MAX_ATTEMPTS {
            if x_live::x_playlist_playable(&client, &hls_url)
                .await
                .unwrap_or(false)
            {
                let elapsed = published_at.elapsed().as_millis() as u64;
                log_x_lifecycle(
                    &state,
                    session_id.as_deref(),
                    protocol::HealthLevel::Info,
                    "x-playback-verified",
                    &format!(
                        "Viewers can watch your X broadcast ({}s after publish): {share_url}",
                        elapsed / 1_000
                    ),
                );
                emit_status("verified", Some(elapsed));
                record_x_playback_outcome(&state, &source_id, true);
                return;
            }
            if !warned_pending
                && published_at.elapsed().as_millis() >= X_PLAYBACK_PENDING_WARN_AFTER_MS
            {
                warned_pending = true;
                log_x_lifecycle(
                    &state,
                    session_id.as_deref(),
                    protocol::HealthLevel::Warn,
                    "x-playback-pending",
                    "X is still provisioning playback — viewers may see a loading spinner. Keep streaming; this can take a few minutes.",
                );
                emit_status("pending", Some(published_at.elapsed().as_millis() as u64));
            }
            // Stop probing once this session is no longer the active one.
            if let Some(session_id) = session_id.as_deref() {
                let active = state
                    .recording
                    .lock()
                    .await
                    .as_ref()
                    .map(|active| active.session_id.clone());
                if active.as_deref() != Some(session_id) {
                    return;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(
                X_PLAYBACK_WATCH_INTERVAL_MS,
            ))
            .await;
        }

        log_x_lifecycle(
            &state,
            session_id.as_deref(),
            protocol::HealthLevel::Error,
            "x-playback-unavailable",
            "X never produced playback for this broadcast — viewers saw a loading spinner. Your local recording is unaffected.",
        );
        emit_status(
            "unavailable",
            Some(published_at.elapsed().as_millis() as u64),
        );
        record_x_playback_outcome(&state, &source_id, false);
    });
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
            // The account no longer vouches for premium — drop hydrated
            // entitlements with it (multistream gate closes immediately).
            if entitlements::clear_account_entitlements() {
                state.emit_event("entitlements.updated", entitlements::current_entitlements());
            }
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
            let entitlement_state = state.clone();
            tokio::spawn(async move { refresh_account_entitlements(&entitlement_state).await });
            ServerResponse::ok(command.id, resolved)
        }
        "account.refresh" => {
            let resolved = account::refresh_account().await;
            *state.account_session.lock().await = Some(resolved.clone());
            let entitlement_state = state.clone();
            tokio::spawn(async move { refresh_account_entitlements(&entitlement_state).await });
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
        "captions.overlay.set" => {
            let png_base64 = command
                .params
                .get("pngBase64")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let position = command
                .params
                .get("position")
                .and_then(|value| {
                    serde_json::from_value::<captions::CaptionOverlayPosition>(value.clone()).ok()
                })
                .unwrap_or(captions::CaptionOverlayPosition::Bottom);
            match captions::install_caption_overlay(&state.caption_overlay, png_base64, position) {
                Ok(info) => ServerResponse::ok(command.id, info),
                Err(error) => {
                    ServerResponse::error(command.id, "captions-overlay-invalid", error.to_string())
                }
            }
        }
        // Comment-highlight overlay (Comments upgrade S2): its own slot, top
        // position by default — it must coexist with the captions bar.
        "comments.highlight.set" => {
            let png_base64 = command
                .params
                .get("pngBase64")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let position = command
                .params
                .get("position")
                .and_then(|value| {
                    serde_json::from_value::<captions::CaptionOverlayPosition>(value.clone()).ok()
                })
                .unwrap_or(captions::CaptionOverlayPosition::Top);
            match captions::install_caption_overlay(&state.highlight_overlay, png_base64, position)
            {
                Ok(info) => ServerResponse::ok(command.id, info),
                Err(error) => ServerResponse::error(
                    command.id,
                    "comments-highlight-invalid",
                    error.to_string(),
                ),
            }
        }
        "comments.highlight.clear" => ServerResponse::ok(
            command.id,
            captions::clear_caption_overlay(&state.highlight_overlay),
        ),
        "captions.overlay.clear" => ServerResponse::ok(
            command.id,
            captions::clear_caption_overlay(&state.caption_overlay),
        ),
        "captions.cues.submit" => {
            let request_id = command
                .params
                .get("requestId")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            let seq = command
                .params
                .get("seq")
                .and_then(|value| value.as_u64())
                .unwrap_or(u64::MAX);
            let png_base64 = command
                .params
                .get("pngBase64")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            match captions::submit_caption_cue_frame(state, &request_id, seq, png_base64).await {
                Ok(completed) => {
                    ServerResponse::ok(command.id, serde_json::json!({ "completed": completed }))
                }
                Err(error) => {
                    ServerResponse::error(command.id, "captions-cue-invalid", error.to_string())
                }
            }
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
                    let microphone_id = params.microphone_id.clone();
                    let result = devices::sample_audio_meter(params).await;
                    {
                        let mut last_audio_meter = state.last_audio_meter.lock().await;
                        *last_audio_meter = Some(protocol::AudioMeterSampleSnapshot {
                            microphone_id,
                            result: result.clone(),
                            sampled_at: chrono::Utc::now().to_rfc3339(),
                        });
                    }
                    ServerResponse::ok(command.id, result)
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "audio.meter.probeNative" => {
            match serde_json::from_value::<protocol::AudioMeterProbeParams>(command.params) {
                Ok(params) => ServerResponse::ok(
                    command.id,
                    devices::sample_native_audio_meters(params).await,
                ),
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
                Ok(params) => match validate_start_session_oauth_availability(&params) {
                    Ok(()) => match start_session(state.clone(), params).await {
                        Ok(status) => ServerResponse::ok(command.id, status),
                        Err(error) => ServerResponse::error(
                            command.id,
                            "recording-start-failed",
                            error.to_string(),
                        ),
                    },
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
                    match validate_start_session_oauth_availability(&params) {
                        Ok(()) => match start_session(state.clone(), params).await {
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
                        },
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
        "sessions.list" => {
            // Library rewrite L1: the manager wants the whole library, not the
            // dashboard's last-20 slice; the limit is caller-chosen, bounded.
            let limit = command
                .params
                .get("limit")
                .and_then(|value| value.as_u64())
                .unwrap_or(20)
                .clamp(1, 500) as usize;
            match state.database.list_sessions(limit) {
                Ok(sessions) => ServerResponse::ok(command.id, sessions),
                Err(error) => {
                    ServerResponse::error(command.id, "sessions-list-failed", error.to_string())
                }
            }
        }
        "sessions.poster" => {
            let session_id = command
                .params
                .get("sessionId")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            let ffmpeg_path = ffmpeg::resolve_ffmpeg_path(
                command
                    .params
                    .get("ffmpegPath")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
            );
            let available = match state.database.session_file_facts(&session_id) {
                Ok(Some((recording_path, duration_ms))) => {
                    posters::ensure_session_poster(
                        state,
                        &session_id,
                        &recording_path,
                        duration_ms,
                        &ffmpeg_path,
                    )
                    .await
                }
                _ => posters::poster_path(&session_id).exists(),
            };
            ServerResponse::ok(command.id, serde_json::json!({ "available": available }))
        }
        "sessions.rename" => {
            let session_id = command
                .params
                .get("sessionId")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let title = command
                .params
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if title.is_empty() || title.chars().count() > 120 {
                ServerResponse::error(
                    command.id,
                    "session-rename-invalid",
                    "Titles must be 1-120 characters.",
                )
            } else {
                match state.database.rename_session(session_id, &title) {
                    Ok(true) => {
                        ServerResponse::ok(command.id, serde_json::json!({ "renamed": true }))
                    }
                    Ok(false) => ServerResponse::error(
                        command.id,
                        "session-rename-missing",
                        "Session not found.",
                    ),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "session-rename-failed",
                        error.to_string(),
                    ),
                }
            }
        }
        "sessions.delete" => {
            let session_ids: Vec<String> = command
                .params
                .get("sessionIds")
                .and_then(|value| value.as_array())
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            if session_ids.is_empty() {
                ServerResponse::error(command.id, "session-delete-invalid", "No sessions given.")
            } else {
                match state.database.delete_sessions(&session_ids) {
                    Ok(deleted) => {
                        for id in &session_ids {
                            posters::remove_session_poster(id).await;
                        }
                        ServerResponse::ok(command.id, serde_json::json!({ "deleted": deleted }))
                    }
                    Err(error) => ServerResponse::error(
                        command.id,
                        "session-delete-failed",
                        error.to_string(),
                    ),
                }
            }
        }
        "sessions.duplicate" => {
            let session_id = command
                .params
                .get("sessionId")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            match session_ops::duplicate_session(state, session_id).await {
                Ok(new_id) => {
                    ServerResponse::ok(command.id, serde_json::json!({ "sessionId": new_id }))
                }
                Err(error) => {
                    ServerResponse::error(command.id, "session-duplicate-failed", error.to_string())
                }
            }
        }
        "sessions.import" => {
            let source_path = command
                .params
                .get("sourcePath")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let output_directory = command
                .params
                .get("outputDirectory")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let ffmpeg_path = ffmpeg::resolve_ffmpeg_path(
                command
                    .params
                    .get("ffmpegPath")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
            );
            match session_ops::import_recording(state, source_path, output_directory, &ffmpeg_path)
                .await
            {
                Ok(id) => ServerResponse::ok(command.id, serde_json::json!({ "sessionId": id })),
                Err(error) => {
                    ServerResponse::error(command.id, "session-import-failed", error.to_string())
                }
            }
        }
        "sessions.storage" => match state.database.session_storage_totals() {
            Ok(totals) => ServerResponse::ok(command.id, totals),
            Err(error) => {
                ServerResponse::error(command.id, "sessions-storage-failed", error.to_string())
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
        "liveChat.x.start" => {
            match serde_json::from_value::<live_chat::StartXLiveChatParams>(command.params) {
                Ok(params) => match live_chat::start_x_live_chat(state, params).await {
                    Ok(snapshot) => ServerResponse::ok(command.id, snapshot),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "live-chat-x-start-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "liveChat.stop" => ServerResponse::ok(command.id, live_chat::stop_live_chat(state).await),
        "liveChat.diagnostics" => {
            ServerResponse::ok(command.id, live_chat::current_diagnostics(state).await)
        }
        "liveChat.send" => {
            let text = command
                .params
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if text.is_empty() || text.chars().count() > 200 {
                ServerResponse::error(
                    command.id,
                    "live-chat-send-invalid",
                    "Chat messages must be 1-200 characters.",
                )
            } else {
                ServerResponse::ok(
                    command.id,
                    live_chat::send_live_chat_message(state, &text).await,
                )
            }
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
                        if params.platform == StreamPlatform::X {
                            // Disconnecting X revokes the local live authorization
                            // too — the OAuth 1.0a token pair must not outlive the
                            // account it belongs to.
                            for secret_ref in [
                                x_live::X_OAUTH1_ACCESS_TOKEN_SECRET_REF,
                                x_live::X_OAUTH1_TOKEN_SECRET_SECRET_REF,
                                x_live::X_OAUTH1_HANDLE_SECRET_REF,
                            ] {
                                if let Err(error) = secrets::delete_secret(secret_ref) {
                                    state.emit_log(
                                        "warn",
                                        format!(
                                            "Could not delete X live secret {secret_ref}: {error}"
                                        ),
                                    );
                                }
                            }
                        }
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
        "streamTargets.twitch.applyMetadata" => {
            match serde_json::from_value::<TwitchPrepareParams>(command.params) {
                Ok(params) => match apply_twitch_stream_target_metadata(state, params).await {
                    Ok(applied) => ServerResponse::ok(command.id, applied),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "twitch-apply-metadata-failed",
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
        "streamTargets.x.startLiveAuthorization" => match start_x_live_authorization(state).await {
            Ok(result) => ServerResponse::ok(command.id, result),
            Err(error) => {
                ServerResponse::error(command.id, "x-live-authorization-failed", error.to_string())
            }
        },
        "streamTargets.x.prepare" => {
            match serde_json::from_value::<XPrepareParams>(command.params) {
                Ok(params) => match prepare_x_native_live(state, params).await {
                    Ok(prepared) => ServerResponse::ok(command.id, prepared),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "x-native-live-unavailable",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "streamTargets.x.publish" => {
            match serde_json::from_value::<XPublishParams>(command.params) {
                Ok(params) => match publish_x_native_live(state, params).await {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => {
                        ServerResponse::error(command.id, "x-publish-failed", error.to_string())
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "streamTargets.x.end" => match serde_json::from_value::<XEndParams>(command.params) {
            Ok(params) => match end_x_native_live(state, params).await {
                Ok(result) => ServerResponse::ok(command.id, result),
                Err(error) => ServerResponse::error(command.id, "x-end-failed", error.to_string()),
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
                        if let Some(recording) = state.recording.lock().await.as_ref()
                            && let Err(error) =
                                recording.set_active_screen_path(Some(&screen.image_path))
                        {
                            return ServerResponse::error(
                                command.id,
                                "screen-activate-failed",
                                error.to_string(),
                            );
                        }
                        // Always re-push the compositor scene: the STANDBY
                        // preview uses the same compositor, so activation must
                        // change what the user sees immediately, not only once
                        // a recording's encoder bridge is running (no-op when
                        // no scene exists yet).
                        update_compositor_active_screen(state, Some(screen.clone())).await;
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
                if let Some(recording) = state.recording.lock().await.as_ref()
                    && let Err(error) = recording.set_active_screen_path(None)
                {
                    return ServerResponse::error(
                        command.id,
                        "screen-clear-failed",
                        error.to_string(),
                    );
                }
                // Mirror screens.activate: the standby preview must drop the
                // takeover the moment it is deactivated.
                update_compositor_active_screen(state, None).await;
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

/// Re-verify the signed-in account's entitlement and hydrate the enforcement
/// snapshot (multistream premium gate). Signed-out clears to basic instantly;
/// a network failure keeps the last verified hydration (bounded by the 24h
/// staleness ceiling in entitlements.rs) so a flaky connection cannot flap a
/// paying user back to basic mid-day. Emits `entitlements.updated` on change.
async fn refresh_account_entitlements(state: &AppState) {
    let changed = match account::stored_session_token() {
        None => entitlements::clear_account_entitlements(),
        Some(token) => match videorc_api::VideorcApiClient::new() {
            Ok(client) => match client.get_ai_capabilities(&token).await {
                Ok(capabilities) => match capabilities.entitlement_token.as_deref() {
                    // Prefer the signed token: verified locally, persisted for
                    // offline grace until its exp.
                    Some(entitlement_token) => {
                        match entitlements::hydrate_account_entitlements_from_token(
                            entitlement_token,
                        ) {
                            Ok(changed) => {
                                account::persist_entitlement_token(entitlement_token);
                                changed
                            }
                            Err(error) => {
                                tracing::warn!(
                                    "Entitlement token failed verification; falling back to the \
                                     unsigned entitlement: {error:#}"
                                );
                                entitlements::hydrate_account_entitlements(
                                    capabilities.entitlement.is_premium,
                                )
                            }
                        }
                    }
                    // Older web deploy / unconfigured signing key: unsigned
                    // boolean with its short staleness ceiling.
                    None => entitlements::hydrate_account_entitlements(
                        capabilities.entitlement.is_premium,
                    ),
                },
                Err(error) => {
                    tracing::info!(
                        "Account entitlement refresh failed (keeping last verified): {error}"
                    );
                    false
                }
            },
            Err(_) => false,
        },
    };
    if changed {
        state.emit_event("entitlements.updated", entitlements::current_entitlements());
    }
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
        app_version: params.app_version,
        renderer_diagnostics: params.renderer_diagnostics,
        database_path: state.database.path().clone(),
        health: backend_health(state, ffmpeg_path).await,
        devices: devices::list_devices(ffmpeg_path).await,
        last_audio_meter: state.last_audio_meter.lock().await.clone(),
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

    // Regression: OAuthCallbackQuery once carried rename_all = "camelCase",
    // which silently dropped the snake_case params providers actually send
    // (oauth_token/oauth_verifier from X's OAuth 1.0a redirect landed as None
    // and every Authorize X Live ended in "state not found").
    #[tokio::test]
    async fn oauth_callback_query_parses_provider_snake_case_params() {
        use axum::extract::FromRequestParts;

        let request = axum::http::Request::builder()
            .uri(
                "/oauth/callback?oauth_token=req-token&oauth_verifier=verifier-1&denied=denied-token&error_description=denied%20by%20user",
            )
            .body(())
            .unwrap();
        let (mut parts, _) = request.into_parts();
        let Query(query) = Query::<OAuthCallbackQuery>::from_request_parts(&mut parts, &())
            .await
            .unwrap();

        assert_eq!(query.oauth_token.as_deref(), Some("req-token"));
        assert_eq!(query.oauth_verifier.as_deref(), Some("verifier-1"));
        assert_eq!(query.denied.as_deref(), Some("denied-token"));
        assert_eq!(query.error_description.as_deref(), Some("denied by user"));
        assert_eq!(query.state, None);
        assert_eq!(query.code, None);
    }

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

    fn streaming_with_enabled_target(
        platform: StreamPlatform,
        auth_mode: crate::streaming::StreamAuthMode,
    ) -> crate::streaming::StreamingSettings {
        let mut targets = crate::streaming::default_stream_targets();
        for target in &mut targets {
            target.enabled = target.platform == platform;
            if target.platform == platform {
                target.auth_mode = auth_mode;
                target.stream_key_present = true;
                target.stream_key_secret_ref = Some(format!(
                    "stream-target:{}:manual-stream-key",
                    crate::streaming::stream_platform_id(platform)
                ));
            }
        }
        let enabled_target_ids = targets
            .iter()
            .filter(|target| target.enabled)
            .map(|target| target.id.clone())
            .collect::<Vec<_>>();
        crate::streaming::StreamingSettings {
            enabled: true,
            mode: crate::streaming::StreamMode::Single,
            targets,
            selected_target_id: Some(crate::streaming::stream_platform_id(platform).to_string()),
            default_output_preset: protocol::VideoPreset::StreamSafe1080p30,
            default_bitrate_kbps: 6_000,
            enabled_target_ids,
        }
    }

    fn upsert_twitch_account(state: &AppState, scopes: Vec<String>) {
        state
            .database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Twitch,
                account_id: "twitch-channel-1".to_string(),
                account_label: "Twitch Channel".to_string(),
                account_handle: Some("twitch_channel".to_string()),
                avatar_url: None,
                scopes,
                token_secret_ref: None,
                refresh_token_secret_ref: None,
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap();
    }

    #[tokio::test]
    async fn manual_twitch_stream_starts_status_only_chat_session_without_oauth_account() {
        let state = test_state();
        let streaming = streaming_with_enabled_target(
            StreamPlatform::Twitch,
            crate::streaming::StreamAuthMode::ManualRtmp,
        );

        spawn_session_live_chat(&state, "manual-twitch-session", &streaming).await;

        let snapshot = live_chat::current_status(&state).await;
        assert_eq!(
            snapshot.session_id.as_deref(),
            Some("manual-twitch-session")
        );
        assert_eq!(snapshot.providers.len(), 1);
        let twitch = snapshot
            .providers
            .iter()
            .find(|provider| provider.platform == StreamPlatform::Twitch)
            .expect("twitch provider row");
        assert_eq!(
            twitch.state,
            live_chat::LiveChatProviderConnectionState::Disabled
        );
        assert!(twitch.message.contains("Connect Twitch"));
    }

    #[tokio::test]
    async fn manual_twitch_stream_surfaces_reconnect_when_account_lacks_chat_scope() {
        let state = test_state();
        upsert_twitch_account(
            &state,
            vec![
                "channel:manage:broadcast".to_string(),
                "channel:read:stream_key".to_string(),
            ],
        );
        let streaming = streaming_with_enabled_target(
            StreamPlatform::Twitch,
            crate::streaming::StreamAuthMode::ManualRtmp,
        );

        spawn_session_live_chat(&state, "stale-twitch-session", &streaming).await;

        let snapshot = live_chat::current_status(&state).await;
        assert_eq!(snapshot.session_id.as_deref(), Some("stale-twitch-session"));
        assert_eq!(snapshot.providers.len(), 1);
        let twitch = snapshot
            .providers
            .iter()
            .find(|provider| provider.platform == StreamPlatform::Twitch)
            .expect("twitch provider row");
        assert_eq!(
            twitch.state,
            live_chat::LiveChatProviderConnectionState::Disabled
        );
        assert!(twitch.message.contains("Reconnect Twitch"));
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
