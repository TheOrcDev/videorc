mod ai;
mod audio;
mod camera_capture;
mod devices;
mod diagnostics;
mod ffmpeg;
mod live_pipeline;
mod live_render;
mod live_scene;
mod oauth;
mod pipeline;
mod protocol;
mod recording;
mod scene;
mod screen_capture;
mod secrets;
mod state;
mod storage;
mod streaming;

use std::convert::Infallible;
use std::io::Write;
use std::process::Stdio;
use std::time::Duration;

use anyhow::Result;
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{StatusCode, header};
use axum::response::Html;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::stream;
use futures_util::{SinkExt, StreamExt};
use protocol::{
    BackendConnection, BackendHealth, ClientCommand, RecordingState, ServerEvent, ServerResponse,
    ToolStatus,
};
use recording::{
    create_preview_snapshot, idle_status, live_preview_status, preview_file_path, remux_session,
    shutdown_capture_processes, start_live_preview, start_session, stop_live_preview,
    stop_recording, subscribe_live_preview_frames,
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
use crate::state::AppState;
use crate::storage::Database;
use crate::streaming::{
    PlatformAccountStatus, PlatformAccountValidation, PlatformAccountValidationState,
    StreamMetadataDraft, UpsertPlatformAccount, validate_stream_metadata_draft,
};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("videorc_backend=info".parse()?),
        )
        .with_writer(std::io::stderr)
        .init();
    secrets::init_native_secret_store();

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let token = Uuid::new_v4().to_string();
    let (events, _) = broadcast::channel(256);
    let database = Database::open_default()?;
    let state = AppState::new(token.clone(), port, events, database);
    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/preview/live.mjpeg", get(live_preview_handler))
        .route("/preview/live.jpg", get(live_preview_frame_handler))
        .route("/preview/{id}", get(preview_handler))
        .route("/oauth/callback", get(oauth_callback_handler))
        .route("/ws", get(ws_handler))
        .with_state(state.clone());

    let ready = BackendConnection {
        host: "127.0.0.1".to_string(),
        port,
        token,
    };
    println!("READY {}", serde_json::to_string(&ready)?);
    std::io::stdout().flush()?;

    state.emit_log("info", "Videorc backend ready.");
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

