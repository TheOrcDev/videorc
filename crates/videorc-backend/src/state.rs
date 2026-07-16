use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, Instant};

use chrono::Utc;
use tokio::sync::{Notify, broadcast};

use crate::capture_interruption::CaptureInterruptionCoordinator;
use crate::compositor::{CompositorSlot, initial_compositor_state};
use crate::diagnostics::idle_diagnostics;
use crate::ffmpeg_work::FfmpegWorkCoordinator;
use crate::live_chat::{LiveChatCoordinator, LiveChatSlot};
use crate::live_chat_persistence::LiveChatPersistence;
use crate::oauth::OAuthSessions;
use crate::preview_camera::{PreviewCameraSlot, initial_preview_camera_state};
use crate::preview_screen::{PreviewScreenSlot, initial_preview_screen_state};
use crate::preview_surface::{PreviewSurfaceSlot, initial_preview_surface_state};
use crate::protocol::{
    AudioMeterSampleSnapshot, BackendLogEvent, DiagnosticStats, Scene, ServerEvent,
    VideorcAccountSnapshot, WebSocketQueueDiagnosticStats, WebSocketTransportDiagnosticStats,
};
use crate::recording::{LivePreviewSlot, RecordingSlot, initial_live_preview_state};
use crate::resource_authority::ResourceAuthority;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebSocketQueueTicket {
    enqueued_at: Instant,
    sequence: u64,
}

#[derive(Debug, Default)]
struct WebSocketQueueTotals {
    current_depth: AtomicU64,
    max_depth: AtomicU64,
    coalesced_count: AtomicU64,
    evicted_or_dropped_count: AtomicU64,
}

#[derive(Debug)]
struct WebSocketQueueMetricsInner {
    pending: StdMutex<BTreeMap<(Instant, u64), ()>>,
    next_sequence: AtomicU64,
    totals: Arc<WebSocketQueueTotals>,
    changed: Notify,
}

impl Drop for WebSocketQueueMetricsInner {
    fn drop(&mut self) {
        let remaining = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len() as u64;
        if remaining == 0 {
            return;
        }
        let _ = self.totals.current_depth.fetch_update(
            Ordering::AcqRel,
            Ordering::Acquire,
            |current| Some(current.saturating_sub(remaining)),
        );
        self.totals
            .evicted_or_dropped_count
            .fetch_add(remaining, Ordering::AcqRel);
    }
}

#[derive(Debug, Clone)]
pub struct TrackedWebSocketQueueMetrics(Arc<WebSocketQueueMetricsInner>);

impl TrackedWebSocketQueueMetrics {
    fn new(totals: Arc<WebSocketQueueTotals>) -> Self {
        Self(Arc::new(WebSocketQueueMetricsInner {
            pending: StdMutex::new(BTreeMap::new()),
            next_sequence: AtomicU64::new(0),
            totals,
            changed: Notify::new(),
        }))
    }

    pub fn record_enqueue(&self) -> WebSocketQueueTicket {
        self.record_enqueue_at(Instant::now())
    }

    fn record_enqueue_at(&self, enqueued_at: Instant) -> WebSocketQueueTicket {
        let sequence = self.0.next_sequence.fetch_add(1, Ordering::AcqRel);
        let ticket = WebSocketQueueTicket {
            enqueued_at,
            sequence,
        };
        self.0
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert((ticket.enqueued_at, ticket.sequence), ());
        let current = self.0.totals.current_depth.fetch_add(1, Ordering::AcqRel) + 1;
        self.0.totals.max_depth.fetch_max(current, Ordering::AcqRel);
        self.0.changed.notify_one();
        ticket
    }

    pub fn record_dequeue_oldest(&self) {
        let removed = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pop_first()
            .is_some();
        if removed {
            self.0.totals.current_depth.fetch_sub(1, Ordering::AcqRel);
            self.0.changed.notify_one();
        }
    }

    pub fn record_dequeue(&self, ticket: WebSocketQueueTicket) {
        self.finish(ticket, false);
    }

    pub fn record_evicted_or_dropped(&self, ticket: WebSocketQueueTicket) {
        self.finish(ticket, true);
    }

    pub fn record_rejected_or_dropped(&self) {
        self.0
            .totals
            .evicted_or_dropped_count
            .fetch_add(1, Ordering::AcqRel);
    }

