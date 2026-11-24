//! Plan 220 S2.4a: the Studio driver against a scripted fake backend. No
//! process, no socket: every answer is queued by the test, every event is
//! handed in by the test, and the transitions (including the failure
//! paths) are checked on the snapshot and the effects.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::{Semaphore, broadcast};
use videorc_app_core::Logger;
use videorc_app_core::client::methods::RemoteIntentAckParams;
use videorc_app_core::client::{BackendEvent, RpcError};
use videorc_app_core::studio::session::READY_TO_START_MESSAGE;
use videorc_app_core::studio::ui_settings_wire::{
    UI_SETTINGS_CHANGED_EVENT, UiSettingsChange, UiSettingsGetParams, UiSettingsSetParams,
    UiSettingsSnapshot,
};
use videorc_app_core::studio::{
    Connection, HealthTone, SessionActivity, SessionEffect, SessionPhase, SessionStartFailureKind,
    SessionStartIntent, StartOutcome, StopExit, StopOrigin, StopOutcome, Studio, StudioBackend,
    StudioConfig, families, keys, settings_write_kept,
};
use videorc_protocol::{
    AudioProcessingUpdateParams, AudioProcessingUpdateResult, BackendConnection, BackendHealth,
    Device, DeviceKind, DeviceList, DeviceStatus, HealthEvent, HealthLevel,
    PreviewScreenSourceKind, PreviewScreenStartParams, PreviewScreenState, PreviewScreenStatus,
    RecordingState, RecordingStatus, Scene, SessionStopParams, StartSessionParams, ToolStatus,
};

const WRITER: &str = "studio:test";

#[derive(Default)]
struct Script {
    start_answers: VecDeque<Result<RecordingStatus, RpcError>>,
    stop_answers: VecDeque<Result<RecordingStatus, RpcError>>,
    status_answers: VecDeque<RecordingStatus>,
    settings_set_fails: bool,
    /// `session.start` waits for a permit here when set.
    start_gate: Option<Arc<Semaphore>>,
    /// `session.stop` waits for a permit here when set.
    stop_gate: Option<Arc<Semaphore>>,
    /// The store, as the backend would hold it.
    settings: BTreeMap<String, Value>,
    revision: u64,
    calls: Vec<String>,
    started_with: Vec<StartSessionParams>,
    /// S3.6b: the folder capability each start carried.
    started_into: Vec<Option<String>>,
    /// S2.6c: every `preview.screen.start`, in order.
    screen_starts: Vec<PreviewScreenStartParams>,
    screen_start_fails: bool,
    /// S3.5c: the livestream RPCs' answers by method (one each, in order;
    /// a method with none left is not connected), and every call made.
    livestream: BTreeMap<String, VecDeque<Result<Value, RpcError>>>,
    livestream_calls: Vec<(String, Value)>,
    /// S1.6b: the device ids `devices.list` answers (the default: a camera
    /// and a display).
    device_ids: Option<Vec<String>>,
}

struct Scripted {
    script: Mutex<Script>,
}

impl Scripted {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(Script::default()),
        })
    }

    fn with(&self, edit: impl FnOnce(&mut Script)) {
        edit(&mut self.script.lock().unwrap());
    }

    fn calls(&self) -> Vec<String> {
        self.script.lock().unwrap().calls.clone()
    }

    fn count(&self, method: &str) -> usize {
        self.calls().iter().filter(|call| *call == method).count()
    }

    fn note(&self, method: &str) {
        self.script.lock().unwrap().calls.push(method.to_string());
    }
}

impl StudioBackend for Scripted {
    async fn health(&self) -> Result<BackendHealth, RpcError> {
        self.note("health.ping");
        Ok(health_ok())
    }

    async fn devices(&self) -> Result<DeviceList, RpcError> {
        self.note("devices.list");
        let ids = self.script.lock().unwrap().device_ids.clone();
        Ok(match ids {
            Some(ids) => devices(&ids.iter().map(String::as_str).collect::<Vec<_>>()),
            None => devices(&["camera:1", "screen:screencapturekit:1"]),
        })
    }

    async fn recording_status(&self) -> Result<RecordingStatus, RpcError> {
        self.note("recording.status");
        let next = self.script.lock().unwrap().status_answers.pop_front();
        Ok(next.unwrap_or_else(|| status(RecordingState::Idle, None)))
    }

    async fn scene(&self) -> Result<Scene, RpcError> {
        self.note("scene.get");
        Ok(scene())
    }

    async fn settings_get(
        &self,
        _params: UiSettingsGetParams,
    ) -> Result<UiSettingsSnapshot, RpcError> {
        self.note("ui.settings.get");
        let script = self.script.lock().unwrap();
        Ok(UiSettingsSnapshot {
            entries: script.settings.clone(),
            revision: script.revision,
            local_storage_migrated: true,
        })
    }

    async fn settings_set(
        &self,
        params: UiSettingsSetParams,
    ) -> Result<UiSettingsChange, RpcError> {
        self.note("ui.settings.set");
        let mut script = self.script.lock().unwrap();
        if script.settings_set_fails {
            return Err(RpcError::new(
                "ui.settings.set",
                "ui-settings-too-large",
                "That setting is too large to store.",
            ));
        }
        for (key, value) in &params.put {
            script.settings.insert(key.clone(), value.clone());
        }
        for key in &params.delete {
            script.settings.remove(key);
        }
        script.revision += 1;
        Ok(UiSettingsChange {
            revision: script.revision,
            put: params.put,
            delete: params.delete,
            writer: params.writer,
        })
    }

    async fn session_start(&self, params: StartSessionParams) -> Result<RecordingStatus, RpcError> {
        self.note("session.start");
        let gate = self.script.lock().unwrap().start_gate.clone();
        if let Some(gate) = gate {
            gate.acquire().await.unwrap().forget();
        }
        let mut script = self.script.lock().unwrap();
        script.started_with.push(params);
        script
            .start_answers
            .pop_front()
            .unwrap_or_else(|| Ok(status(RecordingState::Recording, Some("s1"))))
    }

    async fn session_start_into(
        &self,
        params: StartSessionParams,
        folder_capability: Option<String>,
    ) -> Result<RecordingStatus, RpcError> {
        self.script
            .lock()
            .unwrap()
            .started_into
            .push(folder_capability);
        self.session_start(params).await
    }

    async fn session_stop(&self, _params: SessionStopParams) -> Result<RecordingStatus, RpcError> {
        self.note("session.stop");
        let gate = self.script.lock().unwrap().stop_gate.clone();
        if let Some(gate) = gate {
            gate.acquire().await.unwrap().forget();
        }
        let mut script = self.script.lock().unwrap();
        script
            .stop_answers
            .pop_front()
            .unwrap_or_else(|| Ok(status(RecordingState::Stopping, Some("s1"))))
    }