#[derive(Debug, Deserialize)]
struct WsQuery {
    token: String,
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

async fn live_preview_frame_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
) -> Response {
    if query.token != state.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    match state.preview_latest_frame.read().await.clone() {
        Some(bytes) => (
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "no-store, no-cache, must-revalidate"),
                (header::PRAGMA, "no-cache"),
                (header::EXPIRES, "0"),
            ],
            bytes,
        )
            .into_response(),
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

        let mut access_token = match secrets::get_secret(access_ref) {
            Ok(token) => token,
            Err(error) => {
                account.status = PlatformAccountStatus::NeedsReconnect;
                changed |= upsert_validated_account(state, &credential, account.clone()).is_ok();
                validations.push(platform_validation(
                    &account,
                    PlatformAccountValidationState::NeedsReconnect,
                    format!("Could not read access token: {error}"),
                ));
                continue;
            }
        };

        let mut refreshed = false;
        if token_expires_soon(account.expires_at.as_deref()) {
            let Some(refresh_ref) = credential.refresh_token_secret_ref.as_deref() else {
                account.status = PlatformAccountStatus::NeedsReconnect;
                changed |= upsert_validated_account(state, &credential, account.clone()).is_ok();
                validations.push(platform_validation(
                    &account,
                    PlatformAccountValidationState::NeedsReconnect,
                    "Access token is expired and no refresh token is stored.",
                ));
                continue;
            };

            match secrets::get_secret(refresh_ref) {
                Ok(refresh_token) => {
                    match oauth::refresh_provider_token(account.platform, &refresh_token, &client)
                        .await
                    {
                        Ok(token) => {
                            if let Err(error) = secrets::put_secret(access_ref, &token.access_token)
                            {
                                account.status = PlatformAccountStatus::NeedsReconnect;
                                changed |=
                                    upsert_validated_account(state, &credential, account.clone())
                                        .is_ok();
                                validations.push(platform_validation(
                                    &account,
                                    PlatformAccountValidationState::NeedsReconnect,
                                    format!("Could not store refreshed access token: {error}"),
                                ));
                                continue;
                            }
                            if let Some(next_refresh_token) = token.refresh_token.as_deref()
                                && let Err(error) =
                                    secrets::put_secret(refresh_ref, next_refresh_token)
                            {
                                account.status = PlatformAccountStatus::NeedsReconnect;
                                changed |=
                                    upsert_validated_account(state, &credential, account.clone())
                                        .is_ok();
                                validations.push(platform_validation(
                                    &account,
                                    PlatformAccountValidationState::NeedsReconnect,
                                    format!("Could not store refreshed refresh token: {error}"),
                                ));
                                continue;
                            }
                            access_token = token.access_token;
                            account.scopes = token.scopes;
                            account.expires_at = token.expires_at;
                            account.status = PlatformAccountStatus::Connected;
                            changed |=
                                upsert_validated_account(state, &credential, account.clone())
                                    .is_ok();
                            refreshed = true;
                        }
                        Err(error) => {
                            account.status = PlatformAccountStatus::NeedsReconnect;
                            changed |=
                                upsert_validated_account(state, &credential, account.clone())
                                    .is_ok();
                            validations.push(platform_validation(
                                &account,
                                PlatformAccountValidationState::NeedsReconnect,
                                format!("Token refresh failed: {error}"),
                            ));
                            continue;
                        }
                    }
                }
                Err(error) => {
                    account.status = PlatformAccountStatus::NeedsReconnect;
                    changed |=
                        upsert_validated_account(state, &credential, account.clone()).is_ok();
                    validations.push(platform_validation(
                        &account,
                        PlatformAccountValidationState::NeedsReconnect,
                        format!("Could not read refresh token: {error}"),
                    ));
                    continue;
                }
            }
        }

        match oauth::validate_provider_access(account.platform, &access_token, &client).await {
            Ok(()) => {
                account.status = PlatformAccountStatus::Connected;
                changed |= upsert_validated_account(state, &credential, account.clone()).is_ok();
                validations.push(platform_validation(
                    &account,
                    if refreshed {
                        PlatformAccountValidationState::Refreshed
                    } else {
                        PlatformAccountValidationState::Valid
                    },
                    if refreshed {
                        "Token refreshed and account access is valid."
                    } else {
                        "Account access is valid."
                    },
                ));
            }
            Err(error) => {
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

    tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
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
        BackendConnection {
            host: "127.0.0.1".to_string(),
            port: state.port,
            token: state.token.clone(),
        },
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
                        let response = handle_text_message(&state, text.as_str()).await;
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
        "diagnostics.stats" => {
            let stats = state.diagnostics.lock().await.clone();
            ServerResponse::ok(command.id, stats)
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
                    let scene = scene_from_capture_config(params);
                    {
                        let mut guard = state.scene.lock().await;
                        *guard = scene.clone();
                    }
                    state.emit_event("scene.changed", &scene);
                    ServerResponse::ok(command.id, scene)
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
                            state.emit_event("scene.changed", &scene);
                            ServerResponse::ok(command.id, scene)
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
                            state.emit_event("scene.changed", &scene);
                            ServerResponse::ok(command.id, scene)
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
                            state.emit_event("scene.changed", &scene);
                            ServerResponse::ok(command.id, scene)
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
                            state.emit_event("scene.changed", &scene);
                            ServerResponse::ok(command.id, scene)
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
                            state.emit_event("scene.changed", &scene);
                            ServerResponse::ok(command.id, scene)
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
                Ok(params) => match start_session(state.clone(), params).await {
                    Ok(status) => ServerResponse::ok(command.id, status),
                    Err(error) => {
                        ServerResponse::error(command.id, "session-start-failed", error.to_string())
                    }
                },
                Err(error) => {
                    ServerResponse::error(command.id, "invalid-params", error.to_string())
                }
            }
        }
        "session.stop" => match stop_recording(state.clone()).await {
            Ok(status) => ServerResponse::ok(command.id, status),
            Err(error) => {
                ServerResponse::error(command.id, "session-stop-failed", error.to_string())
            }
        },
        "sessions.list" => match state.database.list_sessions(20) {
            Ok(sessions) => ServerResponse::ok(command.id, sessions),
            Err(error) => {
                ServerResponse::error(command.id, "sessions-list-failed", error.to_string())
            }
        },
        "platformAccounts.list" => match state.database.list_platform_accounts() {
            Ok(accounts) => ServerResponse::ok(command.id, accounts),
            Err(error) => ServerResponse::error(
                command.id,
                "platform-accounts-list-failed",
                error.to_string(),
            ),
        },
        "platformAccounts.oauth.start" => {
            match serde_json::from_value::<OAuthStartParams>(command.params) {
                Ok(params) => match state.oauth.start(params, state.port).await {
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
                Ok(params) => match state.oauth.start_provider(params, state.port).await {
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
        "recording.status" => {
            let status = state
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
                .unwrap_or_else(idle_status);
            ServerResponse::ok(command.id, status)
        }
        method => ServerResponse::error(
            command.id,
            "unknown-method",
            format!("Unknown backend method: {method}"),
        ),
    }
}

async fn backend_health(state: &AppState, ffmpeg_path: &str) -> BackendHealth {
    BackendHealth {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        ffmpeg: ffmpeg_status(ffmpeg_path).await,
        database_path: state.database.path().display().to_string(),
    }
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

    #[test]
    fn response_shape_omits_empty_error() {
        let response = ServerResponse::ok("abc", json!({ "pong": true }));
        let value = serde_json::to_value(response).unwrap();

        assert_eq!(value["id"], "abc");
        assert_eq!(value["ok"], true);
        assert!(value.get("error").is_none());
    }
}
