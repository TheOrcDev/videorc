//! The health summary: `health.ping`'s answer and the last `health.event`s,
//! as `use-studio.tsx` keeps them (`health`, `healthEvents` capped at 40,
//! `stopOverrun`).
//!
//! S3.0g: the telemetry the Health page reads ([`HealthTelemetry`]): the
//! newest `diagnostics.stats`, `stream.health` (merged as
//! `mergeStreamHealth` merges it), `stream.targets` and the four
//! `preview.*.status` reads, as the backend's JSON, and the capture stage's
//! drop window (`advanceStreamDropActivity`'s, #981).

use std::time::{Duration, Instant};

use serde_json::Value;
use videorc_protocol::{BackendHealth, HealthEvent, HealthLevel};

/// Which stages dropped within the window (`RecentStreamDrops`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RecentDrops {
    pub audio: bool,
    pub capture: bool,
    pub encoder: bool,
    pub preview: bool,
}

/// The telemetry events the Studio hears for the Health page.
pub const DIAGNOSTICS_STATS_EVENT: &str = "diagnostics.stats";
pub const STREAM_HEALTH_EVENT: &str = "stream.health";
pub const PREVIEW_LIVE_STATUS_EVENT: &str = "preview.live.status";
pub const PREVIEW_CAMERA_STATUS_EVENT: &str = "preview.camera.status";
pub const PREVIEW_SCREEN_STATUS_EVENT: &str = "preview.screen.status";
pub const PREVIEW_SURFACE_STATUS_EVENT: &str = "preview.surface.status";

/// `RECENT_DROP_WINDOW_MS`: how long a drop keeps naming its stage.
pub const RECENT_DROP_WINDOW: Duration = Duration::from_secs(10);

/// `StreamDropActivity`: the last counters of each stage and when they last
/// grew (audio, capture, encoder, preview).
#[derive(Debug, Clone, Default)]
struct DropActivity {
    session_id: Option<String>,
    totals: [Vec<Option<f64>>; 4],
    last_increase: [Option<Instant>; 4],
}

const AUDIO: usize = 0;
const CAPTURE: usize = 1;
const ENCODER: usize = 2;
const PREVIEW: usize = 3;

/// What the Health page reads that the Studio's state machine doesn't.
#[derive(Debug, Clone, Default)]
pub struct HealthTelemetry {
    pub diagnostics: Option<Value>,
    pub stream_health: Option<Value>,
    /// `stream.targets`' `targets`, as sent.
    pub stream_targets: Vec<Value>,
    pub preview_live: Option<Value>,
    pub preview_camera: Option<Value>,
    pub preview_screen: Option<Value>,
    pub preview_surface: Option<Value>,
    drops: DropActivity,
}

impl HealthTelemetry {
    /// One telemetry event (or a bootstrap read under its event's name).
    /// Returns false for an event it doesn't keep.
    pub fn apply(&mut self, event: &str, payload: Value, now: Instant) -> bool {
        match event {
            DIAGNOSTICS_STATS_EVENT => {
                self.advance_drops(&payload, now);
                self.diagnostics = Some(payload);
            }
            STREAM_HEALTH_EVENT => {
                self.stream_health = Some(merge_stream_health(self.stream_health.take(), payload));
            }
            crate::client::names::STREAM_TARGETS => {
                self.stream_targets = payload
                    .get("targets")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
            }
            PREVIEW_LIVE_STATUS_EVENT => self.preview_live = Some(payload),
            PREVIEW_CAMERA_STATUS_EVENT => self.preview_camera = Some(payload),
            PREVIEW_SCREEN_STATUS_EVENT => self.preview_screen = Some(payload),
            PREVIEW_SURFACE_STATUS_EVENT => self.preview_surface = Some(payload),
            _ => return false,
        }
        true
    }

    /// A new session's start clears the last stream's health (`setStreamHealth(null)`).
    pub fn clear_stream_health(&mut self) {
        self.stream_health = None;
    }

