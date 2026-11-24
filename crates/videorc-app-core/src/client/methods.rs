//! Typed request and response pairs for the methods Phase 2 uses, as
//! `BackendRpcMethodMap` in `apps/desktop/src/shared/backend-rpc-contract.ts`
//! types them for the renderer. Each pair is a unit struct naming the method;
//! [`super::BackendClient::call`] and [`super::BackendSocket::call`] take it as
//! a type parameter:
//!
//! ```ignore
//! let health = client.call::<HealthPing>(&()).await?;
//! ```
//!
//! Every other method stays reachable untyped through `request(method,
//! serde_json::Value)`.
//!
//! Methods without params take `()`, sent as no `params` at all (what the
//! renderer's `request(method)` sends); several handlers refuse anything but
//! null.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use videorc_protocol::playback::{
    PlaybackMuteParams, PlaybackOpenParams, PlaybackSeekParams, PlaybackStatus,
};
use videorc_protocol::{
    AudioProcessingUpdateParams, AudioProcessingUpdateResult, BackendHealth, CompositorStatus,
    DeviceList, PreviewScreenStartParams, PreviewScreenStatus, PreviewSurfaceBoundsParams,
    PreviewSurfaceCreateParams, PreviewSurfaceStatus, RecordingStatus, Scene, SceneCommitStatus,
    SceneConfigParams, SessionDetailListParams, SessionHealthEventsPage, SessionListPage,
    SessionListParams, SessionLogsPage, SessionStopParams, StartSessionParams,
};

/// One backend method: its wire name and the types of its params and result.
pub trait Method {
    const NAME: &'static str;
    type Params: Serialize;
    type Result: DeserializeOwned;
}

