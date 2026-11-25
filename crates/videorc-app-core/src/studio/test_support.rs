//! The view tests' Studio (plan 260 S1.6a part 6a): a snapshot read from a
//! [`Studio`] over a backend that answers nothing, so a fixture holds every
//! area's defaults whatever fields the snapshot grows, then made ready to
//! start (connected, bootstrapped, the recorder there, a saved Custom RTMP
//! destination at 1080p30).

use std::sync::Arc;

use serde_json::{Value, json};
use videorc_protocol::streaming::{StreamMode, StreamTargetSettings, StreamingSettings};
use videorc_protocol::{
    AudioProcessingUpdateParams, AudioProcessingUpdateResult, BackendHealth, DeviceList,
    PreviewScreenStartParams, PreviewScreenStatus, RecordingStatus, Scene, SessionStopParams,
    StartSessionParams, ToolStatus, VideoPreset, VideoSettings,
};

use super::session::SessionActivity;
use super::{
    Connection, HealthSummary, SessionPhase, Studio, StudioBackend, StudioConfig, StudioSnapshot,
};
use crate::client::RpcError;
use crate::client::methods::RemoteIntentAckParams;
use videorc_protocol::ui_settings::{
    UiSettingsChange, UiSettingsGetParams, UiSettingsSetParams, UiSettingsSnapshot,
};

/// A backend that answers nothing.
pub(crate) struct Silent;

impl StudioBackend for Silent {
    async fn health(&self) -> Result<BackendHealth, RpcError> {
        Err(RpcError::not_connected("health.ping"))
    }

    async fn devices(&self) -> Result<DeviceList, RpcError> {
        Err(RpcError::not_connected("devices.list"))
    }

    async fn recording_status(&self) -> Result<RecordingStatus, RpcError> {
        Err(RpcError::not_connected("recording.status"))
    }

    async fn scene(&self) -> Result<Scene, RpcError> {
        Err(RpcError::not_connected("scene.get"))
    }

    async fn settings_get(
        &self,
        _params: UiSettingsGetParams,
    ) -> Result<UiSettingsSnapshot, RpcError> {
        Err(RpcError::not_connected("ui.settings.get"))
    }

    async fn settings_set(
        &self,
        _params: UiSettingsSetParams,
    ) -> Result<UiSettingsChange, RpcError> {
        Err(RpcError::not_connected("ui.settings.set"))
    }

    async fn session_start(
        &self,
        _params: StartSessionParams,
    ) -> Result<RecordingStatus, RpcError> {
        Err(RpcError::not_connected("session.start"))
    }

    async fn session_stop(&self, _params: SessionStopParams) -> Result<RecordingStatus, RpcError> {
        Err(RpcError::not_connected("session.stop"))
    }

    async fn audio_processing_update(
        &self,
        _params: AudioProcessingUpdateParams,
    ) -> Result<AudioProcessingUpdateResult, RpcError> {
        Err(RpcError::not_connected("audio.processing.update"))
    }

    async fn remote_intent_ack(&self, _params: RemoteIntentAckParams) -> Result<(), RpcError> {
        Err(RpcError::not_connected("remote.intent.ack"))
    }

    async fn remote_surface_publish(&self, _snapshot: Value) -> Result<(), RpcError> {
        Err(RpcError::not_connected("remote.surface.publish"))
    }

    async fn preview_screen_start(
        &self,
        _params: PreviewScreenStartParams,
    ) -> Result<PreviewScreenStatus, RpcError> {
        Err(RpcError::not_connected("preview.screen.start"))
    }
}

/// The snapshot a new Studio publishes: waiting for the backend.
pub(crate) fn fresh_snapshot() -> StudioSnapshot {
    Studio::new(Arc::new(Silent), StudioConfig::default()).snapshot()
}

/// `health.ping` answered, with or without the recorder.
pub(crate) fn health(ffmpeg: bool) -> HealthSummary {
    let mut summary = HealthSummary::default();
    summary.set_backend(BackendHealth {
        status: "ok".to_string(),
        version: "test".to_string(),
        platform: "darwin".to_string(),
        ffmpeg: ToolStatus {
            path: "/ffmpeg".to_string(),
            available: ffmpeg,
            version: None,
            message: None,
        },
        database_path: "/db".to_string(),
        secret_store_backend: "keychain".to_string(),
    });
    summary
}

/// A saved destination, as `Livestream → Setup` keeps it.
pub(crate) fn destination(id: &str, label: &str, enabled: bool) -> StreamTargetSettings {
    serde_json::from_value(json!({
        "id": id, "platform": "custom", "label": label, "enabled": enabled,
        "serverUrl": "rtmp://127.0.0.1/live", "streamKey": "k",
        "streamKeyPresent": true, "authMode": "manual-rtmp",
        "createdAt": "2026-11-08T00:00:00Z", "updatedAt": "2026-11-08T00:00:00Z"
    }))
    .expect("a stream target")
}

/// The saved destinations, set on both the typed config and the document.
pub(crate) fn set_destinations(snapshot: &mut StudioSnapshot, targets: Vec<StreamTargetSettings>) {
    let enabled_target_ids = targets
        .iter()
        .filter(|target| target.enabled)
        .map(|target| target.id.clone())
        .collect();
    let streaming = StreamingSettings {
        enabled: true,
        mode: StreamMode::Single,
        targets,
        selected_target_id: None,
        default_output_preset: VideoPreset::Tutorial1080p30,
        default_bitrate_kbps: 6_000,
        enabled_target_ids,
    };
    snapshot.settings.capture_doc["streaming"] =
        serde_json::to_value(&streaming).expect("streaming settings");
    snapshot.settings.capture.streaming = Some(streaming);
}

/// Connected, bootstrapped, the recorder there, one Custom RTMP
/// destination on, 1080p30, nothing running.
pub(crate) fn ready_snapshot() -> StudioSnapshot {
    let mut snapshot = fresh_snapshot();
    snapshot.connection = Connection::Connected { pid: 1 };
    snapshot.connection_generation = 1;
    snapshot.bootstrapped = true;
    snapshot.health = health(true);
    snapshot.settings.hydrated = true;
    snapshot.settings.capture.video = VideoSettings {
        preset: VideoPreset::Tutorial1080p30,
        width: 1920,
        height: 1080,
        fps: 30,
        bitrate_kbps: 6_000,
    };
    set_destinations(
        &mut snapshot,
        vec![destination("custom", "Custom RTMP", true)],
    );
    snapshot
}

/// The session reads `status`, as the Studio would publish it.
pub(crate) fn set_status(snapshot: &mut StudioSnapshot, status: RecordingStatus) {
    snapshot.session.phase = SessionPhase::from_status(&status);
    snapshot.session.activity = SessionActivity::of(&status);
    snapshot.session.status = status;
}