    /// `advanceStreamDropActivity`: a counter that grows marks its stage as
    /// dropping now; one that first appears or shrinks only sets the
    /// baseline; a new session starts over. The stream's own counters count
    /// only for the diagnostics' session (`healthForDiagnosticSession`).
    fn advance_drops(&mut self, stats: &Value, now: Instant) {
        let session_id = stats
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let health = self.stream_health.as_ref().filter(|health| {
            session_id.is_none()
                || health.get("sessionId").and_then(Value::as_str) == session_id.as_deref()
        });
        let read = |value: Option<&Value>, key: &str| {
            value
                .and_then(|value| value.get(key))
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
        };
        let stats_of = |key: &str| read(Some(stats), key);
        let counters: [Vec<Option<f64>>; 4] = [
            vec![stats_of("micDroppedFrames")],
            vec![
                stats_of("previewCameraDroppedFrames"),
                stats_of("previewScreenDroppedFrames"),
            ],
            vec![
                stats_of("droppedFrames"),
                read(health, "droppedFrames"),
                stats_of("encoderBridgeDroppedFrames"),
                stats_of("encoderBridgeOutputQueueDroppedFrames"),
                stats_of("encoderBridgeStreamQueueDroppedFrames"),
                stats_of("encoderBridgeEncodedOutputErrors"),
                stats_of("streamDuplicatedFrames"),
                read(health, "duplicatedFrames"),
            ],
            vec![stats_of("previewDroppedFrames")],
        ];
        let same = self.drops.session_id == session_id;
        if !same {
            self.drops.last_increase = [None; 4];
        }
        for (stage, counters) in counters.iter().enumerate() {
            let before = if same {
                self.drops.totals[stage].as_slice()
            } else {
                &[]
            };
            let grew = counters
                .iter()
                .zip(before.iter())
                .any(|pair| matches!(pair, (Some(count), Some(before)) if count > before));
            if grew {
                self.drops.last_increase[stage] = Some(now);
            }
        }
        self.drops.session_id = session_id;
        self.drops.totals = counters;
    }

    fn dropped_recently(&self, stage: usize, now: Instant) -> bool {
        self.drops.last_increase[stage]
            .is_some_and(|at| now.saturating_duration_since(at) <= RECENT_DROP_WINDOW)
    }

    /// Whether the camera or the screen dropped within the window.
    pub fn capture_dropping(&self, now: Instant) -> bool {
        self.dropped_recently(CAPTURE, now)
    }

    /// `recentStreamDrops`: which stages dropped within the window (S3.1a,
    /// the Session section's Stream fact).
    pub fn recent_drops(&self, now: Instant) -> RecentDrops {
        RecentDrops {
            audio: self.dropped_recently(AUDIO, now),
            capture: self.dropped_recently(CAPTURE, now),
            encoder: self.dropped_recently(ENCODER, now),
            preview: self.dropped_recently(PREVIEW, now),
        }
    }
}

/// `mergeStreamHealth`: another session's health replaces; the same
/// session's keeps the numbers the update leaves out.
pub fn merge_stream_health(current: Option<Value>, update: Value) -> Value {
    const KEPT: [&str; 6] = [
        "fps",
        "droppedFrames",
        "speed",
        "bitrateKbps",
        "totalBytes",
        "duplicatedFrames",
    ];
    let Some(mut current) = current else {
        return update;
    };
    if current.get("sessionId") != update.get("sessionId") {
        return update;
    }
    let (Some(target), Value::Object(update)) = (current.as_object_mut(), update.clone()) else {
        return update;
    };
    for (key, value) in update {
        if value.is_null() && KEPT.contains(&key.as_str()) {
            continue;
        }
        target.insert(key, value);
    }
    current
}

/// `setHealthEvents((current) => [event, ...current].slice(0, 40))`.
pub const HEALTH_EVENT_LIMIT: usize = 40;