macro_rules! method {
    ($(#[$doc:meta])* $name:ident, $wire:literal, $params:ty => $result:ty) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub struct $name;

        impl Method for $name {
            const NAME: &'static str = $wire;
            type Params = $params;
            type Result = $result;
        }
    };
}

method!(
    /// The backend's health; the renderer credential sees managed paths only.
    HealthPing, "health.ping", () => BackendHealth
);
method!(
    /// The session status: idle, starting, recording, streaming, stopping or
    /// failed.
    RecordingStatusGet, "recording.status", () => RecordingStatus
);
method!(
    /// The screens, windows, cameras and microphones the backend can capture,
    /// with the permission warnings (30 s deadline; the backend also pushes
    /// the list as `devices.changed`).
    DevicesList, "devices.list", () => DeviceList
);
method!(
    /// Record, go live, or both: `output.recordEnabled`,
    /// `output.streamEnabled` and `streaming` (the destinations) choose.
    /// Answers with the status once the session runs (120 s deadline).
    SessionStart, "session.start", StartSessionParams => RecordingStatus
);
method!(
    /// Stop: ends the recording and the stream together (120 s deadline).
    SessionStop, "session.stop", SessionStopParams => RecordingStatus
);
method!(
    /// The committed scene.
    SceneGet, "scene.get", () => Scene
);
method!(
    /// Commits the idle scene built from a capture config (sources, layout,
    /// video). Answers whether it applied and the compositor's state.
    SceneLoadFromCaptureConfig, "scene.load_from_capture_config", SceneConfigParams => SceneCommitStatus
);
method!(
    /// The compositor's status (10 s deadline).
    CompositorStatusGet, "compositor.status", () => CompositorStatus
);
method!(
    /// Starts the preview surface at the given bounds and rate; the backend
    /// starts its preview compositor (the synthetic one for `source:
    /// synthetic`).
    PreviewSurfaceCreate, "preview.surface.create", PreviewSurfaceCreateParams => PreviewSurfaceStatus
);
method!(
    /// Moves or resizes the preview surface.
    PreviewSurfaceUpdateBounds, "preview.surface.update_bounds", PreviewSurfaceBoundsParams => PreviewSurfaceStatus
);
method!(
    /// Stops the preview surface and its compositor.
    PreviewSurfaceDestroy, "preview.surface.destroy", () => PreviewSurfaceStatus
);
method!(
    /// Plan 260 (from plan 220 S3.7b): opens a recording's playback in the
    /// backend, paused on its first frame (a refusal is a `failed` status
    /// with `refusal`). The backend answers the playback family from D9 on.
    PlaybackOpen, "playback.open", PlaybackOpenParams => PlaybackStatus
);
method!(
    /// Starts the playback's clock (from the top after its end).
    PlaybackPlay, "playback.play", () => PlaybackStatus
);
method!(
    /// Stops the playback's clock where it stands.
    PlaybackPause, "playback.pause", () => PlaybackStatus
);
method!(
    /// Moves the playhead; the frame there shows at once.
    PlaybackSeek, "playback.seek", PlaybackSeekParams => PlaybackStatus
);
method!(
    /// Mutes or unmutes the playback's sound; the clock keeps time.
    PlaybackMute, "playback.mute", PlaybackMuteParams => PlaybackStatus
);
method!(
    /// Closes the playback: its decoders stop and its ring goes.
    PlaybackClose, "playback.close", () => PlaybackStatus
);
method!(
    /// The playback's status.
    PlaybackStatusGet, "playback.status", () => PlaybackStatus
);
method!(
    /// The preview surface's status (5 s deadline).
    PreviewSurfaceStatusGet, "preview.surface.status", () => PreviewSurfaceStatus
);
method!(
    /// Plan 220 S2.6c: starts the screen or window capture of `sources`, or,
    /// when that capture already runs, applies `protectedOverlayWindowIds`
    /// (the windows the backend's ScreenCaptureKit filter leaves out) to it
    /// in place; the status's message says which. The renderer's screen
    /// preview start, which carries the exclusion list.
    PreviewScreenStart, "preview.screen.start", PreviewScreenStartParams => PreviewScreenStatus
);
method!(
    /// This socket hears only these events from now on (connection-scoped).
    EventsSetIncluded, "events.setIncluded", EventListParams => IncludedEvents
);
method!(
    /// This socket hears every event but these from now on
    /// (connection-scoped).
    EventsSetExcluded, "events.setExcluded", EventListParams => ExcludedEvents
);

method!(
    /// Plan 220 S2.4c: the ack of a relayed `remote.intent`, which the
    /// backend forwards to the remote as `remote.ack` (`{intentId, ok,
    /// message?}`). Answers `{ok: true}`.
    RemoteIntentAck, "remote.intent.ack", RemoteIntentAckParams => Value
);
method!(
    /// Plan 220 S2.4c: the remote surface (`{state, describe}`) the deck keys
    /// render, as `RemoteSurfacePublisher` published it from the renderer.
    /// The backend keeps the newest and pushes `state` as `remote.state`.
    RemoteSurfacePublish, "remote.surface.publish", Value => Value
);
method!(
    /// The live microphone and System audio update for a running session
    /// (`audio.processing.update`); `applied` says whether the session took
    /// it.
    AudioProcessingUpdate, "audio.processing.update", AudioProcessingUpdateParams => AudioProcessingUpdateResult
);
method!(
    /// Plan 220 S3.0f: one page of the Library's rows, newest first (the
    /// recovery after a reconnect reads the first page for a session that
    /// failed while the Studio was away).
    SessionsList, "sessions.list", SessionListParams => SessionListPage
);
method!(
    /// Plan 220 S3.0f: one page of a session's health events, oldest first.
    SessionHealthEventsList, "sessions.healthEvents.list", SessionDetailListParams => SessionHealthEventsPage
);
method!(
    /// Plan 220 S3.0g: one page of a session's log lines, oldest first
    /// (Health's recording log).
    SessionLogsList, "sessions.logs.list", SessionDetailListParams => SessionLogsPage
);
method!(
    /// Plan 220 S3.0g: Health's support bundle (`{appVersion,
    /// rendererDiagnostics}` → `{path, includedSections, redactionSummary}`),
    /// written to the backend's `support-bundles` folder.
    SupportBundleExport, "diagnostics.supportBundle.export", Value => Value
);

/// `remote.intent.ack`'s params: the ticket id and the outcome, with a
/// message only when there is one (the renderer's `executeRemoteIntent`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteIntentAckParams {
    pub intent_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// `events.setIncluded` / `events.setExcluded` params.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventListParams {
    pub events: Vec<String>,
}

/// `events.setIncluded`'s answer: the list now in force, sorted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncludedEvents {
    pub included: Vec<String>,
}

