use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;

use chrono::Utc;
use tokio::sync::broadcast;

use crate::compositor::{CompositorSlot, initial_compositor_state};
use crate::diagnostics::idle_diagnostics;
use crate::ffmpeg_work::FfmpegWorkCoordinator;
use crate::live_chat::{LiveChatCoordinator, LiveChatSlot};
use crate::oauth::OAuthSessions;
use crate::preview_camera::{PreviewCameraSlot, initial_preview_camera_state};
use crate::preview_screen::{PreviewScreenSlot, initial_preview_screen_state};
use crate::preview_surface::{PreviewSurfaceSlot, initial_preview_surface_state};
use crate::protocol::{
    AudioMeterSampleSnapshot, BackendLogEvent, DiagnosticStats, Scene, ServerEvent,
    VideorcAccountSnapshot,
};
use crate::recording::{LivePreviewSlot, RecordingSlot, initial_live_preview_state};
use crate::scene::default_scene;
use crate::source_registry::SourceRegistry;
use crate::storage::Database;

const PREVIEW_FRAME_CHANNEL_CAPACITY: usize = 256;
const LOG_HISTORY_LIMIT: usize = 200;

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

#[derive(Debug, Default)]
pub struct LayoutIntentState {
    pub latest_intent_id: u64,
    pub latest_needs_camera: bool,
    pub latest_needs_screen: bool,
}