    // S2.4c's requests: not part of these tests (tests/remote_executor.rs
    // and the `remote` module's own tests cover them).
    async fn audio_processing_update(
        &self,
        params: AudioProcessingUpdateParams,
    ) -> Result<AudioProcessingUpdateResult, RpcError> {
        self.note("audio.processing.update");
        Err(RpcError::not_connected(&format!(
            "audio.processing.update for {}",
            params.session_id
        )))
    }

    async fn remote_intent_ack(&self, _params: RemoteIntentAckParams) -> Result<(), RpcError> {
        self.note("remote.intent.ack");
        Ok(())
    }

    async fn remote_surface_publish(&self, _snapshot: Value) -> Result<(), RpcError> {
        self.note("remote.surface.publish");
        Ok(())
    }

    async fn livestream_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<Value, RpcError> {
        let mut script = self.script.lock().unwrap();
        script.livestream_calls.push((method.to_string(), params));
        script
            .livestream
            .get_mut(method)
            .and_then(VecDeque::pop_front)
            .unwrap_or_else(|| Err(RpcError::not_connected(method)))
    }

    async fn preview_screen_start(
        &self,
        params: PreviewScreenStartParams,
    ) -> Result<PreviewScreenStatus, RpcError> {
        self.note("preview.screen.start");
        let mut script = self.script.lock().unwrap();
        if script.screen_start_fails {
            return Err(RpcError::new(
                "preview.screen.start",
                "screen-failed",
                "The screen capture could not start.",
            ));
        }
        let reused = !script.screen_starts.is_empty();
        script.screen_starts.push(params);
        Ok(screen_status(reused))
    }
}

fn screen_status(reused: bool) -> PreviewScreenStatus {
    PreviewScreenStatus {
        state: PreviewScreenState::Live,
        source_id: Some("screen:screencapturekit:1".to_string()),
        source_kind: Some(PreviewScreenSourceKind::Screen),
        target_fps: 30,
        width: None,
        height: None,
        native_width: None,
        native_height: None,
        requested_width: None,
        requested_height: None,
        actual_width: None,
        actual_height: None,
        iosurface_available: None,
        d3d11_texture_available: None,
        source_fps: None,
        frame_age_ms: None,
        frames_captured: 1,
        dropped_frames: 0,
        sequence: None,
        include_cursor: true,
        exclude_current_process_windows: false,
        updated_at: "2026-11-09T00:00:00Z".to_string(),
        message: Some(if reused {
            "Native screen preview source reused; the capture exclusion set was applied to the running capture.".to_string()
        } else {
            "Native screen preview started.".to_string()
        }),
    }
}

fn health_ok() -> BackendHealth {
    BackendHealth {
        status: "ok".to_string(),
        version: "0.0.0-test".to_string(),
        platform: "test".to_string(),
        ffmpeg: ToolStatus {
            path: "ffmpeg".to_string(),
            available: true,
            version: None,
            message: None,
        },
        database_path: String::new(),
        secret_store_backend: "test".to_string(),
    }
}

fn devices(ids: &[&str]) -> DeviceList {
    DeviceList {
        devices: ids
            .iter()
            .map(|id| Device {
                app: None,
                window_title: None,
                display_uuid: None,
                id: id.to_string(),
                name: id.to_string(),
                // S3.1c: a display the reconcile keeps (a ScreenCaptureKit
                // screen); every other id is a camera.
                kind: if id.starts_with("screen:") {
                    DeviceKind::Screen
                } else {
                    DeviceKind::Camera
                },
                status: DeviceStatus::Available,
                detail: None,
                width: None,
                height: None,
            })
            .collect(),
        warnings: Vec::new(),
    }
}

/// The shared fixture's scene (`high-risk-contracts.json`).
fn scene() -> Scene {
    const HIGH_RISK: &str = include_str!("../../../protocol-fixtures/high-risk-contracts.json");
    let fixture: Value = serde_json::from_str(HIGH_RISK).unwrap();
    serde_json::from_value(fixture["scene"]["wire"].clone()).expect("the fixture's scene")
}

fn status(state: RecordingState, session_id: Option<&str>) -> RecordingStatus {
    RecordingStatus {
        state,
        session_id: session_id.map(str::to_string),
        output_path: None,
        stream_url: None,
        started_at: None,
        audio_tracks: Vec::new(),
        pipeline: None,
        duration_ms: None,
        message: None,
        replay_only: false,
        accepts_live_scene_edits: None,
    }
}

fn live(session_id: &str) -> RecordingStatus {
    RecordingStatus {
        stream_url: Some("rtmp://127.0.0.1:1935/live".to_string()),
        ..status(RecordingState::Recording, Some(session_id))
    }
}

fn ready() -> BackendEvent {
    BackendEvent::Ready(BackendConnection {
        host: "127.0.0.1".to_string(),
        port: 1,
        token: "t".to_string(),
        pid: 42,
        parent_pid: None,
    })
}

fn new_studio(backend: &Arc<Scripted>) -> Arc<Studio<Scripted>> {
    Arc::new(Studio::new(
        backend.clone(),
        StudioConfig {
            logger: Logger::silent(),
            writer_id: WRITER.to_string(),
            ..StudioConfig::default()
        },
    ))
}

fn drain(effects: &mut broadcast::Receiver<SessionEffect>) -> Vec<SessionEffect> {
    let mut out = Vec::new();
    while let Ok(effect) = effects.try_recv() {
        out.push(effect);
    }
    out
}

/// The Twitch destination the Go Live tests stream to; a capture config with
/// it saved, as the Livestream page writes it.
fn capture_config_with_twitch() -> Value {
    json!({
        "recordEnabled": true,
        "streamEnabled": false,
        "streaming": {
            "enabled": true, "mode": "single",
            "targets": [{
                "id": "twitch", "platform": "twitch", "label": "Twitch", "enabled": true,
                "serverUrl": "rtmp://live.twitch.tv/app", "streamKey": "k",
                "streamKeyPresent": true, "authMode": "manual-rtmp",
                "createdAt": "2026-11-08T00:00:00Z", "updatedAt": "2026-11-08T00:00:00Z"
            }],
            "defaultOutputPreset": "tutorial-1080p30", "defaultBitrateKbps": 6000,
            "enabledTargetIds": ["twitch"]
        }
    })
}

