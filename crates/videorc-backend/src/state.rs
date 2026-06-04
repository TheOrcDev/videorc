use std::sync::Arc;
use std::time::Instant;

use chrono::Utc;
use tokio::sync::broadcast;

use crate::diagnostics::idle_diagnostics;
use crate::ffmpeg_work::FfmpegWorkCoordinator;
use crate::oauth::OAuthSessions;
use crate::preview_camera::{PreviewCameraSlot, initial_preview_camera_state};
use crate::preview_screen::{PreviewScreenSlot, initial_preview_screen_state};
use crate::preview_surface::{PreviewSurfaceSlot, initial_preview_surface_state};
use crate::protocol::{BackendLogEvent, DiagnosticStats, Scene, ServerEvent};
use crate::recording::{LivePreviewSlot, RecordingSlot, initial_live_preview_state};
use crate::scene::default_scene;
use crate::storage::Database;

const PREVIEW_FRAME_CHANNEL_CAPACITY: usize = 256;

#[derive(Clone)]
pub struct PreviewFrame {
    pub sequence: u64,
    pub bytes: Vec<u8>,
    pub published_at: Instant,
}

#[derive(Debug, Default)]
pub struct PreviewMetricsState {
    pub next_sequence: u64,
    pub last_presented_at: Option<Instant>,
    pub last_presented_sequence: Option<u64>,
    pub present_fps: Option<f64>,
    pub repeated_frames: u64,
    pub surface_resize_count: u64,
}

#[derive(Clone)]
pub struct AppState {
    pub token: String,
    pub port: u16,
    pub events: broadcast::Sender<ServerEvent>,
    pub recording: RecordingSlot,
    pub live_preview: LivePreviewSlot,
    pub preview_frames: broadcast::Sender<Vec<u8>>,
    pub preview_latest_frame: Arc<tokio::sync::RwLock<Option<PreviewFrame>>>,
    pub preview_metrics: Arc<tokio::sync::Mutex<PreviewMetricsState>>,
    pub preview_camera: PreviewCameraSlot,
    pub preview_screen: PreviewScreenSlot,
    pub preview_surface: PreviewSurfaceSlot,
    pub scene: Arc<tokio::sync::Mutex<Scene>>,
    pub diagnostics: Arc<tokio::sync::Mutex<DiagnosticStats>>,
    pub database: Database,
    pub oauth: Arc<OAuthSessions>,
    pub ffmpeg_work: Arc<FfmpegWorkCoordinator>,
}

impl AppState {
    pub fn new(
        token: String,
        port: u16,
        events: broadcast::Sender<ServerEvent>,
        database: Database,
    ) -> Self {
        Self {
            token,
            port,
            events,
            recording: Arc::new(tokio::sync::Mutex::new(None)),
            live_preview: Arc::new(tokio::sync::Mutex::new(initial_live_preview_state())),
            preview_frames: broadcast::channel(PREVIEW_FRAME_CHANNEL_CAPACITY).0,
            preview_latest_frame: Arc::new(tokio::sync::RwLock::new(None)),
            preview_metrics: Arc::new(tokio::sync::Mutex::new(PreviewMetricsState::default())),
            preview_camera: Arc::new(tokio::sync::Mutex::new(initial_preview_camera_state())),
            preview_screen: Arc::new(tokio::sync::Mutex::new(initial_preview_screen_state())),
            preview_surface: Arc::new(tokio::sync::Mutex::new(initial_preview_surface_state())),
            scene: Arc::new(tokio::sync::Mutex::new(default_scene())),
            diagnostics: Arc::new(tokio::sync::Mutex::new(idle_diagnostics())),
            database,
            oauth: Arc::new(OAuthSessions::default()),
            ffmpeg_work: Arc::new(FfmpegWorkCoordinator::new()),
        }
    }

    pub fn emit_event<T: serde::Serialize>(&self, event: impl Into<String>, payload: T) {
        let _ = self.events.send(ServerEvent::new(event, payload));
    }

    pub fn emit_log(&self, level: impl Into<String>, message: impl Into<String>) {
        let payload = BackendLogEvent {
            level: level.into(),
            message: message.into(),
            timestamp: Utc::now().to_rfc3339(),
        };
        let level = payload.level.clone();
        let message = payload.message.clone();
        match level.as_str() {
            "error" => tracing::error!("{message}"),
            "warn" => tracing::warn!("{message}"),
            _ => tracing::info!("{message}"),
        }
        self.emit_event("log", payload);
    }
}
