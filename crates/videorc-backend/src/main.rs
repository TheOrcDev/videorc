mod ai;
mod audio;
mod camera_capture;
mod devices;
mod ffmpeg;
mod pipeline;
mod protocol;
mod recording;
mod scene;
mod screen_capture;
mod state;
mod storage;

use std::convert::Infallible;
use std::io::Write;
use std::process::Stdio;
use std::time::Duration;

use anyhow::Result;
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{StatusCode, header};
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
    update_source_transform,
};
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::sync::{broadcast, mpsc};
use tokio::time::timeout;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use crate::ffmpeg::{default_ffmpeg_path, resolve_ffmpeg_path_ref};
use crate::state::AppState;
use crate::storage::Database;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("videorc_backend=info".parse()?),
        )
        .with_writer(std::io::stderr)
        .init();

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let token = Uuid::new_v4().to_string();
    let (events, _) = broadcast::channel(256);
    let database = Database::open_default()?;
    let state = AppState::new(token.clone(), port, events, database);
    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/preview/live.mjpeg", get(live_preview_handler))
        .route("/preview/{id}", get(preview_handler))
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