    pub fn record_coalesced_replacement(
        &self,
        replaced: WebSocketQueueTicket,
    ) -> WebSocketQueueTicket {
        let replacement = WebSocketQueueTicket {
            enqueued_at: Instant::now(),
            sequence: self.0.next_sequence.fetch_add(1, Ordering::AcqRel),
        };
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if pending
            .remove(&(replaced.enqueued_at, replaced.sequence))
            .is_some()
        {
            pending.insert((replacement.enqueued_at, replacement.sequence), ());
            self.0.totals.coalesced_count.fetch_add(1, Ordering::AcqRel);
            drop(pending);
            self.0.changed.notify_one();
            replacement
        } else {
            drop(pending);
            self.record_enqueue()
        }
    }

    fn finish(&self, ticket: WebSocketQueueTicket, dropped: bool) {
        let removed = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&(ticket.enqueued_at, ticket.sequence))
            .is_some();
        if !removed {
            return;
        }
        self.0.totals.current_depth.fetch_sub(1, Ordering::AcqRel);
        self.0.changed.notify_one();
        if dropped {
            self.0
                .totals
                .evicted_or_dropped_count
                .fetch_add(1, Ordering::AcqRel);
        }
    }

    fn oldest_age_ms(&self, now: Instant) -> Option<u64> {
        self.0
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .first_key_value()
            .map(|((enqueued_at, _), _)| {
                now.saturating_duration_since(*enqueued_at).as_millis() as u64
            })
    }

    fn remaining_until_oldest_age_at(
        &self,
        now: Instant,
        oldest_age_limit: Duration,
    ) -> Option<Duration> {
        self.0
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .first_key_value()
            .map(|((enqueued_at, _), _)| {
                oldest_age_limit.saturating_sub(now.saturating_duration_since(*enqueued_at))
            })
    }

    pub fn remaining_until_oldest_age(&self, oldest_age_limit: Duration) -> Option<Duration> {
        self.remaining_until_oldest_age_at(Instant::now(), oldest_age_limit)
    }

    pub async fn wait_until_oldest_age_reaches(&self, oldest_age_limit: Duration) {
        loop {
            // `notify_one` stores a permit when this future has not been polled yet,
            // so a queue change between this line and the age read cannot be lost.
            let changed = self.0.changed.notified();
            match self.remaining_until_oldest_age(oldest_age_limit) {
                Some(remaining) if remaining.is_zero() => return,
                Some(remaining) => {
                    tokio::select! {
                        _ = tokio::time::sleep(remaining) => {}
                        _ = changed => {}
                    }
                }
                None => changed.await,
            }
        }
    }
}

#[derive(Debug, Default)]
struct WebSocketQueueRegistry {
    totals: Arc<WebSocketQueueTotals>,
    connections: StdMutex<Vec<Weak<WebSocketQueueMetricsInner>>>,
}

impl WebSocketQueueRegistry {
    fn register(&self) -> TrackedWebSocketQueueMetrics {
        let metrics = TrackedWebSocketQueueMetrics::new(self.totals.clone());
        let mut connections = self
            .connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        connections.retain(|connection| connection.strong_count() > 0);
        connections.push(Arc::downgrade(&metrics.0));
        metrics
    }

    fn snapshot(&self, now: Instant) -> WebSocketQueueDiagnosticStats {
        let mut connections = self
            .connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut oldest_age_ms = None;
        connections.retain(|connection| {
            let Some(connection) = connection.upgrade() else {
                return false;
            };
            let metrics = TrackedWebSocketQueueMetrics(connection);
            if let Some(age_ms) = metrics.oldest_age_ms(now) {
                oldest_age_ms =
                    Some(oldest_age_ms.map_or(age_ms, |oldest: u64| oldest.max(age_ms)));
            }
            true
        });
        WebSocketQueueDiagnosticStats {
            current_depth: self.totals.current_depth.load(Ordering::Acquire),
            max_depth: self.totals.max_depth.load(Ordering::Acquire),
            oldest_age_ms,
            coalesced_count: self.totals.coalesced_count.load(Ordering::Acquire),
            evicted_or_dropped_count: self.totals.evicted_or_dropped_count.load(Ordering::Acquire),
        }
    }
}

#[derive(Debug)]
pub struct WebSocketConnectionTransportMetrics {
    pub reliable_response_queue: TrackedWebSocketQueueMetrics,
    pub incoming_command_queue: TrackedWebSocketQueueMetrics,
    pub coalesced_telemetry_queue: TrackedWebSocketQueueMetrics,
}