#[tokio::test]
async fn the_bootstrap_reads_everything_in_one_go() {
    let backend = Scripted::new();
    backend.with(|script| {
        script
            .settings
            .insert(keys::THEME.to_string(), Value::String("light".to_string()));
        script.settings.insert(
            keys::SETTINGS.to_string(),
            Value::String(r#"{"keepOriginalRecording":true}"#.to_string()),
        );
        script.revision = 9;
    });
    let studio = new_studio(&backend);
    let before = studio.snapshot();
    assert_eq!(before.connection, Connection::Waiting);
    assert!(!before.bootstrapped);
    assert!(!before.settings.hydrated);
    assert_eq!(before.health.tone(), HealthTone::Unknown);

    studio.handle_event(ready()).await;
    let after = studio.snapshot();
    assert_eq!(after.connection, Connection::Connected { pid: 42 });
    assert!(after.bootstrapped);
    assert_eq!(after.session.phase, SessionPhase::Idle);
    assert!(after.sources.devices_known);
    assert_eq!(after.sources.devices.devices.len(), 2);
    assert!(after.sources.scene.is_some());
    assert_eq!(after.health.tone(), HealthTone::Ok);
    assert!(after.settings.hydrated);
    // S1.6b: a profile with no scene library migrates and stores it once,
    // with the bootstrap's flush.
    assert_eq!(after.settings.revision, 10);
    assert!(after.scenes.loaded);
    assert_eq!(after.settings.theme.as_deref(), Some("light"));
    assert!(after.settings.studio.keep_original_recording());
    let mut calls = backend.calls();
    calls.sort();
    assert_eq!(
        calls,
        [
            "devices.list",
            "health.ping",
            "recording.status",
            "scene.get",
            "ui.settings.get",
            "ui.settings.set"
        ]
    );

    studio
        .handle_event(BackendEvent::ConnectionClosed {
            reason: "gone".to_string(),
        })
        .await;
    let closed = studio.snapshot();
    assert_eq!(
        closed.connection,
        Connection::Disconnected {
            reason: "gone".to_string()
        }
    );
    assert!(!closed.bootstrapped);
    assert!(!closed.sources.devices_known);
    assert_eq!(closed.health.tone(), HealthTone::Unknown);
}

#[tokio::test]
async fn record_then_stop_walks_idle_starting_recording_stopping_idle() {
    let backend = Scripted::new();
    // The start waits at this gate, so the optimistic `starting` is visible.
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| script.start_gate = Some(gate.clone()));
    let studio = new_studio(&backend);
    let mut effects = studio.effects();
    studio.handle_event(ready()).await;
    assert_eq!(studio.snapshot().session.phase, SessionPhase::Idle);

    // The Sources page's switch says test pattern; the start reads it.
    studio.set_test_pattern(true).await.unwrap();

    let starting = tokio::spawn({
        let studio = studio.clone();
        async move { studio.start_recording().await }
    });
    for _ in 0..100 {
        if studio.snapshot().session.phase == SessionPhase::Starting {
            break;
        }
        tokio::task::yield_now().await;
    }
    let snapshot = studio.snapshot();
    assert_eq!(snapshot.session.phase, SessionPhase::Starting);
    assert!(
        snapshot.session.start_pending,
        "Record is disabled meanwhile"
    );
    assert_eq!(
        snapshot.session.status.message.as_deref(),
        Some("Preparing recording…")
    );
    assert_eq!(snapshot.session.intent, Some(SessionStartIntent::RECORD));
    gate.add_permits(1);
    assert_eq!(starting.await.unwrap(), StartOutcome::Started);

    let snapshot = studio.snapshot();
    assert_eq!(snapshot.session.phase, SessionPhase::Recording);
    assert_eq!(snapshot.session.intent, Some(SessionStartIntent::RECORD));
    assert!(!snapshot.session.start_pending);
    assert_eq!(
        drain(&mut effects),
        [SessionEffect::SessionStarted {
            session_id: Some("s1".to_string())
        }]
    );
    {
        let script = backend.script.lock().unwrap();
        let params = &script.started_with[0];
        assert!(params.sources.test_pattern);
        assert!(params.output.record_enabled && !params.output.stream_enabled);
        assert!(params.streaming.is_none());
    }
    // A second Record while recording does nothing.
    assert_eq!(studio.start_recording().await, StartOutcome::Busy);
    assert_eq!(backend.count("session.start"), 1);

    // A recording stops at once.
    assert_eq!(
        studio.request_stop(StopOrigin::Button).await,
        StopOutcome::Stopped(true)
    );
    assert_eq!(studio.snapshot().session.phase, SessionPhase::Stopping);
    assert_eq!(backend.count("session.stop"), 1);
    // The backend finishes: Idle with the file.
    let mut saved = status(RecordingState::Idle, Some("s1"));
    saved.output_path = Some("/tmp/profile/recordings/take.mkv".to_string());
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(saved)))
        .await;
    assert_eq!(studio.snapshot().session.phase, SessionPhase::Idle);
    assert_eq!(
        drain(&mut effects),
        [
            SessionEffect::SessionEnded,
            SessionEffect::SessionFinished {
                session_id: Some("s1".to_string()),
                activity: SessionActivity::Recording
            },
            SessionEffect::RecordingSaved {
                session_id: Some("s1".to_string()),
                output_path: Some("/tmp/profile/recordings/take.mkv".to_string())
            }
        ]
    );
    // Stop while idle: nothing to do, and no request.
    assert_eq!(
        studio.request_stop(StopOrigin::Button).await,
        StopOutcome::Stopped(true)
    );
    assert_eq!(backend.count("session.stop"), 1);
}

#[tokio::test]
async fn a_second_stop_while_one_runs_gets_its_answer() {
    // `stopSessionInFlightPromiseRef`: the second Stop joins the first, so a
    // failed stop is not followed by a fresh `session.stop` nobody clicked.
    let backend = Scripted::new();
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| {
        script.stop_gate = Some(gate.clone());
        script.stop_answers.push_back(Err(RpcError::new(
            "session.stop",
            "session-stop-failed",
            "The recorder did not answer.",
        )));
    });
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    studio.set_test_pattern(true).await.unwrap();
    assert_eq!(studio.start_recording().await, StartOutcome::Started);

    let (first, second, ()) = tokio::join!(studio.stop(), studio.stop(), async {
        for _ in 0..100 {
            if backend.count("session.stop") == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
        gate.add_permits(1);
    });
    assert_eq!((first, second), (false, false));
    assert_eq!(backend.count("session.stop"), 1);
    assert_eq!(studio.snapshot().session.phase, SessionPhase::Recording);

    // Once it ended, the next Stop is a stop of its own.
    gate.add_permits(1);
    assert!(studio.stop().await);
    assert_eq!(backend.count("session.stop"), 2);
}

