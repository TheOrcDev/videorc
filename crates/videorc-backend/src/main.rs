mod account;
mod ai;
mod atomic_file;
mod audio;
mod backend_authority;
mod camera_capture;
mod captions;
mod capture_input;
mod capture_interruption;
mod color;
mod comment_highlight;
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
mod h264_profile;
mod live_chat;
mod live_chat_persistence;
mod live_layout;
mod live_pipeline;
mod live_render;
mod live_scene;
mod metal_compositor;
mod mpeg_ts;
mod native_preview_host;
mod noise_cleanup;
mod oauth;
mod pipeline;
mod posters;
mod preflight;
mod preview_bmp;
mod preview_camera;
mod preview_screen;
mod preview_surface;
mod process_job;
mod protocol;
mod publish_clips;
mod recording;
mod repair;
mod repair_service;
mod resource_authority;
mod scene;
mod scene_geometry;
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
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use compositor::{compositor_status, update_compositor_active_screen, update_compositor_scene};
#[cfg(debug_assertions)]
use encoder_bridge::run_synthetic_encoder_bridge;
use futures_util::stream;
use futures_util::{SinkExt, StreamExt};
use preview_camera::{
    latest_preview_camera_bmp, latest_preview_camera_png, preview_camera_status,
    start_preview_camera, stop_preview_camera,
};
use preview_screen::{
    latest_preview_screen_bmp, latest_preview_screen_png, preview_screen_status,
    start_preview_screen, stop_preview_screen,
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
    stop_live_preview, stop_recording, subscribe_live_preview_frames,
    update_active_audio_processing, update_preview_frame_age,
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

const ENTITLEMENT_REFRESH_TIMEOUT: Duration = Duration::from_secs(10);

use crate::backend_authority::{
    BackendBootstrap, BackendRole, authenticate_backend_token, authorize_backend_method,
    resolve_trusted_ffmpeg_path, scrub_untrusted_ffmpeg_paths,
};
use crate::ffmpeg::{default_ffmpeg_path, resolve_ffmpeg_path_ref};
use crate::oauth::{OAuthCompleteParams, OAuthStartParams, OAuthStartProviderParams};
use crate::preflight::GoLivePreflightParams;
use crate::process_job::output_owned_tokio;
use crate::state::{
    AppState, TrackedWebSocketQueueMetrics, WebSocketQueueTicket, WebSocketTransportMetrics,
};
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
    diagnostics::start_runtime_resource_sampler();

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
    match database.reconcile_session_finalization_recoveries() {
        Ok(summary) if summary.recovered > 0 || summary.pending > 0 => tracing::warn!(
            "Replayed {} recording finalization recovery record(s); {} remain pending: {:?}",
            summary.recovered,
            summary.pending,
            summary.errors
        ),
        Ok(_) => {}
        Err(error) => tracing::warn!("Could not reconcile recording finalizations: {error:#}"),
    }
    match database.reconcile_session_deletions() {
        Ok(summary) if summary.completed > 0 || summary.pending > 0 => tracing::warn!(
            "Completed {} interrupted Library deletion(s); {} still require Trash retry: {:?}",
            summary.completed,
            summary.pending,
            summary.errors
        ),
        Ok(_) => {}
        Err(error) => tracing::warn!("Could not reconcile Library deletions: {error:#}"),
    }
    match database.reconcile_session_file_operations() {
        Ok(summary) if summary.published > 0 || summary.discarded > 0 || summary.pending > 0 => {
            tracing::warn!(
                "Reconciled Library file operations: {} published, {} discarded, {} pending: {:?}",
                summary.published,
                summary.discarded,
                summary.pending,
                summary.errors
            )
        }
        Ok(_) => {}
        Err(error) => tracing::warn!("Could not reconcile Library file operations: {error:#}"),
    }
    match database.reconcile_orphaned_sessions() {
        Ok(0) => {}
        Ok(reconciled) => tracing::warn!(
            "Marked {reconciled} orphaned 'running' session(s) as failed (previous backend did not shut down cleanly)."
        ),
        Err(error) => tracing::warn!("Could not reconcile orphaned sessions: {error:#}"),
    }
    match database.reconcile_orphaned_chat_send_operations() {
        Ok(0) => {}
        Ok(reconciled) => tracing::warn!(
            "Marked {reconciled} interrupted Comments send operation(s) as delivery unknown."
        ),
        Err(error) => tracing::warn!("Could not reconcile Comments send operations: {error:#}"),
    }
    let mut state = AppState::new(token.clone(), port, events, database);
    state.oauth_callback_port = oauth_callback_port;
    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/preview/live.mjpeg", get(live_preview_handler))
        .route("/preview/live.jpg", get(live_preview_frame_handler))
        .route("/preview/camera/live.png", get(live_camera_frame_handler))
        .route("/preview/screen/live.png", get(live_screen_frame_handler))
        .route("/preview/camera/latest.bmp", get(live_camera_bmp_handler))
        .route("/preview/screen/latest.bmp", get(live_screen_bmp_handler))
        .route("/preview/{id}", get(preview_handler))
        .route("/sessions/{id}/poster", get(session_poster_handler))
        .route("/compositor/status", get(compositor_status_handler))
        .route(
            "/interruption/lease",
            post(acquire_interruption_lease_handler),
        )
        .route(
            "/interruption/lease/{lease_id}",
            delete(release_interruption_lease_handler).put(renew_interruption_lease_handler),
        )
        .route(
            "/interruption/lease/{lease_id}/consume",
            post(consume_interruption_lease_handler),
        )
        .route("/oauth/callback", get(oauth_callback_handler))
        .route("/ws", get(ws_handler))
        .with_state(state.clone());

    // READY is a private bootstrap message consumed by Electron main. Main
    // must strip `adminToken` before any log, smoke marker, preload response,
    // or renderer event. Ordinary backend.ready events use BackendConnection
    // below and therefore contain only the renderer-scoped credential.
    let ready = backend_bootstrap(&state);
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
    tokio::spawn(resume_pending_oauth_completions(state.clone()));
    // Resume interrupted repair jobs through the idle-only maintenance queue.
    tokio::spawn(resume_pending_repair_jobs(state.clone()));
    noise_cleanup::resume_interrupted(&state);
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
        "Backend shutdown requested; stopping caption, capture, and artifact processes.",
    );
    captions::shutdown_caption_runtime(&state).await;
    state.noise_cleanup.interrupt_all_for_shutdown();
    shutdown_capture_processes(state.clone()).await;
    captions::shutdown_caption_artifacts(&state).await;
}

/// A dedicated OS thread that kills this process when its parent dies. This MUST be
/// a plain thread, not a tokio task: the async watchdog variant below failed in the
/// field because a wedged runtime stops polling exactly when the process most needs
/// to die. Orphaned backends hold the camera/microphone/ScreenCaptureKit and starve
/// fresh app instances (screen layers fall to the synthetic pattern mid-session).
///
/// On Windows the same guarantee comes from waiting on a `VIDEORC_SUPERVISOR_PID`
/// process handle: when the Electron supervisor exits (including a crash), the wait
/// completes and the backend exits, and the backend-owned Job Object
/// (`process_job.rs`, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) tears down its ffmpeg
/// children with it. See docs/windows-port-plan.md, Phase 1.
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

    #[cfg(windows)]
    {
        use windows::Win32::Foundation::WAIT_OBJECT_0;
        use windows::Win32::System::Threading::{
            INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
        };

        let Some(supervisor_pid) = std::env::var("VIDEORC_SUPERVISOR_PID")
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .filter(|pid| *pid > 1)
        else {
            // No supervisor (bare `cargo run` / smoke harness): nothing to watch.
            return;
        };
        std::thread::spawn(move || {
            let handle = match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, supervisor_pid) } {
                Ok(handle) => handle,
                // The supervisor is already gone (or unwaitable): treat it as
                // dead rather than running unsupervised with live devices.
                Err(_) => {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    eprintln!(
                        "Supervisor process {supervisor_pid} is not waitable; exiting so capture devices are released."
                    );
                    std::process::exit(1);
                }
            };
            let wait = unsafe { WaitForSingleObject(handle, INFINITE) };
            if wait == WAIT_OBJECT_0 {
                // Give the async graceful path a moment, then exit
                // unconditionally; process teardown releases every capture
                // device and drops the Job Object holding the ffmpeg children.
                std::thread::sleep(std::time::Duration::from_secs(5));
                eprintln!("Supervisor process died; exiting so capture devices are released.");
                std::process::exit(1);
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

fn backend_bootstrap(state: &AppState) -> BackendBootstrap {
    BackendBootstrap {
        host: "127.0.0.1".to_string(),
        port: state.port,
        token: state.token.clone(),
        admin_token: state.admin_token.clone(),
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
    #[serde(default)]
    after_sequence: Option<u64>,
    #[serde(default)]
    after_generation: Option<String>,
    /// PNG endpoints are retained only as an explicit developer/debug fallback.
    #[serde(default)]
    debug: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InterruptionLeaseQuery {
    token: String,
    owner_id: String,
    action: String,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InterruptionLeaseResponse {
    lease_id: String,
    expires_in_ms: u64,
    consumed: bool,
}

#[derive(Debug, serde::Serialize)]
struct InterruptionLeaseErrorResponse {
    code: &'static str,
    message: String,
}

impl WsQuery {
    fn preview_bmp_cursor(&self) -> Option<preview_bmp::PreviewBmpCursor> {
        Some(preview_bmp::PreviewBmpCursor {
            generation: self.after_generation.clone()?,
            sequence: self.after_sequence?,
        })
    }
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

fn http_backend_role(state: &AppState, token: &str) -> Option<BackendRole> {
    authenticate_backend_token(token, &state.token, &state.admin_token)
}

async fn health_handler(State(state): State<AppState>, Query(query): Query<WsQuery>) -> Response {
    let role = http_backend_role(&state, &query.token);
    if role.is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let ffmpeg_path = default_ffmpeg_path();
    let mut health = backend_health(&state, &ffmpeg_path).await;
    if role == Some(BackendRole::Renderer) {
        health.database_path = "managed-app-data".to_string();
        health.ffmpeg.path = "trusted-bundled-ffmpeg".to_string();
    }
    Json(health).into_response()
}

async fn compositor_status_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
) -> impl IntoResponse {
    let Some(role) = http_backend_role(&state, &query.token) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    let status = compositor_status(&state).await;
    if role == BackendRole::Renderer {
        let mut value = serde_json::to_value(status).unwrap_or(serde_json::Value::Null);
        resource_authority::redact_managed_screen_paths(&mut value);
        Json(value).into_response()
    } else {
        Json(serde_json::to_value(status).unwrap_or(serde_json::Value::Null)).into_response()
    }
}

async fn acquire_interruption_lease_handler(
    State(state): State<AppState>,
    Query(query): Query<InterruptionLeaseQuery>,
) -> Response {
    if http_backend_role(&state, &query.token) != Some(BackendRole::Admin) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if query
        .reason
        .as_deref()
        .is_some_and(|reason| reason.len() > 256)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(InterruptionLeaseErrorResponse {
                code: "invalid-reason",
                message: "Interruption reason must be at most 256 bytes.".to_string(),
            }),
        )
            .into_response();
    }
    if !valid_interruption_identifier(&query.owner_id, 128)
        || !valid_interruption_identifier(&query.action, 64)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(InterruptionLeaseErrorResponse {
                code: "invalid-owner-or-action",
                message: "Interruption owner and action must be bounded ASCII identifiers."
                    .to_string(),
            }),
        )
            .into_response();
    }

    match state
        .capture_interruption
        .try_acquire_interruption(&query.owner_id, &query.action)
    {
        Ok(grant) => (
            StatusCode::CREATED,
            Json(interruption_lease_response(grant)),
        )
            .into_response(),
        Err(blocker) => (
            StatusCode::CONFLICT,
            Json(InterruptionLeaseErrorResponse {
                code: "capture-not-idle",
                message: blocker.to_string(),
            }),
        )
            .into_response(),
    }
}

fn valid_interruption_identifier(value: &str, max_length: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_length
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
        })
}

fn interruption_lease_response(
    grant: capture_interruption::InterruptionLeaseGrant,
) -> InterruptionLeaseResponse {
    InterruptionLeaseResponse {
        lease_id: grant.lease_id,
        expires_in_ms: grant.expires_in_ms,
        consumed: grant.consumed,
    }
}