#[derive(Debug, Default)]
pub struct WebSocketTransportMetrics {
    reliable_response_queue: WebSocketQueueRegistry,
    incoming_command_queue: WebSocketQueueRegistry,
    coalesced_telemetry_queue: WebSocketQueueRegistry,
    slow_pressure_disconnect_count: AtomicU64,
}

impl WebSocketTransportMetrics {
    pub fn register_connection(&self) -> WebSocketConnectionTransportMetrics {
        WebSocketConnectionTransportMetrics {
            reliable_response_queue: self.reliable_response_queue.register(),
            incoming_command_queue: self.incoming_command_queue.register(),
            coalesced_telemetry_queue: self.coalesced_telemetry_queue.register(),
        }
    }

    pub fn record_slow_pressure_disconnect(&self) {
        self.slow_pressure_disconnect_count
            .fetch_add(1, Ordering::AcqRel);
    }

    pub fn snapshot(&self) -> WebSocketTransportDiagnosticStats {
        self.snapshot_at(Instant::now())
    }

    fn snapshot_at(&self, now: Instant) -> WebSocketTransportDiagnosticStats {
        WebSocketTransportDiagnosticStats {
            reliable_response_queue: self.reliable_response_queue.snapshot(now),
            incoming_command_queue: self.incoming_command_queue.snapshot(now),
            coalesced_telemetry_queue: self.coalesced_telemetry_queue.snapshot(now),
            slow_pressure_disconnect_count: self
                .slow_pressure_disconnect_count
                .load(Ordering::Acquire),
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    /// Least-privilege renderer transport credential.
    pub token: String,
    /// Electron-main/admin transport credential. Never serialize this through
    /// `BackendConnection` or renderer-facing events.
    pub admin_token: String,
    /// Test RPCs require both a debug build and this explicit runtime switch.
    pub smoke_rpc_enabled: bool,
    pub port: u16,
    /// Fixed-port loopback listener for OAuth callbacks. Providers like X match
    /// redirect URIs EXACTLY (port included), so callbacks cannot ride the
    /// randomly-bound main port; None means the candidate ports were all busy
    /// and redirects fall back to the main port.
    pub oauth_callback_port: Option<u16>,
    pub events: broadcast::Sender<ServerEvent>,
    pub recording: RecordingSlot,
    /// Atomic admission edge shared by session startup and privileged process
    /// interruptions. Main-process status events are UX hints, not authority.
    pub capture_interruption: Arc<CaptureInterruptionCoordinator>,
    pub live_preview: LivePreviewSlot,
    pub preview_frames: broadcast::Sender<Vec<u8>>,
    pub preview_latest_frame: Arc<tokio::sync::RwLock<Option<PreviewFrame>>>,
    pub preview_metrics: Arc<tokio::sync::Mutex<PreviewMetricsState>>,
    pub preview_camera: PreviewCameraSlot,
    pub preview_screen: PreviewScreenSlot,
    pub preview_surface: PreviewSurfaceSlot,
    /// Serializes preview-surface create/update/destroy transactions. The
    /// compositor lifecycle lock only protects worker ownership; it does not
    /// make the surface status, native-host commands, and owned run id one
    /// atomic transition.
    pub preview_surface_lifecycle: Arc<tokio::sync::Mutex<()>>,
    pub compositor: CompositorSlot,
    /// Serializes compositor worker stop/start handoffs so concurrent preview and
    /// recording ownership changes cannot orphan a `spawn_blocking` render worker.
    pub compositor_lifecycle: Arc<tokio::sync::Mutex<()>>,
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
    pub websocket_transport_metrics: Arc<WebSocketTransportMetrics>,
    pub last_audio_meter: Arc<tokio::sync::Mutex<Option<AudioMeterSampleSnapshot>>>,
    pub logs: Arc<StdMutex<Vec<BackendLogEvent>>>,
    pub database: Database,
    /// Remote-control surface (Stream Deck et al): enabled flag, rotatable
    /// token, renderer-published describe/state snapshots, intent debounce.
    pub remote_control: crate::remote_control::RemoteControlSlot,
    /// Bumped on remote token regenerate/disable: live remote sockets watch
    /// it and close, so a rotated token cuts existing clients immediately.
    pub remote_generation: tokio::sync::watch::Sender<u64>,
    pub resource_authority: ResourceAuthority,
    pub oauth: Arc<OAuthSessions>,
    /// Pending 3-legged OAuth 1.0a authorizations for X Live (keyed by
    /// request token — OAuth 1.0a callbacks carry no `state` param).
    pub x_oauth1: Arc<crate::x_oauth1::XOauth1Sessions>,
    pub ffmpeg_work: Arc<FfmpegWorkCoordinator>,
    pub noise_cleanup: Arc<crate::noise_cleanup::NoiseCleanupRegistry>,
    pub live_chat: LiveChatSlot,
    pub live_chat_persistence: LiveChatPersistence,
    /// In-memory product-account session override (deep-link sign-in / Sign out).
    /// None falls back to the dev env mock; persistent token storage replaces it.
    pub account_session: Arc<tokio::sync::Mutex<Option<VideorcAccountSnapshot>>>,
    /// Serializes product-account intent generation, remote code exchange,
    /// refresh, and sign-out so a stale completion cannot publish after a newer
    /// sign-in intent or explicit sign-out.
    pub account_auth_transition: Arc<tokio::sync::Mutex<()>>,
    pub captions: crate::captions::CaptionsSlot,
    /// Per-output burn-in caption bars (std mutex: read from the synchronous
    /// compositor render thread). Primary and auxiliary may use different
    /// raster dimensions for split 4K-record/1080p-stream sessions.
    pub caption_overlay: crate::captions::CaptionOverlaySlots,
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
        let oauth_store_path = (database.path().to_string_lossy() != ":memory:")
            .then(|| database.path().with_extension("oauth-pending.json"));
        Self {
            token,
            admin_token: uuid::Uuid::new_v4().to_string(),
            smoke_rpc_enabled: cfg!(debug_assertions)
                && std::env::var("VIDEORC_ENABLE_SMOKE_RPC").as_deref() == Ok("1"),
            port,
            oauth_callback_port: None,
            events,
            recording: Arc::new(tokio::sync::Mutex::new(None)),
            capture_interruption: Arc::new(CaptureInterruptionCoordinator::default()),
            live_preview: Arc::new(tokio::sync::Mutex::new(initial_live_preview_state())),
            preview_frames: broadcast::channel(PREVIEW_FRAME_CHANNEL_CAPACITY).0,
            preview_latest_frame: Arc::new(tokio::sync::RwLock::new(None)),
            preview_metrics: Arc::new(tokio::sync::Mutex::new(PreviewMetricsState::default())),
            preview_camera: Arc::new(tokio::sync::Mutex::new(initial_preview_camera_state())),
            preview_screen: Arc::new(tokio::sync::Mutex::new(initial_preview_screen_state())),
            preview_surface: Arc::new(tokio::sync::Mutex::new(initial_preview_surface_state())),
            preview_surface_lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            compositor: Arc::new(tokio::sync::Mutex::new(initial_compositor_state())),
            compositor_lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            scene: Arc::new(tokio::sync::Mutex::new(default_scene())),
            scene_commit: Arc::new(tokio::sync::Mutex::new(())),
            layout_intents: Arc::new(tokio::sync::Mutex::new(LayoutIntentState::default())),
            source_registry: Arc::new(tokio::sync::Mutex::new(SourceRegistry::new())),
            diagnostics: Arc::new(tokio::sync::Mutex::new(idle_diagnostics())),
            websocket_transport_metrics: Arc::new(WebSocketTransportMetrics::default()),
            last_audio_meter: Arc::new(tokio::sync::Mutex::new(None)),
            logs: Arc::new(StdMutex::new(Vec::new())),
            live_chat_persistence: LiveChatPersistence::new(database.clone()),
            database,
            remote_control: std::sync::Arc::new(StdMutex::new(
                crate::remote_control::RemoteControlRuntime::load_from_secrets(),
            )),
            remote_generation: tokio::sync::watch::channel(0).0,
            resource_authority: ResourceAuthority::default(),
            oauth: Arc::new(OAuthSessions::new_with_secret_store(
                oauth_store_path,
                crate::secrets::put_secret,
                crate::secrets::delete_secret,
            )),
            x_oauth1: Arc::new(crate::x_oauth1::XOauth1Sessions::default()),
            ffmpeg_work: Arc::new(FfmpegWorkCoordinator::new()),
            noise_cleanup: Arc::new(crate::noise_cleanup::NoiseCleanupRegistry::default()),
            live_chat: Arc::new(tokio::sync::Mutex::new(LiveChatCoordinator::default())),
            account_session: Arc::new(tokio::sync::Mutex::new(
                crate::account::restore_persisted_account(),
            )),
            account_auth_transition: Arc::new(tokio::sync::Mutex::new(())),
            captions: crate::captions::new_captions_slot(),
            caption_overlay: crate::captions::new_caption_overlay_slots(),
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
        let mut event = ServerEvent::new(event, payload);
        crate::resource_authority::redact_managed_background_paths(&mut event.payload);
        if event.event == "diagnostics.stats"
            && let Some(payload) = event.payload.as_object_mut()
        {
            payload.insert(
                "websocketTransport".to_string(),
                serde_json::to_value(self.websocket_transport_metrics.snapshot())
                    .expect("serializable WebSocket transport diagnostics"),
            );
        }
        let _ = self.events.send(event);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_queue_metrics_track_depth_oldest_age_and_lifetime_counters() {
        let now = Instant::now();
        let transport = WebSocketTransportMetrics::default();
        let connection = transport.register_connection();
        let reliable = &connection.reliable_response_queue;

        let oldest = reliable.record_enqueue_at(now - Duration::from_millis(120));
        let newest = reliable.record_enqueue_at(now - Duration::from_millis(25));
        let snapshot = transport.snapshot_at(now);
        assert_eq!(snapshot.reliable_response_queue.current_depth, 2);
        assert_eq!(snapshot.reliable_response_queue.max_depth, 2);
        assert_eq!(snapshot.reliable_response_queue.oldest_age_ms, Some(120));
        assert_eq!(snapshot.reliable_response_queue.evicted_or_dropped_count, 0);

        reliable.record_dequeue(oldest);
        let snapshot = transport.snapshot_at(now);
        assert_eq!(snapshot.reliable_response_queue.current_depth, 1);
        assert_eq!(snapshot.reliable_response_queue.oldest_age_ms, Some(25));

        reliable.record_evicted_or_dropped(newest);
        let snapshot = transport.snapshot_at(now);
        assert_eq!(snapshot.reliable_response_queue.current_depth, 0);
        assert_eq!(snapshot.reliable_response_queue.oldest_age_ms, None);
        assert_eq!(snapshot.reliable_response_queue.evicted_or_dropped_count, 1);
    }

    #[test]
    fn websocket_queue_metrics_expose_exact_remaining_oldest_age_budget() {
        let now = Instant::now();
        let transport = WebSocketTransportMetrics::default();
        let connection = transport.register_connection();
        let reliable = &connection.reliable_response_queue;

        assert_eq!(
            reliable.remaining_until_oldest_age_at(now, Duration::from_secs(5)),
            None
        );
        reliable.record_enqueue_at(now - Duration::from_secs(3));
        assert_eq!(
            reliable.remaining_until_oldest_age_at(now, Duration::from_secs(5)),
            Some(Duration::from_secs(2))
        );
        assert_eq!(
            reliable.remaining_until_oldest_age_at(
                now + Duration::from_secs(3),
                Duration::from_secs(5),
            ),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn websocket_transport_metrics_keep_lanes_separate_and_count_coalescing_pressure() {
        let now = Instant::now();
        let transport = WebSocketTransportMetrics::default();
        let connection = transport.register_connection();
        let command = connection
            .incoming_command_queue
            .record_enqueue_at(now - Duration::from_millis(40));
        let telemetry = connection
            .coalesced_telemetry_queue
            .record_enqueue_at(now - Duration::from_millis(70));
        let replacement = connection
            .coalesced_telemetry_queue
            .record_coalesced_replacement(telemetry);
        connection
            .coalesced_telemetry_queue
            .record_evicted_or_dropped(replacement);
        transport.record_slow_pressure_disconnect();

        let snapshot = transport.snapshot_at(now);
        assert_eq!(snapshot.incoming_command_queue.current_depth, 1);
        assert_eq!(snapshot.incoming_command_queue.oldest_age_ms, Some(40));
        assert_eq!(snapshot.coalesced_telemetry_queue.current_depth, 0);
        assert_eq!(snapshot.coalesced_telemetry_queue.max_depth, 1);
        assert_eq!(snapshot.coalesced_telemetry_queue.coalesced_count, 1);
        assert_eq!(
            snapshot.coalesced_telemetry_queue.evicted_or_dropped_count,
            1
        );
        assert_eq!(snapshot.slow_pressure_disconnect_count, 1);

        connection.incoming_command_queue.record_dequeue(command);
        assert_eq!(
            transport
                .snapshot_at(now)
                .incoming_command_queue
                .current_depth,
            0
        );
    }
}
