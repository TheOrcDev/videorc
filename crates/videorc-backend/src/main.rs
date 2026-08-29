// Rust 1.98 clippy (CI `stable`) flags `chunks_exact(N)` with a constant N in
// favour of `as_chunks::<N>()`. The pixel loops in the compositor/capture paths
// are deliberately written with `chunks_exact`, which is the same speed and
// keeps the row/pixel arithmetic explicit; silence the style lint crate-wide
// rather than rewriting ten hot loops for a cosmetic suggestion.
#![allow(clippy::chunks_exact_to_as_chunks)]

mod account;
mod ai;
mod atomic_file;
mod audio;
mod backend_authority;
mod camera_capture;
mod captions;
mod capture_health;
mod capture_input;
mod capture_interruption;
mod capture_recovery;
mod cohost;
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
mod panic_hook;
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
mod remote_control;
mod repair;
mod repair_service;
mod resource_authority;
mod scene;
mod scene_geometry;
mod screen_capture;
mod secrets;
mod session_ops;
mod source_mask;
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
#[allow(dead_code)]
mod windows_d3d11_capture;
#[allow(dead_code)]
mod windows_d3d11_compositor;
#[allow(dead_code)]
mod windows_d3d11_device;
#[allow(dead_code)]
mod windows_d3d11_encoder_contract;
#[allow(dead_code)]
mod windows_d3d11_preview;
#[allow(dead_code)]
mod windows_d3d11_session;
#[allow(dead_code)]
mod windows_d3d11_test_pattern;
#[cfg(target_os = "windows")]
mod windows_graphics_capture;
#[cfg(target_os = "windows")]
mod windows_media_foundation_encoder;
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
use futures_util::{FutureExt, SinkExt, StreamExt};
use preview_camera::{
    latest_preview_camera_bmp, latest_preview_camera_png, preview_camera_status,
    start_preview_camera, stop_preview_camera,
};
use preview_screen::{
    latest_preview_screen_bmp, latest_preview_screen_png, preview_screen_status,
    start_preview_screen, stop_preview_screen,
};
use preview_surface::{
    PreviewSurfaceBusy, apply_main_owned_preview_surface_bounds, create_preview_surface,
    destroy_preview_surface, preview_surface_status, register_preview_surface_resize,
    take_native_preview_host_commands, update_preview_surface_bounds,
    update_preview_surface_present,
};
use protocol::{
    BackendConnection, BackendHealth, ClientCommand, RecordingState, ServerEvent, ServerResponse,
    ToolStatus,
};
use recording::{
    create_preview_snapshot, current_stream_targets_snapshot, idle_status, live_preview_status,
    preview_file_path, probe_stream_output_topology, remux_session, resume_pending_repair_jobs,
    shutdown_capture_processes, start_live_preview, start_session, stop_live_preview,
    stop_recording, subscribe_live_preview_frames, update_active_audio_processing,
    update_preview_frame_age,
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
const ACCOUNT_REFRESH_TIMEOUT: Duration = Duration::from_secs(8);

use crate::backend_authority::{
    BackendBootstrap, BackendRole, authenticate_backend_token, authorize_backend_method,
    resolve_trusted_ffmpeg_path, scrub_untrusted_ffmpeg_paths,
};
use crate::ffmpeg::{default_ffmpeg_path, resolve_ffmpeg_path_ref};
use crate::oauth::{OAuthCompleteParams, OAuthStartParams, OAuthStartProviderParams};
use crate::preflight::GoLivePreflightParams;
use crate::process_job::output_owned_tokio;
use crate::state::{
    AppState, CommandCompletionGuard as WebSocketOperatorMutationGuard,
    CommandCompletionSnapshot as WebSocketOperatorObservationFence,
    TrackedWebSocketCommandLaneMetrics, TrackedWebSocketQueueMetrics, WebSocketQueueTicket,
    WebSocketTransportMetrics,
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

/// Stderr writer that reports every write as successful even when the real
/// write fails (e.g. the parent process died and the pipe broke). See the
/// tracing init below for why log writes must never be able to kill the
/// backend.
struct FailSilentStderr;

impl std::io::Write for FailSilentStderr {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stderr().write(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let _ = std::io::stderr().flush();
        Ok(())
    }
}

/// Sleep, then terminate without allocating, locking, logging, or writing.
/// This is the final edge used when a supervisor or graceful runtime is
/// already unresponsive; even best-effort stderr can block on a full pipe.
fn hard_abort_after_delay(grace: Duration) -> ! {
    std::thread::sleep(grace);
    // `process::exit` runs Rust/C runtime cleanup and registered exit handlers;
    // either can wait on the same wedged stdio/runtime state. `abort` skips
    // those paths and is the actual unconditional process-termination edge.
    std::process::abort();
}

fn backend_runtime_worker_threads() -> usize {
    std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(2)
        .max(2)
}

const PROCESS_RUNTIME_BLOCKING_TASK_SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
const BACKEND_PROCESS_OWNERSHIP_ENV: &str = "VIDEORC_BACKEND_OWNERSHIP_TOKEN";
const BACKEND_PROCESS_OWNERSHIP_PREFIX: &str = "OWNERSHIP ";

fn main() -> Result<()> {
    publish_backend_process_ownership()?;
    // Live-control handlers are third-party/platform integration boundaries.
    // Keep at least one runtime worker available for the process-owned shutdown
    // and recording-finalization path even if a handler accidentally blocks its
    // worker forever. Build explicitly so TOKIO_WORKER_THREADS=1 inherited from
    // a shell or launcher cannot disable that containment guarantee.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(backend_runtime_worker_threads())
        .enable_all()
        .build()?;
    let result = runtime.block_on(run_backend());
    // `spawn_blocking` tasks cannot be aborted. Bound runtime destruction so
    // an already-safe backend can still exit if a device driver or render
    // owner ignores its cooperative shutdown signal.
    runtime.shutdown_timeout(PROCESS_RUNTIME_BLOCKING_TASK_SHUTDOWN_GRACE);
    result
}

fn backend_process_ownership_marker(token: &str) -> Result<String> {
    let token = Uuid::parse_str(token.trim()).context("invalid backend ownership token")?;
    Ok(format!(
        "{BACKEND_PROCESS_OWNERSHIP_PREFIX}{}",
        serde_json::json!({
            "token": token.to_string(),
            "pid": std::process::id(),
            "parentPid": current_parent_pid(),
        })
    ))
}

fn publish_backend_process_ownership() -> Result<()> {
    let Some(token) = std::env::var(BACKEND_PROCESS_OWNERSHIP_ENV).ok() else {
        return Ok(());
    };
    println!("{}", backend_process_ownership_marker(&token)?);
    std::io::stdout().flush()?;
    Ok(())
}

async fn run_backend() -> Result<()> {
    // One JSON line on stderr per panic so the supervisor's crash record
    // (backend-crashes.json) names the cause; see panic_hook.rs.
    panic_hook::install();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("videorc_backend=info".parse()?),
        )
        // NOT plain std::io::stderr: the fmt layer's writer panics on write
        // failure, and a panic aborts the whole backend (panic hook → abort).
        // If the supervisor/parent dies first, stderr becomes a broken pipe
        // and the next log line would kill an otherwise healthy backend
        // mid-recording. Logging must never be load-bearing.
        .with_writer(|| FailSilentStderr)
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
            "/process/shutdown/prepare",
            post(process_shutdown_prepare_handler),
        )
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
    if let Err(error) = sync_remote_discovery_file(&state) {
        state.emit_log(
            "warn",
            format!("Remote-control discovery file could not be written: {error:#}"),
        );
    }
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

async fn prepare_capture_finalization_for_process_shutdown(state: &AppState) -> Result<()> {
    state.request_process_shutdown();
    // A start which reached admission before the latch either fails its final
    // pre-publication check or finishes publishing every process owner before
    // this guard is acquired. Recovery and native source-transition waits use
    // a different fence, so they can never strand shutdown here.
    let _session_start_publication_fence = state
        .session_start_publication_fence
        .clone()
        .lock_owned()
        .await;
    // Finalize exactly once after publication ownership is closed. This must
    // use the ordinary stop path so the process monitor retains the recording
    // slot through MKV flush, MP4 export, persistence, and terminal status.
    recording::finalize_active_recording_for_shutdown(state).await
}

async fn prepare_and_publish_capture_finalization_for_process_shutdown(
    state: &AppState,
) -> Result<()> {
    let preparation = prepare_capture_finalization_for_process_shutdown(state).await;
    state.publish_process_shutdown_preparation(
        preparation
            .as_ref()
            .map(|_| ())
            .map_err(|error| format!("{error:#}")),
    );
    preparation
}

#[cfg(not(test))]
const PROCESS_SHUTDOWN_POST_FINALIZATION_HARD_EXIT_GRACE: Duration = Duration::from_secs(30);
const PROCESS_SHUTDOWN_CLEANUP_GRACE: Duration = Duration::from_secs(10);

/// Once recording finalization has published success, remaining device and
/// socket cleanup is no longer allowed to strand the process indefinitely.
/// Electron uses the same 30-second post-receipt kill grace for an intentional
/// quit. This backend-owned copy also covers autonomous recovery, where there
/// is no HTTP receipt owner available to send SIGKILL.
fn arm_post_finalization_hard_exit() {
    #[cfg(not(test))]
    std::thread::spawn(|| {
        hard_abort_after_delay(PROCESS_SHUTDOWN_POST_FINALIZATION_HARD_EXIT_GRACE)
    });
}

async fn arm_hard_exit_after_safe_preparation<Preparation, Arm>(
    preparation: Preparation,
    arm: Arm,
) -> Result<()>
where
    Preparation: std::future::Future<Output = Result<()>>,
    Arm: FnOnce(),
{
    preparation.await?;
    arm();
    Ok(())
}

async fn run_process_cleanup_with_deadline<Cleanup>(cleanup: Cleanup, deadline: Duration) -> bool
where
    Cleanup: std::future::Future<Output = ()> + Send + 'static,
{
    let mut cleanup = tokio::spawn(cleanup);
    matches!(
        tokio::time::timeout(deadline, &mut cleanup).await,
        Ok(Ok(()))
    )
}

async fn cleanup_process_owners_after_finalization(state: AppState) {
    if let Some(path) = crate::remote_control::discovery_path(state.database.path()) {
        crate::remote_control::remove_discovery(&path);
    }
    captions::shutdown_caption_runtime(&state).await;
    state.noise_cleanup.interrupt_all_for_shutdown();
    if !compositor::shutdown_compositor(&state).await {
        state.emit_log(
            "warn",
            "Compositor teardown exceeded the graceful-shutdown deadline; the post-finalization hard-exit guard remains armed.",
        );
    }
    shutdown_capture_processes(state.clone()).await;
    {
        let mut windows_media = state
            .windows_d3d11_media
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Err(error) = windows_media.shutdown() {
            state.emit_log(
                "warn",
                format!("Could not drain the Windows D3D11 media authority: {error}"),
            );
        }
    }
    captions::shutdown_caption_artifacts(&state).await;
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
            _ = state.wait_for_process_shutdown_request() => {}
        }
    }

    #[cfg(not(unix))]
    {
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if let Err(error) = result {
                    state.emit_log(
                        "warn",
                        format!("Could not listen for shutdown signal: {error}"),
                    );
                }
            }
            _ = state.wait_for_process_shutdown_request() => {}
        }
    }

    let preparation = arm_hard_exit_after_safe_preparation(
        prepare_and_publish_capture_finalization_for_process_shutdown(&state),
        arm_post_finalization_hard_exit,
    )
    .await;
    if let Err(error) = preparation {
        state.emit_log(
            "error",
            format!(
                "Backend shutdown is paused because the active recording did not reach a safe terminal state: {error:#}"
            ),
        );
        // Returning would let Electron/the OS tear down the process while the
        // recording lifecycle is still authoritative. Remain alive so normal
        // app quit cannot convert a recoverable MKV into silent data loss.
        std::future::pending::<()>().await;
        return;
    }
    state.emit_log(
        "info",
        "Backend recording finalization is safe; stopping caption, capture, and artifact processes.",
    );
    if !run_process_cleanup_with_deadline(
        cleanup_process_owners_after_finalization(state.clone()),
        PROCESS_SHUTDOWN_CLEANUP_GRACE,
    )
    .await
    {
        state.emit_log(
            "warn",
            format!(
                "Backend post-finalization cleanup exceeded {}ms; runtime teardown is continuing under its bounded shutdown contract.",
                PROCESS_SHUTDOWN_CLEANUP_GRACE.as_millis()
            ),
        );
    }
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
                    hard_abort_after_delay(std::time::Duration::from_secs(5));
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
                    hard_abort_after_delay(std::time::Duration::from_secs(5));
                }
            };
            let wait = unsafe { WaitForSingleObject(handle, INFINITE) };
            if wait == WAIT_OBJECT_0 {
                // Give the async graceful path a moment, then exit
                // unconditionally; process teardown releases every capture
                // device and drops the Job Object holding the ffmpeg children.
                hard_abort_after_delay(std::time::Duration::from_secs(5));
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
            std::thread::spawn(|| hard_abort_after_delay(std::time::Duration::from_secs(10)));
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
struct ProcessShutdownPrepareQuery {
    token: String,
    request_id: String,
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

async fn process_shutdown_prepare_handler(
    State(state): State<AppState>,
    Query(query): Query<ProcessShutdownPrepareQuery>,
) -> Response {
    if http_backend_role(&state, &query.token) != Some(BackendRole::Admin) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if Uuid::parse_str(&query.request_id).is_err() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let backend_pid = std::process::id();
    state.request_process_shutdown();
    match state.wait_for_process_shutdown_preparation().await {
        Ok(()) => Json(serde_json::json!({
            "shutdownLatched": true,
            "captureFinalizationComplete": true,
            "requestId": query.request_id,
            "backendPid": backend_pid,
        }))
        .into_response(),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "shutdownLatched": state.process_shutdown_requested(),
                "captureFinalizationComplete": false,
                "requestId": query.request_id,
                "backendPid": backend_pid,
                "error": error,
            })),
        )
            .into_response(),
    }
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
    // Say WHY. A bare "OAuth failed" leaves the user with nothing to act on
    // and nothing to report; the backend already knows the reason.
    let detail = result
        .message
        .as_deref()
        .map(|message| format!("<p>{}</p>", html_escape_text(message)))
        .unwrap_or_default();
    Html(format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>\
         <body><h1>{title}</h1>{detail}<p>You can return to Videorc.</p></body></html>"
    ))
}