#[tokio::test]
async fn a_rejected_start_reports_the_reason_and_retry_runs_the_same_start() {
    let backend = Scripted::new();
    backend.with(|script| {
        script.start_answers.push_back(Err(RpcError::new(
            "session.start",
            "session-start-failed",
            "No video source is selected.",
        )));
    });
    let studio = new_studio(&backend);
    let mut effects = studio.effects();
    studio.handle_event(ready()).await;

    assert_eq!(
        studio.start_recording().await,
        StartOutcome::Refused {
            message: "No video source is selected.".to_string()
        }
    );
    let snapshot = studio.snapshot();
    assert_eq!(snapshot.session.phase, SessionPhase::Idle);
    assert_eq!(
        snapshot.session.status.message.as_deref(),
        Some(READY_TO_START_MESSAGE)
    );
    assert!(!snapshot.session.start_pending);
    assert_eq!(snapshot.session.intent, None);
    let failure = snapshot.session.start_failure.expect("the failure line");
    assert_eq!(failure.message, "No video source is selected.");
    assert_eq!(failure.kind, SessionStartFailureKind::Record);
    assert_eq!(
        snapshot.last_error.as_deref(),
        Some("No video source is selected.")
    );
    assert!(matches!(
        &drain(&mut effects)[..],
        [SessionEffect::StartFailed(failed)] if failed.message == "No video source is selected."
    ));

    // Retry: the exact start, and it works this time.
    assert_eq!(studio.retry_start().await, StartOutcome::Started);
    assert_eq!(backend.count("session.start"), 2);
    let snapshot = studio.snapshot();
    assert_eq!(snapshot.session.phase, SessionPhase::Recording);
    assert_eq!(
        snapshot.session.start_failure, None,
        "the attempt clears it"
    );

    // The backend's own refusal: an Idle answer with a message, no failure
    // line (the status says it).
    let backend = Scripted::new();
    backend.with(|script| {
        let mut rejected = status(RecordingState::Idle, Some("s2"));
        rejected.message = Some("Could not start: the recordings folder is read-only.".to_string());
        script.start_answers.push_back(Ok(rejected));
    });
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    assert_eq!(
        studio.start_recording().await,
        StartOutcome::Refused {
            message: "Could not start: the recordings folder is read-only.".to_string()
        }
    );
    let snapshot = studio.snapshot();
    assert_eq!(snapshot.session.phase, SessionPhase::Idle);
    assert_eq!(snapshot.session.start_failure, None);
    assert_eq!(
        snapshot.session.status.message.as_deref(),
        Some("Could not start: the recordings folder is read-only.")
    );
}

#[tokio::test]
async fn go_live_asks_before_stopping_and_the_quit_answer_carries_the_exit() {
    let backend = Scripted::new();
    backend.with(|script| {
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(capture_config_with_twitch().to_string()),
        );
        script.start_answers.push_back(Ok(live("s3")));
        script
            .stop_answers
            .push_back(Ok(status(RecordingState::Idle, Some("s3"))));
    });
    let studio = new_studio(&backend);
    let mut effects = studio.effects();
    studio.handle_event(ready()).await;

    // Go Live records too: "Save local recording" is on.
    assert_eq!(studio.start_livestream(None).await, StartOutcome::Started);
    let snapshot = studio.snapshot();
    assert_eq!(snapshot.session.phase, SessionPhase::Live);
    assert_eq!(snapshot.session.activity, SessionActivity::RecordAndStream);
    assert_eq!(
        snapshot.session.intent,
        Some(SessionStartIntent::livestream(true))
    );
    assert_eq!(
        drain(&mut effects),
        [
            SessionEffect::SessionStarted {
                session_id: Some("s3".to_string())
            },
            SessionEffect::WentLive
        ]
    );
    {
        let script = backend.script.lock().unwrap();
        let params = &script.started_with[0];
        assert!(params.output.record_enabled && params.output.stream_enabled);
        // S3.0d: the saved destinations as the renderer loads them: every
        // built-in card, Twitch the one enabled.
        let streaming = params.streaming.as_ref().expect("streaming");
        assert_eq!(streaming.targets.len(), 9);
        let enabled: Vec<&str> = streaming
            .targets
            .iter()
            .filter(|target| target.enabled)
            .map(|target| target.id.as_str())
            .collect();
        assert_eq!(enabled, ["twitch"]);
    }

    // The button asks; Keep streaming keeps it.
    let outcome = studio.request_stop(StopOrigin::Button).await;
    let StopOutcome::Confirm(confirmation) = outcome else {
        panic!("{outcome:?}");
    };
    assert_eq!(confirmation.platforms, ["Twitch"]);
    assert!(confirmation.also_records);
    assert_eq!(confirmation.session_id.as_deref(), Some("s3"));
    assert_eq!(
        studio.snapshot().session.stop_confirmation.as_ref(),
        Some(&confirmation)
    );
    assert_eq!(backend.count("session.stop"), 0);
    studio.cancel_stop();
    assert_eq!(studio.snapshot().session.stop_confirmation, None);
    assert_eq!(studio.snapshot().session.phase, SessionPhase::Live);

    // Nothing to confirm: no stop.
    assert_eq!(studio.confirm_stop().await, (false, None));
    assert_eq!(backend.count("session.stop"), 0);

    // The hotkey arms, then stops on the second press.
    assert_eq!(
        studio.request_stop(StopOrigin::GlobalHotkey).await,
        StopOutcome::Armed
    );
    assert_eq!(backend.count("session.stop"), 0);

    // Quitting asks too; the answer ends the livestream and says "quit".
    let outcome = studio.request_stop(StopOrigin::Quit).await;
    assert!(matches!(outcome, StopOutcome::Confirm(_)));
    assert_eq!(studio.confirm_stop().await, (true, Some(StopExit::Quit)));
    assert_eq!(backend.count("session.stop"), 1);
    let snapshot = studio.snapshot();
    assert_eq!(snapshot.session.phase, SessionPhase::Idle);
    assert_eq!(snapshot.session.stop_confirmation, None);
    assert_eq!(snapshot.session.intent, None);
    assert_eq!(
        drain(&mut effects),
        [
            SessionEffect::SessionEnded,
            SessionEffect::SessionFinished {
                session_id: Some("s3".to_string()),
                activity: SessionActivity::RecordAndStream
            },
            SessionEffect::RecordingSaved {
                session_id: Some("s3".to_string()),
                output_path: None
            }
        ]
    );

    // Without a destination, Go Live is refused before any request, in the
    // start-blocking table's words (S3.1a: `START_BLOCKED_COPY.noDestination`).
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let outcome = studio.start_livestream(None).await;
    assert_eq!(
        outcome,
        StartOutcome::Refused {
            message: "Turn on a destination in Destinations before you go live.".to_string()
        }
    );
    assert_eq!(backend.count("session.start"), 0);
    assert!(studio.snapshot().session.start_failure.is_some());
}