async fn consume_interruption_lease_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    AxumPath(lease_id): AxumPath<String>,
) -> Response {
    if http_backend_role(&state, &query.token) != Some(BackendRole::Admin) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match state.capture_interruption.consume_interruption(&lease_id) {
        Some(grant) => Json(interruption_lease_response(grant)).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn renew_interruption_lease_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    AxumPath(lease_id): AxumPath<String>,
) -> Response {
    if http_backend_role(&state, &query.token) != Some(BackendRole::Admin) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match state.capture_interruption.renew_interruption(&lease_id) {
        Some(grant) => Json(interruption_lease_response(grant)).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn release_interruption_lease_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    AxumPath(lease_id): AxumPath<String>,
) -> Response {
    if http_backend_role(&state, &query.token) != Some(BackendRole::Admin) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if state.capture_interruption.release_interruption(&lease_id) {
        StatusCode::NO_CONTENT.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

async fn preview_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    if http_backend_role(&state, &query.token).is_none() {
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
    if http_backend_role(&state, &query.token).is_none() {
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
    let role = http_backend_role(&state, &query.token);
    if role.is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    if !query.debug {
        diagnostics::PREVIEW_POLL_COUNTS.record_production_png();
        return StatusCode::NOT_FOUND.into_response();
    }
    if role != Some(BackendRole::Admin) || !state.smoke_rpc_enabled {
        return StatusCode::FORBIDDEN.into_response();
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
    let role = http_backend_role(&state, &query.token);
    if role.is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    if !query.debug {
        diagnostics::PREVIEW_POLL_COUNTS.record_production_png();
        return StatusCode::NOT_FOUND.into_response();
    }
    if role != Some(BackendRole::Admin) || !state.smoke_rpc_enabled {
        return StatusCode::FORBIDDEN.into_response();
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

async fn live_camera_bmp_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
) -> Response {
    if http_backend_role(&state, &query.token).is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    diagnostics::PREVIEW_POLL_COUNTS.record_camera_bmp();
    let cursor = query.preview_bmp_cursor();
    match latest_preview_camera_bmp(&state, query.max_width, cursor).await {
        Some(poll) => latest_preview_bmp_response(poll),
        None => preview_bmp_not_found_response(),
    }
}

async fn live_screen_bmp_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
) -> Response {
    if http_backend_role(&state, &query.token).is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    diagnostics::PREVIEW_POLL_COUNTS.record_screen_bmp();
    let cursor = query.preview_bmp_cursor();
    match latest_preview_screen_bmp(&state, query.max_width, cursor).await {
        Some(poll) => latest_preview_bmp_response(poll),
        None => preview_bmp_not_found_response(),
    }
}

const PREVIEW_BMP_EXPOSED_HEADERS: &str = "x-videorc-frame-transport, x-videorc-frame-generation, x-videorc-frame-sequence, x-videorc-frame-width, x-videorc-frame-height, x-videorc-frame-stride, x-videorc-pixel-format";

fn latest_preview_bmp_response(poll: preview_bmp::LatestPreviewBmpPoll) -> Response {
    match poll {
        preview_bmp::LatestPreviewBmpPoll::Unchanged {
            generation,
            sequence,
        } => Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(header::CACHE_CONTROL, "no-store")
            .header("access-control-allow-origin", "*")
            .header("access-control-expose-headers", PREVIEW_BMP_EXPOSED_HEADERS)
            .header("x-videorc-frame-transport", "latest-bgra-bmp")
            .header("x-videorc-frame-generation", generation)
            .header("x-videorc-frame-sequence", sequence.to_string())
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        preview_bmp::LatestPreviewBmpPoll::Frame(frame) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/bmp")
            .header(header::CACHE_CONTROL, "no-store")
            .header("access-control-allow-origin", "*")
            .header("access-control-expose-headers", PREVIEW_BMP_EXPOSED_HEADERS)
            .header("x-videorc-frame-transport", "latest-bgra-bmp")
            .header("x-videorc-frame-generation", frame.generation)
            .header("x-videorc-frame-sequence", frame.sequence.to_string())
            .header("x-videorc-frame-width", frame.width.to_string())
            .header("x-videorc-frame-height", frame.height.to_string())
            .header("x-videorc-frame-stride", frame.stride.to_string())
            .header("x-videorc-pixel-format", frame.pixel_format)
            .body(Body::from(frame.bytes))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
    }
}

fn preview_bmp_not_found_response() -> Response {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CACHE_CONTROL, "no-store")
        .header("access-control-allow-origin", "*")
        .header("access-control-expose-headers", PREVIEW_BMP_EXPOSED_HEADERS)
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Serve a session's poster thumbnail (Library rewrite L2). Token-gated like
/// every other media route; 404 until the poster exists.
async fn session_poster_handler(
    State(state): State<AppState>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
    Query(query): Query<WsQuery>,
) -> Response {
    if http_backend_role(&state, &query.token).is_none() {
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
    if http_backend_role(&state, &query.token).is_none() {
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
    let (result, event_already_emitted) = if let Some(state_param) = query.state {
        (
            drive_loopback_oauth_callback(
                state.clone(),
                OAuthCompleteParams {
                    state: state_param,
                    code: query.code,
                    error: query.error,
                    error_description: query.error_description,
                },
            )
            .await,
            true,
        )
    } else {
        (
            complete_x_oauth1_callback(
                &state,
                query.oauth_token,
                query.oauth_verifier,
                query.denied,
            )
            .await,
            false,
        )
    };
    if !event_already_emitted {
        state.emit_event("platformAccounts.oauth.callback", result.clone());
    }

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

const LOOPBACK_OAUTH_RETRY_DELAYS: [Duration; 5] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];
const LOOPBACK_OAUTH_COOLDOWN_RETRY_DELAY: Duration = Duration::from_secs(20);

fn oauth_retry_delay(
    fast_retry_delays: &[Duration],
    cooldown_retry_delay: Duration,
    retries_scheduled: usize,
    now: tokio::time::Instant,
    retry_deadline: tokio::time::Instant,
) -> Option<Duration> {
    (now < retry_deadline).then(|| {
        fast_retry_delays
            .get(retries_scheduled)
            .copied()
            .unwrap_or(cooldown_retry_delay)
            .min(retry_deadline.saturating_duration_since(now))
    })
}

async fn run_bounded_oauth_retry_loop<A, AFut, R, RFut, E>(
    initial_params: OAuthCompleteParams,
    fast_retry_delays: &[Duration],
    cooldown_retry_delay: Duration,
    retry_deadline: tokio::time::Instant,
    mut attempt: A,
    mut can_resume_without_code: R,
    mut emit: E,
) -> oauth::OAuthCallbackResult
where
    A: FnMut(OAuthCompleteParams) -> AFut,
    AFut: std::future::Future<Output = oauth::OAuthCallbackResult>,
    R: FnMut() -> RFut,
    RFut: std::future::Future<Output = bool>,
    E: FnMut(&oauth::OAuthCallbackResult),
{
    let callback_state = initial_params.state.clone();
    let mut params = initial_params;
    let mut retries_scheduled = 0usize;
    let mut deadline_retry_attempted = false;
    loop {
        let result = attempt(params).await;
        emit(&result);
        if !result.retryable {
            return result;
        }
        // Retrying ProviderExchange would repost a single-use code. Only a
        // durably advanced checkpoint/account stage may continue code-less.
        if !can_resume_without_code().await {
            return result;
        }
        let now = tokio::time::Instant::now();
        if now >= retry_deadline {
            if deadline_retry_attempted {
                return result;
            }
            deadline_retry_attempted = true;
            params = OAuthCompleteParams {
                state: callback_state.clone(),
                code: None,
                error: None,
                error_description: None,
            };
            continue;
        }
        let Some(delay) = oauth_retry_delay(
            fast_retry_delays,
            cooldown_retry_delay,
            retries_scheduled,
            now,
            retry_deadline,
        ) else {
            return result;
        };
        retries_scheduled += 1;
        // Drop the authorization code before any await. Every retry is driven
        // exclusively by a durable code-less checkpoint.
        params = OAuthCompleteParams {
            state: callback_state.clone(),
            code: None,
            error: None,
            error_description: None,
        };
        tokio::time::sleep(delay).await;
    }
}

async fn drive_loopback_oauth_callback(
    state: AppState,
    params: OAuthCompleteParams,
) -> oauth::OAuthCallbackResult {
    let callback_state = params.state.clone();
    let attempt_state = state.clone();
    let resume_oauth = state.oauth.clone();
    let resume_state = callback_state.clone();
    let event_state = state.clone();
    let retry_window = state
        .oauth
        .pending_retry_window(&callback_state)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let retry_deadline = tokio::time::Instant::now() + retry_window;
    run_bounded_oauth_retry_loop(
        params,
        &LOOPBACK_OAUTH_RETRY_DELAYS,
        LOOPBACK_OAUTH_COOLDOWN_RETRY_DELAY,
        retry_deadline,
        move |params| {
            let state = attempt_state.clone();
            async move { complete_oauth_callback(&state, params).await }
        },
        move || {
            let oauth = resume_oauth.clone();
            let callback_state = resume_state.clone();
            async move {
                oauth
                    .can_resume_without_code(&callback_state)
                    .await
                    .unwrap_or(false)
            }
        },
        move |result| {
            event_state.emit_event("platformAccounts.oauth.callback", result.clone());
        },
    )
    .await
}

async fn resume_pending_oauth_completions(state: AppState) {
    const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(5);
    loop {
        let states = match state
            .oauth
            .maintain_pending(chrono::Utc::now(), secrets::delete_secret)
            .await
        {
            Ok(states) => states,
            Err(error) => {
                state.emit_log(
                    "error",
                    format!("Could not maintain durable OAuth recovery work: {error}"),
                );
                tokio::time::sleep(MAINTENANCE_INTERVAL).await;
                continue;
            }
        };
        for callback_state in states {
            let recovery_state = state.clone();
            tokio::spawn(async move {
                let result = drive_loopback_oauth_callback(
                    recovery_state.clone(),
                    OAuthCompleteParams {
                        state: callback_state.clone(),
                        code: None,
                        error: None,
                        error_description: None,
                    },
                )
                .await;
                recovery_state
                    .oauth
                    .release_recovery_driver(&callback_state)
                    .await;
                if result.retryable {
                    recovery_state.emit_log(
                        "warn",
                        "Durable OAuth recovery remains pending and will be retried by live maintenance.",
                    );
                }
            });
        }
        tokio::time::sleep(MAINTENANCE_INTERVAL).await;
    }
}

fn prepare_oauth_account_transition(
    mut account: crate::streaming::UpsertPlatformAccount,
    existing: Option<&crate::storage::PlatformAccountCredentials>,
) -> (crate::streaming::UpsertPlatformAccount, Vec<String>) {
    if let Some(existing) = existing
        && existing.account.account_id == account.account_id
        && account.refresh_token_secret_ref.is_none()
    {
        account.refresh_token_secret_ref = existing.refresh_token_secret_ref.clone();
    }
    let committed = [
        account.token_secret_ref.as_deref(),
        account.refresh_token_secret_ref.as_deref(),
    ];
    let mut superseded = existing
        .into_iter()
        .flat_map(|existing| {
            [
                existing.token_secret_ref.as_ref(),
                existing.refresh_token_secret_ref.as_ref(),
            ]
            .into_iter()
            .flatten()
        })
        .filter(|secret_ref| {
            !committed
                .iter()
                .flatten()
                .any(|committed| *committed == secret_ref.as_str())
        })
        .cloned()
        .collect::<Vec<_>>();
    superseded.sort();
    superseded.dedup();
    (account, superseded)
}

async fn complete_oauth_callback(
    state: &AppState,
    params: OAuthCompleteParams,
) -> oauth::OAuthCallbackResult {
    let outcome = state.oauth.complete_with_pending(params).await;
    let mut result = outcome.result;
    let callback_state = result.state.clone();
    if result.status != oauth::OAuthCallbackStatus::Success {
        // A concurrent delivery can observe the durable state while its owner
        // is still exchanging/storing credentials. It is explicitly retryable:
        // retiring it here would consume the single-use code out from under the
        // in-flight owner and make crash recovery impossible.
        if result.retryable {
            return result;
        }
        if result.status != oauth::OAuthCallbackStatus::UnknownState
            && let Err(error) = state
                .oauth
                .finish_with_secret_cleanup(&callback_state, secrets::delete_secret)
                .await
        {
            result.retryable = true;
            result.message = Some(format!(
                "OAuth callback could not be retired durably and will be retried: {error}"
            ));
        }
        return result;
    }

    let account_write = if let Some(account) = outcome.account_to_store {
        let commit =
            outcome
                .account_storage_commit
                .unwrap_or(oauth::PendingOAuthAccountStorageCommit {
                    expected_account_state: None,
                    write_generation: 0,
                });
        let guard = state
            .oauth
            .lock_platform_finalization(account.platform)
            .await;
        Some((account, commit, guard))
    } else {
        let provider_client = oauth::provider_http_client();
        let token_and_checkpoint = if let Some(checkpoint) = outcome.token_checkpoint {
            match secrets::try_get_secret(checkpoint.secret_ref()) {
                Ok(Some(payload)) => {
                    match oauth::recover_exchanged_token(&checkpoint, |_| Ok(Some(payload.clone())))
                    {
                        Ok(token) => Some((checkpoint, token)),
                        Err(error) => {
                            result.status = oauth::OAuthCallbackStatus::Failed;
                            result.message = Some(format!(
                                "Protected OAuth token checkpoint was invalid. Start the connection again: {error}"
                            ));
                            if let Err(cleanup_error) = state
                                .oauth
                                .finish_with_secret_cleanup(&callback_state, secrets::delete_secret)
                                .await
                            {
                                result.retryable = true;
                                result.message = Some(format!(
                                    "OAuth checkpoint cleanup failed and will be retried: {cleanup_error}"
                                ));
                            }
                            return result;
                        }
                    }
                }
                Ok(None) => {
                    result.status = oauth::OAuthCallbackStatus::Failed;
                    result.message = Some(
                        "OAuth code exchange was interrupted before its protected token checkpoint completed. Start the connection again."
                            .to_string(),
                    );
                    if let Err(error) = state
                        .oauth
                        .finish_with_secret_cleanup(&callback_state, secrets::delete_secret)
                        .await
                    {
                        result.retryable = true;
                        result.message = Some(format!(
                            "OAuth checkpoint cleanup failed and will be retried: {error}"
                        ));
                    }
                    return result;
                }
                Err(error) => {
                    result.status = oauth::OAuthCallbackStatus::Failed;
                    result.retryable = true;
                    result.message = Some(format!(
                        "Protected OAuth token checkpoint is temporarily unavailable: {error}"
                    ));
                    let _ = state.oauth.retry(&callback_state).await;
                    return result;
                }
            }
        } else if let (Some(exchange), Some(code)) = (outcome.exchange, outcome.authorization_code)
        {
            let code_verifier = match oauth::recover_pkce_verifier(
                &exchange,
                secrets::try_get_secret,
            ) {
                Ok(code_verifier) => code_verifier,
                Err(error) => {
                    result.status = oauth::OAuthCallbackStatus::Failed;
                    result.message = Some(format!(
                        "Protected OAuth PKCE recovery failed. Start the connection again: {error}"
                    ));
                    if let Err(cleanup_error) = state
                        .oauth
                        .finish_with_secret_cleanup(&callback_state, secrets::delete_secret)
                        .await
                    {
                        result.retryable = true;
                        result.message = Some(format!(
                            "OAuth PKCE cleanup failed and will be retried: {cleanup_error}"
                        ));
                    }
                    return result;
                }
            };
            let checkpoint = match state.oauth.stage_exchange_started(&callback_state).await {
                Ok(checkpoint) => checkpoint,
                Err(error) => {
                    result.status = oauth::OAuthCallbackStatus::Failed;
                    result.retryable = true;
                    result.message = Some(format!(
                        "OAuth token exchange could not be admitted durably: {error}"
                    ));
                    let _ = state.oauth.retry(&callback_state).await;
                    return result;
                }
            };
            let token = match oauth::exchange_authorization_code(
                &exchange,
                &code,
                code_verifier.as_deref(),
                &provider_client,
            )
            .await
            {
                Ok(token) => token,
                Err(error) => {
                    result.status = oauth::OAuthCallbackStatus::Failed;
                    result.message = Some(format!(
                        "OAuth token exchange did not complete. Start the connection again: {error}"
                    ));
                    if let Err(cleanup_error) = state
                        .oauth
                        .finish_with_secret_cleanup(&callback_state, secrets::delete_secret)
                        .await
                    {
                        result.retryable = true;
                        result.message = Some(format!(
                            "OAuth exchange cleanup failed and will be retried: {cleanup_error}"
                        ));
                    }
                    return result;
                }
            };
            if let Err(error) = state
                .oauth
                .stage_exchanged_token(&callback_state, token.clone(), secrets::put_secret)
                .await
            {
                result.status = oauth::OAuthCallbackStatus::Failed;
                result.retryable = true;
                result.message = Some(format!(
                    "OAuth token checkpoint could not be committed and will be recovered or retired: {error}"
                ));
                let _ = state.oauth.retry(&callback_state).await;
                return result;
            }
            Some((checkpoint, token))
        } else {
            None
        };

        match token_and_checkpoint {
            Some((checkpoint, token)) => match oauth::account_from_exchanged_token(
                &checkpoint,
                &token,
                &provider_client,
                secrets::put_secrets,
            )
            .await
            {
                Ok(account) => {
                    let guard = state
                        .oauth
                        .lock_platform_finalization(account.platform)
                        .await;
                    let existing = match state.database.list_platform_account_credentials() {
                        Ok(credentials) => credentials
                            .into_iter()
                            .find(|credential| credential.account.platform == account.platform),
                        Err(error) => {
                            result.status = oauth::OAuthCallbackStatus::Failed;
                            result.retryable = true;
                            result.message = Some(format!(
                                "OAuth account transition could not inspect existing credentials: {error}"
                            ));
                            let _ = state.oauth.retry(&callback_state).await;
                            return result;
                        }
                    };
                    let expected_account_state = match state
                        .database
                        .platform_account_write_expectation(account.platform)
                    {
                        Ok(expected) => expected,
                        Err(error) => {
                            result.status = oauth::OAuthCallbackStatus::Failed;
                            result.retryable = true;
                            result.message = Some(format!(
                                "OAuth account transition could not snapshot its write generation: {error}"
                            ));
                            let _ = state.oauth.retry(&callback_state).await;
                            return result;
                        }
                    };
                    let (account, superseded_secret_refs) =
                        prepare_oauth_account_transition(account, existing.as_ref());
                    let commit = match state
                        .oauth
                        .stage_account_storage_with_checkpoint(
                            &callback_state,
                            account.clone(),
                            Some(&checkpoint),
                            superseded_secret_refs,
                            expected_account_state,
                        )
                        .await
                    {
                        Ok(commit) => commit,
                        Err(error) => {
                            result.status = oauth::OAuthCallbackStatus::Failed;
                            result.retryable = true;
                            result.message = Some(format!(
                                "OAuth completion could not be staged durably: {error}"
                            ));
                            let _ = state.oauth.retry(&callback_state).await;
                            return result;
                        }
                    };
                    Some((account, commit, guard))
                }
                Err(error) => {
                    result.status = oauth::OAuthCallbackStatus::Failed;
                    result.retryable = true;
                    result.message = Some(format!(
                        "OAuth account preparation failed and will be retried from its protected token checkpoint: {error}"
                    ));
                    let _ = state.oauth.retry(&callback_state).await;
                    return result;
                }
            },
            None => None,
        }
    };

    let mut stale_account_state = None;
    let mut platform_finalization_guard = None;
    if let Some((account, commit, guard)) = account_write {
        platform_finalization_guard = Some(guard);
        match state.database.compare_and_upsert_platform_account(
            account,
            commit.expected_account_state.as_ref(),
            commit.write_generation,
            true,
            true,
            || Ok(()),
        ) {
            Ok(
                storage::PlatformAccountCasOutcome::Applied(_)
                | storage::PlatformAccountCasOutcome::AlreadyApplied(_),
            ) => {
                result.token_stored = true;
                result.account_connected = true;
                if let Ok(accounts) = state.database.list_platform_accounts() {
                    state.emit_event("platformAccounts.changed", accounts);
                }
            }
            Ok(storage::PlatformAccountCasOutcome::Stale(current)) => {
                result.token_stored = current.token_secret_ref.is_some();
                result.account_connected = current.exists;
                result.message = Some(
                    "A newer account connection already won; the older OAuth transaction was retired."
                        .to_string(),
                );
                stale_account_state = Some(current);
            }
            Err(error) => {
                result.status = oauth::OAuthCallbackStatus::Failed;
                result.retryable = true;
                result.message = Some(format!("OAuth account storage failed: {error}"));
                let _ = state.oauth.retry(&callback_state).await;
                return result;
            }
        }
    }

    let cleanup = if let Some(current) = stale_account_state.as_ref() {
        state
            .oauth
            .finish_superseded_account_storage_with_secret_cleanup(
                &callback_state,
                current,
                secrets::delete_secret,
            )
            .await
    } else {
        state
            .oauth
            .finish_with_secret_cleanup(&callback_state, secrets::delete_secret)
            .await
    };
    if let Err(error) = cleanup {
        result.status = oauth::OAuthCallbackStatus::Failed;
        result.retryable = true;
        result.message = Some(format!("OAuth completion acknowledgement failed: {error}"));
    }
    drop(platform_finalization_guard);
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
        retryable: false,
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

#[derive(Debug)]
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
    persist_refreshed_platform_access_token_with_secret_writer(
        state,
        credential,
        access_ref,
        refresh_ref,
        token,
        secrets::put_secrets,
    )
}

fn persist_refreshed_platform_access_token_with_secret_writer<F>(
    state: &AppState,
    credential: &storage::PlatformAccountCredentials,
    access_ref: &str,
    refresh_ref: &str,
    token: oauth::RefreshedOAuthToken,
    mut put_secrets: F,
) -> Result<FreshPlatformAccessToken>
where
    F: FnMut(&[(&str, &str)]) -> Result<()>,
{
    let mut account = credential.account.clone();
    account.scopes = token.scopes.clone();
    account.expires_at = token.expires_at.clone();
    account.status = PlatformAccountStatus::Connected;
    let expected = storage::PlatformAccountWriteExpectation::from_credentials(credential);
    let upsert = UpsertPlatformAccount {
        platform: account.platform,
        account_id: account.account_id.clone(),
        account_label: account.account_label.clone(),
        account_handle: account.account_handle.clone(),
        avatar_url: account.avatar_url.clone(),
        scopes: account.scopes.clone(),
        token_secret_ref: credential.token_secret_ref.clone(),
        refresh_token_secret_ref: credential.refresh_token_secret_ref.clone(),
        stream_key_secret_ref: credential.stream_key_secret_ref.clone(),
        expires_at: account.expires_at.clone(),
        status: account.status,
    };
    let outcome = state.database.compare_and_upsert_platform_account(
        upsert,
        Some(&expected),
        expected.generation.saturating_add(1),
        false,
        false,
        || {
            let mut entries = vec![(access_ref, token.access_token.as_str())];
            if let Some(next_refresh_token) = token.refresh_token.as_deref() {
                entries.push((refresh_ref, next_refresh_token));
            }
            put_secrets(&entries).context("Could not atomically store refreshed OAuth credentials")
        },
    )?;
    if !matches!(outcome, storage::PlatformAccountCasOutcome::Applied(_)) {
        anyhow::bail!("Platform account changed while its OAuth token was refreshing.");
    }
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
            changed |=
                upsert_validated_account(state, &credential, account.clone()).unwrap_or(false);
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
                changed |=
                    upsert_validated_account(state, &credential, account.clone()).unwrap_or(false);
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
                    changed |= upsert_validated_account(state, &credential, account.clone())
                        .unwrap_or(false);
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
                changed |=
                    upsert_validated_account(state, &credential, account.clone()).unwrap_or(false);
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
                    changed |= upsert_validated_account(state, &credential, account.clone())
                        .unwrap_or(false);
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
                changed |=
                    upsert_validated_account(state, &credential, account.clone()).unwrap_or(false);
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

fn oauth_streaming_for_start(
    params: &protocol::StartSessionParams,
) -> Option<&crate::streaming::StreamingSettings> {
    if !params.output.stream_enabled {
        return None;
    }
    params
        .streaming
        .as_ref()
        .filter(|streaming| streaming.enabled)
}

fn validate_start_session_oauth_availability(params: &protocol::StartSessionParams) -> Result<()> {
    let Some(streaming) = oauth_streaming_for_start(params) else {
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
    let credential = twitch_account_credentials(state, target.account_id.as_deref())
        .map_err(|error| anyhow::anyhow!("Connect Twitch to enable live comments: {error}"))?;
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
/// Live comments only exist for sessions with a live audience: chat providers
/// attach when the session actually STREAMS, never for local recordings. The
/// Older or alternate clients may still send saved streaming settings with a
/// recording request, so the mere presence of `streaming` is not a streaming
/// session. The output flag is authoritative (owner reports, 2026-07-13 and
/// 2026-07-14).
fn session_attaches_live_chat(params: &protocol::StartSessionParams) -> bool {
    params.output.stream_enabled && params.streaming.is_some()
}

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
        destinations: Vec::new(),
        fake: None,
        fakes: Vec::new(),
        youtube: None,
        twitch: None,
        x: None,
    };
    for target in &streaming.targets {
        if !enabled.contains(target.id.as_str()) {
            continue;
        }
        params
            .destinations
            .push(live_chat::LiveChatDestinationStart {
                target_id: target.id.clone(),
                platform: target.platform,
                read: None,
                write: None,
                preparation_error: None,
            });
        match target.platform {
            StreamPlatform::Youtube => {
                if target.auth_mode != crate::streaming::StreamAuthMode::Oauth {
                    if let Some(destination) = params.destinations.last_mut() {
                        destination.read = Some(live_chat::CommentsReadState::Unavailable);
                        destination.write = Some(live_chat::CommentsWriteState::Unavailable);
                        destination.preparation_error = Some(
                            "Connect YouTube and select the matching broadcast to attach Comments."
                                .to_string(),
                        );
                    }
                    continue;
                }
                if !params.platforms.contains(&StreamPlatform::Youtube) {
                    params.platforms.push(StreamPlatform::Youtube);
                }
                match youtube_chat_config(state, target).await {
                    Ok(config) => params.youtube = Some(config),
                    Err(error) => {
                        let message = format!("YouTube live chat unavailable: {error}");
                        if let Some(destination) = params.destinations.last_mut() {
                            destination.preparation_error = Some(message.clone());
                        }
                        state.emit_log("warn", message)
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
                    let message = format!("Twitch live chat unavailable: {error}");
                    if let Some(destination) = params.destinations.last_mut() {
                        destination.preparation_error = Some(message.clone());
                    }
                    state.emit_log("warn", message)
                }
            },
            StreamPlatform::X => {
                if target.auth_mode != crate::streaming::StreamAuthMode::Oauth {
                    if let Some(destination) = params.destinations.last_mut() {
                        destination.read = Some(live_chat::CommentsReadState::Unavailable);
                        destination.write = Some(live_chat::CommentsWriteState::ReadOnly);
                        destination.preparation_error = Some(
                            "Manual RTMP has no native X broadcast context, so X comments are unavailable for this destination."
                                .to_string(),
                        );
                    }
                    continue;
                }
                if !params.platforms.contains(&StreamPlatform::X) {
                    params.platforms.push(StreamPlatform::X);
                }
            }
            StreamPlatform::Custom => {}
        }
    }
    if !params.destinations.is_empty() {
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
) -> anyhow::Result<bool> {
    let expected = storage::PlatformAccountWriteExpectation::from_credentials(credential);
    let outcome = state.database.compare_and_upsert_platform_account(
        UpsertPlatformAccount {
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
        },
        Some(&expected),
        expected.generation.saturating_add(1),
        false,
        false,
        || Ok(()),
    )?;
    Ok(matches!(
        outcome,
        storage::PlatformAccountCasOutcome::Applied(_)
    ))
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

#[derive(Default)]
struct ConnectionEventFilter {
    excluded: std::collections::HashSet<String>,
    included: Option<std::collections::HashSet<String>>,
}

impl ConnectionEventFilter {
    fn allows(&self, event: &str) -> bool {
        !self.excluded.contains(event)
            && self
                .included
                .as_ref()
                .is_none_or(|included| included.contains(event))
    }
}

/// Handles connection-scoped control commands ("events.setExcluded" and
/// "events.setIncluded") that
/// mutate this socket's event filter instead of shared app state. Returns None
/// for everything else so the regular dispatcher runs.
fn handle_connection_control(
    event_filter: &std::sync::Arc<std::sync::Mutex<ConnectionEventFilter>>,
    text: &str,
) -> Option<ServerResponse> {
    let command: serde_json::Value = serde_json::from_str(text).ok()?;
    let method = command.get("method").and_then(|method| method.as_str())?;
    if !matches!(method, "events.setExcluded" | "events.setIncluded") {
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
    let response = {
        let mut guard = event_filter
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let target = if method == "events.setExcluded" {
            &mut guard.excluded
        } else {
            guard.included.get_or_insert_default()
        };
        *target = events;
        let mut list: Vec<String> = target.iter().cloned().collect();
        list.sort();
        if method == "events.setExcluded" {
            serde_json::json!({ "excluded": list })
        } else {
            serde_json::json!({ "included": list })
        }
    };
    Some(ServerResponse::ok(id, response))
}

const WEBSOCKET_RELIABLE_QUEUE_CAPACITY: usize = 128;
const WEBSOCKET_COMMAND_QUEUE_CAPACITY: usize = 64;
const WEBSOCKET_TELEMETRY_KIND_CAPACITY: usize = 32;
const WEBSOCKET_LAYOUT_CONCURRENCY: usize = 8;
const WEBSOCKET_READ_ONLY_CONCURRENCY: usize = 4;
// The renderer already sends live audio updates single-flight/latest-wins.
// Keep the transport path independently bounded so a malformed/raw client
// cannot build a task backlog, while session.stop remains dispatchable during
// FFmpeg's acknowledgement wait.
const WEBSOCKET_AUDIO_PROCESSING_CONCURRENCY: usize = 1;
const WEBSOCKET_RELIABLE_BURST_LIMIT: usize = 8;
// The desktop clients are loopback peers. Five seconds is deliberately far
// above normal socket jitter while still bounding the lifetime of queued
// responses when a reader or writer stalls.
const WEBSOCKET_RELIABLE_MAX_OLDEST_AGE: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct WebSocketSlowPressureSignal {
    sender: mpsc::Sender<()>,
    transport_metrics: std::sync::Arc<WebSocketTransportMetrics>,
    signaled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl WebSocketSlowPressureSignal {
    fn new(
        sender: mpsc::Sender<()>,
        transport_metrics: std::sync::Arc<WebSocketTransportMetrics>,
    ) -> Self {
        Self {
            sender,
            transport_metrics,
            signaled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    fn signal(&self) -> bool {
        if self
            .signaled
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_err()
        {
            return false;
        }
        self.transport_metrics.record_slow_pressure_disconnect();
        let _ = self.sender.try_send(());
        true
    }
}

async fn queue_websocket_response(
    outgoing: &mpsc::Sender<Message>,
    reliable_metrics: &TrackedWebSocketQueueMetrics,
    slow_pressure: &WebSocketSlowPressureSignal,
    response: ServerResponse,
) -> bool {
    match serde_json::to_string(&response) {
        Ok(text) => {
            send_tracked_reliable_websocket_item(
                outgoing,
                reliable_metrics,
                Message::Text(text.into()),
                slow_pressure,
            )
            .await
        }
        Err(error) => {
            tracing::error!("Could not serialize response: {error}");
            reliable_metrics.record_rejected_or_dropped();
            false
        }
    }
}

async fn send_tracked_websocket_item<T>(
    sender: &mpsc::Sender<T>,
    metrics: &TrackedWebSocketQueueMetrics,
    value: T,
) -> bool {
    let Ok(permit) = sender.reserve().await else {
        metrics.record_rejected_or_dropped();
        return false;
    };
    metrics.record_enqueue();
    permit.send(value);
    true
}

async fn send_tracked_reliable_websocket_item<T>(
    sender: &mpsc::Sender<T>,
    metrics: &TrackedWebSocketQueueMetrics,
    value: T,
    slow_pressure: &WebSocketSlowPressureSignal,
) -> bool {
    send_tracked_reliable_websocket_item_with_limit(
        sender,
        metrics,
        value,
        slow_pressure,
        WEBSOCKET_RELIABLE_MAX_OLDEST_AGE,
    )
    .await
}

async fn send_tracked_reliable_websocket_item_with_limit<T>(
    sender: &mpsc::Sender<T>,
    metrics: &TrackedWebSocketQueueMetrics,
    value: T,
    slow_pressure: &WebSocketSlowPressureSignal,
    oldest_age_limit: Duration,
) -> bool {
    let permit = loop {
        let reserve_wait = metrics
            .remaining_until_oldest_age(oldest_age_limit)
            .unwrap_or(oldest_age_limit);
        match timeout(reserve_wait, sender.reserve()).await {
            Ok(Ok(permit)) => break permit,
            Ok(Err(_)) => {
                metrics.record_rejected_or_dropped();
                return false;
            }
            Err(_)
                if !metrics
                    .remaining_until_oldest_age(oldest_age_limit)
                    .is_some_and(|remaining| remaining.is_zero()) =>
            {
                // Another producer may have won newly available capacity after
                // the former oldest item left. Recompute from the current
                // oldest item rather than treating a stale deadline as pressure.
                continue;
            }
            Err(_) => {
                metrics.record_rejected_or_dropped();
                if slow_pressure.signal() {
                    tracing::warn!(
                        oldest_age_limit_ms = oldest_age_limit.as_millis(),
                        "Closing slow WebSocket peer after reliable queue pressure exceeded its age limit."
                    );
                }
                return false;
            }
        }
    };

    // Capacity may open just as the oldest queued response reaches its age
    // limit. Do not reset sustained pressure by accepting one more response.
    if metrics
        .remaining_until_oldest_age(oldest_age_limit)
        .is_some_and(|remaining| remaining.is_zero())
    {
        drop(permit);
        metrics.record_rejected_or_dropped();
        if slow_pressure.signal() {
            tracing::warn!(
                oldest_age_limit_ms = oldest_age_limit.as_millis(),
                "Closing slow WebSocket peer after reliable queue pressure exceeded its age limit."
            );
        }
        return false;
    }

    metrics.record_enqueue();
    permit.send(value);
    true
}

async fn run_websocket_reliable_pressure_watchdog(
    metrics: TrackedWebSocketQueueMetrics,
    slow_pressure: WebSocketSlowPressureSignal,
) {
    run_websocket_reliable_pressure_watchdog_with_limit(
        metrics,
        slow_pressure,
        WEBSOCKET_RELIABLE_MAX_OLDEST_AGE,
    )
    .await;
}

async fn run_websocket_reliable_pressure_watchdog_with_limit(
    metrics: TrackedWebSocketQueueMetrics,
    slow_pressure: WebSocketSlowPressureSignal,
    oldest_age_limit: Duration,
) {
    metrics
        .wait_until_oldest_age_reaches(oldest_age_limit)
        .await;
    if slow_pressure.signal() {
        tracing::warn!(
            oldest_age_limit_ms = oldest_age_limit.as_millis(),
            "Closing slow WebSocket peer because its oldest reliable message exceeded the age limit."
        );
    }
}

#[derive(Debug)]
struct TrackedCoalescedEvent {
    event: ServerEvent,
    ticket: WebSocketQueueTicket,
}

#[derive(Debug, Default)]
struct CoalescingEventBufferState {
    order: std::collections::VecDeque<String>,
    latest: std::collections::HashMap<String, TrackedCoalescedEvent>,
    coalesced: u64,
    evicted: u64,
}

#[derive(Debug, Clone)]
struct CoalescingEventBuffer {
    capacity: usize,
    state: std::sync::Arc<std::sync::Mutex<CoalescingEventBufferState>>,
    ready: std::sync::Arc<tokio::sync::Notify>,
    metrics: TrackedWebSocketQueueMetrics,
}

impl CoalescingEventBuffer {
    #[cfg(test)]
    fn new(capacity: usize) -> Self {
        let transport = WebSocketTransportMetrics::default();
        let connection = transport.register_connection();
        Self::with_metrics(capacity, connection.coalesced_telemetry_queue)
    }

    fn with_metrics(capacity: usize, metrics: TrackedWebSocketQueueMetrics) -> Self {
        Self {
            capacity: capacity.max(1),
            state: std::sync::Arc::new(
                std::sync::Mutex::new(CoalescingEventBufferState::default()),
            ),
            ready: std::sync::Arc::new(tokio::sync::Notify::new()),
            metrics,
        }
    }

    fn push(&self, event: ServerEvent) {
        let key = event.event.clone();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(current) = state.latest.get_mut(&key) {
            let ticket = self.metrics.record_coalesced_replacement(current.ticket);
            *current = TrackedCoalescedEvent { event, ticket };
            state.coalesced = state.coalesced.saturating_add(1);
        } else {
            if state.latest.len() >= self.capacity
                && let Some(oldest) = state.order.pop_front()
            {
                if let Some(evicted) = state.latest.remove(&oldest) {
                    self.metrics.record_evicted_or_dropped(evicted.ticket);
                }
                state.evicted = state.evicted.saturating_add(1);
            }
            let ticket = self.metrics.record_enqueue();
            state.order.push_back(key.clone());
            state
                .latest
                .insert(key, TrackedCoalescedEvent { event, ticket });
        }
        drop(state);
        self.ready.notify_one();
    }

    async fn recv(&self) -> ServerEvent {
        loop {
            let notified = self.ready.notified();
            if let Some(event) = self.pop() {
                return event;
            }
            notified.await;
        }
    }

    fn pop(&self) -> Option<ServerEvent> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let key = state.order.pop_front()?;
        let tracked = state.latest.remove(&key)?;
        self.metrics.record_dequeue(tracked.ticket);
        Some(tracked.event)
    }

    fn stats(&self) -> (usize, u64, u64) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (state.latest.len(), state.coalesced, state.evicted)
    }
}

fn websocket_event_is_coalescible(event: &str) -> bool {
    matches!(
        event,
        "preview.frameReady"
            | "compositor.status"
            | "diagnostics.stats"
            | "preview.surface.status"
            | "preview.camera.status"
            | "preview.screen.status"
            | "preview.live.status"
            | "stream.health"
            | "stream.viewers"
    )
}

enum WebSocketWriterInput {
    Reliable(Message),
    Telemetry(ServerEvent),
}

#[derive(Debug)]
struct WebSocketWriterSchedule {
    reliable_open: bool,
    reliable_burst: usize,
}

impl Default for WebSocketWriterSchedule {
    fn default() -> Self {
        Self {
            reliable_open: true,
            reliable_burst: 0,
        }
    }
}

impl WebSocketWriterSchedule {
    fn record_reliable(&mut self) {
        self.reliable_burst = self
            .reliable_burst
            .saturating_add(1)
            .min(WEBSOCKET_RELIABLE_BURST_LIMIT);
    }

    fn record_telemetry(&mut self) {
        self.reliable_burst = 0;
    }

    fn try_next(
        &mut self,
        reliable: &mut mpsc::Receiver<Message>,
        reliable_metrics: &TrackedWebSocketQueueMetrics,
        telemetry: &CoalescingEventBuffer,
    ) -> Option<WebSocketWriterInput> {
        let telemetry_due =
            !self.reliable_open || self.reliable_burst >= WEBSOCKET_RELIABLE_BURST_LIMIT;
        if telemetry_due && let Some(event) = telemetry.pop() {
            self.record_telemetry();
            return Some(WebSocketWriterInput::Telemetry(event));
        }

        if self.reliable_open {
            match try_receive_tracked_websocket_item(reliable, reliable_metrics) {
                Ok(message) => {
                    self.record_reliable();
                    return Some(WebSocketWriterInput::Reliable(message));
                }
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    self.reliable_open = false;
                }
                Err(mpsc::error::TryRecvError::Empty) => {}
            }
        }

        telemetry.pop().map(|event| {
            self.record_telemetry();
            WebSocketWriterInput::Telemetry(event)
        })
    }

    async fn next(
        &mut self,
        reliable: &mut mpsc::Receiver<Message>,
        reliable_metrics: &TrackedWebSocketQueueMetrics,
        telemetry: &CoalescingEventBuffer,
    ) -> WebSocketWriterInput {
        loop {
            if let Some(input) = self.try_next(reliable, reliable_metrics, telemetry) {
                return input;
            }

            if !self.reliable_open {
                let event = telemetry.recv().await;
                self.record_telemetry();
                return WebSocketWriterInput::Telemetry(event);
            }

            let telemetry_due = self.reliable_burst >= WEBSOCKET_RELIABLE_BURST_LIMIT;
            let input = if telemetry_due {
                tokio::select! {
                    biased;
                    event = telemetry.recv() => WebSocketWriterInput::Telemetry(event),
                    message = receive_tracked_websocket_item(reliable, reliable_metrics) => match message {
                        Some(message) => WebSocketWriterInput::Reliable(message),
                        None => {
                            self.reliable_open = false;
                            continue;
                        }
                    },
                }
            } else {
                tokio::select! {
                    biased;
                    message = receive_tracked_websocket_item(reliable, reliable_metrics) => match message {
                        Some(message) => WebSocketWriterInput::Reliable(message),
                        None => {
                            self.reliable_open = false;
                            continue;
                        }
                    },
                    event = telemetry.recv() => WebSocketWriterInput::Telemetry(event),
                }
            };

            match input {
                WebSocketWriterInput::Reliable(_) => self.record_reliable(),
                WebSocketWriterInput::Telemetry(_) => self.record_telemetry(),
            }
            return input;
        }
    }
}

fn try_receive_tracked_websocket_item<T>(
    receiver: &mut mpsc::Receiver<T>,
    metrics: &TrackedWebSocketQueueMetrics,
) -> Result<T, mpsc::error::TryRecvError> {
    let value = receiver.try_recv()?;
    metrics.record_dequeue_oldest();
    Ok(value)
}

async fn receive_tracked_websocket_item<T>(
    receiver: &mut mpsc::Receiver<T>,
    metrics: &TrackedWebSocketQueueMetrics,
) -> Option<T> {
    let value = receiver.recv().await?;
    metrics.record_dequeue_oldest();
    Some(value)
}

async fn next_websocket_writer_message(
    schedule: &mut WebSocketWriterSchedule,
    reliable: &mut mpsc::Receiver<Message>,
    reliable_metrics: &TrackedWebSocketQueueMetrics,
    telemetry: &CoalescingEventBuffer,
) -> Message {
    loop {
        match schedule.next(reliable, reliable_metrics, telemetry).await {
            WebSocketWriterInput::Reliable(message) => return message,
            WebSocketWriterInput::Telemetry(event) => match serde_json::to_string(&event) {
                Ok(text) => return Message::Text(text.into()),
                Err(error) => tracing::error!("Could not serialize event: {error}"),
            },
        }
    }
}

async fn run_websocket_writer(
    mut sender: futures_util::stream::SplitSink<WebSocket, Message>,
    mut reliable: mpsc::Receiver<Message>,
    reliable_metrics: TrackedWebSocketQueueMetrics,
    telemetry: CoalescingEventBuffer,
) {
    let mut schedule = WebSocketWriterSchedule::default();
    loop {
        let message = next_websocket_writer_message(
            &mut schedule,
            &mut reliable,
            &reliable_metrics,
            &telemetry,
        )
        .await;
        if sender.send(message).await.is_err() {
            break;
        }
    }
}

type WebSocketCommandFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = ServerResponse> + Send>>;
type WebSocketCommandHandler =
    std::sync::Arc<dyn Fn(AppState, String) -> WebSocketCommandFuture + Send + Sync>;

fn production_websocket_command_handler(role: BackendRole) -> WebSocketCommandHandler {
    std::sync::Arc::new(move |state, text| {
        Box::pin(async move { handle_text_message_with_role(&state, text.as_str(), role).await })
    })
}

/// Pure state reads that must never queue behind a multi-second stateful
/// command (`session.start`/`session.stop` awaits the MP4 export inline). The
/// serial dispatcher starved `preview.surface.status` behind exactly that,
/// and the renderer's 5s budget turned every recording stop into "Backend
/// request timed out" toasts (2026-07-16 owner incident). Each method here is
/// verified read-only: it locks, clones, and answers.
fn websocket_command_is_read_only(text: &str) -> bool {
    serde_json::from_str::<ClientCommand>(text).is_ok_and(|command| {
        matches!(
            command.method.as_str(),
            "preview.surface.status" | "compositor.status" | "diagnostics.stats" | "health.ping"
        )
    })
}

fn websocket_command_may_overlap(text: &str) -> bool {
    serde_json::from_str::<ClientCommand>(text).is_ok_and(|command| {
        matches!(
            command.method.as_str(),
            "scene.layout.apply_live" | "scene.layout.apply_preview"
        ) && command
            .params
            .get("intentId")
            .and_then(serde_json::Value::as_u64)
            .is_some()
    })
}

fn websocket_audio_processing_command_id(text: &str) -> Option<String> {
    serde_json::from_str::<ClientCommand>(text)
        .ok()
        .filter(|command| command.method == "audio.processing.update")
        .map(|command| command.id)
}

fn websocket_command_is_session_stop(text: &str) -> bool {
    serde_json::from_str::<ClientCommand>(text)
        .is_ok_and(|command| command.method == "session.stop")
}

async fn drain_websocket_layout_commands(tasks: &mut tokio::task::JoinSet<()>) {
    while let Some(completed) = tasks.join_next().await {
        if let Err(error) = completed {
            tracing::warn!("WebSocket layout command task failed: {error}");
        }
    }
}

async fn drain_websocket_audio_processing_commands(tasks: &mut tokio::task::JoinSet<()>) {
    while let Some(completed) = tasks.join_next().await {
        if let Err(error) = completed {
            tracing::warn!("WebSocket audio processing command task failed: {error}");
        }
    }
}

fn reap_websocket_audio_processing_commands(tasks: &mut tokio::task::JoinSet<()>) {
    while let Some(completed) = tasks.try_join_next() {
        if let Err(error) = completed {
            tracing::warn!("WebSocket audio processing command task failed: {error}");
        }
    }
}

async fn run_websocket_command_dispatcher(
    state: AppState,
    mut commands: mpsc::Receiver<String>,
    command_metrics: TrackedWebSocketQueueMetrics,
    outgoing: mpsc::Sender<Message>,
    reliable_metrics: TrackedWebSocketQueueMetrics,
    slow_pressure: WebSocketSlowPressureSignal,
    command_handler: WebSocketCommandHandler,
) {
    let mut layout_tasks = tokio::task::JoinSet::new();
    let mut audio_processing_tasks = tokio::task::JoinSet::new();
    let mut read_only_tasks = tokio::task::JoinSet::new();
    // At most ONE stateful mutation runs at a time; it is a barrier for every
    // later non-read command but runs as a task so read-only queries keep
    // answering while it is in flight (a session.stop awaits the MP4 export
    // inline — serial dispatch starved preview.surface.status for its whole
    // duration, the 2026-07-16 owner incident).
    let mut stateful_task: Option<tokio::task::JoinHandle<bool>> = None;

    while let Some(text) = commands.recv().await {
        command_metrics.record_dequeue_oldest();
        reap_websocket_audio_processing_commands(&mut audio_processing_tasks);
        while read_only_tasks.try_join_next().is_some() {}
        // Read-only queries answer concurrently with ANY in-flight command —
        // they are never an ordering barrier and no barrier waits for them.
        if websocket_command_is_read_only(text.as_str()) {
            if read_only_tasks.len() >= WEBSOCKET_READ_ONLY_CONCURRENCY
                && let Some(completed) = read_only_tasks.join_next().await
                && let Err(error) = completed
            {
                tracing::warn!("WebSocket read-only command task failed: {error}");
            }
            let command_state = state.clone();
            let response_tx = outgoing.clone();
            let response_metrics = reliable_metrics.clone();
            let response_pressure = slow_pressure.clone();
            let handler = command_handler.clone();
            read_only_tasks.spawn(async move {
                let response = handler(command_state, text).await;
                let _ = queue_websocket_response(
                    &response_tx,
                    &response_metrics,
                    &response_pressure,
                    response,
                )
                .await;
            });
            continue;
        }
        if websocket_command_may_overlap(text.as_str()) {
            await_websocket_stateful_barrier(&mut stateful_task).await;
            if layout_tasks.len() >= WEBSOCKET_LAYOUT_CONCURRENCY
                && let Some(completed) = layout_tasks.join_next().await
                && let Err(error) = completed
            {
                tracing::warn!("WebSocket layout command task failed: {error}");
            }
            let command_state = state.clone();
            let response_tx = outgoing.clone();
            let response_metrics = reliable_metrics.clone();
            let response_pressure = slow_pressure.clone();
            let handler = command_handler.clone();
            layout_tasks.spawn(async move {
                let response = handler(command_state, text).await;
                let _ = queue_websocket_response(
                    &response_tx,
                    &response_metrics,
                    &response_pressure,
                    response,
                )
                .await;
            });
            continue;
        }

        if let Some(command_id) = websocket_audio_processing_command_id(text.as_str()) {
            await_websocket_stateful_barrier(&mut stateful_task).await;
            // Audio gain/mute is independent from scene layout. Do not hold the
            // dispatcher during FFmpeg's acknowledgement cadence; a following
            // session.stop must be able to publish its stopping marker.
            if audio_processing_tasks.len() >= WEBSOCKET_AUDIO_PROCESSING_CONCURRENCY {
                let response = ServerResponse::error(
                    command_id,
                    "audio-processing-busy",
                    "A live microphone update is already awaiting acknowledgement.",
                );
                if !queue_websocket_response(&outgoing, &reliable_metrics, &slow_pressure, response)
                    .await
                {
                    break;
                }
                continue;
            }

            let command_state = state.clone();
            let response_tx = outgoing.clone();
            let response_metrics = reliable_metrics.clone();
            let response_pressure = slow_pressure.clone();
            let handler = command_handler.clone();
            audio_processing_tasks.spawn(async move {
                let response = handler(command_state, text).await;
                let _ = queue_websocket_response(
                    &response_tx,
                    &response_metrics,
                    &response_pressure,
                    response,
                )
                .await;
            });
            continue;
        }

        // A stateful non-layout command is an ordering barrier. All layouts
        // accepted before it finish first, and later commands remain queued
        // until this mutation completes. session.stop is the deliberate narrow
        // exception for an in-flight live audio acknowledgement: the backend's
        // session mutex and stop marker preserve native ordering.
        await_websocket_stateful_barrier(&mut stateful_task).await;
        drain_websocket_layout_commands(&mut layout_tasks).await;
        if !websocket_command_is_session_stop(text.as_str()) {
            drain_websocket_audio_processing_commands(&mut audio_processing_tasks).await;
        }
        let command_state = state.clone();
        let response_tx = outgoing.clone();
        let response_metrics = reliable_metrics.clone();
        let response_pressure = slow_pressure.clone();
        let handler = command_handler.clone();
        stateful_task = Some(tokio::spawn(async move {
            let response = handler(command_state, text).await;
            queue_websocket_response(
                &response_tx,
                &response_metrics,
                &response_pressure,
                response,
            )
            .await
        }));
    }

    await_websocket_stateful_barrier(&mut stateful_task).await;
    drain_websocket_layout_commands(&mut layout_tasks).await;
    drain_websocket_audio_processing_commands(&mut audio_processing_tasks).await;
    while read_only_tasks.join_next().await.is_some() {}
}

/// Wait for the in-flight stateful mutation (if any) before dispatching the
/// next non-read-only command — mutation ordering is exactly the old serial
/// dispatcher's; only read-only queries bypass the barrier.
async fn await_websocket_stateful_barrier(
    stateful_task: &mut Option<tokio::task::JoinHandle<bool>>,
) {
    if let Some(task) = stateful_task.take()
        && let Err(error) = task.await
    {
        tracing::warn!("WebSocket stateful command task failed: {error}");
    }
}

async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let Some(role) = authenticate_backend_token(&query.token, &state.token, &state.admin_token)
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    ws.on_upgrade(move |socket| websocket_session(socket, state, role))
        .into_response()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EventsLaggedPayload {
    skipped: u64,
    occurred_at: String,
}

async fn relay_websocket_events(
    mut events: broadcast::Receiver<ServerEvent>,
    reliable_tx: mpsc::Sender<Message>,
    reliable_metrics: TrackedWebSocketQueueMetrics,
    slow_pressure: WebSocketSlowPressureSignal,
    telemetry: CoalescingEventBuffer,
    event_filter: std::sync::Arc<std::sync::Mutex<ConnectionEventFilter>>,
    redact_renderer_paths: bool,
) {
    loop {
        let (mut event, is_recovery) = match events.recv().await {
            Ok(event) => (event, false),
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                // Backpressure is deliberate: a slow socket can retain at most the
                // connection-local queue plus the shared broadcast ring. Once the ring
                // drops events, preserve the existing recovery contract so the renderer
                // replaces incremental live-chat state via `liveChat.status`.
                (
                    ServerEvent::new(
                        "events.lagged",
                        EventsLaggedPayload {
                            skipped,
                            occurred_at: chrono::Utc::now().to_rfc3339(),
                        },
                    ),
                    true,
                )
            }
            Err(broadcast::error::RecvError::Closed) => break,
        };
        if redact_renderer_paths {
            resource_authority::redact_managed_background_paths(&mut event.payload);
            resource_authority::redact_managed_screen_paths(&mut event.payload);
        }

        // A recovery frame is mandatory connection control, not an ordinary event a
        // renderer can exclude. Keep the pre-bounded-queue protocol behavior intact.
        let allowed = is_recovery
            || event_filter
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .allows(&event.event);
        if !allowed {
            continue;
        }
        if !is_recovery && websocket_event_is_coalescible(&event.event) {
            telemetry.push(event);
            continue;
        }

        match serde_json::to_string(&event) {
            Ok(text) => {
                if !send_tracked_reliable_websocket_item(
                    &reliable_tx,
                    &reliable_metrics,
                    Message::Text(text.into()),
                    &slow_pressure,
                )
                .await
                {
                    break;
                }
            }
            Err(error) => tracing::error!("Could not serialize event: {error}"),
        }
    }
}

async fn websocket_session(socket: WebSocket, state: AppState, role: BackendRole) {
    websocket_session_with_handler_and_redaction(
        socket,
        state,
        production_websocket_command_handler(role),
        role == BackendRole::Renderer,
    )
    .await;
}

#[cfg(test)]
async fn websocket_session_with_handler(
    socket: WebSocket,
    state: AppState,
    command_handler: WebSocketCommandHandler,
) {
    websocket_session_with_handler_and_redaction(socket, state, command_handler, false).await;
}

async fn websocket_session_with_handler_and_redaction(
    socket: WebSocket,
    state: AppState,
    command_handler: WebSocketCommandHandler,
    redact_renderer_paths: bool,
) {
    let (sender, mut receiver) = socket.split();
    let events = state.events.subscribe();
    let connection_metrics = state.websocket_transport_metrics.register_connection();
    let reliable_metrics = connection_metrics.reliable_response_queue.clone();
    let command_metrics = connection_metrics.incoming_command_queue.clone();
    let (outgoing_tx, outgoing_rx) = mpsc::channel::<Message>(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
    let event_tx = outgoing_tx.clone();
    let telemetry = CoalescingEventBuffer::with_metrics(
        WEBSOCKET_TELEMETRY_KIND_CAPACITY,
        connection_metrics.coalesced_telemetry_queue.clone(),
    );
    let telemetry_tx = telemetry.clone();
    let telemetry_observer = telemetry.clone();
    let (pressure_tx, mut pressure_rx) = mpsc::channel::<()>(1);
    let slow_pressure =
        WebSocketSlowPressureSignal::new(pressure_tx, state.websocket_transport_metrics.clone());
    // Per-connection event exclusions: the renderer mutes the compact 60Hz
    // frame-ready lane while the main process drives presents, and unmutes
    // instantly when it must take over as the fallback pump. Full compositor
    // diagnostics remain visible at their low bounded cadence.
    let event_filter = std::sync::Arc::new(std::sync::Mutex::new(ConnectionEventFilter::default()));
    let event_filter_for_events = event_filter.clone();

    let writer_task = tokio::spawn(run_websocket_writer(
        sender,
        outgoing_rx,
        reliable_metrics.clone(),
        telemetry,
    ));
    let pressure_watchdog_task = tokio::spawn(run_websocket_reliable_pressure_watchdog(
        reliable_metrics.clone(),
        slow_pressure.clone(),
    ));

    let ready_event = ServerEvent::new(
        "backend.ready",
        backend_connection(state.port, state.token.clone()),
    );
    if let Ok(text) = serde_json::to_string(&ready_event)
        && !send_tracked_reliable_websocket_item(
            &outgoing_tx,
            &reliable_metrics,
            Message::Text(text.into()),
            &slow_pressure,
        )
        .await
    {
        pressure_watchdog_task.abort();
        let _ = pressure_watchdog_task.await;
        writer_task.abort();
        let _ = writer_task.await;
        return;
    }

    let event_task = tokio::spawn(relay_websocket_events(
        events,
        event_tx,
        reliable_metrics.clone(),
        slow_pressure.clone(),
        telemetry_tx,
        event_filter_for_events,
        redact_renderer_paths,
    ));

    let (command_tx, command_rx) = mpsc::channel::<String>(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
    let command_dispatcher_task = tokio::spawn(run_websocket_command_dispatcher(
        state.clone(),
        command_rx,
        command_metrics.clone(),
        outgoing_tx.clone(),
        reliable_metrics.clone(),
        slow_pressure.clone(),
        command_handler,
    ));

    loop {
        let incoming = tokio::select! {
            incoming = receiver.next() => incoming,
            _ = pressure_rx.recv() => {
                break;
            }
        };
        let Some(incoming) = incoming else {
            break;
        };

        match incoming {
            Ok(Message::Text(text)) => {
                // Connection-local control messages never reach the shared
                // dispatcher (the exclusion set is per socket).
                if let Some(response) = handle_connection_control(&event_filter, text.as_str()) {
                    if !queue_websocket_response(
                        &outgoing_tx,
                        &reliable_metrics,
                        &slow_pressure,
                        response,
                    )
                    .await
                    {
                        break;
                    }
                    continue;
                }

                if !send_tracked_websocket_item(&command_tx, &command_metrics, text.to_string())
                    .await
                {
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(payload)) => {
                if !send_tracked_reliable_websocket_item(
                    &outgoing_tx,
                    &reliable_metrics,
                    Message::Pong(payload),
                    &slow_pressure,
                )
                .await
                {
                    break;
                }
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!("WebSocket receive error: {error}");
                break;
            }
        }
    }

    // Every command read from the socket is accepted work. Closing this
    // connection stops new intake, but the detached dispatcher drains the
    // accepted queue so native/source mutations are never canceled halfway.
    drop(command_tx);
    drop(command_dispatcher_task);
    event_task.abort();
    let _ = event_task.await;
    pressure_watchdog_task.abort();
    let _ = pressure_watchdog_task.await;
    drop(outgoing_tx);
    writer_task.abort();
    let _ = writer_task.await;
    let (telemetry_depth, telemetry_coalesced, telemetry_evicted) = telemetry_observer.stats();
    tracing::debug!(
        telemetry_depth,
        telemetry_coalesced,
        telemetry_evicted,
        "WebSocket telemetry queue closed."
    );
}

#[cfg(test)]
async fn handle_text_message(state: &AppState, text: &str) -> ServerResponse {
    handle_text_message_with_role(state, text, BackendRole::Admin).await
}

fn consume_resource_field(
    state: &AppState,
    object: &mut serde_json::Map<String, serde_json::Value>,
    role: BackendRole,
    capability_field: &str,
    path_field: &str,
    kind: resource_authority::ResourceCapabilityKind,
    required: bool,
) -> Result<()> {
    let raw_path_present = object
        .get(path_field)
        .and_then(serde_json::Value::as_str)
        .is_some_and(|path| !path.trim().is_empty());
    let capability_id = object
        .remove(capability_field)
        .and_then(|value| value.as_str().map(str::to_string));

    if role == BackendRole::Admin && capability_id.is_none() {
        return Ok(());
    }
    let Some(capability_id) = capability_id else {
        object.remove(path_field);
        if required || raw_path_present {
            anyhow::bail!("{capability_field} is required; raw {path_field} is not accepted.");
        }
        return Ok(());
    };
    let path = state.resource_authority.consume(&capability_id, kind)?;
    object.insert(
        path_field.to_string(),
        serde_json::Value::String(path.display().to_string()),
    );
    Ok(())
}

fn resolve_start_session_resources(
    state: &AppState,
    params: &mut serde_json::Value,
    role: BackendRole,
) -> Result<()> {
    let output = params
        .get_mut("output")
        .and_then(serde_json::Value::as_object_mut)
        .context("output is required")?;
    consume_resource_field(
        state,
        output,
        role,
        "outputDirectoryCapability",
        "outputDirectory",
        resource_authority::ResourceCapabilityKind::OutputDirectory,
        false,
    )
}

fn resolve_import_resources(
    state: &AppState,
    params: &mut serde_json::Value,
    role: BackendRole,
) -> Result<()> {
    let object = params.as_object_mut().context("params must be an object")?;
    consume_resource_field(
        state,
        object,
        role,
        "sourceCapability",
        "sourcePath",
        resource_authority::ResourceCapabilityKind::InputFile,
        true,
    )?;
    consume_resource_field(
        state,
        object,
        role,
        "outputDirectoryCapability",
        "outputDirectory",
        resource_authority::ResourceCapabilityKind::OutputDirectory,
        false,
    )
}

fn resolve_screen_import_resource(
    state: &AppState,
    params: &mut serde_json::Value,
    role: BackendRole,
) -> Result<()> {
    let object = params.as_object_mut().context("params must be an object")?;
    consume_resource_field(
        state,
        object,
        role,
        "sourceCapability",
        "path",
        resource_authority::ResourceCapabilityKind::InputFile,
        true,
    )
}

fn session_deletion_handle(
    operation: &storage::PendingSessionDeletion,
) -> protocol::SessionDeletionHandle {
    protocol::SessionDeletionHandle {
        operation_id: operation.operation_id.clone(),
        session_id: operation.session_id.clone(),
        path_count: operation.paths.len(),
        blocked_path_count: operation.blocked_paths.len(),
    }
}

fn session_recording_path(state: &AppState, session_id: &str) -> Result<String> {
    if session_id.is_empty() {
        anyhow::bail!("sessionId is required.");
    }
    state
        .database
        .session_file_facts(session_id)?
        .map(|(path, _)| path)
        .filter(|path| !path.trim().is_empty())
        .with_context(|| format!("Session {session_id} has no managed recording file."))
}

fn resolve_repair_file_params(
    state: &AppState,
    value: serde_json::Value,
    role: BackendRole,
) -> Result<protocol::RepairFileParams> {
    if role == BackendRole::Admin && value.get("path").is_some() {
        return serde_json::from_value(value).map_err(Into::into);
    }
    let params = serde_json::from_value::<protocol::RepairSessionParams>(value)?;
    Ok(protocol::RepairFileParams {
        path: session_recording_path(state, &params.session_id)?,
        ffmpeg_path: None,
        expect_audio: params.expect_audio,
        intended_fps: params.intended_fps,
    })
}

fn resolve_repair_restore_params(
    state: &AppState,
    value: serde_json::Value,
    role: BackendRole,
) -> Result<protocol::RepairRestoreParams> {
    if role == BackendRole::Admin && value.get("path").is_some() {
        return serde_json::from_value(value).map_err(Into::into);
    }
    let params = serde_json::from_value::<protocol::RepairRestoreSessionParams>(value)?;
    Ok(protocol::RepairRestoreParams {
        path: session_recording_path(state, &params.session_id)?,
    })
}

fn resolve_renderer_managed_backgrounds(
    state: &AppState,
    value: &mut serde_json::Value,
    role: BackendRole,
) -> Result<()> {
    if role == BackendRole::Admin {
        return Ok(());
    }
    match value {
        serde_json::Value::Object(object) => {
            if let Some(background) = object.get_mut("background")
                && let Some(background) = background.as_object_mut()
            {
                let asset_id = background
                    .get("assetId")
                    .and_then(serde_json::Value::as_str)
                    .context("Scene background assetId is required.")?;
                let path = state
                    .resource_authority
                    .resolve_managed_background(asset_id)?;
                background.insert(
                    "managedAssetPath".to_string(),
                    serde_json::Value::String(path.display().to_string()),
                );
            }
            for child in object.values_mut() {
                resolve_renderer_managed_backgrounds(state, child, role)?;
            }
        }
        serde_json::Value::Array(array) => {
            for child in array {
                resolve_renderer_managed_backgrounds(state, child, role)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn rpc_params_are_empty(params: &serde_json::Value) -> bool {
    params.is_null() || params.as_object().is_some_and(serde_json::Map::is_empty)
}

async fn handle_text_message_with_role(
    state: &AppState,
    text: &str,
    role: BackendRole,
) -> ServerResponse {
    let mut command = match serde_json::from_str::<ClientCommand>(text) {
        Ok(command) => command,
        Err(error) => {
            return ServerResponse::error(
                "unknown",
                "invalid-json",
                format!("Could not parse command: {error}"),
            );
        }
    };

    if let Err(error) = authorize_backend_method(role, &command.method, state.smoke_rpc_enabled) {
        return ServerResponse::error(command.id, error.code(), error.message());
    }
    // Do this centrally, before individual parameter deserializers can turn a
    // renderer string into process authority. Release builds ignore caller
    // FFmpeg paths even on the admin channel.
    scrub_untrusted_ffmpeg_paths(&mut command.params, role, state.smoke_rpc_enabled);
    if let Err(error) = resolve_renderer_managed_backgrounds(state, &mut command.params, role) {
        return ServerResponse::error(command.id, "managed-background-rejected", error.to_string());
    }

    let mut response = match command.method.as_str() {
        "resource.capability.issue" => {
            match serde_json::from_value::<resource_authority::IssueResourceCapabilityParams>(
                command.params,
            ) {
                Ok(params) => match state.resource_authority.issue(params) {
                    Ok(capability) => ServerResponse::ok(command.id, capability),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "resource-capability-rejected",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "resource.capability.revoke" => {
            let capability_id = command
                .params
                .get("capabilityId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            ServerResponse::ok(
                command.id,
                serde_json::json!({
                    "revoked": state.resource_authority.revoke(capability_id)
                }),
            )
        }
        "resource.capability.register_background" => {
            let asset_id = command
                .params
                .get("assetId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let path = command
                .params
                .get("path")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            match state
                .resource_authority
                .register_managed_background(asset_id, path)
            {
                Ok(()) => ServerResponse::ok(
                    command.id,
                    serde_json::json!({ "registered": true, "assetId": asset_id }),
                ),
                Err(error) => ServerResponse::error(
                    command.id,
                    "managed-background-rejected",
                    error.to_string(),
                ),
            }
        }
        "resource.admin.resolve_session_path" => {
            let session_id = command
                .params
                .get("sessionId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            match session_recording_path(state, session_id) {
                Ok(path) => ServerResponse::ok(command.id, serde_json::json!({ "path": path })),
                Err(error) => ServerResponse::error(
                    command.id,
                    "managed-session-path-missing",
                    error.to_string(),
                ),
            }
        }
        "resource.admin.resolve_screen_path" => {
            let screen_id = command
                .params
                .get("screenId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            match state.database.stream_screen_by_id(screen_id) {
                Ok(screen)
                    if screen.status == protocol::StreamScreenStatus::Ready
                        && !screen.image_path.is_empty() =>
                {
                    ServerResponse::ok(command.id, serde_json::json!({ "path": screen.image_path }))
                }
                Ok(_) => ServerResponse::error(
                    command.id,
                    "managed-screen-path-missing",
                    "Managed Screen image is missing or no longer trusted.",
                ),
                Err(error) => ServerResponse::error(
                    command.id,
                    "managed-screen-path-missing",
                    error.to_string(),
                ),
            }
        }
        "resource.admin.resolve_background_path" => {
            let asset_id = command
                .params
                .get("assetId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            match state
                .resource_authority
                .resolve_managed_background(asset_id)
            {
                Ok(path) => ServerResponse::ok(
                    command.id,
                    serde_json::json!({ "path": path.display().to_string() }),
                ),
                Err(error) => ServerResponse::error(
                    command.id,
                    "managed-background-path-missing",
                    error.to_string(),
                ),
            }
        }
        "health.ping" => {
            let ffmpeg_path = resolve_trusted_ffmpeg_path(
                command
                    .params
                    .get("ffmpegPath")
                    .and_then(|value| value.as_str()),
                role,
                state.smoke_rpc_enabled,
            );
            let mut health = backend_health(state, &ffmpeg_path).await;
            if role == BackendRole::Renderer {
                health.database_path = "managed-app-data".to_string();
                health.ffmpeg.path = "trusted-bundled-ffmpeg".to_string();
            }
            ServerResponse::ok(command.id, health)
        }
        "account.get" => {
            let session = state.account_session.lock().await;
            ServerResponse::ok(command.id, account::current_account(session.as_ref()))
        }
        "account.auth.begin_intent" => {
            let _account_transition = state.account_auth_transition.lock().await;
            match account::advance_sign_in_intent_generation() {
                Ok(intent_generation) => ServerResponse::ok(
                    command.id,
                    protocol::AccountAuthIntent { intent_generation },
                ),
                Err(error) => ServerResponse::error(
                    command.id,
                    "account-intent-persist-failed",
                    error.to_string(),
                ),
            }
        }
        "account.sign_out" => {
            let account_transition = state.account_auth_transition.lock().await;
            let mut clear_result = None;
            clear_account_credentials_after_caption_shutdown(state, || {
                clear_result = Some(account::clear_persisted_account_and_advance_intent());
            })
            .await;
            if let Some(Err(error)) = clear_result {
                return ServerResponse::error(
                    command.id,
                    "account-sign-out-persist-failed",
                    error.to_string(),
                );
            }
            // The account no longer vouches for premium — drop hydrated
            // entitlements with it (multistream gate closes immediately).
            if entitlements::clear_account_entitlements() {
                state.emit_event("entitlements.updated", entitlements::current_entitlements());
            }
            let signed_out = account::signed_out_account();
            *state.account_session.lock().await = Some(signed_out.clone());
            drop(account_transition);
            ServerResponse::ok(command.id, signed_out)
        }
        "account.complete_sign_in" => {
            match serde_json::from_value::<protocol::AccountCompleteSignInParams>(command.params) {
                Ok(params) => {
                    let account_transition = state.account_auth_transition.lock().await;
                    match account::complete_sign_in(
                        &params.code,
                        &params.state,
                        &params.verifier,
                        params.intent_generation,
                        cfg!(debug_assertions),
                    )
                    .await
                    {
                        Ok(resolved) => {
                            *state.account_session.lock().await = Some(resolved.clone());
                            drop(account_transition);
                            let entitlement_state = state.clone();
                            tokio::spawn(async move {
                                refresh_account_entitlements(&entitlement_state).await
                            });
                            ServerResponse::ok(command.id, resolved)
                        }
                        Err(error) => {
                            let code = if account::is_sign_in_superseded(&error) {
                                "account-sign-in-superseded"
                            } else {
                                "account-sign-in-failed"
                            };
                            ServerResponse::error(command.id, code, error.to_string())
                        }
                    }
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "account.refresh" => {
            let account_transition = state.account_auth_transition.lock().await;
            let resolved = account::refresh_account().await;
            *state.account_session.lock().await = Some(resolved.clone());
            drop(account_transition);
            let entitlement_state = state.clone();
            tokio::spawn(async move { refresh_account_entitlements(&entitlement_state).await });
            ServerResponse::ok(command.id, resolved)
        }
        "entitlements.get" => ServerResponse::ok(command.id, entitlements::current_entitlements()),
        "entitlements.refresh" => {
            if !rpc_params_are_empty(&command.params) {
                ServerResponse::error(
                    command.id,
                    "invalid-params",
                    "entitlements.refresh does not accept parameters.",
                )
            } else {
                // Revalidation is best-effort and fail-closed. The refresh helper
                // retains only a still-valid verified snapshot on network failure;
                // callers always receive the effective current snapshot.
                let _ = tokio::time::timeout(
                    ENTITLEMENT_REFRESH_TIMEOUT,
                    refresh_account_entitlements(state),
                )
                .await;
                ServerResponse::ok(command.id, entitlements::current_entitlements())
            }
        }
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
        "captions.style.set" => {
            match serde_json::from_value::<captions::SetCaptionStyleParams>(command.params) {
                Ok(params) => match captions::update_caption_style(state, params).await {
                    Ok(style) => ServerResponse::ok(command.id, style),
                    Err(error) => ServerResponse::error(
                        command.id,
                        captions::caption_style_error_code(&error),
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        #[cfg(debug_assertions)]
        "captions.test.inject-audio" => {
            let duration_ms = command
                .params
                .get("durationMs")
                .and_then(|value| value.as_u64())
                .unwrap_or(600);
            match captions::inject_caption_contract_test_audio(duration_ms).await {
                Ok(frames_accepted) => ServerResponse::ok(
                    command.id,
                    serde_json::json!({ "framesAccepted": frames_accepted }),
                ),
                Err(error) => ServerResponse::error(
                    command.id,
                    "caption-contract-test-disabled",
                    error.to_string(),
                ),
            }
        }
        #[cfg(debug_assertions)]
        "captions.test.snapshot" => match captions::caption_contract_test_snapshot(state).await {
            Ok(snapshot) => ServerResponse::ok(command.id, snapshot),
            Err(error) => ServerResponse::error(
                command.id,
                "caption-contract-test-disabled",
                error.to_string(),
            ),
        },
        "captions.overlay.set" => {
            match serde_json::from_value::<captions::SetCaptionOverlayParams>(command.params) {
                Ok(params) => {
                    match captions::install_caption_overlays(&state.caption_overlay, params) {
                        Ok(info) => ServerResponse::ok(command.id, info),
                        Err(error) => ServerResponse::error(
                            command.id,
                            captions::caption_overlay_error_code(&error),
                            error.to_string(),
                        ),
                    }
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "comments.highlight.status" => ServerResponse::ok(
            command.id,
            comment_highlight::comment_highlight_status(state).await,
        ),
        "comments.highlight.set" => {
            match serde_json::from_value::<comment_highlight::SetCommentHighlightParams>(
                command.params,
            ) {
                Ok(params) => match comment_highlight::set_comment_highlight(state, params).await {
                    Ok(status) => ServerResponse::ok(command.id, status),
                    Err(error) => {
                        ServerResponse::error(command.id, error.code(), error.to_string())
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "comments.highlight.clear" => ServerResponse::ok(
            command.id,
            comment_highlight::clear_comment_highlight(state).await,
        ),
        "captions.overlay.clear" => {
            match serde_json::from_value::<captions::ClearCaptionOverlayParams>(command.params) {
                Ok(params) => {
                    match captions::clear_caption_overlays(&state.caption_overlay, params) {
                        Ok(info) => ServerResponse::ok(command.id, info),
                        Err(error) => ServerResponse::error(
                            command.id,
                            captions::caption_overlay_error_code(&error),
                            error.to_string(),
                        ),
                    }
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
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
            let ffmpeg_path = resolve_trusted_ffmpeg_path(
                command
                    .params
                    .get("ffmpegPath")
                    .and_then(|value| value.as_str()),
                role,
                state.smoke_rpc_enabled,
            );
            let devices = devices::list_devices(&ffmpeg_path).await;
            state.emit_event("devices.changed", &devices);
            ServerResponse::ok(command.id, devices)
        }
        "diagnostics.supportBundle.export" => {
            if role == BackendRole::Renderer
                && command
                    .params
                    .as_object()
                    .is_some_and(|params| params.contains_key("outputDirectory"))
            {
                return ServerResponse::error(
                    command.id,
                    "resource-capability-rejected",
                    "Renderer support bundles use the managed diagnostics directory; raw outputDirectory is not accepted.",
                );
            }
            match serde_json::from_value::<support_bundle::SupportBundleExportParams>(
                command.params,
            ) {
                Ok(params) => {
                    let ffmpeg_path = resolve_trusted_ffmpeg_path(
                        params.ffmpeg_path.as_deref(),
                        role,
                        state.smoke_rpc_enabled,
                    );
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
        #[cfg(debug_assertions)]
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
                    let _scene_commit = state.scene_commit.lock().await;
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
        "audio.processing.update" => {
            match serde_json::from_value::<protocol::AudioProcessingUpdateParams>(command.params) {
                Ok(params) => ServerResponse::ok(
                    command.id,
                    update_active_audio_processing(state, params).await,
                ),
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        #[cfg(debug_assertions)]
        "audio.test.inject-pcm" => {
            let session_id = command
                .params
                .get("sessionId")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            let duration_ms = command
                .params
                .get("durationMs")
                .and_then(|value| value.as_u64())
                .unwrap_or(600);
            let raw_peak = command
                .params
                .get("rawPeak")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.12) as f32;
            let injector = {
                let recording = state.recording.lock().await;
                recording
                    .as_ref()
                    .filter(|active| active.session_id == session_id)
                    .and_then(|active| active.native_audio.as_ref())
                    .and_then(|native_audio| native_audio.caption_contract_test_injector())
            };
            match injector {
                Some(injector) => match injector.inject(duration_ms, raw_peak).await {
                    Ok(injection) => ServerResponse::ok(
                        command.id,
                        serde_json::json!({
                            "packetsGenerated": injection.packets_generated,
                            "rawPeak": injection.raw_peak,
                        }),
                    ),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "caption-contract-test-disabled",
                        error.to_string(),
                    ),
                },
                None => ServerResponse::error(
                    command.id,
                    "caption-contract-test-disabled",
                    "The matching caption contract test microphone session is not active.",
                ),
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
                    match live_layout::commit_idle_scene_with_layout(
                        state,
                        &scene,
                        params.layout,
                        None,
                    )
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
            match serde_json::from_value::<protocol::SceneLayoutApplyParams>(command.params) {
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
        "scene.layout.apply_preview" => {
            match serde_json::from_value::<protocol::SceneLayoutApplyParams>(command.params) {
                Ok(params) => match live_layout::apply_layout_preview(state, params).await {
                    Ok(status) => ServerResponse::ok(command.id, status),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "layout-preview-failed",
                        error.to_string(),
                    ),
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
        #[cfg(debug_assertions)]
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
            let mut params_value = command.params;
            if let Err(error) = resolve_start_session_resources(state, &mut params_value, role) {
                return ServerResponse::error(
                    command.id,
                    "resource-capability-rejected",
                    error.to_string(),
                );
            }
            match serde_json::from_value::<protocol::StartSessionParams>(params_value) {
                Ok(params) => {
                    let streaming = params.streaming.clone();
                    let attach_live_chat = session_attaches_live_chat(&params);
                    match validate_start_session_oauth_availability(&params) {
                        Ok(()) => match start_session(state.clone(), params).await {
                            Ok(status) => {
                                if attach_live_chat
                                    && let Some(streaming) = streaming.as_ref()
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
            match serde_json::from_value::<protocol::SessionDeleteParams>(command.params) {
                Ok(params) if params.session_ids.is_empty() => ServerResponse::error(
                    command.id,
                    "session-delete-invalid",
                    "No sessions given.",
                ),
                Ok(params)
                    if params.session_ids.iter().any(|session_id| {
                        noise_cleanup::session_mutation_blocked(state, session_id).unwrap_or(true)
                    }) =>
                {
                    ServerResponse::error(
                        command.id,
                        "noise-cleanup-mutation-blocked",
                        "This recording cannot be deleted while Noise Cleanup is active.",
                    )
                }
                Ok(params) => match state
                    .database
                    .prepare_session_deletions(&params.session_ids)
                {
                    Ok(operations) => ServerResponse::ok(
                        command.id,
                        operations
                            .iter()
                            .map(session_deletion_handle)
                            .collect::<Vec<_>>(),
                    ),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "session-delete-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "sessions.delete.complete" => {
            match serde_json::from_value::<protocol::SessionDeleteCompleteParams>(command.params) {
                Ok(params) if params.operation_id.is_empty() => ServerResponse::error(
                    command.id,
                    "session-delete-complete-invalid",
                    "A delete operation id is required.",
                ),
                Ok(params) => match state
                    .database
                    .complete_session_deletion(&params.operation_id, &params.failed_paths)
                {
                    Ok(completion) => {
                        if completion.deleted {
                            posters::remove_session_poster(&completion.session_id).await;
                        }
                        ServerResponse::ok(command.id, completion)
                    }
                    Err(error) => ServerResponse::error(
                        command.id,
                        "session-delete-complete-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "sessions.delete.resolve" => {
            let operation_id = command
                .params
                .get("operationId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if operation_id.is_empty() {
                ServerResponse::error(
                    command.id,
                    "session-delete-resolve-invalid",
                    "A delete operation id is required.",
                )
            } else {
                match state.database.pending_session_deletions() {
                    Ok(operations) => match operations
                        .into_iter()
                        .find(|operation| operation.operation_id == operation_id)
                    {
                        Some(operation) => ServerResponse::ok(command.id, operation),
                        None => ServerResponse::error(
                            command.id,
                            "session-delete-resolve-missing",
                            "Delete operation was not found.",
                        ),
                    },
                    Err(error) => ServerResponse::error(
                        command.id,
                        "session-delete-resolve-failed",
                        error.to_string(),
                    ),
                }
            }
        }
        "sessions.delete.pending" => match state.database.pending_session_deletions() {
            Ok(operations) => ServerResponse::ok(
                command.id,
                operations
                    .iter()
                    .map(session_deletion_handle)
                    .collect::<Vec<_>>(),
            ),
            Err(error) => ServerResponse::error(
                command.id,
                "session-delete-pending-failed",
                error.to_string(),
            ),
        },
        "sessions.duplicate" => {
            let session_id = command
                .params
                .get("sessionId")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if noise_cleanup::session_mutation_blocked(state, session_id).unwrap_or(true) {
                return ServerResponse::error(
                    command.id,
                    "noise-cleanup-mutation-blocked",
                    "This recording cannot be duplicated while Noise Cleanup is active.",
                );
            }
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
            let mut params_value = command.params;
            if let Err(error) = resolve_import_resources(state, &mut params_value, role) {
                return ServerResponse::error(
                    command.id,
                    "resource-capability-rejected",
                    error.to_string(),
                );
            }
            let output_directory = params_value
                .get("outputDirectory")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let source_path = params_value
                .get("sourcePath")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let ffmpeg_path = ffmpeg::resolve_ffmpeg_path(
                params_value
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
                Ok(params) => match state.database.list_live_chat_messages_page(
                    &params.session_id,
                    params.cursor.as_deref(),
                    params.limit,
                ) {
                    Ok(page) => ServerResponse::ok(command.id, page),
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
            match serde_json::from_value::<live_chat::CommentsSendParams>(command.params) {
                Ok(params) => match live_chat::send_live_chat_message(state, params).await {
                    Ok(operation) => ServerResponse::ok(command.id, operation),
                    Err(error) => ServerResponse::error(command.id, "live-chat-send-failed", error),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "liveChat.sendOperations.list" => {
            let session_id = command
                .params
                .get("sessionId")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if session_id.is_empty() {
                ServerResponse::error(command.id, "invalid-params", "sessionId is required.")
            } else {
                match state.database.list_chat_send_operations(session_id) {
                    Ok(operations) => ServerResponse::ok(command.id, operations),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "live-chat-send-operations-list-failed",
                        error.to_string(),
                    ),
                }
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
                    .start_provider_with_secret_store(
                        params,
                        state.oauth_redirect_port(),
                        secrets::put_secret,
                        secrets::delete_secret,
                    )
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
                Ok(params) => {
                    let _platform_finalization = state
                        .oauth
                        .lock_platform_finalization(params.platform)
                        .await;
                    let pending_generation = state
                        .oauth
                        .highest_pending_account_write_generation(params.platform)
                        .await;
                    if params.platform == StreamPlatform::Youtube {
                        let credentials = match state.database.list_platform_account_credentials() {
                            Ok(accounts) => accounts.into_iter().find(|account| {
                                account.account.platform == StreamPlatform::Youtube
                            }),
                            Err(error) => {
                                return ServerResponse::error(
                                    command.id,
                                    "platform-account-revocation-failed",
                                    format!(
                                        "Could not load the saved YouTube authorization before revoking it: {error}"
                                    ),
                                );
                            }
                        };
                        if let Some(credentials) = credentials {
                            let token_ref = credentials
                                .refresh_token_secret_ref
                                .as_deref()
                                .or(credentials.token_secret_ref.as_deref());
                            if let Some(token_ref) = token_ref {
                                match secrets::get_secret(token_ref) {
                                    Ok(token) => {
                                        if let Err(error) = oauth::revoke_youtube_token(
                                            &token,
                                            &oauth::provider_http_client(),
                                        )
                                        .await
                                        {
                                            return ServerResponse::error(
                                                command.id,
                                                "platform-account-revocation-failed",
                                                format!(
                                                    "Could not revoke YouTube access. Check your connection and try Disconnect again. {error}"
                                                ),
                                            );
                                        }
                                    }
                                    Err(error) => {
                                        return ServerResponse::error(
                                            command.id,
                                            "platform-account-revocation-failed",
                                            format!(
                                                "Could not read the saved YouTube authorization before revoking it: {error}"
                                            ),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    match state.database.disconnect_platform_account_after_generation(
                        params.platform,
                        pending_generation,
                    ) {
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
                    }
                }
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
            let mut params_value = command.params;
            if let Err(error) = resolve_screen_import_resource(state, &mut params_value, role) {
                return ServerResponse::error(
                    command.id,
                    "resource-capability-rejected",
                    error.to_string(),
                );
            }
            match serde_json::from_value::<protocol::ImportScreenImageParams>(params_value) {
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
                Ok(params)
                    if noise_cleanup::session_mutation_blocked(state, &params.session_id)
                        .unwrap_or(true) =>
                {
                    ServerResponse::error(
                        command.id,
                        "noise-cleanup-mutation-blocked",
                        "This recording cannot be remuxed while Noise Cleanup is active.",
                    )
                }
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
        "repair.assess_file" => match resolve_repair_file_params(state, command.params, role) {
            Ok(params) => match repair_service::assess_file(state.clone(), params).await {
                Ok(result) => ServerResponse::ok(command.id, result),
                Err(error) => ServerResponse::error(command.id, "repair-assess-failed", error),
            },
            Err(error) => ServerResponse::error(command.id, "invalid-params", error.to_string()),
        },
        "repair.repair_file" => match resolve_repair_file_params(state, command.params, role) {
            Ok(params)
                if state
                    .database
                    .session_id_for_media_path(&params.path)
                    .ok()
                    .flatten()
                    .is_some_and(|session_id| {
                        noise_cleanup::session_mutation_blocked(state, &session_id).unwrap_or(true)
                    }) =>
            {
                ServerResponse::error(
                    command.id,
                    "noise-cleanup-mutation-blocked",
                    "This recording cannot be repaired while Noise Cleanup is active.",
                )
            }
            Ok(params) => match repair_service::repair_file(state.clone(), params).await {
                Ok(status) => ServerResponse::ok(command.id, status),
                Err(error) => ServerResponse::error(command.id, "repair-failed", error),
            },
            Err(error) => ServerResponse::error(command.id, "invalid-params", error.to_string()),
        },
        "repair.restore_file" => match resolve_repair_restore_params(state, command.params, role) {
            Ok(params)
                if state
                    .database
                    .session_id_for_media_path(&params.path)
                    .ok()
                    .flatten()
                    .is_some_and(|session_id| {
                        noise_cleanup::session_mutation_blocked(state, &session_id).unwrap_or(true)
                    }) =>
            {
                ServerResponse::error(
                    command.id,
                    "noise-cleanup-mutation-blocked",
                    "This recording cannot be restored while Noise Cleanup is active.",
                )
            }
            Ok(params) => match repair_service::restore_file(params).await {
                Ok(restored) => {
                    ServerResponse::ok(command.id, serde_json::json!({ "restored": restored }))
                }
                Err(error) => ServerResponse::error(command.id, "repair-restore-failed", error),
            },
            Err(error) => ServerResponse::error(command.id, "invalid-params", error.to_string()),
        },
        "noiseCleanup.start" => {
            match serde_json::from_value::<protocol::NoiseCleanupStartParams>(command.params) {
                Ok(params) => match noise_cleanup::start(state.clone(), params).await {
                    Ok(job) => ServerResponse::ok(command.id, job),
                    Err(error) => {
                        let code = if error.contains("Premium") {
                            "noise-cleanup-premium-required"
                        } else if error.contains("live session") {
                            "noise-cleanup-live"
                        } else {
                            "noise-cleanup-start-failed"
                        };
                        ServerResponse::error(command.id, code, error)
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "noiseCleanup.cancel" => {
            match serde_json::from_value::<protocol::NoiseCleanupCancelParams>(command.params) {
                Ok(params) => match noise_cleanup::cancel(state.clone(), params).await {
                    Ok(job) => ServerResponse::ok(command.id, job),
                    Err(error) => {
                        ServerResponse::error(command.id, "noise-cleanup-cancel-failed", error)
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "noiseCleanup.list" => {
            let valid = rpc_params_are_empty(&command.params);
            if !valid {
                ServerResponse::error(
                    command.id,
                    "invalid-params",
                    "noiseCleanup.list does not accept parameters.",
                )
            } else {
                match noise_cleanup::list(state).await {
                    Ok(jobs) => ServerResponse::ok(command.id, jobs),
                    Err(error) => {
                        ServerResponse::error(command.id, "noise-cleanup-list-failed", error)
                    }
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
        "ai.clips.suggest" => {
            match serde_json::from_value::<protocol::ClipSuggestParams>(command.params) {
                Ok(params) => match publish_clips::suggest_clips(state.clone(), params).await {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => {
                        ServerResponse::error(command.id, "clip-suggest-failed", error.to_string())
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "ai.clip.export" => {
            match serde_json::from_value::<protocol::ClipExportParams>(command.params) {
                Ok(params) => match publish_clips::export_clip(state.clone(), params).await {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => {
                        ServerResponse::error(command.id, "clip-export-failed", error.to_string())
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
    };
    if role == BackendRole::Renderer
        && let Some(payload) = response.payload.as_mut()
    {
        resource_authority::redact_managed_background_paths(payload);
        resource_authority::redact_managed_screen_paths(payload);
    }
    response
}

async fn clear_account_credentials_after_caption_shutdown(
    state: &AppState,
    clear_credentials: impl FnOnce(),
) {
    captions::stop_captions_for_sign_out(state, clear_credentials).await;
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
    let stats =
        diagnostics::apply_runtime_diagnostics_snapshot(stats, state.ffmpeg_work.snapshot());
    diagnostics::apply_websocket_transport_stats(
        stats,
        state.websocket_transport_metrics.snapshot(),
    )
}

async fn current_recording_status(state: &AppState) -> protocol::RecordingStatus {
    let active_status = state.recording.lock().await.as_ref().map(|active| {
        let state = if active.stop_requested {
            RecordingState::Stopping
        } else if active.mode == "stream" {
            RecordingState::Streaming
        } else {
            RecordingState::Recording
        };
        active.status(state, None)
    });
    if let Some(status) = active_status {
        return status;
    }
    if state.ffmpeg_work.snapshot().finalizing_active {
        return protocol::RecordingStatus {
            state: RecordingState::Stopping,
            session_id: None,
            output_path: None,
            stream_url: None,
            started_at: None,
            audio_tracks: Vec::new(),
            pipeline: None,
            duration_ms: None,
            message: Some("Finalizing recording output.".to_string()),
        };
    }
    idle_status()
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
    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = timeout(Duration::from_secs(4), output_owned_tokio(&mut command)).await;

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
    use std::time::Instant;
    use tokio::sync::broadcast;

    static CAPTION_LIFECYCLE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[test]
    fn no_param_rpc_accepts_omitted_or_empty_params_only() {
        assert!(rpc_params_are_empty(&serde_json::Value::Null));
        assert!(rpc_params_are_empty(&json!({})));
        assert!(!rpc_params_are_empty(&json!({ "unexpected": true })));
        assert!(!rpc_params_are_empty(&json!([])));
    }

    #[test]
    fn entitlement_refresh_is_bounded_below_the_rpc_deadline() {
        assert_eq!(ENTITLEMENT_REFRESH_TIMEOUT, Duration::from_secs(10));
        assert!(ENTITLEMENT_REFRESH_TIMEOUT < Duration::from_secs(30));
    }

    async fn receive_tracked_json(
        receiver: &mut mpsc::Receiver<Message>,
        metrics: &TrackedWebSocketQueueMetrics,
    ) -> serde_json::Value {
        let message = receiver.recv().await.expect("tracked websocket message");
        metrics.record_dequeue_oldest();
        let Message::Text(text) = message else {
            panic!("expected tracked websocket text message");
        };
        serde_json::from_str(text.as_str()).expect("tracked websocket JSON")
    }

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

    #[tokio::test]
    async fn loopback_oauth_retries_advanced_work_code_less_until_success() {
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen_codes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let emitted = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let attempt_counter = attempts.clone();
        let attempt_codes = seen_codes.clone();
        let emitted_counter = emitted.clone();

        let result = run_bounded_oauth_retry_loop(
            OAuthCompleteParams {
                state: "provider-state".to_string(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            },
            &[Duration::ZERO, Duration::ZERO, Duration::ZERO],
            Duration::ZERO,
            tokio::time::Instant::now() + Duration::from_secs(1),
            move |params| {
                let attempt_counter = attempt_counter.clone();
                let attempt_codes = attempt_codes.clone();
                async move {
                    attempt_codes.lock().unwrap().push(params.code.clone());
                    let attempt = attempt_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    oauth::OAuthCallbackResult {
                        platform: Some(StreamPlatform::X),
                        state: params.state,
                        status: if attempt < 2 {
                            oauth::OAuthCallbackStatus::Failed
                        } else {
                            oauth::OAuthCallbackStatus::Success
                        },
                        code_present: params.code.is_some(),
                        error: None,
                        message: None,
                        token_stored: attempt >= 2,
                        account_connected: attempt >= 2,
                        retryable: attempt < 2,
                        received_at: chrono::Utc::now().to_rfc3339(),
                    }
                }
            },
            || async { true },
            move |_| {
                emitted_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            },
        )
        .await;

        assert_eq!(result.status, oauth::OAuthCallbackStatus::Success);
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert_eq!(emitted.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert_eq!(
            *seen_codes.lock().unwrap(),
            vec![Some("single-use-code".to_string()), None, None]
        );
    }

    #[test]
    fn loopback_oauth_cooldown_is_capped_by_the_transaction_expiry() {
        let now = tokio::time::Instant::now();
        let deadline = now + Duration::from_secs(600);

        assert_eq!(
            oauth_retry_delay(
                &LOOPBACK_OAUTH_RETRY_DELAYS,
                LOOPBACK_OAUTH_COOLDOWN_RETRY_DELAY,
                LOOPBACK_OAUTH_RETRY_DELAYS.len(),
                now + Duration::from_secs(595),
                deadline,
            ),
            Some(Duration::from_secs(5))
        );
        assert_eq!(
            oauth_retry_delay(
                &LOOPBACK_OAUTH_RETRY_DELAYS,
                LOOPBACK_OAUTH_COOLDOWN_RETRY_DELAY,
                LOOPBACK_OAUTH_RETRY_DELAYS.len(),
                deadline,
                deadline,
            ),
            None
        );
    }

    #[tokio::test]
    async fn loopback_oauth_runs_one_code_less_terminal_attempt_at_expiry() {
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen_codes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let attempt_counter = attempts.clone();
        let attempt_codes = seen_codes.clone();

        let result = run_bounded_oauth_retry_loop(
            OAuthCompleteParams {
                state: "provider-state".to_string(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            },
            &LOOPBACK_OAUTH_RETRY_DELAYS,
            LOOPBACK_OAUTH_COOLDOWN_RETRY_DELAY,
            tokio::time::Instant::now(),
            move |params| {
                let attempt_counter = attempt_counter.clone();
                let attempt_codes = attempt_codes.clone();
                async move {
                    attempt_codes.lock().unwrap().push(params.code.clone());
                    let attempt = attempt_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    oauth::OAuthCallbackResult {
                        platform: Some(StreamPlatform::X),
                        state: params.state,
                        status: if attempt == 0 {
                            oauth::OAuthCallbackStatus::Failed
                        } else {
                            oauth::OAuthCallbackStatus::Expired
                        },
                        code_present: params.code.is_some(),
                        error: None,
                        message: None,
                        token_stored: false,
                        account_connected: false,
                        retryable: attempt == 0,
                        received_at: chrono::Utc::now().to_rfc3339(),
                    }
                }
            },
            || async { true },
            |_| {},
        )
        .await;

        assert_eq!(result.status, oauth::OAuthCallbackStatus::Expired);
        assert_eq!(
            *seen_codes.lock().unwrap(),
            vec![Some("single-use-code".to_string()), None]
        );
    }

    #[tokio::test]
    async fn loopback_oauth_never_reposts_provider_exchange_code() {
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let attempt_counter = attempts.clone();
        let result = run_bounded_oauth_retry_loop(
            OAuthCompleteParams {
                state: "provider-state".to_string(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            },
            &[Duration::ZERO],
            Duration::ZERO,
            tokio::time::Instant::now() + Duration::from_secs(1),
            move |params| {
                attempt_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async move {
                    oauth::OAuthCallbackResult {
                        platform: Some(StreamPlatform::X),
                        state: params.state,
                        status: oauth::OAuthCallbackStatus::Failed,
                        code_present: params.code.is_some(),
                        error: None,
                        message: None,
                        token_stored: false,
                        account_connected: false,
                        retryable: true,
                        received_at: chrono::Utc::now().to_rfc3339(),
                    }
                }
            },
            || async { false },
            |_| {},
        )
        .await;

        assert!(result.retryable);
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn loopback_oauth_cooldown_recovers_after_the_fast_retry_window_without_reposting_code() {
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen_codes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let attempt_counter = attempts.clone();
        let attempt_codes = seen_codes.clone();

        let result = run_bounded_oauth_retry_loop(
            OAuthCompleteParams {
                state: "provider-state".to_string(),
                code: Some("single-use-code".to_string()),
                error: None,
                error_description: None,
            },
            &[Duration::ZERO],
            Duration::ZERO,
            tokio::time::Instant::now() + Duration::from_secs(1),
            move |params| {
                let attempt_counter = attempt_counter.clone();
                let attempt_codes = attempt_codes.clone();
                async move {
                    attempt_codes.lock().unwrap().push(params.code.clone());
                    let attempt = attempt_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    oauth::OAuthCallbackResult {
                        platform: Some(StreamPlatform::X),
                        state: params.state,
                        status: if attempt < 8 {
                            oauth::OAuthCallbackStatus::Failed
                        } else {
                            oauth::OAuthCallbackStatus::Success
                        },
                        code_present: params.code.is_some(),
                        error: None,
                        message: None,
                        token_stored: attempt >= 8,
                        account_connected: attempt >= 8,
                        retryable: attempt < 8,
                        received_at: chrono::Utc::now().to_rfc3339(),
                    }
                }
            },
            || async { true },
            |_| {},
        )
        .await;

        assert_eq!(result.status, oauth::OAuthCallbackStatus::Success);
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 9);
        let codes = seen_codes.lock().unwrap();
        assert_eq!(codes.first(), Some(&Some("single-use-code".to_string())));
        assert!(codes.iter().skip(1).all(Option::is_none));
    }

    #[tokio::test]
    async fn concurrent_oauth_completion_never_retires_the_in_flight_transaction() {
        let state = test_state();
        let started = state
            .oauth
            .start_provider(
                OAuthStartProviderParams {
                    platform: StreamPlatform::X,
                    redirect_uri: Some("videorc://oauth/callback".to_string()),
                },
                state.port,
            )
            .await
            .unwrap();
        let params = OAuthCompleteParams {
            state: started.state.clone(),
            code: Some("single-use-code".to_string()),
            error: None,
            error_description: None,
        };

        let first = state.oauth.complete_with_pending(params.clone()).await;
        assert!(first.exchange.is_some(), "first caller owns the exchange");

        let concurrent = complete_oauth_callback(&state, params.clone()).await;
        assert!(concurrent.retryable);
        assert!(
            concurrent
                .message
                .as_deref()
                .is_some_and(|message| { message.contains("already in progress") })
        );

        state.oauth.retry(&started.state).await.unwrap();
        let recovered = state.oauth.complete_with_pending(params).await;
        assert_eq!(recovered.result.status, oauth::OAuthCallbackStatus::Success);
        assert!(
            recovered.exchange.is_some(),
            "the retryable concurrent caller must not delete pending exchange state"
        );
        state.oauth.finish(&started.state).await.unwrap();
    }

    #[test]
    fn oauth_account_transition_preserves_same_identity_refresh_and_supersedes_old_access() {
        let existing = crate::storage::PlatformAccountCredentials {
            account: crate::streaming::PlatformAccount {
                id: "stored-account".to_string(),
                platform: StreamPlatform::X,
                account_id: "x-user-1".to_string(),
                account_label: "X User".to_string(),
                account_handle: Some("@x-user".to_string()),
                avatar_url: None,
                scopes: vec!["users.read".to_string()],
                access_token_present: true,
                refresh_token_present: true,
                stream_key_present: false,
                expires_at: None,
                connected_at: "2026-07-12T00:00:00Z".to_string(),
                updated_at: "2026-07-12T00:00:00Z".to_string(),
                status: crate::streaming::PlatformAccountStatus::Connected,
            },
            token_secret_ref: Some("platform:x:oauth:access".to_string()),
            refresh_token_secret_ref: Some("platform:x:oauth:refresh".to_string()),
            stream_key_secret_ref: None,
            write_generation: 0,
        };
        let candidate = crate::streaming::UpsertPlatformAccount {
            platform: StreamPlatform::X,
            account_id: "x-user-1".to_string(),
            account_label: "X User".to_string(),
            account_handle: Some("@x-user".to_string()),
            avatar_url: None,
            scopes: vec!["users.read".to_string()],
            token_secret_ref: Some("platform:x:oauth:candidate:abc:access".to_string()),
            refresh_token_secret_ref: None,
            stream_key_secret_ref: None,
            expires_at: None,
            status: crate::streaming::PlatformAccountStatus::Connected,
        };

        let (prepared, superseded) =
            prepare_oauth_account_transition(candidate.clone(), Some(&existing));
        assert_eq!(
            prepared.refresh_token_secret_ref.as_deref(),
            Some("platform:x:oauth:refresh")
        );
        assert_eq!(superseded, vec!["platform:x:oauth:access".to_string()]);

        let mut different_identity = candidate;
        different_identity.account_id = "x-user-2".to_string();
        let (prepared, superseded) =
            prepare_oauth_account_transition(different_identity, Some(&existing));
        assert!(prepared.refresh_token_secret_ref.is_none());
        assert_eq!(
            superseded,
            vec![
                "platform:x:oauth:access".to_string(),
                "platform:x:oauth:refresh".to_string(),
            ]
        );
    }

    #[test]
    fn refresh_finishing_after_reconnect_cannot_restore_stale_secret_refs() {
        let state = test_state();
        let account = |account_id: &str, token_ref: &str| UpsertPlatformAccount {
            platform: StreamPlatform::X,
            account_id: account_id.to_string(),
            account_label: account_id.to_string(),
            account_handle: Some(format!("@{account_id}")),
            avatar_url: None,
            scopes: vec!["users.read".to_string()],
            token_secret_ref: Some(token_ref.to_string()),
            refresh_token_secret_ref: Some(format!("{token_ref}:refresh")),
            stream_key_secret_ref: None,
            expires_at: None,
            status: PlatformAccountStatus::Connected,
        };
        state
            .database
            .upsert_platform_account(account("account-a", "platform:x:oauth:a"))
            .unwrap();
        let stale = state
            .database
            .list_platform_account_credentials()
            .unwrap()
            .remove(0);
        state
            .database
            .upsert_platform_account(account("account-b", "platform:x:oauth:b"))
            .unwrap();
        let secret_writer_called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let called = secret_writer_called.clone();

        let error = persist_refreshed_platform_access_token_with_secret_writer(
            &state,
            &stale,
            stale.token_secret_ref.as_deref().unwrap(),
            stale.refresh_token_secret_ref.as_deref().unwrap(),
            oauth::RefreshedOAuthToken {
                access_token: "late-refreshed-access".to_string(),
                refresh_token: Some("late-refreshed-refresh".to_string()),
                scopes: vec!["users.read".to_string()],
                expires_at: None,
            },
            move |_| {
                called.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.to_string().contains("changed while"));
        assert!(!secret_writer_called.load(std::sync::atomic::Ordering::SeqCst));
        let current = state.database.list_platform_account_credentials().unwrap();
        assert_eq!(current[0].account.account_id, "account-b");
        assert_eq!(
            current[0].token_secret_ref.as_deref(),
            Some("platform:x:oauth:b")
        );
    }

    #[tokio::test]
    async fn preview_bmp_query_parses_generation_aware_camel_case_cursor() {
        use axum::extract::FromRequestParts;

        let request = axum::http::Request::builder()
            .uri(
                "/preview/screen/latest.bmp?token=test-token&maxWidth=960&afterGeneration=screen-run-b&afterSequence=42",
            )
            .body(())
            .unwrap();
        let (mut parts, _) = request.into_parts();
        let Query(query) = Query::<WsQuery>::from_request_parts(&mut parts, &())
            .await
            .unwrap();

        assert_eq!(query.max_width, Some(960));
        assert_eq!(
            query.preview_bmp_cursor(),
            Some(preview_bmp::PreviewBmpCursor {
                generation: "screen-run-b".to_string(),
                sequence: 42,
            })
        );
    }

    #[test]
    fn unchanged_preview_bmp_response_exposes_generation_cursor_to_file_origin_fetch() {
        let response = latest_preview_bmp_response(preview_bmp::LatestPreviewBmpPoll::Unchanged {
            generation: "camera-run-a".to_string(),
            sequence: 9,
        });

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response.headers()["x-videorc-frame-generation"],
            "camera-run-a"
        );
        assert_eq!(response.headers()["x-videorc-frame-sequence"], "9");
        assert!(
            response.headers()["access-control-expose-headers"]
                .to_str()
                .unwrap()
                .contains("x-videorc-frame-generation")
        );
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
    fn connection_control_replaces_per_socket_include_and_exclude_sets() {
        let filter = std::sync::Arc::new(std::sync::Mutex::new(ConnectionEventFilter::default()));

        // Non-control commands pass through untouched.
        assert!(
            handle_connection_control(&filter, r#"{"id":"a","method":"recording.start"}"#)
                .is_none()
        );
        assert!(handle_connection_control(&filter, "not json").is_none());

        let response = handle_connection_control(
            &filter,
            r#"{"id":"b","method":"events.setExcluded","params":{"events":["compositor.status"]}}"#,
        )
        .expect("control response");
        assert!(response.ok);
        assert!(
            filter
                .lock()
                .unwrap()
                .excluded
                .contains("compositor.status")
        );

        let response = handle_connection_control(
            &filter,
            r#"{"id":"included","method":"events.setIncluded","params":{"events":["preview.frameReady","compositor.status"]}}"#,
        )
        .expect("include control response");
        assert!(response.ok);
        let guard = filter.lock().unwrap();
        assert!(guard.allows("preview.frameReady"));
        assert!(!guard.allows("recording.status"));
        assert!(!guard.allows("compositor.status"), "exclusion still wins");
        drop(guard);

        // An empty list clears the filter (fallback pump resubscribes).
        let response = handle_connection_control(
            &filter,
            r#"{"id":"c","method":"events.setExcluded","params":{"events":[]}}"#,
        )
        .expect("control response");
        assert!(response.ok);
        let guard = filter.lock().unwrap();
        assert!(guard.excluded.is_empty());
        assert!(guard.allows("compositor.status"));
        assert!(!guard.allows("recording.status"));
    }

    #[tokio::test]
    async fn websocket_telemetry_buffer_is_capacity_bounded_and_latest_wins() {
        let transport = WebSocketTransportMetrics::default();
        let connection = transport.register_connection();
        let telemetry =
            CoalescingEventBuffer::with_metrics(2, connection.coalesced_telemetry_queue.clone());
        telemetry.push(ServerEvent::new(
            "preview.frameReady",
            json!({
                "sceneRevision": 10,
                "frameSceneRevision": 9,
                "framesRendered": 1,
            }),
        ));
        telemetry.push(ServerEvent::new(
            "preview.frameReady",
            json!({
                "sceneRevision": 12,
                "frameSceneRevision": 11,
                "framesRendered": 2,
            }),
        ));
        telemetry.push(ServerEvent::new(
            "diagnostics.stats",
            json!({ "sample": 1 }),
        ));

        assert_eq!(telemetry.stats(), (2, 1, 0));
        let queue = transport.snapshot().coalesced_telemetry_queue;
        assert_eq!(queue.current_depth, 2);
        assert_eq!(queue.max_depth, 2);
        assert_eq!(queue.coalesced_count, 1);
        assert_eq!(queue.evicted_or_dropped_count, 0);
        assert!(queue.oldest_age_ms.is_some());
        let frame_ready = telemetry.recv().await;
        assert_eq!(frame_ready.event, "preview.frameReady");
        assert_eq!(frame_ready.payload["sceneRevision"], 12);
        assert_eq!(frame_ready.payload["frameSceneRevision"], 11);
        assert_eq!(frame_ready.payload["framesRendered"], 2);

        telemetry.push(ServerEvent::new(
            "preview.surface.status",
            json!({ "frame": 3 }),
        ));
        telemetry.push(ServerEvent::new(
            "recording.status",
            json!({ "state": "live" }),
        ));
        let (depth, _, evicted) = telemetry.stats();
        assert_eq!(depth, 2);
        assert_eq!(evicted, 1);
        let queue = transport.snapshot().coalesced_telemetry_queue;
        assert_eq!(queue.current_depth, 2);
        assert_eq!(queue.max_depth, 2);
        assert_eq!(queue.coalesced_count, 1);
        assert_eq!(queue.evicted_or_dropped_count, 1);
    }

    #[tokio::test]
    async fn websocket_writer_services_latest_frame_ready_during_sustained_reliable_traffic() {
        let transport = WebSocketTransportMetrics::default();
        let connection = transport.register_connection();
        let reliable_metrics = connection.reliable_response_queue;
        let (reliable_tx, mut reliable_rx) = mpsc::channel(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
        for sequence in 0..(WEBSOCKET_RELIABLE_BURST_LIMIT + 4) {
            assert!(
                send_tracked_websocket_item(
                    &reliable_tx,
                    &reliable_metrics,
                    Message::Text(format!("reliable-{sequence}").into()),
                )
                .await
            );
        }

        let telemetry = CoalescingEventBuffer::new(WEBSOCKET_TELEMETRY_KIND_CAPACITY);
        telemetry.push(ServerEvent::new(
            "preview.frameReady",
            json!({
                "sceneRevision": 20,
                "frameSceneRevision": 19,
                "framesRendered": 100,
            }),
        ));
        telemetry.push(ServerEvent::new(
            "preview.frameReady",
            json!({
                "sceneRevision": 22,
                "frameSceneRevision": 21,
                "framesRendered": 101,
            }),
        ));

        let mut schedule = WebSocketWriterSchedule::default();
        for sequence in 0..WEBSOCKET_RELIABLE_BURST_LIMIT {
            let message = next_websocket_writer_message(
                &mut schedule,
                &mut reliable_rx,
                &reliable_metrics,
                &telemetry,
            )
            .await;
            let Message::Text(text) = message else {
                panic!("expected reliable text message");
            };
            assert_eq!(text.as_str(), format!("reliable-{sequence}"));
        }

        let message = next_websocket_writer_message(
            &mut schedule,
            &mut reliable_rx,
            &reliable_metrics,
            &telemetry,
        )
        .await;
        let Message::Text(text) = message else {
            panic!("expected serialized frame-ready event");
        };
        let event: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
        assert_eq!(event["event"], "preview.frameReady");
        assert_eq!(event["payload"]["sceneRevision"], 22);
        assert_eq!(event["payload"]["frameSceneRevision"], 21);
        assert_eq!(event["payload"]["framesRendered"], 101);
        assert!(
            reliable_rx.len() > 0,
            "telemetry must be serviced while reliable traffic remains queued"
        );
        let queue = transport.snapshot().reliable_response_queue;
        assert_eq!(queue.current_depth, 4);
        assert_eq!(queue.max_depth, 12);
        assert!(queue.oldest_age_ms.is_some());
        assert_eq!(queue.coalesced_count, 0);
        assert_eq!(queue.evicted_or_dropped_count, 0);
    }

    #[tokio::test]
    async fn websocket_reliable_queue_age_disconnects_and_releases_blocked_producer() {
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let connection = transport.register_connection();
        let reliable_metrics = connection.reliable_response_queue;
        let (reliable_tx, reliable_rx) = mpsc::channel(1);
        assert!(
            send_tracked_websocket_item(
                &reliable_tx,
                &reliable_metrics,
                Message::Text("queued".into()),
            )
            .await
        );
        let observer_metrics = reliable_metrics.clone();

        let (pressure_tx, mut pressure_rx) = mpsc::channel(1);
        let pressure = WebSocketSlowPressureSignal::new(pressure_tx, transport.clone());
        let watchdog = tokio::spawn(run_websocket_reliable_pressure_watchdog_with_limit(
            reliable_metrics.clone(),
            pressure.clone(),
            Duration::ZERO,
        ));
        let blocked_producer = tokio::spawn(async move {
            send_tracked_reliable_websocket_item_with_limit(
                &reliable_tx,
                &reliable_metrics,
                Message::Text("must-not-be-silently-dropped".into()),
                &pressure,
                Duration::ZERO,
            )
            .await
        });

        timeout(Duration::from_secs(1), pressure_rx.recv())
            .await
            .expect("reliable oldest-age pressure should disconnect the peer")
            .expect("pressure signal should remain open");
        assert!(
            !timeout(Duration::from_secs(1), blocked_producer)
                .await
                .expect("blocked producer should be released at the pressure deadline")
                .expect("blocked producer task should not panic")
        );
        watchdog.await.expect("pressure watchdog should not panic");

        let snapshot = transport.snapshot();
        assert_eq!(snapshot.slow_pressure_disconnect_count, 1);
        assert_eq!(
            snapshot.reliable_response_queue.evicted_or_dropped_count, 1,
            "the reliable item rejected at disconnect must be counted"
        );
        assert_eq!(snapshot.reliable_response_queue.current_depth, 1);

        drop(reliable_rx);
        drop(observer_metrics);
        let snapshot = transport.snapshot();
        assert_eq!(snapshot.reliable_response_queue.current_depth, 0);
        assert_eq!(
            snapshot.reliable_response_queue.evicted_or_dropped_count, 2,
            "the queued reliable item discarded by connection teardown must also be counted"
        );
    }

    #[test]
    fn websocket_only_coalesces_state_snapshots_not_ordered_events() {
        assert!(websocket_event_is_coalescible("preview.frameReady"));
        assert!(websocket_event_is_coalescible("compositor.status"));
        assert!(websocket_event_is_coalescible("preview.surface.status"));
        assert!(!websocket_event_is_coalescible("liveChat.message"));
        assert!(!websocket_event_is_coalescible("liveChat.snapshot"));
        assert!(!websocket_event_is_coalescible("liveChat.providerStatus"));
        assert!(!websocket_event_is_coalescible("recording.status"));
        assert!(!websocket_event_is_coalescible("screens.changed"));
        assert!(!websocket_event_is_coalescible("session.log"));
        assert!(!websocket_event_is_coalescible(
            "platformAccounts.oauth.callback"
        ));
    }

    #[tokio::test]
    async fn websocket_read_only_queries_answer_while_a_stateful_command_is_in_flight() {
        // The 0.9.44 owner incident: session.stop (which awaits the MP4
        // export inline) starved preview.surface.status behind the serial
        // dispatcher until the renderer's 5s budget expired. Read-only
        // queries must overlap stateful commands.
        let handler: WebSocketCommandHandler = std::sync::Arc::new(move |_state, text| {
            Box::pin(async move {
                let command: serde_json::Value = serde_json::from_str(&text).unwrap();
                if command["method"] == "session.stop" {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                ServerResponse::ok(command["id"].as_str().unwrap(), json!({}))
            })
        });
        let (command_tx, command_rx) = mpsc::channel(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let connection = transport.register_connection();
        let command_metrics = connection.incoming_command_queue;
        let reliable_metrics = connection.reliable_response_queue;
        let (pressure_tx, _pressure_rx) = mpsc::channel(1);
        let slow_pressure = WebSocketSlowPressureSignal::new(pressure_tx, transport.clone());
        let dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            test_state(),
            command_rx,
            command_metrics.clone(),
            outgoing_tx,
            reliable_metrics.clone(),
            slow_pressure,
            handler,
        ));

        assert!(
            send_tracked_websocket_item(
                &command_tx,
                &command_metrics,
                json!({ "id": "stop", "method": "session.stop", "params": {} }).to_string(),
            )
            .await
        );
        for index in 0..3 {
            assert!(
                send_tracked_websocket_item(
                    &command_tx,
                    &command_metrics,
                    json!({
                        "id": format!("status-{index}"),
                        "method": "preview.surface.status",
                        "params": {}
                    })
                    .to_string(),
                )
                .await
            );
        }
        drop(command_tx);
        dispatcher.await.unwrap();

        let mut response_order = Vec::new();
        while let Some(Message::Text(text)) = outgoing_rx.recv().await {
            reliable_metrics.record_dequeue_oldest();
            let response: serde_json::Value = serde_json::from_str(&text).unwrap();
            response_order.push(response["id"].as_str().unwrap().to_string());
        }
        assert_eq!(response_order.len(), 4);
        // Every status query answered BEFORE the slow stateful command.
        assert_eq!(
            response_order.last().map(String::as_str),
            Some("stop"),
            "read-only queries must not queue behind session.stop: {response_order:?}"
        );
    }

    #[tokio::test]
    async fn websocket_layout_flood_has_bounded_work_and_returns_every_response() {
        let active = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let max_active = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handler: WebSocketCommandHandler = {
            let active = active.clone();
            let max_active = max_active.clone();
            std::sync::Arc::new(move |_state, text| {
                let active = active.clone();
                let max_active = max_active.clone();
                Box::pin(async move {
                    let command: serde_json::Value = serde_json::from_str(&text).unwrap();
                    let now_active = active.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
                    max_active.fetch_max(now_active, std::sync::atomic::Ordering::AcqRel);
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    active.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                    ServerResponse::ok(command["id"].as_str().unwrap(), json!({}))
                })
            })
        };
        let (command_tx, command_rx) = mpsc::channel(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let connection = transport.register_connection();
        let command_metrics = connection.incoming_command_queue;
        let reliable_metrics = connection.reliable_response_queue;
        let (pressure_tx, _pressure_rx) = mpsc::channel(1);
        let slow_pressure = WebSocketSlowPressureSignal::new(pressure_tx, transport.clone());
        let dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            test_state(),
            command_rx,
            command_metrics.clone(),
            outgoing_tx,
            reliable_metrics.clone(),
            slow_pressure,
            handler,
        ));

        for index in 0..100 {
            assert!(
                send_tracked_websocket_item(
                    &command_tx,
                    &command_metrics,
                    json!({
                        "id": format!("layout-{index}"),
                        "method": "scene.layout.apply_preview",
                        "params": { "intentId": index + 1 }
                    })
                    .to_string(),
                )
                .await
            );
        }
        drop(command_tx);
        dispatcher.await.unwrap();

        let mut response_ids = std::collections::HashSet::new();
        while let Some(Message::Text(text)) = outgoing_rx.recv().await {
            reliable_metrics.record_dequeue_oldest();
            let response: serde_json::Value = serde_json::from_str(&text).unwrap();
            response_ids.insert(response["id"].as_str().unwrap().to_string());
        }
        assert_eq!(response_ids.len(), 100);
        assert!(
            max_active.load(std::sync::atomic::Ordering::Acquire) <= WEBSOCKET_LAYOUT_CONCURRENCY
        );
        let snapshot = transport.snapshot();
        assert_eq!(snapshot.incoming_command_queue.current_depth, 0);
        assert!(snapshot.incoming_command_queue.max_depth > 0);
        assert_eq!(snapshot.incoming_command_queue.oldest_age_ms, None);
        assert_eq!(snapshot.reliable_response_queue.current_depth, 0);
        assert!(snapshot.reliable_response_queue.max_depth > 0);
        assert_eq!(snapshot.reliable_response_queue.oldest_age_ms, None);
    }

    #[tokio::test]
    async fn websocket_event_relay_bounds_slow_clients_and_reports_backpressure_lag() {
        let (events_tx, events_rx) = broadcast::channel(2);
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(1);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let connection = transport.register_connection();
        let reliable_metrics = connection.reliable_response_queue;
        let telemetry = CoalescingEventBuffer::with_metrics(
            WEBSOCKET_TELEMETRY_KIND_CAPACITY,
            connection.coalesced_telemetry_queue,
        );
        let (pressure_tx, _pressure_rx) = mpsc::channel(1);
        let slow_pressure = WebSocketSlowPressureSignal::new(pressure_tx, transport);
        let event_filter = std::sync::Arc::new(std::sync::Mutex::new(ConnectionEventFilter {
            excluded: std::collections::HashSet::from(["events.lagged".to_string()]),
            included: None,
        }));
        let relay = tokio::spawn(relay_websocket_events(
            events_rx,
            outgoing_tx,
            reliable_metrics.clone(),
            slow_pressure,
            telemetry,
            event_filter,
            false,
        ));

        events_tx
            .send(ServerEvent::new("test.burst", json!({ "sequence": 0 })))
            .unwrap();
        timeout(Duration::from_secs(1), async {
            while outgoing_rx.len() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first event did not fill bounded outbound queue");

        // The relay takes sequence 1 from the broadcast ring, then blocks on the full
        // one-slot outbound queue. This is real outbound backpressure, not scheduler lag.
        events_tx
            .send(ServerEvent::new("test.burst", json!({ "sequence": 1 })))
            .unwrap();
        timeout(Duration::from_secs(1), async {
            while events_tx.len() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("relay did not block on the full outbound queue");

        for sequence in 2..64 {
            events_tx
                .send(ServerEvent::new(
                    "test.burst",
                    json!({ "sequence": sequence }),
                ))
                .unwrap();
        }
        assert_eq!(outgoing_rx.len(), 1, "outbound queue exceeded its bound");

        let first = receive_tracked_json(&mut outgoing_rx, &reliable_metrics).await;
        assert_eq!(first["payload"]["sequence"], 0);
        let second = receive_tracked_json(&mut outgoing_rx, &reliable_metrics).await;
        assert_eq!(second["payload"]["sequence"], 1);

        let lagged = timeout(
            Duration::from_secs(1),
            receive_tracked_json(&mut outgoing_rx, &reliable_metrics),
        )
        .await
        .expect("events.lagged timeout");
        assert_eq!(lagged["event"], "events.lagged");
        assert!(lagged["payload"]["skipped"].as_u64().unwrap() > 0);
        assert!(
            chrono::DateTime::parse_from_rfc3339(lagged["payload"]["occurredAt"].as_str().unwrap())
                .is_ok()
        );

        // The two newest broadcast events survive the ring overrun. Once consumed, the
        // same bounded relay remains live and carries subsequent incremental events.
        for expected in [62, 63] {
            let event = receive_tracked_json(&mut outgoing_rx, &reliable_metrics).await;
            assert_eq!(event["payload"]["sequence"], expected);
        }
        events_tx
            .send(ServerEvent::new("test.afterLag", json!({ "alive": true })))
            .unwrap();
        let after_lag = timeout(
            Duration::from_secs(1),
            receive_tracked_json(&mut outgoing_rx, &reliable_metrics),
        )
        .await
        .expect("post-lag event timeout");
        assert_eq!(after_lag["event"], "test.afterLag");
        assert_eq!(after_lag["payload"]["alive"], true);

        drop(events_tx);
        relay.await.unwrap();
    }

    #[tokio::test]
    async fn websocket_event_relay_reports_lag_stays_open_and_serves_a_fresh_snapshot() {
        let (events, _) = broadcast::channel(2);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = AppState::new(
            "test-token".to_string(),
            address.port(),
            events,
            Database::open_in_memory_for_tests(),
        );

        // Seed authoritative chat state before the socket subscribes. The lagged client must
        // be able to replace its incremental belief with this full snapshot afterward.
        let params = serde_json::from_value(json!({
            "sessionId": "lag-recovery-session",
            "fake": {
                "platform": "youtube",
                "count": 1,
                "intervalMs": 0,
                "includeDuplicate": false
            }
        }))
        .unwrap();
        live_chat::start_live_chat(&state, params).await;
        timeout(Duration::from_secs(2), async {
            loop {
                if live_chat::current_status(&state).await.messages.len() == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fake chat message");

        let app = Router::new()
            .route("/ws", get(ws_handler))
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let (mut socket, _) =
            tokio_tungstenite::connect_async(format!("ws://{address}/ws?token=test-token"))
                .await
                .unwrap();

        let ready = timeout(Duration::from_secs(2), socket.next())
            .await
            .expect("backend.ready timeout")
            .expect("backend.ready frame")
            .expect("backend.ready websocket result");
        let ready: serde_json::Value = serde_json::from_str(ready.to_text().unwrap()).unwrap();
        assert_eq!(ready["event"], "backend.ready");

        // A current-thread Tokio test cannot schedule the relay while this tight loop fills
        // its two-slot receiver, making the lag deterministic rather than timing-sensitive.
        for sequence in 0..64 {
            state.emit_event("test.burst", json!({ "sequence": sequence }));
        }

        let lagged = timeout(Duration::from_secs(2), async {
            loop {
                let frame = socket
                    .next()
                    .await
                    .expect("lag recovery frame")
                    .expect("lag recovery websocket result");
                if !frame.is_text() {
                    continue;
                }
                let value: serde_json::Value =
                    serde_json::from_str(frame.to_text().unwrap()).unwrap();
                if value["event"] == "events.lagged" {
                    break value;
                }
            }
        })
        .await
        .expect("events.lagged timeout");
        assert!(lagged["payload"]["skipped"].as_u64().unwrap() > 0);
        assert!(
            chrono::DateTime::parse_from_rfc3339(lagged["payload"]["occurredAt"].as_str().unwrap())
                .is_ok()
        );

        state.emit_event("test.afterLag", json!({ "alive": true }));
        timeout(Duration::from_secs(2), async {
            loop {
                let frame = socket
                    .next()
                    .await
                    .expect("post-lag frame")
                    .expect("post-lag websocket result");
                if !frame.is_text() {
                    continue;
                }
                let value: serde_json::Value =
                    serde_json::from_str(frame.to_text().unwrap()).unwrap();
                if value["event"] == "test.afterLag" {
                    assert!(value["payload"]["alive"].as_bool().unwrap());
                    break;
                }
            }
        })
        .await
        .expect("relay stopped after lag");

        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "id": "status-after-lag",
                    "method": "liveChat.status",
                    "params": {}
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let snapshot = timeout(Duration::from_secs(2), async {
            loop {
                let frame = socket
                    .next()
                    .await
                    .expect("status frame")
                    .expect("status websocket result");
                if !frame.is_text() {
                    continue;
                }
                let value: serde_json::Value =
                    serde_json::from_str(frame.to_text().unwrap()).unwrap();
                if value["id"] == "status-after-lag" {
                    break value;
                }
            }
        })
        .await
        .expect("fresh liveChat.status timeout");
        assert!(snapshot["ok"].as_bool().unwrap());
        assert_eq!(snapshot["payload"]["sessionId"], "lag-recovery-session");
        assert_eq!(snapshot["payload"]["messages"].as_array().unwrap().len(), 1);

        socket.close(None).await.unwrap();
        server.abort();
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

    #[tokio::test]
    async fn renderer_support_bundle_export_rejects_a_raw_output_directory() {
        let state = test_state();
        let response = handle_text_message_with_role(
            &state,
            &serde_json::json!({
                "id": "support-bundle-raw-path",
                "method": "diagnostics.supportBundle.export",
                "params": { "outputDirectory": "/tmp/renderer-chosen-output" }
            })
            .to_string(),
            BackendRole::Renderer,
        )
        .await;

        assert!(!response.ok);
        let error = response.error.expect("renderer raw path rejection");
        assert_eq!(error.code, "resource-capability-rejected");
        assert!(
            error
                .message
                .contains("raw outputDirectory is not accepted")
        );
    }

    #[tokio::test]
    async fn recording_status_stays_stopping_for_the_authoritative_finalization_lease() {
        let state = test_state();
        let finalizing = state.ffmpeg_work.begin_finalizing();

        let status = current_recording_status(&state).await;
        assert!(matches!(status.state, RecordingState::Stopping));
        assert_eq!(
            status.message.as_deref(),
            Some("Finalizing recording output.")
        );

        drop(finalizing);
        assert!(matches!(
            current_recording_status(&state).await.state,
            RecordingState::Idle
        ));
    }

    #[tokio::test]
    async fn live_audio_processing_update_requires_an_active_matching_session() {
        let state = test_state();
        let response = handle_text_message(
            &state,
            r#"{"id":"audio-live","method":"audio.processing.update","params":{"sessionId":"ended-session","microphoneGainDb":6,"microphoneMuted":true}}"#,
        )
        .await;

        assert!(response.ok);
        let payload = response.payload.expect("audio processing payload");
        assert_eq!(payload["applied"], false);
        assert_eq!(payload["sessionId"], "ended-session");
        assert_eq!(payload["microphoneGainDb"], 6.0);
        assert_eq!(payload["microphoneMuted"], true);
        assert_eq!(payload["reasonCode"], "no-active-session");
    }

    #[tokio::test]
    async fn account_sign_out_stops_active_captions_before_credentials_are_cleared() {
        let _caption_test_guard = CAPTION_LIFECYCLE_TEST_LOCK.lock().await;
        let state = test_state();
        let probe = captions::install_caption_sign_out_test_session(&state).await;
        let mut events = state.events.subscribe();
        let frame = audio::AudioFrame {
            timestamp_micros: 0,
            captured_at: std::time::Instant::now(),
            sample_rate: 48_000,
            channels: 1,
            samples: vec![0.1; 960],
        };

        captions::offer_caption_frame(&frame);
        timeout(Duration::from_secs(1), async {
            while probe.frames_received() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("active caption task should consume the microphone tap");
        let received_before_sign_out = probe.frames_received();

        let credentials_cleared = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let clear_signal = credentials_cleared.clone();
        clear_account_credentials_after_caption_shutdown(&state, || {
            assert!(
                probe.task_finished(),
                "caption task must be joined before credential removal"
            );
            clear_signal.store(true, std::sync::atomic::Ordering::Release);
        })
        .await;
        assert!(credentials_cleared.load(std::sync::atomic::Ordering::Acquire));

        captions::offer_caption_frame(&audio::AudioFrame {
            timestamp_micros: 20_000,
            ..frame
        });
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert_eq!(
            probe.frames_received(),
            received_before_sign_out,
            "signed-out captions must not continue consuming microphone audio"
        );

        assert_eq!(
            captions::caption_sign_out_test_snapshot(&state).await,
            captions::CaptionSignOutTestSnapshot {
                task_present: false,
                stop_present: false,
                desired_enabled: false,
                language_present: false,
                chunk_count: 0,
                finalized_style_present: false,
                tap_active: false,
                primary_overlay_active: false,
                auxiliary_overlay_active: false,
            }
        );
        assert_eq!(
            captions::captions_status(&state).await.state,
            captions::CaptionsState::Idle
        );

        let mut saw_idle = false;
        let mut saw_cleared = false;
        while let Ok(event) = events.try_recv() {
            saw_idle |= event.event == "captions.status" && event.payload["state"] == "idle";
            saw_cleared |= event.event == "captions.cleared";
        }
        assert!(saw_idle, "renderer must receive the signed-out idle state");
        assert!(
            saw_cleared,
            "renderer must receive a transcript reset event"
        );
    }

    #[tokio::test]
    async fn backend_shutdown_joins_active_captions_and_removes_the_audio_tap() {
        let _caption_test_guard = CAPTION_LIFECYCLE_TEST_LOCK.lock().await;
        let state = test_state();
        let probe = captions::install_caption_sign_out_test_session(&state).await;
        let frame = audio::AudioFrame {
            timestamp_micros: 0,
            captured_at: std::time::Instant::now(),
            sample_rate: 48_000,
            channels: 1,
            samples: vec![0.1; 960],
        };

        captions::offer_caption_frame(&frame);
        timeout(Duration::from_secs(1), async {
            while probe.frames_received() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("active caption task should consume the microphone tap");
        let received_before_shutdown = probe.frames_received();

        captions::shutdown_caption_runtime(&state).await;
        assert!(
            probe.task_finished(),
            "backend shutdown must join the provider task before capture teardown"
        );
        captions::offer_caption_frame(&audio::AudioFrame {
            timestamp_micros: 20_000,
            ..frame
        });
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert_eq!(
            probe.frames_received(),
            received_before_shutdown,
            "backend shutdown must disconnect the microphone tap"
        );

        assert_eq!(
            captions::caption_sign_out_test_snapshot(&state).await,
            captions::CaptionSignOutTestSnapshot {
                task_present: false,
                stop_present: false,
                desired_enabled: true,
                language_present: true,
                chunk_count: 1,
                finalized_style_present: true,
                tap_active: false,
                primary_overlay_active: false,
                auxiliary_overlay_active: false,
            },
            "runtime shutdown preserves preferences and artifact cues until the artifact teardown"
        );

        captions::shutdown_caption_artifacts(&state).await;
        let cleaned = captions::caption_sign_out_test_snapshot(&state).await;
        assert_eq!(cleaned.chunk_count, 0);
        assert!(!cleaned.finalized_style_present);
    }

    #[tokio::test]
    async fn caption_stop_and_block_clear_backend_overlays_and_reset_renderer() {
        let _caption_test_guard = CAPTION_LIFECYCLE_TEST_LOCK.lock().await;
        let state = test_state();

        let _stop_probe = captions::install_caption_sign_out_test_session(&state).await;
        let mut stop_events = state.events.subscribe();
        let stopped = captions::stop_captions(&state).await;
        assert_eq!(stopped.state, captions::CaptionsState::Idle);
        let stopped_snapshot = captions::caption_sign_out_test_snapshot(&state).await;
        assert!(!stopped_snapshot.primary_overlay_active);
        assert!(!stopped_snapshot.auxiliary_overlay_active);
        assert_eq!(
            stopped_snapshot.chunk_count, 1,
            "ordinary stop preserves already-spoken cues for the recording artifact"
        );
        assert!(event_stream_contains_caption_reset(
            &mut stop_events,
            "stopped"
        ));

        let _block_probe = captions::install_caption_sign_out_test_session(&state).await;
        let mut block_events = state.events.subscribe();
        captions::block_captions(&state, "audio-path-unsupported", "No supported mic path").await;
        let blocked = captions::captions_status(&state).await;
        assert_eq!(blocked.state, captions::CaptionsState::Blocked);
        assert_eq!(
            blocked.reason_code.as_deref(),
            Some("audio-path-unsupported")
        );
        let blocked_snapshot = captions::caption_sign_out_test_snapshot(&state).await;
        assert!(!blocked_snapshot.primary_overlay_active);
        assert!(!blocked_snapshot.auxiliary_overlay_active);
        assert!(event_stream_contains_caption_reset(
            &mut block_events,
            "blocked"
        ));
    }

    #[tokio::test]
    async fn explicit_caption_opt_out_discards_audio_already_queued_for_transcription() {
        let _caption_test_guard = CAPTION_LIFECYCLE_TEST_LOCK.lock().await;
        let state = test_state();
        let probe = captions::install_caption_queued_audio_test_session(&state).await;
        timeout(Duration::from_secs(1), async {
            while !probe.task_started() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("caption test consumer should start");

        for timestamp_micros in [0, 20_000, 40_000] {
            captions::offer_caption_frame(&audio::AudioFrame {
                timestamp_micros,
                captured_at: std::time::Instant::now(),
                sample_rate: 48_000,
                channels: 1,
                samples: vec![0.1; 960],
            });
        }

        let stop_state = state.clone();
        let stopped = tokio::spawn(async move { captions::stop_captions(&stop_state).await });
        timeout(Duration::from_secs(1), async {
            while !captions::caption_task_detached_for_test(&state).await {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("stop should take ownership of the caption task");
        probe.release();

        assert_eq!(
            stopped.await.expect("stop task joins").state,
            captions::CaptionsState::Idle
        );
        assert_eq!(
            probe.frames_received(),
            0,
            "privacy opt-out must discard queued PCM instead of transcribing it"
        );
    }

    #[tokio::test]
    async fn terminal_caption_failure_clears_backend_overlays_and_resets_renderer() {
        let _caption_test_guard = CAPTION_LIFECYCLE_TEST_LOCK.lock().await;
        let state = test_state();
        let _probe = captions::install_caption_sign_out_test_session(&state).await;
        let mut events = state.events.subscribe();

        captions::publish_terminal_caption_failure_for_test(&state).await;

        let snapshot = captions::caption_sign_out_test_snapshot(&state).await;
        assert!(!snapshot.primary_overlay_active);
        assert!(!snapshot.auxiliary_overlay_active);
        assert!(event_stream_contains_caption_reset(&mut events, "blocked"));
    }

    #[tokio::test]
    async fn capture_end_resets_live_caption_presentation_but_retains_artifact_cues() {
        let _caption_test_guard = CAPTION_LIFECYCLE_TEST_LOCK.lock().await;
        let state = test_state();
        let _probe = captions::install_caption_sign_out_test_session(&state).await;
        let mut events = state.events.subscribe();

        let status = captions::finish_captions_for_capture(&state).await;

        assert_eq!(status.state, captions::CaptionsState::Ready);
        let snapshot = captions::caption_sign_out_test_snapshot(&state).await;
        assert_eq!(
            snapshot.chunk_count, 1,
            "capture finalization must retain canonical cues for SRT/captioned-copy generation"
        );
        assert!(!snapshot.primary_overlay_active);
        assert!(!snapshot.auxiliary_overlay_active);
        assert!(event_stream_contains_caption_reset(
            &mut events,
            "capture-ended"
        ));
    }

    fn event_stream_contains_caption_reset(
        events: &mut broadcast::Receiver<protocol::ServerEvent>,
        reason: &str,
    ) -> bool {
        while let Ok(event) = events.try_recv() {
            if event.event == "captions.cleared" && event.payload["reason"] == reason {
                return true;
            }
        }
        false
    }

    // The publish workflow must reuse a live-captions transcript: Transcript
    // Ready from the .srt, no audio extraction, no consent needed — the exact
    // fix for "Title & description just downloads sound" (2026-07-11).
    #[tokio::test]
    async fn publish_workflow_reuses_live_captions_transcript_without_consent() {
        let state = test_state();
        let dir = std::env::temp_dir().join(format!("videorc-ai-srt-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let recording = dir.join("session-a.mp4");
        std::fs::write(&recording, b"stub-video").unwrap();
        std::fs::write(
            dir.join("session-a.srt"),
            "1\n00:00:01,000 --> 00:00:02,000\nhello from captions\n\n",
        )
        .unwrap();
        state
            .database
            .create_session(&crate::storage::NewSession {
                id: "session-a".to_string(),
                title: "Captions session".to_string(),
                started_at: "2026-07-11T00:00:00Z".to_string(),
                mode: "record".to_string(),
                output_path: Some(recording.display().to_string()),
                container: None,
                stream_preset: None,
                sources: serde_json::from_str("{}").unwrap(),
                layout: protocol::default_layout_settings(),
                output: serde_json::from_value(serde_json::json!({
                    "recordEnabled": true,
                    "streamEnabled": false,
                    "video": {
                        "preset": "tutorial-1080p30",
                        "width": 1920,
                        "height": 1080,
                        "fps": 30,
                        "bitrateKbps": 6000
                    },
                    "rtmp": { "preset": "custom", "serverUrl": "", "streamKey": "" }
                }))
                .unwrap(),
            })
            .unwrap();

        let result = ai::run_ai_workflow(
            state.clone(),
            protocol::RunAiWorkflowParams {
                session_id: "session-a".to_string(),
                consent_to_upload_audio: false,
                ffmpeg_path: None,
                outputs: None,
                tone: None,
            },
        )
        .await
        .unwrap();

        assert!(
            result.audio_path.is_empty(),
            "captions transcript must skip audio extraction"
        );
        let artifacts = state.database.list_ai_artifacts("session-a").unwrap();
        assert!(
            artifacts
                .iter()
                .all(|artifact| artifact.kind != protocol::AiArtifactKind::AudioExtract)
        );
        let transcript = artifacts
            .iter()
            .find(|artifact| artifact.kind == protocol::AiArtifactKind::Transcript)
            .expect("transcript artifact");
        assert_eq!(transcript.status, protocol::AiArtifactStatus::Ready);
        assert_eq!(
            transcript.content.get("source").and_then(|v| v.as_str()),
            Some("live-captions")
        );
        assert!(
            transcript
                .content
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .contains("hello from captions")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[derive(Clone)]
    struct TestWebSocketState {
        app: AppState,
        command_handler: WebSocketCommandHandler,
        session_finished: std::sync::Arc<tokio::sync::Semaphore>,
    }

    async fn test_ws_handler(
        State(state): State<TestWebSocketState>,
        Query(query): Query<WsQuery>,
        ws: WebSocketUpgrade,
    ) -> impl IntoResponse {
        if query.token != state.app.token {
            return StatusCode::UNAUTHORIZED.into_response();
        }

        ws.on_upgrade(move |socket| async move {
            websocket_session_with_handler(socket, state.app, state.command_handler).await;
            state.session_finished.add_permits(1);
        })
        .into_response()
    }

    async fn connect_test_websocket(
        command_handler: WebSocketCommandHandler,
    ) -> (
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        tokio::task::JoinHandle<()>,
        std::sync::Arc<tokio::sync::Semaphore>,
    ) {
        let state = test_state();
        let token = state.token.clone();
        let session_finished = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let server_session_finished = session_finished.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                Router::new()
                    .route("/ws", get(test_ws_handler))
                    .with_state(TestWebSocketState {
                        app: state,
                        command_handler,
                        session_finished: server_session_finished,
                    }),
            )
            .await;
        });
        let (socket, _) =
            tokio_tungstenite::connect_async(format!("ws://{address}/ws?token={token}"))
                .await
                .unwrap();
        (socket, server, session_finished)
    }

    #[tokio::test]
    async fn websocket_non_layout_start_then_stop_remains_fifo() {
        let order = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<&'static str>::new()));
        let start_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let stop_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_start = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let handler: WebSocketCommandHandler = {
            let order = order.clone();
            let start_entered = start_entered.clone();
            let stop_entered = stop_entered.clone();
            let release_start = release_start.clone();
            std::sync::Arc::new(move |_state, text| {
                let order = order.clone();
                let start_entered = start_entered.clone();
                let stop_entered = stop_entered.clone();
                let release_start = release_start.clone();
                Box::pin(async move {
                    let command: serde_json::Value = serde_json::from_str(&text).unwrap();
                    let id = command["id"].as_str().unwrap().to_string();
                    match command["method"].as_str().unwrap() {
                        "test.mutation.start" => {
                            start_entered.add_permits(1);
                            release_start.acquire().await.unwrap().forget();
                            order.lock().await.push("start");
                        }
                        "test.mutation.stop" => {
                            stop_entered.add_permits(1);
                            order.lock().await.push("stop");
                        }
                        method => panic!("unexpected test command: {method}"),
                    }
                    ServerResponse::ok(id, json!({}))
                })
            })
        };
        let (mut socket, server, _) = connect_test_websocket(handler).await;

        for (id, method) in [
            ("start", "test.mutation.start"),
            ("stop", "test.mutation.stop"),
        ] {
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    json!({ "id": id, "method": method, "params": {} })
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        }

        timeout(Duration::from_secs(1), start_entered.acquire())
            .await
            .expect("start command should be accepted")
            .unwrap()
            .forget();
        assert!(
            timeout(Duration::from_millis(100), stop_entered.acquire())
                .await
                .is_err(),
            "stop must not overtake an accepted non-layout start"
        );

        release_start.add_permits(1);
        timeout(Duration::from_secs(1), stop_entered.acquire())
            .await
            .expect("stop should run after start completes")
            .unwrap()
            .forget();
        assert_eq!(*order.lock().await, ["start", "stop"]);

        let _ = socket.close(None).await;
        server.abort();
    }

    #[tokio::test]
    async fn websocket_session_stop_bypasses_bounded_live_audio_acknowledgement() {
        let order = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<&'static str>::new()));
        let audio_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let stop_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_audio = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let handler: WebSocketCommandHandler = {
            let order = order.clone();
            let audio_entered = audio_entered.clone();
            let stop_entered = stop_entered.clone();
            let release_audio = release_audio.clone();
            std::sync::Arc::new(move |_state, text| {
                let order = order.clone();
                let audio_entered = audio_entered.clone();
                let stop_entered = stop_entered.clone();
                let release_audio = release_audio.clone();
                Box::pin(async move {
                    let command: serde_json::Value = serde_json::from_str(&text).unwrap();
                    let id = command["id"].as_str().unwrap().to_string();
                    match command["method"].as_str().unwrap() {
                        "audio.processing.update" => {
                            audio_entered.add_permits(1);
                            release_audio.acquire().await.unwrap().forget();
                            order.lock().await.push("audio-ack");
                        }
                        "session.stop" => {
                            stop_entered.add_permits(1);
                            order.lock().await.push("stop");
                        }
                        method => panic!("unexpected test command: {method}"),
                    }
                    ServerResponse::ok(id, json!({}))
                })
            })
        };
        let (mut socket, server, _) = connect_test_websocket(handler).await;

        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "id": "audio-first",
                    "method": "audio.processing.update",
                    "params": {}
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        timeout(Duration::from_secs(1), audio_entered.acquire())
            .await
            .expect("first audio update should run off the dispatcher")
            .unwrap()
            .forget();

        for (id, method) in [
            ("audio-excess", "audio.processing.update"),
            ("stop", "session.stop"),
        ] {
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    json!({ "id": id, "method": method, "params": {} })
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        }

        timeout(Duration::from_secs(1), stop_entered.acquire())
            .await
            .expect("session.stop must dispatch before the delayed audio acknowledgement")
            .unwrap()
            .forget();
        assert_eq!(*order.lock().await, ["stop"]);

        let early_responses = timeout(Duration::from_secs(1), async {
            let mut responses = std::collections::HashMap::new();
            while responses.len() < 2 {
                let message = socket.next().await.unwrap().unwrap();
                let tokio_tungstenite::tungstenite::Message::Text(text) = message else {
                    continue;
                };
                let response: serde_json::Value = serde_json::from_str(&text).unwrap();
                if let Some(id) = response["id"].as_str() {
                    responses.insert(id.to_string(), response);
                }
            }
            responses
        })
        .await
        .expect("busy and stop responses must not wait for the audio acknowledgement");
        assert_eq!(early_responses["audio-excess"]["ok"], false);
        assert_eq!(
            early_responses["audio-excess"]["error"]["code"],
            "audio-processing-busy"
        );
        assert_eq!(early_responses["stop"]["ok"], true);

        release_audio.add_permits(1);
        let audio_response = timeout(Duration::from_secs(1), async {
            loop {
                let message = socket.next().await.unwrap().unwrap();
                let tokio_tungstenite::tungstenite::Message::Text(text) = message else {
                    continue;
                };
                let response: serde_json::Value = serde_json::from_str(&text).unwrap();
                if response["id"] == "audio-first" {
                    break response;
                }
            }
        })
        .await
        .expect("the accepted audio update still owes its response after stop");
        assert_eq!(audio_response["ok"], true);
        assert_eq!(*order.lock().await, ["stop", "audio-ack"]);

        let _ = socket.close(None).await;
        server.abort();
    }

    #[tokio::test]
    async fn websocket_ordinary_barrier_waits_for_live_audio_acknowledgement() {
        let audio_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let barrier_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_audio = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let handler: WebSocketCommandHandler = {
            let audio_entered = audio_entered.clone();
            let barrier_entered = barrier_entered.clone();
            let release_audio = release_audio.clone();
            std::sync::Arc::new(move |_state, text| {
                let audio_entered = audio_entered.clone();
                let barrier_entered = barrier_entered.clone();
                let release_audio = release_audio.clone();
                Box::pin(async move {
                    let command: serde_json::Value = serde_json::from_str(&text).unwrap();
                    let id = command["id"].as_str().unwrap().to_string();
                    match command["method"].as_str().unwrap() {
                        "audio.processing.update" => {
                            audio_entered.add_permits(1);
                            release_audio.acquire().await.unwrap().forget();
                        }
                        "test.mutation.ordered" => barrier_entered.add_permits(1),
                        method => panic!("unexpected test command: {method}"),
                    }
                    ServerResponse::ok(id, json!({}))
                })
            })
        };
        let (mut socket, server, _) = connect_test_websocket(handler).await;

        for (id, method) in [
            ("audio", "audio.processing.update"),
            ("barrier", "test.mutation.ordered"),
        ] {
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    json!({ "id": id, "method": method, "params": {} })
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        }

        timeout(Duration::from_secs(1), audio_entered.acquire())
            .await
            .expect("audio update should start")
            .unwrap()
            .forget();
        assert!(
            timeout(Duration::from_millis(100), barrier_entered.acquire())
                .await
                .is_err(),
            "ordinary ordered commands must retain the live audio barrier"
        );
        release_audio.add_permits(1);
        timeout(Duration::from_secs(1), barrier_entered.acquire())
            .await
            .expect("ordinary barrier should run after audio acknowledgement")
            .unwrap()
            .forget();

        let _ = socket.close(None).await;
        server.abort();
    }

    #[tokio::test]
    async fn websocket_legacy_layouts_without_intent_ids_execute_in_receipt_order() {
        let order = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let first_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let second_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_first = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let handler: WebSocketCommandHandler = {
            let order = order.clone();
            let first_entered = first_entered.clone();
            let second_entered = second_entered.clone();
            let release_first = release_first.clone();
            std::sync::Arc::new(move |_state, text| {
                let order = order.clone();
                let first_entered = first_entered.clone();
                let second_entered = second_entered.clone();
                let release_first = release_first.clone();
                Box::pin(async move {
                    let command: serde_json::Value = serde_json::from_str(&text).unwrap();
                    let id = command["id"].as_str().unwrap().to_string();
                    if id == "legacy-first" {
                        first_entered.add_permits(1);
                        release_first.acquire().await.unwrap().forget();
                    } else {
                        second_entered.add_permits(1);
                    }
                    order.lock().await.push(id.clone());
                    ServerResponse::ok(id, json!({}))
                })
            })
        };
        let (command_tx, command_rx) = mpsc::channel(4);
        let (outgoing_tx, _outgoing_rx) = mpsc::channel(4);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let connection = transport.register_connection();
        let (pressure_tx, _pressure_rx) = mpsc::channel(1);
        let slow_pressure = WebSocketSlowPressureSignal::new(pressure_tx, transport);
        let dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            test_state(),
            command_rx,
            connection.incoming_command_queue,
            outgoing_tx,
            connection.reliable_response_queue,
            slow_pressure,
            handler,
        ));

        for id in ["legacy-first", "legacy-second"] {
            command_tx
                .send(
                    json!({
                        "id": id,
                        "method": "scene.layout.apply_preview",
                        "params": {}
                    })
                    .to_string(),
                )
                .await
                .unwrap();
        }
        drop(command_tx);

        timeout(Duration::from_secs(1), first_entered.acquire())
            .await
            .expect("first legacy layout should enter")
            .unwrap()
            .forget();
        assert!(
            timeout(Duration::from_millis(50), second_entered.acquire())
                .await
                .is_err(),
            "second legacy layout must not overtake the first"
        );
        release_first.add_permits(1);
        timeout(Duration::from_secs(1), second_entered.acquire())
            .await
            .expect("second legacy layout should run after the first")
            .unwrap()
            .forget();
        dispatcher.await.unwrap();
        assert_eq!(*order.lock().await, ["legacy-first", "legacy-second"]);
    }

    #[tokio::test]
    async fn websocket_layout_commands_respect_non_layout_boundaries() {
        let order = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<&'static str>::new()));
        let start_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let layout_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let stop_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_start = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_layout = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let handler: WebSocketCommandHandler = {
            let order = order.clone();
            let start_entered = start_entered.clone();
            let layout_entered = layout_entered.clone();
            let stop_entered = stop_entered.clone();
            let release_start = release_start.clone();
            let release_layout = release_layout.clone();
            std::sync::Arc::new(move |_state, text| {
                let order = order.clone();
                let start_entered = start_entered.clone();
                let layout_entered = layout_entered.clone();
                let stop_entered = stop_entered.clone();
                let release_start = release_start.clone();
                let release_layout = release_layout.clone();
                Box::pin(async move {
                    let command: serde_json::Value = serde_json::from_str(&text).unwrap();
                    let id = command["id"].as_str().unwrap().to_string();
                    match command["method"].as_str().unwrap() {
                        "test.mutation.start" => {
                            start_entered.add_permits(1);
                            release_start.acquire().await.unwrap().forget();
                            order.lock().await.push("start");
                        }
                        "scene.layout.apply_preview" => {
                            layout_entered.add_permits(1);
                            release_layout.acquire().await.unwrap().forget();
                            order.lock().await.push("layout");
                        }
                        "test.mutation.stop" => {
                            stop_entered.add_permits(1);
                            order.lock().await.push("stop");
                        }
                        method => panic!("unexpected test command: {method}"),
                    }
                    ServerResponse::ok(id, json!({}))
                })
            })
        };
        let (mut socket, server, _) = connect_test_websocket(handler).await;

        for (id, method) in [
            ("start", "test.mutation.start"),
            ("layout", "scene.layout.apply_preview"),
            ("stop", "test.mutation.stop"),
        ] {
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    json!({ "id": id, "method": method, "params": {} })
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        }

        timeout(Duration::from_secs(1), start_entered.acquire())
            .await
            .expect("start command should be accepted")
            .unwrap()
            .forget();
        assert!(
            timeout(Duration::from_millis(100), layout_entered.acquire())
                .await
                .is_err(),
            "layout must not overtake the preceding non-layout start"
        );

        release_start.add_permits(1);
        timeout(Duration::from_secs(1), layout_entered.acquire())
            .await
            .expect("layout should run after start completes")
            .unwrap()
            .forget();
        assert!(
            timeout(Duration::from_millis(100), stop_entered.acquire())
                .await
                .is_err(),
            "stop must not overtake the preceding layout"
        );

        release_layout.add_permits(1);
        timeout(Duration::from_secs(1), stop_entered.acquire())
            .await
            .expect("stop should run after layout completes")
            .unwrap()
            .forget();
        assert_eq!(*order.lock().await, ["start", "layout", "stop"]);

        let _ = socket.close(None).await;
        server.abort();
    }

    #[tokio::test]
    async fn websocket_disconnect_does_not_cancel_an_accepted_mutation() {
        let mutation_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_mutation = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let mutation_completed = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let handler: WebSocketCommandHandler = {
            let mutation_entered = mutation_entered.clone();
            let release_mutation = release_mutation.clone();
            let mutation_completed = mutation_completed.clone();
            std::sync::Arc::new(move |_state, text| {
                let mutation_entered = mutation_entered.clone();
                let release_mutation = release_mutation.clone();
                let mutation_completed = mutation_completed.clone();
                Box::pin(async move {
                    let command: serde_json::Value = serde_json::from_str(&text).unwrap();
                    let id = command["id"].as_str().unwrap().to_string();
                    assert_eq!(command["method"], "test.mutation.start");
                    mutation_entered.add_permits(1);
                    release_mutation.acquire().await.unwrap().forget();
                    mutation_completed.add_permits(1);
                    ServerResponse::ok(id, json!({}))
                })
            })
        };
        let (mut socket, server, session_finished) = connect_test_websocket(handler).await;

        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "id": "start",
                    "method": "test.mutation.start",
                    "params": {},
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        timeout(Duration::from_secs(1), mutation_entered.acquire())
            .await
            .expect("mutation should be accepted before disconnect")
            .unwrap()
            .forget();

        let _ = socket.close(None).await;
        drop(socket);
        timeout(Duration::from_secs(1), session_finished.acquire())
            .await
            .expect("server should observe the disconnected socket")
            .unwrap()
            .forget();

        release_mutation.add_permits(1);
        timeout(Duration::from_millis(250), mutation_completed.acquire())
            .await
            .expect("accepted mutation must finish after its socket disconnects")
            .unwrap()
            .forget();

        server.abort();
    }

    fn preview_layout_params(intent_id: u64, preset: protocol::LayoutPreset) -> serde_json::Value {
        let mut layout = protocol::default_layout_settings();
        layout.layout_preset = preset;
        let config = protocol::SceneConfigParams {
            sources: protocol::SourceSelection {
                screen_id: Some("screen:screencapturekit:1".to_string()),
                window_id: None,
                camera_id: Some("camera:avfoundation-native:camera-1".to_string()),
                microphone_id: None,
                test_pattern: false,
            },
            layout,
            video: None,
            background: None,
            protected_overlay_window_ids: Vec::new(),
        };
        let mut params = serde_json::to_value(config).expect("preview layout params");
        params["intentId"] = json!(intent_id);
        params
    }

    async fn request_for_test(
        state: &AppState,
        id: &str,
        method: &str,
        params: serde_json::Value,
    ) -> ServerResponse {
        handle_text_message(
            state,
            &json!({
                "id": id,
                "method": method,
                "params": params,
            })
            .to_string(),
        )
        .await
    }

    #[tokio::test]
    async fn websocket_newer_preview_layout_supersedes_older_warmup_promptly() {
        let state = test_state();
        {
            let mut camera = state.preview_camera.lock().await;
            camera.status.state = protocol::PreviewCameraState::Live;
            camera.status.camera_id = Some("camera:avfoundation-native:camera-1".to_string());
            camera.status.frame_age_ms = Some(0);
            camera.status.frames_captured = 1;
            camera.status.sequence = Some(1);
        }
        {
            let mut screen = state.preview_screen.lock().await;
            screen.status.state = protocol::PreviewScreenState::Starting;
            screen.status.source_id = Some("screen:screencapturekit:1".to_string());
            screen.status.frames_captured = 0;
            screen.status.sequence = None;
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/ws", get(ws_handler))
                    .with_state(state.clone()),
            )
            .into_future(),
        );
        let (mut socket, _) =
            tokio_tungstenite::connect_async(format!("ws://{address}/ws?token={}", state.token))
                .await
                .unwrap();

        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "id": "initial",
                    "method": "scene.load_from_capture_config",
                    "params": preview_layout_params(0, protocol::LayoutPreset::CameraOnly),
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let initial = timeout(Duration::from_secs(1), async {
            loop {
                let message = socket.next().await.unwrap().unwrap();
                let tokio_tungstenite::tungstenite::Message::Text(text) = message else {
                    continue;
                };
                let payload: serde_json::Value = serde_json::from_str(&text).unwrap();
                if payload["id"] == "initial" {
                    break payload;
                }
            }
        })
        .await
        .expect("initial scene command should return over /ws");
        assert_eq!(initial["ok"], true);

        let started = Instant::now();
        for (id, intent_id, preset) in [
            ("older-warmup", 10, protocol::LayoutPreset::SideBySide),
            ("newer-camera-only", 11, protocol::LayoutPreset::CameraOnly),
        ] {
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    json!({
                        "id": id,
                        "method": "scene.layout.apply_preview",
                        "params": preview_layout_params(intent_id, preset),
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
        }

        let (older, newer) = timeout(Duration::from_millis(1_500), async {
            let mut older = None;
            let mut newer = None;
            while older.is_none() || newer.is_none() {
                let message = socket.next().await.unwrap().unwrap();
                let tokio_tungstenite::tungstenite::Message::Text(text) = message else {
                    continue;
                };
                let payload: serde_json::Value = serde_json::from_str(&text).unwrap();
                match payload["id"].as_str() {
                    Some("older-warmup") => older = Some(payload),
                    Some("newer-camera-only") => newer = Some(payload),
                    _ => {}
                }
            }
            (older.unwrap(), newer.unwrap())
        })
        .await
        .expect("newer click must not wait behind the older 5s warm-up timeout");

        assert_eq!(newer["ok"], true);
        assert_eq!(newer["payload"]["intentId"], 11);
        assert_eq!(older["ok"], false);
        assert!(
            older["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("superseded"))
        );
        assert!(started.elapsed() < Duration::from_millis(1_500));

        let _ = socket.close(None).await;
        server.abort();
    }

    #[tokio::test]
    async fn preview_layout_public_api_is_zero_settle_last_intent_wins_with_one_revision_truth() {
        let state = test_state();
        {
            let mut camera = state.preview_camera.lock().await;
            camera.status.state = protocol::PreviewCameraState::Live;
            camera.status.camera_id = Some("camera:avfoundation-native:camera-1".to_string());
            camera.status.frame_age_ms = Some(0);
            camera.status.frames_captured = 1;
            camera.status.sequence = Some(1);
        }
        {
            let mut screen = state.preview_screen.lock().await;
            screen.status.state = protocol::PreviewScreenState::Live;
            screen.status.source_id = Some("screen:screencapturekit:1".to_string());
            screen.status.frame_age_ms = Some(60_000);
            screen.status.frames_captured = 1;
            screen.status.sequence = Some(1);
        }

        let initial = request_for_test(
            &state,
            "initial",
            "scene.load_from_capture_config",
            preview_layout_params(0, protocol::LayoutPreset::CameraOnly),
        )
        .await;
        assert!(initial.ok);

        let screen_only = request_for_test(
            &state,
            "screen-only",
            "scene.layout.apply_preview",
            preview_layout_params(1, protocol::LayoutPreset::ScreenOnly),
        )
        .await;
        assert!(screen_only.ok, "{:?}", screen_only.error);

        let side_by_side = request_for_test(
            &state,
            "side-by-side",
            "scene.layout.apply_preview",
            preview_layout_params(2, protocol::LayoutPreset::SideBySide),
        )
        .await;
        assert!(side_by_side.ok, "{:?}", side_by_side.error);
        let committed = side_by_side.payload.expect("side-by-side status");
        let revision = committed["sceneRevision"].as_u64().expect("scene revision");
        assert_eq!(committed["intentId"], 2);

        let stale = request_for_test(
            &state,
            "stale-screen-only",
            "scene.layout.apply_preview",
            preview_layout_params(1, protocol::LayoutPreset::ScreenOnly),
        )
        .await;
        assert!(
            !stale.ok,
            "an older layout intent must never replace the latest"
        );

        let scene = request_for_test(&state, "scene", "scene.get", json!({})).await;
        let scene = scene.payload.expect("scene response");
        assert_eq!(scene["sources"].as_array().map(Vec::len), Some(2));
        assert!(scene["sources"].as_array().is_some_and(|sources| {
            sources.iter().any(|source| source["kind"] == "camera")
                && sources.iter().any(|source| source["kind"] == "screen")
        }));

        let compositor =
            request_for_test(&state, "compositor", "compositor.status", json!({})).await;
        assert_eq!(
            compositor.payload.expect("compositor status")["sceneRevision"],
            revision
        );

        tokio::time::sleep(Duration::from_millis(1_100)).await;
        assert_eq!(
            preview_camera_status(&state).await.state,
            protocol::PreviewCameraState::Live,
            "the newer side-by-side intent must cancel screen-only's camera-stop grace"
        );
    }

    #[tokio::test]
    async fn preview_layout_public_api_keeps_previous_scene_until_required_source_is_ready() {
        let state = test_state();
        {
            let mut camera = state.preview_camera.lock().await;
            camera.status.state = protocol::PreviewCameraState::Live;
            camera.status.camera_id = Some("camera:avfoundation-native:camera-1".to_string());
            camera.status.frame_age_ms = Some(0);
            camera.status.frames_captured = 1;
            camera.status.sequence = Some(1);
        }
        {
            let mut screen = state.preview_screen.lock().await;
            screen.status.state = protocol::PreviewScreenState::Starting;
            screen.status.source_id = Some("screen:screencapturekit:1".to_string());
            screen.status.frames_captured = 0;
            screen.status.sequence = None;
        }

        let initial = request_for_test(
            &state,
            "initial-warm",
            "scene.load_from_capture_config",
            preview_layout_params(0, protocol::LayoutPreset::CameraOnly),
        )
        .await;
        let initial_revision = initial.payload.expect("initial scene status")["sceneRevision"]
            .as_u64()
            .expect("initial revision");

        let warm_state = state.clone();
        let pending = tokio::spawn(async move {
            request_for_test(
                &warm_state,
                "warm-side-by-side",
                "scene.layout.apply_preview",
                preview_layout_params(10, protocol::LayoutPreset::SideBySide),
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(25)).await;
        let while_warming = request_for_test(&state, "warming-scene", "scene.get", json!({})).await;
        let while_warming = while_warming.payload.expect("warming scene");
        assert_eq!(while_warming["sources"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            state.compositor.lock().await.status.scene_revision,
            Some(initial_revision),
            "warm-up must not publish target metadata ahead of target pixels"
        );

        {
            let mut screen = state.preview_screen.lock().await;
            screen.status.state = protocol::PreviewScreenState::Live;
            screen.status.frames_captured = 1;
            screen.status.sequence = Some(1);
        }

        let applied = pending.await.expect("warm request task");
        assert!(applied.ok, "{:?}", applied.error);
        let applied = applied.payload.expect("warm apply status");
        assert_eq!(applied["mode"], "warm");
        assert!(applied["sceneRevision"].as_u64().expect("warm revision") > initial_revision);
        assert_eq!(
            applied["scene"]["sources"].as_array().map(Vec::len),
            Some(2)
        );
    }

    #[tokio::test]
    async fn preview_layout_public_api_cancels_an_older_in_flight_warmup() {
        let state = test_state();
        {
            let mut camera = state.preview_camera.lock().await;
            camera.status.state = protocol::PreviewCameraState::Live;
            camera.status.camera_id = Some("camera:avfoundation-native:camera-1".to_string());
            camera.status.frame_age_ms = Some(0);
            camera.status.frames_captured = 1;
            camera.status.sequence = Some(1);
        }
        {
            let mut screen = state.preview_screen.lock().await;
            screen.status.state = protocol::PreviewScreenState::Starting;
            screen.status.source_id = Some("screen:screencapturekit:1".to_string());
        }

        let initial = request_for_test(
            &state,
            "initial-cancel",
            "scene.load_from_capture_config",
            preview_layout_params(0, protocol::LayoutPreset::CameraOnly),
        )
        .await;
        assert!(initial.ok);

        let stale_state = state.clone();
        let stale_pending = tokio::spawn(async move {
            request_for_test(
                &stale_state,
                "stale-warmup",
                "scene.layout.apply_preview",
                preview_layout_params(20, protocol::LayoutPreset::SideBySide),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(25)).await;

        let newest = request_for_test(
            &state,
            "newest-camera-only",
            "scene.layout.apply_preview",
            preview_layout_params(21, protocol::LayoutPreset::CameraOnly),
        )
        .await;
        assert!(newest.ok, "{:?}", newest.error);

        let stale = stale_pending.await.expect("stale warm-up task");
        assert!(!stale.ok);
        assert!(
            stale
                .error
                .is_some_and(|error| error.message.contains("superseded"))
        );
        let final_scene = request_for_test(&state, "final-scene", "scene.get", json!({})).await;
        let final_scene = final_scene.payload.expect("final scene");
        assert_eq!(final_scene["sources"].as_array().map(Vec::len), Some(1));
        assert_eq!(final_scene["sources"][0]["kind"], "camera");
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

    fn session_params_with_stream_output(stream_enabled: bool) -> protocol::StartSessionParams {
        serde_json::from_value(serde_json::json!({
            "sources": { "testPattern": true },
            "layout": {
                "cameraCorner": "bottom-right",
                "cameraSize": "medium",
                "cameraShape": "rectangle",
                "cameraMargin": 32
            },
            "output": {
                "recordEnabled": true,
                "streamEnabled": stream_enabled,
                "video": {
                    "preset": "custom",
                    "width": 1280,
                    "height": 720,
                    "fps": 30,
                    "bitrateKbps": 2000
                },
                "rtmp": { "preset": "youtube", "serverUrl": "", "streamKey": "" }
            }
        }))
        .expect("minimal session params")
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
            live_chat::LiveChatProviderConnectionState::Failed
        );
        assert_eq!(twitch.read, live_chat::CommentsReadState::Unavailable);
        assert_eq!(twitch.write, live_chat::CommentsWriteState::Unavailable);
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
            live_chat::LiveChatProviderConnectionState::Failed
        );
        assert_eq!(twitch.read, live_chat::CommentsReadState::Unavailable);
        assert_eq!(twitch.write, live_chat::CommentsWriteState::MissingScope);
        assert!(twitch.message.contains("Reconnect Twitch"));
    }

    #[test]
    fn live_chat_attaches_only_to_streaming_sessions() {
        let streaming = streaming_with_enabled_target(
            StreamPlatform::Twitch,
            crate::streaming::StreamAuthMode::ManualRtmp,
        );

        // A recording with configured stream targets must NOT attach chat —
        // this exact shape toasted "Twitch comments are not connected" on
        // every plain recording.
        let mut recording = session_params_with_stream_output(false);
        recording.streaming = Some(streaming.clone());
        assert!(!session_attaches_live_chat(&recording));

        // A real go-live with the same targets keeps the 2026-07-10 guarantee:
        // broken chat setup at go-live must surface, never fail silently.
        let mut live = session_params_with_stream_output(true);
        live.streaming = Some(streaming);
        assert!(session_attaches_live_chat(&live));

        // No streaming settings at all → nothing to attach either way.
        assert!(!session_attaches_live_chat(
            &session_params_with_stream_output(true)
        ));
    }

    #[test]
    fn oauth_start_validation_only_applies_to_streaming_sessions() {
        let streaming = streaming_with_enabled_target(
            StreamPlatform::Youtube,
            crate::streaming::StreamAuthMode::Oauth,
        );

        let mut recording = session_params_with_stream_output(false);
        recording.streaming = Some(streaming.clone());
        assert!(oauth_streaming_for_start(&recording).is_none());
        assert!(validate_start_session_oauth_availability(&recording).is_ok());

        let mut live = session_params_with_stream_output(true);
        live.streaming = Some(streaming);
        assert!(oauth_streaming_for_start(&live).is_some());
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