/// `RECORDING_STOP_FINALIZE_OVERRUN_CODE` (`lib/studio-session-view.ts`):
/// the stop drags on; the Studio explains Force stop (B-16).
pub const RECORDING_STOP_FINALIZE_OVERRUN_CODE: &str = "recording-stop-finalize-overrun";

/// The one-line reading of the backend's health.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthTone {
    /// `health.ping` has not answered on this connection.
    Unknown,
    Ok,
    Warning,
    Error,
}

#[derive(Debug, Clone, Default)]
pub struct HealthSummary {
    /// `health.ping`'s last answer on this connection.
    pub backend: Option<BackendHealth>,
    /// Newest first, at most [`HEALTH_EVENT_LIMIT`].
    pub events: Vec<HealthEvent>,
}

impl HealthSummary {
    pub fn set_backend(&mut self, health: BackendHealth) {
        self.backend = Some(health);
    }

    /// The backend is gone: its health is unknown until the next ping.
    pub fn clear_backend(&mut self) {
        self.backend = None;
    }

    /// One `health.event`. Returns true when it is the stop overrun.
    pub fn push_event(&mut self, event: HealthEvent) -> bool {
        let overrun = event.code == RECORDING_STOP_FINALIZE_OVERRUN_CODE;
        self.events.insert(0, event);
        self.events.truncate(HEALTH_EVENT_LIMIT);
        overrun
    }

    pub fn ffmpeg_available(&self) -> bool {
        self.backend
            .as_ref()
            .is_some_and(|health| health.ffmpeg.available)
    }