#[tokio::test]
async fn a_session_that_dies_raises_one_notice_and_a_reconnect_recovers_it() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    let mut effects = studio.effects();
    studio.handle_event(ready()).await;
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    drain(&mut effects);

    let mut died = status(RecordingState::Failed, Some("s1"));
    died.message = Some("The encoder quit.".to_string());
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(died.clone())))
        .await;
    let snapshot = studio.snapshot();
    assert_eq!(snapshot.session.phase, SessionPhase::Failed);
    let notice = snapshot.session.notice.expect("the notice");
    assert_eq!(notice.message, "The encoder quit.");
    assert_eq!(notice.title(), "Recording stopped unexpectedly");
    assert_eq!(notice.session_id.as_deref(), Some("s1"));
    assert!(matches!(
        &drain(&mut effects)[..],
        [
            SessionEffect::SessionEnded,
            SessionEffect::RecordingFailed(_)
        ]
    ));
    // The backend repeats it: one notice, nothing ended again.
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(died.clone())))
        .await;
    assert!(drain(&mut effects).is_empty());
    studio.dismiss_notice();
    assert_eq!(studio.snapshot().session.notice, None);

    // The Studio was away while the next session died: the bootstrap's
    // status says failed, and the notice comes from the recovery.
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(live("s4"))))
        .await;
    studio
        .handle_event(BackendEvent::ConnectionClosed {
            reason: "the backend restarted".to_string(),
        })
        .await;
    backend.with(|script| {
        script
            .status_answers
            .push_back(status(RecordingState::Failed, Some("s4")));
    });
    drain(&mut effects);
    studio.handle_event(ready()).await;
    let snapshot = studio.snapshot();
    assert!(snapshot.bootstrapped);
    assert_eq!(snapshot.session.phase, SessionPhase::Failed);
    let notice = snapshot.session.notice.expect("the recovered notice");
    assert_eq!(notice.session_id.as_deref(), Some("s4"));
    assert_eq!(notice.activity, SessionActivity::RecordAndStream);
    assert_eq!(notice.title(), "Livestream stopped unexpectedly");
    assert_eq!(notice.message, "Videorc couldn't finish this livestream.");
    assert!(matches!(
        &drain(&mut effects)[..],
        [
            SessionEffect::SessionEnded,
            SessionEffect::RecordingFailed(_)
        ]
    ));
}

#[tokio::test]
async fn health_devices_lag_and_finalization_events_land_in_the_snapshot() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(status(
            RecordingState::Stopping,
            Some("s1"),
        ))))
        .await;
    assert!(!studio.snapshot().session.stop_overrun);
    studio
        .handle_event(BackendEvent::HealthEvent(Box::new(HealthEvent {
            id: "h1".to_string(),
            session_id: Some("s1".to_string()),
            level: HealthLevel::Warn,
            code: "recording-stop-finalize-overrun".to_string(),
            message: "Still finishing.".to_string(),
            permission_pane: None,
            created_at: String::new(),
        })))
        .await;
    let snapshot = studio.snapshot();
    assert!(snapshot.session.stop_overrun, "Force stop is explained");
    assert_eq!(snapshot.health.tone(), HealthTone::Warning);
    assert_eq!(snapshot.health.events.len(), 1);

    studio
        .handle_event(BackendEvent::DevicesChanged(Box::new(devices(&[
            "camera:1", "camera:2",
        ]))))
        .await;
    assert_eq!(studio.snapshot().sources.devices.devices.len(), 2);

    // A lag reads the state again.
    let before = backend.count("recording.status");
    studio
        .handle_event(BackendEvent::ClientLagged { skipped: 3 })
        .await;
    assert_eq!(backend.count("recording.status"), before + 1);
    assert_eq!(studio.snapshot().session.phase, SessionPhase::Idle);
    assert!(!studio.snapshot().session.stop_overrun);

    studio
        .handle_event(BackendEvent::RecordingFinalization(Box::new(
            serde_json::from_value(json!({
                "sessionId": "s1", "state": "finalized", "mp4Path": "/tmp/take.mp4",
                "updatedAt": "2026-11-08T00:00:00Z"
            }))
            .unwrap(),
        )))
        .await;
    assert_eq!(
        studio
            .snapshot()
            .session
            .finalization
            .and_then(|event| event.mp4_path),
        Some("/tmp/take.mp4".to_string())
    );
}

#[tokio::test]
async fn settings_write_through_skip_their_own_echo_and_a_failed_send_waits() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let revision = studio.snapshot().settings.revision;

    let mut settings = studio.snapshot().settings.studio;
    settings.set("keepOriginalRecording", json!(true));
    settings.set("globalShortcuts", json!({"record": "F9"}));
    studio.set_studio_settings(&settings).await.unwrap();
    let snapshot = studio.snapshot();
    assert!(snapshot.settings.studio.keep_original_recording());
    assert_eq!(snapshot.settings.revision, revision + 1);
    assert_eq!(snapshot.settings.studio.global_shortcuts()["record"], "F9");
    {
        let script = backend.script.lock().unwrap();
        let stored = script.settings[keys::SETTINGS].as_str().expect("JSON text");
        assert!(stored.contains("\"keepOriginalRecording\":true"));
        assert!(stored.contains("\"globalShortcuts\""));
    }

    // The store echoes this window's batch: nothing changes.
    studio
        .handle_event(BackendEvent::Untyped {
            event: UI_SETTINGS_CHANGED_EVENT.to_string(),
            payload: serde_json::to_value(UiSettingsChange {
                revision: revision + 1,
                put: BTreeMap::from([(
                    keys::SETTINGS.to_string(),
                    Value::String(r#"{"keepOriginalRecording":false}"#.to_string()),
                )]),
                delete: Vec::new(),
                writer: Some(WRITER.to_string()),
            })
            .unwrap(),
        })
        .await;
    assert!(studio.snapshot().settings.studio.keep_original_recording());

    // Another window writes the theme (a plain word, as next-themes keeps
    // it): applied.
    studio
        .handle_event(BackendEvent::Untyped {
            event: UI_SETTINGS_CHANGED_EVENT.to_string(),
            payload: serde_json::to_value(UiSettingsChange {
                revision: revision + 2,
                put: BTreeMap::from([(keys::THEME.to_string(), json!("dark"))]),
                delete: Vec::new(),
                writer: Some("other-window".to_string()),
            })
            .unwrap(),
        })
        .await;
    let snapshot = studio.snapshot();
    assert_eq!(snapshot.settings.theme.as_deref(), Some("dark"));
    assert_eq!(snapshot.settings.revision, revision + 2);

    // S3.0d: a send that fails keeps the write (as the renderer's store
    // does), names the error and waits for the retry.
    backend.with(|script| script.settings_set_fails = true);
    let error = studio
        .write_settings(vec![families::write_theme("light")])
        .await
        .expect_err("the send failed");
    assert_eq!(error.code, "ui-settings-too-large");
    assert!(settings_write_kept(&error));
    let snapshot = studio.snapshot();
    assert_eq!(snapshot.settings.theme.as_deref(), Some("light"));
    assert_eq!(snapshot.settings.pending, [keys::THEME]);
    assert_eq!(
        snapshot.last_error.as_deref(),
        Some("That setting is too large to store.")
    );
    assert!(studio.settings_retry_due().is_some());
    backend.with(|script| script.settings_set_fails = false);
    studio.retry_settings().await;
    assert!(studio.snapshot().settings.pending.is_empty());
    assert_eq!(
        backend.script.lock().unwrap().settings[keys::THEME],
        json!("light")
    );
    studio.delete_setting(keys::THEME).await.unwrap();
    assert_eq!(studio.snapshot().settings.theme, None);
    assert_eq!(studio.setting(keys::THEME), None);
}