/// Escape provider-supplied text before it reaches the callback page. The
/// message can carry an upstream error string, so it is never trusted markup.
fn html_escape_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
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
    // A maintenance error is usually static for the whole process (a store
    // that failed to load stays failed until restart). Logging it on every
    // 5-second tick wrote the same ERROR line ~17k times a day into field
    // logs (2026-08-27); log each distinct message once, and again only when
    // the message changes or after recovery.
    let mut last_maintenance_error: Option<String> = None;
    loop {
        let states = match state
            .oauth
            .maintain_pending(chrono::Utc::now(), secrets::delete_secret)
            .await
        {
            Ok(states) => {
                if last_maintenance_error.take().is_some() {
                    state.emit_log("info", "OAuth recovery maintenance recovered.".to_string());
                }
                states
            }
            Err(error) => {
                let message = format!("Could not maintain durable OAuth recovery work: {error}");
                if last_maintenance_error.as_deref() != Some(message.as_str()) {
                    state.emit_log("error", message.clone());
                    last_maintenance_error = Some(message);
                }
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
        } else if let Some((exchange, code)) =
            oauth::provider_exchange_to_run(outcome.exchange, outcome.authorization_code)
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
            // Device grants (Twitch) wait inside this call until the user
            // approves in the browser; redirect grants return immediately.
            let token = match oauth::obtain_provider_token(
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

async fn prepare_session_live_chat(
    state: &AppState,
    session_id: &str,
    streaming: &crate::streaming::StreamingSettings,
) -> Option<live_chat::LiveChatStartParams> {
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
    (!params.destinations.is_empty()).then_some(params)
}

/// Commit one fully-prepared Comments session only while the matching capture
/// is still active. The recording guard is deliberately held through
/// `start_live_chat`: that function installs the coordinator session and then
/// attaches every provider task/sender in several lock transactions. The
/// process monitor retires the recording under this same guard before it tears
/// Comments down, so it can no longer stop an empty coordinator and then be
/// overtaken by a late attachment from the already-terminal session.
async fn attach_prepared_session_live_chat(
    state: &AppState,
    session_id: &str,
    params: live_chat::LiveChatStartParams,
) -> bool {
    debug_assert_eq!(params.session_id, session_id);
    let recording = state.recording.lock().await;
    let session_is_active = recording
        .as_ref()
        .is_some_and(|active| active.session_id == session_id && !active.stop_requested);
    if !session_is_active {
        return false;
    }
    live_chat::start_live_chat(state, params).await;
    drop(recording);
    true
}

async fn spawn_session_live_chat(
    state: &AppState,
    session_id: &str,
    streaming: &crate::streaming::StreamingSettings,
) -> bool {
    let Some(params) = prepare_session_live_chat(state, session_id, streaming).await else {
        return false;
    };
    attach_prepared_session_live_chat(state, session_id, params).await
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

/// Remote sockets must not widen their locked event filter: the
/// remote.state/remote.ack inclusion IS the leak boundary.
fn deny_remote_connection_control(text: &str) -> Option<ServerResponse> {
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
    Some(ServerResponse::error(
        id,
        "forbidden-method",
        "Remote-control connections cannot change their event filter.",
    ))
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
const WEBSOCKET_OBSERVATION_LANE_QUEUE_CAPACITY: usize = 32;
const WEBSOCKET_ACCOUNT_MAINTENANCE_QUEUE_CAPACITY: usize = 8;
const WEBSOCKET_ISOLATED_LANE_QUEUE_CAPACITY: usize = 16;
const WEBSOCKET_STOP_LANE_QUEUE_CAPACITY: usize = 4;
const WEBSOCKET_OBSERVATION_MAX_QUEUE_AGE: Duration = Duration::from_secs(5);
const WEBSOCKET_ACCOUNT_MAINTENANCE_MAX_QUEUE_AGE: Duration = Duration::from_secs(15);
const WEBSOCKET_LIVE_CONTROL_MAX_QUEUE_AGE: Duration = Duration::from_secs(5);
// Once dispatched, operator controls must either complete or LATCH a clean
// backend recycle before the renderer's 30s request deadline. Recording
// finalization remains fail-closed and the post-finalization teardown has its
// own deadline, so a generation change itself is intentionally not promised
// inside this execution window. Queue age alone cannot catch a RUNNING command,
// which is how one wedged screens.activate blocked captions, takeover, and
// highlights in the 2026-08-27 live incident.
const WEBSOCKET_MUTATION_MAX_EXECUTION_AGE: Duration = Duration::from_secs(10);
// Warm layout transactions can legitimately spend 15 seconds starting a
// source and another 15 proving its first fresh frame. Keep that complete
// backend transaction below the renderer's 45-second envelope while retaining
// the 10-second watchdog for unrelated live controls.
const WEBSOCKET_LIVE_LAYOUT_MAX_EXECUTION_AGE: Duration = Duration::from_secs(30);
const WEBSOCKET_FILE_MUTATION_MAX_EXECUTION_AGE: Duration = Duration::from_secs(30);
const WEBSOCKET_PROVIDER_MUTATION_MAX_EXECUTION_AGE: Duration = Duration::from_secs(25);
const WEBSOCKET_MEDIA_MUTATION_MAX_EXECUTION_AGE: Duration = Duration::from_secs(9 * 60);
const WEBSOCKET_AI_MUTATION_MAX_EXECUTION_AGE: Duration = Duration::from_secs(29 * 60);
const WEBSOCKET_PROBE_MUTATION_MAX_EXECUTION_AGE: Duration = Duration::from_secs(110);
#[cfg(not(test))]
const WEBSOCKET_MUTATION_EXECUTOR_THREADS: usize = 4;
// Backend tests run concurrently and several intentionally hold a watched
// mutation open. Keep their shared process-global executor roomy; the focused
// starvation regression uses its own two-worker executor and saturates it
// deterministically.
#[cfg(test)]
const WEBSOCKET_MUTATION_EXECUTOR_THREADS: usize = 16;
const WEBSOCKET_DURABLE_CHAT_MAX_QUEUE_AGE: Duration = Duration::from_secs(5);
const WEBSOCKET_STOP_MAX_QUEUE_AGE: Duration = Duration::from_secs(5);
const WEBSOCKET_ORDERED_MAX_QUEUE_AGE: Duration = Duration::from_secs(5);
const COMMAND_LANE_SMOKE_BLOCK_METHOD: &str = "test.commandLanes.accountMaintenance.block";
const LIVE_CONTROL_RECYCLE_SMOKE_BLOCK_METHOD: &str = "test.commandLanes.liveControl.block";
const COMMAND_LANE_SMOKE_STATUS_METHOD: &str = "test.commandLanes.accountMaintenance.status";
const COMMAND_LANE_SMOKE_RELEASE_METHOD: &str = "test.commandLanes.accountMaintenance.release";
const CAPTURE_RECOVERY_SMOKE_INJECT_METHOD: &str =
    "test.captureRecovery.injectCameraDeliveryDegradation";
const CAPTURE_RECOVERY_SMOKE_INJECT_SCREEN_METHOD: &str =
    "test.captureRecovery.injectScreenDeliveryDegradation";
const CAPTURE_RECOVERY_SMOKE_CAMERA_CADENCE_EVIDENCE_METHOD: &str =
    "test.captureRecovery.cameraCadenceEvidence";
const CAPTURE_RECOVERY_SMOKE_SCREEN_CADENCE_EVIDENCE_METHOD: &str =
    "test.captureRecovery.screenCadenceEvidence";
const WEBSOCKET_RELIABLE_BURST_LIMIT: usize = 8;
// The desktop clients are loopback peers. Five seconds is deliberately far
// above normal socket jitter while still bounding the lifetime of queued
// responses when a reader or writer stalls.
const WEBSOCKET_RELIABLE_MAX_OLDEST_AGE: Duration = Duration::from_secs(5);

/// Watched mutations never run on the process-owned Tokio runtime. A platform
/// handler is allowed to block every worker here: the ordinary runtime still
/// owns shutdown notification and recording finalization. The runtime is
/// intentionally leaked for process lifetime so shutdown can never wait while
/// dropping a runtime whose mutation worker is blocked in foreign code.
#[derive(Clone)]
struct WebSocketMutationExecutor {
    handle: tokio::runtime::Handle,
}

impl WebSocketMutationExecutor {
    fn new(worker_threads: usize) -> std::io::Result<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(worker_threads.max(1))
            .thread_name("videorc-mutation-worker")
            .enable_all()
            .build()?;
        let runtime = Box::leak(Box::new(runtime));
        Ok(Self {
            handle: runtime.handle().clone(),
        })
    }

    fn spawn<F>(&self, future: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.handle.spawn(future)
    }
}

fn websocket_mutation_executor() -> Result<WebSocketMutationExecutor, &'static str> {
    static EXECUTOR: std::sync::OnceLock<Result<WebSocketMutationExecutor, String>> =
        std::sync::OnceLock::new();
    EXECUTOR
        .get_or_init(|| {
            WebSocketMutationExecutor::new(WEBSOCKET_MUTATION_EXECUTOR_THREADS)
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .cloned()
        .map_err(String::as_str)
}

/// Arm the dispatched-mutation deadline outside Tokio. Live controls, durable
/// chat sends, and authoritative scene/source changes cross platform, provider,
/// or native-capture boundaries and can perform an outcome-unknown mutation
/// before they stop replying. Putting both that work and its deadline on the
/// same runtime recreates the exact failure the deadline is meant to contain.
///
/// The returned sender belongs to the handler task. Sending means the handler
/// reached a terminal outcome. A timeout or an unexpectedly dropped sender
/// latches process shutdown without logging, allocating, or waiting on a
/// renderer response queue.
fn arm_runtime_independent_mutation_deadline(
    state: AppState,
    max_execution_age: Duration,
) -> Option<std::sync::mpsc::Sender<()>> {
    arm_runtime_independent_mutation_deadline_with(state, max_execution_age, |deadline| {
        std::thread::Builder::new()
            .name("videorc-mutation-deadline".to_string())
            .spawn(deadline)
            .map(|_| ())
    })
}

fn arm_runtime_independent_mutation_deadline_with<Spawn>(
    state: AppState,
    max_execution_age: Duration,
    spawn: Spawn,
) -> Option<std::sync::mpsc::Sender<()>>
where
    Spawn: FnOnce(Box<dyn FnOnce() + Send + 'static>) -> std::io::Result<()>,
{
    let (completion_tx, completion_rx) = std::sync::mpsc::channel();
    let deadline_state = state.clone();
    match spawn(Box::new(move || {
        use std::sync::mpsc::RecvTimeoutError;

        match completion_rx.recv_timeout(max_execution_age) {
            Ok(()) => {}
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                deadline_state.request_process_shutdown();
            }
        }
    })) {
        Ok(_) => Some(completion_tx),
        Err(_) => {
            // Thread exhaustion is itself an unsafe execution environment for
            // an operator mutation. Fail closed and let the existing process
            // shutdown owner preserve any active recording before teardown.
            state.request_process_shutdown();
            None
        }
    }
}

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

/// Best-effort terminal response used only when a command watchdog has already
/// decided the connection/process must recycle. It cannot await queue capacity:
/// shutdown must latch immediately even when the renderer itself is wedged.
fn try_queue_websocket_response(
    outgoing: &mpsc::Sender<Message>,
    reliable_metrics: &TrackedWebSocketQueueMetrics,
    slow_pressure: &WebSocketSlowPressureSignal,
    response: ServerResponse,
) -> bool {
    let text = match serde_json::to_string(&response) {
        Ok(text) => text,
        Err(error) => {
            tracing::error!("Could not serialize watchdog response: {error}");
            reliable_metrics.record_rejected_or_dropped();
            return false;
        }
    };
    match outgoing.try_reserve() {
        Ok(permit) => {
            reliable_metrics.record_enqueue();
            permit.send(Message::Text(text.into()));
            true
        }
        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
            reliable_metrics.record_rejected_or_dropped();
            slow_pressure.signal();
            false
        }
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
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

/// Pure observations never queue behind a multi-second stateful command. The
/// exhaustive execution-policy inventory is the single authority: a mutator
/// cannot accidentally join this fast path through a second hand-written list.
fn websocket_command_is_read_only(text: &str) -> bool {
    serde_json::from_str::<ClientCommand>(text).is_ok_and(|command| {
        websocket_method_execution_policy(command.method.as_str())
            == Some(WebSocketMethodExecutionPolicy::Observation)
    })
}

fn websocket_command_is_authoritative_scene_mutation(text: &str) -> bool {
    serde_json::from_str::<ClientCommand>(text).is_ok_and(|command| {
        matches!(
            command.method.as_str(),
            "scene.load_from_capture_config"
                | "scene.layout.apply_live"
                | "scene.layout.apply_preview"
                | "scene.source.device.switch"
                | "scene.source.transform.update"
                | "scene.source.transform.reset"
                | "scene.source.visibility.update"
                | "scene.source.nudge"
                | "scene.sources.reorder"
        )
    })
}

fn websocket_command_is_authoritative_source_mutation(text: &str) -> bool {
    serde_json::from_str::<ClientCommand>(text).is_ok_and(|command| {
        matches!(
            command.method.as_str(),
            "preview.camera.start"
                | "preview.camera.stop"
                | "preview.screen.start"
                | "preview.screen.stop"
        )
    })
}

fn websocket_observation_requires_operator_fence(text: &str) -> bool {
    serde_json::from_str::<ClientCommand>(text).is_ok_and(|command| {
        matches!(
            command.method.as_str(),
            "scene.get"
                | "compositor.status"
                | "capture.recovery.status"
                | "captions.status.get"
                | "comments.highlight.status"
                | CAPTURE_RECOVERY_SMOKE_CAMERA_CADENCE_EVIDENCE_METHOD
                | CAPTURE_RECOVERY_SMOKE_SCREEN_CADENCE_EVIDENCE_METHOD
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

fn websocket_command_is_session_start(text: &str) -> bool {
    serde_json::from_str::<ClientCommand>(text)
        .is_ok_and(|command| command.method == "session.start")
}

/// These commands already own stricter process-lifecycle contracts than a
/// generic mutation deadline. Start owns an atomic publication fence. Both stop
/// spellings may legitimately await unbounded, fail-closed MKV flush and MP4
/// export; timing them out must never release or replace that ownership.
#[cfg(test)]
fn websocket_command_has_session_lifecycle_policy(text: &str) -> bool {
    serde_json::from_str::<ClientCommand>(text).is_ok_and(|command| {
        matches!(
            command.method.as_str(),
            "session.start" | "session.stop" | "recording.stop" | "recording.start_test"
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WebSocketMethodExecutionPolicy {
    Observation,
    Mutation { max_execution_age: Duration },
    SessionLifecycle,
}

const DEFAULT_MUTATION_POLICY: WebSocketMethodExecutionPolicy =
    WebSocketMethodExecutionPolicy::Mutation {
        max_execution_age: WEBSOCKET_MUTATION_MAX_EXECUTION_AGE,
    };

/// Explicit inventory for every top-level RPC arm in
/// `handle_text_message_with_role`. The source-derived regression below fails
/// when an arm is added without choosing one of these policies.
fn websocket_method_execution_policy(method: &str) -> Option<WebSocketMethodExecutionPolicy> {
    use WebSocketMethodExecutionPolicy::{Mutation, Observation, SessionLifecycle};

    match method {
        COMMAND_LANE_SMOKE_RELEASE_METHOD
        | LIVE_CONTROL_RECYCLE_SMOKE_BLOCK_METHOD
        | CAPTURE_RECOVERY_SMOKE_INJECT_METHOD
        | CAPTURE_RECOVERY_SMOKE_INJECT_SCREEN_METHOD
        | "resource.capability.issue"
        | "resource.capability.revoke"
        | "resource.capability.register_background"
        | "account.auth.begin_intent"
        | "account.sign_out"
        | "captions.start"
        | "captions.stop"
        | "captions.style.set"
        | "captions.test.inject-audio"
        | "captions.overlay.set"
        | "comments.highlight.set"
        | "comments.highlight.clear"
        | "cohost.start"
        | "cohost.stop"
        | "cohost.question.answered"
        | "cohost.question.dismiss"
        | "cohost.flag.dismiss"
        | "cohost.settings.set"
        | "captions.overlay.clear"
        | "captions.cues.submit"
        | "capture.recovery.retry"
        | "diagnostics.preview_baseline.record"
        | "diagnostics.preview_surface.resize"
        | "preview.surface.create"
        | "preview.surface.update_bounds"
        | "preview.surface.present"
        | "preview.surface.destroy"
        | "preview.surface.take_native_host_commands"
        | "resource.admin.preview_surface_bounds"
        | "remote.control.enable"
        | "remote.control.disable"
        | "remote.control.regenerate"
        | "remote.surface.publish"
        | "remote.intent.ack"
        | "remote.intent"
        | "compositor.scene.update"
        | "preview.camera.start"
        | "preview.camera.stop"
        | "preview.screen.start"
        | "preview.screen.stop"
        | "audio.meter.sample"
        | "audio.processing.update"
        | "audio.test.disconnect"
        | "audio.test.inject-pcm"
        | "scene.load_from_capture_config"
        | "scene.source.transform.update"
        | "scene.source.transform.reset"
        | "scene.source.visibility.update"
        | "scene.source.nudge"
        | "scene.sources.reorder"
        | "sessions.rename"
        | "sessions.duplicate"
        | "liveChat.start"
        | "liveChat.x.start"
        | "liveChat.stop"
        | "liveChat.send"
        | "liveChat.clearLocal"
        | "platformAccounts.oauth.providerCredentials"
        | "streamTargets.metadata.update"
        | "streamTargets.manualKey.store"
        | "streamTargets.manualKey.restorePrevious"
        | "platformAccounts.youtube.selectChannel"
        | "screens.rename"
        | "screens.delete"
        | "screens.reorder"
        | "screens.activate"
        | "screens.clear"
        | "preview.live.start"
        | "preview.live.stop" => Some(DEFAULT_MUTATION_POLICY),

        "scene.layout.apply_live" | "scene.layout.apply_preview" | "scene.source.device.switch" => {
            Some(Mutation {
                max_execution_age: WEBSOCKET_LIVE_LAYOUT_MAX_EXECUTION_AGE,
            })
        }

        "sessions.delete" | "sessions.delete.complete" | "screens.importImage" => Some(Mutation {
            max_execution_age: WEBSOCKET_FILE_MUTATION_MAX_EXECUTION_AGE,
        }),

        "account.complete_sign_in"
        | "account.refresh"
        | "entitlements.refresh"
        | "diagnostics.supportBundle.export"
        | "sessions.poster"
        | "platformAccounts.oauth.start"
        | "platformAccounts.oauth.startProvider"
        | "platformAccounts.oauth.complete"
        | "platformAccounts.disconnect"
        | "platformAccounts.validate"
        | "platformAccounts.refresh"
        | "streamTargets.youtube.prepare"
        | "streamTargets.youtube.transition"
        | "streamTargets.twitch.prepare"
        | "streamTargets.twitch.applyMetadata"
        | "streamTargets.x.startLiveAuthorization"
        | "streamTargets.x.prepare"
        | "streamTargets.x.publish"
        | "streamTargets.x.end"
        | "repair.restore_file"
        | "ai.clips.suggest"
        | "ai.clip.export"
        | "preview.snapshot" => Some(Mutation {
            max_execution_age: WEBSOCKET_PROVIDER_MUTATION_MAX_EXECUTION_AGE,
        }),

        "session.remux_mp4" | "sessions.import" | "repair.repair_file" => Some(Mutation {
            max_execution_age: WEBSOCKET_MEDIA_MUTATION_MAX_EXECUTION_AGE,
        }),

        "ai.run_post_recording" | "ai.publish_pack.export" => Some(Mutation {
            max_execution_age: WEBSOCKET_AI_MUTATION_MAX_EXECUTION_AGE,
        }),

        "encoder_bridge.synthetic_record" => Some(Mutation {
            max_execution_age: WEBSOCKET_PROBE_MUTATION_MAX_EXECUTION_AGE,
        }),

        COMMAND_LANE_SMOKE_BLOCK_METHOD | "noiseCleanup.start" | "noiseCleanup.cancel" => {
            Some(DEFAULT_MUTATION_POLICY)
        }

        "session.start" | "session.stop" | "recording.stop" | "recording.start_test" => {
            Some(SessionLifecycle)
        }

        COMMAND_LANE_SMOKE_STATUS_METHOD
        | CAPTURE_RECOVERY_SMOKE_CAMERA_CADENCE_EVIDENCE_METHOD
        | CAPTURE_RECOVERY_SMOKE_SCREEN_CADENCE_EVIDENCE_METHOD
        | "resource.admin.resolve_session_path"
        | "resource.admin.resolve_screen_path"
        | "resource.admin.resolve_background_path"
        | "health.ping"
        | "account.get"
        | "entitlements.get"
        | "captions.status.get"
        | "captions.test.snapshot"
        | "comments.highlight.status"
        | "cohost.status"
        | "cohost.settings.get"
        | "ai.capabilities.get"
        | "ai.quota.get"
        | "ai.jobs.get"
        | "devices.list"
        | "diagnostics.stats"
        | "capture.recovery.status"
        | "preview.surface.status"
        | "remote.control.status"
        | "remote.describe"
        | "compositor.status"
        | "preview.camera.status"
        | "preview.screen.status"
        | "audio.meter.probeNative"
        | "scene.get"
        | "stream.output.topology.probe"
        | "sessions.list"
        | "sessions.healthEvents.list"
        | "sessions.logs.list"
        | "sessions.aiArtifacts.list"
        | "sessions.delete.resolve"
        | "sessions.delete.pending"
        | "sessions.storage"
        | "sessions.comments.list"
        | "platformAccounts.list"
        | "liveChat.capability"
        | "liveChat.status"
        | "liveChat.diagnostics"
        | "liveChat.sendOperations.list"
        | "liveChat.sendOperations.latest"
        | "liveChat.xCommentsReadiness"
        | "streamTargets.metadata.get"
        | "streamTargets.metadata.validate"
        | "streamTargets.manualKey.inspect"
        | "streamTargets.confirmation.validate"
        | "streamTargets.youtube.streamStatus"
        | "platformAccounts.youtube.channels"
        | "streamTargets.twitch.searchCategories"
        | "streamTargets.x.capability"
        | "screens.list"
        | "repair.assess_file"
        | "noiseCleanup.list"
        | "ai.artifacts.list"
        | "preview.live.status"
        | "recording.status"
        | "stream.targets.snapshot" => Some(Observation),

        "screens.active" => Some(DEFAULT_MUTATION_POLICY),
        _ => None,
    }
}

fn websocket_command_mutation_max_execution_age(text: &str) -> Option<Duration> {
    let command = serde_json::from_str::<ClientCommand>(text).ok()?;
    match websocket_method_execution_policy(command.method.as_str())? {
        WebSocketMethodExecutionPolicy::Mutation { max_execution_age } => Some(max_execution_age),
        WebSocketMethodExecutionPolicy::Observation
        | WebSocketMethodExecutionPolicy::SessionLifecycle => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WebSocketIsolatedCommandLaneKind {
    Observation,
    AccountMaintenance,
    DurableChat,
    LiveControl,
    Stop,
}

fn websocket_isolated_command_lane(text: &str) -> Option<WebSocketIsolatedCommandLaneKind> {
    let command = serde_json::from_str::<ClientCommand>(text).ok()?;
    match command.method.as_str() {
        "account.refresh"
        | "entitlements.refresh"
        | "platformAccounts.refresh"
        | "platformAccounts.validate"
        | COMMAND_LANE_SMOKE_BLOCK_METHOD => {
            Some(WebSocketIsolatedCommandLaneKind::AccountMaintenance)
        }
        "liveChat.send" => Some(WebSocketIsolatedCommandLaneKind::DurableChat),
        "screens.active"
        | "screens.activate"
        | "screens.clear"
        | "screens.delete"
        | LIVE_CONTROL_RECYCLE_SMOKE_BLOCK_METHOD
        | "capture.recovery.retry"
        | CAPTURE_RECOVERY_SMOKE_INJECT_METHOD
        | CAPTURE_RECOVERY_SMOKE_INJECT_SCREEN_METHOD
        | "captions.start"
        | "captions.stop"
        | "captions.style.set"
        | "comments.highlight.set"
        | "comments.highlight.clear" => Some(WebSocketIsolatedCommandLaneKind::LiveControl),
        "session.stop" | COMMAND_LANE_SMOKE_RELEASE_METHOD => {
            Some(WebSocketIsolatedCommandLaneKind::Stop)
        }
        _ => None,
    }
}

#[derive(Clone)]
struct WebSocketIsolatedCommandLane {
    kind: WebSocketIsolatedCommandLaneKind,
    capacity: std::sync::Arc<tokio::sync::Semaphore>,
    sender: mpsc::Sender<WebSocketQueuedLaneCommand>,
    max_queue_age: Duration,
    metrics: TrackedWebSocketCommandLaneMetrics,
    account_refresh_pending: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl WebSocketIsolatedCommandLane {
    fn new(
        kind: WebSocketIsolatedCommandLaneKind,
        capacity: usize,
        max_queue_age: Duration,
        metrics: TrackedWebSocketCommandLaneMetrics,
    ) -> (Self, mpsc::Receiver<WebSocketQueuedLaneCommand>) {
        let (sender, receiver) = mpsc::channel(capacity);
        (
            Self {
                kind,
                capacity: std::sync::Arc::new(tokio::sync::Semaphore::new(capacity)),
                sender,
                max_queue_age,
                metrics,
                account_refresh_pending: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
                    false,
                )),
            },
            receiver,
        )
    }

    fn full_error(&self, command_id: String) -> ServerResponse {
        match self.kind {
            WebSocketIsolatedCommandLaneKind::Observation => ServerResponse::error(
                command_id,
                "observation-lane-full",
                "The observation lane is full; this request was not applied.",
            ),
            _ => ServerResponse::error(
                command_id,
                "command-lane-full",
                "The command lane is full; this command was not applied.",
            ),
        }
    }

    fn duplicate_account_refresh_error(&self, command_id: String) -> ServerResponse {
        ServerResponse::error(
            command_id,
            "account-maintenance-coalesced",
            "Account maintenance is already running; this duplicate was not applied.",
        )
    }
}

struct WebSocketLaneAdmissionGuard {
    _capacity_permit: tokio::sync::OwnedSemaphorePermit,
    account_refresh_pending: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    _operator_mutation: Option<WebSocketOperatorMutationGuard>,
    live_control_order: Option<WebSocketOperatorMutationGuard>,
}

impl Drop for WebSocketLaneAdmissionGuard {
    fn drop(&mut self) {
        if let Some(pending) = &self.account_refresh_pending {
            pending.store(false, std::sync::atomic::Ordering::Release);
        }
    }
}

struct WebSocketQueuedLaneCommand {
    command_id: String,
    text: String,
    dispatch_deadline: tokio::time::Instant,
    queue_ticket: WebSocketQueueTicket,
    dispatch_fence: Option<WebSocketCommandDispatchFence>,
    _admission: WebSocketLaneAdmissionGuard,
}

enum WebSocketCommandDispatchFence {
    /// Cross-lane ordering and reconciliation remain bounded by the accepted
    /// command's queue-age contract. Work that cannot reach a safe dispatch
    /// point in time is definitely not applied.
    Bounded(WebSocketOperatorObservationFence),
    /// Stop must not overtake or expire behind an already accepted
    /// session.start. Otherwise Start could complete into a live capture after
    /// Stop reported Idle or expired.
    PriorSessionStart(WebSocketOperatorObservationFence),
}

struct WebSocketAcceptedCommand {
    text: String,
    _accepted_at: tokio::time::Instant,
    dispatch_deadline: tokio::time::Instant,
    operator_mutation: Option<WebSocketOperatorMutationGuard>,
    live_control_order: Option<WebSocketOperatorMutationGuard>,
    session_start: Option<WebSocketOperatorMutationGuard>,
    dispatch_fence: Option<WebSocketCommandDispatchFence>,
}

fn accept_websocket_command(state: &AppState, text: String) -> WebSocketAcceptedCommand {
    let accepted_at = tokio::time::Instant::now();
    let lane_kind = websocket_isolated_command_lane(text.as_str());
    let max_queue_age = if websocket_command_is_read_only(text.as_str()) {
        WEBSOCKET_OBSERVATION_MAX_QUEUE_AGE
    } else {
        match lane_kind {
            Some(WebSocketIsolatedCommandLaneKind::AccountMaintenance) => {
                WEBSOCKET_ACCOUNT_MAINTENANCE_MAX_QUEUE_AGE
            }
            Some(WebSocketIsolatedCommandLaneKind::DurableChat) => {
                WEBSOCKET_DURABLE_CHAT_MAX_QUEUE_AGE
            }
            Some(WebSocketIsolatedCommandLaneKind::LiveControl) => {
                WEBSOCKET_LIVE_CONTROL_MAX_QUEUE_AGE
            }
            Some(WebSocketIsolatedCommandLaneKind::Stop) => WEBSOCKET_STOP_MAX_QUEUE_AGE,
            // Observation is classified above because it is a read-only
            // property rather than a mutation-lane classifier result.
            Some(WebSocketIsolatedCommandLaneKind::Observation) => {
                WEBSOCKET_OBSERVATION_MAX_QUEUE_AGE
            }
            None => WEBSOCKET_ORDERED_MAX_QUEUE_AGE,
        }
    };
    // One short process-global critical section establishes receipt order and
    // makes every associated fence guard visible before this command can sit
    // in a per-connection queue.
    let admission = state
        .websocket_command_admission
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let live_control = lane_kind == Some(WebSocketIsolatedCommandLaneKind::LiveControl);
    let operator_mutation_command = live_control
        || websocket_command_is_authoritative_scene_mutation(text.as_str())
        || websocket_command_is_authoritative_source_mutation(text.as_str());
    let session_start_command = websocket_command_is_session_start(text.as_str());
    let operator_mutation = operator_mutation_command.then(|| state.operator_command_fence.begin());
    let live_control_order = live_control.then(|| state.live_control_command_order.begin());
    let session_start = session_start_command.then(|| state.session_start_command_fence.begin());
    let dispatch_fence = if websocket_command_is_read_only(text.as_str())
        && websocket_observation_requires_operator_fence(text.as_str())
    {
        Some(WebSocketCommandDispatchFence::Bounded(
            state.operator_command_fence.observe(),
        ))
    } else if lane_kind == Some(WebSocketIsolatedCommandLaneKind::Stop)
        && websocket_command_is_session_stop(text.as_str())
    {
        Some(WebSocketCommandDispatchFence::PriorSessionStart(
            state.session_start_command_fence.observe(),
        ))
    } else if session_start_command {
        Some(WebSocketCommandDispatchFence::Bounded(
            state.operator_command_fence.observe(),
        ))
    } else if operator_mutation_command {
        Some(WebSocketCommandDispatchFence::Bounded(
            state.session_start_command_fence.observe(),
        ))
    } else {
        None
    };
    drop(admission);
    WebSocketAcceptedCommand {
        text,
        _accepted_at: accepted_at,
        dispatch_deadline: accepted_at + max_queue_age,
        operator_mutation,
        live_control_order,
        session_start,
        dispatch_fence,
    }
}

struct WebSocketOrderedCommand {
    text: String,
    dispatch_deadline: tokio::time::Instant,
    dispatch_fence: Option<WebSocketCommandDispatchFence>,
    _operator_mutation: Option<WebSocketOperatorMutationGuard>,
    _session_start: Option<WebSocketOperatorMutationGuard>,
}

struct WebSocketIsolatedCommandLanes {
    observation: WebSocketIsolatedCommandLane,
    account: WebSocketIsolatedCommandLane,
    durable_chat: WebSocketIsolatedCommandLane,
    live_control: WebSocketIsolatedCommandLane,
    stop: WebSocketIsolatedCommandLane,
}

struct WebSocketIsolatedCommandLaneReceivers {
    observation: mpsc::Receiver<WebSocketQueuedLaneCommand>,
    account: mpsc::Receiver<WebSocketQueuedLaneCommand>,
    durable_chat: mpsc::Receiver<WebSocketQueuedLaneCommand>,
    live_control: mpsc::Receiver<WebSocketQueuedLaneCommand>,
    stop: mpsc::Receiver<WebSocketQueuedLaneCommand>,
}

impl WebSocketIsolatedCommandLanes {
    fn new(transport: &WebSocketTransportMetrics) -> (Self, WebSocketIsolatedCommandLaneReceivers) {
        let (observation, observation_rx) = WebSocketIsolatedCommandLane::new(
            WebSocketIsolatedCommandLaneKind::Observation,
            WEBSOCKET_OBSERVATION_LANE_QUEUE_CAPACITY,
            WEBSOCKET_OBSERVATION_MAX_QUEUE_AGE,
            transport.register_command_lane("observation"),
        );
        let (account, account_rx) = WebSocketIsolatedCommandLane::new(
            WebSocketIsolatedCommandLaneKind::AccountMaintenance,
            WEBSOCKET_ACCOUNT_MAINTENANCE_QUEUE_CAPACITY,
            WEBSOCKET_ACCOUNT_MAINTENANCE_MAX_QUEUE_AGE,
            transport.register_command_lane("accountMaintenance"),
        );
        let (durable_chat, durable_chat_rx) = WebSocketIsolatedCommandLane::new(
            WebSocketIsolatedCommandLaneKind::DurableChat,
            WEBSOCKET_ISOLATED_LANE_QUEUE_CAPACITY,
            WEBSOCKET_DURABLE_CHAT_MAX_QUEUE_AGE,
            transport.register_command_lane("durableChat"),
        );
        let (live_control, live_control_rx) = WebSocketIsolatedCommandLane::new(
            WebSocketIsolatedCommandLaneKind::LiveControl,
            WEBSOCKET_ISOLATED_LANE_QUEUE_CAPACITY,
            WEBSOCKET_LIVE_CONTROL_MAX_QUEUE_AGE,
            transport.register_command_lane("liveControl"),
        );
        let (stop, stop_rx) = WebSocketIsolatedCommandLane::new(
            WebSocketIsolatedCommandLaneKind::Stop,
            WEBSOCKET_STOP_LANE_QUEUE_CAPACITY,
            WEBSOCKET_STOP_MAX_QUEUE_AGE,
            transport.register_command_lane("stop"),
        );
        (
            Self {
                observation,
                account,
                durable_chat,
                live_control,
                stop,
            },
            WebSocketIsolatedCommandLaneReceivers {
                observation: observation_rx,
                account: account_rx,
                durable_chat: durable_chat_rx,
                live_control: live_control_rx,
                stop: stop_rx,
            },
        )
    }

    fn get(&self, kind: WebSocketIsolatedCommandLaneKind) -> WebSocketIsolatedCommandLane {
        match kind {
            WebSocketIsolatedCommandLaneKind::Observation => self.observation.clone(),
            WebSocketIsolatedCommandLaneKind::AccountMaintenance => self.account.clone(),
            WebSocketIsolatedCommandLaneKind::DurableChat => self.durable_chat.clone(),
            WebSocketIsolatedCommandLaneKind::LiveControl => self.live_control.clone(),
            WebSocketIsolatedCommandLaneKind::Stop => self.stop.clone(),
        }
    }
}

fn websocket_command_id(text: &str) -> String {
    serde_json::from_str::<ClientCommand>(text)
        .map(|command| command.id)
        .unwrap_or_else(|_| "unknown".to_string())
}

fn websocket_command_method(text: &str) -> String {
    serde_json::from_str::<ClientCommand>(text)
        .map(|command| command.method)
        .unwrap_or_else(|_| "unknown".to_string())
}

/// A stateful mutation that outlives this budget gets named in the log — the
/// 2026-08-27 live incident produced 30 seconds of silence because the stuck
/// command was the RUNNING stateful mutation, invisible to the queue-age
/// expiry that covers only QUEUED commands.
const WEBSOCKET_SLOW_STATEFUL_COMMAND_THRESHOLD: Duration = Duration::from_secs(2);

/// The ordered dispatcher's currently-running stateful mutation, shared with
/// the enqueue side so a `command-lane-full` rejection can name what is
/// actually jamming the lane instead of only telling the client "full".
#[derive(Clone, Default)]
struct WebSocketRunningStatefulCommand(
    std::sync::Arc<std::sync::Mutex<Option<(String, std::time::Instant)>>>,
);

impl WebSocketRunningStatefulCommand {
    fn set(&self, method: String) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
            Some((method, std::time::Instant::now()));
    }

    fn clear(&self) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    fn snapshot(&self) -> Option<(String, u128)> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(|(method, started)| (method.clone(), started.elapsed().as_millis()))
    }
}

/// Clears the diagnostic owner only when the mutation executor really releases
/// the handler future. Keeping this guard inside the detached executor task is
/// what makes a timed-out command remain truthfully visible as still running.
struct WebSocketMutationTrackerRetention(Option<WebSocketRunningStatefulCommand>);

impl Drop for WebSocketMutationTrackerRetention {
    fn drop(&mut self) {
        if let Some(tracker) = self.0.as_ref() {
            tracker.clear();
        }
    }
}

enum WebSocketMutationExecutionOutcome {
    Completed(ServerResponse),
    Panicked,
    NotInvokedAfterShutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WebSocketMutationStartFailure {
    ExecutorUnavailable,
    DeadlineUnavailable,
}

/// Transfer an admitted mutation and every completion owner it retains to the
/// process-lifetime mutation runtime. The OS-thread deadline is armed before
/// `spawn`, and the queued task checks the shutdown latch at the last possible
/// edge before it invokes the handler. Therefore an executor backlog can never
/// start stale work after its own deadline has already retired the generation.
fn spawn_websocket_mutation_execution<Retention>(
    executor: Result<WebSocketMutationExecutor, &'static str>,
    state: AppState,
    text: String,
    handler: WebSocketCommandHandler,
    retention: Retention,
    stateful_tracker: Option<WebSocketRunningStatefulCommand>,
    max_execution_age: Duration,
) -> Result<tokio::task::JoinHandle<WebSocketMutationExecutionOutcome>, WebSocketMutationStartFailure>
where
    Retention: Send + 'static,
{
    let executor = match executor {
        Ok(executor) => executor,
        Err(_) => {
            // Runtime construction includes spawning its worker threads. Any
            // failure means there is no isolated execution boundary, so fail
            // closed before the handler can be invoked.
            state.request_process_shutdown();
            if let Some(tracker) = stateful_tracker.as_ref() {
                tracker.clear();
            }
            drop(retention);
            return Err(WebSocketMutationStartFailure::ExecutorUnavailable);
        }
    };
    let Some(execution_deadline_completion) =
        arm_runtime_independent_mutation_deadline(state.clone(), max_execution_age)
    else {
        if let Some(tracker) = stateful_tracker.as_ref() {
            tracker.clear();
        }
        drop(retention);
        return Err(WebSocketMutationStartFailure::DeadlineUnavailable);
    };

    let restart_state = state.clone();
    Ok(executor.spawn(async move {
        // These owners live in the mutation task, not in its JoinHandle. A
        // caller which drops the JoinHandle on timeout merely detaches; it
        // cannot cancel the handler or release reconciliation ordering early.
        let _retention = retention;
        let _tracker_retention = WebSocketMutationTrackerRetention(stateful_tracker);

        // This task may have spent its entire budget queued behind blocking
        // mutation workers. Recheck at the invocation edge and never apply it
        // in the generation its OS deadline has already retired.
        if restart_state.process_shutdown_requested() {
            let _ = execution_deadline_completion.send(());
            return WebSocketMutationExecutionOutcome::NotInvokedAfterShutdown;
        }

        let response = std::panic::AssertUnwindSafe(handler(state, text))
            .catch_unwind()
            .await;
        match response {
            Ok(response) => {
                let _ = execution_deadline_completion.send(());
                WebSocketMutationExecutionOutcome::Completed(response)
            }
            Err(_panic) => {
                // Latch before disarming the independent deadline or dropping
                // any retained ordering owner.
                restart_state.request_process_shutdown();
                let _ = execution_deadline_completion.send(());
                WebSocketMutationExecutionOutcome::Panicked
            }
        }
    }))
}

struct WebSocketMutationDispatchResult {
    response_queued: bool,
    handler_terminal: bool,
}

/// Execute an already-admitted authoritative mutation behind both the Tokio
/// timer and the runtime-independent OS-thread deadline. The handler owns its
/// completion guards until it really terminates; a timeout detaches the join
/// handle instead of cancelling outcome-unknown work.
#[allow(clippy::too_many_arguments)]
async fn run_websocket_mutation_with_deadline(
    mutation_executor: Result<WebSocketMutationExecutor, &'static str>,
    state: AppState,
    text: String,
    outgoing: mpsc::Sender<Message>,
    reliable_metrics: TrackedWebSocketQueueMetrics,
    slow_pressure: WebSocketSlowPressureSignal,
    handler: WebSocketCommandHandler,
    max_execution_age: Duration,
    operator_mutation: Option<WebSocketOperatorMutationGuard>,
    session_start: Option<WebSocketOperatorMutationGuard>,
    stateful_tracker: Option<WebSocketRunningStatefulCommand>,
) -> WebSocketMutationDispatchResult {
    let command_id = websocket_command_id(text.as_str());
    let method = websocket_command_method(text.as_str());
    let restart_state = state.clone();
    let mut execution = match spawn_websocket_mutation_execution(
        mutation_executor,
        state,
        text,
        handler,
        (operator_mutation, session_start),
        stateful_tracker,
        max_execution_age,
    ) {
        Ok(execution) => execution,
        Err(_failure) => {
            let response_queued = try_queue_websocket_response(
                &outgoing,
                &reliable_metrics,
                &slow_pressure,
                ServerResponse::error(
                    command_id,
                    "command-not-applied",
                    "Videorc could not arm the mutation safety deadline. The command was not applied and the backend is restarting.",
                ),
            );
            return WebSocketMutationDispatchResult {
                response_queued,
                handler_terminal: true,
            };
        }
    };

    tokio::select! {
        biased;
        completed = &mut execution => {
            match completed {
                Ok(WebSocketMutationExecutionOutcome::Completed(response)) => {
                    WebSocketMutationDispatchResult {
                        response_queued: queue_websocket_response(
                            &outgoing,
                            &reliable_metrics,
                            &slow_pressure,
                            response,
                        ).await,
                        handler_terminal: true,
                    }
                }
                Ok(WebSocketMutationExecutionOutcome::Panicked) => {
                    restart_state.request_process_shutdown();
                    restart_state.emit_log(
                        "error",
                        format!(
                            "Mutating command {method} panicked after dispatch; its outcome is unknown and the backend is restarting after safe recording finalization."
                        ),
                    );
                    WebSocketMutationDispatchResult {
                        response_queued: try_queue_websocket_response(
                            &outgoing,
                            &reliable_metrics,
                            &slow_pressure,
                            ServerResponse::error(
                                command_id,
                                "request-outcome-unknown",
                                "The mutating command panicked after dispatch. Its outcome is unknown; Videorc is restarting the backend and will reconcile authoritative state.",
                            ),
                        ),
                        handler_terminal: true,
                    }
                }
                Ok(WebSocketMutationExecutionOutcome::NotInvokedAfterShutdown) => {
                    WebSocketMutationDispatchResult {
                        response_queued: try_queue_websocket_response(
                            &outgoing,
                            &reliable_metrics,
                            &slow_pressure,
                            ServerResponse::error(
                                command_id,
                                "command-not-applied",
                                "Backend shutdown began while the command waited for mutation execution; it was not applied.",
                            ),
                        ),
                        handler_terminal: true,
                    }
                }
                Err(error) => {
                    restart_state.request_process_shutdown();
                    restart_state.emit_log(
                        "error",
                        format!(
                            "Mutating command {method} task failed after dispatch ({error}); its outcome is unknown and the backend is restarting after safe recording finalization."
                        ),
                    );
                    WebSocketMutationDispatchResult {
                        response_queued: try_queue_websocket_response(
                            &outgoing,
                            &reliable_metrics,
                            &slow_pressure,
                            ServerResponse::error(
                                command_id,
                                "request-outcome-unknown",
                                "The mutating command task failed after dispatch. Its outcome is unknown; Videorc is restarting the backend and will reconcile authoritative state.",
                            ),
                        ),
                        handler_terminal: true,
                    }
                }
            }
        }
        _ = tokio::time::sleep(max_execution_age) => {
            restart_state.request_process_shutdown();
            restart_state.emit_log(
                "error",
                format!(
                    "Mutating command {method} exceeded its {}ms execution contract; its outcome is unknown and the backend is restarting after safe recording finalization.",
                    max_execution_age.as_millis()
                ),
            );
            let response_queued = try_queue_websocket_response(
                &outgoing,
                &reliable_metrics,
                &slow_pressure,
                ServerResponse::error(
                    command_id,
                    "request-outcome-unknown",
                    "The mutating command stopped replying after dispatch. Its outcome is unknown; Videorc is restarting the backend and will reconcile authoritative state.",
                ),
            );
            // Dropping a JoinHandle detaches. The handler task still owns both
            // completion guards and the stateful tracker until real completion.
            drop(execution);
            WebSocketMutationDispatchResult {
                response_queued,
                handler_terminal: false,
            }
        }
    }
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

fn try_enqueue_websocket_lane_command(
    lane: &WebSocketIsolatedCommandLane,
    text: String,
    dispatch_deadline: tokio::time::Instant,
    operator_mutation: Option<WebSocketOperatorMutationGuard>,
    live_control_order: Option<WebSocketOperatorMutationGuard>,
    dispatch_fence: Option<WebSocketCommandDispatchFence>,
) -> Result<(), ServerResponse> {
    let command_id = websocket_command_id(text.as_str());
    let account_refresh = lane.kind == WebSocketIsolatedCommandLaneKind::AccountMaintenance
        && serde_json::from_str::<ClientCommand>(text.as_str())
            .is_ok_and(|command| command.method == "account.refresh");
    if account_refresh
        && lane
            .account_refresh_pending
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_err()
    {
        lane.metrics.record_rejected_before_dispatch();
        return Err(lane.duplicate_account_refresh_error(command_id));
    }
    let account_refresh_pending = account_refresh.then(|| lane.account_refresh_pending.clone());
    let capacity_permit = match lane.capacity.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            if let Some(pending) = account_refresh_pending {
                pending.store(false, std::sync::atomic::Ordering::Release);
            }
            lane.metrics.record_rejected_before_dispatch();
            return Err(lane.full_error(command_id));
        }
    };
    let queue_ticket = lane.metrics.record_enqueue();
    let dispatch_deadline = dispatch_deadline.min(tokio::time::Instant::now() + lane.max_queue_age);
    let queued = WebSocketQueuedLaneCommand {
        command_id: command_id.clone(),
        text,
        dispatch_deadline,
        queue_ticket,
        dispatch_fence,
        _admission: WebSocketLaneAdmissionGuard {
            _capacity_permit: capacity_permit,
            account_refresh_pending,
            _operator_mutation: operator_mutation,
            live_control_order,
        },
    };
    match lane.sender.try_send(queued) {
        Ok(()) => Ok(()),
        Err(error) => {
            let queued = error.into_inner();
            lane.metrics.record_dispatch(queued.queue_ticket);
            lane.metrics.record_rejected_before_dispatch();
            drop(queued);
            Err(lane.full_error(command_id))
        }
    }
}

async fn wait_for_websocket_lane_deadline(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending::<()>().await,
    }
}

async fn wait_for_websocket_dispatch_fence(
    dispatch_fence: Option<WebSocketCommandDispatchFence>,
    dispatch_deadline: tokio::time::Instant,
) -> bool {
    match dispatch_fence {
        Some(WebSocketCommandDispatchFence::Bounded(fence)) => {
            tokio::time::timeout_at(dispatch_deadline, fence.wait())
                .await
                .is_ok()
        }
        Some(WebSocketCommandDispatchFence::PriorSessionStart(fence)) => {
            fence.wait().await;
            true
        }
        None => true,
    }
}

#[derive(Clone)]
struct WebSocketCommandLaneWorkerContext {
    state: AppState,
    outgoing: mpsc::Sender<Message>,
    reliable_metrics: TrackedWebSocketQueueMetrics,
    slow_pressure: WebSocketSlowPressureSignal,
    command_handler: WebSocketCommandHandler,
}

async fn run_websocket_command_lane_worker(
    mut commands: mpsc::Receiver<WebSocketQueuedLaneCommand>,
    max_concurrency: usize,
    metrics: TrackedWebSocketCommandLaneMetrics,
    context: WebSocketCommandLaneWorkerContext,
    mutation_executor: Result<WebSocketMutationExecutor, &'static str>,
    mutation_max_execution_age_override: Option<Duration>,
) {
    let mut pending = std::collections::VecDeque::<WebSocketQueuedLaneCommand>::new();
    let mut active = tokio::task::JoinSet::new();
    let mut accepting = true;

    loop {
        while active.len() < max_concurrency {
            let Some(front) = pending.front() else {
                break;
            };
            if context.state.process_shutdown_requested() {
                let rejected = pending.pop_front().expect("lane front exists");
                let WebSocketQueuedLaneCommand {
                    command_id,
                    queue_ticket,
                    _admission,
                    ..
                } = rejected;
                metrics.record_dispatch(queue_ticket);
                metrics.record_expired_before_dispatch();
                let response = ServerResponse::error(
                    command_id,
                    "command-expired-before-dispatch",
                    "Backend shutdown began before this command dispatched; it was not applied.",
                );
                drop(_admission);
                let _ = queue_websocket_response(
                    &context.outgoing,
                    &context.reliable_metrics,
                    &context.slow_pressure,
                    response,
                )
                .await;
                continue;
            }
            if front.dispatch_deadline <= tokio::time::Instant::now() {
                let expired = pending.pop_front().expect("lane front exists");
                let WebSocketQueuedLaneCommand {
                    command_id,
                    queue_ticket,
                    _admission,
                    ..
                } = expired;
                metrics.record_dispatch(queue_ticket);
                metrics.record_expired_before_dispatch();
                let response = ServerResponse::error(
                    command_id,
                    "command-expired-before-dispatch",
                    "The command expired in its lane before dispatch and was not applied.",
                );
                drop(_admission);
                let _ = queue_websocket_response(
                    &context.outgoing,
                    &context.reliable_metrics,
                    &context.slow_pressure,
                    response,
                )
                .await;
                continue;
            }

            let command = pending.pop_front().expect("lane front exists");
            metrics.record_dispatch(command.queue_ticket);
            let command_state = context.state.clone();
            let response_tx = context.outgoing.clone();
            let response_metrics = context.reliable_metrics.clone();
            let response_pressure = context.slow_pressure.clone();
            let handler = context.command_handler.clone();
            let lane_metrics = metrics.clone();
            let mutation_executor = mutation_executor.clone();
            active.spawn(async move {
                let WebSocketQueuedLaneCommand {
                    command_id,
                    text,
                    dispatch_deadline,
                    dispatch_fence,
                    _admission,
                    ..
                } = command;
                let order_ready = match _admission.live_control_order.as_ref() {
                    Some(order) => {
                        tokio::time::timeout_at(dispatch_deadline, order.wait_for_turn())
                            .await
                            .is_ok()
                    }
                    None => true,
                };
                let fence_ready = if order_ready {
                    wait_for_websocket_dispatch_fence(dispatch_fence, dispatch_deadline).await
                } else {
                    false
                };
                if !fence_ready {
                    lane_metrics.record_expired_before_dispatch();
                    let response = ServerResponse::error(
                        command_id,
                        "command-expired-before-dispatch",
                        "The command expired while awaiting its reconciliation fence and was not applied.",
                    );
                    drop(_admission);
                    let _ = queue_websocket_response(
                        &response_tx,
                        &response_metrics,
                        &response_pressure,
                        response,
                    )
                    .await;
                    return;
                }
                // Shutdown may latch while this command waits for a prior-order
                // or source/session fence. Recheck at the final dispatch edge so
                // accepted work cannot start inside the recycling generation.
                if command_state.process_shutdown_requested() {
                    lane_metrics.record_expired_before_dispatch();
                    let response = ServerResponse::error(
                        command_id,
                        "command-expired-before-dispatch",
                        "Backend shutdown began before this command dispatched; it was not applied.",
                    );
                    drop(_admission);
                    let _ = queue_websocket_response(
                        &response_tx,
                        &response_metrics,
                        &response_pressure,
                        response,
                    )
                    .await;
                    return;
                }

                if let Some(max_execution_age) =
                    websocket_command_mutation_max_execution_age(text.as_str())
                {
                    let max_execution_age =
                        mutation_max_execution_age_override.unwrap_or(max_execution_age);
                    let method = websocket_command_method(text.as_str());
                    let restart_state = command_state.clone();
                    let mut execution = match spawn_websocket_mutation_execution(
                        mutation_executor,
                        command_state,
                        text,
                        handler,
                        _admission,
                        None,
                        max_execution_age,
                    ) {
                        Ok(execution) => execution,
                        Err(_failure) => {
                            // The helper already latched shutdown and released
                            // admission. No handler was invoked.
                            let _ = try_queue_websocket_response(
                                &response_tx,
                                &response_metrics,
                                &response_pressure,
                                ServerResponse::error(
                                    command_id,
                                    "command-not-applied",
                                    "Videorc could not arm isolated mutation execution. The command was not applied and the backend is restarting.",
                                ),
                            );
                            return;
                        }
                    };
                    tokio::select! {
                        biased;
                        completed = &mut execution => {
                            match completed {
                                Ok(WebSocketMutationExecutionOutcome::Completed(response)) => {
                                    // Application completion, rather than a slow peer's response
                                    // queue, is the fence edge observed by Stop/reconciliation.
                                    let _ = queue_websocket_response(
                                        &response_tx,
                                        &response_metrics,
                                        &response_pressure,
                                        response,
                                    )
                                    .await;
                                }
                                Ok(WebSocketMutationExecutionOutcome::Panicked) => {
                                    // The latch is the recovery authority; diagnostics
                                    // are never allowed ahead of it because stderr/log
                                    // storage can itself be saturated.
                                    restart_state.request_process_shutdown();
                                    restart_state.emit_log(
                                        "error",
                                        format!(
                                            "Mutating command {method} panicked after dispatch; its outcome is unknown and the backend is restarting after safe recording finalization."
                                        ),
                                    );
                                    let _ = try_queue_websocket_response(
                                        &response_tx,
                                        &response_metrics,
                                        &response_pressure,
                                        ServerResponse::error(
                                            command_id,
                                            "request-outcome-unknown",
                                            "The mutating command panicked after dispatch. Its outcome is unknown; Videorc is restarting the backend and will reconcile authoritative state.",
                                        ),
                                    );
                                }
                                Ok(WebSocketMutationExecutionOutcome::NotInvokedAfterShutdown) => {
                                    let _ = try_queue_websocket_response(
                                        &response_tx,
                                        &response_metrics,
                                        &response_pressure,
                                        ServerResponse::error(
                                            command_id,
                                            "command-not-applied",
                                            "Backend shutdown began while the command waited for mutation execution; it was not applied.",
                                        ),
                                    );
                                }
                                Err(error) => {
                                    restart_state.request_process_shutdown();
                                    restart_state.emit_log(
                                        "error",
                                        format!(
                                            "Mutating command {method} task failed after dispatch ({error}); its outcome is unknown and the backend is restarting after safe recording finalization."
                                        ),
                                    );
                                    let _ = try_queue_websocket_response(
                                        &response_tx,
                                        &response_metrics,
                                        &response_pressure,
                                        ServerResponse::error(
                                            command_id,
                                            "request-outcome-unknown",
                                            "The mutating command task failed after dispatch. Its outcome is unknown; Videorc is restarting the backend and will reconcile authoritative state.",
                                        ),
                                    );
                                }
                            }
                        }
                        _ = tokio::time::sleep(max_execution_age) => {
                            // Latch recycle before diagnostics or response work.
                            restart_state.request_process_shutdown();
                            restart_state.emit_log(
                                "error",
                                format!(
                                    "Mutating command {method} exceeded its {}ms execution contract; its outcome is unknown and the backend is restarting after safe recording finalization.",
                                    max_execution_age.as_millis()
                                ),
                            );
                            // The response queue may itself be full; socket close
                            // still conveys outcome-unknown to the renderer.
                            let _ = try_queue_websocket_response(
                                &response_tx,
                                &response_metrics,
                                &response_pressure,
                                ServerResponse::error(
                                    command_id,
                                    "request-outcome-unknown",
                                    "The mutating command stopped replying after dispatch. Its outcome is unknown; Videorc is restarting the backend and will reconcile authoritative state.",
                                ),
                            );
                            // Drop detaches this JoinHandle. The handler task retains
                            // the admission/fence guards through actual completion or
                            // process death; it is never cancelled by the watchdog.
                            drop(execution);
                        }
                    }
                    return;
                }

                let response = handler(command_state, text).await;
                // Application completion, rather than a slow peer's response
                // queue, is the fence edge observed by Stop/reconciliation.
                drop(_admission);
                let _ = queue_websocket_response(
                    &response_tx,
                    &response_metrics,
                    &response_pressure,
                    response,
                )
                .await;
            });
        }

        if !accepting && pending.is_empty() && active.is_empty() {
            break;
        }
        let next_deadline = pending.front().map(|command| command.dispatch_deadline);
        tokio::select! {
            incoming = commands.recv(), if accepting => {
                match incoming {
                    Some(command) => pending.push_back(command),
                    None => accepting = false,
                }
            }
            completed = active.join_next(), if !active.is_empty() => {
                if let Some(Err(error)) = completed {
                    tracing::warn!("WebSocket command lane task failed: {error}");
                }
            }
            _ = wait_for_websocket_lane_deadline(next_deadline) => {
                while pending
                    .front()
                    .is_some_and(|command| command.dispatch_deadline <= tokio::time::Instant::now())
                {
                    let expired = pending.pop_front().expect("expired lane front exists");
                    let WebSocketQueuedLaneCommand {
                        command_id,
                        queue_ticket,
                        _admission,
                        ..
                    } = expired;
                    metrics.record_dispatch(queue_ticket);
                    metrics.record_expired_before_dispatch();
                    let response = ServerResponse::error(
                        command_id,
                        "command-expired-before-dispatch",
                        "The command expired in its lane before dispatch and was not applied.",
                    );
                    drop(_admission);
                    let _ = queue_websocket_response(
                        &context.outgoing,
                        &context.reliable_metrics,
                        &context.slow_pressure,
                        response,
                    )
                    .await;
                }
            }
        }
    }
}

fn spawn_websocket_command_lane_worker(
    workers: &mut tokio::task::JoinSet<()>,
    commands: mpsc::Receiver<WebSocketQueuedLaneCommand>,
    max_concurrency: usize,
    metrics: TrackedWebSocketCommandLaneMetrics,
    context: &WebSocketCommandLaneWorkerContext,
) {
    spawn_websocket_command_lane_worker_with_mutation_executor(
        workers,
        commands,
        max_concurrency,
        metrics,
        context,
        websocket_mutation_executor(),
        None,
    );
}

fn spawn_websocket_command_lane_worker_with_mutation_executor(
    workers: &mut tokio::task::JoinSet<()>,
    commands: mpsc::Receiver<WebSocketQueuedLaneCommand>,
    max_concurrency: usize,
    metrics: TrackedWebSocketCommandLaneMetrics,
    context: &WebSocketCommandLaneWorkerContext,
    mutation_executor: Result<WebSocketMutationExecutor, &'static str>,
    mutation_max_execution_age_override: Option<Duration>,
) {
    workers.spawn(run_websocket_command_lane_worker(
        commands,
        max_concurrency,
        metrics,
        context.clone(),
        mutation_executor,
        mutation_max_execution_age_override,
    ));
}

async fn run_websocket_command_dispatcher(
    state: AppState,
    mut commands: mpsc::Receiver<WebSocketAcceptedCommand>,
    command_metrics: TrackedWebSocketQueueMetrics,
    outgoing: mpsc::Sender<Message>,
    reliable_metrics: TrackedWebSocketQueueMetrics,
    slow_pressure: WebSocketSlowPressureSignal,
    command_handler: WebSocketCommandHandler,
) {
    let (ordered_tx, ordered_rx) = mpsc::channel(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
    let running_stateful = WebSocketRunningStatefulCommand::default();
    let ordered_task = tokio::spawn(run_websocket_ordered_command_dispatcher(
        state.clone(),
        ordered_rx,
        outgoing.clone(),
        reliable_metrics.clone(),
        slow_pressure.clone(),
        command_handler.clone(),
        running_stateful.clone(),
    ));
    let (lanes, lane_receivers) =
        WebSocketIsolatedCommandLanes::new(&state.websocket_transport_metrics);
    let mut lane_workers = tokio::task::JoinSet::new();
    let lane_worker_context = WebSocketCommandLaneWorkerContext {
        state: state.clone(),
        outgoing: outgoing.clone(),
        reliable_metrics: reliable_metrics.clone(),
        slow_pressure: slow_pressure.clone(),
        command_handler: command_handler.clone(),
    };
    spawn_websocket_command_lane_worker(
        &mut lane_workers,
        lane_receivers.observation,
        WEBSOCKET_READ_ONLY_CONCURRENCY,
        lanes.observation.metrics.clone(),
        &lane_worker_context,
    );
    spawn_websocket_command_lane_worker(
        &mut lane_workers,
        lane_receivers.account,
        1,
        lanes.account.metrics.clone(),
        &lane_worker_context,
    );
    spawn_websocket_command_lane_worker(
        &mut lane_workers,
        lane_receivers.durable_chat,
        1,
        lanes.durable_chat.metrics.clone(),
        &lane_worker_context,
    );
    spawn_websocket_command_lane_worker(
        &mut lane_workers,
        lane_receivers.live_control,
        1,
        lanes.live_control.metrics.clone(),
        &lane_worker_context,
    );
    spawn_websocket_command_lane_worker(
        &mut lane_workers,
        lane_receivers.stop,
        1,
        lanes.stop.metrics.clone(),
        &lane_worker_context,
    );

    while let Some(accepted) = commands.recv().await {
        command_metrics.record_dequeue_oldest();
        let WebSocketAcceptedCommand {
            text,
            dispatch_deadline,
            operator_mutation,
            live_control_order,
            session_start,
            dispatch_fence,
            ..
        } = accepted;
        if dispatch_deadline <= tokio::time::Instant::now() {
            let response = ServerResponse::error(
                websocket_command_id(text.as_str()),
                "command-expired-before-dispatch",
                "The command expired in its connection queue before dispatch and was not applied.",
            );
            drop(operator_mutation);
            drop(live_control_order);
            drop(session_start);
            drop(dispatch_fence);
            if !queue_websocket_response(&outgoing, &reliable_metrics, &slow_pressure, response)
                .await
            {
                break;
            }
            continue;
        }

        if websocket_command_is_read_only(text.as_str()) {
            if let Err(response) = try_enqueue_websocket_lane_command(
                &lanes.observation,
                text,
                dispatch_deadline,
                operator_mutation,
                live_control_order,
                dispatch_fence,
            ) && !queue_websocket_response(
                &outgoing,
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

        if let Some(kind) = websocket_isolated_command_lane(text.as_str()) {
            let lane = lanes.get(kind);
            if let Err(response) = try_enqueue_websocket_lane_command(
                &lane,
                text,
                dispatch_deadline,
                operator_mutation,
                live_control_order,
                dispatch_fence,
            ) && !queue_websocket_response(
                &outgoing,
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

        let ordered_command = WebSocketOrderedCommand {
            dispatch_deadline,
            dispatch_fence,
            _operator_mutation: operator_mutation,
            _session_start: session_start,
            text,
        };
        if let Err(error) = ordered_tx.try_send(ordered_command) {
            let command = match error {
                mpsc::error::TrySendError::Full(command)
                | mpsc::error::TrySendError::Closed(command) => command,
            };
            let command_id = websocket_command_id(command.text.as_str());
            let rejected_method = websocket_command_method(command.text.as_str());
            match running_stateful.snapshot() {
                Some((running_method, elapsed_ms)) => tracing::warn!(
                    "[command-lane] ordered lane full: rejected {rejected_method}; running stateful command {running_method} has held the lane for {elapsed_ms}ms"
                ),
                None => tracing::warn!(
                    "[command-lane] ordered lane full: rejected {rejected_method}; no stateful command running (queue backlog)"
                ),
            }
            // Rejected work is definitely not applied, so release its global
            // completion fences before awaiting a potentially slow peer.
            drop(command);
            let response = ServerResponse::error(
                command_id,
                "command-lane-full",
                "The ordered command lane is full; this command was not applied.",
            );
            if !queue_websocket_response(&outgoing, &reliable_metrics, &slow_pressure, response)
                .await
            {
                break;
            }
        }
    }

    drop(ordered_tx);
    drop(lanes);
    if let Err(error) = ordered_task.await {
        tracing::warn!("WebSocket ordered command dispatcher failed: {error}");
    }
    while let Some(completed) = lane_workers.join_next().await {
        if let Err(error) = completed {
            tracing::warn!("WebSocket command lane worker failed: {error}");
        }
    }
}

async fn run_websocket_ordered_command_dispatcher(
    state: AppState,
    commands: mpsc::Receiver<WebSocketOrderedCommand>,
    outgoing: mpsc::Sender<Message>,
    reliable_metrics: TrackedWebSocketQueueMetrics,
    slow_pressure: WebSocketSlowPressureSignal,
    command_handler: WebSocketCommandHandler,
    running_stateful: WebSocketRunningStatefulCommand,
) {
    run_websocket_ordered_command_dispatcher_with_mutation_executor(
        state,
        commands,
        outgoing,
        reliable_metrics,
        slow_pressure,
        command_handler,
        running_stateful,
        websocket_mutation_executor(),
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn run_websocket_ordered_command_dispatcher_with_mutation_executor(
    state: AppState,
    mut commands: mpsc::Receiver<WebSocketOrderedCommand>,
    outgoing: mpsc::Sender<Message>,
    reliable_metrics: TrackedWebSocketQueueMetrics,
    slow_pressure: WebSocketSlowPressureSignal,
    command_handler: WebSocketCommandHandler,
    running_stateful: WebSocketRunningStatefulCommand,
    mutation_executor: Result<WebSocketMutationExecutor, &'static str>,
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

    while let Some(command) = commands.recv().await {
        let WebSocketOrderedCommand {
            text,
            dispatch_deadline,
            dispatch_fence,
            _operator_mutation,
            _session_start,
        } = command;
        if dispatch_deadline <= tokio::time::Instant::now() {
            let response = ServerResponse::error(
                websocket_command_id(text.as_str()),
                "command-expired-before-dispatch",
                "The ordered command expired before dispatch and was not applied.",
            );
            drop(_operator_mutation);
            drop(_session_start);
            if !queue_websocket_response(&outgoing, &reliable_metrics, &slow_pressure, response)
                .await
            {
                break;
            }
            continue;
        }
        if !wait_for_websocket_dispatch_fence(dispatch_fence, dispatch_deadline).await {
            let response = ServerResponse::error(
                websocket_command_id(text.as_str()),
                "command-expired-before-dispatch",
                "The command expired while awaiting its reconciliation fence and was not applied.",
            );
            drop(_operator_mutation);
            drop(_session_start);
            if !queue_websocket_response(&outgoing, &reliable_metrics, &slow_pressure, response)
                .await
            {
                break;
            }
            continue;
        }
        if state.process_shutdown_requested() {
            let response = ServerResponse::error(
                websocket_command_id(text.as_str()),
                "command-expired-before-dispatch",
                "Backend shutdown began before this command dispatched; it was not applied.",
            );
            drop(_operator_mutation);
            drop(_session_start);
            if !queue_websocket_response(&outgoing, &reliable_metrics, &slow_pressure, response)
                .await
            {
                break;
            }
            continue;
        }
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
                drop(_operator_mutation);
                drop(_session_start);
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
            // The prior stateful command or the layout task reaped above may
            // have crossed its mutation deadline while this command waited.
            // Never dispatch fresh work inside the retiring generation.
            if state.process_shutdown_requested() {
                let response = ServerResponse::error(
                    websocket_command_id(text.as_str()),
                    "command-expired-before-dispatch",
                    "Backend shutdown began before this command dispatched; it was not applied.",
                );
                drop(_operator_mutation);
                drop(_session_start);
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
            let mutation_executor = mutation_executor.clone();
            layout_tasks.spawn(async move {
                let max_execution_age = websocket_command_mutation_max_execution_age(text.as_str())
                    .expect("overlapping layout commands are inventoried mutations");
                let _ = run_websocket_mutation_with_deadline(
                    mutation_executor,
                    command_state,
                    text,
                    response_tx,
                    response_metrics,
                    response_pressure,
                    handler,
                    max_execution_age,
                    _operator_mutation,
                    _session_start,
                    None,
                )
                .await;
            });
            continue;
        }

        if let Some(command_id) = websocket_audio_processing_command_id(text.as_str()) {
            await_websocket_stateful_barrier(&mut stateful_task).await;
            if state.process_shutdown_requested() {
                let response = ServerResponse::error(
                    command_id,
                    "command-expired-before-dispatch",
                    "Backend shutdown began before this command dispatched; it was not applied.",
                );
                drop(_operator_mutation);
                drop(_session_start);
                if !queue_websocket_response(&outgoing, &reliable_metrics, &slow_pressure, response)
                    .await
                {
                    break;
                }
                continue;
            }
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
            let mutation_executor = mutation_executor.clone();
            audio_processing_tasks.spawn(async move {
                let max_execution_age = websocket_command_mutation_max_execution_age(text.as_str())
                    .expect("audio processing is an inventoried mutation");
                let _ = run_websocket_mutation_with_deadline(
                    mutation_executor,
                    command_state,
                    text,
                    response_tx,
                    response_metrics,
                    response_pressure,
                    handler,
                    max_execution_age,
                    _operator_mutation,
                    _session_start,
                    None,
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
        if state.process_shutdown_requested() {
            let response = ServerResponse::error(
                websocket_command_id(text.as_str()),
                "command-expired-before-dispatch",
                "Backend shutdown began before this command dispatched; it was not applied.",
            );
            drop(_operator_mutation);
            drop(_session_start);
            if !queue_websocket_response(&outgoing, &reliable_metrics, &slow_pressure, response)
                .await
            {
                break;
            }
            continue;
        }
        let mutation_max_execution_age =
            websocket_command_mutation_max_execution_age(text.as_str());
        let command_state = state.clone();
        let response_tx = outgoing.clone();
        let response_metrics = reliable_metrics.clone();
        let response_pressure = slow_pressure.clone();
        let handler = command_handler.clone();
        let stateful_tracker = running_stateful.clone();
        let mutation_executor = mutation_executor.clone();
        stateful_task = Some(tokio::spawn(async move {
            let method = websocket_command_method(text.as_str());
            let started = std::time::Instant::now();
            stateful_tracker.set(method.clone());
            // One live line the moment the running mutation crosses the
            // budget, aborted on completion — so a wedged command is named
            // WHILE it is wedged, not only in the post-mortem.
            let slow_method = method.clone();
            let slow_watch = tokio::spawn(async move {
                tokio::time::sleep(WEBSOCKET_SLOW_STATEFUL_COMMAND_THRESHOLD).await;
                tracing::warn!(
                    "[command-lane] stateful command {slow_method} still running after {}ms; later ordered commands are barriered behind it",
                    WEBSOCKET_SLOW_STATEFUL_COMMAND_THRESHOLD.as_millis()
                );
            });
            if let Some(max_execution_age) = mutation_max_execution_age {
                let result = run_websocket_mutation_with_deadline(
                    mutation_executor,
                    command_state,
                    text,
                    response_tx,
                    response_metrics,
                    response_pressure,
                    handler,
                    max_execution_age,
                    _operator_mutation,
                    _session_start,
                    Some(stateful_tracker.clone()),
                )
                .await;
                slow_watch.abort();
                let elapsed = started.elapsed();
                if result.handler_terminal && elapsed >= WEBSOCKET_SLOW_STATEFUL_COMMAND_THRESHOLD {
                    tracing::warn!(
                        "[command-lane] stateful command {method} completed after {}ms",
                        elapsed.as_millis()
                    );
                }
                result.response_queued
            } else {
                let response = handler(command_state, text).await;
                slow_watch.abort();
                let elapsed = started.elapsed();
                if elapsed >= WEBSOCKET_SLOW_STATEFUL_COMMAND_THRESHOLD {
                    tracing::warn!(
                        "[command-lane] stateful command {method} completed after {}ms",
                        elapsed.as_millis()
                    );
                }
                stateful_tracker.clear();
                drop(_operator_mutation);
                drop(_session_start);
                queue_websocket_response(
                    &response_tx,
                    &response_metrics,
                    &response_pressure,
                    response,
                )
                .await
            }
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

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteControlStatus {
    enabled: bool,
    /// Full token — this RPC (and the remote.control.status event) is
    /// renderer/admin-only; the renderer renders the copy field + QR. Remote
    /// sockets can never call it, and their locked included-event filter
    /// (remote.state/remote.ack only) never relays the event to them.
    token: Option<String>,
    port: u16,
    connected_clients: usize,
    discovery_path: Option<String>,
}

fn remote_control_status(state: &AppState) -> RemoteControlStatus {
    let (enabled, token, connected_clients) = state
        .remote_control
        .lock()
        .map(|runtime| {
            (
                runtime.enabled,
                runtime.token.clone(),
                runtime.connected_clients,
            )
        })
        .unwrap_or((false, None, 0));
    RemoteControlStatus {
        token: enabled.then_some(token).flatten(),
        enabled,
        port: state.port,
        connected_clients,
        discovery_path: crate::remote_control::discovery_path(state.database.path())
            .map(|path| path.display().to_string()),
    }
}

fn sync_remote_discovery_file(state: &AppState) -> anyhow::Result<()> {
    let Some(path) = crate::remote_control::discovery_path(state.database.path()) else {
        return Ok(());
    };
    let (enabled, token) = state
        .remote_control
        .lock()
        .map(|runtime| (runtime.enabled, runtime.token.clone()))
        .unwrap_or((false, None));
    match (enabled, token) {
        (true, Some(token)) => {
            crate::remote_control::write_discovery(&path, "127.0.0.1", state.port, &token)
        }
        _ => {
            crate::remote_control::remove_discovery(&path);
            Ok(())
        }
    }
}

fn enable_remote_control(state: &AppState) -> anyhow::Result<RemoteControlStatus> {
    {
        let mut runtime = state
            .remote_control
            .lock()
            .map_err(|_| anyhow::anyhow!("Remote control state unavailable."))?;
        if runtime.token.is_none() {
            runtime.token = Some(crate::remote_control::generate_token());
        }
        runtime.enabled = true;
        crate::remote_control::persist_enabled(true, runtime.token.as_deref())?;
    }
    sync_remote_discovery_file(state)?;
    let status = remote_control_status(state);
    state.emit_event("remote.control.status", status.clone());
    Ok(status)
}

fn disable_remote_control(state: &AppState) -> anyhow::Result<RemoteControlStatus> {
    {
        let mut runtime = state
            .remote_control
            .lock()
            .map_err(|_| anyhow::anyhow!("Remote control state unavailable."))?;
        runtime.enabled = false;
        crate::remote_control::persist_enabled(false, None)?;
    }
    sync_remote_discovery_file(state)?;
    // Cut live remote clients immediately.
    state
        .remote_generation
        .send_modify(|generation| *generation += 1);
    let status = remote_control_status(state);
    state.emit_event("remote.control.status", status.clone());
    Ok(status)
}

fn regenerate_remote_control_token(state: &AppState) -> anyhow::Result<RemoteControlStatus> {
    {
        let mut runtime = state
            .remote_control
            .lock()
            .map_err(|_| anyhow::anyhow!("Remote control state unavailable."))?;
        runtime.token = Some(crate::remote_control::generate_token());
        if runtime.enabled {
            crate::remote_control::persist_enabled(true, runtime.token.as_deref())?;
        }
    }
    sync_remote_discovery_file(state)?;
    state
        .remote_generation
        .send_modify(|generation| *generation += 1);
    let status = remote_control_status(state);
    state.emit_event("remote.control.status", status.clone());
    Ok(status)
}

async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let role =
        authenticate_backend_token(&query.token, &state.token, &state.admin_token).or_else(|| {
            let runtime = state.remote_control.lock().ok()?;
            (runtime.enabled
                && crate::backend_authority::authenticate_remote_token(
                    &query.token,
                    runtime.token.as_deref(),
                ))
            .then_some(BackendRole::Remote)
        });
    let Some(role) = role else {
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

// The relay owns distinct reliability, pressure, telemetry, filtering, and
// redaction channels. Keeping them explicit makes the connection contract and
// task ownership visible at its only production call site.
#[allow(clippy::too_many_arguments)]
async fn relay_websocket_events(
    state: AppState,
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

                if is_recovery {
                    // The broadcast ring may have dropped a terminal recovery
                    // event while this socket was backpressured. Follow the
                    // lag marker with the coordinator's authoritative latest
                    // snapshot so a renderer cannot remain stuck on an older
                    // Restarting/Verifying revision indefinitely.
                    let repair = ServerEvent::new(
                        "capture.recovery.status",
                        capture_recovery::capture_recovery_status(&state).await,
                    );
                    let repair_allowed = event_filter
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .allows(&repair.event);
                    if repair_allowed
                        && let Ok(text) = serde_json::to_string(&repair)
                        && !send_tracked_reliable_websocket_item(
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
            }
            Err(error) => tracing::error!("Could not serialize event: {error}"),
        }
    }
}

async fn websocket_session(socket: WebSocket, state: AppState, role: BackendRole) {
    websocket_session_with_handler_role_and_redaction(
        socket,
        state,
        production_websocket_command_handler(role),
        role,
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
    websocket_session_with_handler_role_and_redaction(
        socket,
        state,
        command_handler,
        BackendRole::Admin,
        false,
    )
    .await;
}

async fn websocket_session_with_handler_role_and_redaction(
    socket: WebSocket,
    state: AppState,
    command_handler: WebSocketCommandHandler,
    role: BackendRole,
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
    // Remote clients only ever see their own lane: state projections and
    // intent acks. This is transport-level leak safety — no recording paths,
    // tokens, or diagnostics can reach a remote socket even by accident.
    let event_filter = std::sync::Arc::new(std::sync::Mutex::new(if role == BackendRole::Remote {
        ConnectionEventFilter {
            excluded: std::collections::HashSet::new(),
            included: Some(std::collections::HashSet::from([
                "remote.state".to_string(),
                "remote.ack".to_string(),
            ])),
        }
    } else {
        ConnectionEventFilter::default()
    }));
    let event_filter_for_events = event_filter.clone();
    // Count Remote clients with a Drop guard: every exit path (early return on
    // a failed ready send, read-loop break, panic) must decrement, and the
    // count feeds Settings via remote.control.status — a leak shows users a
    // phantom connected deck forever.
    struct RemoteClientCountGuard(AppState);
    impl Drop for RemoteClientCountGuard {
        fn drop(&mut self) {
            if let Ok(mut runtime) = self.0.remote_control.lock() {
                runtime.connected_clients = runtime.connected_clients.saturating_sub(1);
            }
            self.0
                .emit_event("remote.control.status", remote_control_status(&self.0));
        }
    }
    let _remote_client_guard = (role == BackendRole::Remote).then(|| {
        if let Ok(mut runtime) = state.remote_control.lock() {
            runtime.connected_clients = runtime.connected_clients.saturating_add(1);
        }
        state.emit_event("remote.control.status", remote_control_status(&state));
        RemoteClientCountGuard(state.clone())
    });

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
        state.clone(),
        events,
        event_tx,
        reliable_metrics.clone(),
        slow_pressure.clone(),
        telemetry_tx,
        event_filter_for_events,
        redact_renderer_paths,
    ));

    let (command_tx, command_rx) =
        mpsc::channel::<WebSocketAcceptedCommand>(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
    let command_dispatcher_task = tokio::spawn(run_websocket_command_dispatcher(
        state.clone(),
        command_rx,
        command_metrics.clone(),
        outgoing_tx.clone(),
        reliable_metrics.clone(),
        slow_pressure.clone(),
        command_handler,
    ));

    // A rotated/disabled remote token must cut existing remote sockets, not
    // just future ones: watch the generation and close when it moves.
    let mut remote_generation_rx = state.remote_generation.subscribe();
    let watch_remote_generation = role == BackendRole::Remote;

    loop {
        let incoming = tokio::select! {
            incoming = receiver.next() => incoming,
            _ = state.wait_for_process_shutdown_request() => {
                // Axum's `on_upgrade` callback is detached from the graceful-shutdown
                // connection tracker, so server shutdown will not close this session for us.
                // Observe the process latch explicitly to stop socket I/O, abort auxiliary
                // tasks, and release per-connection state during bounded shutdown.
                break;
            }
            _ = pressure_rx.recv() => {
                break;
            }
            changed = remote_generation_rx.changed(), if watch_remote_generation => {
                if changed.is_ok() {
                    tracing::info!("Remote-control token rotated or surface disabled; closing remote client.");
                }
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
                if role == BackendRole::Remote
                    && let Some(response) = deny_remote_connection_control(text.as_str())
                {
                    if !send_tracked_reliable_websocket_item(
                        &outgoing_tx,
                        &reliable_metrics,
                        Message::Text(serde_json::to_string(&response).unwrap_or_default().into()),
                        &slow_pressure,
                    )
                    .await
                    {
                        break;
                    }
                    continue;
                }
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

                let accepted = accept_websocket_command(&state, text.to_string());
                if !send_tracked_websocket_item(&command_tx, &command_metrics, accepted).await {
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
    // (Remote client count is decremented by RemoteClientCountGuard's Drop.)
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

async fn apply_active_screen_output(
    state: &AppState,
    active_screen: Option<protocol::StreamScreen>,
) -> Result<()> {
    let legacy_overlay_preparation = {
        let recording = state.recording.lock().await;
        recording
            .as_ref()
            .and_then(recording::ActiveRecording::active_screen_overlay_preparation)
    };
    if let Some(preparation) = legacy_overlay_preparation {
        let image_path = active_screen
            .as_ref()
            .map(|screen| screen.image_path.clone());
        // Image decode/resize and transparent-frame allocation can be tens of
        // milliseconds for a 4K takeover. Keep both off the async worker and,
        // critically, outside `state.recording` so Stop can enter finalization.
        let prepared = tokio::task::spawn_blocking(move || preparation.prepare(image_path))
            .await
            .context("Legacy Screen overlay preparation task stopped")??;
        let commit = {
            let recording = state.recording.lock().await;
            recording.as_ref().map_or(
                recording::PreparedScreenOverlayCommit::Retired,
                |recording| recording.commit_prepared_active_screen(prepared),
            )
        };
        match commit {
            recording::PreparedScreenOverlayCommit::Applied
            | recording::PreparedScreenOverlayCommit::Retired => {}
            recording::PreparedScreenOverlayCommit::Superseded => {
                anyhow::bail!(
                    "The active recording changed while the Screen image was prepared; retry the takeover."
                );
            }
        }
    }
    // Standby preview uses the same compositor. Publish the takeover there
    // before changing the authoritative persisted pointer.
    update_compositor_active_screen(state, active_screen).await;
    Ok(())
}

async fn apply_output_then_persist<T, ApplyOutput, Persist, RollbackOutput, RollbackFuture>(
    apply_output: ApplyOutput,
    persist: Persist,
    rollback_output: RollbackOutput,
) -> Result<T>
where
    ApplyOutput: std::future::Future<Output = Result<()>>,
    Persist: FnOnce() -> Result<T>,
    RollbackOutput: FnOnce() -> RollbackFuture,
    RollbackFuture: std::future::Future<Output = Result<()>>,
{
    // The failure mode this ordering prevents is subtle but dangerous: DB was
    // previously changed first, then a FIFO/image-path failure left
    // screens.active claiming a takeover that never reached the output.
    apply_output.await?;
    match persist() {
        Ok(value) => Ok(value),
        Err(persist_error) => match rollback_output().await {
            Ok(()) => Err(persist_error),
            Err(rollback_error) => Err(anyhow::anyhow!(
                "{persist_error}; output rollback also failed: {rollback_error}"
            )),
        },
    }
}

async fn commit_active_screen_transition<T, Persist>(
    state: &AppState,
    next: Option<protocol::StreamScreen>,
    persist: Persist,
) -> Result<T>
where
    Persist: FnOnce() -> Result<T>,
{
    let _transition = state.active_screen_transition.lock().await;
    let previous = match state.database.active_stream_screen_selection()? {
        storage::ActiveStreamScreenSelection::Ready(screen) => Some(screen),
        storage::ActiveStreamScreenSelection::Inactive
        | storage::ActiveStreamScreenSelection::Unavailable { .. } => None,
    };
    apply_output_then_persist(apply_active_screen_output(state, next), persist, || {
        apply_active_screen_output(state, previous)
    })
    .await
}

async fn delete_stream_screen_transition(state: &AppState, screen_id: &str) -> Result<()> {
    let _transition = state.active_screen_transition.lock().await;
    let (deleting_active, previous) = match state.database.active_stream_screen_selection()? {
        storage::ActiveStreamScreenSelection::Inactive => (false, None),
        storage::ActiveStreamScreenSelection::Ready(screen) => {
            (screen.id == screen_id, Some(screen))
        }
        storage::ActiveStreamScreenSelection::Unavailable {
            screen_id: active_screen_id,
        } => (active_screen_id == screen_id, None),
    };
    if !deleting_active {
        return state.database.delete_stream_screen(screen_id);
    }
    apply_output_then_persist(
        apply_active_screen_output(state, None),
        || state.database.delete_stream_screen(screen_id),
        || apply_active_screen_output(state, previous),
    )
    .await
}

async fn resolve_active_screen_read<ClearOutput, ClearPointer>(
    selection: storage::ActiveStreamScreenSelection,
    clear_output: ClearOutput,
    clear_pointer: ClearPointer,
) -> Result<Option<protocol::StreamScreen>>
where
    ClearOutput: std::future::Future<Output = Result<()>>,
    ClearPointer: FnOnce() -> Result<()>,
{
    match selection {
        storage::ActiveStreamScreenSelection::Inactive => Ok(None),
        storage::ActiveStreamScreenSelection::Ready(screen) => Ok(Some(screen)),
        storage::ActiveStreamScreenSelection::Unavailable { screen_id } => {
            clear_output.await.with_context(|| {
                format!("Could not clear unavailable active Screen {screen_id} from output")
            })?;
            // Do not restore an invalid/tampered path if persistence fails. The
            // output is safely clear and the explicit error lets the next read
            // retry retiring the stale pointer.
            clear_pointer().with_context(|| {
                format!(
                    "Active Screen {screen_id} output was cleared, but its persisted pointer could not be retired"
                )
            })?;
            Ok(None)
        }
    }
}

async fn read_active_screen_transition(state: &AppState) -> Result<Option<protocol::StreamScreen>> {
    let _transition = state.active_screen_transition.lock().await;
    let selection = state.database.active_stream_screen_selection()?;
    let retired_unavailable = matches!(
        &selection,
        storage::ActiveStreamScreenSelection::Unavailable { .. }
    );
    let active =
        resolve_active_screen_read(selection, apply_active_screen_output(state, None), || {
            state.database.clear_active_stream_screen()
        })
        .await?;
    if retired_unavailable {
        state.emit_event(
            "screens.active.changed",
            Option::<protocol::StreamScreen>::None,
        );
    }
    Ok(active)
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

async fn prepare_session_deletions_exclusively(
    state: &AppState,
    session_ids: &[String],
) -> Result<Vec<storage::PendingSessionDeletion>> {
    let _file_mutation = state
        .ffmpeg_work
        .begin_recording_file_mutation_when_available()
        .await;
    state.database.prepare_session_deletions(session_ids)
}

async fn complete_session_deletion_exclusively(
    state: &AppState,
    operation_id: &str,
    failed_paths: &[String],
) -> Result<storage::SessionDeletionCompletion> {
    let _file_mutation = state
        .ffmpeg_work
        .begin_recording_file_mutation_when_available()
        .await;
    state
        .database
        .complete_session_deletion(operation_id, failed_paths)
}

async fn pending_session_deletions_exclusively(
    state: &AppState,
) -> Result<Vec<storage::PendingSessionDeletion>> {
    if !state.database.has_pending_session_deletions()? {
        return Ok(Vec::new());
    }
    let _file_mutation = state
        .ffmpeg_work
        .begin_recording_file_mutation_when_available()
        .await;
    state.database.pending_session_deletions()
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
        #[cfg(debug_assertions)]
        COMMAND_LANE_SMOKE_BLOCK_METHOD | LIVE_CONTROL_RECYCLE_SMOKE_BLOCK_METHOD => {
            if !rpc_params_are_empty(&command.params) {
                ServerResponse::error(
                    command.id,
                    "invalid-params",
                    "The command-lane blocker does not accept parameters.",
                )
            } else {
                match state.command_lane_smoke_blocker.block().await {
                    Ok(generation) => ServerResponse::ok(
                        command.id,
                        serde_json::json!({ "generation": generation, "released": true }),
                    ),
                    Err(active_generation) => ServerResponse::error(
                        command.id,
                        "command-lane-smoke-blocker-active",
                        format!(
                            "Command-lane smoke blocker generation {active_generation} is already active."
                        ),
                    ),
                }
            }
        }
        #[cfg(debug_assertions)]
        COMMAND_LANE_SMOKE_STATUS_METHOD => {
            if !rpc_params_are_empty(&command.params) {
                ServerResponse::error(
                    command.id,
                    "invalid-params",
                    "The command-lane blocker status does not accept parameters.",
                )
            } else {
                let (active, generation, active_generation) =
                    state.command_lane_smoke_blocker.status();
                ServerResponse::ok(
                    command.id,
                    serde_json::json!({
                        "active": active,
                        "generation": generation,
                        "activeGeneration": active_generation,
                    }),
                )
            }
        }
        #[cfg(debug_assertions)]
        COMMAND_LANE_SMOKE_RELEASE_METHOD => {
            if !rpc_params_are_empty(&command.params) {
                ServerResponse::error(
                    command.id,
                    "invalid-params",
                    "The command-lane blocker release does not accept parameters.",
                )
            } else {
                let released_generation = state.command_lane_smoke_blocker.release();
                ServerResponse::ok(
                    command.id,
                    serde_json::json!({
                        "released": released_generation.is_some(),
                        "generation": released_generation,
                    }),
                )
            }
        }
        #[cfg(debug_assertions)]
        CAPTURE_RECOVERY_SMOKE_INJECT_METHOD => {
            if !rpc_params_are_empty(&command.params) {
                ServerResponse::error(
                    command.id,
                    "invalid-params",
                    "The capture-recovery smoke injection does not accept parameters.",
                )
            } else {
                match capture_recovery::arm_camera_delivery_degradation(state).await {
                    Ok(ack) => ServerResponse::ok(command.id, ack),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "capture-recovery-smoke-arm-failed",
                        error,
                    ),
                }
            }
        }
        #[cfg(debug_assertions)]
        CAPTURE_RECOVERY_SMOKE_INJECT_SCREEN_METHOD => {
            if !rpc_params_are_empty(&command.params) {
                ServerResponse::error(
                    command.id,
                    "invalid-params",
                    "The capture-recovery smoke injection does not accept parameters.",
                )
            } else {
                match capture_recovery::arm_screen_delivery_degradation(state).await {
                    Ok(ack) => ServerResponse::ok(command.id, ack),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "capture-recovery-smoke-arm-failed",
                        error,
                    ),
                }
            }
        }
        #[cfg(debug_assertions)]
        CAPTURE_RECOVERY_SMOKE_CAMERA_CADENCE_EVIDENCE_METHOD
        | CAPTURE_RECOVERY_SMOKE_SCREEN_CADENCE_EVIDENCE_METHOD => {
            if !rpc_params_are_empty(&command.params) {
                ServerResponse::error(
                    command.id,
                    "invalid-params",
                    "The capture-recovery cadence evidence request does not accept parameters.",
                )
            } else {
                let source =
                    if command.method == CAPTURE_RECOVERY_SMOKE_CAMERA_CADENCE_EVIDENCE_METHOD {
                        protocol::CaptureRecoverySource::Camera
                    } else {
                        protocol::CaptureRecoverySource::Screen
                    };
                match capture_recovery::capture_recovery_smoke_cadence_evidence(state, source).await
                {
                    Ok(evidence) => ServerResponse::ok(command.id, evidence),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "capture-recovery-smoke-evidence-unavailable",
                        error,
                    ),
                }
            }
        }
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
            let caption_shutdown = clear_account_credentials_after_caption_shutdown(state, || {
                clear_result = Some(clear_account_credentials_fail_closed(
                    || {
                        if entitlements::clear_account_entitlements() {
                            state.emit_event(
                                "entitlements.updated",
                                entitlements::current_entitlements(),
                            );
                        }
                    },
                    account::clear_persisted_account_and_advance_intent,
                ));
            })
            .await;
            if let Err(message) = caption_sign_out_cleanup_result(&caption_shutdown) {
                return ServerResponse::error(
                    command.id,
                    "account-sign-out-caption-cleanup-failed",
                    message,
                );
            }
            if let Some(Err(error)) = clear_result {
                return ServerResponse::error(
                    command.id,
                    "account-sign-out-persist-failed",
                    error.to_string(),
                );
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
            // Capture generation + token atomically with account transitions,
            // release the lock for bounded network I/O, then reacquire it for
            // compare+commit. A stale refresh can never undo sign-out or
            // replace a newer sign-in.
            let captured = {
                let account_transition = state.account_auth_transition.lock().await;
                let captured = state
                    .account_refresh_generation
                    .fetch_update(
                        std::sync::atomic::Ordering::AcqRel,
                        std::sync::atomic::Ordering::Acquire,
                        |generation| generation.checked_add(1),
                    )
                    .map(|previous| previous + 1)
                    .map_err(|_| anyhow::anyhow!("Account refresh generation was exhausted."))
                    .and_then(account::capture_account_refresh_identity);
                drop(account_transition);
                captured
            };
            let prepared = match captured {
                Ok(identity) => Some(
                    tokio::time::timeout(
                        ACCOUNT_REFRESH_TIMEOUT,
                        account::prepare_account_refresh(identity),
                    )
                    .await,
                ),
                Err(error) => {
                    tracing::warn!("Account refresh identity capture failed: {error:#}");
                    None
                }
            };
            let account_transition = state.account_auth_transition.lock().await;
            let current = {
                let session = state.account_session.lock().await;
                account::current_account(session.as_ref())
            };
            let (resolved, committed) = match prepared {
                Some(Ok(prepared)) => match account::commit_account_refresh(
                    prepared,
                    state
                        .account_refresh_generation
                        .load(std::sync::atomic::Ordering::Acquire),
                    || {
                        // This callback runs inside the Unauthorized commit before
                        // durable credentials are deleted. Keep it synchronous and
                        // under account_auth_transition: premium gates read the
                        // hydration directly, so spawning the revocation would
                        // expose a SignedOut/Premium race.
                        if entitlements::clear_account_entitlements() {
                            state.emit_event(
                                "entitlements.updated",
                                entitlements::current_entitlements(),
                            );
                        }
                    },
                ) {
                    Some(resolved) => (resolved, true),
                    None => (current, false),
                },
                Some(Err(_)) => {
                    tracing::warn!("Account refresh exceeded its bounded network deadline.");
                    (current, false)
                }
                None => (current, false),
            };
            *state.account_session.lock().await = Some(resolved.clone());
            drop(account_transition);
            if committed {
                let entitlement_state = state.clone();
                tokio::spawn(async move { refresh_account_entitlements(&entitlement_state).await });
            }
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
        "cohost.status" => ServerResponse::ok(command.id, cohost::cohost_status(state).await),
        "cohost.start" => {
            match serde_json::from_value::<protocol::CohostStartParams>(command.params) {
                Ok(params) => match cohost::start_cohost(state, params).await {
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
        "cohost.stop" => ServerResponse::ok(command.id, cohost::stop_cohost(state).await),
        "cohost.question.answered" => {
            match serde_json::from_value::<protocol::CohostQuestionParams>(command.params) {
                Ok(params) => match cohost::mark_question_answered(state, params).await {
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
        "cohost.question.dismiss" => {
            match serde_json::from_value::<protocol::CohostQuestionParams>(command.params) {
                Ok(params) => match cohost::dismiss_question(state, params).await {
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
        "cohost.flag.dismiss" => {
            match serde_json::from_value::<protocol::CohostFlagParams>(command.params) {
                Ok(params) => match cohost::dismiss_flag(state, params).await {
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
        "cohost.settings.get" => {
            ServerResponse::ok(command.id, cohost::get_cohost_settings(state).await)
        }
        "cohost.settings.set" => {
            match serde_json::from_value::<protocol::CohostSettingsPatch>(command.params) {
                Ok(patch) => match cohost::set_cohost_settings(state, patch).await {
                    Ok(settings) => ServerResponse::ok(command.id, settings),
                    Err(error) => {
                        ServerResponse::error(command.id, error.code(), error.to_string())
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
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
        "capture.recovery.status" => ServerResponse::ok(
            command.id,
            capture_recovery::capture_recovery_status(state).await,
        ),
        "capture.recovery.retry" => {
            if !rpc_params_are_empty(&command.params) {
                ServerResponse::error(
                    command.id,
                    "invalid-params",
                    "Capture recovery retry does not accept parameters.",
                )
            } else {
                ServerResponse::ok(
                    command.id,
                    capture_recovery::retry_capture_recovery(state.clone()).await,
                )
            }
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
                Ok(params) => match create_preview_surface(state.clone(), params).await {
                    Ok(status) => ServerResponse::ok(command.id, status),
                    Err(PreviewSurfaceBusy) => ServerResponse::error(
                        command.id,
                        PreviewSurfaceBusy::CODE,
                        PreviewSurfaceBusy::MESSAGE.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "preview.surface.update_bounds" => {
            match serde_json::from_value::<protocol::PreviewSurfaceBoundsParams>(command.params) {
                Ok(params) => match update_preview_surface_bounds(state, params).await {
                    Ok(status) => ServerResponse::ok(command.id, status),
                    Err(PreviewSurfaceBusy) => ServerResponse::error(
                        command.id,
                        PreviewSurfaceBusy::CODE,
                        PreviewSurfaceBusy::MESSAGE.to_string(),
                    ),
                },
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
        "preview.surface.destroy" => match destroy_preview_surface(state).await {
            Ok(status) => ServerResponse::ok(command.id, status),
            Err(PreviewSurfaceBusy) => ServerResponse::error(
                command.id,
                PreviewSurfaceBusy::CODE,
                PreviewSurfaceBusy::MESSAGE.to_string(),
            ),
        },
        "preview.surface.status" => {
            let status = preview_surface_status(state).await;
            ServerResponse::ok(command.id, status)
        }
        "preview.surface.take_native_host_commands" => {
            let commands = take_native_preview_host_commands(state).await;
            ServerResponse::ok(command.id, commands)
        }
        "resource.admin.preview_surface_bounds" => {
            match serde_json::from_value::<protocol::MainOwnedPreviewSurfaceBoundsParams>(
                command.params,
            ) {
                Ok(params) => match apply_main_owned_preview_surface_bounds(state, params).await {
                    Ok(status) => ServerResponse::ok(command.id, status),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "preview-surface-stacking-rejected",
                        error,
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "remote.control.status" => ServerResponse::ok(command.id, remote_control_status(state)),
        "remote.control.enable" => match enable_remote_control(state) {
            Ok(status) => ServerResponse::ok(command.id, status),
            Err(error) => ServerResponse::error(command.id, "remote-control", error.to_string()),
        },
        "remote.control.disable" => match disable_remote_control(state) {
            Ok(status) => ServerResponse::ok(command.id, status),
            Err(error) => ServerResponse::error(command.id, "remote-control", error.to_string()),
        },
        "remote.control.regenerate" => match regenerate_remote_control_token(state) {
            Ok(status) => ServerResponse::ok(command.id, status),
            Err(error) => ServerResponse::error(command.id, "remote-control", error.to_string()),
        },
        "remote.surface.publish" => {
            // Renderer-published catalog + state projection. The state event
            // is the ONLY payload remote sockets receive (their event filter
            // is locked to remote.state/remote.ack).
            let describe = command.params.get("describe").cloned();
            let state_snapshot = command.params.get("state").cloned();
            if let Ok(mut runtime) = state.remote_control.lock() {
                if let Some(describe) = describe {
                    runtime.describe = Some(describe);
                }
                if let Some(snapshot) = state_snapshot.clone() {
                    runtime.state = Some(snapshot);
                }
            }
            if let Some(snapshot) = state_snapshot {
                state.emit_event("remote.state", snapshot);
            }
            ServerResponse::ok(command.id, serde_json::json!({ "ok": true }))
        }
        "remote.intent.ack" => {
            state.emit_event("remote.ack", command.params);
            ServerResponse::ok(command.id, serde_json::json!({ "ok": true }))
        }
        "remote.describe" => {
            let (describe, snapshot) = state
                .remote_control
                .lock()
                .map(|runtime| (runtime.describe.clone(), runtime.state.clone()))
                .unwrap_or((None, None));
            ServerResponse::ok(
                command.id,
                serde_json::json!({ "describe": describe, "state": snapshot, "protocol": 1 }),
            )
        }
        "remote.intent" => {
            match serde_json::from_value::<crate::remote_control::RemoteIntent>(
                command.params.clone(),
            ) {
                Ok(intent) => {
                    if let Err(message) = intent.validate() {
                        return ServerResponse::error(command.id, "invalid-intent", message);
                    }
                    let ticket = state
                        .remote_control
                        .lock()
                        .map(|mut runtime| runtime.admit_intent(&intent, std::time::Instant::now()))
                        .unwrap_or(crate::remote_control::RemoteIntentTicket {
                            intent_id: String::new(),
                            accepted: false,
                            message: Some("Remote control state unavailable.".to_string()),
                        });
                    if ticket.accepted {
                        state.emit_event(
                            "remote.intent",
                            serde_json::json!({ "intentId": ticket.intent_id, "intent": intent }),
                        );
                    }
                    ServerResponse::ok(command.id, ticket)
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-intent", error.to_string())
                }
            }
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
        "audio.test.disconnect" => {
            let session_id = command
                .params
                .get("sessionId")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            let injector = {
                let recording = state.recording.lock().await;
                recording
                    .as_ref()
                    .filter(|active| active.session_id == session_id)
                    .and_then(|active| active.native_audio.as_ref())
                    .and_then(|native_audio| native_audio.caption_contract_test_injector())
            };
            match injector {
                Some(injector) => ServerResponse::ok(
                    command.id,
                    serde_json::json!({
                        "disconnected": injector.disconnect_source(),
                    }),
                ),
                None => ServerResponse::error(
                    command.id,
                    "caption-contract-test-disabled",
                    "The matching caption contract test microphone session is not active.",
                ),
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
        "stream.output.topology.probe" => {
            match serde_json::from_value::<protocol::StreamOutputTopologyProbeParams>(
                command.params,
            ) {
                Ok(params) => match probe_stream_output_topology(params).await {
                    Ok(result) => ServerResponse::ok(command.id, result),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "stream-output-topology-probe-failed",
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
            match serde_json::from_value::<protocol::SessionListParams>(command.params) {
                Ok(params) => match state
                    .database
                    .list_session_items_page(params.cursor.as_deref(), params.limit)
                {
                    Ok(page) => ServerResponse::ok(command.id, page),
                    Err(error) => {
                        ServerResponse::error(command.id, "sessions-list-failed", error.to_string())
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "sessions.healthEvents.list" => {
            match serde_json::from_value::<protocol::SessionDetailListParams>(command.params) {
                Ok(params) => match state.database.list_health_events_page(
                    &params.session_id,
                    params.cursor.as_deref(),
                    params.limit,
                ) {
                    Ok(page) => ServerResponse::ok(command.id, page),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "session-health-events-list-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "sessions.logs.list" => {
            match serde_json::from_value::<protocol::SessionDetailListParams>(command.params) {
                Ok(params) => match state.database.list_session_logs_page(
                    &params.session_id,
                    params.cursor.as_deref(),
                    params.limit,
                ) {
                    Ok(page) => ServerResponse::ok(command.id, page),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "session-logs-list-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "sessions.aiArtifacts.list" => {
            match serde_json::from_value::<protocol::SessionDetailListParams>(command.params) {
                Ok(params) => match state.database.list_ai_artifacts_page(
                    &params.session_id,
                    params.cursor.as_deref(),
                    params.limit,
                ) {
                    Ok(page) => ServerResponse::ok(command.id, page),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "session-ai-artifacts-list-failed",
                        error.to_string(),
                    ),
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
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
                Ok(params) => {
                    match prepare_session_deletions_exclusively(state, &params.session_ids).await {
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
                    }
                }
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
                Ok(params) => match complete_session_deletion_exclusively(
                    state,
                    &params.operation_id,
                    &params.failed_paths,
                )
                .await
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
                match pending_session_deletions_exclusively(state).await {
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
        "sessions.delete.pending" => match pending_session_deletions_exclusively(state).await {
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
        "liveChat.sendOperations.latest" => {
            let session_id = command
                .params
                .get("sessionId")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if session_id.is_empty() {
                ServerResponse::error(command.id, "invalid-params", "sessionId is required.")
            } else {
                match state.database.latest_chat_send_operation(session_id) {
                    Ok(operation) => ServerResponse::ok(command.id, operation),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "live-chat-send-operation-latest-failed",
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
                    Ok(result) => {
                        // A device grant (Twitch) has no redirect, so nothing
                        // will ever deliver a callback. Drive the SAME
                        // completion path from a background task instead: the
                        // token step waits for the user's approval, and every
                        // downstream step — profile, secrets, account storage,
                        // platformAccounts.changed — is shared with the
                        // redirect flow, so the renderer needs no changes.
                        if result.redirect_uri.is_empty() {
                            let completion_state = state.clone();
                            let callback_state = result.state.clone();
                            tokio::spawn(async move {
                                let outcome = complete_oauth_callback(
                                    &completion_state,
                                    OAuthCompleteParams {
                                        state: callback_state.clone(),
                                        code: None,
                                        error: None,
                                        error_description: None,
                                    },
                                )
                                .await;
                                if !outcome.retryable {
                                    let _ = completion_state.oauth.finish(&callback_state).await;
                                }
                                completion_state
                                    .emit_event("platformAccounts.oauth.callback", outcome);
                            });
                        }
                        ServerResponse::ok(command.id, result)
                    }
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
        "screens.active" => match read_active_screen_transition(state).await {
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
                Ok(params) => {
                    let delete_result =
                        delete_stream_screen_transition(state, &params.screen_id).await;
                    match delete_result {
                        Ok(()) => match state.database.list_stream_screens() {
                            Ok(screens) => {
                                state.emit_event("screens.changed", screens.clone());
                                if let Ok(active) = state.database.active_stream_screen() {
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
                        Err(error) => ServerResponse::error(
                            command.id,
                            "screen-delete-failed",
                            error.to_string(),
                        ),
                    }
                }
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
                Ok(params) => {
                    let screen = match state.database.stream_screen_by_id(&params.screen_id) {
                        Ok(screen) if screen.status == protocol::StreamScreenStatus::Ready => {
                            screen
                        }
                        Ok(_) => {
                            return ServerResponse::error(
                                command.id,
                                "screen-activate-failed",
                                "Screen image is missing and cannot be activated.",
                            );
                        }
                        Err(error) => {
                            return ServerResponse::error(
                                command.id,
                                "screen-activate-failed",
                                error.to_string(),
                            );
                        }
                    };
                    match commit_active_screen_transition(state, Some(screen.clone()), || {
                        state.database.activate_stream_screen(&params.screen_id)
                    })
                    .await
                    {
                        Ok(screen) => {
                            state.emit_event("screens.active.changed", Some(screen.clone()));
                            ServerResponse::ok(command.id, screen)
                        }
                        Err(error) => ServerResponse::error(
                            command.id,
                            "screen-activate-failed",
                            error.to_string(),
                        ),
                    }
                }
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "screens.clear" => {
            match commit_active_screen_transition(state, None, || {
                state.database.clear_active_stream_screen()
            })
            .await
            {
                Ok(()) => {
                    state.emit_event(
                        "screens.active.changed",
                        Option::<protocol::StreamScreen>::None,
                    );
                    ServerResponse::ok(command.id, Option::<protocol::StreamScreen>::None)
                }
                Err(error) => {
                    ServerResponse::error(command.id, "screen-clear-failed", error.to_string())
                }
            }
        }
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
            Ok(params) => match repair_service::restore_file(state.clone(), params).await {
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
        "stream.targets.snapshot" => {
            if !rpc_params_are_empty(&command.params) {
                ServerResponse::error(
                    command.id,
                    "invalid-params",
                    "stream.targets.snapshot does not accept parameters",
                )
            } else {
                match current_stream_targets_snapshot(state).await {
                    Ok(snapshot) => ServerResponse::ok(command.id, snapshot),
                    Err(error) => ServerResponse::error(
                        command.id,
                        "stream-targets-unavailable",
                        error.to_string(),
                    ),
                }
            }
        }
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
) -> captions::CaptionsStatus {
    captions::stop_captions_for_sign_out(state, clear_credentials).await
}

fn caption_sign_out_cleanup_result(
    status: &captions::CaptionsStatus,
) -> std::result::Result<(), String> {
    if status.reason_code.as_deref() == Some("captions-privacy-cleanup-failed") {
        Err(status.message.clone().unwrap_or_else(|| {
            "Private caption artifacts could not be removed; credentials and account state were preserved."
                .to_string()
        }))
    } else {
        Ok(())
    }
}

fn clear_account_credentials_fail_closed<T>(
    revoke_entitlements_and_emit_update: impl FnOnce(),
    clear_credentials: impl FnOnce() -> T,
) -> T {
    // Premium gates read the in-memory hydration without taking the async
    // account-transition lock. Revoke first so another runtime thread cannot
    // authorize Premium after durable credentials have been deleted.
    revoke_entitlements_and_emit_update();
    clear_credentials()
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
#[derive(Debug, Clone, PartialEq, Eq)]
struct AccountEntitlementRefreshIdentity {
    session_token: Option<String>,
    sign_in_intent_generation: u64,
    refresh_generation: u64,
}

enum PreparedAccountEntitlementRefreshOutcome {
    NoStoredSession,
    Capabilities(Box<protocol::AiCapabilities>),
    KeepCached(String),
}

struct PreparedAccountEntitlementRefresh {
    identity: AccountEntitlementRefreshIdentity,
    outcome: PreparedAccountEntitlementRefreshOutcome,
}

/// Capture while holding `AppState.account_auth_transition`.
fn capture_account_entitlement_refresh_identity(
    state: &AppState,
) -> Result<AccountEntitlementRefreshIdentity> {
    let session_token = account::stored_session_token_result()?;
    let sign_in_intent_generation = account::current_sign_in_intent_generation()?;
    let refresh_generation = state
        .account_entitlement_refresh_generation
        .fetch_update(
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
            |generation| generation.checked_add(1),
        )
        .map(|previous| previous + 1)
        .map_err(|_| anyhow::anyhow!("Account entitlement refresh generation was exhausted."))?;
    Ok(AccountEntitlementRefreshIdentity {
        session_token,
        sign_in_intent_generation,
        refresh_generation,
    })
}

/// Read while holding `AppState.account_auth_transition` immediately before
/// hydration/persistence.
fn current_account_entitlement_refresh_identity(
    state: &AppState,
) -> Result<AccountEntitlementRefreshIdentity> {
    Ok(AccountEntitlementRefreshIdentity {
        session_token: account::stored_session_token_result()?,
        sign_in_intent_generation: account::current_sign_in_intent_generation()?,
        refresh_generation: state
            .account_entitlement_refresh_generation
            .load(std::sync::atomic::Ordering::Acquire),
    })
}

async fn prepare_account_entitlement_refresh<Request, RequestFuture>(
    identity: AccountEntitlementRefreshIdentity,
    request: Request,
) -> PreparedAccountEntitlementRefresh
where
    Request: FnOnce(String) -> RequestFuture,
    RequestFuture: std::future::Future<Output = Result<protocol::AiCapabilities>>,
{
    let outcome = match identity.session_token.clone() {
        None => PreparedAccountEntitlementRefreshOutcome::NoStoredSession,
        Some(token) => match request(token).await {
            Ok(capabilities) => {
                PreparedAccountEntitlementRefreshOutcome::Capabilities(Box::new(capabilities))
            }
            Err(error) => PreparedAccountEntitlementRefreshOutcome::KeepCached(error.to_string()),
        },
    };
    PreparedAccountEntitlementRefresh { identity, outcome }
}

fn commit_account_entitlement_refresh_if_current<T>(
    expected: &AccountEntitlementRefreshIdentity,
    current: &AccountEntitlementRefreshIdentity,
    commit: impl FnOnce() -> T,
) -> Option<T> {
    (expected == current).then(commit)
}

fn apply_prepared_account_entitlement_refresh(
    outcome: PreparedAccountEntitlementRefreshOutcome,
) -> bool {
    match outcome {
        PreparedAccountEntitlementRefreshOutcome::NoStoredSession => {
            entitlements::clear_account_entitlements()
        }
        PreparedAccountEntitlementRefreshOutcome::Capabilities(capabilities) => {
            match capabilities.entitlement_token.as_deref() {
                // Prefer the signed token: verified locally, persisted for
                // offline grace until its exp.
                Some(entitlement_token) => {
                    match entitlements::hydrate_account_entitlements_from_token(entitlement_token) {
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
                None => {
                    entitlements::hydrate_account_entitlements(capabilities.entitlement.is_premium)
                }
            }
        }
        PreparedAccountEntitlementRefreshOutcome::KeepCached(error) => {
            tracing::info!("Account entitlement refresh failed (keeping last verified): {error}");
            false
        }
    }
}

async fn refresh_account_entitlements(state: &AppState) {
    // Phase 1: token + sign-in intent + refresh generation are one identity.
    let identity = {
        let transition = state.account_auth_transition.lock().await;
        let identity = capture_account_entitlement_refresh_identity(state);
        drop(transition);
        identity
    };
    let Ok(identity) = identity else {
        tracing::warn!("Account entitlement refresh identity capture failed.");
        return;
    };
    // Phase 2: no auth/entitlement mutation while network I/O is pending.
    let prepared = prepare_account_entitlement_refresh(identity, |token| async move {
        let client = videorc_api::VideorcApiClient::new()?;
        client.get_ai_capabilities(&token).await
    })
    .await;
    // Phase 3: compare+hydrate+persist atomically with sign-in/sign-out. A
    // newer refresh generation also wins for the same token/account.
    let transition = state.account_auth_transition.lock().await;
    let changed = match current_account_entitlement_refresh_identity(state) {
        Ok(current) => {
            commit_account_entitlement_refresh_if_current(&prepared.identity, &current, || {
                apply_prepared_account_entitlement_refresh(prepared.outcome)
            })
            .unwrap_or(false)
        }
        Err(error) => {
            tracing::warn!("Account entitlement refresh commit check failed: {error:#}");
            false
        }
    };
    // Publish while the auth-transition lock still orders this snapshot. A
    // concurrent sign-out must not emit Basic and then be followed by a stale
    // Premium event from the refresh that it superseded.
    if changed {
        state.emit_event("entitlements.updated", entitlements::current_entitlements());
    }
    drop(transition);
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
    let recovery = capture_recovery::capture_recovery_status(state).await;
    let stats = diagnostics::apply_capture_recovery_status(stats, &recovery);
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

    const HARD_EXIT_CHILD_ENV: &str = "VIDEORC_TEST_ZERO_IO_HARD_EXIT";

    struct ScreenOverlayPreparationReleaseGuard(recording::ScreenOverlayPreparationBlocker);

    impl Drop for ScreenOverlayPreparationReleaseGuard {
        fn drop(&mut self) {
            self.0.release();
        }
    }

    fn parse_websocket_rpc_arm_methods(
        source: &str,
    ) -> Result<std::collections::BTreeSet<String>, String> {
        fn resolve_pattern(token: &str) -> Option<&'static str> {
            match token {
                "COMMAND_LANE_SMOKE_BLOCK_METHOD" => Some(COMMAND_LANE_SMOKE_BLOCK_METHOD),
                "COMMAND_LANE_SMOKE_STATUS_METHOD" => Some(COMMAND_LANE_SMOKE_STATUS_METHOD),
                "COMMAND_LANE_SMOKE_RELEASE_METHOD" => Some(COMMAND_LANE_SMOKE_RELEASE_METHOD),
                "LIVE_CONTROL_RECYCLE_SMOKE_BLOCK_METHOD" => {
                    Some(LIVE_CONTROL_RECYCLE_SMOKE_BLOCK_METHOD)
                }
                "CAPTURE_RECOVERY_SMOKE_INJECT_METHOD" => {
                    Some(CAPTURE_RECOVERY_SMOKE_INJECT_METHOD)
                }
                "CAPTURE_RECOVERY_SMOKE_INJECT_SCREEN_METHOD" => {
                    Some(CAPTURE_RECOVERY_SMOKE_INJECT_SCREEN_METHOD)
                }
                "CAPTURE_RECOVERY_SMOKE_CAMERA_CADENCE_EVIDENCE_METHOD" => {
                    Some(CAPTURE_RECOVERY_SMOKE_CAMERA_CADENCE_EVIDENCE_METHOD)
                }
                "CAPTURE_RECOVERY_SMOKE_SCREEN_CADENCE_EVIDENCE_METHOD" => {
                    Some(CAPTURE_RECOVERY_SMOKE_SCREEN_CADENCE_EVIDENCE_METHOD)
                }
                _ => None,
            }
        }

        let mut methods = std::collections::BTreeSet::new();
        let mut pending_pattern = String::new();
        for line in source.lines() {
            let Some(top_level) = line.strip_prefix("        ") else {
                continue;
            };
            if top_level.starts_with(' ') || top_level.starts_with('\t') {
                continue;
            }
            let candidate = top_level.trim();
            if candidate.is_empty()
                || candidate.starts_with("#[")
                || candidate.starts_with("//")
                || matches!(candidate, "}" | "},")
            {
                continue;
            }

            if pending_pattern.is_empty() {
                if candidate.starts_with('"')
                    || candidate.starts_with('|')
                    || candidate
                        .chars()
                        .next()
                        .is_some_and(|first| first.is_ascii_uppercase())
                {
                    pending_pattern.push_str(candidate);
                } else if candidate.contains("=>") {
                    return Err(format!(
                        "unparsed top-level websocket RPC arm pattern: {candidate}"
                    ));
                } else {
                    continue;
                }
            } else if candidate.starts_with('|') {
                pending_pattern.push(' ');
                pending_pattern.push_str(candidate);
            } else {
                return Err(format!(
                    "unterminated websocket RPC arm pattern `{pending_pattern}` before `{candidate}`"
                ));
            }

            let Some((patterns, _body)) = pending_pattern.split_once("=>") else {
                continue;
            };
            for raw_pattern in patterns.split('|') {
                let token = raw_pattern.trim();
                let method = if let Some(literal) = token
                    .strip_prefix('"')
                    .and_then(|literal| literal.strip_suffix('"'))
                {
                    literal.to_string()
                } else {
                    resolve_pattern(token)
                        .ok_or_else(|| format!("unknown websocket RPC arm pattern `{token}`"))?
                        .to_string()
                };
                if !methods.insert(method.clone()) {
                    return Err(format!("duplicate websocket RPC arm `{method}`"));
                }
            }
            pending_pattern.clear();
        }
        if pending_pattern.is_empty() {
            Ok(methods)
        } else {
            Err(format!(
                "unterminated websocket RPC arm pattern `{pending_pattern}`"
            ))
        }
    }

    #[test]
    fn websocket_rpc_inventory_parser_covers_combined_and_multiline_arms() {
        let parsed = parse_websocket_rpc_arm_methods(concat!(
            "        \"one\" | \"two\" => {}\n",
            "        \"three\"\n",
            "        | \"four\" => {}\n",
            "        COMMAND_LANE_SMOKE_BLOCK_METHOD\n",
            "        | CAPTURE_RECOVERY_SMOKE_CAMERA_CADENCE_EVIDENCE_METHOD => {}\n",
        ))
        .expect("combined and multiline RPC arm parser");
        assert_eq!(
            parsed,
            [
                "one",
                "two",
                "three",
                "four",
                COMMAND_LANE_SMOKE_BLOCK_METHOD,
                CAPTURE_RECOVERY_SMOKE_CAMERA_CADENCE_EVIDENCE_METHOD,
            ]
            .into_iter()
            .map(str::to_string)
            .collect()
        );
        assert!(
            parse_websocket_rpc_arm_methods("        future_guard if enabled => {}").is_err(),
            "a new top-level arm shape must fail closed instead of evading inventory"
        );
    }

    #[test]
    fn backend_runtime_reserves_a_worker_for_shutdown_progress() {
        assert!(
            backend_runtime_worker_threads() >= 2,
            "one blocked live-control worker must not starve shutdown/finalization"
        );
    }

    #[test]
    fn backend_publishes_authenticated_process_ownership_before_ready() {
        let token = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let marker = backend_process_ownership_marker(token).expect("ownership marker");
        assert!(marker.starts_with(BACKEND_PROCESS_OWNERSHIP_PREFIX));
        let payload: serde_json::Value = serde_json::from_str(
            marker
                .strip_prefix(BACKEND_PROCESS_OWNERSHIP_PREFIX)
                .expect("ownership prefix"),
        )
        .expect("ownership JSON");
        assert_eq!(payload["token"], token);
        assert_eq!(payload["pid"], std::process::id());
        assert!(backend_process_ownership_marker("not-a-uuid").is_err());
    }

    #[test]
    fn backend_runtime_shutdown_does_not_wait_forever_for_a_blocking_owner() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test runtime");
        let gate = std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let blocked_gate = gate.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (finished_tx, finished_rx) = std::sync::mpsc::sync_channel(1);
        runtime.spawn_blocking(move || {
            entered_tx.send(()).expect("publish blocking owner entry");
            let (released, wake) = &*blocked_gate;
            let mut released = released.lock().expect("blocking owner gate");
            while !*released {
                released = wake.wait(released).expect("blocking owner wait");
            }
            finished_tx.send(()).expect("publish blocking owner exit");
        });
        entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("blocking owner entered");

        let started = Instant::now();
        runtime.shutdown_timeout(Duration::from_millis(20));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "runtime shutdown must remain bounded around an uncooperative blocking owner"
        );

        let (released, wake) = &*gate;
        *released.lock().expect("release blocking owner gate") = true;
        wake.notify_all();
        finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("detached blocking owner exits after release");
    }

    #[tokio::test]
    async fn post_finalization_cleanup_deadline_detaches_without_cancelling_ownership() {
        let entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
        let cleanup_entered = entered.clone();
        let cleanup_release = release.clone();
        let cleanup = async move {
            cleanup_entered.add_permits(1);
            cleanup_release
                .acquire()
                .await
                .expect("cleanup release semaphore")
                .forget();
            let _ = finished_tx.send(());
        };
        let deadline = tokio::spawn(run_process_cleanup_with_deadline(
            cleanup,
            Duration::from_millis(20),
        ));
        entered
            .acquire()
            .await
            .expect("cleanup task entered")
            .forget();

        assert!(
            !deadline.await.expect("cleanup deadline task"),
            "an unfinished cleanup must report its bounded deadline"
        );
        release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), finished_rx)
            .await
            .expect("detached cleanup retains ownership after caller timeout")
            .expect("detached cleanup completion signal");
    }

    #[tokio::test]
    async fn post_finalization_cleanup_deadline_starts_before_compositor_admission() {
        let state = test_state();
        let compositor_admission = state.compositor_lifecycle.clone().lock_owned().await;
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
        let cleanup_state = state.clone();
        let cleanup = async move {
            cleanup_process_owners_after_finalization(cleanup_state).await;
            let _ = finished_tx.send(());
        };

        assert!(
            !run_process_cleanup_with_deadline(cleanup, Duration::from_millis(20)).await,
            "the total cleanup deadline must include compositor lifecycle admission"
        );
        drop(compositor_admission);
        tokio::time::timeout(Duration::from_secs(1), finished_rx)
            .await
            .expect("detached production cleanup completes after admission release")
            .expect("detached production cleanup completion signal");
    }

    #[test]
    fn hard_exit_child_helper() {
        if std::env::var(HARD_EXIT_CHILD_ENV).as_deref() != Ok("1") {
            return;
        }
        std::thread::spawn(|| hard_abort_after_delay(Duration::from_millis(150)));
        // The parent deliberately never drains this pipe. Hold stderr's lock
        // and fill the OS buffer so any logging in the exit thread would block
        // behind either this lock or pipe backpressure forever.
        let stderr = std::io::stderr();
        let mut stderr = stderr.lock();
        let bytes = [b'x'; 64 * 1024];
        loop {
            let _ = stderr.write_all(&bytes);
        }
    }

    #[test]
    fn hard_exit_deadline_does_not_depend_on_a_writable_stderr_pipe() {
        let mut child = std::process::Command::new(std::env::current_exe().expect("test binary"))
            .args(["--exact", "tests::hard_exit_child_helper", "--nocapture"])
            .env(HARD_EXIT_CHILD_ENV, "1")
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn hard-exit child");
        let deadline = Instant::now() + Duration::from_secs(3);
        let status = loop {
            if let Some(status) = child.try_wait().expect("poll hard-exit child") {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("hard-exit child remained blocked on its full stderr pipe");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(
            !status.success(),
            "hard-abort child must terminate abnormally"
        );
    }

    #[test]
    fn live_control_deadline_latches_while_the_only_tokio_worker_is_blocked() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("single-worker Tokio runtime");
        runtime.block_on(async {
            let state = test_state();
            let blocker_state = state.clone();
            tokio::spawn(async move {
                let completion = arm_runtime_independent_mutation_deadline(
                    blocker_state,
                    Duration::from_millis(25),
                )
                .expect("deadline thread");
                // Deliberately block the runtime's only worker. A Tokio timer
                // cannot run here; the OS-thread deadline still must latch.
                std::thread::sleep(Duration::from_millis(150));
                let _ = completion.send(());
            })
            .await
            .expect("blocking handler task");
            assert!(
                state.process_shutdown_requested(),
                "live-control recovery must not depend on Tokio making progress"
            );
        });
    }

    #[test]
    fn live_control_completion_disarms_the_runtime_independent_deadline() {
        let state = test_state();
        let completion =
            arm_runtime_independent_mutation_deadline(state.clone(), Duration::from_millis(75))
                .expect("deadline thread");
        completion.send(()).expect("completion signal");
        std::thread::sleep(Duration::from_millis(150));
        assert!(
            !state.process_shutdown_requested(),
            "a completed live-control command must not trigger a later recycle"
        );
    }

    #[test]
    fn live_control_deadline_thread_failure_latches_shutdown_before_dispatch() {
        let state = test_state();
        let deadline = arm_runtime_independent_mutation_deadline_with(
            state.clone(),
            Duration::from_secs(10),
            |_| Err(std::io::Error::other("simulated thread exhaustion")),
        );
        assert!(deadline.is_none());
        assert!(
            state.process_shutdown_requested(),
            "failure to arm the safety boundary must fail closed"
        );
    }

    #[test]
    fn mutation_executor_creation_failure_latches_without_invoking_handler() {
        let state = test_state();
        let invoked = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handler: WebSocketCommandHandler = {
            let invoked = invoked.clone();
            std::sync::Arc::new(move |_state, _text| {
                invoked.store(true, std::sync::atomic::Ordering::Release);
                Box::pin(async { ServerResponse::ok("unexpected", json!({})) })
            })
        };

        let execution = spawn_websocket_mutation_execution(
            Err("simulated mutation-runtime worker creation failure"),
            state.clone(),
            json!({ "id": "must-not-run", "method": "screens.activate", "params": {} }).to_string(),
            handler,
            (),
            None,
            Duration::from_secs(10),
        );

        assert!(matches!(
            execution,
            Err(WebSocketMutationStartFailure::ExecutorUnavailable)
        ));
        assert!(state.process_shutdown_requested());
        assert!(
            !invoked.load(std::sync::atomic::Ordering::Acquire),
            "an operator handler must never run without an isolated mutation executor"
        );
    }

    #[test]
    fn saturated_mutation_executor_cannot_starve_process_owned_finalization() {
        struct RetentionProbe(std::sync::Arc<std::sync::atomic::AtomicUsize>);

        impl Drop for RetentionProbe {
            fn drop(&mut self) {
                self.0.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            }
        }

        let process_runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("process-owned test runtime");
        process_runtime.block_on(async {
            let state = test_state();
            let executor =
                WebSocketMutationExecutor::new(2).expect("dedicated two-worker mutation executor");
            let (entered_tx, entered_rx) = std::sync::mpsc::channel::<String>();
            let release =
                std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
            let retained = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let handler: WebSocketCommandHandler = {
                let entered_tx = entered_tx.clone();
                let release = release.clone();
                std::sync::Arc::new(move |_state, text| {
                    let entered_tx = entered_tx.clone();
                    let release = release.clone();
                    Box::pin(async move {
                        entered_tx
                            .send(
                                std::thread::current()
                                    .name()
                                    .unwrap_or("unnamed")
                                    .to_string(),
                            )
                            .expect("publish mutation worker entry");
                        let (released, released_signal) = &*release;
                        let mut released = released
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        while !*released {
                            released = released_signal
                                .wait(released)
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                        }
                        ServerResponse::ok(websocket_command_id(text.as_str()), json!({}))
                    })
                })
            };
            let command =
                json!({ "id": "blocked", "method": "screens.activate", "params": {} }).to_string();
            let first = spawn_websocket_mutation_execution(
                Ok(executor.clone()),
                state.clone(),
                command.clone(),
                handler.clone(),
                RetentionProbe(retained.clone()),
                None,
                Duration::from_secs(2),
            )
            .expect("first isolated mutation");
            let second = spawn_websocket_mutation_execution(
                Ok(executor.clone()),
                state.clone(),
                command.clone(),
                handler.clone(),
                RetentionProbe(retained.clone()),
                None,
                Duration::from_secs(2),
            )
            .expect("second isolated mutation");
            for _ in 0..2 {
                let worker_name = entered_rx
                    .recv_timeout(Duration::from_secs(1))
                    .expect("both mutation workers must enter the blocking handler");
                assert_eq!(worker_name, "videorc-mutation-worker");
            }
            // Occupy both workers before submitting the third task. Submitting
            // all three first made the executor free to choose any two, while
            // the assertions incorrectly assumed the third JoinHandle was the
            // queued one.
            let third = spawn_websocket_mutation_execution(
                Ok(executor),
                state.clone(),
                command,
                handler,
                RetentionProbe(retained.clone()),
                None,
                Duration::from_secs(2),
            )
            .expect("queued isolated mutation");
            assert_eq!(
                retained.load(std::sync::atomic::Ordering::Acquire),
                0,
                "blocked mutation tasks must retain their completion owners"
            );

            let finalization_advanced =
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let process_state = state.clone();
            let process_finalization_advanced = finalization_advanced.clone();
            let process_finalization = tokio::spawn(async move {
                process_state.wait_for_process_shutdown_request().await;
                // This yield models the first process-owned asynchronous edge
                // of recording finalization after observing the recycle latch.
                tokio::task::yield_now().await;
                process_finalization_advanced.store(true, std::sync::atomic::Ordering::Release);
            });
            timeout(Duration::from_secs(3), process_finalization)
                .await
                .expect("OS deadline must wake process-owned finalization")
                .expect("process-owned finalization sentinel task");
            assert!(state.process_shutdown_requested());
            assert!(
                finalization_advanced.load(std::sync::atomic::Ordering::Acquire),
                "the process runtime must advance while every mutation worker is blocked"
            );
            assert!(!first.is_finished());
            assert!(!second.is_finished());
            assert!(!third.is_finished());

            let (released, released_signal) = &*release;
            *released
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
            released_signal.notify_all();
            assert!(matches!(
                timeout(Duration::from_secs(1), first)
                    .await
                    .expect("first mutation release")
                    .expect("first mutation task"),
                WebSocketMutationExecutionOutcome::Completed(_)
            ));
            assert!(matches!(
                timeout(Duration::from_secs(1), second)
                    .await
                    .expect("second mutation release")
                    .expect("second mutation task"),
                WebSocketMutationExecutionOutcome::Completed(_)
            ));
            assert!(matches!(
                timeout(Duration::from_secs(1), third)
                    .await
                    .expect("queued mutation release")
                    .expect("queued mutation task"),
                WebSocketMutationExecutionOutcome::NotInvokedAfterShutdown
            ));
            assert_eq!(
                retained.load(std::sync::atomic::Ordering::Acquire),
                3,
                "completion owners release only after their blocked handlers really terminate"
            );
        });
    }

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
        assert_eq!(ACCOUNT_REFRESH_TIMEOUT, Duration::from_secs(8));
        assert!(ACCOUNT_REFRESH_TIMEOUT < Duration::from_secs(10));
    }

    fn entitlement_refresh_identity(
        token: Option<&str>,
        sign_in_intent_generation: u64,
        refresh_generation: u64,
    ) -> AccountEntitlementRefreshIdentity {
        AccountEntitlementRefreshIdentity {
            session_token: token.map(str::to_string),
            sign_in_intent_generation,
            refresh_generation,
        }
    }

    #[test]
    fn account_entitlement_refresh_completion_after_sign_out_is_stale() {
        let expected = entitlement_refresh_identity(Some("account-a"), 7, 1);
        let signed_out = entitlement_refresh_identity(None, 8, 1);
        let committed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let result = commit_account_entitlement_refresh_if_current(&expected, &signed_out, {
            let committed = committed.clone();
            move || committed.store(true, std::sync::atomic::Ordering::Release)
        });
        assert!(result.is_none());
        assert!(!committed.load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn account_entitlement_refresh_completion_cannot_cross_a_new_sign_in() {
        let account_a = entitlement_refresh_identity(Some("account-a"), 7, 1);
        let account_b = entitlement_refresh_identity(Some("account-b"), 8, 2);
        let committed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let result = commit_account_entitlement_refresh_if_current(&account_a, &account_b, {
            let committed = committed.clone();
            move || committed.store(true, std::sync::atomic::Ordering::Release)
        });
        assert!(result.is_none());
        assert!(!committed.load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn older_overlapping_account_entitlement_refresh_completion_cannot_win() {
        let older = entitlement_refresh_identity(Some("account-a"), 7, 1);
        let newer = entitlement_refresh_identity(Some("account-a"), 7, 2);
        let older_committed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let older_result = commit_account_entitlement_refresh_if_current(&older, &newer, {
            let older_committed = older_committed.clone();
            move || older_committed.store(true, std::sync::atomic::Ordering::Release)
        });
        assert!(older_result.is_none());
        assert!(!older_committed.load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(
            commit_account_entitlement_refresh_if_current(&newer, &newer, || "newer"),
            Some("newer")
        );
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

    async fn send_test_websocket_command(
        state: &AppState,
        sender: &mpsc::Sender<WebSocketAcceptedCommand>,
        metrics: &TrackedWebSocketQueueMetrics,
        text: String,
    ) -> bool {
        send_tracked_websocket_item(sender, metrics, accept_websocket_command(state, text)).await
    }

    async fn assert_cross_connection_websocket_command_order(
        first_method: &'static str,
        second_method: &'static str,
    ) {
        let first_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let second_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_first = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let entered = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let handler: WebSocketCommandHandler = {
            let first_entered = first_entered.clone();
            let second_entered = second_entered.clone();
            let release_first = release_first.clone();
            let entered = entered.clone();
            std::sync::Arc::new(move |_state, text| {
                let first_entered = first_entered.clone();
                let second_entered = second_entered.clone();
                let release_first = release_first.clone();
                let entered = entered.clone();
                Box::pin(async move {
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    entered.lock().await.push(command.id.clone());
                    if command.id == "first" {
                        first_entered.add_permits(1);
                        release_first.acquire().await.unwrap().forget();
                    } else if command.id == "second" {
                        second_entered.add_permits(1);
                    }
                    ServerResponse::ok(command.id, json!({}))
                })
            })
        };
        let (first_tx, first_rx) = mpsc::channel(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
        let (second_tx, second_rx) = mpsc::channel(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
        let (first_outgoing_tx, mut first_outgoing_rx) =
            mpsc::channel(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
        let (second_outgoing_tx, mut second_outgoing_rx) =
            mpsc::channel(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let first_connection = transport.register_connection();
        let first_metrics = first_connection.incoming_command_queue;
        let first_reliable_metrics = first_connection.reliable_response_queue;
        let second_connection = transport.register_connection();
        let second_metrics = second_connection.incoming_command_queue;
        let second_reliable_metrics = second_connection.reliable_response_queue;
        let (first_pressure_tx, _first_pressure_rx) = mpsc::channel(1);
        let first_pressure = WebSocketSlowPressureSignal::new(first_pressure_tx, transport.clone());
        let (second_pressure_tx, _second_pressure_rx) = mpsc::channel(1);
        let second_pressure =
            WebSocketSlowPressureSignal::new(second_pressure_tx, transport.clone());
        let state = test_state();

        // Accept the first command on the old socket before its dispatcher can
        // dequeue it. The new socket must honor that intake order even though
        // its own dispatcher is already running.
        assert!(
            send_test_websocket_command(
                &state,
                &first_tx,
                &first_metrics,
                json!({ "id": "first", "method": first_method, "params": {} }).to_string(),
            )
            .await
        );
        let second_dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            second_rx,
            second_metrics.clone(),
            second_outgoing_tx,
            second_reliable_metrics.clone(),
            second_pressure,
            handler.clone(),
        ));
        assert!(
            send_test_websocket_command(
                &state,
                &second_tx,
                &second_metrics,
                json!({ "id": "second", "method": second_method, "params": {} }).to_string(),
            )
            .await
        );
        timeout(Duration::from_secs(1), async {
            while transport.snapshot().incoming_command_queue.current_depth != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("new socket should dequeue its command and reach the global intake fence");
        assert!(
            timeout(Duration::from_millis(50), second_entered.acquire())
                .await
                .is_err(),
            "{second_method} must not overtake prior {first_method} accepted on another socket"
        );

        let first_dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state,
            first_rx,
            first_metrics.clone(),
            first_outgoing_tx,
            first_reliable_metrics.clone(),
            first_pressure,
            handler,
        ));
        timeout(Duration::from_secs(1), first_entered.acquire())
            .await
            .expect("old-socket command should dispatch once its dispatcher starts")
            .unwrap()
            .forget();
        assert!(
            timeout(Duration::from_millis(50), second_entered.acquire())
                .await
                .is_err(),
            "{second_method} must wait until prior {first_method} completes"
        );

        release_first.add_permits(1);
        timeout(Duration::from_secs(1), second_entered.acquire())
            .await
            .expect("new-socket command should dispatch after the prior command completes")
            .unwrap()
            .forget();
        drop(first_tx);
        drop(second_tx);
        first_dispatcher.await.unwrap();
        second_dispatcher.await.unwrap();
        let first_response =
            receive_tracked_json(&mut first_outgoing_rx, &first_reliable_metrics).await;
        let second_response =
            receive_tracked_json(&mut second_outgoing_rx, &second_reliable_metrics).await;
        assert_eq!(first_response["id"], "first");
        assert_eq!(first_response["ok"], true);
        assert_eq!(second_response["id"], "second");
        assert_eq!(second_response["ok"], true);
        assert_eq!(*entered.lock().await, ["first", "second"]);
    }

    async fn assert_session_start_waits_for_source_tail_after_response(across_reconnect: bool) {
        let source_transition = std::sync::Arc::new(tokio::sync::Mutex::new(None));
        let session_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let handler: WebSocketCommandHandler = {
            let source_transition = source_transition.clone();
            let session_entered = session_entered.clone();
            std::sync::Arc::new(move |state, text| {
                let source_transition = source_transition.clone();
                let session_entered = session_entered.clone();
                Box::pin(async move {
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    match command.id.as_str() {
                        "source" => {
                            *source_transition.lock().await =
                                Some(state.source_transition_fence.begin());
                        }
                        "session" => {
                            crate::recording::test_admit_session_start_and_release(&state)
                                .await
                                .expect("test session-start admission");
                            session_entered.add_permits(1);
                        }
                        _ => unreachable!("unexpected source-tail test command"),
                    }
                    ServerResponse::ok(command.id, json!({}))
                })
            })
        };

        let (first_tx, first_rx) = mpsc::channel(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
        let (second_tx, second_rx) = mpsc::channel(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
        let (first_outgoing_tx, mut first_outgoing_rx) =
            mpsc::channel(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
        let (second_outgoing_tx, mut second_outgoing_rx) =
            mpsc::channel(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let first_connection = transport.register_connection();
        let first_metrics = first_connection.incoming_command_queue;
        let first_reliable_metrics = first_connection.reliable_response_queue;
        let second_connection = transport.register_connection();
        let second_metrics = second_connection.incoming_command_queue;
        let second_reliable_metrics = second_connection.reliable_response_queue;
        let (first_pressure_tx, _first_pressure_rx) = mpsc::channel(1);
        let first_pressure = WebSocketSlowPressureSignal::new(first_pressure_tx, transport.clone());
        let (second_pressure_tx, _second_pressure_rx) = mpsc::channel(1);
        let second_pressure = WebSocketSlowPressureSignal::new(second_pressure_tx, transport);
        let state = test_state();
        let first_dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            first_rx,
            first_metrics.clone(),
            first_outgoing_tx,
            first_reliable_metrics.clone(),
            first_pressure,
            handler.clone(),
        ));
        let second_dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            second_rx,
            second_metrics.clone(),
            second_outgoing_tx,
            second_reliable_metrics.clone(),
            second_pressure,
            handler,
        ));

        assert!(
            send_test_websocket_command(
                &state,
                &first_tx,
                &first_metrics,
                json!({ "id": "source", "method": "preview.camera.start", "params": {} })
                    .to_string(),
            )
            .await
        );
        let (session_tx, session_metrics) = if across_reconnect {
            (&second_tx, &second_metrics)
        } else {
            (&first_tx, &first_metrics)
        };
        assert!(
            send_test_websocket_command(
                &state,
                session_tx,
                session_metrics,
                json!({ "id": "session", "method": "session.start", "params": {} }).to_string(),
            )
            .await
        );

        let source_response = timeout(
            Duration::from_secs(1),
            receive_tracked_json(&mut first_outgoing_rx, &first_reliable_metrics),
        )
        .await
        .expect("the bounded source command response must complete");
        assert_eq!(source_response["id"], "source");
        assert_eq!(source_response["ok"], true);
        assert!(
            timeout(Duration::from_millis(50), session_entered.acquire())
                .await
                .is_err(),
            "session.start must remain behind the process-owned source tail after its command response"
        );

        drop(
            source_transition
                .lock()
                .await
                .take()
                .expect("source transition guard"),
        );
        timeout(Duration::from_secs(1), session_entered.acquire())
            .await
            .expect("session.start should enter after exact source completion")
            .unwrap()
            .forget();
        let session_response = if across_reconnect {
            timeout(
                Duration::from_secs(1),
                receive_tracked_json(&mut second_outgoing_rx, &second_reliable_metrics),
            )
            .await
            .expect("reconnected session.start response")
        } else {
            timeout(
                Duration::from_secs(1),
                receive_tracked_json(&mut first_outgoing_rx, &first_reliable_metrics),
            )
            .await
            .expect("same-socket session.start response")
        };
        assert_eq!(session_response["id"], "session");
        assert_eq!(session_response["ok"], true);

        drop(first_tx);
        drop(second_tx);
        first_dispatcher.await.unwrap();
        second_dispatcher.await.unwrap();
    }

    #[tokio::test]
    async fn websocket_same_socket_session_start_waits_for_source_tail_after_response() {
        assert_session_start_waits_for_source_tail_after_response(false).await;
    }

    #[tokio::test]
    async fn websocket_reconnected_session_start_waits_for_source_tail_after_response() {
        assert_session_start_waits_for_source_tail_after_response(true).await;
    }

    async fn assert_active_screen_output_failure_prevents_persist(operation: &str) {
        let persisted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let rollback_called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let result: Result<()> = apply_output_then_persist(
            async { Err(anyhow::anyhow!("injected {operation} output failure")) },
            {
                let persisted = persisted.clone();
                move || {
                    persisted.store(true, std::sync::atomic::Ordering::Release);
                    Ok(())
                }
            },
            {
                let rollback_called = rollback_called.clone();
                move || async move {
                    rollback_called.store(true, std::sync::atomic::Ordering::Release);
                    Ok(())
                }
            },
        )
        .await;
        assert!(result.is_err());
        assert!(
            !persisted.load(std::sync::atomic::Ordering::Acquire),
            "{operation} must not mutate screens.active until output apply succeeds"
        );
        assert!(
            !rollback_called.load(std::sync::atomic::Ordering::Acquire),
            "there is no persisted transition to roll back when output apply fails"
        );
    }

    #[tokio::test]
    async fn screens_activate_output_failure_cannot_leave_database_ahead_of_output() {
        assert_active_screen_output_failure_prevents_persist("activate").await;
    }

    #[tokio::test]
    async fn screens_clear_output_failure_cannot_leave_database_ahead_of_output() {
        assert_active_screen_output_failure_prevents_persist("clear").await;
    }

    #[tokio::test]
    async fn screens_delete_active_output_failure_cannot_leave_database_ahead_of_output() {
        assert_active_screen_output_failure_prevents_persist("delete-active").await;
    }

    #[tokio::test]
    async fn legacy_screen_decode_does_not_block_recording_finalization_intent() {
        let state = test_state();
        let blocker = recording::ScreenOverlayPreparationBlocker::new();
        let _release_on_panic = ScreenOverlayPreparationReleaseGuard(blocker.clone());
        let mut active = recording::test_active_recording_stub("screen-decode-stop");
        active.screen_overlay = Some(recording::ScreenOverlaySession::test_stub(
            2,
            2,
            blocker.clone(),
        ));
        *state.recording.lock().await = Some(active);

        let image_path =
            std::env::temp_dir().join(format!("videorc-screen-decode-stop-{}.png", Uuid::new_v4()));
        image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255]))
            .save(&image_path)
            .expect("write takeover test image");
        let active_screen = protocol::StreamScreen {
            id: "screen-decode-stop".to_string(),
            name: "Stop-safe takeover".to_string(),
            image_path: image_path.display().to_string(),
            thumbnail_path: None,
            sort_order: 0,
            status: protocol::StreamScreenStatus::Ready,
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        let apply_state = state.clone();
        let applying = tokio::spawn(async move {
            apply_active_screen_output(&apply_state, Some(active_screen)).await
        });
        timeout(Duration::from_secs(1), async {
            while !blocker.entered() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Screen preparation must reach the deterministic blocker");

        let stop_state = state.clone();
        let stopping = tokio::spawn(async move { stop_recording(stop_state).await });
        timeout(Duration::from_secs(1), async {
            loop {
                let recording = state.recording.lock().await;
                if recording.as_ref().is_some_and(|active| {
                    active.stop_requested
                        && active.pipeline.status().finalization
                            == protocol::RecordingFinalizationState::Finalizing
                }) {
                    break;
                }
                drop(recording);
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Stop must publish finalization intent before Screen decode is released");

        {
            let recording = state.recording.lock().await;
            let frame = recording
                .as_ref()
                .and_then(|active| active.screen_overlay.as_ref())
                .expect("legacy overlay remains installed until finalization")
                .test_current_frame();
            assert!(
                frame.iter().all(|byte| *byte == 0),
                "the frame prepared for a stopping generation must not commit"
            );
        }

        blocker.release();
        timeout(Duration::from_secs(1), applying)
            .await
            .expect("Screen apply must settle after preparation is released")
            .expect("Screen apply task")
            .expect("a retired legacy target should not block standby takeover state");

        stopping.abort();
        let _ = stopping.await;
        state.recording.lock().await.take();
        std::fs::remove_file(image_path).expect("remove takeover test image");
    }

    #[tokio::test]
    async fn screens_active_reconciliation_retires_stale_output_before_returning_inactive() {
        let stale_output = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let persisted_pointer = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let stale_output_for_clear = stale_output.clone();
        let stale_output_for_persist = stale_output.clone();
        let persisted_pointer_for_clear = persisted_pointer.clone();

        let active = resolve_active_screen_read(
            storage::ActiveStreamScreenSelection::Unavailable {
                screen_id: "missing-screen".to_string(),
            },
            async move {
                stale_output_for_clear.store(false, std::sync::atomic::Ordering::Release);
                Ok(())
            },
            move || {
                assert!(
                    !stale_output_for_persist.load(std::sync::atomic::Ordering::Acquire),
                    "screens.active must clear the stale takeover output before retiring its pointer"
                );
                persisted_pointer_for_clear
                    .store(false, std::sync::atomic::Ordering::Release);
                Ok(())
            },
        )
        .await
        .unwrap();

        assert!(active.is_none());
        assert!(!stale_output.load(std::sync::atomic::Ordering::Acquire));
        assert!(!persisted_pointer.load(std::sync::atomic::Ordering::Acquire));
    }

    #[tokio::test]
    async fn screens_active_retirement_persist_failure_remains_fail_closed_and_explicit() {
        let stale_output = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let stale_output_for_clear = stale_output.clone();

        let error = resolve_active_screen_read(
            storage::ActiveStreamScreenSelection::Unavailable {
                screen_id: "tampered-screen".to_string(),
            },
            async move {
                stale_output_for_clear.store(false, std::sync::atomic::Ordering::Release);
                Ok(())
            },
            || Err(anyhow::anyhow!("injected pointer failure")),
        )
        .await
        .unwrap_err();

        assert!(!stale_output.load(std::sync::atomic::Ordering::Acquire));
        assert!(error.to_string().contains("output was cleared"));
        assert!(error.to_string().contains("persisted pointer"));
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
        assert!(!websocket_event_is_coalescible("cohost.state"));
        assert!(!websocket_event_is_coalescible("recording.status"));
        assert!(!websocket_event_is_coalescible("screens.changed"));
        assert!(!websocket_event_is_coalescible("session.log"));
        assert!(!websocket_event_is_coalescible(
            "platformAccounts.oauth.callback"
        ));
    }

    #[test]
    fn websocket_authoritative_reconciliation_reads_use_the_observation_lane() {
        for method in [
            "account.get",
            "captions.status.get",
            "comments.highlight.status",
            "scene.get",
            "liveChat.status",
            "liveChat.sendOperations.list",
            "liveChat.sendOperations.latest",
            "screens.list",
            "recording.status",
            "capture.recovery.status",
            CAPTURE_RECOVERY_SMOKE_CAMERA_CADENCE_EVIDENCE_METHOD,
            CAPTURE_RECOVERY_SMOKE_SCREEN_CADENCE_EVIDENCE_METHOD,
        ] {
            let command = json!({ "id": method, "method": method, "params": {} }).to_string();
            assert!(
                websocket_command_is_read_only(command.as_str()),
                "{method} must reconcile independently from mutations"
            );
        }
        let recovery_status =
            json!({ "id": "recovery", "method": "capture.recovery.status", "params": {} })
                .to_string();
        assert!(
            websocket_observation_requires_operator_fence(recovery_status.as_str()),
            "recovery status must reconcile after accepted operator retries"
        );
        for method in ["screens.active", "screens.activate"] {
            assert!(
                !websocket_command_is_read_only(
                    json!({ "id": method, "method": method, "params": {} })
                        .to_string()
                        .as_str()
                ),
                "{method} can change authoritative takeover state and must use mutation execution"
            );
        }
    }

    #[test]
    fn websocket_handler_execution_policy_inventory_is_exhaustive() {
        for method in [
            "screens.active",
            "screens.activate",
            "screens.clear",
            "screens.delete",
            "captions.start",
            "captions.stop",
            "captions.style.set",
            "comments.highlight.set",
            "comments.highlight.clear",
            "capture.recovery.retry",
            CAPTURE_RECOVERY_SMOKE_INJECT_METHOD,
            CAPTURE_RECOVERY_SMOKE_INJECT_SCREEN_METHOD,
            LIVE_CONTROL_RECYCLE_SMOKE_BLOCK_METHOD,
        ] {
            let command = json!({ "id": method, "method": method, "params": {} }).to_string();
            assert_eq!(
                websocket_isolated_command_lane(command.as_str()),
                Some(WebSocketIsolatedCommandLaneKind::LiveControl),
                "{method} must not wait behind maintenance or background mutations"
            );
            assert!(
                websocket_command_mutation_max_execution_age(command.as_str()).is_some(),
                "{method} must recycle a generation that stops replying after dispatch"
            );
        }

        let durable_chat =
            json!({ "id": "chat", "method": "liveChat.send", "params": {} }).to_string();
        assert_eq!(
            websocket_isolated_command_lane(durable_chat.as_str()),
            Some(WebSocketIsolatedCommandLaneKind::DurableChat)
        );
        assert!(websocket_command_mutation_max_execution_age(durable_chat.as_str()).is_some());

        for method in ["scene.layout.apply_live", "scene.layout.apply_preview"] {
            let command = json!({
                "id": method,
                "method": method,
                "params": { "intentId": 1 }
            })
            .to_string();
            assert_eq!(
                websocket_isolated_command_lane(command.as_str()),
                None,
                "{method} must retain the ordered dispatcher's latest-wins overlap path"
            );
            assert!(
                websocket_command_is_authoritative_scene_mutation(command.as_str()),
                "{method} must fence authoritative observations and session starts"
            );
            assert!(
                websocket_command_may_overlap(command.as_str()),
                "{method} with an intentId must be eligible for concurrent latest-wins dispatch"
            );
            assert_eq!(
                websocket_command_mutation_max_execution_age(command.as_str()),
                Some(WEBSOCKET_LIVE_LAYOUT_MAX_EXECUTION_AGE),
                "{method} must retain its complete warm-source budget behind an independent execution deadline"
            );
        }

        for method in [
            "scene.load_from_capture_config",
            "scene.source.device.switch",
            "scene.source.transform.update",
            "scene.source.transform.reset",
            "scene.source.visibility.update",
            "scene.source.nudge",
            "scene.sources.reorder",
        ] {
            let command = json!({
                "id": method,
                "method": method,
                "params": { "intentId": 1 }
            })
            .to_string();
            assert!(
                websocket_command_is_authoritative_scene_mutation(command.as_str()),
                "{method} must fence authoritative observations and session starts"
            );
            assert!(
                !websocket_command_may_overlap(command.as_str()),
                "{method} must remain serialized even if an unrelated intentId is present"
            );
            let expected_execution_age = if method == "scene.source.device.switch" {
                WEBSOCKET_LIVE_LAYOUT_MAX_EXECUTION_AGE
            } else {
                WEBSOCKET_MUTATION_MAX_EXECUTION_AGE
            };
            assert_eq!(
                websocket_command_mutation_max_execution_age(command.as_str()),
                Some(expected_execution_age),
                "{method} must recycle only after its legitimate execution budget"
            );
        }

        for method in [
            "preview.camera.start",
            "preview.camera.stop",
            "preview.screen.start",
            "preview.screen.stop",
        ] {
            let command = json!({ "id": method, "method": method, "params": {} }).to_string();
            assert!(
                websocket_command_is_authoritative_source_mutation(command.as_str()),
                "{method} must order native source ownership against session.start"
            );
            assert_eq!(
                websocket_isolated_command_lane(command.as_str()),
                None,
                "{method} must retain its ordered command lane"
            );
            assert!(
                websocket_command_mutation_max_execution_age(command.as_str()).is_some(),
                "{method} must recycle a generation that stops replying after dispatch"
            );
        }

        let audio_processing =
            json!({ "id": "audio", "method": "audio.processing.update", "params": {} }).to_string();
        assert!(websocket_command_mutation_max_execution_age(audio_processing.as_str()).is_some());
        let account_refresh =
            json!({ "id": "account", "method": "account.refresh", "params": {} }).to_string();
        assert_eq!(
            websocket_command_mutation_max_execution_age(account_refresh.as_str()),
            Some(WEBSOCKET_PROVIDER_MUTATION_MAX_EXECUTION_AGE),
            "bounded provider maintenance is stateful and must use isolated mutation execution"
        );

        for method in [
            "screens.importImage",
            "sessions.delete",
            "sessions.delete.complete",
        ] {
            assert_eq!(
                websocket_method_execution_policy(method),
                Some(WebSocketMethodExecutionPolicy::Mutation {
                    max_execution_age: WEBSOCKET_FILE_MUTATION_MAX_EXECUTION_AGE,
                }),
                "{method} must finish or become outcome-unknown before the renderer's 45-second envelope"
            );
        }
        for method in ["sessions.delete.resolve", "sessions.delete.pending"] {
            assert_eq!(
                websocket_method_execution_policy(method),
                Some(WebSocketMethodExecutionPolicy::Observation),
                "{method} only observes a durable deletion operation"
            );
        }

        // Inventory the actual top-level RPC arms rather than maintaining a
        // second hand-copied list which could silently miss a future method.
        // The parser handles literal and named-constant alternatives, including
        // multiline arms, and fails closed on every unknown top-level arm shape.
        let source = include_str!("main.rs");
        let handler_source = source
            .split_once("let mut response = match command.method.as_str() {")
            .expect("websocket RPC dispatch start")
            .1
            .split_once("\n        method => ServerResponse::error(")
            .expect("websocket RPC fallback arm")
            .0;
        let methods = parse_websocket_rpc_arm_methods(handler_source)
            .expect("every top-level websocket RPC arm must be inventory-readable");
        assert!(
            methods.len() >= 175,
            "the source-derived RPC inventory unexpectedly shrank: {methods:?}"
        );

        let mut lifecycle_exemptions = Vec::new();
        for method in methods {
            let command = json!({ "id": method, "method": method, "params": {} }).to_string();
            let policy = websocket_method_execution_policy(method.as_str())
                .unwrap_or_else(|| panic!("RPC {method} has no execution policy"));
            match policy {
                WebSocketMethodExecutionPolicy::Mutation { max_execution_age } => {
                    assert!(
                        !websocket_command_is_read_only(command.as_str()),
                        "state-changing RPC {method} must not bypass mutation execution through the observation fast path"
                    );
                    assert_eq!(
                        websocket_command_mutation_max_execution_age(command.as_str()),
                        Some(max_execution_age),
                        "state-changing RPC {method} must use its inventoried isolated execution deadline"
                    );
                }
                WebSocketMethodExecutionPolicy::Observation => {
                    assert!(
                        websocket_command_is_read_only(command.as_str()),
                        "observation RPC {method} must use the concurrent observation path"
                    );
                    assert_eq!(
                        websocket_command_mutation_max_execution_age(command.as_str()),
                        None,
                        "observation RPC {method} must not arm an outcome-unknown mutation deadline"
                    );
                }
                WebSocketMethodExecutionPolicy::SessionLifecycle => {
                    assert!(
                        websocket_command_has_session_lifecycle_policy(command.as_str()),
                        "{method} must document its stronger session lifecycle ownership"
                    );
                    assert_eq!(
                        websocket_command_mutation_max_execution_age(command.as_str()),
                        None,
                        "{method} must retain its stronger fail-closed lifecycle contract"
                    );
                    lifecycle_exemptions.push(method);
                }
            }
        }
        lifecycle_exemptions.sort_unstable();
        assert_eq!(
            lifecycle_exemptions,
            [
                "recording.start_test",
                "recording.stop",
                "session.start",
                "session.stop",
            ]
            .map(str::to_string)
            .to_vec(),
            "only atomic Start and fail-closed recording finalization may bypass generic mutation deadlines"
        );
    }

    #[test]
    fn websocket_provider_validation_uses_the_account_maintenance_lane() {
        for method in [
            "account.refresh",
            "entitlements.refresh",
            "platformAccounts.refresh",
            "platformAccounts.validate",
            COMMAND_LANE_SMOKE_BLOCK_METHOD,
        ] {
            let command = json!({ "id": method, "method": method, "params": {} }).to_string();
            assert_eq!(
                websocket_isolated_command_lane(command.as_str()),
                Some(WebSocketIsolatedCommandLaneKind::AccountMaintenance),
                "{method} must not block operator commands"
            );
        }
    }

    #[test]
    fn capture_recovery_rpc_authority_matches_renderer_operator_surface() {
        for role in [BackendRole::Renderer, BackendRole::Admin] {
            for method in ["capture.recovery.status", "capture.recovery.retry"] {
                assert_eq!(
                    authorize_backend_method(role, method, false),
                    Ok(()),
                    "{method} must be available to the trusted desktop operator"
                );
            }
        }
        for method in ["capture.recovery.status", "capture.recovery.retry"] {
            assert_eq!(
                authorize_backend_method(BackendRole::Remote, method, false),
                Err(backend_authority::MethodAdmissionError::AdminOnly),
                "remote-control peers must not gain capture-recovery authority"
            );
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn capture_recovery_smoke_injection_is_trusted_debug_smoke_only() {
        for method in [
            CAPTURE_RECOVERY_SMOKE_INJECT_METHOD,
            CAPTURE_RECOVERY_SMOKE_INJECT_SCREEN_METHOD,
        ] {
            for role in [BackendRole::Admin, BackendRole::Renderer] {
                assert_eq!(authorize_backend_method(role, method, true), Ok(()));
                assert_eq!(
                    authorize_backend_method(role, method, false),
                    Err(backend_authority::MethodAdmissionError::SmokeDisabled)
                );
            }
            assert_eq!(
                authorize_backend_method(BackendRole::Remote, method, true),
                Err(backend_authority::MethodAdmissionError::AdminOnly)
            );
        }
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn capture_recovery_smoke_injection_arms_natural_generation_bound_detector() {
        let mut state = test_state();
        state.smoke_rpc_enabled = true;
        let rejected = handle_text_message_with_role(
            &state,
            &json!({
                "id": "inject-with-params",
                "method": CAPTURE_RECOVERY_SMOKE_INJECT_METHOD,
                "params": { "source": "camera" }
            })
            .to_string(),
            BackendRole::Renderer,
        )
        .await;
        assert!(!rejected.ok);
        assert_eq!(rejected.error.unwrap().code, "invalid-params");

        let no_camera = handle_text_message_with_role(
            &state,
            &json!({
                "id": "inject",
                "method": CAPTURE_RECOVERY_SMOKE_INJECT_METHOD,
                "params": {}
            })
            .to_string(),
            BackendRole::Renderer,
        )
        .await;
        assert!(!no_camera.ok);
        assert_eq!(
            no_camera.error.unwrap().code,
            "capture-recovery-smoke-arm-failed"
        );

        let layout = protocol::default_layout_settings();
        let video = protocol::VideoSettings {
            preset: protocol::VideoPreset::Custom,
            width: 8,
            height: 4,
            fps: 30,
            bitrate_kbps: 2_000,
        };
        crate::preview_camera::test_install_live_camera_for_layout(
            &state,
            "camera:test",
            &layout,
            &video,
        )
        .await;
        let camera = crate::preview_camera::preview_camera_restart_snapshot(&state)
            .await
            .expect("test camera generation");
        let camera_epoch = crate::capture_health::CaptureHealthCameraEpoch {
            source_key: camera.source_key,
            generation: camera.generation,
        };
        let arm_state = state.clone();
        let arm = tokio::spawn(async move {
            handle_text_message_with_role(
                &arm_state,
                &json!({
                    "id": "inject-live",
                    "method": CAPTURE_RECOVERY_SMOKE_INJECT_METHOD,
                    "params": {}
                })
                .to_string(),
                BackendRole::Renderer,
            )
            .await
        });
        timeout(Duration::from_secs(1), async {
            loop {
                if capture_recovery::apply_camera_delivery_smoke_fault(
                    &state,
                    &camera_epoch,
                    1,
                    1,
                    1,
                )
                .is_some()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("smoke RPC must arm the exact camera generation");
        let armed = arm.await.expect("capture-recovery smoke RPC task");
        assert!(armed.ok);
        let payload = armed.payload.unwrap();
        assert_eq!(payload["armed"], true);
        assert!(payload["faultId"].as_u64().unwrap() > 0);
        assert!(payload["sourceGeneration"].as_u64().unwrap() > 0);
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn screen_capture_recovery_smoke_injection_arms_natural_generation_bound_detector() {
        let mut state = test_state();
        state.smoke_rpc_enabled = true;
        let rejected = handle_text_message_with_role(
            &state,
            &json!({
                "id": "inject-screen-with-params",
                "method": CAPTURE_RECOVERY_SMOKE_INJECT_SCREEN_METHOD,
                "params": { "source": "screen" }
            })
            .to_string(),
            BackendRole::Renderer,
        )
        .await;
        assert!(!rejected.ok);
        assert_eq!(rejected.error.unwrap().code, "invalid-params");

        let no_screen = handle_text_message_with_role(
            &state,
            &json!({
                "id": "inject-screen",
                "method": CAPTURE_RECOVERY_SMOKE_INJECT_SCREEN_METHOD,
                "params": {}
            })
            .to_string(),
            BackendRole::Renderer,
        )
        .await;
        assert!(!no_screen.ok);
        assert_eq!(
            no_screen.error.unwrap().code,
            "capture-recovery-smoke-arm-failed"
        );

        let video = protocol::VideoSettings {
            preset: protocol::VideoPreset::Custom,
            width: 8,
            height: 4,
            fps: 30,
            bitrate_kbps: 2_000,
        };
        crate::preview_screen::test_install_live_screen_generation(
            &state,
            "screen:screencapturekit:test",
            41,
            1,
            &video,
        )
        .await;
        let screen = crate::preview_screen::preview_screen_restart_snapshot(&state)
            .await
            .expect("test ScreenCaptureKit generation");
        let screen_epoch = crate::capture_health::CaptureHealthScreenEpoch {
            source_key: screen.source_key,
            generation: screen.generation,
        };
        let arm_state = state.clone();
        let arm = tokio::spawn(async move {
            handle_text_message_with_role(
                &arm_state,
                &json!({
                    "id": "inject-screen-live",
                    "method": CAPTURE_RECOVERY_SMOKE_INJECT_SCREEN_METHOD,
                    "params": {}
                })
                .to_string(),
                BackendRole::Renderer,
            )
            .await
        });
        timeout(Duration::from_secs(1), async {
            loop {
                if capture_recovery::apply_screen_delivery_smoke_fault(
                    &state,
                    &screen_epoch,
                    1,
                    1,
                    1,
                )
                .is_some()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("smoke RPC must arm the exact ScreenCaptureKit generation");
        let armed = arm.await.expect("screen capture-recovery smoke RPC task");
        assert!(armed.ok);
        let payload = armed.payload.unwrap();
        assert_eq!(payload["armed"], true);
        assert!(payload["faultId"].as_u64().unwrap() > 0);
        assert_eq!(payload["sourceGeneration"], 41);
    }

    #[tokio::test]
    async fn capture_recovery_retry_is_parameterless_and_idle_idempotent() {
        let state = test_state();
        let rejected = handle_text_message_with_role(
            &state,
            &json!({
                "id": "retry-with-params",
                "method": "capture.recovery.retry",
                "params": { "generation": 9 }
            })
            .to_string(),
            BackendRole::Renderer,
        )
        .await;
        assert!(!rejected.ok);
        assert_eq!(rejected.error.unwrap().code, "invalid-params");

        for id in ["retry-idle-a", "retry-idle-b"] {
            let response = handle_text_message_with_role(
                &state,
                &json!({
                    "id": id,
                    "method": "capture.recovery.retry",
                    "params": {}
                })
                .to_string(),
                BackendRole::Renderer,
            )
            .await;
            assert!(response.ok);
            assert_eq!(response.payload.unwrap()["phase"], "idle");
        }
    }

    #[test]
    fn websocket_command_lane_smoke_controls_cannot_queue_behind_the_blocker() {
        let durable_chat = json!({
            "id": "chat",
            "method": "liveChat.send",
            "params": {}
        })
        .to_string();
        assert_eq!(
            websocket_isolated_command_lane(durable_chat.as_str()),
            Some(WebSocketIsolatedCommandLaneKind::DurableChat)
        );

        let stop = json!({ "id": "stop", "method": "session.stop", "params": {} }).to_string();
        assert_eq!(
            websocket_isolated_command_lane(stop.as_str()),
            Some(WebSocketIsolatedCommandLaneKind::Stop)
        );

        let status = json!({
            "id": "smoke-status",
            "method": COMMAND_LANE_SMOKE_STATUS_METHOD,
            "params": {}
        })
        .to_string();
        assert!(
            websocket_command_is_read_only(status.as_str()),
            "the readiness handshake must stay observable while AccountMaintenance is blocked"
        );

        let release = json!({
            "id": "smoke-release",
            "method": COMMAND_LANE_SMOKE_RELEASE_METHOD,
            "params": {}
        })
        .to_string();
        assert_eq!(
            websocket_isolated_command_lane(release.as_str()),
            Some(WebSocketIsolatedCommandLaneKind::Stop),
            "the debug release control must remain reachable through a separate bounded lane"
        );
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
        let state = test_state();
        let dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            command_rx,
            command_metrics.clone(),
            outgoing_tx,
            reliable_metrics.clone(),
            slow_pressure,
            handler,
        ));

        assert!(
            send_test_websocket_command(
                &state,
                &command_tx,
                &command_metrics,
                json!({ "id": "stop", "method": "session.stop", "params": {} }).to_string(),
            )
            .await
        );
        for index in 0..3 {
            assert!(
                send_test_websocket_command(
                    &state,
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
    async fn websocket_live_commands_do_not_wait_for_wedged_account_maintenance() {
        let account_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_account = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let live_commands = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let handler: WebSocketCommandHandler = {
            let account_entered = account_entered.clone();
            let release_account = release_account.clone();
            let live_commands = live_commands.clone();
            std::sync::Arc::new(move |_state, text| {
                let account_entered = account_entered.clone();
                let release_account = release_account.clone();
                let live_commands = live_commands.clone();
                Box::pin(async move {
                    let command: serde_json::Value = serde_json::from_str(&text).unwrap();
                    let id = command["id"].as_str().unwrap().to_string();
                    let method = command["method"].as_str().unwrap().to_string();
                    if method == "account.refresh" {
                        account_entered.add_permits(1);
                        release_account.acquire().await.unwrap().forget();
                    } else {
                        live_commands.lock().await.push(method);
                    }
                    ServerResponse::ok(id, json!({}))
                })
            })
        };
        let (command_tx, command_rx) = mpsc::channel(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
        let (outgoing_tx, _outgoing_rx) = mpsc::channel(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let connection = transport.register_connection();
        let command_metrics = connection.incoming_command_queue;
        let reliable_metrics = connection.reliable_response_queue;
        let (pressure_tx, _pressure_rx) = mpsc::channel(1);
        let slow_pressure = WebSocketSlowPressureSignal::new(pressure_tx, transport.clone());
        let state = test_state();
        let dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            command_rx,
            command_metrics.clone(),
            outgoing_tx,
            reliable_metrics,
            slow_pressure,
            handler,
        ));

        send_test_websocket_command(
            &state,
            &command_tx,
            &command_metrics,
            json!({ "id": "account", "method": "account.refresh", "params": {} }).to_string(),
        )
        .await;
        timeout(Duration::from_secs(1), account_entered.acquire())
            .await
            .expect("account maintenance should enter")
            .unwrap()
            .forget();

        for (id, method) in [
            ("screen", "screens.activate"),
            ("scene", "scene.layout.apply_live"),
            ("captions", "captions.start"),
            ("chat", "liveChat.send"),
            ("stop", "session.stop"),
        ] {
            send_test_websocket_command(
                &state,
                &command_tx,
                &command_metrics,
                json!({ "id": id, "method": method, "params": {} }).to_string(),
            )
            .await;
        }

        timeout(Duration::from_millis(250), async {
            loop {
                if live_commands.lock().await.len() == 5 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("live commands and Stop must dispatch despite wedged account maintenance");

        let mut observed = live_commands.lock().await.clone();
        observed.sort();
        assert_eq!(
            observed,
            [
                "captions.start",
                "liveChat.send",
                "scene.layout.apply_live",
                "screens.activate",
                "session.stop"
            ]
        );

        release_account.add_permits(1);
        drop(command_tx);
        dispatcher.await.unwrap();
    }

    #[tokio::test]
    async fn websocket_observation_lane_queues_a_bootstrap_sized_burst() {
        let release = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let active = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let max_active = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handler: WebSocketCommandHandler = {
            let release = release.clone();
            let active = active.clone();
            let max_active = max_active.clone();
            std::sync::Arc::new(move |_state, text| {
                let release = release.clone();
                let active = active.clone();
                let max_active = max_active.clone();
                Box::pin(async move {
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    let current = active.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
                    max_active.fetch_max(current, std::sync::atomic::Ordering::AcqRel);
                    release.acquire().await.unwrap().forget();
                    active.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                    ServerResponse::ok(command.id, json!({}))
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
        let state = test_state();
        let lane_metrics = state.websocket_transport_metrics.clone();
        let dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            command_rx,
            command_metrics.clone(),
            outgoing_tx,
            reliable_metrics.clone(),
            slow_pressure,
            handler,
        ));

        const BURST_SIZE: usize = 8;
        for index in 0..BURST_SIZE {
            assert!(
                send_test_websocket_command(
                    &state,
                    &command_tx,
                    &command_metrics,
                    json!({
                        "id": format!("observation-{index}"),
                        "method": "health.ping",
                        "params": {}
                    })
                    .to_string(),
                )
                .await
            );
        }
        timeout(Duration::from_secs(1), async {
            while active.load(std::sync::atomic::Ordering::Acquire)
                < WEBSOCKET_READ_ONLY_CONCURRENCY
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the observation worker should fill its concurrency slots");
        assert_eq!(
            max_active.load(std::sync::atomic::Ordering::Acquire),
            WEBSOCKET_READ_ONLY_CONCURRENCY
        );

        release.add_permits(BURST_SIZE);
        drop(command_tx);
        dispatcher.await.unwrap();

        let mut response_ids = std::collections::HashSet::new();
        while let Some(Message::Text(text)) = outgoing_rx.recv().await {
            reliable_metrics.record_dequeue_oldest();
            let response: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(response["ok"], true, "unexpected response: {response}");
            response_ids.insert(response["id"].as_str().unwrap().to_string());
        }
        assert_eq!(response_ids.len(), BURST_SIZE);
        let diagnostics = &lane_metrics.snapshot().command_lanes["observation"];
        assert_eq!(diagnostics.rejected_before_dispatch_count, 0);
        assert!(diagnostics.queue.max_depth > WEBSOCKET_READ_ONLY_CONCURRENCY as u64);
    }

    #[tokio::test]
    async fn websocket_account_maintenance_queues_distinct_refresh_work_in_fifo_order() {
        assert_eq!(
            WEBSOCKET_ACCOUNT_MAINTENANCE_MAX_QUEUE_AGE,
            Duration::from_secs(15)
        );
        assert!(WEBSOCKET_ACCOUNT_MAINTENANCE_MAX_QUEUE_AGE > ACCOUNT_REFRESH_TIMEOUT);
        let first_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let second_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_first = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let entered = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let handler: WebSocketCommandHandler = {
            let first_entered = first_entered.clone();
            let second_entered = second_entered.clone();
            let release_first = release_first.clone();
            let entered = entered.clone();
            std::sync::Arc::new(move |_state, text| {
                let first_entered = first_entered.clone();
                let second_entered = second_entered.clone();
                let release_first = release_first.clone();
                let entered = entered.clone();
                Box::pin(async move {
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    entered.lock().await.push(command.method.clone());
                    if command.method == "entitlements.refresh" {
                        first_entered.add_permits(1);
                        release_first.acquire().await.unwrap().forget();
                    } else if command.method == "platformAccounts.validate" {
                        second_entered.add_permits(1);
                    }
                    ServerResponse::ok(command.id, json!({}))
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
        let state = test_state();
        let lane_metrics = state.websocket_transport_metrics.clone();
        let dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            command_rx,
            command_metrics.clone(),
            outgoing_tx,
            reliable_metrics.clone(),
            slow_pressure,
            handler,
        ));

        assert!(
            send_test_websocket_command(
                &state,
                &command_tx,
                &command_metrics,
                json!({ "id": "entitlements", "method": "entitlements.refresh", "params": {} })
                    .to_string(),
            )
            .await
        );
        timeout(Duration::from_secs(1), first_entered.acquire())
            .await
            .expect("entitlements refresh should dispatch")
            .unwrap()
            .forget();
        assert!(
            send_test_websocket_command(
                &state,
                &command_tx,
                &command_metrics,
                json!({ "id": "platforms", "method": "platformAccounts.validate", "params": {} })
                    .to_string(),
            )
            .await
        );
        assert!(
            timeout(Duration::from_millis(50), second_entered.acquire())
                .await
                .is_err(),
            "account maintenance must remain serial"
        );

        release_first.add_permits(1);
        timeout(Duration::from_secs(1), second_entered.acquire())
            .await
            .expect("the distinct provider validation should remain queued")
            .unwrap()
            .forget();
        drop(command_tx);
        dispatcher.await.unwrap();

        let mut responses = Vec::new();
        while let Some(Message::Text(text)) = outgoing_rx.recv().await {
            reliable_metrics.record_dequeue_oldest();
            responses.push(serde_json::from_str::<serde_json::Value>(&text).unwrap());
        }
        assert_eq!(responses.len(), 2);
        assert!(responses.iter().all(|response| response["ok"] == true));
        assert_eq!(
            *entered.lock().await,
            ["entitlements.refresh", "platformAccounts.validate"]
        );
        assert_eq!(
            lane_metrics.snapshot().command_lanes["accountMaintenance"]
                .rejected_before_dispatch_count,
            0
        );
    }

    #[tokio::test]
    async fn websocket_scene_layout_retains_concurrent_latest_wins_path_while_account_is_wedged() {
        let account_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_account = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let scenes_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_scenes = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let scene_active = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let max_scene_active = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handler: WebSocketCommandHandler = {
            let account_entered = account_entered.clone();
            let release_account = release_account.clone();
            let scenes_entered = scenes_entered.clone();
            let release_scenes = release_scenes.clone();
            let scene_active = scene_active.clone();
            let max_scene_active = max_scene_active.clone();
            std::sync::Arc::new(move |_state, text| {
                let account_entered = account_entered.clone();
                let release_account = release_account.clone();
                let scenes_entered = scenes_entered.clone();
                let release_scenes = release_scenes.clone();
                let scene_active = scene_active.clone();
                let max_scene_active = max_scene_active.clone();
                Box::pin(async move {
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    if command.method == "account.refresh" {
                        account_entered.add_permits(1);
                        release_account.acquire().await.unwrap().forget();
                    } else if command.method.starts_with("scene.layout.apply_") {
                        let current =
                            scene_active.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
                        max_scene_active.fetch_max(current, std::sync::atomic::Ordering::AcqRel);
                        scenes_entered.add_permits(1);
                        release_scenes.acquire().await.unwrap().forget();
                        scene_active.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                    }
                    ServerResponse::ok(command.id, json!({}))
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
        let slow_pressure = WebSocketSlowPressureSignal::new(pressure_tx, transport);
        let state = test_state();
        let dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            command_rx,
            command_metrics.clone(),
            outgoing_tx,
            reliable_metrics.clone(),
            slow_pressure,
            handler,
        ));

        send_test_websocket_command(
            &state,
            &command_tx,
            &command_metrics,
            json!({ "id": "account", "method": "account.refresh", "params": {} }).to_string(),
        )
        .await;
        timeout(Duration::from_secs(1), account_entered.acquire())
            .await
            .expect("account refresh should wedge")
            .unwrap()
            .forget();
        for (id, method, intent_id) in [
            ("live-layout", "scene.layout.apply_live", 1),
            ("preview-layout", "scene.layout.apply_preview", 2),
        ] {
            send_test_websocket_command(
                &state,
                &command_tx,
                &command_metrics,
                json!({ "id": id, "method": method, "params": { "intentId": intent_id } })
                    .to_string(),
            )
            .await;
        }
        timeout(Duration::from_millis(250), scenes_entered.acquire_many(2))
            .await
            .expect("both latest-wins layouts must overlap despite wedged account maintenance")
            .unwrap()
            .forget();
        assert_eq!(
            max_scene_active.load(std::sync::atomic::Ordering::Acquire),
            2
        );

        release_scenes.add_permits(2);
        release_account.add_permits(1);
        drop(command_tx);
        dispatcher.await.unwrap();
        let mut response_count = 0;
        while let Some(Message::Text(text)) = outgoing_rx.recv().await {
            reliable_metrics.record_dequeue_oldest();
            let response: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(response["ok"], true);
            response_count += 1;
        }
        assert_eq!(response_count, 3);
    }

    #[tokio::test]
    async fn websocket_live_control_lane_dispatches_in_arrival_order() {
        let first_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let later_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_first = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let entered = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let handler: WebSocketCommandHandler = {
            let first_entered = first_entered.clone();
            let later_entered = later_entered.clone();
            let release_first = release_first.clone();
            let entered = entered.clone();
            std::sync::Arc::new(move |_state, text| {
                let first_entered = first_entered.clone();
                let later_entered = later_entered.clone();
                let release_first = release_first.clone();
                let entered = entered.clone();
                Box::pin(async move {
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    entered.lock().await.push(command.id.clone());
                    if command.id == "screen" {
                        first_entered.add_permits(1);
                        release_first.acquire().await.unwrap().forget();
                    } else {
                        later_entered.add_permits(1);
                    }
                    ServerResponse::ok(command.id, json!({}))
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
        let slow_pressure = WebSocketSlowPressureSignal::new(pressure_tx, transport);
        let state = test_state();
        let dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            command_rx,
            command_metrics.clone(),
            outgoing_tx,
            reliable_metrics.clone(),
            slow_pressure,
            handler,
        ));

        for (id, method) in [
            ("screen", "screens.activate"),
            ("captions", "captions.start"),
            ("highlight", "comments.highlight.set"),
        ] {
            send_test_websocket_command(
                &state,
                &command_tx,
                &command_metrics,
                json!({ "id": id, "method": method, "params": {} }).to_string(),
            )
            .await;
        }
        timeout(Duration::from_secs(1), first_entered.acquire())
            .await
            .expect("first live-control command should dispatch")
            .unwrap()
            .forget();
        assert!(
            timeout(Duration::from_millis(50), later_entered.acquire())
                .await
                .is_err(),
            "later live-control commands must wait for the head command"
        );

        release_first.add_permits(1);
        timeout(Duration::from_secs(1), later_entered.acquire_many(2))
            .await
            .expect("queued live-control commands should dispatch")
            .unwrap()
            .forget();
        drop(command_tx);
        dispatcher.await.unwrap();
        let mut response_count = 0;
        while let Some(Message::Text(text)) = outgoing_rx.recv().await {
            reliable_metrics.record_dequeue_oldest();
            let response: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(response["ok"], true);
            response_count += 1;
        }
        assert_eq!(response_count, 3);
        assert_eq!(*entered.lock().await, ["screen", "captions", "highlight"]);
    }

    #[tokio::test]
    async fn websocket_live_control_fifo_is_global_across_reconnect() {
        let slow_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let activate_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let clear_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_slow = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_activate = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let entered = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let handler: WebSocketCommandHandler = {
            let slow_entered = slow_entered.clone();
            let activate_entered = activate_entered.clone();
            let clear_entered = clear_entered.clone();
            let release_slow = release_slow.clone();
            let release_activate = release_activate.clone();
            let entered = entered.clone();
            std::sync::Arc::new(move |_state, text| {
                let slow_entered = slow_entered.clone();
                let activate_entered = activate_entered.clone();
                let clear_entered = clear_entered.clone();
                let release_slow = release_slow.clone();
                let release_activate = release_activate.clone();
                let entered = entered.clone();
                Box::pin(async move {
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    entered.lock().await.push(command.method.clone());
                    match command.method.as_str() {
                        "captions.start" => {
                            slow_entered.add_permits(1);
                            release_slow.acquire().await.unwrap().forget();
                        }
                        "screens.activate" => {
                            activate_entered.add_permits(1);
                            release_activate.acquire().await.unwrap().forget();
                        }
                        "screens.clear" => clear_entered.add_permits(1),
                        _ => {}
                    }
                    ServerResponse::ok(command.id, json!({}))
                })
            })
        };
        let (old_tx, old_rx) = mpsc::channel(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
        let (new_tx, new_rx) = mpsc::channel(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
        let (old_outgoing_tx, mut old_outgoing_rx) =
            mpsc::channel(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
        let (new_outgoing_tx, mut new_outgoing_rx) =
            mpsc::channel(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let old_connection = transport.register_connection();
        let old_metrics = old_connection.incoming_command_queue;
        let old_reliable_metrics = old_connection.reliable_response_queue;
        let new_connection = transport.register_connection();
        let new_metrics = new_connection.incoming_command_queue;
        let new_reliable_metrics = new_connection.reliable_response_queue;
        let (old_pressure_tx, _old_pressure_rx) = mpsc::channel(1);
        let old_pressure = WebSocketSlowPressureSignal::new(old_pressure_tx, transport.clone());
        let (new_pressure_tx, _new_pressure_rx) = mpsc::channel(1);
        let new_pressure = WebSocketSlowPressureSignal::new(new_pressure_tx, transport);
        let state = test_state();

        // Accept both old-socket commands before its dispatcher is allowed to
        // dequeue them. This pins the reconnect race at socket intake rather
        // than accidentally relying on old-dispatcher scheduling.
        send_test_websocket_command(
            &state,
            &old_tx,
            &old_metrics,
            json!({ "id": "slow", "method": "captions.start", "params": {} }).to_string(),
        )
        .await;
        send_test_websocket_command(
            &state,
            &old_tx,
            &old_metrics,
            json!({ "id": "activate", "method": "screens.activate", "params": {} }).to_string(),
        )
        .await;
        assert_eq!(state.live_control_command_order.accepted_sequence(), 2);

        let new_dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            new_rx,
            new_metrics.clone(),
            new_outgoing_tx,
            new_reliable_metrics.clone(),
            new_pressure,
            handler.clone(),
        ));
        send_test_websocket_command(
            &state,
            &new_tx,
            &new_metrics,
            json!({ "id": "clear", "method": "screens.clear", "params": {} }).to_string(),
        )
        .await;
        assert!(
            timeout(Duration::from_millis(50), clear_entered.acquire())
                .await
                .is_err(),
            "new socket clear must not overtake live controls still queued on the old socket"
        );

        let old_dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            old_rx,
            old_metrics.clone(),
            old_outgoing_tx,
            old_reliable_metrics.clone(),
            old_pressure,
            handler,
        ));
        timeout(Duration::from_secs(1), slow_entered.acquire())
            .await
            .expect("old socket head command should dispatch once its dispatcher starts")
            .unwrap()
            .forget();

        release_slow.add_permits(1);
        timeout(Duration::from_secs(1), activate_entered.acquire())
            .await
            .expect("old socket activate should retain its global turn")
            .unwrap()
            .forget();
        assert!(
            timeout(Duration::from_millis(50), clear_entered.acquire())
                .await
                .is_err(),
            "clear must remain behind activate until activate commits"
        );
        release_activate.add_permits(1);
        timeout(Duration::from_secs(1), clear_entered.acquire())
            .await
            .expect("new socket clear should dispatch after older commands")
            .unwrap()
            .forget();

        drop(old_tx);
        drop(new_tx);
        old_dispatcher.await.unwrap();
        new_dispatcher.await.unwrap();
        let mut response_count = 0;
        while let Some(Message::Text(text)) = old_outgoing_rx.recv().await {
            old_reliable_metrics.record_dequeue_oldest();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&text).unwrap()["ok"],
                true
            );
            response_count += 1;
        }
        while let Some(Message::Text(text)) = new_outgoing_rx.recv().await {
            new_reliable_metrics.record_dequeue_oldest();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&text).unwrap()["ok"],
                true
            );
            response_count += 1;
        }
        assert_eq!(response_count, 3);
        assert_eq!(
            *entered.lock().await,
            ["captions.start", "screens.activate", "screens.clear"]
        );
    }

    #[tokio::test]
    async fn websocket_session_start_waits_for_prior_live_control_across_reconnect() {
        assert_cross_connection_websocket_command_order("screens.activate", "session.start").await;
    }

    #[tokio::test]
    async fn websocket_live_control_waits_for_prior_session_start_across_reconnect() {
        assert_cross_connection_websocket_command_order("session.start", "screens.activate").await;
    }

    #[tokio::test]
    async fn websocket_layout_waits_for_prior_session_start_across_reconnect() {
        assert_cross_connection_websocket_command_order("session.start", "scene.layout.apply_live")
            .await;
    }

    #[tokio::test]
    async fn websocket_session_start_waits_for_prior_authoritative_scene_mutations_across_reconnect()
     {
        for mutation_method in [
            "scene.load_from_capture_config",
            "scene.layout.apply_live",
            "scene.layout.apply_preview",
            "scene.source.device.switch",
            "scene.source.transform.update",
            "scene.source.transform.reset",
            "scene.source.visibility.update",
            "scene.source.nudge",
            "scene.sources.reorder",
        ] {
            assert_cross_connection_websocket_command_order(mutation_method, "session.start").await;
        }
    }

    #[tokio::test]
    async fn websocket_session_start_waits_for_prior_raw_source_mutations_across_reconnect() {
        for mutation_method in [
            "preview.camera.start",
            "preview.camera.stop",
            "preview.screen.start",
            "preview.screen.stop",
        ] {
            assert_cross_connection_websocket_command_order(mutation_method, "session.start").await;
        }
    }

    async fn assert_websocket_reconciliation_fence_waits_for_prior_scene_mutation(
        mutation_method: &'static str,
    ) {
        let mutation_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_mutation = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let read_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let committed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let read_saw_commit = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handler: WebSocketCommandHandler = {
            let mutation_entered = mutation_entered.clone();
            let release_mutation = release_mutation.clone();
            let read_entered = read_entered.clone();
            let committed = committed.clone();
            let read_saw_commit = read_saw_commit.clone();
            std::sync::Arc::new(move |_state, text| {
                let mutation_entered = mutation_entered.clone();
                let release_mutation = release_mutation.clone();
                let read_entered = read_entered.clone();
                let committed = committed.clone();
                let read_saw_commit = read_saw_commit.clone();
                Box::pin(async move {
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    if command.method == mutation_method {
                        mutation_entered.add_permits(1);
                        release_mutation.acquire().await.unwrap().forget();
                        committed.store(true, std::sync::atomic::Ordering::Release);
                    } else if command.method == "scene.get" {
                        read_saw_commit.store(
                            committed.load(std::sync::atomic::Ordering::Acquire),
                            std::sync::atomic::Ordering::Release,
                        );
                        read_entered.add_permits(1);
                    }
                    ServerResponse::ok(command.id, json!({}))
                })
            })
        };
        let (mutation_tx, mutation_rx) = mpsc::channel(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
        let (read_tx, read_rx) = mpsc::channel(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
        let (mutation_outgoing_tx, mut mutation_outgoing_rx) =
            mpsc::channel(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
        let (read_outgoing_tx, mut read_outgoing_rx) =
            mpsc::channel(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let mutation_connection = transport.register_connection();
        let mutation_metrics = mutation_connection.incoming_command_queue;
        let mutation_reliable_metrics = mutation_connection.reliable_response_queue;
        let read_connection = transport.register_connection();
        let read_metrics = read_connection.incoming_command_queue;
        let read_reliable_metrics = read_connection.reliable_response_queue;
        let (mutation_pressure_tx, _mutation_pressure_rx) = mpsc::channel(1);
        let mutation_pressure =
            WebSocketSlowPressureSignal::new(mutation_pressure_tx, transport.clone());
        let (read_pressure_tx, _read_pressure_rx) = mpsc::channel(1);
        let read_pressure = WebSocketSlowPressureSignal::new(read_pressure_tx, transport);
        let state = test_state();

        // Admission happens at socket intake. Keep the old dispatcher stopped
        // so this regression covers a mutation accepted on a disconnected
        // socket but not yet dequeued by its per-connection dispatcher.
        send_test_websocket_command(
            &state,
            &mutation_tx,
            &mutation_metrics,
            json!({
                "id": "mutation",
                "method": mutation_method,
                "params": { "intentId": 1 }
            })
            .to_string(),
        )
        .await;

        let read_dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            read_rx,
            read_metrics.clone(),
            read_outgoing_tx,
            read_reliable_metrics.clone(),
            read_pressure,
            handler.clone(),
        ));
        send_test_websocket_command(
            &state,
            &read_tx,
            &read_metrics,
            json!({ "id": "scene", "method": "scene.get", "params": {} }).to_string(),
        )
        .await;
        assert!(
            timeout(Duration::from_millis(50), read_entered.acquire())
                .await
                .is_err(),
            "authoritative read must not overtake prior {mutation_method} still queued on the old socket"
        );

        let mutation_dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            mutation_rx,
            mutation_metrics.clone(),
            mutation_outgoing_tx,
            mutation_reliable_metrics.clone(),
            mutation_pressure,
            handler,
        ));
        timeout(Duration::from_secs(1), mutation_entered.acquire())
            .await
            .expect("scene mutation should dispatch once its old dispatcher starts")
            .unwrap()
            .forget();

        release_mutation.add_permits(1);
        timeout(Duration::from_secs(1), read_entered.acquire())
            .await
            .expect("authoritative read should dispatch after the mutation commits")
            .unwrap()
            .forget();
        assert!(read_saw_commit.load(std::sync::atomic::Ordering::Acquire));
        drop(mutation_tx);
        drop(read_tx);
        mutation_dispatcher.await.unwrap();
        read_dispatcher.await.unwrap();
        let mut response_count = 0;
        while let Some(Message::Text(text)) = mutation_outgoing_rx.recv().await {
            mutation_reliable_metrics.record_dequeue_oldest();
            let response: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(response["ok"], true);
            response_count += 1;
        }
        while let Some(Message::Text(text)) = read_outgoing_rx.recv().await {
            read_reliable_metrics.record_dequeue_oldest();
            let response: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(response["ok"], true);
            response_count += 1;
        }
        assert_eq!(response_count, 2);
    }

    #[tokio::test]
    async fn websocket_reconciliation_fence_waits_for_prior_layout_commit_across_reconnect() {
        assert_websocket_reconciliation_fence_waits_for_prior_scene_mutation(
            "scene.layout.apply_live",
        )
        .await;
    }

    #[tokio::test]
    async fn websocket_reconciliation_fence_waits_for_prior_device_switch_across_reconnect() {
        assert_websocket_reconciliation_fence_waits_for_prior_scene_mutation(
            "scene.source.device.switch",
        )
        .await;
    }

    #[tokio::test(start_paused = true)]
    async fn websocket_session_stop_waits_past_its_deadline_for_an_earlier_session_start() {
        let start_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let stop_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_start = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let entered = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let handler: WebSocketCommandHandler = {
            let start_entered = start_entered.clone();
            let stop_entered = stop_entered.clone();
            let release_start = release_start.clone();
            let entered = entered.clone();
            std::sync::Arc::new(move |_state, text| {
                let start_entered = start_entered.clone();
                let stop_entered = stop_entered.clone();
                let release_start = release_start.clone();
                let entered = entered.clone();
                Box::pin(async move {
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    entered.lock().await.push(command.method.clone());
                    if command.method == "session.start" {
                        start_entered.add_permits(1);
                        release_start.acquire().await.unwrap().forget();
                    } else if command.method == "session.stop" {
                        stop_entered.add_permits(1);
                    }
                    ServerResponse::ok(command.id, json!({}))
                })
            })
        };
        let (start_command_tx, start_command_rx) = mpsc::channel(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
        let (stop_command_tx, stop_command_rx) = mpsc::channel(WEBSOCKET_COMMAND_QUEUE_CAPACITY);
        let (start_outgoing_tx, mut start_outgoing_rx) =
            mpsc::channel(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
        let (stop_outgoing_tx, mut stop_outgoing_rx) =
            mpsc::channel(WEBSOCKET_RELIABLE_QUEUE_CAPACITY);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let start_connection = transport.register_connection();
        let start_command_metrics = start_connection.incoming_command_queue;
        let start_reliable_metrics = start_connection.reliable_response_queue;
        let stop_connection = transport.register_connection();
        let stop_command_metrics = stop_connection.incoming_command_queue;
        let stop_reliable_metrics = stop_connection.reliable_response_queue;
        let (start_pressure_tx, _start_pressure_rx) = mpsc::channel(1);
        let start_slow_pressure =
            WebSocketSlowPressureSignal::new(start_pressure_tx, transport.clone());
        let (stop_pressure_tx, _stop_pressure_rx) = mpsc::channel(1);
        let stop_slow_pressure = WebSocketSlowPressureSignal::new(stop_pressure_tx, transport);
        let state = test_state();
        let dispatcher_metrics = state.websocket_transport_metrics.clone();

        // Capture the Start generation at old-socket intake, then hold its
        // dispatcher. A Stop on a reconnected socket must still observe and
        // wait for that accepted Start.
        send_test_websocket_command(
            &state,
            &start_command_tx,
            &start_command_metrics,
            json!({ "id": "start", "method": "session.start", "params": {} }).to_string(),
        )
        .await;
        let stop_dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            stop_command_rx,
            stop_command_metrics.clone(),
            stop_outgoing_tx,
            stop_reliable_metrics.clone(),
            stop_slow_pressure,
            handler.clone(),
        ));
        send_test_websocket_command(
            &state,
            &stop_command_tx,
            &stop_command_metrics,
            json!({ "id": "stop", "method": "session.stop", "params": {} }).to_string(),
        )
        .await;
        loop {
            let snapshot = dispatcher_metrics.snapshot();
            if snapshot
                .command_lanes
                .get("stop")
                .is_some_and(|lane| lane.queue.max_depth >= 1)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(
            stop_entered.try_acquire().is_err(),
            "session.stop must not observe Idle while session.start is still establishing capture"
        );

        let start_dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            start_command_rx,
            start_command_metrics.clone(),
            start_outgoing_tx,
            start_reliable_metrics.clone(),
            start_slow_pressure,
            handler,
        ));
        start_entered.acquire().await.unwrap().forget();
        tokio::time::advance(WEBSOCKET_STOP_MAX_QUEUE_AGE + Duration::from_secs(1)).await;
        assert!(
            stop_entered.try_acquire().is_err(),
            "session.stop must keep waiting after its ordinary lane deadline"
        );

        release_start.add_permits(1);
        timeout(Duration::from_secs(1), stop_entered.acquire())
            .await
            .expect("session.stop should dispatch after session.start finishes")
            .unwrap()
            .forget();
        drop(start_command_tx);
        drop(stop_command_tx);
        start_dispatcher.await.unwrap();
        stop_dispatcher.await.unwrap();
        let mut response_count = 0;
        while let Some(Message::Text(text)) = start_outgoing_rx.recv().await {
            start_reliable_metrics.record_dequeue_oldest();
            let response: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(response["ok"], true);
            response_count += 1;
        }
        while let Some(Message::Text(text)) = stop_outgoing_rx.recv().await {
            stop_reliable_metrics.record_dequeue_oldest();
            let response: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(response["ok"], true);
            response_count += 1;
        }
        assert_eq!(response_count, 2);
        assert_eq!(*entered.lock().await, ["session.start", "session.stop"]);
    }

    #[tokio::test]
    async fn screens_active_unavailable_hang_restarts_without_cancelling_or_overtaking_activation()
    {
        const TEST_MUTATION_MAX_EXECUTION_AGE: Duration = Duration::from_secs(3);

        struct DropProbe(std::sync::Arc<std::sync::atomic::AtomicBool>);

        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::Release);
            }
        }

        let first_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_first = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let executed = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let handler_future_dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handler: WebSocketCommandHandler = {
            let first_entered = first_entered.clone();
            let release_first = release_first.clone();
            let executed = executed.clone();
            let handler_future_dropped = handler_future_dropped.clone();
            std::sync::Arc::new(move |_state, text| {
                let first_entered = first_entered.clone();
                let release_first = release_first.clone();
                let executed = executed.clone();
                let handler_future_dropped = handler_future_dropped.clone();
                Box::pin(async move {
                    let _drop_probe = DropProbe(handler_future_dropped);
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    executed.lock().await.push(command.id.clone());
                    if command.id == "wedged" {
                        resolve_active_screen_read(
                            storage::ActiveStreamScreenSelection::Unavailable {
                                screen_id: "missing-screen".to_string(),
                            },
                            async move {
                                first_entered.add_permits(1);
                                release_first.acquire().await.unwrap().forget();
                                Ok(())
                            },
                            || Ok(()),
                        )
                        .await
                        .expect("released unavailable selection should retire")
                        .is_none()
                        .then_some(())
                        .expect("unavailable selection resolves inactive");
                    }
                    ServerResponse::ok(command.id, json!({}))
                })
            })
        };
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(4);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let (active_lane, active_lane_rx) = WebSocketIsolatedCommandLane::new(
            WebSocketIsolatedCommandLaneKind::LiveControl,
            1,
            Duration::from_secs(60),
            transport.register_command_lane("activeScreenRead"),
        );
        let (activation_lane, activation_lane_rx) = WebSocketIsolatedCommandLane::new(
            WebSocketIsolatedCommandLaneKind::LiveControl,
            1,
            Duration::from_secs(60),
            transport.register_command_lane("activeScreenActivation"),
        );
        let connection = transport.register_connection();
        let reliable_metrics = connection.reliable_response_queue;
        let (pressure_tx, _pressure_rx) = mpsc::channel(1);
        let slow_pressure = WebSocketSlowPressureSignal::new(pressure_tx, transport);
        let state = test_state();
        let mut workers = tokio::task::JoinSet::new();
        let worker_context = WebSocketCommandLaneWorkerContext {
            state: state.clone(),
            outgoing: outgoing_tx.clone(),
            reliable_metrics: reliable_metrics.clone(),
            slow_pressure,
            command_handler: handler,
        };
        spawn_websocket_command_lane_worker_with_mutation_executor(
            &mut workers,
            active_lane_rx,
            1,
            active_lane.metrics.clone(),
            &worker_context,
            Ok(WebSocketMutationExecutor::new(2).expect("isolated live-control mutation executor")),
            Some(TEST_MUTATION_MAX_EXECUTION_AGE),
        );
        spawn_websocket_command_lane_worker_with_mutation_executor(
            &mut workers,
            activation_lane_rx,
            1,
            activation_lane.metrics.clone(),
            &worker_context,
            Ok(WebSocketMutationExecutor::new(2).expect("isolated activation mutation executor")),
            Some(TEST_MUTATION_MAX_EXECUTION_AGE),
        );

        let first_order = state.live_control_command_order.begin();
        let first_completion = state.live_control_command_order.observe();
        let first_operator = state.operator_command_fence.begin();
        let first_operator_completion = state.operator_command_fence.observe();
        try_enqueue_websocket_lane_command(
            &active_lane,
            json!({ "id": "wedged", "method": "screens.active", "params": {} }).to_string(),
            tokio::time::Instant::now() + Duration::from_secs(60),
            Some(first_operator),
            Some(first_order),
            None,
        )
        .unwrap();
        timeout(Duration::from_secs(5), first_entered.acquire())
            .await
            .expect("live-control command should dispatch")
            .unwrap()
            .forget();
        try_enqueue_websocket_lane_command(
            &activation_lane,
            json!({ "id": "later", "method": "screens.activate", "params": {} }).to_string(),
            tokio::time::Instant::now() + Duration::from_secs(60),
            None,
            Some(state.live_control_command_order.begin()),
            None,
        )
        .unwrap();

        assert!(
            timeout(Duration::from_millis(50), outgoing_rx.recv())
                .await
                .is_err(),
            "the mutation must not time out before its execution contract"
        );
        assert!(!state.process_shutdown_requested());

        let unknown = timeout(
            Duration::from_secs(10),
            receive_tracked_json(&mut outgoing_rx, &reliable_metrics),
        )
        .await
        .expect("the real-time mutation watchdog must publish outcome-unknown");
        assert_eq!(unknown["id"], "wedged");
        assert_eq!(unknown["ok"], false);
        assert_eq!(unknown["error"]["code"], "request-outcome-unknown");
        assert!(state.process_shutdown_requested());
        assert_eq!(*executed.lock().await, ["wedged"]);
        assert!(
            !handler_future_dropped.load(std::sync::atomic::Ordering::Acquire),
            "the watchdog must detach, not cancel, the outcome-unknown handler future"
        );

        let mut first_completion_wait = Box::pin(first_completion.wait());
        assert!(
            futures_util::poll!(&mut first_completion_wait).is_pending(),
            "the unknown mutation must retain its global order guard"
        );
        let mut first_operator_completion_wait = Box::pin(first_operator_completion.wait());
        assert!(
            futures_util::poll!(&mut first_operator_completion_wait).is_pending(),
            "the unknown mutation must retain its operator reconciliation fence"
        );

        release_first.add_permits(1);
        first_completion_wait.await;
        first_operator_completion_wait.await;
        assert!(handler_future_dropped.load(std::sync::atomic::Ordering::Acquire));
        drop(active_lane);
        drop(activation_lane);
        while workers.join_next().await.is_some() {}
        let rejected = receive_tracked_json(&mut outgoing_rx, &reliable_metrics).await;
        assert_eq!(rejected["id"], "later");
        assert_eq!(rejected["error"]["code"], "command-expired-before-dispatch");
        assert_eq!(
            *executed.lock().await,
            ["wedged"],
            "concurrent activation must not overtake an outcome-unknown active-screen retirement"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn websocket_ordered_stateful_mutation_timeout_restarts_without_cancelling_or_overtaking()
    {
        struct DropProbe(std::sync::Arc<std::sync::atomic::AtomicBool>);

        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::Release);
            }
        }

        let first_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_first = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let executed = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let handler_future_dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handler: WebSocketCommandHandler = {
            let first_entered = first_entered.clone();
            let release_first = release_first.clone();
            let executed = executed.clone();
            let handler_future_dropped = handler_future_dropped.clone();
            std::sync::Arc::new(move |_state, text| {
                let first_entered = first_entered.clone();
                let release_first = release_first.clone();
                let executed = executed.clone();
                let handler_future_dropped = handler_future_dropped.clone();
                Box::pin(async move {
                    let _drop_probe = DropProbe(handler_future_dropped);
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    executed.lock().await.push(command.id.clone());
                    if command.id == "wedged-source" {
                        first_entered.add_permits(1);
                        release_first.acquire().await.unwrap().forget();
                    }
                    ServerResponse::ok(command.id, json!({}))
                })
            })
        };
        let (command_tx, command_rx) = mpsc::channel(2);
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(4);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let connection = transport.register_connection();
        let reliable_metrics = connection.reliable_response_queue;
        let (pressure_tx, _pressure_rx) = mpsc::channel(1);
        let state = test_state();
        let running_stateful = WebSocketRunningStatefulCommand::default();
        let dispatcher = tokio::spawn(
            run_websocket_ordered_command_dispatcher_with_mutation_executor(
                state.clone(),
                command_rx,
                outgoing_tx,
                reliable_metrics.clone(),
                WebSocketSlowPressureSignal::new(pressure_tx, transport),
                handler,
                running_stateful.clone(),
                Ok(WebSocketMutationExecutor::new(2).expect("isolated stateful mutation executor")),
            ),
        );

        let first_operator = state.operator_command_fence.begin();
        let first_operator_completion = state.operator_command_fence.observe();
        command_tx
            .send(WebSocketOrderedCommand {
                text: json!({
                    "id": "wedged-source",
                    "method": "scene.source.device.switch",
                    "params": {}
                })
                .to_string(),
                dispatch_deadline: tokio::time::Instant::now() + Duration::from_secs(60),
                dispatch_fence: None,
                _operator_mutation: Some(first_operator),
                _session_start: None,
            })
            .await
            .unwrap();
        // The handler runs on the deliberately separate mutation runtime. A
        // paused Tokio clock would auto-advance this timeout before that OS
        // worker gets scheduled under a parallel test load, so use real time
        // only for the explicit dispatch-readiness handshake.
        tokio::time::resume();
        timeout(Duration::from_secs(5), first_entered.acquire())
            .await
            .expect("stateful source mutation should dispatch")
            .unwrap()
            .forget();
        tokio::time::pause();
        command_tx
            .send(WebSocketOrderedCommand {
                text: json!({
                    "id": "later-source",
                    "method": "scene.source.visibility.update",
                    "params": {}
                })
                .to_string(),
                dispatch_deadline: tokio::time::Instant::now() + Duration::from_secs(60),
                dispatch_fence: None,
                _operator_mutation: Some(state.operator_command_fence.begin()),
                _session_start: None,
            })
            .await
            .unwrap();

        tokio::time::advance(WEBSOCKET_MUTATION_MAX_EXECUTION_AGE).await;
        let unknown = receive_tracked_json(&mut outgoing_rx, &reliable_metrics).await;
        assert_eq!(unknown["id"], "wedged-source");
        assert_eq!(unknown["error"]["code"], "request-outcome-unknown");
        assert!(state.process_shutdown_requested());
        assert_eq!(*executed.lock().await, ["wedged-source"]);
        assert!(
            !handler_future_dropped.load(std::sync::atomic::Ordering::Acquire),
            "the ordered watchdog must detach, not cancel, the source mutation"
        );
        assert_eq!(
            running_stateful.snapshot().map(|(method, _)| method),
            Some("scene.source.device.switch".to_string()),
            "the detached mutation remains the truthful running stateful owner"
        );
        let mut first_operator_wait = Box::pin(first_operator_completion.wait());
        assert!(
            futures_util::poll!(&mut first_operator_wait).is_pending(),
            "the detached mutation must retain its operator reconciliation fence"
        );

        let rejected = receive_tracked_json(&mut outgoing_rx, &reliable_metrics).await;
        assert_eq!(rejected["id"], "later-source");
        assert_eq!(rejected["error"]["code"], "command-expired-before-dispatch");
        assert_eq!(*executed.lock().await, ["wedged-source"]);

        release_first.add_permits(1);
        first_operator_wait.await;
        assert!(handler_future_dropped.load(std::sync::atomic::Ordering::Acquire));
        assert!(running_stateful.snapshot().is_none());
        drop(command_tx);
        dispatcher.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn websocket_latest_wins_layout_timeout_restarts_without_cancelling_the_old_intent() {
        struct DropProbe(std::sync::Arc<std::sync::atomic::AtomicBool>);

        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::Release);
            }
        }

        let first_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_first = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let executed = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let first_future_dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handler: WebSocketCommandHandler = {
            let first_entered = first_entered.clone();
            let release_first = release_first.clone();
            let executed = executed.clone();
            let first_future_dropped = first_future_dropped.clone();
            std::sync::Arc::new(move |_state, text| {
                let first_entered = first_entered.clone();
                let release_first = release_first.clone();
                let executed = executed.clone();
                let first_future_dropped = first_future_dropped.clone();
                Box::pin(async move {
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    let _drop_probe =
                        (command.id == "wedged-layout").then(|| DropProbe(first_future_dropped));
                    executed.lock().await.push(command.id.clone());
                    if command.id == "wedged-layout" {
                        first_entered.add_permits(1);
                        release_first.acquire().await.unwrap().forget();
                    }
                    ServerResponse::ok(command.id, json!({}))
                })
            })
        };
        let (command_tx, command_rx) = mpsc::channel(2);
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(4);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let connection = transport.register_connection();
        let reliable_metrics = connection.reliable_response_queue;
        let (pressure_tx, _pressure_rx) = mpsc::channel(1);
        let state = test_state();
        let dispatcher = tokio::spawn(
            run_websocket_ordered_command_dispatcher_with_mutation_executor(
                state.clone(),
                command_rx,
                outgoing_tx,
                reliable_metrics.clone(),
                WebSocketSlowPressureSignal::new(pressure_tx, transport),
                handler,
                WebSocketRunningStatefulCommand::default(),
                Ok(WebSocketMutationExecutor::new(2)
                    .expect("isolated latest-wins mutation executor")),
            ),
        );

        let first_operator = state.operator_command_fence.begin();
        let first_operator_completion = state.operator_command_fence.observe();
        command_tx
            .send(WebSocketOrderedCommand {
                text: json!({
                    "id": "wedged-layout",
                    "method": "scene.layout.apply_live",
                    "params": { "intentId": 1 }
                })
                .to_string(),
                dispatch_deadline: tokio::time::Instant::now() + Duration::from_secs(60),
                dispatch_fence: None,
                _operator_mutation: Some(first_operator),
                _session_start: None,
            })
            .await
            .unwrap();
        // This readiness signal crosses into the isolated mutation runtime;
        // keep its bounded wait on real time before returning to the paused
        // clock used to drive the execution-contract deadline deterministically.
        tokio::time::resume();
        timeout(Duration::from_secs(5), first_entered.acquire())
            .await
            .expect("first layout intent should dispatch")
            .unwrap()
            .forget();
        tokio::time::pause();
        command_tx
            .send(WebSocketOrderedCommand {
                text: json!({
                    "id": "later-layout",
                    "method": "scene.layout.apply_live",
                    "params": { "intentId": 2 }
                })
                .to_string(),
                dispatch_deadline: tokio::time::Instant::now() + Duration::from_secs(60),
                dispatch_fence: None,
                _operator_mutation: Some(state.operator_command_fence.begin()),
                _session_start: None,
            })
            .await
            .unwrap();

        let latest = receive_tracked_json(&mut outgoing_rx, &reliable_metrics).await;
        assert_eq!(latest["id"], "later-layout");
        assert_eq!(latest["ok"], true);
        assert_eq!(
            *executed.lock().await,
            ["wedged-layout", "later-layout"],
            "the watchdog wrapper must preserve concurrent latest-wins layout dispatch"
        );

        tokio::time::advance(WEBSOCKET_MUTATION_MAX_EXECUTION_AGE).await;
        let unknown = receive_tracked_json(&mut outgoing_rx, &reliable_metrics).await;
        assert_eq!(unknown["id"], "wedged-layout");
        assert_eq!(unknown["error"]["code"], "request-outcome-unknown");
        assert!(state.process_shutdown_requested());
        assert!(
            !first_future_dropped.load(std::sync::atomic::Ordering::Acquire),
            "the timed-out old layout intent must remain owned until real completion"
        );
        let mut first_operator_wait = Box::pin(first_operator_completion.wait());
        assert!(
            futures_util::poll!(&mut first_operator_wait).is_pending(),
            "the detached layout must retain its operator reconciliation fence"
        );

        release_first.add_permits(1);
        first_operator_wait.await;
        assert!(first_future_dropped.load(std::sync::atomic::Ordering::Acquire));
        drop(command_tx);
        dispatcher.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn websocket_durable_chat_timeout_latches_shutdown_even_when_response_queue_is_full() {
        let entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let handler: WebSocketCommandHandler = {
            let entered = entered.clone();
            let release = release.clone();
            std::sync::Arc::new(move |_state, text| {
                let entered = entered.clone();
                let release = release.clone();
                Box::pin(async move {
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    entered.add_permits(1);
                    release.acquire().await.unwrap().forget();
                    ServerResponse::ok(command.id, json!({}))
                })
            })
        };
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(1);
        outgoing_tx
            .try_send(Message::Text("occupied".into()))
            .expect("prefill response queue");
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let (lane, lane_rx) = WebSocketIsolatedCommandLane::new(
            WebSocketIsolatedCommandLaneKind::DurableChat,
            1,
            Duration::from_secs(60),
            transport.register_command_lane("durableChat"),
        );
        let connection = transport.register_connection();
        let (pressure_tx, mut pressure_rx) = mpsc::channel(1);
        let state = test_state();
        let mut workers = tokio::task::JoinSet::new();
        spawn_websocket_command_lane_worker(
            &mut workers,
            lane_rx,
            1,
            lane.metrics.clone(),
            &WebSocketCommandLaneWorkerContext {
                state: state.clone(),
                outgoing: outgoing_tx,
                reliable_metrics: connection.reliable_response_queue,
                slow_pressure: WebSocketSlowPressureSignal::new(pressure_tx, transport),
                command_handler: handler,
            },
        );
        try_enqueue_websocket_lane_command(
            &lane,
            json!({ "id": "wedged", "method": "liveChat.send", "params": {} }).to_string(),
            tokio::time::Instant::now() + Duration::from_secs(60),
            None,
            None,
            None,
        )
        .unwrap();
        // The handler runs on the deliberately separate mutation runtime. A
        // paused Tokio clock can auto-advance the execution deadline before
        // that OS worker is scheduled, rejecting the command before it can
        // publish this readiness signal. Use real time only for the
        // cross-runtime dispatch handshake, then return to the paused clock to
        // drive the watchdog deterministically.
        tokio::time::resume();
        timeout(Duration::from_secs(5), entered.acquire())
            .await
            .expect("durable chat mutation should dispatch")
            .unwrap()
            .forget();
        tokio::time::pause();

        // Observe the actual latch with a later virtual-time guard. Moving the
        // clock to the watchdog deadline is not enough: the test task and the
        // watchdog can wake together, and the test may otherwise assert before
        // the watchdog processes its wake-up.
        timeout(
            WEBSOCKET_MUTATION_MAX_EXECUTION_AGE + Duration::from_secs(1),
            state.wait_for_process_shutdown_request(),
        )
        .await
        .expect("durable chat watchdog should latch process shutdown");
        assert!(state.process_shutdown_requested());
        assert_eq!(
            timeout(Duration::from_secs(1), pressure_rx.recv())
                .await
                .expect("full response queue should signal slow-peer pressure"),
            Some(())
        );
        assert!(matches!(
            outgoing_rx.try_recv(),
            Ok(Message::Text(text)) if text == "occupied"
        ));

        release.add_permits(1);
        drop(lane);
        tokio::time::resume();
        timeout(Duration::from_secs(5), async {
            while workers.join_next().await.is_some() {}
        })
        .await
        .expect("durable chat lane worker should stop after its sender closes");
    }

    #[tokio::test]
    async fn screens_active_unavailable_panic_latches_before_releasing_cross_socket_order() {
        let first_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_first = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let second_executed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handler: WebSocketCommandHandler = {
            let first_entered = first_entered.clone();
            let release_first = release_first.clone();
            let second_executed = second_executed.clone();
            std::sync::Arc::new(move |_state, text| {
                let first_entered = first_entered.clone();
                let release_first = release_first.clone();
                let second_executed = second_executed.clone();
                Box::pin(async move {
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    if command.id == "panic" {
                        let _ = resolve_active_screen_read(
                            storage::ActiveStreamScreenSelection::Unavailable {
                                screen_id: "missing-screen".to_string(),
                            },
                            async move {
                                first_entered.add_permits(1);
                                release_first.acquire().await.unwrap().forget();
                                Ok(())
                            },
                            || -> Result<()> {
                                panic!("simulated active-screen retirement panic after dispatch")
                            },
                        )
                        .await;
                    }
                    second_executed.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                    ServerResponse::ok(command.id, json!({}))
                })
            })
        };
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(4);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let (first_lane, first_lane_rx) = WebSocketIsolatedCommandLane::new(
            WebSocketIsolatedCommandLaneKind::LiveControl,
            1,
            Duration::from_secs(60),
            transport.register_command_lane("liveControlPanicFirst"),
        );
        let (second_lane, second_lane_rx) = WebSocketIsolatedCommandLane::new(
            WebSocketIsolatedCommandLaneKind::LiveControl,
            1,
            Duration::from_secs(60),
            transport.register_command_lane("liveControlPanicSecond"),
        );
        let connection = transport.register_connection();
        let reliable_metrics = connection.reliable_response_queue;
        let (pressure_tx, _pressure_rx) = mpsc::channel(1);
        let state = test_state();
        let context = WebSocketCommandLaneWorkerContext {
            state: state.clone(),
            outgoing: outgoing_tx,
            reliable_metrics: reliable_metrics.clone(),
            slow_pressure: WebSocketSlowPressureSignal::new(pressure_tx, transport),
            command_handler: handler,
        };
        let mut workers = tokio::task::JoinSet::new();
        spawn_websocket_command_lane_worker(
            &mut workers,
            first_lane_rx,
            1,
            first_lane.metrics.clone(),
            &context,
        );
        spawn_websocket_command_lane_worker(
            &mut workers,
            second_lane_rx,
            1,
            second_lane.metrics.clone(),
            &context,
        );

        try_enqueue_websocket_lane_command(
            &first_lane,
            json!({ "id": "panic", "method": "screens.active", "params": {} }).to_string(),
            tokio::time::Instant::now() + Duration::from_secs(60),
            Some(state.operator_command_fence.begin()),
            Some(state.live_control_command_order.begin()),
            None,
        )
        .unwrap();
        first_entered.acquire().await.unwrap().forget();
        try_enqueue_websocket_lane_command(
            &second_lane,
            json!({ "id": "later", "method": "captions.start", "params": {} }).to_string(),
            tokio::time::Instant::now() + Duration::from_secs(60),
            Some(state.operator_command_fence.begin()),
            Some(state.live_control_command_order.begin()),
            None,
        )
        .unwrap();
        release_first.add_permits(1);

        let mut responses = std::collections::HashMap::new();
        timeout(Duration::from_secs(1), async {
            while responses.len() < 2 {
                let response = receive_tracked_json(&mut outgoing_rx, &reliable_metrics).await;
                responses.insert(response["id"].as_str().unwrap().to_string(), response);
            }
        })
        .await
        .expect("panic and queued-command terminal responses");
        assert_eq!(
            responses["panic"]["error"]["code"],
            "request-outcome-unknown"
        );
        assert_eq!(
            responses["later"]["error"]["code"],
            "command-expired-before-dispatch"
        );
        assert!(state.process_shutdown_requested());
        assert_eq!(
            second_executed.load(std::sync::atomic::Ordering::Acquire),
            0
        );

        drop(first_lane);
        drop(second_lane);
        while workers.join_next().await.is_some() {}
    }

    #[tokio::test]
    async fn websocket_lane_rechecks_shutdown_after_waiting_for_dispatch_fence() {
        let executed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handler: WebSocketCommandHandler = {
            let executed = executed.clone();
            std::sync::Arc::new(move |_state, text| {
                let executed = executed.clone();
                Box::pin(async move {
                    executed.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    ServerResponse::ok(command.id, json!({}))
                })
            })
        };
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(2);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let (lane, lane_rx) = WebSocketIsolatedCommandLane::new(
            WebSocketIsolatedCommandLaneKind::LiveControl,
            1,
            Duration::from_secs(60),
            transport.register_command_lane("liveControl"),
        );
        let connection = transport.register_connection();
        let reliable_metrics = connection.reliable_response_queue;
        let (pressure_tx, _pressure_rx) = mpsc::channel(1);
        let state = test_state();
        let prior_session_start = state.session_start_command_fence.begin();
        let dispatch_fence = state.session_start_command_fence.observe();
        let mut workers = tokio::task::JoinSet::new();
        spawn_websocket_command_lane_worker(
            &mut workers,
            lane_rx,
            1,
            lane.metrics.clone(),
            &WebSocketCommandLaneWorkerContext {
                state: state.clone(),
                outgoing: outgoing_tx,
                reliable_metrics: reliable_metrics.clone(),
                slow_pressure: WebSocketSlowPressureSignal::new(pressure_tx, transport.clone()),
                command_handler: handler,
            },
        );
        try_enqueue_websocket_lane_command(
            &lane,
            json!({ "id": "blocked", "method": "screens.activate", "params": {} }).to_string(),
            tokio::time::Instant::now() + Duration::from_secs(60),
            None,
            Some(state.live_control_command_order.begin()),
            Some(WebSocketCommandDispatchFence::Bounded(dispatch_fence)),
        )
        .unwrap();
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            transport.snapshot().command_lanes["liveControl"]
                .queue
                .current_depth,
            0
        );
        assert_eq!(executed.load(std::sync::atomic::Ordering::Acquire), 0);

        state.request_process_shutdown();
        drop(prior_session_start);
        let response = timeout(
            Duration::from_secs(1),
            receive_tracked_json(&mut outgoing_rx, &reliable_metrics),
        )
        .await
        .expect("shutdown rejection after fence release");
        assert_eq!(response["id"], "blocked");
        assert_eq!(response["error"]["code"], "command-expired-before-dispatch");
        assert_eq!(executed.load(std::sync::atomic::Ordering::Acquire), 0);

        drop(lane);
        while workers.join_next().await.is_some() {}
    }

    #[tokio::test]
    async fn websocket_ordered_dispatcher_rechecks_shutdown_after_waiting_for_fence() {
        let executed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handler: WebSocketCommandHandler = {
            let executed = executed.clone();
            std::sync::Arc::new(move |_state, text| {
                let executed = executed.clone();
                Box::pin(async move {
                    executed.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    ServerResponse::ok(command.id, json!({}))
                })
            })
        };
        let state = test_state();
        let prior_operator_mutation = state.operator_command_fence.begin();
        let dispatch_fence = state.operator_command_fence.observe();
        let (command_tx, command_rx) = mpsc::channel(1);
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(2);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let connection = transport.register_connection();
        let reliable_metrics = connection.reliable_response_queue;
        let (pressure_tx, _pressure_rx) = mpsc::channel(1);
        let dispatcher = tokio::spawn(run_websocket_ordered_command_dispatcher(
            state.clone(),
            command_rx,
            outgoing_tx,
            reliable_metrics.clone(),
            WebSocketSlowPressureSignal::new(pressure_tx, transport),
            handler,
            WebSocketRunningStatefulCommand::default(),
        ));
        command_tx
            .send(WebSocketOrderedCommand {
                text: json!({
                    "id": "ordered-blocked",
                    "method": "test.mutation.ordered",
                    "params": {}
                })
                .to_string(),
                dispatch_deadline: tokio::time::Instant::now() + Duration::from_secs(60),
                dispatch_fence: Some(WebSocketCommandDispatchFence::Bounded(dispatch_fence)),
                _operator_mutation: None,
                _session_start: None,
            })
            .await
            .unwrap();
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert_eq!(executed.load(std::sync::atomic::Ordering::Acquire), 0);

        state.request_process_shutdown();
        drop(prior_operator_mutation);
        let response = timeout(
            Duration::from_secs(1),
            receive_tracked_json(&mut outgoing_rx, &reliable_metrics),
        )
        .await
        .expect("ordered shutdown rejection after fence release");
        assert_eq!(response["id"], "ordered-blocked");
        assert_eq!(response["error"]["code"], "command-expired-before-dispatch");
        assert_eq!(executed.load(std::sync::atomic::Ordering::Acquire), 0);

        drop(command_tx);
        dispatcher.await.unwrap();
    }

    #[tokio::test]
    async fn websocket_lane_expiry_reports_command_was_not_applied() {
        let first_entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let release_first = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let executed = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let handler: WebSocketCommandHandler = {
            let first_entered = first_entered.clone();
            let release_first = release_first.clone();
            let executed = executed.clone();
            std::sync::Arc::new(move |_state, text| {
                let first_entered = first_entered.clone();
                let release_first = release_first.clone();
                let executed = executed.clone();
                Box::pin(async move {
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    executed.lock().await.push(command.id.clone());
                    if command.id == "first" {
                        first_entered.add_permits(1);
                        release_first.acquire().await.unwrap().forget();
                    }
                    ServerResponse::ok(command.id, json!({}))
                })
            })
        };
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(4);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let (lane, lane_rx) = WebSocketIsolatedCommandLane::new(
            WebSocketIsolatedCommandLaneKind::LiveControl,
            2,
            Duration::from_millis(25),
            transport.register_command_lane("liveControl"),
        );
        let connection = transport.register_connection();
        let reliable_metrics = connection.reliable_response_queue;
        let (pressure_tx, _pressure_rx) = mpsc::channel(1);
        let slow_pressure = WebSocketSlowPressureSignal::new(pressure_tx, transport.clone());
        let mut workers = tokio::task::JoinSet::new();
        let worker_context = WebSocketCommandLaneWorkerContext {
            state: test_state(),
            outgoing: outgoing_tx.clone(),
            reliable_metrics: reliable_metrics.clone(),
            slow_pressure: slow_pressure.clone(),
            command_handler: handler.clone(),
        };
        spawn_websocket_command_lane_worker(
            &mut workers,
            lane_rx,
            1,
            lane.metrics.clone(),
            &worker_context,
        );

        try_enqueue_websocket_lane_command(
            &lane,
            json!({ "id": "first", "method": "screens.activate", "params": {} }).to_string(),
            tokio::time::Instant::now() + Duration::from_millis(25),
            None,
            None,
            None,
        )
        .unwrap();
        timeout(Duration::from_secs(1), first_entered.acquire())
            .await
            .expect("first command should dispatch")
            .unwrap()
            .forget();
        try_enqueue_websocket_lane_command(
            &lane,
            json!({ "id": "expired", "method": "captions.start", "params": {} }).to_string(),
            tokio::time::Instant::now() + Duration::from_millis(25),
            None,
            None,
            None,
        )
        .unwrap();

        let expired = timeout(
            Duration::from_millis(150),
            receive_tracked_json(&mut outgoing_rx, &reliable_metrics),
        )
        .await
        .expect("expiry must respond while the head command remains wedged");
        assert_eq!(expired["id"], "expired");
        assert_eq!(expired["ok"], false);
        assert_eq!(expired["error"]["code"], "command-expired-before-dispatch");
        assert_eq!(
            *executed.lock().await,
            ["first"],
            "an expired command must never reach the handler"
        );

        release_first.add_permits(1);
        drop(lane);
        while workers.join_next().await.is_some() {}
        drop(outgoing_tx);
        let first = receive_tracked_json(&mut outgoing_rx, &reliable_metrics).await;
        assert_eq!(first["id"], "first");
        assert_eq!(first["ok"], true);
        let snapshot = transport.snapshot();
        let diagnostics = &snapshot.command_lanes["liveControl"];
        assert_eq!(diagnostics.queue.current_depth, 0);
        assert_eq!(diagnostics.queue.max_depth, 1);
        assert_eq!(diagnostics.expired_before_dispatch_count, 1);
        assert_eq!(diagnostics.rejected_before_dispatch_count, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn websocket_connection_queue_age_counts_toward_expiry_before_dispatch() {
        let executed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handler: WebSocketCommandHandler = {
            let executed = executed.clone();
            std::sync::Arc::new(move |_state, text| {
                let executed = executed.clone();
                Box::pin(async move {
                    executed.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                    let command: ClientCommand = serde_json::from_str(&text).unwrap();
                    ServerResponse::ok(command.id, json!({}))
                })
            })
        };
        let (command_tx, command_rx) = mpsc::channel(4);
        let (outgoing_tx, mut outgoing_rx) = mpsc::channel(4);
        let transport = std::sync::Arc::new(WebSocketTransportMetrics::default());
        let connection = transport.register_connection();
        let command_metrics = connection.incoming_command_queue;
        let reliable_metrics = connection.reliable_response_queue;
        let (pressure_tx, _pressure_rx) = mpsc::channel(1);
        let slow_pressure = WebSocketSlowPressureSignal::new(pressure_tx, transport);
        let state = test_state();

        assert!(
            send_test_websocket_command(
                &state,
                &command_tx,
                &command_metrics,
                json!({ "id": "stale", "method": "screens.activate", "params": {} }).to_string(),
            )
            .await
        );
        tokio::time::advance(WEBSOCKET_LIVE_CONTROL_MAX_QUEUE_AGE + Duration::from_millis(1)).await;

        let dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state,
            command_rx,
            command_metrics,
            outgoing_tx,
            reliable_metrics.clone(),
            slow_pressure,
            handler,
        ));
        drop(command_tx);
        dispatcher.await.unwrap();

        let response = receive_tracked_json(&mut outgoing_rx, &reliable_metrics).await;
        assert_eq!(response["id"], "stale");
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "command-expired-before-dispatch");
        assert_eq!(
            executed.load(std::sync::atomic::Ordering::Acquire),
            0,
            "work expired in the connection queue must never reach the handler"
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
        let state = test_state();
        let dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            command_rx,
            command_metrics.clone(),
            outgoing_tx,
            reliable_metrics.clone(),
            slow_pressure,
            handler,
        ));

        for index in 0..100 {
            assert!(
                send_test_websocket_command(
                    &state,
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
        let relay_state = AppState::new(
            "lag-repair-token".to_string(),
            0,
            events_tx.clone(),
            Database::open_in_memory_for_tests(),
        );
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
            relay_state.clone(),
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

        let terminal = capture_recovery::seed_terminal_capture_recovery_failure_for_transport_test(
            &relay_state,
        )
        .await;
        assert_eq!(terminal.phase, protocol::CaptureRecoveryPhase::Failed);

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

        let recovery = receive_tracked_json(&mut outgoing_rx, &reliable_metrics).await;
        assert_eq!(recovery["event"], "capture.recovery.status");
        assert_eq!(recovery["payload"]["phase"], "failed");
        assert_eq!(recovery["payload"]["revision"], terminal.revision);

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
        relay.abort();
        let relay_error = timeout(Duration::from_secs(1), relay)
            .await
            .expect("event relay did not stop after production-mirrored cancellation")
            .expect_err("cancelled event relay unexpectedly completed normally");
        assert!(
            relay_error.is_cancelled(),
            "event relay teardown returned a non-cancellation join error: {relay_error}"
        );
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
    async fn library_delete_cancels_repair_and_quarantines_before_repair_can_resume() {
        let state = test_state();
        let directory =
            std::env::temp_dir().join(format!("videorc-delete-repair-race-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let recording = directory.join("recording.mp4");
        std::fs::write(&recording, b"original recording").unwrap();
        let session_id = "delete-repair-race";
        state
            .database
            .create_session(&crate::storage::NewSession {
                id: session_id.to_string(),
                title: "Delete repair race".to_string(),
                started_at: "2026-08-28T00:00:00Z".to_string(),
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
        state
            .database
            .finish_session(
                session_id,
                "completed",
                None,
                Some(recording.display().to_string()),
                Some(1_000),
            )
            .unwrap();

        // The maintenance permit models a repair between its initial existence
        // check and safe_replace. Deletion must cancel it and cannot touch the
        // file until that exact mutation owner has exited.
        let repair = state.ffmpeg_work.try_begin_maintenance().unwrap();
        let repair_cancel = repair.cancel_token();
        let deletion = tokio::spawn({
            let state = state.clone();
            async move { prepare_session_deletions_exclusively(&state, &[session_id.to_string()]).await }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !repair_cancel.is_cancelled() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("delete must request repair cancellation");
        assert!(repair_cancel.is_cancelled());
        assert!(!deletion.is_finished());
        assert!(recording.exists());

        drop(repair);
        let operations = tokio::time::timeout(Duration::from_secs(1), deletion)
            .await
            .expect("delete must acquire the mutation boundary after repair exits")
            .expect("delete task")
            .expect("delete preparation");
        assert_eq!(operations.len(), 1);
        assert!(!recording.exists(), "the visible path must stay absent");
        assert_eq!(operations[0].paths.len(), 1);
        let quarantine = PathBuf::from(&operations[0].paths[0]);
        assert!(quarantine.exists());

        // A resumed background repair enters only after deletion and therefore
        // observes the missing original instead of recreating it from a temp.
        let resumed_repair = state.ffmpeg_work.try_begin_maintenance().unwrap();
        assert!(!recording.exists());
        drop(resumed_repair);

        std::fs::remove_file(quarantine).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn empty_pending_deletion_poll_does_not_cancel_active_maintenance() {
        let state = test_state();
        let maintenance = state.ffmpeg_work.try_begin_maintenance().unwrap();
        let cancel = maintenance.cancel_token();

        let pending = pending_session_deletions_exclusively(&state)
            .await
            .expect("empty pending deletion poll");

        assert!(pending.is_empty());
        assert!(!cancel.is_cancelled());
        assert!(!state.ffmpeg_work.snapshot().maintenance_cancel_requested);
        drop(maintenance);
    }

    fn spawn_test_process_shutdown_preparation_owner(
        state: AppState,
    ) -> tokio::task::JoinHandle<Result<()>> {
        tokio::spawn(async move {
            state.wait_for_process_shutdown_request().await;
            prepare_and_publish_capture_finalization_for_process_shutdown(&state).await
        })
    }

    #[tokio::test]
    async fn hard_exit_arms_once_and_only_after_recording_finalization_is_safe() {
        let state = test_state();
        let finalizing = state.ffmpeg_work.begin_finalizing();
        let armed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let task_state = state.clone();
        let task_armed = armed.clone();
        let preparation = tokio::spawn(async move {
            arm_hard_exit_after_safe_preparation(
                prepare_and_publish_capture_finalization_for_process_shutdown(&task_state),
                move || {
                    task_armed.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                },
            )
            .await
        });

        timeout(
            Duration::from_secs(1),
            state.wait_for_process_shutdown_request(),
        )
        .await
        .expect("shutdown latch before recording finalization");
        tokio::task::yield_now().await;
        assert_eq!(armed.load(std::sync::atomic::Ordering::Acquire), 0);
        assert!(
            !preparation.is_finished(),
            "the hard-exit deadline must not arm while FFmpeg finalization is owned"
        );

        drop(finalizing);
        timeout(Duration::from_secs(1), preparation)
            .await
            .expect("safe finalization completion")
            .expect("preparation task")
            .expect("safe preparation");
        assert_eq!(
            armed.load(std::sync::atomic::Ordering::Acquire),
            1,
            "successful finalization arms exactly one hard-exit deadline"
        );
    }

    #[tokio::test]
    async fn hard_exit_never_arms_after_recording_finalization_error() {
        let armed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let task_armed = armed.clone();
        let result = arm_hard_exit_after_safe_preparation(
            async { Err(anyhow::anyhow!("simulated unsafe recording finalization")) },
            move || {
                task_armed.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            },
        )
        .await;

        assert!(result.is_err());
        assert_eq!(
            armed.load(std::sync::atomic::Ordering::Acquire),
            0,
            "unsafe recording finalization must remain alive for recovery"
        );
    }

    #[tokio::test]
    async fn shutdown_prepare_is_admin_only_generation_bound_and_waits_for_publication() {
        let state = test_state();
        let renderer_response = process_shutdown_prepare_handler(
            State(state.clone()),
            Query(ProcessShutdownPrepareQuery {
                token: state.token.clone(),
                request_id: Uuid::new_v4().to_string(),
            }),
        )
        .await;
        assert_eq!(renderer_response.status(), StatusCode::UNAUTHORIZED);
        assert!(!state.process_shutdown_requested());

        let publication = state
            .session_start_publication_fence
            .clone()
            .lock_owned()
            .await;
        let preparation_owner = spawn_test_process_shutdown_preparation_owner(state.clone());
        let request_id = Uuid::new_v4().to_string();
        let request_state = state.clone();
        let request_token = state.admin_token.clone();
        let request_id_for_task = request_id.clone();
        let request = tokio::spawn(async move {
            process_shutdown_prepare_handler(
                State(request_state),
                Query(ProcessShutdownPrepareQuery {
                    token: request_token,
                    request_id: request_id_for_task,
                }),
            )
            .await
        });

        timeout(
            Duration::from_secs(1),
            state.wait_for_process_shutdown_request(),
        )
        .await
        .expect("shutdown request notification must be lossless");
        assert!(state.process_shutdown_requested());
        assert!(
            !request.is_finished(),
            "receipt cannot precede the accepted-start publication fence"
        );

        drop(publication);
        let response = timeout(Duration::from_secs(1), request)
            .await
            .expect("shutdown preparation response")
            .expect("shutdown preparation task");
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 16 * 1024)
            .await
            .expect("shutdown preparation body");
        let payload: serde_json::Value =
            serde_json::from_slice(&body).expect("shutdown preparation JSON");
        assert_eq!(payload["shutdownLatched"], true);
        assert_eq!(payload["captureFinalizationComplete"], true);
        assert_eq!(payload["requestId"], request_id);
        assert_eq!(payload["backendPid"], std::process::id());
        timeout(Duration::from_secs(1), preparation_owner)
            .await
            .expect("process-owned preparation completion")
            .expect("process-owned preparation task")
            .expect("process-owned preparation result");
    }

    #[tokio::test]
    async fn shutdown_prepare_receipt_flushes_through_real_axum_graceful_shutdown() {
        let state = test_state();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route(
                "/process/shutdown/prepare",
                post(process_shutdown_prepare_handler),
            )
            .with_state(state.clone());
        let graceful_state = state.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    graceful_state.wait_for_process_shutdown_request().await;
                    prepare_and_publish_capture_finalization_for_process_shutdown(&graceful_state)
                        .await
                        .expect("test process-owned shutdown preparation");
                })
                .await
                .expect("test Axum server");
        });

        let request_id = Uuid::new_v4().to_string();
        let response = timeout(
            Duration::from_secs(2),
            reqwest::Client::new()
                .post(format!(
                    "http://{address}/process/shutdown/prepare?token={}&requestId={request_id}",
                    state.admin_token
                ))
                .send(),
        )
        .await
        .expect("shutdown preparation HTTP response")
        .expect("shutdown preparation HTTP request");
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let payload: serde_json::Value = response
            .json()
            .await
            .expect("shutdown preparation HTTP JSON");
        assert_eq!(
            payload,
            serde_json::json!({
                "shutdownLatched": true,
                "captureFinalizationComplete": true,
                "requestId": request_id,
                "backendPid": std::process::id(),
            })
        );
        timeout(Duration::from_secs(2), server)
            .await
            .expect("graceful Axum server completion")
            .expect("graceful Axum server task");
    }

    #[tokio::test]
    async fn shutdown_prepare_waits_for_recording_finalization_before_safe_receipt() {
        let state = test_state();
        let finalizing = state.ffmpeg_work.begin_finalizing();
        let preparation_owner = spawn_test_process_shutdown_preparation_owner(state.clone());
        let request_id = Uuid::new_v4().to_string();
        let request_state = state.clone();
        let request_token = state.admin_token.clone();
        let request_id_for_task = request_id.clone();
        let request = tokio::spawn(async move {
            process_shutdown_prepare_handler(
                State(request_state),
                Query(ProcessShutdownPrepareQuery {
                    token: request_token,
                    request_id: request_id_for_task,
                }),
            )
            .await
        });

        timeout(
            Duration::from_secs(1),
            state.wait_for_process_shutdown_request(),
        )
        .await
        .expect("shutdown preparation must latch before waiting for finalization");
        assert!(
            !request.is_finished(),
            "safe receipt cannot precede the authoritative finalization lease"
        );

        drop(finalizing);
        let response = timeout(Duration::from_secs(1), request)
            .await
            .expect("shutdown preparation response after finalization")
            .expect("shutdown preparation task");
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 16 * 1024)
            .await
            .expect("shutdown preparation body");
        let payload: serde_json::Value =
            serde_json::from_slice(&body).expect("shutdown preparation JSON");
        assert_eq!(
            payload,
            serde_json::json!({
                "shutdownLatched": true,
                "captureFinalizationComplete": true,
                "requestId": request_id,
                "backendPid": std::process::id(),
            })
        );
        timeout(Duration::from_secs(1), preparation_owner)
            .await
            .expect("process-owned preparation completion")
            .expect("process-owned preparation task")
            .expect("process-owned preparation result");
    }

    #[tokio::test]
    async fn cancelling_shutdown_http_request_cannot_cancel_process_owned_finalization() {
        let state = test_state();
        let finalizing = state.ffmpeg_work.begin_finalizing();
        let preparation_owner = spawn_test_process_shutdown_preparation_owner(state.clone());
        let request_state = state.clone();
        let request_token = state.admin_token.clone();
        let request = tokio::spawn(async move {
            process_shutdown_prepare_handler(
                State(request_state),
                Query(ProcessShutdownPrepareQuery {
                    token: request_token,
                    request_id: Uuid::new_v4().to_string(),
                }),
            )
            .await
        });

        timeout(
            Duration::from_secs(1),
            state.wait_for_process_shutdown_request(),
        )
        .await
        .expect("shutdown request latch");
        assert!(!preparation_owner.is_finished());
        request.abort();
        request
            .await
            .expect_err("HTTP request task must be cancelled");

        drop(finalizing);
        timeout(Duration::from_secs(1), preparation_owner)
            .await
            .expect("process-owned preparation survives request cancellation")
            .expect("process-owned preparation task")
            .expect("process-owned preparation result");
        timeout(
            Duration::from_secs(1),
            state.wait_for_process_shutdown_preparation(),
        )
        .await
        .expect("shared preparation result")
        .expect("safe shared preparation result");
    }

    #[tokio::test]
    async fn process_shutdown_notification_wakes_waiter_registered_before_request() {
        let state = test_state();
        let waiter_state = state.clone();
        let (registered_sender, registered_receiver) = tokio::sync::oneshot::channel();
        let waiter = tokio::spawn(async move {
            let mut shutdown_request = Box::pin(waiter_state.wait_for_process_shutdown_request());
            assert!(
                futures_util::poll!(&mut shutdown_request).is_pending(),
                "a waiter registered before shutdown must initially remain pending"
            );
            registered_sender
                .send(())
                .expect("publish shutdown waiter registration");
            shutdown_request.await;
        });

        timeout(Duration::from_secs(1), registered_receiver)
            .await
            .expect("shutdown waiter registration")
            .expect("shutdown waiter registration sender");
        assert!(state.request_process_shutdown());
        timeout(Duration::from_secs(1), waiter)
            .await
            .expect("registered shutdown waiter must receive the request")
            .expect("shutdown waiter task");
        assert!(state.process_shutdown_requested());
    }

    #[tokio::test]
    async fn shutdown_prepare_rejects_malformed_request_identity_without_latching() {
        let state = test_state();
        let response = process_shutdown_prepare_handler(
            State(state.clone()),
            Query(ProcessShutdownPrepareQuery {
                token: state.admin_token.clone(),
                request_id: "not-a-uuid".to_string(),
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(!state.process_shutdown_requested());
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
    async fn windows_d3d11_main_owned_preview_bounds_are_admin_only() {
        let state = test_state();
        let response = handle_text_message_with_role(
            &state,
            &serde_json::json!({
                "id": "forged-preview-hwnd",
                "method": "resource.admin.preview_surface_bounds",
                "params": {
                    "bounds": {
                        "screenX": 0.0,
                        "screenY": 0.0,
                        "width": 640.0,
                        "height": 360.0,
                        "scaleFactor": 1.0,
                        "orderAboveWindowHandle": "0x000000001234abcd"
                    },
                    "generation": 7
                }
            })
            .to_string(),
            BackendRole::Renderer,
        )
        .await;

        assert!(!response.ok);
        let error = response.error.expect("renderer HWND request rejection");
        assert_eq!(error.code, "forbidden-method");
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
    async fn stream_targets_snapshot_rpc_fails_closed_without_an_active_session() {
        let state = test_state();
        let response = handle_text_message(
            &state,
            r#"{"id":"targets","method":"stream.targets.snapshot","params":{}}"#,
        )
        .await;

        assert!(!response.ok);
        let error = response.error.expect("idle snapshot error");
        assert_eq!(error.code, "stream-targets-unavailable");
        assert!(error.message.contains("No active capture session"));
    }

    #[tokio::test]
    async fn stream_targets_snapshot_rpc_rejects_non_empty_parameters() {
        let state = test_state();
        let response = handle_text_message(
            &state,
            r#"{"id":"targets","method":"stream.targets.snapshot","params":{"sessionId":"stale"}}"#,
        )
        .await;

        assert!(!response.ok);
        assert_eq!(
            response.error.expect("parameter rejection").code,
            "invalid-params"
        );
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

    #[test]
    fn account_sign_out_revokes_entitlements_before_credentials_are_cleared() {
        let premium = std::cell::Cell::new(true);
        let entitlement_update_emitted = std::cell::Cell::new(false);
        let credentials_present = std::cell::Cell::new(true);

        let result = clear_account_credentials_fail_closed(
            || {
                premium.set(false);
                entitlement_update_emitted.set(true);
            },
            || {
                assert!(
                    !premium.get(),
                    "premium gates must close before credentials are deleted"
                );
                assert!(
                    entitlement_update_emitted.get(),
                    "the Basic entitlement update must be emitted before credential deletion"
                );
                credentials_present.set(false);
                "cleared"
            },
        );

        assert_eq!(result, "cleared");
        assert!(!credentials_present.get());
    }

    #[test]
    fn account_sign_out_rejects_failed_caption_privacy_cleanup_before_account_mutation() {
        let mut status = captions::CaptionsStatus::idle();
        status.state = captions::CaptionsState::Blocked;
        status.reason_code = Some("captions-privacy-cleanup-failed".to_string());
        status.message = Some("injected private cleanup failure".to_string());
        let account_still_signed_in = std::cell::Cell::new(true);

        let result = caption_sign_out_cleanup_result(&status);
        if result.is_ok() {
            account_still_signed_in.set(false);
        }

        assert_eq!(result, Err("injected private cleanup failure".to_string()));
        assert!(
            account_still_signed_in.get(),
            "a failed caption privacy boundary must preserve the in-memory account"
        );
    }

    #[tokio::test]
    async fn account_sign_out_stops_active_captions_before_credentials_are_cleared() {
        let _caption_test_guard = captions::caption_lifecycle_test_lock().lock().await;
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
        let _caption_test_guard = captions::caption_lifecycle_test_lock().lock().await;
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
        let _caption_test_guard = captions::caption_lifecycle_test_lock().lock().await;
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
        let _caption_test_guard = captions::caption_lifecycle_test_lock().lock().await;
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
        let _caption_test_guard = captions::caption_lifecycle_test_lock().lock().await;
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
        let _caption_test_guard = captions::caption_lifecycle_test_lock().lock().await;
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
    async fn websocket_session_finishes_when_process_shutdown_is_latched() {
        let handler: WebSocketCommandHandler = std::sync::Arc::new(|_state, text| {
            Box::pin(async move {
                let command: ClientCommand = serde_json::from_str(&text).unwrap();
                ServerResponse::ok(command.id, json!({}))
            })
        });
        let state = test_state();
        let token = state.token.clone();
        let session_finished = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_state = TestWebSocketState {
            app: state.clone(),
            command_handler: handler,
            session_finished: session_finished.clone(),
        };
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                Router::new()
                    .route("/ws", get(test_ws_handler))
                    .with_state(server_state),
            )
            .await;
        });
        let (mut socket, _) =
            tokio_tungstenite::connect_async(format!("ws://{address}/ws?token={token}"))
                .await
                .unwrap();
        timeout(Duration::from_secs(1), async {
            loop {
                let message = socket.next().await.unwrap().unwrap();
                let tokio_tungstenite::tungstenite::Message::Text(text) = message else {
                    continue;
                };
                let event: serde_json::Value = serde_json::from_str(&text).unwrap();
                if event["event"] == "backend.ready" {
                    break;
                }
            }
        })
        .await
        .expect("backend.ready confirms the upgraded session is active");

        state.request_process_shutdown();
        timeout(Duration::from_secs(1), session_finished.acquire())
            .await
            .expect("shutdown must finish the WebSocket session")
            .unwrap()
            .forget();

        let _ = socket.close(None).await;
        server.abort();
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
        let command_metrics = connection.incoming_command_queue;
        let reliable_metrics = connection.reliable_response_queue;
        let (pressure_tx, _pressure_rx) = mpsc::channel(1);
        let slow_pressure = WebSocketSlowPressureSignal::new(pressure_tx, transport);
        let state = test_state();
        let dispatcher = tokio::spawn(run_websocket_command_dispatcher(
            state.clone(),
            command_rx,
            command_metrics.clone(),
            outgoing_tx,
            reliable_metrics,
            slow_pressure,
            handler,
        ));

        for id in ["legacy-first", "legacy-second"] {
            assert!(
                send_test_websocket_command(
                    &state,
                    &command_tx,
                    &command_metrics,
                    json!({
                        "id": id,
                        "method": "scene.layout.apply_preview",
                        "params": {}
                    })
                    .to_string(),
                )
                .await
            );
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

    fn preview_layout_video_settings() -> protocol::VideoSettings {
        protocol::VideoSettings {
            preset: protocol::VideoPreset::Tutorial1440p30,
            width: 2560,
            height: 1440,
            fps: 30,
            bitrate_kbps: 8000,
        }
    }

    fn preview_layout_params(intent_id: u64, preset: protocol::LayoutPreset) -> serde_json::Value {
        let mut layout = protocol::default_layout_settings();
        layout.layout_preset = preset;
        let config = protocol::SceneConfigParams {
            transition_ms: None,
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
    async fn stream_output_topology_probe_rpc_returns_a_secret_free_typed_verdict() {
        let state = test_state();
        let missing_ffmpeg_marker = format!("videorc-missing-ffmpeg-{}", Uuid::new_v4());
        let missing_ffmpeg_path = std::env::temp_dir().join(&missing_ffmpeg_marker).join(
            if cfg!(target_os = "windows") {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            },
        );
        assert!(
            !missing_ffmpeg_path.exists(),
            "the topology test requires a guaranteed-missing FFmpeg path"
        );
        let missing_ffmpeg_path = missing_ffmpeg_path.to_string_lossy().into_owned();
        let response = request_for_test(
            &state,
            "topology-probe",
            "stream.output.topology.probe",
            json!({
                "ffmpegPath": missing_ffmpeg_path,
                "streamProfile": {
                    "preset": "stream-safe-1080p30",
                    "width": 1920,
                    "height": 1080,
                    "fps": 30,
                    "bitrateKbps": 6000
                },
                "outputRoles": ["shared"]
            }),
        )
        .await;

        assert!(response.ok, "{:?}", response.error);
        let payload = response.payload.expect("topology probe payload");
        assert_eq!(payload["streamProfile"]["width"], 1920);
        assert_eq!(payload["outputRoles"], json!(["shared"]));
        #[cfg(target_os = "windows")]
        {
            assert_eq!(
                payload["requestedBridgeOutput"],
                "windows-media-foundation-h264-mpegts"
            );
            match payload["probeState"].as_str() {
                Some("passed") => {
                    assert_eq!(
                        payload["effectiveBridgeOutput"],
                        "windows-media-foundation-h264-mpegts"
                    );
                    assert!(payload["fallbackReason"].is_null());
                }
                Some("rejected") | Some("unsupported") => {
                    assert_eq!(payload["effectiveBridgeOutput"], "raw-yuv420p");
                    let fallback_reason = payload["fallbackReason"]
                        .as_str()
                        .expect("a rejected Media Foundation topology has a fallback reason");
                    assert!(!fallback_reason.trim().is_empty());
                    assert!(
                        fallback_reason.len() <= 480,
                        "topology fallback reason must remain protocol-bounded"
                    );
                }
                verdict => panic!("unexpected Media Foundation topology verdict: {verdict:?}"),
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(
                payload["requestedBridgeOutput"], payload["effectiveBridgeOutput"],
                "the source default must not fabricate a probed fallback"
            );
            assert_eq!(payload["probeState"], "not-required");
        }
        let capability_key = payload["capabilityKey"]
            .as_str()
            .expect("hashed capability key");
        assert!(capability_key.starts_with("stream-output-topology-v1:"));
        assert_eq!(
            capability_key.len(),
            "stream-output-topology-v1:".len() + 64
        );
        let serialized = payload.to_string().to_ascii_lowercase();
        assert!(
            !serialized.contains(&missing_ffmpeg_marker.to_ascii_lowercase()),
            "the local FFmpeg probe path must not leave the backend"
        );
        assert!(!serialized.contains("streamkey"));
        assert!(!serialized.contains("serverurl"));
        assert!(!serialized.contains("accesstoken"));
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
        crate::preview_screen::test_install_starting_screen_generation(
            &state,
            "screen:screencapturekit:1",
            &preview_layout_video_settings(),
            None,
        )
        .await;

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
        let screen_video = preview_layout_video_settings();
        let pending_screen = crate::preview_screen::test_install_starting_screen_generation(
            &state,
            "screen:screencapturekit:1",
            &screen_video,
            None,
        )
        .await;

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

        crate::preview_screen::test_install_live_screen_generation(
            &state,
            "screen:screencapturekit:1",
            pending_screen.generation,
            1,
            &screen_video,
        )
        .await;

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
        let initial = request_for_test(
            &state,
            "initial-cancel",
            "scene.load_from_capture_config",
            preview_layout_params(0, protocol::LayoutPreset::CameraOnly),
        )
        .await;
        assert!(initial.ok);
        crate::preview_screen::test_install_starting_screen_generation(
            &state,
            "screen:screencapturekit:1",
            &preview_layout_video_settings(),
            None,
        )
        .await;

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

    fn fake_live_chat_start_params(
        session_id: &str,
        target_id: &str,
    ) -> live_chat::LiveChatStartParams {
        serde_json::from_value(serde_json::json!({
            "sessionId": session_id,
            "platforms": ["youtube"],
            "destinations": [{
                "targetId": target_id,
                "platform": "youtube"
            }],
            "fake": {
                "platform": "youtube",
                "targetId": target_id,
                "count": 1,
                "intervalMs": 60_000
            }
        }))
        .expect("fake live-chat start params")
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
        *state.recording.lock().await = Some(recording::test_active_recording_stub(
            "manual-twitch-session",
        ));
        let streaming = streaming_with_enabled_target(
            StreamPlatform::Twitch,
            crate::streaming::StreamAuthMode::ManualRtmp,
        );

        assert!(spawn_session_live_chat(&state, "manual-twitch-session", &streaming).await);

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
        *state.recording.lock().await = Some(recording::test_active_recording_stub(
            "stale-twitch-session",
        ));
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

        assert!(spawn_session_live_chat(&state, "stale-twitch-session", &streaming).await);

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

    #[tokio::test]
    async fn fast_terminal_cannot_resurrect_chat_or_contaminate_a_replacement_session() {
        let terminal_state = test_state();
        let terminal_session_id = "fast-terminal-chat-session";
        let mut terminal_recording = terminal_state.recording.lock().await;
        *terminal_recording = Some(recording::test_active_recording_stub(terminal_session_id));

        let late_attach_state = terminal_state.clone();
        let late_attach = tokio::spawn(async move {
            attach_prepared_session_live_chat(
                &late_attach_state,
                terminal_session_id,
                fake_live_chat_start_params(terminal_session_id, "late-terminal-target"),
            )
            .await
        });

        // Model the monitor's exact retirement edge while the already-returned
        // session.start handler is waiting to attach Comments. The monitor then
        // tears the session-owned coordinator down after releasing this lock.
        terminal_recording.take();
        drop(terminal_recording);
        live_chat::stop_live_chat(&terminal_state).await;

        assert!(!late_attach.await.expect("late Comments attachment task"));
        let terminal_snapshot = live_chat::current_status(&terminal_state).await;
        assert_eq!(terminal_snapshot.session_id, None);
        assert_eq!(
            terminal_state.live_chat.lock().await.runtime_ownership(),
            (0, 0),
            "terminal session must retain neither connector tasks nor send credentials"
        );

        let stopping_state = test_state();
        let stopping_session_id = "stop-requested-before-chat-attachment";
        let mut stopping_recording = recording::test_active_recording_stub(stopping_session_id);
        stopping_recording.stop_requested = true;
        *stopping_state.recording.lock().await = Some(stopping_recording);
        assert!(
            !attach_prepared_session_live_chat(
                &stopping_state,
                stopping_session_id,
                fake_live_chat_start_params(stopping_session_id, "stopping-target"),
            )
            .await,
            "an exact session already committed to Stop must not attach Comments"
        );
        assert_eq!(
            stopping_state.live_chat.lock().await.runtime_ownership(),
            (0, 0)
        );

        // A delayed attachment can also resume after the next capture is live.
        // Keep the mutex continuously owned while replacing the recording so
        // the stale task deterministically observes the replacement, not a
        // scheduler-dependent intermediate None.
        let replacement_state = test_state();
        let stale_session_id = "retired-before-chat-attachment";
        let replacement_session_id = "replacement-chat-session";
        let mut replacement_recording = replacement_state.recording.lock().await;
        *replacement_recording = Some(recording::test_active_recording_stub(stale_session_id));
        let stale_attach_state = replacement_state.clone();
        let stale_attach = tokio::spawn(async move {
            attach_prepared_session_live_chat(
                &stale_attach_state,
                stale_session_id,
                fake_live_chat_start_params(stale_session_id, "stale-target"),
            )
            .await
        });
        *replacement_recording = Some(recording::test_active_recording_stub(
            replacement_session_id,
        ));
        live_chat::start_live_chat(
            &replacement_state,
            fake_live_chat_start_params(replacement_session_id, "replacement-target"),
        )
        .await;
        drop(replacement_recording);

        assert!(!stale_attach.await.expect("stale Comments attachment task"));
        let replacement_snapshot = live_chat::current_status(&replacement_state).await;
        assert_eq!(
            replacement_snapshot.session_id.as_deref(),
            Some(replacement_session_id)
        );
        assert_eq!(
            replacement_state.live_chat.lock().await.runtime_ownership(),
            (1, 1),
            "stale attachment must not replace or append to the replacement connector set"
        );
        live_chat::stop_live_chat(&replacement_state).await;
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
    fn callback_page_escapes_provider_supplied_failure_text() {
        // Provider messages reach the page verbatim; markup in them must never
        // become markup on the page.
        let escaped = html_escape_text("<script>alert('x')</script> & \"quoted\"");

        assert!(!escaped.contains('<'));
        assert!(!escaped.contains('>'));
        assert!(escaped.contains("&lt;script&gt;"));
        assert!(escaped.contains("&amp;"));
        assert!(escaped.contains("&quot;"));
        assert!(escaped.contains("&#39;"));
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
    async fn busy_surface_lifecycle_answers_surface_busy_instead_of_stalling() {
        // 2026-08-27 live incident: with the lifecycle mutex held by a healing
        // destroy/create cycle, an update_bounds sat as the running stateful
        // mutation for 30+ seconds with no response, barriering the whole
        // ordered lane until it filled. Bounded acquisition must answer fast
        // with a retryable error instead.
        let state = test_state();
        let _lifecycle_held = state.preview_surface_lifecycle.clone().lock_owned().await;
        let bounds = json!({
            "id": "bounds",
            "method": "preview.surface.update_bounds",
            "params": {
                "bounds": {
                    "screenX": 10.0,
                    "screenY": 20.0,
                    "width": 640.0,
                    "height": 360.0,
                    "scaleFactor": 2.0,
                    "screenHeight": 1000.0
                }
            }
        });
        let started = std::time::Instant::now();
        let response = handle_text_message(&state, &bounds.to_string()).await;
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!response.ok);
        let error = response.error.expect("busy error");
        assert_eq!(error.code, PreviewSurfaceBusy::CODE);

        let destroy = json!({ "id": "destroy", "method": "preview.surface.destroy" });
        let response = handle_text_message(&state, &destroy.to_string()).await;
        assert!(!response.ok);
        assert_eq!(
            response.error.expect("busy error").code,
            PreviewSurfaceBusy::CODE
        );
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

        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
    }
}