/// `events.setExcluded`'s answer: the list now in force, sorted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedEvents {
    pub excluded: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::timeouts::{DEFAULT_REQUEST_TIMEOUT, backend_request_timeout};
    use serde_json::{Value, json};
    use std::time::Duration;
    use videorc_protocol::streaming::StreamingSettings;
    use videorc_protocol::{
        AudioSettings, LayoutSettings, OutputSettings, RtmpPreset, RtmpSettings, SessionPurpose,
        SourceSelection, VideoPreset, VideoSettings,
    };

    // Plan 260 S1.6c: `videorc-rust` read a wire snapshot fixture here; the
    // client and the backend now share one `videorc-protocol`, so the cases
    // below compare against the protocol's own values, and the shared
    // high-risk fixture (also read by Electron's tests) stays the outside
    // reference.
    const HIGH_RISK: &str = include_str!("../../../../protocol-fixtures/high-risk-contracts.json");

    fn high_risk(path: &[&str]) -> Value {
        let mut value: Value = serde_json::from_str(HIGH_RISK).unwrap();
        for key in path {
            value = value[*key].take();
        }
        assert!(
            !value.is_null(),
            "{path:?} is not in high-risk-contracts.json"
        );
        value
    }

    fn video_1080p30() -> VideoSettings {
        VideoSettings {
            preset: VideoPreset::Tutorial1080p30,
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate_kbps: 8_000,
        }
    }

    fn sources() -> SourceSelection {
        SourceSelection {
            screen_id: Some("screen:1".to_string()),
            window_id: None,
            camera_id: Some("camera:1".to_string()),
            microphone_id: Some("mic:1".to_string()),
            test_pattern: false,
        }
    }

    fn layout() -> LayoutSettings {
        videorc_protocol::default_layout_settings()
    }

    fn output(record: bool, stream: bool) -> OutputSettings {
        OutputSettings {
            record_enabled: record,
            stream_enabled: stream,
            output_directory: None,
            ffmpeg_path: None,
            keep_original_mkv: false,
            separate_source_recordings: None,
            video: video_1080p30(),
            rtmp: RtmpSettings {
                preset: RtmpPreset::Custom,
                server_url: String::new(),
                stream_key: String::new(),
            },
        }
    }

    fn record_params() -> StartSessionParams {
        StartSessionParams {
            sources: sources(),
            layout: layout(),
            scene: None,
            output: output(true, false),
            audio: AudioSettings::default(),
            streaming: None,
            captions: None,
            simulcast: None,
            requested_at_ms: Some(1_762_560_000_000),
            replay: None,
            purpose: SessionPurpose::Capture,
        }
    }

    #[test]
    fn the_wire_names_are_the_backend_methods() {
        assert_eq!(SessionStart::NAME, "session.start");
        assert_eq!(SessionStop::NAME, "session.stop");
        assert_eq!(RecordingStatusGet::NAME, "recording.status");
        assert_eq!(PreviewSurfaceCreate::NAME, "preview.surface.create");
        assert_eq!(PlaybackOpen::NAME, "playback.open");
        assert_eq!(PlaybackSeek::NAME, "playback.seek");
        assert_eq!(PlaybackStatusGet::NAME, "playback.status");
        assert_eq!(PreviewScreenStart::NAME, "preview.screen.start");
        assert_eq!(
            SceneLoadFromCaptureConfig::NAME,
            "scene.load_from_capture_config"
        );
        // The deadlines follow the method (backendClient.ts).
        assert_eq!(
            backend_request_timeout(SessionStart::NAME),
            Duration::from_secs(120)
        );
        assert_eq!(
            backend_request_timeout(SessionStop::NAME),
            Duration::from_secs(120)
        );
        assert_eq!(
            backend_request_timeout(SceneGet::NAME),
            DEFAULT_REQUEST_TIMEOUT
        );
    }

    /// Record: what the client sends, and the backend reads it back the same.
    /// Today's protocol writes an absent option as `null` (no
    /// `skip_serializing_if` on these fields; adding it would change what the
    /// backend writes, which S1.1 must not), and the backend reads `null` as
    /// absent, so each optional block is absent or `null` and reads back as
    /// `None`.
    #[test]
    fn record_params_serialize_absent_options_and_read_back() {
        let params = record_params();
        let wire = serde_json::to_value(&params).unwrap();
        let object = wire.as_object().unwrap();
        for absent in [
            "streaming",
            "captions",
            "scene",
            "simulcast",
            "replay",
            "purpose",
        ] {
            assert!(
                object.get(absent).is_none_or(Value::is_null),
                "{absent} must be absent or null: {wire}"
            );
        }
        for absent in ["outputDirectory", "ffmpegPath", "separateSourceRecordings"] {
            assert!(
                wire["output"].get(absent).is_none_or(Value::is_null),
                "output.{absent} must be absent or null: {wire}"
            );
        }
        assert_eq!(wire["output"]["recordEnabled"], true);
        assert_eq!(wire["output"]["streamEnabled"], false);
        assert_eq!(wire["requestedAtMs"], 1_762_560_000_000u64);
        // The layout is the protocol's default layout, byte for byte.
        assert_eq!(
            serde_json::to_string(&params.layout).unwrap(),
            serde_json::to_string(&videorc_protocol::default_layout_settings()).unwrap()
        );
        let back: StartSessionParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap(), wire);
        assert!(back.output.record_enabled && !back.output.stream_enabled);
        assert!(back.streaming.is_none() && back.captions.is_none() && back.scene.is_none());
    }

    /// Go live: `streamEnabled` and the destinations, carried as sent.
    #[test]
    fn go_live_params_carry_the_streaming_settings() {
        let streaming_wire = json!({
            "enabled": true,
            "mode": "multi",
            "targets": [],
            "selectedTargetId": "t1",
            "defaultOutputPreset": "stream-youtube-1080p60",
            "defaultBitrateKbps": 6000,
            "enabledTargetIds": ["t1"]
        })
        .to_string();
        let streaming: StreamingSettings = serde_json::from_str(&streaming_wire).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&serde_json::to_string(&streaming).unwrap()).unwrap(),
            serde_json::from_str::<Value>(&streaming_wire).unwrap()
        );

        let params = StartSessionParams {
            output: output(false, true),
            streaming: Some(streaming),
            requested_at_ms: None,
            ..record_params()
        };
        let wire = serde_json::to_value(&params).unwrap();
        assert_eq!(wire["output"]["streamEnabled"], true);
        assert_eq!(wire["output"]["recordEnabled"], false);
        assert_eq!(
            wire["streaming"],
            serde_json::from_str::<Value>(&streaming_wire).unwrap()
        );
        assert!(wire.get("requestedAtMs").is_none());
        let back: StartSessionParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap(), wire);
    }

    /// Stop: `SessionStopParams::default` is `{}`.
    #[test]
    fn stop_params_omit_an_absent_click_time() {
        assert_eq!(
            serde_json::to_string(&SessionStopParams::default()).unwrap(),
            "{}"
        );
        let clicked = SessionStopParams {
            requested_at_ms: Some(5),
        };
        assert_eq!(
            serde_json::to_value(&clicked).unwrap(),
            json!({"requestedAtMs": 5})
        );
    }

    /// The answers to record, stop and status read the shared fixture's
    /// recording statuses.
    #[test]
    fn recording_status_answers_read_the_shared_fixture() {
        for case in ["wire", "fixedSceneWire", "minimalWire", "mixedAudioWire"] {
            let wire = high_risk(&["recordingStatus", case]);
            let status: <SessionStart as Method>::Result = serde_json::from_value(wire.clone())
                .unwrap_or_else(|error| panic!("recordingStatus.{case}: {error}"));
            let again = serde_json::to_value(&status).unwrap();
            assert_eq!(again["state"], wire["state"], "recordingStatus.{case}");
        }
        let _: <CompositorStatusGet as Method>::Result =
            serde_json::from_value(high_risk(&["compositorStatus", "stoppedWire"])).unwrap();
        let _: <SceneGet as Method>::Result =
            serde_json::from_value(high_risk(&["scene", "wire"])).unwrap();
    }

    #[test]
    fn scene_and_preview_params_omit_absent_options() {
        let scene = SceneConfigParams {
            sources: SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: true,
            },
            layout: layout(),
            video: None,
            background: None,
            protected_overlay_window_ids: Vec::new(),
            transition_ms: None,
        };
        let wire = serde_json::to_value(&scene).unwrap();
        assert!(
            wire.get("video").is_none_or(Value::is_null),
            "video must be absent or null: {wire}"
        );
        assert_eq!(wire["sources"]["testPattern"], true);

        let bounds = high_risk(&["previewSurfaceBounds", "wire"]);
        let create: PreviewSurfaceCreateParams = serde_json::from_value(
            json!({"bounds": bounds, "targetFps": 60, "source": "synthetic"}),
        )
        .unwrap();
        let wire = serde_json::to_value(&create).unwrap();
        assert_eq!(wire["source"], "synthetic");
        assert_eq!(wire["targetFps"], 60);
        let bounds = videorc_protocol::PreviewSurfaceBounds::default();
        let again: videorc_protocol::PreviewSurfaceBounds =
            serde_json::from_str(&serde_json::to_string(&bounds).unwrap()).unwrap();
        assert_eq!(again, bounds);
    }

    #[test]
    fn health_reads_the_backend_shape() {
        let wire = json!({
            "status": "ok",
            "version": "0.37.1",
            "platform": "macos",
            "ffmpeg": {"path": "/opt/ffmpeg/bin/ffmpeg", "available": true, "version": "7.1"},
            "databasePath": "/tmp/videorc.sqlite3",
            "secretStoreBackend": "keychain"
        })
        .to_string();
        let health: <HealthPing as Method>::Result = serde_json::from_str(&wire).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&serde_json::to_string(&health).unwrap()).unwrap(),
            serde_json::from_str::<Value>(&wire).unwrap()
        );
        assert!(health.ffmpeg.available);
    }

    #[test]
    fn event_list_params_are_the_backend_shape() {
        let params = EventListParams {
            events: vec!["recording.status".to_string()],
        };
        assert_eq!(
            serde_json::to_value(&params).unwrap(),
            json!({"events": ["recording.status"]})
        );
        let included: IncludedEvents =
            serde_json::from_value(json!({"included": ["a", "b"]})).unwrap();
        assert_eq!(included.included, ["a", "b"]);
        let excluded: ExcludedEvents = serde_json::from_value(json!({"excluded": []})).unwrap();
        assert!(excluded.excluded.is_empty());
    }
}