// --- S2.6c: Hide from stream through the backend's capture filter ---

/// A display capture at 1280x720, as the Sources page saves it.
fn capture_config_with_display() -> Value {
    json!({
        "sources": {"screenId": "screen:screencapturekit:1"},
        "video": {"preset": "custom", "width": 1280, "height": 720, "fps": 30, "bitrateKbps": 6000},
        "recordEnabled": true
    })
}

#[tokio::test]
async fn a_hidden_window_reaches_the_capture_before_the_first_frame_and_in_place_after() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    studio
        .put_setting(keys::CAPTURE_CONFIG, &capture_config_with_display())
        .await
        .unwrap();

    // Idle: the list is kept, nothing is sent (no capture runs to change).
    studio
        .set_protected_overlay_window_ids(vec![41, 40, 41, 0])
        .await;
    assert_eq!(backend.count("preview.screen.start"), 0);
    assert_eq!(studio.snapshot().capture_exclusion.wanted, vec![40, 41]);

    // Record: the capture starts with the list, then the session.
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    let calls = backend.calls();
    let screen = calls
        .iter()
        .position(|call| call == "preview.screen.start")
        .expect("the capture starts first");
    let session = calls
        .iter()
        .position(|call| call == "session.start")
        .unwrap();
    assert!(screen < session, "{calls:?}");
    {
        let script = backend.script.lock().unwrap();
        let first = &script.screen_starts[0];
        assert_eq!(first.protected_overlay_window_ids, vec![40, 41]);
        assert_eq!(
            first.sources.screen_id.as_deref(),
            Some("screen:screencapturekit:1")
        );
        assert_eq!(first.video.width, 1280);
        assert_eq!(first.sources, script.started_with[0].sources);
        assert_eq!(first.video, script.started_with[0].output.video);
    }
    let last = studio.snapshot().capture_exclusion.last.expect("an answer");
    assert_eq!(last.reason, "session-start");
    assert_eq!(last.screen_state, Some(PreviewScreenState::Live));

    // The same list again: nothing to send.
    studio.set_protected_overlay_window_ids(vec![40, 41]).await;
    assert_eq!(backend.count("preview.screen.start"), 1);

    // A window shown again mid-session: the running capture takes the new
    // list, with the session's own source and video.
    studio.set_protected_overlay_window_ids(vec![40]).await;
    assert_eq!(backend.count("preview.screen.start"), 2);
    {
        let script = backend.script.lock().unwrap();
        let second = &script.screen_starts[1];
        assert_eq!(second.protected_overlay_window_ids, vec![40]);
        assert_eq!(second.sources, script.screen_starts[0].sources);
        assert_eq!(second.video, script.screen_starts[0].video);
    }
    let last = studio.snapshot().capture_exclusion.last.expect("an answer");
    assert_eq!(last.reason, "in-session");
    assert!(
        last.message
            .as_deref()
            .is_some_and(|message| message.contains("applied to the running capture")),
        "{last:?}"
    );

    // Stopping and idle: nothing is sent; the next start carries the list.
    studio.request_stop(StopOrigin::Button).await;
    studio.set_protected_overlay_window_ids(Vec::new()).await;
    assert_eq!(backend.count("preview.screen.start"), 2);
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(status(
            RecordingState::Idle,
            Some("s1"),
        ))))
        .await;
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    assert_eq!(backend.count("preview.screen.start"), 3);
    let script = backend.script.lock().unwrap();
    assert!(
        script.screen_starts[2]
            .protected_overlay_window_ids
            .is_empty()
    );
}

#[tokio::test]
async fn a_screen_session_always_starts_its_capture_first_and_the_test_pattern_never() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;

    // An empty list too: the backend refuses a session on a screen that
    // produced no frames, so the capture starts first, as the renderer's
    // screen preview does.
    studio
        .put_setting(keys::CAPTURE_CONFIG, &capture_config_with_display())
        .await
        .unwrap();
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    assert_eq!(backend.count("preview.screen.start"), 1);
    assert!(
        backend.script.lock().unwrap().screen_starts[0]
            .protected_overlay_window_ids
            .is_empty()
    );
    studio.request_stop(StopOrigin::Button).await;
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(status(
            RecordingState::Idle,
            Some("s1"),
        ))))
        .await;

    // The test pattern: no screen capture, so no list to apply, even with a
    // hidden window, and none mid-session.
    studio.set_test_pattern(true).await.unwrap();
    studio.set_protected_overlay_window_ids(vec![40]).await;
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    studio.set_protected_overlay_window_ids(vec![40, 41]).await;
    assert_eq!(backend.count("preview.screen.start"), 1);
}