#[derive(Clone)]
pub struct AppState {
    pub token: String,
    pub port: u16,
    /// Fixed-port loopback listener for OAuth callbacks. Providers like X match
    /// redirect URIs EXACTLY (port included), so callbacks cannot ride the
    /// randomly-bound main port; None means the candidate ports were all busy
    /// and redirects fall back to the main port.
    pub oauth_callback_port: Option<u16>,
    pub events: broadcast::Sender<ServerEvent>,
    pub recording: RecordingSlot,
    pub live_preview: LivePreviewSlot,
    pub preview_frames: broadcast::Sender<Vec<u8>>,
    pub preview_latest_frame: Arc<tokio::sync::RwLock<Option<PreviewFrame>>>,
    pub preview_metrics: Arc<tokio::sync::Mutex<PreviewMetricsState>>,
    pub preview_camera: PreviewCameraSlot,
    pub preview_screen: PreviewScreenSlot,
    pub preview_surface: PreviewSurfaceSlot,
    pub compositor: CompositorSlot,
    pub scene: Arc<tokio::sync::Mutex<Scene>>,
    /// Serializes scene storage, revision allocation, compositor publication,
    /// and the scene-changed event as one commit edge.
    pub scene_commit: Arc<tokio::sync::Mutex<()>>,
    /// Serializes the commit edge of layout transactions while allowing source
    /// warm-up to run concurrently. A newer registered intent supersedes older
    /// waiters before they can replace the last good scene.
    pub layout_intents: Arc<tokio::sync::Mutex<LayoutIntentState>>,
    pub source_registry: Arc<tokio::sync::Mutex<SourceRegistry>>,
    pub diagnostics: Arc<tokio::sync::Mutex<DiagnosticStats>>,
    pub last_audio_meter: Arc<tokio::sync::Mutex<Option<AudioMeterSampleSnapshot>>>,
    pub logs: Arc<StdMutex<Vec<BackendLogEvent>>>,
    pub database: Database,
    pub oauth: Arc<OAuthSessions>,
    /// Pending 3-legged OAuth 1.0a authorizations for X Live (keyed by
    /// request token — OAuth 1.0a callbacks carry no `state` param).
    pub x_oauth1: Arc<crate::x_oauth1::XOauth1Sessions>,
    pub ffmpeg_work: Arc<FfmpegWorkCoordinator>,
    pub live_chat: LiveChatSlot,
    /// In-memory product-account session override (deep-link sign-in / Sign out).
    /// None falls back to the dev env mock; persistent token storage replaces it.
    pub account_session: Arc<tokio::sync::Mutex<Option<VideorcAccountSnapshot>>>,
    pub captions: crate::captions::CaptionsSlot,
    /// Burn-in caption bar for the stream leg (std mutex: read from the
    /// synchronous compositor render thread).
    pub caption_overlay: crate::captions::CaptionOverlaySlot,
    /// Comment-highlight overlay (Comments upgrade S2): independent from the
    /// captions bar — highlight top, captions bottom, coexisting.
    pub highlight_overlay: crate::captions::CaptionOverlaySlot,
    /// Backend-owned acknowledgement/lifetime for the viewer-facing comment
    /// card. The image slot above and this state are mutated under this
    /// state-machine lock so stale expiry tasks cannot clear newer cards.
    pub comment_highlight: crate::comment_highlight::CommentHighlightSlot,
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
            oauth_callback_port: None,
            events,
            recording: Arc::new(tokio::sync::Mutex::new(None)),
            live_preview: Arc::new(tokio::sync::Mutex::new(initial_live_preview_state())),
            preview_frames: broadcast::channel(PREVIEW_FRAME_CHANNEL_CAPACITY).0,
            preview_latest_frame: Arc::new(tokio::sync::RwLock::new(None)),
            preview_metrics: Arc::new(tokio::sync::Mutex::new(PreviewMetricsState::default())),
            preview_camera: Arc::new(tokio::sync::Mutex::new(initial_preview_camera_state())),
            preview_screen: Arc::new(tokio::sync::Mutex::new(initial_preview_screen_state())),
            preview_surface: Arc::new(tokio::sync::Mutex::new(initial_preview_surface_state())),
            compositor: Arc::new(tokio::sync::Mutex::new(initial_compositor_state())),
            scene: Arc::new(tokio::sync::Mutex::new(default_scene())),
            scene_commit: Arc::new(tokio::sync::Mutex::new(())),
            layout_intents: Arc::new(tokio::sync::Mutex::new(LayoutIntentState::default())),
            source_registry: Arc::new(tokio::sync::Mutex::new(SourceRegistry::new())),
            diagnostics: Arc::new(tokio::sync::Mutex::new(idle_diagnostics())),
            last_audio_meter: Arc::new(tokio::sync::Mutex::new(None)),
            logs: Arc::new(StdMutex::new(Vec::new())),
            database,
            oauth: Arc::new(OAuthSessions::default()),
            x_oauth1: Arc::new(crate::x_oauth1::XOauth1Sessions::default()),
            ffmpeg_work: Arc::new(FfmpegWorkCoordinator::new()),
            live_chat: Arc::new(tokio::sync::Mutex::new(LiveChatCoordinator::default())),
            account_session: Arc::new(tokio::sync::Mutex::new(
                crate::account::restore_persisted_account(),
            )),
            captions: crate::captions::new_captions_slot(),
            caption_overlay: crate::captions::new_caption_overlay_slot(),
            highlight_overlay: crate::captions::new_caption_overlay_slot(),
            comment_highlight: crate::comment_highlight::new_comment_highlight_slot(),
        }
    }

    /// The port OAuth redirect URIs must use: the fixed callback listener when
    /// it bound, else the dynamic main port (still fine for providers that
    /// accept any loopback port, like Google).
    pub fn oauth_redirect_port(&self) -> u16 {
        self.oauth_callback_port.unwrap_or(self.port)
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
        self.remember_log(payload.clone());
        self.emit_event("log", payload);
    }

    pub fn recent_logs(&self, limit: usize) -> Vec<BackendLogEvent> {
        self.logs
            .lock()
            .map(|logs| {
                let start = logs.len().saturating_sub(limit);
                logs[start..].to_vec()
            })
            .unwrap_or_default()
    }

    fn remember_log(&self, event: BackendLogEvent) {
        if let Ok(mut logs) = self.logs.lock() {
            logs.push(event);
            let overflow = logs.len().saturating_sub(LOG_HISTORY_LIMIT);
            if overflow > 0 {
                logs.drain(0..overflow);
            }
        }
    }
}