    /// The events of one session, newest first.
    pub fn events_for_session<'a>(
        &'a self,
        session_id: &'a str,
    ) -> impl Iterator<Item = &'a HealthEvent> + 'a {
        self.events
            .iter()
            .filter(move |event| event.session_id.as_deref() == Some(session_id))
    }

    /// The worst level among the events, or none.
    pub fn worst_level(&self) -> Option<HealthLevel> {
        let mut worst: Option<HealthLevel> = None;
        for event in &self.events {
            worst = Some(match (worst, &event.level) {
                (_, HealthLevel::Error) | (Some(HealthLevel::Error), _) => HealthLevel::Error,
                (_, HealthLevel::Warn) | (Some(HealthLevel::Warn), _) => HealthLevel::Warn,
                _ => HealthLevel::Info,
            });
        }
        worst
    }

    /// Unknown without a ping; Error when the backend says so or FFmpeg is
    /// missing or an error event arrived; Warning on a warning event.
    pub fn tone(&self) -> HealthTone {
        let Some(backend) = &self.backend else {
            return HealthTone::Unknown;
        };
        if backend.status != "ok" || !backend.ffmpeg.available {
            return HealthTone::Error;
        }
        match self.worst_level() {
            Some(HealthLevel::Error) => HealthTone::Error,
            Some(HealthLevel::Warn) => HealthTone::Warning,
            _ => HealthTone::Ok,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use videorc_protocol::ToolStatus;

    fn health(ok: bool, ffmpeg: bool) -> BackendHealth {
        BackendHealth {
            status: if ok { "ok" } else { "degraded" }.to_string(),
            version: "0.0.0".to_string(),
            platform: "macos".to_string(),
            ffmpeg: ToolStatus {
                path: "ffmpeg".to_string(),
                available: ffmpeg,
                version: None,
                message: None,
            },
            database_path: String::new(),
            secret_store_backend: "test".to_string(),
        }
    }

    fn event(id: &str, level: HealthLevel, code: &str) -> HealthEvent {
        HealthEvent {
            id: id.to_string(),
            session_id: Some("s".to_string()),
            level,
            code: code.to_string(),
            message: String::new(),
            permission_pane: None,
            created_at: String::new(),
        }
    }

    #[test]
    fn the_tone_reads_the_ping_then_the_events() {
        let mut summary = HealthSummary::default();
        assert_eq!(summary.tone(), HealthTone::Unknown);
        summary.set_backend(health(true, false));
        assert_eq!(summary.tone(), HealthTone::Error, "no FFmpeg");
        summary.set_backend(health(true, true));
        assert_eq!(summary.tone(), HealthTone::Ok);
        summary.push_event(event("1", HealthLevel::Info, "recording-finalized"));
        assert_eq!(summary.tone(), HealthTone::Ok);
        assert!(summary.push_event(event(
            "2",
            HealthLevel::Warn,
            RECORDING_STOP_FINALIZE_OVERRUN_CODE
        )));
        assert_eq!(summary.tone(), HealthTone::Warning);
        summary.push_event(event("3", HealthLevel::Error, "encoder-quit"));
        assert_eq!(summary.tone(), HealthTone::Error);
        assert_eq!(summary.events[0].id, "3", "newest first");
        assert_eq!(summary.events_for_session("s").count(), 3);
        assert_eq!(summary.events_for_session("other").count(), 0);
        summary.set_backend(health(false, true));
        assert_eq!(summary.tone(), HealthTone::Error);
        summary.clear_backend();
        assert_eq!(summary.tone(), HealthTone::Unknown);
    }

    #[test]
    fn the_same_sessions_stream_health_keeps_the_numbers_an_update_leaves_out() {
        let first = serde_json::json!({"sessionId": "a", "fps": 30, "droppedFrames": 2});
        let merged = merge_stream_health(
            Some(first),
            serde_json::json!({"sessionId": "a", "fps": null, "speed": 1.0}),
        );
        assert_eq!(
            merged,
            serde_json::json!({"sessionId": "a", "fps": 30, "droppedFrames": 2, "speed": 1.0})
        );
        let other = merge_stream_health(
            Some(merged),
            serde_json::json!({"sessionId": "b", "fps": 60}),
        );
        assert_eq!(other, serde_json::json!({"sessionId": "b", "fps": 60}));
    }

    #[test]
    fn capture_drops_read_the_window_never_the_run_totals() {
        let start = Instant::now();
        let mut telemetry = HealthTelemetry::default();
        let stats = |camera: u64, screen: u64| {
            serde_json::json!({
                "sessionId": "s",
                "previewCameraDroppedFrames": camera,
                "previewScreenDroppedFrames": screen,
            })
        };
        // The first sample is the baseline, however large.
        telemetry.apply(DIAGNOSTICS_STATS_EVENT, stats(0, 5_065), start);
        assert!(!telemetry.capture_dropping(start));
        telemetry.apply(DIAGNOSTICS_STATS_EVENT, stats(0, 5_065), start);
        assert!(!telemetry.capture_dropping(start));
        let later = start + Duration::from_secs(1);
        telemetry.apply(DIAGNOSTICS_STATS_EVENT, stats(1, 5_065), later);
        assert!(telemetry.capture_dropping(later));
        assert!(telemetry.capture_dropping(later + RECENT_DROP_WINDOW));
        assert!(!telemetry.capture_dropping(later + RECENT_DROP_WINDOW + Duration::from_millis(1)));
        // A new session starts over.
        telemetry.apply(
            DIAGNOSTICS_STATS_EVENT,
            serde_json::json!({"sessionId": "t", "previewCameraDroppedFrames": 9}),
            later,
        );
        assert!(!telemetry.capture_dropping(later));
        assert!(!telemetry.apply("devices.changed", Value::Null, later));
    }

    #[test]
    fn the_event_list_keeps_the_newest_forty() {
        let mut summary = HealthSummary::default();
        for index in 0..50 {
            summary.push_event(event(&index.to_string(), HealthLevel::Info, "x"));
        }
        assert_eq!(summary.events.len(), HEALTH_EVENT_LIMIT);
        assert_eq!(summary.events[0].id, "49");
        assert_eq!(summary.events[39].id, "10");
    }
}