#[tokio::test]
async fn a_failed_list_is_reported_and_sent_again_at_the_next_start() {
    let backend = Scripted::new();
    backend.with(|script| script.screen_start_fails = true);
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    studio
        .put_setting(keys::CAPTURE_CONFIG, &capture_config_with_display())
        .await
        .unwrap();
    studio.set_protected_overlay_window_ids(vec![40]).await;
    // The session still starts (it starts its own capture); the failure is
    // named, never silent.
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    let last = studio.snapshot().capture_exclusion.last.expect("an answer");
    assert_eq!(last.screen_state, None);
    assert_eq!(
        last.message.as_deref(),
        Some("The screen capture could not start.")
    );
    studio.request_stop(StopOrigin::Button).await;
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(status(
            RecordingState::Idle,
            Some("s1"),
        ))))
        .await;
    backend.with(|script| script.screen_start_fails = false);
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    assert_eq!(backend.count("preview.screen.start"), 2);
    // A restarted backend (a new pid) holds no list: it is sent again.
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(status(
            RecordingState::Idle,
            Some("s1"),
        ))))
        .await;
    studio
        .handle_event(BackendEvent::Ready(BackendConnection {
            host: "127.0.0.1".to_string(),
            port: 1,
            token: "t".to_string(),
            pid: 43,
            parent_pid: None,
        }))
        .await;
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    assert_eq!(backend.count("preview.screen.start"), 3);
}

/// Plan 220 S3.1a: a second caller asking for the start already on its way
/// hears that start's answer (`sessionStartInFlightRef`), one request goes
/// out, and the click's time is the request's `requestedAtMs`; the status
/// that completes the start closes the click-to-status sample.
#[tokio::test]
async fn a_second_record_joins_the_start_in_flight_and_the_click_is_timed() {
    use videorc_app_core::studio::LatencyKind;
    let backend = Scripted::new();
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| script.start_gate = Some(gate.clone()));
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    studio.set_test_pattern(true).await.unwrap();

    let clicked_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    studio.note_record_click(LatencyKind::Start);
    let first = tokio::spawn({
        let studio = studio.clone();
        async move { studio.start_recording().await }
    });
    for _ in 0..100 {
        if studio.snapshot().session.start_pending {
            break;
        }
        tokio::task::yield_now().await;
    }
    let second = tokio::spawn({
        let studio = studio.clone();
        async move { studio.start_recording().await }
    });
    // Another start (Go Live) while Record's is on its way is busy at once.
    assert_eq!(studio.start_livestream(None).await, StartOutcome::Busy);
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    gate.add_permits(1);
    assert_eq!(first.await.unwrap(), StartOutcome::Started);
    assert_eq!(
        second.await.unwrap(),
        StartOutcome::Started,
        "the second caller heard the same answer"
    );
    assert_eq!(backend.count("session.start"), 1, "one request");
    let requested = backend.script.lock().unwrap().started_with[0]
        .requested_at_ms
        .expect("the request carries the click's time");
    assert!(
        requested >= clicked_ms && requested < clicked_ms + 1_000,
        "{requested} vs the click at {clicked_ms}"
    );
    let latency = studio.snapshot().record_latency;
    let sample = latency.start.expect("the start closed a sample");
    assert_eq!(sample.session_id.as_deref(), Some("s1"));
    assert!(latency.stop.is_none());
}

// --- S3.5c: Go Live through its dialog ----------------------------------

/// The accounts' announcement never validates them again: a validation
/// re-announces them, so that loop spent YouTube's quota on `channels.list`
/// (the youtube-quota smoke saw 16,000 calls in a minute).
#[tokio::test]
async fn an_accounts_announcement_never_validates_them_again() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let validations = |backend: &Scripted| {
        backend
            .script
            .lock()
            .unwrap()
            .livestream_calls
            .iter()
            .filter(|(method, _)| method == "platformAccounts.validate")
            .count()
    };
    let before = validations(&backend);
    for _ in 0..3 {
        studio
            .handle_event(BackendEvent::Untyped {
                event: "platformAccounts.changed".to_string(),
                payload: json!([]),
            })
            .await;
    }
    assert_eq!(validations(&backend), before);
}

// --- S1.6b part 3: the Studio's scenes on plan 231's library ---

/// One of Electron's scene migration fixtures (a profile's stored keys).
fn scene_fixture(name: &str) -> Value {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/src/renderer/src/lib/__fixtures__/scenes")
        .join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

/// The store seeded with a fixture's keys, each as the JSON text the
/// renderer's `localStorage` held.
fn seed_fixture(backend: &Scripted, fixture: &Value) {
    backend.with(|script| {
        for (key, value) in fixture.as_object().unwrap() {
            script
                .settings
                .insert(key.clone(), Value::String(value.to_string()));
        }
    });
}

/// A stored key, parsed.
fn stored_json(backend: &Scripted, key: &str) -> Option<Value> {
    let script = backend.script.lock().unwrap();
    let text = script.settings.get(key)?.as_str()?.to_string();
    serde_json::from_str(&text).ok()
}

fn scene_ids(view: &videorc_app_core::studio::scenes::ScenesView) -> Vec<String> {
    view.scenes.iter().map(|scene| scene.id.clone()).collect()
}

#[tokio::test]
async fn a_new_profile_gets_the_default_scenes_on_its_display_stored_once() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    assert!(!studio.snapshot().scenes.loaded);
    studio.handle_event(ready()).await;
    let view = studio.snapshot().scenes;
    assert!(view.loaded);
    assert!(!view.read_only);
    assert_eq!(
        scene_ids(&view),
        [
            "default-screen-camera",
            "default-screen-only",
            "default-camera-only",
            "default-side-by-side"
        ]
    );
    // The capture config's layout (Screen + camera) names the scene on.
    assert_eq!(view.on_stream_id.as_deref(), Some("default-screen-camera"));
    // The device list named the main display for every screen scene.
    let stored = stored_json(&backend, keys::SCENES).expect("the library is stored");
    assert_eq!(stored["version"], 2);
    assert_eq!(stored["onStreamId"], "default-screen-camera");
    assert_eq!(
        stored["scenes"][0]["shows"]["screenId"],
        "screen:screencapturekit:1"
    );
    // D15: the moved keys are in the settings, and the library let them go.
    assert!(stored.get("pendingShortcuts").is_none());
    assert!(
        stored_json(&backend, keys::SETTINGS).unwrap()["globalShortcuts"].is_object(),
        "the settings hold the migrated keys"
    );
    // One launch write; a reconnect reads nothing again.
    assert_eq!(backend.count("ui.settings.set"), 1);
    studio.handle_event(ready()).await;
    assert_eq!(backend.count("ui.settings.set"), 1);
    assert_eq!(studio.snapshot().scenes, view);
}

#[tokio::test]
async fn a_v1_profile_migrates_with_its_layout_keys_moved_to_scene_keys() {
    let backend = Scripted::new();
    seed_fixture(&backend, &scene_fixture("builtin-user-layout-keys"));
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let view = studio.snapshot().scenes;
    assert!(view.loaded);
    assert!(view.error.is_none());
    let stored = stored_json(&backend, keys::SCENES).expect("migrated and stored");
    assert!(stored.get("pendingShortcuts").is_none());
    let settings = stored_json(&backend, keys::SETTINGS).unwrap();
    let shortcuts = &settings["globalShortcuts"];
    // The layout keys became scene keys (which ones stay custom depends on
    // the platform's position keys, checked in `scenes::v2_tests`); the
    // other keys stay.
    assert!(shortcuts.get("layouts").is_none());
    assert!(shortcuts["scenes"].is_object());
    assert_eq!(shortcuts["recordToggle"], "Control+Alt+R");
    assert_eq!(shortcuts["layoutNext"], "Control+Alt+Right");
    // v1 is read, never written.
    assert!(backend.script.lock().unwrap().settings[keys::SCENE_PRESETS].is_string());
    assert_eq!(
        stored_json(&backend, keys::SCENE_PRESETS).unwrap(),
        scene_fixture("builtin-user-layout-keys")["videorc.scene-presets.v1"]
    );
}

#[tokio::test]
async fn a_library_from_0_34_is_repaired_and_its_working_scene_goes_on() {
    let backend = Scripted::new();
    let fixture = scene_fixture("v2-vertical-camera-only");
    seed_fixture(&backend, &fixture);
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let stored = stored_json(&backend, keys::SCENES).unwrap();
    assert_eq!(stored["verticalLayoutsRepaired"], true);
    let snapshot = studio.snapshot();
    // The working setup laid over the capture config: a 9:16 studio on
    // Camera only, which the library names.
    assert_eq!(
        snapshot.settings.capture_doc["layout"]["layoutPreset"],
        "vertical-camera-only"
    );
    assert_eq!(
        snapshot.scenes.on_stream_id.as_deref(),
        Some("default-camera-only")
    );
    // Listed in the studio's orientation.
    let listed = snapshot
        .scenes
        .scenes
        .iter()
        .find(|scene| scene.id == "default-camera-only")
        .unwrap();
    assert_eq!(
        listed.visual["layout"]["layoutPreset"],
        "vertical-camera-only"
    );
}

#[tokio::test]
async fn a_library_from_a_newer_videorc_is_never_written() {
    let backend = Scripted::new();
    let fixture = scene_fixture("unknown-version");
    seed_fixture(&backend, &fixture);
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let view = studio.snapshot().scenes;
    assert!(view.read_only);
    assert!(view.error.is_some());
    assert!(!view.scenes.is_empty());
    assert_eq!(
        stored_json(&backend, keys::SCENES).unwrap(),
        fixture[keys::SCENES]
    );
    let id = view.scenes[0].id.clone();
    assert!(!studio.move_scene(&id, 1).await);
    assert!(!studio.rename_scene(&id, "Talk").await);
    assert_eq!(
        stored_json(&backend, keys::SCENES).unwrap(),
        fixture[keys::SCENES]
    );
}

#[tokio::test]
async fn the_main_display_is_named_when_the_device_list_first_has_one() {
    let backend = Scripted::new();
    backend.with(|script| script.device_ids = Some(vec!["camera:1".to_string()]));
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let stored = stored_json(&backend, keys::SCENES).unwrap();
    // The main display, not named yet.
    assert_eq!(stored["scenes"][0]["shows"]["screenId"], "");
    let writes = backend.count("ui.settings.set");

    studio
        .handle_event(BackendEvent::DevicesChanged(Box::new(devices(&[
            "camera:1",
            "screen:screencapturekit:2",
        ]))))
        .await;
    let stored = stored_json(&backend, keys::SCENES).unwrap();
    assert_eq!(
        stored["scenes"][0]["shows"]["screenId"],
        "screen:screencapturekit:2"
    );
    assert_eq!(backend.count("ui.settings.set"), writes + 1);
    // Named once: another list changes nothing.
    studio
        .handle_event(BackendEvent::DevicesChanged(Box::new(devices(&[
            "camera:1",
            "screen:screencapturekit:3",
        ]))))
        .await;
    assert_eq!(backend.count("ui.settings.set"), writes + 1);
}

#[tokio::test]
async fn the_library_edits_write_the_whole_library_and_a_taken_name_is_said() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    let mut notices = studio.notices();
    studio.handle_event(ready()).await;

    assert!(studio.move_scene("default-side-by-side", 0).await);
    let stored = stored_json(&backend, keys::SCENES).unwrap();
    assert_eq!(stored["scenes"][0]["id"], "default-side-by-side");
    assert_eq!(
        scene_ids(&studio.snapshot().scenes)[0],
        "default-side-by-side"
    );

    assert!(studio.rename_scene("default-camera-only", "  Talk ").await);
    let library = studio.snapshot().scenes.library.unwrap();
    let talk = library
        .scenes
        .iter()
        .find(|scene| scene.id == "default-camera-only")
        .unwrap();
    assert_eq!(talk.name, "Talk");

    assert!(
        !studio
            .rename_scene("default-camera-only", "screen only")
            .await
    );
    let said: Vec<String> = std::iter::from_fn(|| notices.try_recv().ok())
        .filter_map(|command| command.notice().map(|notice| notice.title.clone()))
        .collect();
    assert_eq!(said, ["A scene with this name already exists."]);

    // D2: a Screen pick writes the scene's screen.
    let shows = videorc_app_core::scenes::v2::SceneShows::TestPattern;
    assert!(
        studio
            .set_scene_shows("default-screen-only", shows.clone())
            .await
    );
    assert!(!studio.set_scene_shows("default-screen-only", shows).await);
    let stored = stored_json(&backend, keys::SCENES).unwrap();
    let screen_only = stored["scenes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|scene| scene["id"] == "default-screen-only")
        .unwrap()
        .clone();
    assert_eq!(screen_only["shows"]["kind"], "test-pattern");

    // Duplicate: after its original.
    let mut copy = studio
        .snapshot()
        .scenes
        .library
        .unwrap()
        .scenes
        .iter()
        .find(|scene| scene.id == "default-screen-camera")
        .unwrap()
        .clone();
    copy.id = "copy".to_string();
    copy.name = "Screen + camera 2".to_string();
    assert!(
        studio
            .insert_scenes(std::slice::from_ref(&copy), Some("default-screen-camera"))
            .await
    );
    let ids = scene_ids(&studio.snapshot().scenes);
    let original = ids
        .iter()
        .position(|id| id == "default-screen-camera")
        .unwrap();
    assert_eq!(ids[original + 1], "copy");
}
