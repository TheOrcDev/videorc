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
use videorc_app_core::studio::inspector::StartGates;
use videorc_app_core::studio::session::READY_TO_START_MESSAGE;
use videorc_app_core::studio::transport::{RecordButtonState, TransportView};
use videorc_app_core::studio::{
    Connection, HealthTone, SessionActivity, SessionEffect, SessionPhase, SessionStartFailureKind,
    SessionStartIntent, StartOutcome, StopExit, StopOrigin, StopOutcome, Studio, StudioBackend,
    StudioConfig, families, keys, settings_write_kept,
};
use videorc_protocol::ui_settings::{
    UI_SETTINGS_CHANGED_EVENT, UiSettingsChange, UiSettingsGetParams, UiSettingsSetParams,
    UiSettingsSnapshot,
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
    /// Idle Camera picks start the picked camera, or stop it for Off.
    camera_requests: Vec<(String, Value)>,
    /// S3.5c: the livestream RPCs' answers by method (one each, in order;
    /// a method with none left is not connected), and every call made.
    livestream: BTreeMap<String, VecDeque<Result<Value, RpcError>>>,
    livestream_calls: Vec<(String, Value)>,
    /// S1.6b: the device ids `devices.list` answers (the default: a camera
    /// and a display).
    device_ids: Option<Vec<String>>,
    /// S1.6b part 3b: every scene commit (`scene.layout.apply_*`), with its
    /// params, and the revision the backend's scene is on.
    layout_commits: Vec<(String, Value)>,
    scene_revision: u64,
    /// S1.6b part 3c: `scene.layout.apply_*` waits for a permit here when
    /// set.
    apply_gate: Option<Arc<Semaphore>>,
    /// The next commits fail with this error; `true` lands the scene anyway
    /// (an answer lost on its way back).
    apply_failures: VecDeque<(RpcError, bool)>,
    /// `scene.get`'s answer as raw JSON (none: not answered), and the layout
    /// `compositor.status` says it draws.
    scene_get: Option<Value>,
    backend_layout: Option<Value>,
    /// S1.6b part 5d: how `audio.processing.update` answers, in order
    /// (`None` applies the request, `Some(reason)` refuses it; none left:
    /// not connected), every request it got, and a gate it waits at (after
    /// the request is recorded) when set.
    audio_answers: VecDeque<Option<&'static str>>,
    audio_updates: Vec<AudioProcessingUpdateParams>,
    audio_gate: Option<Arc<Semaphore>>,
    /// S1.6a part 6c: `replay.status`'s answer (none: not answered, so the
    /// Clips ring is never armed, as in every test before it), and every
    /// Clips request made.
    replay_status: Option<Value>,
    clips_calls: Vec<(String, Value)>,
    /// S1.6b part 5e: the ScreenCaptureKit windows `devices.list` lists
    /// after the other devices (id, name); `sources.resolve_app_window`'s
    /// answer (none: not connected) and every request it got; and
    /// `scene.load_from_capture_config`'s answer (none: not connected, as
    /// before part 5e) and every request it got.
    windows: Vec<(String, String)>,
    app_window: Option<Value>,
    resolver_calls: Vec<Value>,
    scene_load: Option<Value>,
    scene_loads: Vec<Value>,
    /// A livestream RPC waits for a permit here when set.
    livestream_gate: Option<Arc<Semaphore>>,
    /// One livestream method waits for a permit here; the rest answer.
    livestream_held: Option<(String, Arc<Semaphore>)>,
    /// A gated livestream RPC is waiting.
    held_reached: bool,
    /// Plan 184 C5b: every `cloud.show.resume` and how it answers (none
    /// left: the show's session, live).
    resumed_with: Vec<StartSessionParams>,
    resume_answers: VecDeque<Result<RecordingStatus, RpcError>>,
    /// S1.6b part 4c-2: every send to the vertical stream's leg
    /// (`scene.layout.apply_live` with `simulcastLeg`). The backend commits
    /// it to the leg only: the program's scene and revision stay.
    leg_sends: Vec<Value>,
    /// Every remote surface published, and every remote intent's ack.
    remote_surfaces: Vec<Value>,
    remote_acks: Vec<RemoteIntentAckParams>,
    /// What a remote's keys ask of the backend: `banners.list`'s answer
    /// (none: not connected) and the refusal `banners.show` answers with;
    /// the takeovers `screens.list` names; `sounds.list`'s sound ids (none:
    /// not connected); whether the screen is hidden; and every banner,
    /// takeover, sound and Hide screen request, with its params.
    banners: Option<Value>,
    banner_show_refusal: Option<String>,
    takeovers: Vec<String>,
    sound_ids: Option<Vec<String>>,
    screen_hidden: bool,
    remote_requests: Vec<(String, Value)>,
    /// Sidekick's settings (`cohost.settings.get`; none: not connected; a
    /// save merges its patch) and the plan (`entitlements.get`; none: not
    /// connected).
    cohost: Option<Value>,
    entitlements: Option<Value>,
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
    async fn sources_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<Value, RpcError> {
        self.note(method);
        let mut script = self.script.lock().unwrap();
        match method {
            "preview.camera.start" | "preview.camera.stop" => {
                let status = json!({
                    "state": if method.ends_with("start") { "live" } else { "idle" },
                    "cameraId": params["sources"]["cameraId"],
                    "updatedAt": "2026-11-26T00:00:00Z",
                });
                script.camera_requests.push((method.to_string(), params));
                Ok(status)
            }
            _ => Err(RpcError::not_connected(method)),
        }
    }

    async fn health(&self) -> Result<BackendHealth, RpcError> {
        self.note("health.ping");
        Ok(health_ok())
    }

    async fn devices(&self) -> Result<DeviceList, RpcError> {
        self.note("devices.list");
        let (ids, windows) = {
            let script = self.script.lock().unwrap();
            (script.device_ids.clone(), script.windows.clone())
        };
        let mut list = match ids {
            Some(ids) => devices(&ids.iter().map(String::as_str).collect::<Vec<_>>()),
            None => devices(&["camera:1", "screen:screencapturekit:1"]),
        };
        list.devices
            .extend(windows.iter().map(|(id, name)| window_device(id, name)));
        Ok(list)
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

    async fn cloud_show_resume_into(
        &self,
        params: StartSessionParams,
        _folder_capability: Option<String>,
    ) -> Result<RecordingStatus, RpcError> {
        self.note("cloud.show.resume");
        let mut script = self.script.lock().unwrap();
        script.resumed_with.push(params);
        script
            .resume_answers
            .pop_front()
            .unwrap_or_else(|| Ok(live("s-show")))
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

    /// S1.6b part 5d: the live audio sync's update, answered as scripted.
    async fn audio_processing_update(
        &self,
        params: AudioProcessingUpdateParams,
    ) -> Result<AudioProcessingUpdateResult, RpcError> {
        self.note("audio.processing.update");
        let gate = {
            let mut script = self.script.lock().unwrap();
            script.audio_updates.push(params.clone());
            script.audio_gate.clone()
        };
        if let Some(gate) = gate {
            gate.acquire().await.unwrap().forget();
        }
        let answer = self.script.lock().unwrap().audio_answers.pop_front();
        match answer {
            Some(reason) => Ok(AudioProcessingUpdateResult {
                microphone_noise_suppression: params
                    .microphone_noise_suppression
                    .unwrap_or_default(),
                confirmed_microphone_noise_suppression: None,
                applied: reason.is_none(),
                session_id: params.session_id.clone(),
                microphone_gain_db: params.microphone_gain_db,
                microphone_muted: params.microphone_muted,
                reason_code: reason.map(str::to_string),
                confirmed_microphone_gain_db: None,
                confirmed_microphone_muted: None,
            }),
            None => Err(RpcError::not_connected(&format!(
                "audio.processing.update for {}",
                params.session_id
            ))),
        }
    }

    /// No takeover on air (the backend retires one at launch).
    async fn screens_active(&self) -> Result<Option<videorc_protocol::StreamScreen>, RpcError> {
        self.note("screens.active");
        Ok(None)
    }

    /// The scripted takeovers.
    async fn screens_list(&self) -> Result<Vec<videorc_protocol::StreamScreen>, RpcError> {
        self.note("screens.list");
        let ids = self.script.lock().unwrap().takeovers.clone();
        Ok(ids.iter().map(|id| takeover(id)).collect())
    }

    async fn screens_activate(
        &self,
        screen_id: &str,
    ) -> Result<videorc_protocol::StreamScreen, RpcError> {
        self.note("screens.activate");
        self.script.lock().unwrap().remote_requests.push((
            "screens.activate".to_string(),
            json!({ "screenId": screen_id }),
        ));
        Ok(takeover(screen_id))
    }

    async fn screens_clear(&self) -> Result<(), RpcError> {
        self.note("screens.clear");
        self.script
            .lock()
            .unwrap()
            .remote_requests
            .push(("screens.clear".to_string(), Value::Null));
        Ok(())
    }

    /// The scripted board (none: not connected).
    async fn sounds_list(&self) -> Result<videorc_protocol::SoundboardState, RpcError> {
        self.note("sounds.list");
        let ids = self.script.lock().unwrap().sound_ids.clone();
        let Some(ids) = ids else {
            return Err(RpcError::not_connected("sounds.list"));
        };
        let sounds: Vec<Value> = ids
            .iter()
            .map(|id| {
                json!({
                    "id": id, "name": id, "file": format!("{id}.wav"),
                    "durationMs": 1000, "loudnessLufs": -18.0, "levelDb": 0.0,
                    "volumeDb": 0, "mode": "oneShot", "sortOrder": 0,
                    "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"
                })
            })
            .collect();
        Ok(serde_json::from_value(json!({
            "sounds": sounds, "volumeDb": 0, "monitor": true, "startersSeeded": true
        }))
        .expect("a soundboard"))
    }

    async fn sounds_request(&self, method: &'static str, params: Value) -> Result<Value, RpcError> {
        self.note(method);
        self.script
            .lock()
            .unwrap()
            .remote_requests
            .push((method.to_string(), params));
        Ok(Value::Null)
    }

    /// Sidekick's settings and the plan, as scripted; a save is noted with
    /// the remote's requests.
    async fn buddy_request(&self, method: &'static str, params: Value) -> Result<Value, RpcError> {
        self.note(method);
        let mut script = self.script.lock().unwrap();
        match method {
            "cohost.settings.get" => script
                .cohost
                .clone()
                .ok_or_else(|| RpcError::not_connected(method)),
            "cohost.settings.set" => {
                script
                    .remote_requests
                    .push((method.to_string(), params.clone()));
                let Some(settings) = script.cohost.as_mut().and_then(Value::as_object_mut) else {
                    return Err(RpcError::not_connected(method));
                };
                if let Some(patch) = params.as_object() {
                    for (key, value) in patch {
                        settings.insert(key.clone(), value.clone());
                    }
                }
                Ok(Value::Object(settings.clone()))
            }
            "entitlements.get" => script
                .entitlements
                .clone()
                .ok_or_else(|| RpcError::not_connected(method)),
            _ => Err(RpcError::not_connected(method)),
        }
    }

    async fn remote_intent_ack(&self, params: RemoteIntentAckParams) -> Result<(), RpcError> {
        self.note("remote.intent.ack");
        self.script.lock().unwrap().remote_acks.push(params);
        Ok(())
    }

    async fn remote_surface_publish(&self, snapshot: Value) -> Result<(), RpcError> {
        self.note("remote.surface.publish");
        self.script.lock().unwrap().remote_surfaces.push(snapshot);
        Ok(())
    }

    async fn livestream_request(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<Value, RpcError> {
        let gate = {
            let script = self.script.lock().unwrap();
            script.livestream_gate.clone().or_else(|| {
                script
                    .livestream_held
                    .as_ref()
                    .filter(|(held, _)| held == method)
                    .map(|(_, gate)| gate.clone())
            })
        };
        if let Some(gate) = gate {
            self.script.lock().unwrap().held_reached = true;
            gate.acquire().await.unwrap().forget();
        }
        let mut script = self.script.lock().unwrap();
        script.livestream_calls.push((method.to_string(), params));
        script
            .livestream
            .get_mut(method)
            .and_then(VecDeque::pop_front)
            .unwrap_or_else(|| Err(RpcError::not_connected(method)))
    }

    /// S1.6b part 3b: a scene commit answers the committed scene at the next
    /// revision; the live proof's reads say it is drawn and on air.
    async fn scene_request(&self, method: &'static str, params: Value) -> Result<Value, RpcError> {
        let leg = params["simulcastLeg"] == true;
        let applying = !leg
            && matches!(
                method,
                "scene.layout.apply_preview" | "scene.layout.apply_live"
            );
        let gate = self.script.lock().unwrap().apply_gate.clone();
        if let (true, Some(gate)) = (applying, gate) {
            gate.acquire().await.unwrap().forget();
        }
        let mut script = self.script.lock().unwrap();
        match method {
            "scene.layout.apply_live" if leg => {
                script.leg_sends.push(params.clone());
                Ok(json!({
                    "intentId": params["intentId"],
                    "sceneRevision": script.scene_revision,
                }))
            }
            "scene.layout.apply_preview" | "scene.layout.apply_live" => {
                script
                    .layout_commits
                    .push((method.to_string(), params.clone()));
                if let Some((error, landed)) = script.apply_failures.pop_front() {
                    if landed {
                        script.scene_revision += 1;
                        script.backend_layout = Some(params["layout"].clone());
                        script.scene_get = Some(landed_scene(&params));
                    }
                    return Err(error);
                }
                script.scene_revision += 1;
                script.backend_layout = Some(params["layout"].clone());
                Ok(json!({
                    "intentId": params["intentId"],
                    "sceneRevision": script.scene_revision,
                    "scene": serde_json::to_value(scene()).unwrap(),
                    "compositorStatus": {"sceneLayout": params["layout"]},
                }))
            }
            "scene.get" => script
                .scene_get
                .clone()
                .ok_or_else(|| RpcError::not_connected(method)),
            "compositor.status" => Ok(json!({
                "sceneRevision": script.scene_revision,
                "frameSceneRevision": script.scene_revision,
                "sceneLayout": script.backend_layout,
                "sceneId": script.scene_get.as_ref().map(|scene| scene["id"].clone()),
            })),
            "diagnostics.stats" => Ok(json!({"activeSceneRevision": script.scene_revision})),
            "sources.resolve_app_window" => {
                script.resolver_calls.push(params);
                script
                    .app_window
                    .clone()
                    .ok_or_else(|| RpcError::not_connected(method))
            }
            "scene.load_from_capture_config" => {
                script.scene_loads.push(params);
                script
                    .scene_load
                    .clone()
                    .ok_or_else(|| RpcError::not_connected(method))
            }
            // A remote's banner and Hide screen keys.
            "banners.list" => script
                .banners
                .clone()
                .ok_or_else(|| RpcError::not_connected(method)),
            "banners.show" | "banners.hide" => {
                script.remote_requests.push((method.to_string(), params));
                match (method, script.banner_show_refusal.clone()) {
                    ("banners.show", Some(refusal)) => {
                        Err(RpcError::new(method, "banner-refused", refusal))
                    }
                    _ => Ok(json!({})),
                }
            }
            "screen.privacy.get" => Ok(json!({ "hidden": script.screen_hidden, "generation": 1 })),
            "screen.hide" | "screen.show" => {
                script.remote_requests.push((method.to_string(), params));
                script.screen_hidden = method == "screen.hide";
                Ok(json!({ "hidden": script.screen_hidden, "generation": 2 }))
            }
            _ => Err(RpcError::not_connected(method)),
        }
    }

    /// S1.6a part 6c: `replay.status` as scripted; nothing else answers.
    async fn clips_request(&self, method: &'static str, params: Value) -> Result<Value, RpcError> {
        let mut script = self.script.lock().unwrap();
        script.clips_calls.push((method.to_string(), params));
        match method {
            "replay.status" => script
                .replay_status
                .clone()
                .ok_or_else(|| RpcError::not_connected(method)),
            _ => Err(RpcError::not_connected(method)),
        }
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

/// The backend's scene once a commit landed: the sources its layout draws,
/// its recording canvas and background, as `scene.get` answers.
fn landed_scene(params: &Value) -> Value {
    let evidence = videorc_app_core::scenes::transaction_policy::requested_transaction_scene(
        &params["layout"],
        &params["sources"],
        &params["video"],
        params.get("background"),
    );
    let sources: Vec<Value> = evidence["sources"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(index, source)| {
            json!({
                "id": format!("source-{index}"),
                "name": source["kind"],
                "kind": source["kind"],
                "deviceId": source["deviceId"],
                "visible": source["visible"],
            })
        })
        .collect();
    let mut scene = json!({
        "id": "program",
        "name": "Program",
        "sources": sources,
        "outputs": [{
            "kind": "recording",
            "width": params["video"]["width"],
            "height": params["video"]["height"],
            "fps": params["video"]["fps"],
        }],
    });
    if let Some(background) = params.get("background") {
        scene["background"] = background.clone();
    }
    scene
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

/// S1.6b part 5e: an on-screen ScreenCaptureKit window.
fn window_device(id: &str, name: &str) -> Device {
    Device {
        app: None,
        window_title: None,
        display_uuid: None,
        id: id.to_string(),
        name: name.to_string(),
        kind: DeviceKind::Window,
        status: DeviceStatus::Available,
        detail: None,
        width: None,
        height: None,
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
    // with the bootstrap's flush; then plan 258's D4 migration settles (no
    // scene keys, so it stores only its version).
    assert_eq!(after.settings.revision, 11);
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
            "ui.settings.set",
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

/// The transport as the Studio tab draws it, with no start gates.
fn transport(studio: &Studio<Scripted>) -> TransportView {
    TransportView::from_snapshot(&studio.snapshot(), &StartGates::default(), false)
}

#[tokio::test]
async fn a_stop_during_a_record_start_reads_stopping_at_once_then_stops_it() {
    // Owner decision Q156 (Electron parity): during a Record start, Record's
    // place holds an enabled "Stop recording". Pressed, it reads "Stopping…"
    // at once (`setStopRequestPending(true)`), waits for the start
    // (`sessionStartInFlightRef`), then stops the session the start started.
    let backend = Scripted::new();
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| script.start_gate = Some(gate.clone()));
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    studio.set_test_pattern(true).await.unwrap();

    let starting = tokio::spawn({
        let studio = studio.clone();
        async move { studio.start_recording().await }
    });
    eventually("the start is at the backend", || {
        backend.count("session.start") == 1
    })
    .await;
    let before = transport(&studio);
    assert_eq!(before.record_state, RecordButtonState::Running);
    assert_eq!(before.stop_label, "Stop recording");
    assert!(before.record_enabled);

    let (stopped, ()) = tokio::join!(studio.request_stop(StopOrigin::Button), async {
        eventually("the stop is marked at the click", || {
            studio.snapshot().session.stop_pending
        })
        .await;
        let pressed = transport(&studio);
        assert_eq!(pressed.record_state, RecordButtonState::Stopping);
        assert_eq!(pressed.stop_label, "Stopping…");
        assert!(pressed.record_enabled, "busy, never dimmed");
        assert_eq!(backend.count("session.stop"), 0, "it waits for the start");
        gate.add_permits(1);
    });
    assert_eq!(stopped, StopOutcome::Stopped(true));
    assert_eq!(starting.await.unwrap(), StartOutcome::Started);
    assert_eq!(backend.count("session.stop"), 1);
    let after = studio.snapshot();
    assert!(!after.session.stop_pending);
    assert_eq!(after.session.phase, SessionPhase::Stopping);
}

#[tokio::test]
async fn cancel_livestream_during_a_go_live_start_reads_stopping_at_once() {
    // B-16 with Electron's `stopRequestPending`: "Cancel livestream" reads
    // "Stopping…" from the click, and the livestream the start brings up is
    // stopped once it answers.
    let backend = Scripted::new();
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| {
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(capture_config_with_twitch().to_string()),
        );
        script.start_gate = Some(gate.clone());
        script.start_answers.push_back(Ok(live("s4")));
        script
            .stop_answers
            .push_back(Ok(status(RecordingState::Idle, Some("s4"))));
    });
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;

    let starting = tokio::spawn({
        let studio = studio.clone();
        async move { studio.start_livestream(None).await }
    });
    eventually("the start is at the backend", || {
        backend.count("session.start") == 1
    })
    .await;
    let before = transport(&studio);
    assert_eq!(before.stop_label, "Cancel livestream");
    assert!(before.record_enabled);

    let (stopped, ()) = tokio::join!(studio.request_stop(StopOrigin::Button), async {
        eventually("the cancel is marked at the click", || {
            studio.snapshot().session.stop_pending
        })
        .await;
        let pressed = transport(&studio);
        assert_eq!(pressed.record_state, RecordButtonState::Stopping);
        assert_eq!(pressed.stop_label, "Stopping…");
        assert!(pressed.record_enabled, "busy, never dimmed");
        assert_eq!(backend.count("session.stop"), 0, "it waits for the start");
        gate.add_permits(1);
    });
    assert_eq!(stopped, StopOutcome::Stopped(true));
    assert_eq!(starting.await.unwrap(), StartOutcome::Started);
    assert_eq!(backend.count("session.stop"), 1);
    let after = studio.snapshot();
    assert!(!after.session.stop_pending);
    assert_eq!(after.session.phase, SessionPhase::Idle);
}

#[tokio::test]
async fn a_stop_dropped_while_it_waits_for_a_start_ends_its_stopping() {
    // The mark moved ahead of the wait for the start, so its drop guard did
    // too: a stop dropped there (a dropped task, a timeout around it) leaves
    // no "Stopping…" behind, and the next Stop is a stop of its own.
    let backend = Scripted::new();
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| script.start_gate = Some(gate.clone()));
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    studio.set_test_pattern(true).await.unwrap();

    let starting = tokio::spawn({
        let studio = studio.clone();
        async move { studio.start_recording().await }
    });
    eventually("the start is at the backend", || {
        backend.count("session.start") == 1
    })
    .await;
    let dropped = tokio::time::timeout(std::time::Duration::from_millis(50), studio.stop()).await;
    assert!(dropped.is_err(), "the stop was still waiting for the start");
    assert!(!studio.snapshot().session.stop_pending);
    assert_eq!(transport(&studio).stop_label, "Stop recording");

    gate.add_permits(1);
    assert_eq!(starting.await.unwrap(), StartOutcome::Started);
    assert_eq!(studio.snapshot().session.phase, SessionPhase::Recording);
    assert!(studio.stop().await);
    assert_eq!(backend.count("session.stop"), 1);
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
    // Plus plan 258's D4 migration settling.
    assert_eq!(backend.count("ui.settings.set"), 2);
    studio.handle_event(ready()).await;
    assert_eq!(backend.count("ui.settings.set"), 2);
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
            .insert_scenes(
                std::slice::from_ref(&copy),
                Some("default-screen-camera"),
                &Default::default(),
            )
            .await
    );
    let ids = scene_ids(&studio.snapshot().scenes);
    let original = ids
        .iter()
        .position(|id| id == "default-screen-camera")
        .unwrap();
    assert_eq!(ids[original + 1], "copy");
}

// --- S1.6b part 3b: the scene switch on plan 231's library ---

use videorc_app_core::scenes::v2::SceneShows;
use videorc_app_core::scenes::view::no_screen_layout_reason;
use videorc_app_core::studio::scene_switch::ApplyOptions;

/// A camera and the display chosen, as the Sources page saves them.
fn capture_config_with_camera() -> Value {
    json!({
        "recordEnabled": true,
        "sources": {
            "cameraId": "camera:1", "cameraName": "camera:1",
            "screenId": "screen:screencapturekit:1", "screenName": "screen:screencapturekit:1"
        }
    })
}

/// A launched Studio over `config`, its scenes loaded.
async fn scenes_studio(config: Value) -> (Arc<Scripted>, Arc<Studio<Scripted>>) {
    let backend = Scripted::new();
    backend.with(|script| {
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(config.to_string()),
        );
    });
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    assert!(studio.snapshot().scenes.loaded);
    (backend, studio)
}

fn layout_commits(backend: &Scripted) -> Vec<(String, Value)> {
    backend.script.lock().unwrap().layout_commits.clone()
}

/// Waits for the switch in flight (its proof included) to settle.
async fn settled(studio: &Studio<Scripted>) {
    for _ in 0..400 {
        if !studio.snapshot().scenes.transaction_pending {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("the switch never settled");
}

/// A stored scene, as the store holds it.
fn stored_scene(backend: &Scripted, id: &str) -> Option<Value> {
    stored_json(backend, keys::SCENES)?["scenes"]
        .as_array()?
        .iter()
        .find(|scene| scene["id"] == id)
        .cloned()
}

fn said(
    notices: &mut broadcast::Receiver<videorc_app_core::notices::NoticeCommand>,
) -> Vec<(String, Option<String>)> {
    std::iter::from_fn(|| notices.try_recv().ok())
        .filter_map(|command| {
            command
                .notice()
                .map(|notice| (notice.title.clone(), notice.id.clone()))
        })
        .collect()
}

async fn apply(studio: &Arc<Studio<Scripted>>, id: &str) -> bool {
    let ok = studio
        .apply_saved_scene(id, None, ApplyOptions::default())
        .await
        .ok;
    settled(studio).await;
    ok
}

#[tokio::test]
async fn an_idle_switch_puts_a_saved_scene_on_with_the_shared_camera() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    assert_eq!(
        studio.snapshot().scenes.on_stream_id.as_deref(),
        Some("default-screen-camera")
    );
    assert!(apply(&studio, "default-screen-only").await);

    let commits = layout_commits(&backend);
    assert_eq!(commits.len(), 1);
    let (method, params) = &commits[0];
    assert_eq!(method, "scene.layout.apply_preview");
    // The scene's screen, the one camera every scene shares (D9).
    assert_eq!(params["sources"]["screenId"], "screen:screencapturekit:1");
    assert_eq!(params["sources"]["cameraId"], "camera:1");
    assert!(params["sources"].get("app").is_none());
    // Its layout in the studio's orientation.
    assert_eq!(params["layout"]["layoutPreset"], "screen-only");
    assert!(params.get("retainScreen").is_none());
    assert!(params.get("verticalLegScreen").is_none());
    assert!(params["intentId"].as_u64().is_some());

    let snapshot = studio.snapshot();
    let scenes = &snapshot.scenes;
    assert_eq!(scenes.on_stream_id.as_deref(), Some("default-screen-only"));
    assert!(!scenes.transaction_pending);
    assert!(scenes.pending_layout.is_none() && scenes.pending_scene_id.is_none());
    let config = &snapshot.settings.capture_doc;
    assert_eq!(config["layout"]["layoutPreset"], "screen-only");
    assert_eq!(config["lastHorizontalPreset"], "screen-only");
    assert_eq!(config["sources"]["cameraId"], "camera:1");
    // Stored: the capture config, the working setup and the library's
    // scene on stream.
    let stored = stored_json(&backend, keys::CAPTURE_CONFIG).unwrap();
    assert_eq!(stored["layout"]["layoutPreset"], "screen-only");
    let working = stored_json(&backend, keys::WORKING_SCENE).unwrap();
    assert_eq!(working["sceneId"], "default-screen-only");
    assert_eq!(working["origin"], "saved");
    assert_eq!(working["visual"]["layout"]["layoutPreset"], "screen-only");
    assert_eq!(
        stored_json(&backend, keys::SCENES).unwrap()["onStreamId"],
        "default-screen-only"
    );
    // A scene going on stream is no edit of it: its layout is as stored.
    assert_eq!(
        stored_scene(&backend, "default-screen-only").unwrap()["shows"]["screenId"],
        "screen:screencapturekit:1"
    );
}

#[tokio::test]
async fn a_switch_while_recording_goes_live_and_never_crosses_orientation() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    let mut notices = studio.notices();
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    assert!(apply(&studio, "default-screen-only").await);
    let commits = layout_commits(&backend);
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].0, "scene.layout.apply_live");

    // The orientation is locked while the session runs.
    let _ = said(&mut notices);
    assert!(!studio.apply_layout_preset("vertical-camera-top").await);
    assert!(!studio.switch_orientation(true).await);
    assert_eq!(layout_commits(&backend).len(), 1);
    let lock = (
        "Stop the recording or stream before switching orientation".to_string(),
        Some("scene-orientation-lock".to_string()),
    );
    assert_eq!(said(&mut notices), [lock.clone(), lock]);
    assert_eq!(
        studio.snapshot().settings.capture_doc["layout"]["layoutPreset"],
        "screen-only"
    );
}

#[tokio::test]
async fn a_camera_only_scene_keeps_the_running_screen_capture() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    studio
        .handle_event(BackendEvent::Untyped {
            event: "preview.screen.status".to_string(),
            payload: json!({"state": "live", "sourceId": "screen:screencapturekit:1"}),
        })
        .await;
    // Camera only shows no screen (a new profile's, D3): it keeps the
    // capture, and the commit says to retain it (D18).
    assert!(apply(&studio, "default-camera-only").await);
    let (method, params) = layout_commits(&backend).pop().unwrap();
    assert_eq!(method, "scene.layout.apply_preview");
    assert_eq!(params["layout"]["layoutPreset"], "camera-only");
    assert_eq!(params["retainScreen"], true);
    assert!(params.get("verticalLegScreen").is_none());
    assert_eq!(params["sources"]["screenId"], "screen:screencapturekit:1");
    // The kept capture is never saved as the scene's screen.
    assert_eq!(
        stored_scene(&backend, "default-camera-only").unwrap()["shows"]["kind"],
        "none"
    );
}

#[tokio::test]
async fn a_vertical_leg_that_draws_the_scenes_screen_asks_for_it() {
    let mut config = capture_config_with_twitch();
    config["streamEnabled"] = json!(true);
    config["streaming"]["targets"][0]["outputOrientation"] = json!("vertical");
    config["sources"] = capture_config_with_camera()["sources"].clone();
    let (backend, studio) = scenes_studio(config).await;
    // A scene that is Camera only in 16:9 and shows its screen in 9:16.
    let library = studio.snapshot().scenes.library.unwrap();
    let find = |id: &str| {
        library
            .scenes
            .iter()
            .find(|scene| scene.id == id)
            .unwrap()
            .clone()
    };
    let mut talk = find("default-camera-only");
    talk.id = "talk".to_string();
    talk.name = "Talk".to_string();
    talk.shows = find("default-screen-camera").shows;
    talk.vertical = find("default-screen-camera").vertical;
    assert!(
        videorc_app_core::scenes::v2::layout_shows_screen(&talk.vertical),
        "the 9:16 layout draws a screen"
    );
    assert!(
        studio
            .insert_scenes(&[talk], None, &Default::default())
            .await
    );
    assert_eq!(studio.start_recording().await, StartOutcome::Started);

    assert!(apply(&studio, "talk").await);
    let (method, params) = layout_commits(&backend).pop().unwrap();
    assert_eq!(method, "scene.layout.apply_live");
    assert_eq!(params["layout"]["layoutPreset"], "camera-only");
    assert_eq!(params["verticalLegScreen"], true);
    assert!(params.get("retainScreen").is_none());
    assert_eq!(params["sources"]["screenId"], "screen:screencapturekit:1");
}

#[tokio::test]
async fn a_screen_layout_on_a_scene_that_shows_none_is_refused() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    let mut notices = studio.notices();
    assert!(apply(&studio, "default-camera-only").await);
    let commits = layout_commits(&backend).len();
    let _ = said(&mut notices);

    assert!(!studio.apply_layout_preset("screen-camera").await);
    assert_eq!(layout_commits(&backend).len(), commits);
    let name = stored_scene(&backend, "default-camera-only").unwrap()["name"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        said(&mut notices),
        [(
            no_screen_layout_reason(&name),
            Some("scene-layout-no-screen".to_string())
        )]
    );
    assert_eq!(
        studio.snapshot().settings.capture_doc["layout"]["layoutPreset"],
        "camera-only"
    );
}

#[tokio::test]
async fn a_layout_chosen_while_a_scene_is_on_saves_into_it() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    assert!(apply(&studio, "default-screen-only").await);
    assert_eq!(
        stored_scene(&backend, "default-screen-only").unwrap()["layouts"]["horizontal"]["layoutPreset"],
        "screen-only"
    );

    assert!(studio.apply_layout_preset("screen-camera").await);
    settled(&studio).await;
    let (method, params) = layout_commits(&backend).pop().unwrap();
    assert_eq!(method, "scene.layout.apply_preview");
    assert_eq!(params["layout"]["layoutPreset"], "screen-camera");
    // D11: the scene on stream took the layout; it stays on.
    let scene = stored_scene(&backend, "default-screen-only").unwrap();
    assert_eq!(
        scene["layouts"]["horizontal"]["layoutPreset"],
        "screen-camera"
    );
    assert_eq!(
        studio.snapshot().scenes.on_stream_id.as_deref(),
        Some("default-screen-only")
    );
    // The other scene with that layout is untouched.
    assert_eq!(
        stored_scene(&backend, "default-screen-camera").unwrap()["layouts"]["horizontal"]["layoutPreset"],
        "screen-camera"
    );
    let working = stored_json(&backend, keys::WORKING_SCENE).unwrap();
    assert_eq!(working["sceneId"], "default-screen-only");
}

#[tokio::test]
async fn the_scene_on_stream_cant_be_deleted_while_recording() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    let mut notices = studio.notices();
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    let _ = said(&mut notices);
    assert!(!studio.delete_scene("default-screen-camera").await);
    assert_eq!(
        said(&mut notices),
        [(
            "Switch to another scene first.".to_string(),
            Some("scene-delete-refused".to_string())
        )]
    );
    assert!(stored_scene(&backend, "default-screen-camera").is_some());
    assert!(layout_commits(&backend).is_empty());
}

#[tokio::test]
async fn deleting_the_scene_on_stream_off_air_switches_to_the_one_before_first() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    assert!(apply(&studio, "default-camera-only").await);
    studio
        .update_studio_settings(|settings| {
            settings.set(
                "globalShortcuts",
                json!({"recordToggle": "Control+Alt+R", "scenes": {
                    "default-camera-only": "F9", "default-side-by-side": "F10"
                }}),
            );
        })
        .await
        .unwrap();

    assert!(studio.delete_scene("default-camera-only").await);
    // Part 3c: the delete waits for the switch's commit receipt, as
    // Electron's does; the Studio takes the commit after its proof.
    settled(&studio).await;
    // The scene before it went on first.
    let (_, params) = layout_commits(&backend).pop().unwrap();
    assert_eq!(params["layout"]["layoutPreset"], "screen-only");
    assert_eq!(
        studio.snapshot().scenes.on_stream_id.as_deref(),
        Some("default-screen-only")
    );
    // Then it went, with its key.
    assert!(stored_scene(&backend, "default-camera-only").is_none());
    let stored = stored_json(&backend, keys::SCENES).unwrap();
    assert_eq!(stored["onStreamId"], "default-screen-only");
    let settings = stored_json(&backend, keys::SETTINGS).unwrap();
    assert_eq!(
        settings["globalShortcuts"],
        json!({"recordToggle": "Control+Alt+R", "scenes": {"default-side-by-side": "F10"}})
    );
    // The last scene always stays.
    for id in ["default-screen-camera", "default-side-by-side"] {
        assert!(studio.delete_scene(id).await);
    }
    assert!(!studio.delete_scene("default-screen-only").await);
}

#[tokio::test]
async fn a_screen_pick_changes_the_screen_of_the_scene_on_stream() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    // Idle: at once.
    assert!(
        studio
            .set_scene_on_stream_shows(SceneShows::TestPattern)
            .await
    );
    assert_eq!(
        stored_scene(&backend, "default-screen-camera").unwrap()["shows"]["kind"],
        "test-pattern"
    );

    // Recording: the session confirms the switch, and that saves it (D11).
    assert!(apply(&studio, "default-screen-only").await);
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    let other = SceneShows::Display {
        screen_id: "screen:screencapturekit:2".to_string(),
        screen_name: Some("Studio Display".to_string()),
        screen_uuid: None,
    };
    assert!(!studio.set_scene_on_stream_shows(other).await);
    assert_eq!(
        stored_scene(&backend, "default-screen-only").unwrap()["shows"]["screenId"],
        "screen:screencapturekit:1"
    );
    let mut confirmed = studio.snapshot().settings.capture_doc["sources"].clone();
    confirmed["screenId"] = json!("screen:screencapturekit:2");
    confirmed["screenName"] = json!("Studio Display");
    studio.note_session_sources_confirmed(confirmed).await;
    let shows = &stored_scene(&backend, "default-screen-only").unwrap()["shows"];
    assert_eq!(shows["screenId"], "screen:screencapturekit:2");
    assert_eq!(shows["screenName"], "Studio Display");
    assert_eq!(
        studio.snapshot().settings.capture_doc["sources"]["screenId"],
        "screen:screencapturekit:2"
    );
}

/// S1.6b part 5a (plan 231 D2): the Sources picker's idle Screen pick never
/// leaves the scene on stream: it is that scene's screen, and the capture's.
#[tokio::test]
async fn an_idle_screen_pick_is_the_screen_of_the_scene_on_stream() {
    use videorc_app_core::studio::source_selection::SourceKind;
    let backend = Scripted::new();
    backend.with(|script| {
        script.device_ids = Some(vec![
            "camera:1".to_string(),
            "screen:screencapturekit:1".to_string(),
            "screen:screencapturekit:2".to_string(),
        ]);
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(capture_config_with_camera().to_string()),
        );
    });
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let on_stream = studio
        .snapshot()
        .scenes
        .on_stream_id
        .expect("a scene is on stream");
    assert_eq!(studio.source_switch_reason(SourceKind::Capture), None);
    studio
        .select_source_device(SourceKind::Capture, Some("screen:screencapturekit:2"))
        .await
        .expect("the pick lands");
    let snapshot = studio.snapshot();
    assert_eq!(
        snapshot.scenes.on_stream_id.as_deref(),
        Some(on_stream.as_str()),
        "the scene stays on stream"
    );
    assert_eq!(
        stored_scene(&backend, &on_stream).unwrap()["shows"]["screenId"],
        "screen:screencapturekit:2"
    );
    assert_eq!(
        snapshot.settings.capture_doc["sources"]["screenId"],
        "screen:screencapturekit:2"
    );
    // The camera, another kind, is left as it was.
    assert_eq!(
        snapshot.settings.capture_doc["sources"]["cameraId"],
        "camera:1"
    );
}

/// L6's smart-scenes out-of-sight step on c54b5bb6d: an idle pick of the
/// Fixture Alpha window landed in the scene, but the preview stayed on the
/// display it captured before, because the idle scene reload starts no
/// capture. As the renderer's `ensureNativePreviewScreen` does, the pick
/// starts the picked screen's or window's capture (with the exclusion
/// list); Off starts none.
#[tokio::test]
async fn an_idle_screen_pick_moves_the_screen_capture_to_the_pick() {
    use videorc_app_core::studio::source_selection::SourceKind;
    const WINDOW: &str = "window:screencapturekit:7";
    let backend = Scripted::new();
    backend.with(|script| {
        script.device_ids = Some(vec![
            "camera:1".to_string(),
            "screen:screencapturekit:1".to_string(),
            "screen:screencapturekit:2".to_string(),
        ]);
        script.windows = vec![(WINDOW.to_string(), "Fixture Alpha".to_string())];
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(capture_config_with_camera().to_string()),
        );
    });
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    studio.set_protected_overlay_window_ids(vec![40]).await;
    assert_eq!(backend.count("preview.screen.start"), 0);

    // A display.
    studio
        .select_source_device(SourceKind::Capture, Some("screen:screencapturekit:2"))
        .await
        .expect("the pick lands");
    assert_eq!(backend.count("preview.screen.start"), 1);
    {
        let script = backend.script.lock().unwrap();
        let start = script.screen_starts.last().expect("the capture follows");
        assert_eq!(
            start.sources.screen_id.as_deref(),
            Some("screen:screencapturekit:2")
        );
        assert_eq!(start.sources.window_id, None);
        assert_eq!(start.protected_overlay_window_ids, vec![40]);
    }
    let last = studio.snapshot().capture_exclusion.last.expect("an answer");
    assert_eq!(last.reason, "screen-pick");

    // A window: the capture moves off the display to it.
    studio
        .select_source_device(SourceKind::Capture, Some(WINDOW))
        .await
        .expect("the pick lands");
    assert_eq!(backend.count("preview.screen.start"), 2);
    {
        let script = backend.script.lock().unwrap();
        let start = script.screen_starts.last().unwrap();
        assert_eq!(start.sources.window_id.as_deref(), Some(WINDOW));
        assert_eq!(start.sources.screen_id, None);
    }

    // Off, and a camera pick, start no screen capture.
    let _ = studio.select_source_device(SourceKind::Capture, None).await;
    let _ = studio
        .select_source_device(SourceKind::Camera, Some("camera:1"))
        .await;
    assert_eq!(backend.count("preview.screen.start"), 2);
}

/// The idle reload only commits the scene. The camera's capture must follow
/// the pick too, just as Electron's ensureNativePreviewCamera does.
#[tokio::test]
async fn an_idle_camera_pick_moves_the_camera_capture_to_the_pick() {
    use videorc_app_core::studio::source_selection::SourceKind;
    let backend = Scripted::new();
    backend.with(|script| {
        script.device_ids = Some(vec![
            "camera:1".to_string(),
            "camera:2".to_string(),
            "screen:screencapturekit:1".to_string(),
        ]);
        let mut config = capture_config_with_camera();
        config["layout"] = json!({"layoutPreset": "camera-only"});
        config["video"] = json!({"width": 1280, "height": 720, "fps": 30});
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(config.to_string()),
        );
    });
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    assert_eq!(backend.count("preview.camera.start"), 0);

    studio
        .select_source_device(SourceKind::Camera, Some("camera:2"))
        .await
        .expect("the camera pick lands");
    assert_eq!(backend.count("preview.camera.start"), 1);
    {
        let script = backend.script.lock().unwrap();
        let (_, params) = script.camera_requests.last().unwrap();
        assert_eq!(params["sources"]["cameraId"], "camera:2");
        assert_eq!(params["layout"]["layoutPreset"], "camera-only");
        assert_eq!(params["video"]["width"], 1280);
        assert_eq!(params["video"]["height"], 720);
        assert_eq!(params["video"]["fps"], 30);
    }
    assert_eq!(
        studio.telemetry_now().preview_camera.unwrap()["cameraId"],
        "camera:2"
    );

    studio
        .select_source_device(SourceKind::Camera, None)
        .await
        .expect("Off lands");
    assert_eq!(backend.count("preview.camera.stop"), 1);
    assert_eq!(
        studio.telemetry_now().preview_camera.unwrap()["state"],
        "idle"
    );

    studio
        .select_source_device(SourceKind::Capture, Some("screen:screencapturekit:1"))
        .await
        .expect("the screen pick lands");
    studio
        .select_source_device(SourceKind::Microphone, None)
        .await
        .unwrap();
    assert_eq!(backend.script.lock().unwrap().camera_requests.len(), 2);
}

#[tokio::test]
async fn an_idle_camera_pick_respects_screen_only_and_unavailable_cameras() {
    use videorc_app_core::studio::source_selection::SourceKind;
    let mut config = capture_config_with_camera();
    config["layout"] = json!({"layoutPreset": "screen-only"});
    let (backend, studio) = scenes_studio(config).await;
    studio
        .select_source_device(SourceKind::Camera, Some("camera:1"))
        .await
        .unwrap();
    assert_eq!(backend.count("preview.camera.start"), 0);
    assert_eq!(backend.count("preview.camera.stop"), 0);

    studio
        .update_capture_config(|config| {
            config["layout"]["layoutPreset"] = json!("camera-only");
        })
        .await
        .unwrap();
    studio
        .switch_source_device_live(
            SourceKind::Camera,
            json!({
                "cameraId": "camera:missing", "cameraName": "Missing", "cameraOff": false
            }),
        )
        .await
        .unwrap();
    assert_eq!(backend.count("preview.camera.start"), 0);

    studio
        .handle_event(BackendEvent::Untyped {
            event: "preview.camera.status".to_string(),
            payload: json!({"state": "disconnected", "cameraId": "camera:1"}),
        })
        .await;
    studio
        .select_source_device(SourceKind::Camera, Some("camera:1"))
        .await
        .unwrap();
    assert_eq!(backend.count("preview.camera.start"), 0);
}

/// S1.6b part 5b: the Studio's Sources mirror is the Camera row (plan 231
/// D8: no Screen row, no Hide screen) with Open Sources at its end (plan
/// 235 D4), and the Sources page's Screen item names the scene on stream.
#[tokio::test]
async fn the_sources_views_read_the_camera_row_and_the_scene_on_stream() {
    use videorc_app_core::studio::sources_page::{
        PermissionInputs, SourcesPageInput, sources_page_view,
    };
    use videorc_app_core::studio::sources_section::{SourcesExtras, SourcesSectionView};
    let (_backend, studio) = scenes_studio(capture_config_with_camera()).await;
    let snapshot = studio.snapshot();
    let telemetry = studio.telemetry_now();

    let mirror =
        SourcesSectionView::from_snapshot(&snapshot, &telemetry, &SourcesExtras::default());
    assert_eq!(mirror.group_label, "Sources");
    assert_eq!(mirror.camera.row.picker.label, "camera:1");
    assert_eq!(mirror.camera.row.disabled_reason, None);
    assert_eq!(mirror.camera.open_label, "Open Sources");
    let background = mirror.camera.background.expect("a camera has a Background");
    assert_eq!(background.value_label, "Off");
    assert!(!background.is_effect);
    assert_eq!(mirror.camera.system_effect, None);
    assert_eq!(mirror.camera.background_stage, None);

    let page = sources_page_view(&SourcesPageInput {
        snapshot: &snapshot,
        telemetry: &telemetry,
        permissions: PermissionInputs {
            platform: "darwin",
            target_name: "Videorc",
            ..PermissionInputs::default()
        },
        development: false,
        refreshing: false,
    });
    let scene = page.screen.scene.expect("the scene on stream is named");
    assert!(scene.shows_screen, "{scene:?}");
    assert!(scene.line.starts_with("Shown by “"), "{}", scene.line);
    assert_eq!(scene.open_label, "Open Scenes");
    assert!(page.camera.low_light.is_none(), "no answer, no switch");
    assert!(page.alerts.is_empty());
}

/// S1.6b part 5c: the Microphone row's mute goes through
/// `requestRemoteMicrophoneMute` (idle: at once), says "Muted", and says
/// "Muted for takeover" with when it ends while a takeover holds the voice
/// (#1601). The section has no title, only its name and its focus.
#[tokio::test]
async fn the_microphone_row_says_muted_and_muted_for_takeover() {
    use std::time::Instant;
    use videorc_app_core::studio::audio_levels::MicLevels;
    use videorc_app_core::studio::audio_section::{AudioInputs, AudioSectionView};
    let backend = Scripted::new();
    backend.with(|script| {
        script.settings.insert(
            keys::SCREEN_TAKEOVER_MUTE_OWNERSHIP.to_string(),
            Value::String(r#"{"priorMicrophoneMuted":false}"#.to_string()),
        );
    });
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let section = |inputs: AudioInputs| {
        AudioSectionView::from_snapshot(
            &studio.snapshot(),
            &MicLevels::default(),
            Instant::now(),
            inputs,
        )
    };
    let idle = section(AudioInputs::default());
    assert_eq!(idle.label, "Audio");
    assert_eq!(idle.focus, "studio-audio");
    assert!(!idle.microphone.muted);
    assert_eq!(idle.microphone.mute_chip, None);

    assert!(studio.request_microphone_mute(true).await, "idle: at once");
    let muted = section(AudioInputs::default());
    assert!(muted.microphone.muted);
    assert_eq!(muted.microphone.mute_chip, Some("Muted"));
    assert_eq!(muted.microphone.takeover_hint, None);

    // The takeover muted a live microphone: the row says so until it ends.
    let held = section(AudioInputs {
        takeover_active: true,
        room_open: false,
    });
    assert_eq!(held.microphone.mute_chip, Some("Muted for takeover"));
    assert_eq!(
        held.microphone.takeover_hint,
        Some("Your microphone comes back on when the takeover ends.")
    );
}

// S1.6b part 5d: the live audio sync (plan 069) and the mute saved first.

/// The capture config's audio as the store holds it.
fn stored_audio(backend: &Scripted) -> Value {
    let stored = backend
        .script
        .lock()
        .unwrap()
        .settings
        .get(keys::CAPTURE_CONFIG)
        .cloned()
        .expect("the capture config is stored");
    let config = match stored {
        Value::String(text) => serde_json::from_str(&text).expect("stored as JSON text"),
        other => other,
    };
    config["audio"].clone()
}

/// A recording the Studio started (`s1`), so the live sync holds what its
/// start sent. Its drive runs: the drive alone drains the live sync's queue
/// (review of #1862). The events reach the Studio through `handle_event`;
/// the drive's own channel stays open, and quiet, for the test.
async fn recording_studio(backend: &Arc<Scripted>) -> Arc<Studio<Scripted>> {
    let studio = new_studio(backend);
    let (keep_open, events) = broadcast::channel::<BackendEvent>(16);
    tokio::spawn({
        let studio = studio.clone();
        async move {
            let _keep_open = keep_open;
            studio.drive(events).await;
        }
    });
    studio.handle_event(ready()).await;
    studio.set_test_pattern(true).await.unwrap();
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    assert_eq!(
        backend.count("audio.processing.update"),
        0,
        "an untouched start sends the session nothing"
    );
    studio
}

/// `requestRemoteMicrophoneMute` during a recording: the mute is in the
/// capture config (and the store) before the session answers, then the
/// call answers once the session applied it.
#[tokio::test]
async fn a_mute_during_a_recording_is_saved_before_the_session_answers() {
    let backend = Scripted::new();
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| {
        script.audio_gate = Some(gate.clone());
        script.audio_answers.push_back(None);
    });
    let studio = recording_studio(&backend).await;

    let muting = tokio::spawn({
        let studio = studio.clone();
        async move { studio.request_microphone_mute(true).await }
    });
    eventually("the mute is on its way to the session", || {
        backend.count("audio.processing.update") == 1
    })
    .await;
    assert!(studio.snapshot().settings.capture.audio.microphone_muted);
    assert_eq!(stored_audio(&backend)["microphoneMuted"], json!(true));
    assert!(!muting.is_finished(), "the session has not answered");
    assert_eq!(
        studio.snapshot().system_audio.applied_microphone_muted,
        Some(false),
        "the session still holds what its start sent"
    );

    gate.add_permits(1);
    assert!(muting.await.unwrap(), "the session applied it");
    assert_eq!(
        studio.snapshot().system_audio.applied_microphone_muted,
        Some(true)
    );
    let sent = backend.script.lock().unwrap().audio_updates.clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].session_id, "s1");
    assert!(sent[0].microphone_muted);
    assert_eq!(
        sent[0].system_audio_enabled, None,
        "the session holds the start's System audio"
    );
    assert!(studio.snapshot().settings.capture.audio.microphone_muted);
    // The toggle reads what the session holds: muted, so it unmutes.
    backend.with(|script| script.audio_answers.push_back(None));
    gate.add_permits(1);
    assert!(
        studio
            .set_microphone_muted(videorc_app_core::studio::MicrophoneMode::Toggle)
            .await
    );
    assert!(!studio.snapshot().settings.capture.audio.microphone_muted);
}

/// A Gain drag while one update is in flight: the session gets only the
/// newest value after it.
#[tokio::test]
async fn gain_changes_while_one_update_is_in_flight_send_only_the_newest() {
    let backend = Scripted::new();
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| {
        script.audio_gate = Some(gate.clone());
        script.audio_answers.extend([None, None]);
    });
    let studio = recording_studio(&backend).await;

    let first = tokio::spawn({
        let studio = studio.clone();
        async move { studio.set_microphone_gain(3.0).await }
    });
    eventually("the first update is in flight", || {
        backend.count("audio.processing.update") == 1
    })
    .await;
    studio.set_microphone_gain(6.0).await;
    studio.set_microphone_gain(9.0).await;
    assert_eq!(
        backend.count("audio.processing.update"),
        1,
        "one request in flight"
    );
    assert_eq!(
        studio.snapshot().settings.capture.audio.microphone_gain_db,
        9.0
    );

    gate.add_permits(2);
    first.await.unwrap();
    // The drive sends the newest once the first settles.
    eventually("the newest gain follows", || {
        backend.count("audio.processing.update") == 2
    })
    .await;
    let gains: Vec<f32> = backend
        .script
        .lock()
        .unwrap()
        .audio_updates
        .iter()
        .map(|update| update.microphone_gain_db)
        .collect();
    assert_eq!(gains, [3.0_f32, 9.0]);
    assert!(!studio.snapshot().system_audio.live_controls_disabled);
}

/// A capture without live audio controls: the controls go back to what the
/// session last accepted, stay pinned there for the session, and say why.
#[tokio::test]
async fn an_unavailable_live_control_restores_and_disables_the_controls() {
    use videorc_app_core::studio::live_audio::copy;
    let backend = Scripted::new();
    backend.with(|script| {
        script
            .audio_answers
            .push_back(Some("live-audio-control-unavailable"));
    });
    let studio = recording_studio(&backend).await;

    studio.set_microphone_gain(6.0).await;
    // The drive sends it and settles the refusal; the rollback is stored.
    eventually("the refusal rolls the controls back", || {
        studio.snapshot().system_audio.live_controls_disabled
            && stored_audio(&backend)["microphoneGainDb"].as_f64() == Some(0.0)
    })
    .await;
    assert_eq!(backend.count("audio.processing.update"), 1);
    let snapshot = studio.snapshot();
    assert_eq!(snapshot.settings.capture.audio.microphone_gain_db, 0.0);
    assert_eq!(
        stored_audio(&backend)["microphoneGainDb"].as_f64(),
        Some(0.0)
    );
    assert!(snapshot.system_audio.live_controls_disabled);
    assert_eq!(
        snapshot.last_error.as_deref(),
        Some(copy::CONTROLS_UNAVAILABLE)
    );

    // Pinned for the session: a later edit goes back at once, unsent, and
    // a mute that would change it is refused.
    studio.set_microphone_gain(3.0).await;
    assert_eq!(
        studio.snapshot().settings.capture.audio.microphone_gain_db,
        0.0
    );
    assert!(!studio.request_microphone_mute(true).await);
    assert!(!studio.snapshot().settings.capture.audio.microphone_muted);
    assert_eq!(backend.count("audio.processing.update"), 1);
}

/// A mute whose caller goes away while its request is in flight (a closed
/// window, a cancelled task) strands nothing: the drive owns the request,
/// settles it, and sends the next change after it, never two at once
/// (review of #1862).
#[tokio::test]
async fn a_dropped_control_strands_nothing_on_the_live_queue() {
    let backend = Scripted::new();
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| {
        script.audio_gate = Some(gate.clone());
        script.audio_answers.extend([None, None]);
    });
    let studio = recording_studio(&backend).await;

    let muting = tokio::spawn({
        let studio = studio.clone();
        async move { studio.request_microphone_mute(true).await }
    });
    eventually("the mute is in flight", || {
        backend.count("audio.processing.update") == 1
    })
    .await;
    muting.abort();
    let _ = muting.await;

    // The next change waits behind the dropped caller's request.
    studio.set_microphone_gain(6.0).await;
    assert_eq!(
        backend.count("audio.processing.update"),
        1,
        "one request in flight"
    );
    gate.add_permits(2);
    eventually("the gain follows the settled mute", || {
        backend.count("audio.processing.update") == 2
    })
    .await;
    eventually("the session holds the mute", || {
        studio.snapshot().system_audio.applied_microphone_muted == Some(true)
    })
    .await;
    let sent = backend.script.lock().unwrap().audio_updates.clone();
    assert!(sent[1].microphone_muted);
    assert_eq!(sent[1].microphone_gain_db, 6.0);
}

/// A writer other than the controls (a saved scene's System audio, through
/// `update_capture_config`) reaches a running session too, as Electron's
/// sync effect hears every `captureConfig.audio` change (review of #1862).
#[tokio::test]
async fn a_capture_config_write_reaches_the_running_session() {
    let backend = Scripted::new();
    backend.with(|script| script.audio_answers.push_back(None));
    let studio = recording_studio(&backend).await;

    let on = !studio
        .snapshot()
        .settings
        .capture
        .audio
        .system_audio_enabled;
    studio
        .update_capture_config(|config| {
            videorc_app_core::studio::capture_config::set_path(
                config,
                &["audio", "systemAudioEnabled"],
                Some(json!(on)),
            );
        })
        .await
        .unwrap();
    eventually("the session is told", || {
        backend.count("audio.processing.update") == 1
    })
    .await;
    let sent = backend.script.lock().unwrap().audio_updates.clone();
    assert_eq!(sent[0].session_id, "s1");
    assert_eq!(sent[0].system_audio_enabled, Some(on));
}

// S1.6b part 3c: the start races (#1643), apply-after-proof and the failure
// reconciliation, the switch's progress (#1275), the manual-apply
// listeners.

/// Waits until `check` holds on the Studio (or the fake).
async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    for _ in 0..400 {
        if check() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("never: {what}");
}

fn listed_name(studio: &Studio<Scripted>, id: &str) -> String {
    studio
        .snapshot()
        .scenes
        .scenes
        .iter()
        .find(|scene| scene.id == id)
        .unwrap()
        .name
        .clone()
}

fn started_preset(backend: &Scripted, index: usize) -> Value {
    let started = &backend.script.lock().unwrap().started_with[index];
    serde_json::to_value(&started.layout).unwrap()["layoutPreset"].clone()
}

#[tokio::test]
async fn a_start_waits_for_the_switch_awaiting_its_proof_and_starts_with_its_scene() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| script.apply_gate = Some(gate.clone()));

    let switching = {
        let studio = studio.clone();
        tokio::spawn(async move { apply(&studio, "default-camera-only").await })
    };
    eventually("the switch is pending", || {
        studio.snapshot().scenes.pending_scene_id.as_deref() == Some("default-camera-only")
    })
    .await;
    let starting = {
        let studio = studio.clone();
        tokio::spawn(async move { studio.start_recording().await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        backend.count("session.start"),
        0,
        "the start waits for the switch's proof"
    );

    gate.add_permits(8);
    assert!(switching.await.unwrap());
    assert_eq!(starting.await.unwrap(), StartOutcome::Started);
    // It started with the scene the switch left, never the one it left.
    assert_eq!(started_preset(&backend, 0), "camera-only");
    assert_eq!(layout_commits(&backend)[0].0, "scene.layout.apply_preview");
}

#[tokio::test]
async fn a_switch_dropped_before_its_receipt_never_holds_a_start() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| script.apply_gate = Some(gate.clone()));

    // A dropped GPUI task or a deck ack's timeout drops the switch's future
    // while its request is out.
    let switching = {
        let studio = studio.clone();
        tokio::spawn(async move { apply(&studio, "default-camera-only").await })
    };
    eventually("the switch is pending", || {
        studio.snapshot().scenes.pending_scene_id.as_deref() == Some("default-camera-only")
    })
    .await;
    switching.abort();
    assert!(switching.await.unwrap_err().is_cancelled());

    // Its `finally` ran: nothing waits for its proof, and the progress went.
    let snapshot = studio.snapshot();
    assert!(!snapshot.scenes.transaction_pending);
    assert_eq!(snapshot.scenes.pending_scene_id, None);
    let started = tokio::time::timeout(std::time::Duration::from_secs(2), studio.start_recording())
        .await
        .expect("the start never waits for a dropped switch");
    assert_eq!(started, StartOutcome::Started);
    gate.add_permits(8);
}

#[tokio::test]
async fn a_switch_asked_for_during_a_start_waits_and_goes_to_the_session() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| script.start_gate = Some(gate.clone()));

    let starting = {
        let studio = studio.clone();
        tokio::spawn(async move { studio.start_recording().await })
    };
    eventually("session.start is sent", || {
        backend.count("session.start") == 1
    })
    .await;
    let switching = {
        let studio = studio.clone();
        tokio::spawn(async move { apply(&studio, "default-screen-only").await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(
        layout_commits(&backend).is_empty(),
        "the switch waits for the start's answer"
    );
    assert!(!studio.snapshot().scenes.transaction_pending);

    gate.add_permits(1);
    assert_eq!(starting.await.unwrap(), StartOutcome::Started);
    assert!(switching.await.unwrap());
    // The start carried the scene as it was; the switch is a change to the
    // session it started.
    assert_eq!(started_preset(&backend, 0), "screen-camera");
    let commits = layout_commits(&backend);
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].0, "scene.layout.apply_live");
    assert_eq!(commits[0].1["layout"]["layoutPreset"], "screen-only");
    assert_eq!(
        studio.snapshot().scenes.on_stream_id.as_deref(),
        Some("default-screen-only")
    );
}

// --- S1.6a part 6c: the Clips ring on the Studio, and #1640's ring half ---

use videorc_app_core::desktop::permissions::{MediaAccessSnapshot, MediaAccessStatus};
use videorc_protocol::ReplayParams;

/// `replay.status` before the ring ever ran.
fn ring_off() -> Value {
    json!({"state": "off", "seconds": 60, "bufferedSeconds": 0.0})
}

/// The buffer-only session's status, as `session.start` answers it.
fn ring_session() -> RecordingStatus {
    RecordingStatus {
        replay_only: true,
        ..status(RecordingState::Recording, Some("ring"))
    }
}

/// A launched Studio over `config` whose backend answers `replay.status`,
/// with a chosen recordings folder and the app's capability issuer; the
/// grants given and the previews the app's own (so nothing waits). Returns
/// the capability the folder's starts carry.
async fn clips_studio(config: Value) -> (Arc<Scripted>, Arc<Studio<Scripted>>, String) {
    let backend = Scripted::new();
    let folder = std::env::temp_dir();
    backend.with(|script| {
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(config.to_string()),
        );
        script.settings.insert(
            keys::RECORDINGS_FOLDER.to_string(),
            Value::String(
                json!({"path": folder.display().to_string(), "displayName": "Recordings"})
                    .to_string(),
            ),
        );
        script.replay_status = Some(ring_off());
        script.start_answers.push_back(Ok(ring_session()));
    });
    let studio = new_studio(&backend);
    let authorize: videorc_app_core::studio::OutputAuthorizer =
        Arc::new(|path: std::path::PathBuf| {
            Box::pin(async move { Ok::<String, String>(format!("cap:{}", path.display())) })
                as std::pin::Pin<
                    Box<dyn std::future::Future<Output = Result<String, String>> + Send>,
                >
        });
    studio.set_output_authorizer(authorize);
    studio.set_clips_auto_preview(false);
    studio.set_clips_media_access(Some(MediaAccessSnapshot {
        camera: MediaAccessStatus::Granted,
        microphone: MediaAccessStatus::Granted,
        screen: MediaAccessStatus::Granted,
    }));
    studio.handle_event(ready()).await;
    assert!(studio.snapshot().scenes.loaded);
    (backend, studio, format!("cap:{}", folder.display()))
}

#[tokio::test]
async fn the_launch_arms_the_ring_and_starts_a_buffer_only_session_with_the_scene() {
    let (backend, studio, capability) = clips_studio(capture_config_with_camera()).await;
    assert_eq!(
        backend.script.lock().unwrap().clips_calls[0].0,
        "replay.status"
    );
    let clips = studio.snapshot().clips;
    assert!(clips.armed && clips.on, "the switch is on by default");
    assert!(studio.clips_due_at().is_some(), "the arming passes");

    studio.clips_due().await;
    assert_eq!(backend.count("session.start"), 1);
    let script = backend.script.lock().unwrap();
    let started = &script.started_with[0];
    assert!(!started.output.record_enabled && !started.output.stream_enabled);
    assert!(started.streaming.is_none() && started.captions.is_none());
    assert_eq!(
        started.replay,
        Some(ReplayParams {
            seconds: 60,
            auto: true
        }),
        "the minute, as the default nobody chose"
    );
    assert_eq!(
        serde_json::to_value(&started.layout).unwrap()["layoutPreset"],
        "screen-camera",
        "the scene on stream"
    );
    assert_eq!(started.sources.camera_id.as_deref(), Some("camera:1"));
    assert_eq!(
        script.started_into[0].as_deref(),
        Some(capability.as_str()),
        "the folder's capability rides the ring's start"
    );
    drop(script);
    assert!(studio.snapshot().session.status.replay_only);
}

/// L6's preview-check-invisible on c54b5bb6d: with no screen preview
/// started at idle, the backend refused the ring three times ("the screen
/// preview source(s) produced no frames") and the ring gave up. The ring's
/// start starts the screen's capture first, as a Record does. The scene
/// holds a screen and a camera: the backend's scene commit starts the camera
/// (`start_missing_sources`), as for a Record, and both starts carry it.
#[tokio::test]
async fn the_rings_start_starts_the_screens_capture_before_the_session() {
    let (backend, studio, _) = clips_studio(capture_config_with_camera()).await;
    studio.clips_due().await;
    let calls = backend.calls();
    let screen = calls
        .iter()
        .position(|call| call == "preview.screen.start")
        .expect("the ring's start starts the screen's capture");
    let start = calls
        .iter()
        .position(|call| call == "session.start")
        .expect("the ring starts");
    assert!(screen < start, "the capture first: {calls:?}");
    let script = backend.script.lock().unwrap();
    let capture = &script.screen_starts[0];
    assert_eq!(capture.sources, script.started_with[0].sources);
    assert_eq!(capture.video, script.started_with[0].output.video);
    assert_eq!(
        capture.sources.screen_id.as_deref(),
        Some("screen:screencapturekit:1")
    );
    assert_eq!(
        capture.sources.camera_id.as_deref(),
        Some("camera:1"),
        "screen and camera"
    );
}

#[tokio::test]
async fn the_ring_waits_for_a_switch_awaiting_its_proof_and_starts_with_its_scene() {
    let (backend, studio, _) = clips_studio(capture_config_with_camera()).await;
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| script.apply_gate = Some(gate.clone()));

    let switching = {
        let studio = studio.clone();
        tokio::spawn(async move { apply(&studio, "default-camera-only").await })
    };
    eventually("the switch is pending", || {
        studio.snapshot().scenes.pending_scene_id.as_deref() == Some("default-camera-only")
    })
    .await;
    studio.clips_due().await;
    assert_eq!(
        backend.count("session.start"),
        0,
        "the ring waits for the switch's proof"
    );

    gate.add_permits(8);
    assert!(switching.await.unwrap());
    assert!(
        studio.clips_due_at().is_some(),
        "the proof's end passes the ring again"
    );
    studio.clips_due().await;
    assert_eq!(backend.count("session.start"), 1);
    // It started with the scene the switch went to, never the one it left.
    assert_eq!(started_preset(&backend, 0), "camera-only");
    assert_eq!(layout_commits(&backend)[0].0, "scene.layout.apply_preview");
}

#[tokio::test]
async fn a_switch_asked_for_during_the_rings_start_waits_and_goes_to_its_session() {
    let (backend, studio, _) = clips_studio(capture_config_with_camera()).await;
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| script.start_gate = Some(gate.clone()));

    let passing = {
        let studio = studio.clone();
        tokio::spawn(async move { studio.clips_due().await })
    };
    eventually("the ring's session.start is sent", || {
        backend.count("session.start") == 1
    })
    .await;
    let switching = {
        let studio = studio.clone();
        tokio::spawn(async move { apply(&studio, "default-screen-only").await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(
        layout_commits(&backend).is_empty(),
        "the switch waits for the ring's start"
    );
    assert!(!studio.snapshot().scenes.transaction_pending);

    gate.add_permits(1);
    passing.await.unwrap();
    assert!(switching.await.unwrap());
    // The ring started with the scene as it was; the switch is a change to
    // the session it started.
    assert_eq!(started_preset(&backend, 0), "screen-camera");
    let commits = layout_commits(&backend);
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].0, "scene.layout.apply_live");
    assert_eq!(commits[0].1["layout"]["layoutPreset"], "screen-only");
    assert_eq!(
        studio.snapshot().scenes.on_stream_id.as_deref(),
        Some("default-screen-only")
    );
}

#[tokio::test]
async fn a_superseded_commit_never_reaches_the_controls_and_the_progress_says_so() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| script.apply_gate = Some(gate.clone()));
    let first = listed_name(&studio, "default-screen-only");
    let second = listed_name(&studio, "default-camera-only");

    let a = {
        let studio = studio.clone();
        tokio::spawn(async move {
            studio
                .apply_saved_scene("default-screen-only", None, ApplyOptions::default())
                .await
        })
    };
    let starting = |studio: &Studio<Scripted>, id: &str| {
        let scenes = studio.snapshot().scenes;
        scenes.pending_scene_id.as_deref() == Some(id)
            && scenes.switch_progress.is_some_and(|progress| {
                progress.phase
                    == videorc_app_core::scenes::switch_progress::SceneSwitchPhase::Starting
            })
    };
    eventually("A is starting", || starting(&studio, "default-screen-only")).await;
    let scenes = studio.snapshot().scenes;
    let progress = scenes.switch_progress.clone().unwrap();
    assert_eq!(progress.target, first, "a saved scene's name");
    assert_eq!(progress.replaced, None);
    assert!(progress.shows_screen && !progress.shows_camera);
    // Not shown in its first moment; shown once 1.5 s have passed.
    assert_eq!(scenes.progress_line(progress.started_at_ms, None), None);
    assert_eq!(
        scenes.progress_line_at(),
        Some(progress.started_at_ms + 1_500)
    );
    let line = scenes
        .progress_line(progress.started_at_ms + 1_500, None)
        .unwrap();
    assert_eq!(
        line.title,
        format!("{first} · Waiting for the screen's first frame…")
    );
    assert_eq!(line.detail, None);

    let b = {
        let studio = studio.clone();
        tokio::spawn(async move {
            studio
                .apply_saved_scene("default-camera-only", None, ApplyOptions::default())
                .await
        })
    };
    eventually("B is starting", || starting(&studio, "default-camera-only")).await;
    let scenes = studio.snapshot().scenes;
    let progress = scenes.switch_progress.clone().unwrap();
    assert_eq!(progress.target, second);
    assert_eq!(progress.replaced.as_deref(), Some(first.as_str()));
    assert!(progress.shows_camera, "Camera only waits on the camera");
    // A takeover shows at once.
    let line = scenes.progress_line(progress.started_at_ms, None).unwrap();
    assert_eq!(
        line.title,
        format!("{second} · Waiting for the camera's first frame…")
    );
    assert_eq!(
        line.detail,
        Some(format!("Replaces the switch to {first}."))
    );

    // A commits first, but B was asked for since: A's receipt is true, and
    // its state never reaches the controls.
    gate.add_permits(1);
    eventually("A committed", || layout_commits(&backend).len() == 1).await;
    assert!(a.await.unwrap().ok);
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    let snapshot = studio.snapshot();
    assert_eq!(
        snapshot.settings.capture_doc["layout"]["layoutPreset"],
        "screen-camera"
    );
    assert_eq!(
        snapshot.scenes.on_stream_id.as_deref(),
        Some("default-screen-camera")
    );
    assert!(snapshot.scenes.transaction_pending, "B still runs");

    gate.add_permits(8);
    assert!(b.await.unwrap().ok);
    settled(&studio).await;
    let snapshot = studio.snapshot();
    assert_eq!(
        snapshot.settings.capture_doc["layout"]["layoutPreset"],
        "camera-only"
    );
    assert_eq!(
        snapshot.scenes.on_stream_id.as_deref(),
        Some("default-camera-only")
    );
    // The finally: the pending state and the progress go.
    assert!(snapshot.scenes.switch_progress.is_none());
    assert!(snapshot.scenes.pending_layout.is_none());
}

#[tokio::test]
async fn a_failed_switch_reconciles_to_the_backends_truth_or_the_last_commit() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    let mut notices = studio.notices();
    assert!(apply(&studio, "default-screen-only").await);
    let _ = said(&mut notices);
    let outcome_unknown = || {
        RpcError::new(
            "scene.layout.apply_preview",
            "request-outcome-unknown",
            "Videorc's engine connection closed before it answered.",
        )
    };

    // No backend truth (scene.get unanswered): the last commit stays, and
    // the failure is said.
    backend.with(|script| script.apply_failures.push_back((outcome_unknown(), false)));
    assert!(!studio.apply_layout_preset("screen-camera").await);
    settled(&studio).await;
    assert_eq!(
        studio.snapshot().settings.capture_doc["layout"]["layoutPreset"],
        "screen-only"
    );
    assert!(!said(&mut notices).is_empty(), "the failure is said");

    // A stable backend truth that is not the requested scene: the Studio
    // takes it, and the failure is still said. It is no edit of the scene
    // on stream.
    backend.with(|script| {
        script.apply_failures.push_back((outcome_unknown(), false));
        script.scene_get =
            Some(json!({"id": "program", "name": "Program", "sources": [], "outputs": []}));
        script.backend_layout = Some(json!({"layoutPreset": "side-by-side"}));
    });
    assert!(!studio.apply_layout_preset("screen-camera").await);
    settled(&studio).await;
    let snapshot = studio.snapshot();
    assert_eq!(
        snapshot.settings.capture_doc["layout"]["layoutPreset"],
        "side-by-side"
    );
    assert_eq!(
        snapshot.scenes.on_stream_id.as_deref(),
        Some("default-screen-only")
    );
    assert_eq!(
        stored_scene(&backend, "default-screen-only").unwrap()["layouts"]["horizontal"]["layoutPreset"],
        "screen-only"
    );
    assert!(!said(&mut notices).is_empty());

    // The answer was lost but the backend shows the requested scene at a
    // newer revision: it counts as committed, and nothing is said.
    backend.with(|script| script.apply_failures.push_back((outcome_unknown(), true)));
    assert!(studio.apply_layout_preset("screen-camera").await);
    settled(&studio).await;
    assert_eq!(
        studio.snapshot().settings.capture_doc["layout"]["layoutPreset"],
        "screen-camera"
    );
    assert!(said(&mut notices).is_empty());

    // A failure that never reached the backend's scene is never success,
    // whatever the backend shows.
    backend.with(|script| {
        script.apply_failures.push_back((
            RpcError::new("scene.layout.apply_preview", "scene-commit-failed", "no"),
            true,
        ))
    });
    assert!(!studio.apply_layout_preset("side-by-side").await);
    settled(&studio).await;
    assert!(!said(&mut notices).is_empty());
}

#[tokio::test]
async fn every_apply_but_the_followers_is_heard_by_the_manual_apply_listeners() {
    let (_backend, studio) = scenes_studio(capture_config_with_camera()).await;
    let mut heard = studio.manual_scene_applies();
    assert!(apply(&studio, "default-screen-only").await);
    assert_eq!(heard.try_recv().unwrap(), "default-screen-only");

    assert!(
        studio
            .apply_saved_scene(
                "default-camera-only",
                None,
                ApplyOptions {
                    origin_follow: true,
                    ..ApplyOptions::default()
                },
            )
            .await
            .ok
    );
    settled(&studio).await;
    assert!(heard.try_recv().is_err(), "the follower's own apply");
}

#[tokio::test]
async fn the_scene_on_stream_is_modified_by_a_look_it_has_not_taken() {
    let (_backend, studio) = scenes_studio(capture_config_with_camera()).await;
    assert!(apply(&studio, "default-screen-only").await);
    assert!(!studio.snapshot().scenes.saved_scene_modified);
    // A layout written without a transaction (no D11 save into the scene).
    studio
        .update_capture_config(|config| {
            config["layout"]["layoutPreset"] = json!("side-by-side");
        })
        .await
        .unwrap();
    assert!(studio.snapshot().scenes.saved_scene_modified);
    // Another screen is not part of it (D18).
    studio
        .update_capture_config(|config| {
            config["layout"]["layoutPreset"] = json!("screen-only");
            config["sources"]["screenId"] = json!("screen:screencapturekit:2");
        })
        .await
        .unwrap();
    assert!(!studio.snapshot().scenes.saved_scene_modified);
}

// --- S1.6b part 4a: the camera's background (plan 258) ---

#[tokio::test]
async fn a_background_pick_is_the_cameras_and_every_commit_carries_it() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    // The D4 migration settled at launch: no scene keys, nothing moved.
    let settings = stored_json(&backend, keys::SETTINGS).unwrap();
    assert_eq!(settings["cameraBackgroundMigration"], 1);
    assert!(settings.get("cameraBackgrounds").is_none());

    let blur = json!({"mode": "blur", "blurPct": 70, "edges": "balanced"});
    assert!(studio.apply_camera_background(&blur).await);
    settled(&studio).await;
    let settings = stored_json(&backend, keys::SETTINGS).unwrap();
    assert_eq!(settings["cameraBackgrounds"]["camera:1"], blur);
    assert_eq!(settings["cameraBackgroundMigration"], 1);
    let commits = layout_commits(&backend);
    let (_, params) = commits.last().expect("the pick commits");
    assert_eq!(params["layout"]["cameraBackground"], blur);
    // Never stored on the capture config.
    let stored = stored_json(&backend, keys::CAPTURE_CONFIG).unwrap();
    assert!(stored["layout"].get("cameraBackground").is_none());
    // A scene switch afterwards carries it too.
    assert!(apply(&studio, "default-screen-only").await);
    let commits = layout_commits(&backend);
    assert_eq!(
        commits.last().unwrap().1["layout"]["cameraBackground"],
        blur
    );
    // Off leaves it off the wire.
    let off = json!({"mode": "off", "blurPct": 70, "edges": "balanced"});
    assert!(studio.apply_camera_background(&off).await);
    settled(&studio).await;
    let commits = layout_commits(&backend);
    assert!(
        commits.last().unwrap().1["layout"]
            .get("cameraBackground")
            .is_none()
    );
}

#[tokio::test]
async fn no_camera_no_background_pick() {
    let (_backend, studio) = scenes_studio(json!({"recordEnabled": true})).await;
    assert!(
        !studio
            .apply_camera_background(&json!({"mode": "blur"}))
            .await
    );
}

// --- S1.6a part 6b: where recordings go ----------------------------------

async fn stop_to_idle(studio: &Studio<Scripted>) {
    studio.request_stop(StopOrigin::Button).await;
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(status(
            RecordingState::Idle,
            Some("s1"),
        ))))
        .await;
}

/// P3-D1: a chosen folder is a plain path in the store; every start
/// carries its capability from the app's issuer. A folder the issuer
/// refuses isn't available, a folder that is gone is refused by name, and
/// neither sends `session.start`; Use default goes back to the backend's
/// default folder. The facts land in the snapshot when a page reads them.
#[tokio::test]
async fn a_chosen_folder_rides_each_start_as_a_capability() {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use videorc_app_core::studio::OutputAuthorizer;
    use videorc_app_core::studio::recordings_folder::{StoredFolder, copy};

    let dir = tempfile::tempdir().unwrap();
    let takes = dir.path().join("Takes");
    std::fs::create_dir(&takes).unwrap();

    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    studio.set_test_pattern(true).await.unwrap();

    // The default folder: nothing rides, and there are no facts to read.
    assert_eq!(studio.recordings_folder(), None);
    assert_eq!(studio.read_recordings_folder_facts().await, None);
    assert!(!studio.snapshot().recordings_folder.view().custom);
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    stop_to_idle(&studio).await;

    // Choose…: the folder, and an issuer that answers with a capability.
    let asked: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
    let refuse = Arc::new(AtomicBool::new(false));
    let authorize: OutputAuthorizer = {
        let asked = asked.clone();
        let refuse = refuse.clone();
        Arc::new(move |path: PathBuf| {
            asked.lock().unwrap().push(path);
            let refused = refuse.load(Ordering::SeqCst);
            Box::pin(async move {
                if refused {
                    Err("The issuer said no.".to_string())
                } else {
                    Ok("resource:folder-1".to_string())
                }
            })
        })
    };
    studio.set_output_authorizer(authorize);
    studio
        .set_recordings_folder(StoredFolder::picked(takes.clone()))
        .await;
    let stored = backend
        .script
        .lock()
        .unwrap()
        .settings
        .get(keys::RECORDINGS_FOLDER)
        .cloned();
    let stored: Value =
        serde_json::from_str(stored.as_ref().and_then(Value::as_str).unwrap()).unwrap();
    assert_eq!(
        stored,
        json!({"path": takes.to_str().unwrap(), "displayName": "Takes"}),
        "a plain path the backend's store holds, as the store keeps every value"
    );
    let snapshot = studio.snapshot();
    assert_eq!(
        snapshot
            .recordings_folder
            .folder
            .as_ref()
            .map(|folder| folder.display_name.as_str()),
        Some("Takes")
    );
    assert_eq!(snapshot.recordings_folder.facts, None, "not read at launch");
    let facts = studio.read_recordings_folder_facts().await.unwrap();
    assert!(facts.exists && facts.writable);
    let view = studio.snapshot().recordings_folder.view();
    assert_eq!(view.path, "Takes");
    assert!(view.custom && view.can_reveal && view.problem.is_none());

    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    assert_eq!(*asked.lock().unwrap(), std::slice::from_ref(&takes));
    stop_to_idle(&studio).await;

    // The issuer refuses: not available, nothing sent.
    refuse.store(true, Ordering::SeqCst);
    let starts = backend.count("session.start");
    assert_eq!(
        studio.start_recording().await,
        StartOutcome::Refused {
            message: copy::FOLDER_UNAVAILABLE.to_string()
        }
    );
    assert_eq!(backend.count("session.start"), starts);
    assert_eq!(studio.snapshot().session.phase, SessionPhase::Idle);

    // The folder is gone: refused by its name, the issuer never asked.
    refuse.store(false, Ordering::SeqCst);
    std::fs::remove_dir(&takes).unwrap();
    let asks = asked.lock().unwrap().len();
    assert_eq!(
        studio.start_recording().await,
        StartOutcome::Refused {
            message: copy::folder_missing("Takes")
        }
    );
    assert_eq!(asked.lock().unwrap().len(), asks);
    assert_eq!(backend.count("session.start"), starts);
    assert_eq!(
        studio
            .snapshot()
            .session
            .start_failure
            .map(|failure| failure.message),
        Some(copy::folder_missing("Takes"))
    );

    // Use default: the store forgets it and the next start sends none.
    studio.use_default_recordings_folder().await;
    assert_eq!(studio.recordings_folder(), None);
    assert_eq!(studio.snapshot().recordings_folder.folder, None);
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    assert_eq!(
        backend.script.lock().unwrap().started_into,
        [None, Some("resource:folder-1".to_string()), None]
    );
}

// --- S1.6b part 5e: the window rebind, the resolver's app state, the editor's reload ---

const ALPHA_OLD: &str = "window:screencapturekit:40696";
const ALPHA_NEW: &str = "window:screencapturekit:51234";
const ALPHA: &str = "Fixture Alpha - Alpha";

/// A launched Studio whose capture is the window `ALPHA`, listed under its
/// old id.
async fn window_studio() -> (Arc<Scripted>, Arc<Studio<Scripted>>) {
    let backend = Scripted::new();
    let config = json!({
        "recordEnabled": true,
        "sources": {"windowId": ALPHA_OLD, "windowName": ALPHA, "cameraOff": true}
    });
    backend.with(|script| {
        script.windows = vec![(ALPHA_OLD.to_string(), ALPHA.to_string())];
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(config.to_string()),
        );
    });
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    assert_eq!(
        studio.snapshot().settings.capture_doc["sources"]["windowId"],
        ALPHA_OLD
    );
    (backend, studio)
}

/// Plan 219 S3 (`window-source-rebind.test.ts`): a window closed and
/// reopened under a new id is picked up again at Record, with one
/// window-list read before `session.start`, and the pick keeps its new id.
#[tokio::test]
async fn a_window_reopened_under_a_new_id_is_picked_up_again_at_record() {
    let (backend, studio) = window_studio().await;
    // Closed and reopened: the list names it under a new id; no event came.
    backend.with(|script| script.windows = vec![(ALPHA_NEW.to_string(), ALPHA.to_string())]);
    let reads = backend.count("devices.list");
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    assert_eq!(
        backend.count("devices.list"),
        reads + 1,
        "one window-list read"
    );
    {
        let script = backend.script.lock().unwrap();
        assert_eq!(
            script.started_with[0].sources.window_id.as_deref(),
            Some(ALPHA_NEW)
        );
        assert_eq!(
            script
                .screen_starts
                .last()
                .unwrap()
                .sources
                .window_id
                .as_deref(),
            Some(ALPHA_NEW),
            "the session's capture starts on the window's new id"
        );
    }
    let snapshot = studio.snapshot();
    assert_eq!(
        snapshot.settings.capture_doc["sources"]["windowId"],
        ALPHA_NEW
    );
    assert_eq!(
        snapshot.settings.capture_doc["sources"]["windowName"],
        ALPHA
    );
    assert!(snapshot.sources.device(ALPHA_NEW).is_some());
    assert_eq!(
        stored_json(&backend, keys::CAPTURE_CONFIG).unwrap()["sources"]["windowId"],
        ALPHA_NEW
    );
}

/// Plan 219 S3: no match leaves the pick alone (the backend names the
/// refusal), and a capture already live on the picked window costs no read.
#[tokio::test]
async fn a_window_with_no_match_or_already_live_is_left_alone_at_record() {
    let (backend, studio) = window_studio().await;
    // Closed for good: nothing of that name (and never a display).
    backend.with(|script| script.windows.clear());
    let reads = backend.count("devices.list");
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    assert_eq!(backend.count("devices.list"), reads + 1);
    assert_eq!(
        backend.script.lock().unwrap().started_with[0]
            .sources
            .window_id
            .as_deref(),
        Some(ALPHA_OLD)
    );
    assert_eq!(
        studio.snapshot().settings.capture_doc["sources"]["windowId"],
        ALPHA_OLD
    );

    // Live on the picked window: the record-latency budget, no round trip.
    let (backend, studio) = window_studio().await;
    studio
        .handle_event(BackendEvent::Untyped {
            event: "preview.screen.status".to_string(),
            payload: json!({"state": "live", "sourceId": ALPHA_OLD}),
        })
        .await;
    let reads = backend.count("devices.list");
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    assert_eq!(backend.count("devices.list"), reads);
}

/// Plan 210 D1: the working sources' reconcile says what the resolver found
/// about the app of the scene on stream ("Figma's window is minimized"),
/// not the device list's guess ("isn't open"); a new device list clears it
/// and asks again.
#[tokio::test]
async fn the_reconcile_keeps_what_the_resolver_said_about_the_scenes_app() {
    use videorc_app_core::scenes::window::{AppWindowFailure, SceneAppState};
    // A profile whose scene on stream was made for Figma.
    let (backend, first) = scenes_studio(capture_config_with_camera()).await;
    assert!(apply(&first, "default-screen-only").await);
    drop(first);
    let figma = json!({"bundleId": "com.figma.Desktop", "name": "Figma", "follows": false});
    let mut library = stored_json(&backend, keys::SCENES).unwrap();
    for scene in library["scenes"].as_array_mut().unwrap() {
        if scene["id"] == "default-screen-only" {
            let mut shows = figma.clone();
            shows["kind"] = json!("app");
            scene["shows"] = shows;
        }
    }
    let mut working = stored_json(&backend, keys::WORKING_SCENE).unwrap();
    working["visual"]["sources"]["app"] = figma;
    backend.with(|script| {
        script
            .settings
            .insert(keys::SCENES.to_string(), Value::String(library.to_string()));
        script.settings.insert(
            keys::WORKING_SCENE.to_string(),
            Value::String(working.to_string()),
        );
        script.app_window = Some(json!({"ok": false, "reason": "minimized"}));
    });

    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let snapshot = studio.snapshot();
    assert_eq!(
        snapshot.scenes.on_stream_id.as_deref(),
        Some("default-screen-only")
    );
    let asked = backend.script.lock().unwrap().resolver_calls.clone();
    assert!(
        !asked.is_empty(),
        "the launch's reconcile asks the resolver"
    );
    assert_eq!(asked[0]["bundleId"], "com.figma.Desktop");
    assert_eq!(
        snapshot.scenes.app_states.get("default-screen-only"),
        Some(&SceneAppState::Failed(AppWindowFailure::Minimized))
    );

    // A new device list clears the answer, and the reconcile asks again.
    backend.with(|script| script.app_window = Some(json!({"ok": false, "reason": "no-window"})));
    studio
        .handle_event(BackendEvent::DevicesChanged(Box::new(devices(&[
            "camera:1",
            "screen:screencapturekit:1",
        ]))))
        .await;
    assert_eq!(
        backend.script.lock().unwrap().resolver_calls.len(),
        asked.len() + 1
    );
    assert_eq!(
        studio
            .snapshot()
            .scenes
            .app_states
            .get("default-screen-only"),
        Some(&SceneAppState::Failed(AppWindowFailure::NoWindow))
    );
}

/// Every `scene.load_from_capture_config` asked for.
fn loads(backend: &Scripted) -> Vec<Value> {
    backend.script.lock().unwrap().scene_loads.clone()
}

/// `switchSourceDeviceLive`: the scene editor holds the idle reload, so an
/// idle screen or camera pick made while it is open loads the scene with
/// the pick; with the editor closed the preview feed's idle reload does.
#[tokio::test]
async fn an_idle_pick_in_the_scene_editor_loads_the_scene() {
    use videorc_app_core::studio::source_selection::SourceKind;
    let backend = Scripted::new();
    backend.with(|script| {
        script.device_ids = Some(vec![
            "camera:1".to_string(),
            "screen:screencapturekit:1".to_string(),
            "screen:screencapturekit:2".to_string(),
        ]);
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(capture_config_with_camera().to_string()),
        );
        script.scene_load = Some(json!({"scene": serde_json::to_value(scene()).unwrap()}));
    });
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;

    // The editor closed: the pick lands and loads nothing here.
    studio
        .select_source_device(SourceKind::Capture, Some("screen:screencapturekit:2"))
        .await
        .expect("the pick lands");
    assert!(loads(&backend).is_empty());

    studio.set_scene_edit_mode(true);
    assert!(studio.snapshot().scene_edit_mode);
    studio
        .select_source_device(SourceKind::Capture, Some("screen:screencapturekit:1"))
        .await
        .expect("the pick lands");
    let loaded = loads(&backend);
    assert_eq!(loaded.len(), 1, "the editor's scene loads with the pick");
    assert_eq!(
        loaded[0]["sources"]["screenId"],
        "screen:screencapturekit:1"
    );
    assert_eq!(loaded[0]["sources"]["cameraId"], "camera:1");
    // The camera's Off is a pick too.
    studio
        .select_source_device(SourceKind::Camera, None)
        .await
        .expect("the pick lands");
    assert_eq!(loads(&backend).len(), 2);

    studio.set_scene_edit_mode(false);
    assert!(!studio.snapshot().scene_edit_mode);
}

// --- S1.6c: the platform accounts --------------------------------------

/// Queues one answer for a livestream method.
fn answer_livestream(backend: &Scripted, method: &str, value: Value) {
    backend
        .script
        .lock()
        .unwrap()
        .livestream
        .entry(method.to_string())
        .or_default()
        .push_back(Ok(value));
}

fn livestream_methods(backend: &Scripted) -> Vec<String> {
    backend
        .script
        .lock()
        .unwrap()
        .livestream_calls
        .iter()
        .map(|(method, _)| method.clone())
        .collect()
}

#[tokio::test]
async fn a_second_output_check_joins_the_one_running_and_hears_its_rejection() {
    use videorc_app_core::livestream::ready::Topology;

    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| {
        script.livestream_gate = Some(gate.clone());
        script
            .livestream
            .entry("stream.output.topology.probe".to_string())
            .or_default()
            .push_back(Err(RpcError::new(
                "stream.output.topology.probe",
                "rejected",
                "The split output isn't available.",
            )));
    });
    let params = json!({ "stream": { "width": 1920 } });
    let first = studio.check_stream_output(params.clone(), false);
    let second = studio.check_stream_output(params.clone(), false);
    let release = async {
        tokio::task::yield_now().await;
        gate.add_permits(1);
    };
    let (first, second, ()) = tokio::join!(first, second, release);
    let failed = Topology::Failed {
        key: videorc_app_core::livestream::ready::probe_key(&params),
        message: "The split output isn't available.".to_string(),
    };
    assert_eq!(first, Some(failed.clone()));
    assert_eq!(second, Some(failed));
    assert_eq!(
        livestream_methods(&backend)
            .iter()
            .filter(|method| *method == "stream.output.topology.probe")
            .count(),
        1
    );

    // A check that never answers (its caller went away) is no pass either.
    let abandoned = studio.check_stream_output(json!({ "stream": { "width": 1280 } }), false);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(10), abandoned)
            .await
            .is_err()
    );
    assert_eq!(studio.details_now().topology, Topology::NotRequested);
}

#[tokio::test]
async fn the_bootstrap_reads_the_accounts_and_an_announcement_closes_the_browser_toast() {
    let backend = Scripted::new();
    answer_livestream(
        &backend,
        "platformAccounts.list",
        json!([{ "platform": "x", "accountId": "x1" }]),
    );
    let studio = new_studio(&backend);
    let mut notices = studio.notices();
    studio.handle_event(ready()).await;

    let platforms = studio.platforms_now();
    assert!(platforms.loaded);
    assert_eq!(platforms.accounts.len(), 1);
    assert_eq!(platforms.accounts[0].account_id, "x1");
    let methods = livestream_methods(&backend);
    for method in [
        "youtube.quota.status",
        "platformAccounts.list",
        "platformAccounts.oauth.providerCredentials",
        "platformAccounts.validate",
        "streamTargets.x.capability",
    ] {
        assert!(methods.iter().any(|m| m == method), "{method}: {methods:?}");
    }

    while notices.try_recv().is_ok() {}
    studio
        .handle_event(BackendEvent::Untyped {
            event: "platformAccounts.changed".to_string(),
            payload: json!([]),
        })
        .await;
    assert!(studio.platforms_now().accounts.is_empty());
    let mut dismissed = Vec::new();
    while let Ok(command) = notices.try_recv() {
        if let videorc_app_core::notices::NoticeCommand::Dismiss(id) = command {
            dismissed.push(id);
        }
    }
    assert_eq!(
        dismissed,
        [videorc_app_core::studio::BROWSER_APPROVAL_TOAST_ID]
    );
}

#[tokio::test]
async fn disconnecting_says_so_and_offline_asks_nothing() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    let mut notices = studio.notices();

    assert!(!studio.disconnect_platform("twitch").await);
    assert!(livestream_methods(&backend).is_empty());

    studio.handle_event(ready()).await;
    while notices.try_recv().is_ok() {}
    answer_livestream(&backend, "platformAccounts.disconnect", json!({}));
    assert!(studio.disconnect_platform("twitch").await);
    let mut titles = Vec::new();
    while let Ok(command) = notices.try_recv() {
        if let videorc_app_core::notices::NoticeCommand::Show(notice) = command {
            titles.push(notice.title.clone());
        }
    }
    assert!(
        titles.iter().any(|t| t == "Disconnected Twitch"),
        "{titles:?}"
    );
}

#[tokio::test]
async fn a_youtube_quota_event_pauses_youtube_until_its_time() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    studio
        .handle_event(BackendEvent::Untyped {
            event: "youtube.quota".to_string(),
            payload: json!({ "pausedUntil": "2035-01-01T08:00:00.000Z" }),
        })
        .await;
    assert_eq!(
        studio.platforms_now().youtube_quota_paused_until.as_deref(),
        Some("2035-01-01T08:00:00.000Z")
    );
    studio
        .handle_event(BackendEvent::Untyped {
            event: "youtube.quota".to_string(),
            payload: json!({ "pausedUntil": "soon" }),
        })
        .await;
    assert_eq!(studio.platforms_now().youtube_quota_paused_until, None);
}

// --- S1.6c: Stream details and Discord ---------------------------------

fn draft(title: &str) -> Value {
    json!({
        "title": title,
        "description": "",
        "defaultPrivacy": "unlisted",
        "targetOverrides": [],
    })
}

#[tokio::test]
async fn the_bootstrap_reads_the_draft_its_validation_and_discord() {
    let backend = Scripted::new();
    answer_livestream(&backend, "streamTargets.metadata.get", draft("Today"));
    answer_livestream(
        &backend,
        "streamTargets.metadata.validate",
        json!({ "valid": false, "issues": [{ "field": "title", "message": "Too long." }] }),
    );
    answer_livestream(&backend, "discord.announce.get", json!({ "enabled": true }));
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;

    let details = studio.details_now();
    assert_eq!(
        details.draft.as_ref().map(|d| d.title.as_str()),
        Some("Today")
    );
    let validation = details.validation.expect("validated");
    assert!(!validation.valid);
    assert_eq!(validation.issues.len(), 1);
    assert!(details.discord.expect("discord").enabled);
    assert_eq!(details.discord_error, None);
}

#[tokio::test]
async fn a_changed_draft_is_taken_and_validated_again() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    assert_eq!(
        studio.details_now().discord_error.as_deref(),
        Some(videorc_app_core::livestream::copy::DISCORD_UNREADABLE)
    );

    answer_livestream(
        &backend,
        "streamTargets.metadata.validate",
        json!({ "valid": true }),
    );
    studio
        .handle_event(BackendEvent::Untyped {
            event: "streamTargets.metadata.changed".to_string(),
            payload: draft("Later"),
        })
        .await;
    let details = studio.details_now();
    assert_eq!(details.draft.map(|d| d.title), Some("Later".to_string()));
    assert!(details.validation.expect("validated").valid);
}

#[tokio::test]
async fn a_category_search_needs_two_characters_and_reads_numeric_ids() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let before = livestream_methods(&backend).len();

    studio.search_categories("twitch", " g ").await;
    assert_eq!(livestream_methods(&backend).len(), before);
    assert_eq!(studio.details_now().category_searched, None);

    answer_livestream(
        &backend,
        "streamTargets.twitch.searchCategories",
        json!({ "categories": [{ "id": 509658, "name": "Just Chatting" }] }),
    );
    studio.search_categories("twitch", "ju").await;
    let details = studio.details_now();
    assert_eq!(
        details.category_results,
        [("509658".to_string(), "Just Chatting".to_string())]
    );
    assert_eq!(details.category_searched.as_deref(), Some("ju"));
    assert!(!details.category_pending);
    let script = backend.script.lock().unwrap();
    let (_, params) = script.livestream_calls.last().expect("a search");
    assert_eq!(params["first"], 10);
    assert_eq!(params["query"], "ju");
}

// --- S1.6c: plan 226's chat commands -----------------------------------

#[tokio::test]
async fn a_failed_list_read_says_so_until_a_state_arrives() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let store = studio.chat_commands_now();
    assert!(store.load_failed);
    assert_eq!(store.state, None);

    studio
        .handle_event(BackendEvent::Untyped {
            event: "chatCommands.changed".to_string(),
            payload: json!({ "commands": [], "listEnabled": true }),
        })
        .await;
    let store = studio.chat_commands_now();
    assert!(!store.load_failed);
    assert!(store.state.expect("a state").list_enabled);
}

#[tokio::test]
async fn a_reply_failure_is_kept_once_per_chat_and_reason() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let failure = json!({
        "sessionId": "s1",
        "destinationId": "yt",
        "platform": "youtube",
        "command": "go",
        "reason": "Chat is off.",
    });
    for _ in 0..2 {
        studio
            .handle_event(BackendEvent::Untyped {
                event: "chatCommands.replyFailed".to_string(),
                payload: failure.clone(),
            })
            .await;
    }
    let failures = studio.chat_commands_now().failures;
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].reason, "Chat is off.");
}

#[tokio::test]
async fn a_save_refusal_goes_under_its_field_and_a_saved_state_is_taken() {
    use videorc_app_core::livestream::chat_commands::{Field, save_params};
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    backend
        .script
        .lock()
        .unwrap()
        .livestream
        .entry("chatCommands.save".to_string())
        .or_default()
        .push_back(Err(RpcError::new(
            "chatCommands.save",
            "invalid-params",
            "!go already exists.",
        )));
    let params = save_params(None, "go", "why", "because");
    let refusal = studio.save_chat_command(&params).await.expect("refused");
    assert_eq!(refusal.field, Some(Field::Name));
    assert_eq!(refusal.message, "!go already exists.");

    answer_livestream(
        &backend,
        "chatCommands.save",
        json!({
            "commands": [{ "id": "c1", "name": "go", "description": "why", "reply": "because", "enabled": true, "createdAt": "2035-01-01T00:00:00.000Z", "updatedAt": "2035-01-01T00:00:00.000Z" }],
            "listEnabled": true,
        }),
    );
    assert_eq!(studio.save_chat_command(&params).await, None);
    let state = studio.chat_commands_now().state.expect("saved");
    assert_eq!(state.commands.len(), 1);
}

// --- S1.6c: Upcoming -----------------------------------------------------

#[test]
fn a_focus_asks_the_platforms_again_after_five_minutes() {
    use videorc_app_core::studio::scheduled::focus_refreshes_providers;
    assert!(focus_refreshes_providers(0, 300_000));
    assert!(!focus_refreshes_providers(1, 300_000));
    assert!(focus_refreshes_providers(1_000, 301_000));
}

#[tokio::test]
async fn the_bootstrap_reads_upcoming_and_a_failed_read_says_why_with_a_period() {
    let backend = Scripted::new();
    answer_livestream(
        &backend,
        "scheduledStreams.list",
        json!([{ "id": "e1", "lifecycle": "scheduled" }]),
    );
    answer_livestream(
        &backend,
        "scheduledStreams.capabilities",
        json!({ "available": false }),
    );
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let state = studio.scheduled_now();
    assert!(state.loaded);
    assert_eq!(state.events.len(), 1);
    assert_eq!(state.error, None);
    assert_eq!(state.last_checked_at, None);

    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let error = studio.scheduled_now().error.expect("a load error");
    assert!(
        error.starts_with("Couldn't load upcoming streams. "),
        "{error}"
    );
}

#[tokio::test]
async fn upcoming_asks_the_platforms_without_holding_the_studio_events() {
    use std::time::Duration;

    let backend = Scripted::new();
    answer_livestream(
        &backend,
        "scheduledStreams.list",
        json!([{ "id": "e1", "lifecycle": "scheduled", "providerEventId": "p1" }]),
    );
    answer_livestream(
        &backend,
        "scheduledStreams.capabilities",
        json!({ "available": true }),
    );
    answer_livestream(
        &backend,
        "scheduledStreams.refresh",
        json!({ "state": "complete", "result": {} }),
    );
    answer_livestream(&backend, "scheduledStreams.list", json!([]));
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| {
        script.livestream_held = Some(("scheduledStreams.refresh".to_string(), gate.clone()));
    });
    let studio = new_studio(&backend);
    let (events, receiver) = broadcast::channel(16);
    let driver = tokio::spawn(Arc::clone(&studio).drive(receiver));
    events.send(ready()).unwrap();
    let asked = async {
        while !backend.script.lock().unwrap().held_reached {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(5), asked)
        .await
        .expect("the platforms are asked");

    // The platforms are still answering; the session's status lands anyway.
    events
        .send(BackendEvent::RecordingStatus(Box::new(live("s-1"))))
        .unwrap();
    let landed = async {
        while studio.snapshot().session.phase == SessionPhase::Idle {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(5), landed)
        .await
        .expect("the status lands while the platforms are asked");
    assert_eq!(studio.scheduled_now().last_checked_at, None);

    gate.add_permits(1);
    let checked = async {
        while studio.scheduled_now().last_checked_at.is_none() {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(5), checked)
        .await
        .expect("the check finishes");
    driver.abort();
}

#[tokio::test]
async fn a_failed_change_names_its_verb_drops_the_code_and_clears_pending() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);

    let offline = studio
        .scheduled_mutate("cancel", json!({ "eventId": "e1" }))
        .await
        .expect_err("offline");
    assert_eq!(offline.message, "Videorc is reconnecting.");
    assert_eq!(studio.scheduled_now().error, None);

    studio.handle_event(ready()).await;
    answer_livestream(
        &backend,
        "scheduledStreams.cancel",
        json!({ "state": "failed", "error": { "code": "youtube-quota", "message": "YouTube said no." } }),
    );
    let error = studio
        .scheduled_mutate("cancel", json!({ "eventId": "e1" }))
        .await
        .expect_err("refused");
    assert_eq!(error.code, "scheduled-operation");
    assert_eq!(error.message, "YouTube said no.");
    let state = studio.scheduled_now();
    assert!(state.pending.is_empty());
    let line = state.error.expect("the line");
    assert!(line.starts_with("Couldn't cancel the event. "), "{line}");
}

fn shown_titles(
    notices: &mut tokio::sync::broadcast::Receiver<videorc_app_core::notices::NoticeCommand>,
) -> Vec<String> {
    let mut titles = Vec::new();
    while let Ok(command) = notices.try_recv() {
        if let videorc_app_core::notices::NoticeCommand::Show(notice) = command {
            titles.push(notice.title.clone());
        }
    }
    titles
}

#[tokio::test]
async fn go_live_with_nothing_ready_offers_destinations_and_never_opens() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    let mut notices = studio.notices();

    studio.open_go_live().await;

    let state = studio.go_live_now();
    assert!(!state.open && !state.pending);
    assert!(livestream_methods(&backend).is_empty());
    let titles = shown_titles(&mut notices);
    assert!(
        titles
            .iter()
            .any(|t| t == "Set up a destination to go live"),
        "{titles:?}"
    );
}

#[tokio::test]
async fn an_x_playback_check_is_told_once_per_broadcast_and_status() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let mut notices = studio.notices();
    let verified = || BackendEvent::Untyped {
        event: "streamTargets.x.playback".into(),
        payload: json!({ "broadcastId": "b1", "status": "verified", "shareUrl": "https://x.com/i/broadcasts/b1" }),
    };

    studio.handle_event(verified()).await;
    let titles = shown_titles(&mut notices);
    assert_eq!(
        titles,
        vec!["Viewers can watch your X broadcast".to_string()]
    );

    studio.handle_event(verified()).await;
    assert!(shown_titles(&mut notices).is_empty());
}

fn shown_ids(
    notices: &mut tokio::sync::broadcast::Receiver<videorc_app_core::notices::NoticeCommand>,
) -> Vec<String> {
    let mut ids = Vec::new();
    while let Ok(command) = notices.try_recv() {
        if let videorc_app_core::notices::NoticeCommand::Show(notice) = command {
            ids.extend(notice.id.clone());
        }
    }
    ids
}

fn cloud_state(payload: Value) -> BackendEvent {
    BackendEvent::Untyped {
        event: "cloud.state".into(),
        payload,
    }
}

#[tokio::test]
async fn a_hand_off_latches_what_it_stopped_until_this_computer_is_back_on_air() {
    let backend = Scripted::new();
    answer_livestream(
        &backend,
        "cloud.status",
        json!({ "phase": "off", "entitled": true }),
    );
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let state = studio.cloud_now();
    assert_eq!(state.status.expect("read at bootstrap").phase, "off");
    assert!(state.handed_off.is_empty());

    studio
        .handle_event(cloud_state(json!({
            "phase": "hold",
            "stoppedBy": "hand-off",
            "sessionId": "s1",
            "show": { "id": "show1" },
            "onAir": { "thisDevice": false, "waiting": true },
        })))
        .await;
    assert_eq!(studio.cloud_now().handed_off, vec!["s1", "show1"]);

    studio
        .handle_event(cloud_state(json!({
            "phase": "live",
            "stoppedBy": "hand-off",
            "show": { "id": "show1" },
            "onAir": { "thisDevice": true, "waiting": false },
        })))
        .await;
    assert!(studio.cloud_now().handed_off.is_empty());
}

#[tokio::test]
async fn cloud_actions_toast_under_one_id_and_focus_asks_once_per_ten_seconds() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let mut notices = studio.notices();

    studio.set_cloud_settings(json!({ "enabled": true })).await;
    assert_eq!(shown_ids(&mut notices), vec!["videorc-cloud".to_string()]);

    answer_livestream(
        &backend,
        "cloud.show.handOff",
        json!({ "confirmed": false }),
    );
    assert!(studio.hand_off_cloud_show().await);
    assert_eq!(shown_ids(&mut notices), vec!["videorc-cloud".to_string()]);
    assert!(!studio.hand_off_cloud_show().await);

    studio.check_cloud_show(20_000).await;
    studio.check_cloud_show(25_000).await;
    studio.check_cloud_show(30_000).await;
    let checks = livestream_methods(&backend)
        .into_iter()
        .filter(|m| m == "cloud.show.check")
        .count();
    assert_eq!(checks, 2);
}

// --- S1.6c: the activation against the stop ---------------------------------

#[tokio::test]
async fn a_late_ingest_reply_never_overwrites_what_the_stop_wrote() {
    let youtube = json!({
        "id": "youtube", "platform": "youtube", "label": "YouTube", "enabled": true,
        "authMode": "oauth", "accountId": "a1",
        "platformBroadcastId": "b1", "platformStreamId": "st1",
        "serverUrl": "rtmp://a.rtmp.youtube.com/live2", "streamKeyPresent": true,
        "status": { "state": "ready", "message": "Ready." },
        "createdAt": "2026-11-08T00:00:00Z", "updatedAt": "2026-11-08T00:00:00Z"
    });
    let mut capture = capture_config_with_twitch();
    let mut saved = youtube.clone();
    saved["enabled"] = json!(false);
    capture["streaming"]["targets"]
        .as_array_mut()
        .unwrap()
        .push(saved);
    let backend = Scripted::new();
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| {
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(capture.to_string()),
        );
        script.start_answers.push_back(Ok(live("s1")));
        script
            .stop_answers
            .push_back(Ok(status(RecordingState::Idle, Some("s1"))));
        script.livestream_held = Some((
            "streamTargets.youtube.streamStatus".to_string(),
            gate.clone(),
        ));
    });
    answer_livestream(
        &backend,
        "streamTargets.youtube.streamStatus",
        json!({ "active": true, "message": "YouTube is receiving video." }),
    );
    answer_livestream(
        &backend,
        "streamTargets.youtube.transition",
        json!({ "lifecycleStatus": "complete" }),
    );
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    assert_eq!(studio.start_livestream(None).await, StartOutcome::Started);

    // The ingest read is out when the streamer stops; the stop completes
    // the broadcast and only then does the read answer.
    let streaming = json!({ "enabled": true, "targets": [youtube] });
    let stop_then_answer = async {
        while !backend.script.lock().unwrap().held_reached {
            tokio::task::yield_now().await;
        }
        assert!(studio.stop().await);
        gate.add_permits(1);
    };
    tokio::join!(
        studio.activate_prepared_for_tests(streaming, "s1"),
        stop_then_answer
    );

    let capture = studio.snapshot().settings.capture_doc;
    let target = capture["streaming"]["targets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|target| target["id"] == "youtube")
        .cloned()
        .expect("the YouTube destination");
    assert_eq!(target["status"]["state"], "stopped", "{target}");
    let script = backend.script.lock().unwrap();
    let transitions: Vec<&Value> = script
        .livestream_calls
        .iter()
        .filter(|(method, _)| method == "streamTargets.youtube.transition")
        .map(|(_, params)| &params["status"])
        .collect();
    assert_eq!(transitions, [&json!("complete")]);
}

// --- The talk show's Stop recording (`cloud.recording.stop`) -------------

/// A talk show's status with the room open.
fn talk_show_status(show: &str, recording: bool) -> Value {
    json!({
        "phase": "live",
        "show": { "id": show, "kind": "talk" },
        "room": { "phase": "open", "live": false, "connected": true },
        "recording": { "active": recording, "seconds": 12 }
    })
}

async fn talk_show_studio(recording: bool) -> (Arc<Scripted>, Arc<Studio<Scripted>>) {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    studio
        .handle_event(BackendEvent::Untyped {
            event: "cloud.state".to_string(),
            payload: talk_show_status("show-7", recording),
        })
        .await;
    (backend, studio)
}

fn cloud_outputs(
    studio: &Studio<Scripted>,
) -> Option<videorc_app_core::studio::screen_views::TalkShowOutputs> {
    videorc_app_core::studio::screen_views::talk_show_room_in(&studio.cloud_now())
        .transport_outputs()
}

fn stop_calls(backend: &Scripted) -> usize {
    livestream_methods(backend)
        .iter()
        .filter(|method| *method == "cloud.recording.stop")
        .count()
}

const COULD_NOT_STOP: (&str, &str) = (
    "Couldn't stop the cloud recording",
    videorc_app_core::livestream::cloud_view::CLOUD_TOAST_ID,
);

#[tokio::test]
async fn stop_recording_in_an_open_room_stops_the_cloud_recording_and_reads_stopping_meanwhile() {
    let (backend, studio) = talk_show_studio(true).await;
    let outputs = cloud_outputs(&studio).expect("the room is open");
    assert!(outputs.recording && !outputs.stopping);

    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| {
        script.livestream_held = Some(("cloud.recording.stop".to_string(), gate.clone()));
    });
    answer_livestream(
        &backend,
        "cloud.recording.stop",
        talk_show_status("show-7", false),
    );
    let mut notices = studio.notices();
    let stop = tokio::spawn({
        let studio = studio.clone();
        async move { studio.stop_cloud_recording().await }
    });
    let asked = async {
        while !backend.script.lock().unwrap().held_reached {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), asked)
        .await
        .expect("the stop is sent");

    // Record reads "Stopping…" while the request is out, and a second
    // click sends nothing.
    assert!(cloud_outputs(&studio).unwrap().stopping);
    assert!(!studio.stop_cloud_recording().await);

    gate.add_permits(1);
    assert!(stop.await.unwrap(), "the answer says it stopped");
    let outputs = cloud_outputs(&studio).unwrap();
    assert!(!outputs.recording && !outputs.stopping);
    assert!(!studio.cloud_now().recording_stop_pending);
    assert_eq!(stop_calls(&backend), 1);
    assert_eq!(said(&mut notices), []);
}

#[tokio::test]
async fn a_cloud_recording_stop_that_did_not_happen_says_so_once() {
    let expected = vec![(
        COULD_NOT_STOP.0.to_string(),
        Some(COULD_NOT_STOP.1.to_string()),
    )];

    // The backend refused.
    let (backend, studio) = talk_show_studio(true).await;
    backend.with(|script| {
        script
            .livestream
            .entry("cloud.recording.stop".to_string())
            .or_default()
            .push_back(Err(RpcError::new(
                "cloud.recording.stop",
                "failed",
                "The runner did not answer.",
            )));
    });
    let mut notices = studio.notices();
    assert!(!studio.stop_cloud_recording().await);
    assert_eq!(said(&mut notices), expected);
    assert!(!cloud_outputs(&studio).unwrap().stopping);

    // The answer still records: committed, and said.
    let (backend, studio) = talk_show_studio(true).await;
    answer_livestream(
        &backend,
        "cloud.recording.stop",
        talk_show_status("show-7", true),
    );
    let mut notices = studio.notices();
    assert!(!studio.stop_cloud_recording().await);
    assert_eq!(said(&mut notices), expected);
    assert!(cloud_outputs(&studio).unwrap().recording);

    // Nothing records: no request, and the same words.
    let (backend, studio) = talk_show_studio(false).await;
    let mut notices = studio.notices();
    assert!(!studio.stop_cloud_recording().await);
    assert_eq!(stop_calls(&backend), 0);
    assert_eq!(said(&mut notices), expected);
}

// --- The Resume notice's talk-show Resume (`cloud.room.resume`) ----------

#[tokio::test]
async fn resume_in_a_talk_show_rejoins_the_room_and_a_refusal_says_so_under_the_clouds_id() {
    let (backend, studio) = talk_show_studio(false).await;
    // The answer is the room's status: here, the cloud recording runs again.
    answer_livestream(
        &backend,
        "cloud.room.resume",
        talk_show_status("show-7", true),
    );
    assert!(!cloud_outputs(&studio).unwrap().recording);
    let mut notices = studio.notices();
    studio.resume_talk_room().await;
    fn resumes(backend: &Scripted) -> usize {
        livestream_methods(backend)
            .iter()
            .filter(|method| *method == "cloud.room.resume")
            .count()
    }
    assert_eq!(resumes(&backend), 1);
    assert!(
        cloud_outputs(&studio).unwrap().recording,
        "the answer is committed"
    );
    assert_eq!(said(&mut notices), []);

    backend.with(|script| {
        script
            .livestream
            .entry("cloud.room.resume".to_string())
            .or_default()
            .push_back(Err(RpcError::new(
                "cloud.room.resume",
                "failed",
                "The room did not answer.",
            )));
    });
    studio.resume_talk_room().await;
    assert_eq!(resumes(&backend), 2);
    let toasts = said(&mut notices);
    assert_eq!(toasts.len(), 1, "{toasts:?}");
    assert!(
        toasts[0].0.starts_with("Couldn't resume the show"),
        "{toasts:?}"
    );
    assert_eq!(
        toasts[0].1.as_deref(),
        Some(videorc_app_core::livestream::cloud_view::CLOUD_TOAST_ID)
    );
}

// --- The live dashboard's 1 s push (#1969 review) -------------------------

#[tokio::test]
async fn a_second_dashboard_change_within_a_second_still_reaches_the_store() {
    use videorc_app_core::stream_manager::dashboard::SessionState;

    let backend = Scripted::new();
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(live("s-dash"))))
        .await;
    // The session ends well within the push interval: the trailing push
    // must still go out on its own timer, with no tick from anyone.
    studio
        .handle_event(BackendEvent::RecordingStatus(Box::new(status(
            RecordingState::Idle,
            Some("s-dash"),
        ))))
        .await;
    let off_air = async {
        loop {
            let state = studio.dashboard_now();
            if state.session == SessionState::OffAir && state.session_id.is_some() {
                return state;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    };
    let state = tokio::time::timeout(std::time::Duration::from_secs(5), off_air)
        .await
        .expect("the trailing push lands within its second");
    assert_eq!(state.session_id.as_deref(), Some("s-dash"));
}

// --- S1.6b part 4c-2: the vertical stream at the start and on air --------

/// A 16:9 studio with a camera and a display, and one vertical destination
/// armed (the Output switch as `stream_enabled` says).
fn capture_config_with_vertical_destination(stream_enabled: bool) -> Value {
    let mut config = capture_config_with_twitch();
    config["streamEnabled"] = json!(stream_enabled);
    config["streaming"]["targets"][0]["outputOrientation"] = json!("vertical");
    config["sources"] = capture_config_with_camera()["sources"].clone();
    config
}

fn leg_sends(backend: &Scripted) -> Vec<Value> {
    backend.script.lock().unwrap().leg_sends.clone()
}

/// The 9:16 layout of a stored scene, as the Studio holds it.
fn vertical_layout_of(studio: &Studio<Scripted>, id: &str) -> Value {
    studio
        .snapshot()
        .scenes
        .library
        .expect("the library")
        .scenes
        .into_iter()
        .find(|scene| scene.id == id)
        .expect("the scene")
        .vertical
}

#[tokio::test]
async fn go_live_starts_the_vertical_stream_on_the_scene_on_streams_9_16_layout() {
    // The saved mode is Record only: the leg follows what the start does.
    let (backend, studio) = scenes_studio(capture_config_with_vertical_destination(false)).await;
    let on_stream = studio
        .snapshot()
        .scenes
        .on_stream_id
        .expect("a scene is always on stream");
    let vertical = vertical_layout_of(&studio, &on_stream);

    assert_eq!(studio.start_livestream(None).await, StartOutcome::Started);
    let leg = backend.script.lock().unwrap().started_with[0]
        .simulcast
        .clone()
        .expect("a vertical destination needs the leg");
    assert_eq!(
        serde_json::to_value(&leg.layout).unwrap()["layoutPreset"],
        vertical["layoutPreset"],
        "the scene on stream's 9:16 layout"
    );
    assert!(leg.video.width < leg.video.height, "a portrait canvas");
    assert!(leg.scene.is_none());

    // Record never streams: no leg, whatever is armed.
    stop_to_idle(&studio).await;
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    assert!(
        backend.script.lock().unwrap().started_with[1]
            .simulcast
            .is_none()
    );
}

#[tokio::test]
async fn a_scene_switch_on_air_cuts_the_vertical_stream_too_and_an_edit_of_its_layout_goes_live() {
    let (backend, studio) = scenes_studio(capture_config_with_vertical_destination(true)).await;
    assert_eq!(studio.start_livestream(None).await, StartOutcome::Started);
    studio.drain_vertical_leg().await;
    assert_eq!(
        leg_sends(&backend),
        Vec::<Value>::new(),
        "the start carried the leg"
    );

    // A commit sends the 9:16 layout of the scene it puts on stream.
    assert!(apply(&studio, "default-camera-only").await);
    studio.drain_vertical_leg().await;
    let vertical = vertical_layout_of(&studio, "default-camera-only");
    let sends = leg_sends(&backend);
    assert!(!sends.is_empty(), "the commit moved the leg");
    for send in &sends {
        assert_eq!(send["simulcastLeg"], true);
        assert_eq!(send["layout"]["layoutPreset"], vertical["layoutPreset"]);
        assert_eq!(send["sources"]["cameraId"], "camera:1");
        assert!(send["video"]["width"].as_u64() < send["video"]["height"].as_u64());
        assert!(send["intentId"].as_u64().unwrap() >= 1);
        assert!(send.get("background").is_none());
    }
    // The program's commits never carry the leg's flag.
    assert!(
        layout_commits(&backend)
            .iter()
            .all(|(_, params)| params.get("simulcastLeg").is_none())
    );

    // The Vertical stream panel's edit is no commit of the program: it goes
    // live on the vertical stream from here.
    let commits = layout_commits(&backend).len();
    let framing = if vertical["verticalScreenFraming"] == "fit" {
        "fill"
    } else {
        "fit"
    };
    let patch = json!({ "verticalScreenFraming": framing })
        .as_object()
        .cloned()
        .unwrap();
    assert!(studio.edit_vertical_stream_layout(patch).await);
    studio.drain_vertical_leg().await;
    let edited = leg_sends(&backend);
    assert_eq!(edited.len(), sends.len() + 1, "one send for the edit");
    assert_eq!(
        edited.last().unwrap()["layout"]["verticalScreenFraming"],
        framing
    );
    assert_eq!(layout_commits(&backend).len(), commits);

    // Any other write of that scene derives the leg already sent, which is
    // never sent twice.
    studio.cancel_stop();
    studio.drain_vertical_leg().await;
    assert_eq!(leg_sends(&backend).len(), edited.len());

    // Off air nothing is sent.
    stop_to_idle(&studio).await;
    let patch = json!({ "verticalScreenFraming": "fit" })
        .as_object()
        .cloned()
        .unwrap();
    studio.edit_vertical_stream_layout(patch).await;
    studio.drain_vertical_leg().await;
    assert_eq!(leg_sends(&backend).len(), edited.len());
}

#[tokio::test]
async fn a_leg_that_would_borrow_a_screen_puts_its_scene_on_again_once() {
    let (backend, studio) = scenes_studio(capture_config_with_vertical_destination(true)).await;
    // A Camera only scene that shows another display than the one captured.
    let library = studio.snapshot().scenes.library.unwrap();
    let mut talk = library
        .scenes
        .iter()
        .find(|scene| scene.id == "default-camera-only")
        .unwrap()
        .clone();
    talk.id = "talk".to_string();
    talk.name = "Talk".to_string();
    talk.shows = SceneShows::Display {
        screen_id: "screen:screencapturekit:2".to_string(),
        screen_name: Some("Second display".to_string()),
        screen_uuid: None,
    };
    assert!(
        studio
            .insert_scenes(&[talk], None, &Default::default())
            .await
    );
    // No leg draws a screen for it: it keeps the capture an earlier scene
    // left (D18), and nothing asks for its own.
    assert!(apply(&studio, "talk").await);
    let mut notices = studio.notices();
    let commits = layout_commits(&backend).len();
    studio.drain_vertical_leg().await;
    assert_eq!(layout_commits(&backend).len(), commits);
    assert_eq!(said(&mut notices), []);

    // Its 9:16 layout now draws a screen: the scene goes on again with its
    // own (a commit, or the refusal said), asked once.
    let patch = json!({ "layoutPreset": "vertical-screen-camera" })
        .as_object()
        .cloned()
        .unwrap();
    assert!(studio.edit_vertical_stream_layout(patch).await);
    studio.drain_vertical_leg().await;
    settled(&studio).await;
    let asked = layout_commits(&backend).len() - commits + said(&mut notices).len();
    assert!(asked > 0, "the scene was put on again");
    assert_eq!(
        leg_sends(&backend),
        Vec::<Value>::new(),
        "no session, no leg send"
    );
    let commits = layout_commits(&backend).len();
    studio.cancel_stop();
    studio.drain_vertical_leg().await;
    settled(&studio).await;
    assert_eq!(layout_commits(&backend).len(), commits, "asked once");
    assert_eq!(said(&mut notices), []);
}

// --- Plan 184 C5b: Resume a solo show (`cloud.show.resume`) ---------------

#[tokio::test]
async fn resume_starts_the_solo_show_again_bound_to_it_with_nothing_set_up() {
    use videorc_app_core::studio::session::SessionStartFailureKind;

    let backend = Scripted::new();
    backend.with(|script| {
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(capture_config_with_twitch().to_string()),
        );
        script
            .stop_answers
            .push_back(Ok(status(RecordingState::Idle, Some("s-show"))));
    });
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let asked = livestream_methods(&backend).len();

    assert!(studio.resume_cloud_show().await);
    assert_eq!(backend.count("cloud.show.resume"), 1);
    assert_eq!(backend.count("session.start"), 0, "never a plain start");
    let set_up: Vec<String> = livestream_methods(&backend)[asked..]
        .iter()
        .filter(|method| method.starts_with("streamTargets.") || method.starts_with("stream."))
        .cloned()
        .collect();
    assert_eq!(
        set_up,
        Vec::<String>::new(),
        "no preflight, no metadata update, no broadcast"
    );
    {
        let script = backend.script.lock().unwrap();
        let params = &script.resumed_with[0];
        // Go Live's livestream intent: the stream, and the recording the
        // Output page asks for.
        assert!(params.output.stream_enabled && params.output.record_enabled);
        let streaming = params.streaming.as_ref().expect("the saved destinations");
        // The saved streaming settings come normalized: every card in
        // `STREAM_TARGET_DEFS` order (YouTube first), with the user's
        // Twitch the one enabled.
        assert_eq!(streaming.enabled_target_ids, ["twitch"]);
        let twitch = streaming
            .targets
            .iter()
            .find(|target| target.id == "twitch")
            .expect("the Twitch card");
        assert!(twitch.enabled);
    }
    assert_eq!(
        studio.snapshot().session.status.session_id.as_deref(),
        Some("s-show")
    );

    // A refused resume is reported as one, and Retry resumes again.
    assert!(studio.stop().await);
    backend.with(|script| {
        script.resume_answers.push_back(Err(RpcError::new(
            "cloud.show.resume",
            "cloud-show-ended",
            "The cloud stream ended.",
        )));
    });
    assert!(!studio.resume_cloud_show().await);
    let failure = studio
        .snapshot()
        .session
        .start_failure
        .expect("the refusal");
    assert_eq!(failure.kind, SessionStartFailureKind::Resume);
    assert_eq!(failure.message, "The cloud stream ended.");
    assert_eq!(studio.retry_start().await, StartOutcome::Started);
    assert_eq!(backend.count("cloud.show.resume"), 3);
    assert_eq!(backend.count("session.start"), 0);
}

#[tokio::test]
async fn resume_is_refused_while_a_start_runs_and_says_why_when_blocked() {
    // Offline: refused with the reason, as Go Live is, and nothing is sent.
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    let mut notices = studio.notices();
    assert!(!studio.resume_cloud_show().await);
    assert_eq!(said(&mut notices).len(), 1);
    assert_eq!(backend.count("cloud.show.resume"), 0);

    // Busy: a start is on its way.
    let backend = Scripted::new();
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| {
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(capture_config_with_twitch().to_string()),
        );
        script.start_gate = Some(gate.clone());
    });
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    let resume_meanwhile = async {
        while backend.count("session.start") == 0 {
            tokio::task::yield_now().await;
        }
        let resumed = studio.resume_cloud_show().await;
        gate.add_permits(1);
        resumed
    };
    let (outcome, resumed) = tokio::join!(studio.start_recording(), resume_meanwhile);
    assert_eq!(outcome, StartOutcome::Started);
    assert!(!resumed);
    assert_eq!(backend.count("cloud.show.resume"), 0);
}

// --- #1888's drift: the platform cleanup around a start -------------------

/// A YouTube destination a Go Live prepared, as the session's owner holds
/// it.
fn prepared_youtube() -> Value {
    json!({
        "id": "youtube", "platform": "youtube", "label": "YouTube", "enabled": true,
        "authMode": "oauth", "accountId": "a1",
        "platformBroadcastId": "b1", "platformStreamId": "st1",
        "serverUrl": "rtmp://a.rtmp.youtube.com/live2", "streamKey": "",
        "streamKeyPresent": true,
        "status": { "state": "ready", "message": "Ready." },
        "createdAt": "2026-11-08T00:00:00Z", "updatedAt": "2026-11-08T00:00:00Z"
    })
}

fn youtube_transitions(backend: &Scripted) -> Vec<Value> {
    backend
        .script
        .lock()
        .unwrap()
        .livestream_calls
        .iter()
        .filter(|(method, _)| method == "streamTargets.youtube.transition")
        .map(|(_, params)| params["status"].clone())
        .collect()
}

#[tokio::test]
async fn a_record_start_first_finishes_the_last_livestreams_cleanup_or_is_refused() {
    let mut capture = capture_config_with_twitch();
    let mut saved = prepared_youtube();
    saved["enabled"] = json!(false);
    capture["streaming"]["targets"]
        .as_array_mut()
        .unwrap()
        .push(saved);
    let backend = Scripted::new();
    backend.with(|script| {
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(capture.to_string()),
        );
    });
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    // The last livestream's owner, its broadcast still to complete.
    let streaming = json!({ "enabled": true, "targets": [prepared_youtube()] });
    studio.activate_prepared_for_tests(streaming, "s0").await;
    assert_eq!(youtube_transitions(&backend), Vec::<Value>::new());

    // YouTube doesn't take the completion: the cleanup isn't done, and
    // Record is refused before anything starts.
    backend.with(|script| {
        script
            .livestream
            .entry("streamTargets.youtube.transition".to_string())
            .or_default()
            .push_back(Err(RpcError::new(
                "streamTargets.youtube.transition",
                "failed",
                "YouTube did not answer.",
            )));
    });
    let refused = studio.start_recording().await;
    assert!(
        matches!(refused, StartOutcome::Refused { .. }),
        "{refused:?}"
    );
    assert_eq!(backend.count("session.start"), 0);
    assert!(!studio.snapshot().session.start_pending);
    assert_eq!(youtube_transitions(&backend), [json!("complete")]);

    // The next Record finishes it, then starts.
    answer_livestream(
        &backend,
        "streamTargets.youtube.transition",
        json!({ "lifecycleStatus": "complete" }),
    );
    assert_eq!(studio.start_recording().await, StartOutcome::Started);
    assert_eq!(
        youtube_transitions(&backend),
        [json!("complete"), json!("complete")]
    );
    assert_eq!(backend.count("session.start"), 1);
}

#[tokio::test]
async fn a_stop_that_waited_for_a_go_lives_start_claims_the_owner_the_start_installed() {
    let mut capture = capture_config_with_twitch();
    capture["streaming"]["targets"]
        .as_array_mut()
        .unwrap()
        .push(prepared_youtube());
    let backend = Scripted::new();
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| {
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(capture.to_string()),
        );
        script.start_gate = Some(gate.clone());
        script.start_answers.push_back(Ok(live("s1")));
        script
            .stop_answers
            .push_back(Ok(status(RecordingState::Idle, Some("s1"))));
    });
    answer_livestream(
        &backend,
        "streamTargets.youtube.transition",
        json!({ "lifecycleStatus": "complete" }),
    );
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;

    // What the dialog prepared: the YouTube broadcast alone.
    let mut streaming = capture["streaming"].clone();
    streaming["targets"] = json!([prepared_youtube()]);
    streaming["enabledTargetIds"] = json!(["youtube"]);
    // Stop is pressed while `session.start` is out; the start answers only
    // once the stop waits for it.
    let stop_during_the_start = async {
        while backend.count("session.start") == 0 {
            tokio::task::yield_now().await;
        }
        let release = async {
            while !studio.snapshot().session.stop_pending {
                tokio::task::yield_now().await;
            }
            gate.add_permits(1);
        };
        let (stopped, ()) = tokio::join!(studio.stop(), release);
        stopped
    };
    let ((), stopped) = tokio::join!(
        studio.start_prepared_for_tests(streaming),
        stop_during_the_start
    );
    assert!(stopped);

    // The stop claimed the owner the start installed from its answer: the
    // broadcast is completed, and the activation it overtook never starts.
    assert_eq!(youtube_transitions(&backend), [json!("complete")]);
    let methods = livestream_methods(&backend);
    assert!(
        !methods
            .iter()
            .any(|method| method == "streamTargets.youtube.streamStatus"),
        "{methods:?}"
    );
    assert_eq!(backend.count("session.stop"), 1);
}

// --- The talk show's rejoin after a backend restart (`talkShow.rejoining`) --

#[tokio::test]
async fn a_restarted_backend_puts_the_talk_show_back_in_its_room_and_says_so_meanwhile() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    let (keep_open, events) = broadcast::channel::<BackendEvent>(16);
    tokio::spawn({
        let studio = studio.clone();
        async move {
            let _keep_open = keep_open;
            studio.drive(events).await;
        }
    });
    studio.handle_event(ready()).await;
    studio
        .handle_event(cloud_state(talk_show_status("show-7", false)))
        .await;
    assert!(!studio.cloud_now().talk_rejoining);

    // The backend restarts: the new one holds the show as resumable, with
    // this computer's controller renewed, and the room is not open.
    let resumable = json!({
        "phase": "hold",
        "show": { "id": "show-7", "kind": "talk", "resumable": true },
        "controller": { "controllerEpoch": 3 }
    });
    // The bootstrap's reads, then the rejoin's own.
    for _ in 0..4 {
        answer_livestream(&backend, "cloud.status", resumable.clone());
    }
    answer_livestream(
        &backend,
        "cloud.room.resume",
        talk_show_status("show-7", false),
    );
    let gate = Arc::new(Semaphore::new(0));
    backend.with(|script| {
        script.livestream_held = Some(("cloud.room.resume".to_string(), gate.clone()));
    });
    studio.handle_event(ready()).await;

    // While its resume is out the notice reads "Reconnecting to your show…".
    eventually("the rejoin says so", || studio.cloud_now().talk_rejoining).await;
    gate.add_permits(1);
    eventually("the rejoin ends", || !studio.cloud_now().talk_rejoining).await;
    let resumes = livestream_methods(&backend)
        .iter()
        .filter(|method| *method == "cloud.room.resume")
        .count();
    assert_eq!(resumes, 1, "asked once");
    assert!(
        cloud_outputs(&studio).is_some(),
        "the room is open again: the answer is committed"
    );

    // A reconnect to the backend that still holds the room asks nothing.
    backend.with(|script| {
        script.livestream.remove("cloud.status");
    });
    for _ in 0..4 {
        answer_livestream(&backend, "cloud.status", talk_show_status("show-7", false));
    }
    studio.handle_event(ready()).await;
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(!studio.cloud_now().talk_rejoining);
    let resumes = livestream_methods(&backend)
        .iter()
        .filter(|method| *method == "cloud.room.resume")
        .count();
    assert_eq!(resumes, 1);
}

// ── The remote-control surface (Stream Deck, the phone remote) ──────────

use videorc_app_core::client::RemoteIntentEnvelope;
use videorc_app_core::studio::remote::copy as remote_copy;

#[tokio::test]
async fn the_driver_publishes_the_remote_surface_and_again_after_a_reconnect() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    let (events, receiver) = broadcast::channel(16);
    let driver = tokio::spawn(Arc::clone(&studio).drive(receiver));
    events.send(ready()).unwrap();
    // The bootstrap's own writes (the scene library's migration) may move
    // the surface once more; the backend ends up holding what the Studio
    // shows.
    let shown = || serde_json::to_value(studio.remote_surface()).unwrap();
    eventually("the backend holds the Studio's surface", || {
        backend.script.lock().unwrap().remote_surfaces.last() == Some(&shown())
    })
    .await;
    let published = shown();
    assert_eq!(published["state"]["sessionState"], json!("idle"));
    assert_eq!(published["state"]["sessionActive"], json!(false));
    assert!(published["describe"]["layoutPresets"].is_array());

    // (The same body twice is never sent: `remote_tests.rs`.)
    let sent = backend.count("remote.surface.publish");

    // A new backend holds nothing: the same surface goes out again.
    events
        .send(BackendEvent::ConnectionClosed {
            reason: "gone".to_string(),
        })
        .unwrap();
    events.send(ready()).unwrap();
    eventually("the surface is published again", || {
        backend.count("remote.surface.publish") > sent
    })
    .await;
    driver.abort();
}

#[tokio::test]
async fn a_remote_intent_is_run_and_acked() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    let (events, receiver) = broadcast::channel(16);
    let driver = tokio::spawn(Arc::clone(&studio).drive(receiver));
    events.send(ready()).unwrap();
    eventually("the bootstrap", || studio.snapshot().bootstrapped).await;
    events
        .send(BackendEvent::RemoteIntent(Box::new(RemoteIntentEnvelope {
            intent_id: "intent-1".to_string(),
            intent: json!({ "kind": "recordStop" }),
        })))
        .unwrap();
    eventually("the intent is acked", || {
        backend.count("remote.intent.ack") == 1
    })
    .await;
    assert_eq!(
        backend.script.lock().unwrap().remote_acks,
        [RemoteIntentAckParams {
            intent_id: "intent-1".to_string(),
            ok: false,
            message: Some(remote_copy::NOT_RUNNING.to_string()),
        }]
    );
    driver.abort();
}

/// A takeover as `screens.list` names it.
fn takeover(id: &str) -> videorc_protocol::StreamScreen {
    videorc_protocol::StreamScreen {
        id: id.to_string(),
        name: id.to_string(),
        image_path: format!("/screens/{id}.png"),
        thumbnail_path: None,
        sort_order: 0,
        status: videorc_protocol::StreamScreenStatus::Ready,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

/// A launched Studio for a remote's keys.
async fn remote_studio(edit: impl FnOnce(&mut Script)) -> (Arc<Scripted>, Arc<Studio<Scripted>>) {
    let backend = Scripted::new();
    backend.with(edit);
    let studio = new_studio(&backend);
    studio.handle_event(ready()).await;
    (backend, studio)
}

/// Runs one intent as the driver does and answers its ack.
async fn press(
    backend: &Scripted,
    studio: &Arc<Studio<Scripted>>,
    intent: Value,
) -> RemoteIntentAckParams {
    studio
        .run_remote_intent(RemoteIntentEnvelope {
            intent_id: "key-1".to_string(),
            intent,
        })
        .await;
    backend
        .script
        .lock()
        .unwrap()
        .remote_acks
        .pop()
        .expect("the intent is acked")
}

fn accepted_ack() -> RemoteIntentAckParams {
    RemoteIntentAckParams {
        intent_id: "key-1".to_string(),
        ok: true,
        message: None,
    }
}

fn refused_ack(message: &str) -> RemoteIntentAckParams {
    RemoteIntentAckParams {
        intent_id: "key-1".to_string(),
        ok: false,
        message: Some(message.to_string()),
    }
}

fn remote_requests(backend: &Scripted) -> Vec<(String, Value)> {
    std::mem::take(&mut backend.script.lock().unwrap().remote_requests)
}

#[tokio::test]
async fn banner_keys_show_hide_and_toggle_a_listed_banner() {
    let (backend, studio) = remote_studio(|script| {
        script.banners = Some(json!([
            { "id": "sale", "name": "Sale", "shown": false },
            { "id": "logo", "name": "Logo", "shown": true }
        ]));
    })
    .await;
    assert_eq!(
        press(
            &backend,
            &studio,
            json!({ "kind": "bannerShow", "bannerId": "sale" })
        )
        .await,
        accepted_ack()
    );
    assert_eq!(
        remote_requests(&backend),
        [("banners.show".to_string(), json!({ "id": "sale" }))]
    );

    // A toggle hides the banner that shows, and shows the hidden one.
    press(
        &backend,
        &studio,
        json!({ "kind": "bannerToggle", "bannerId": "logo" }),
    )
    .await;
    press(
        &backend,
        &studio,
        json!({ "kind": "bannerToggle", "bannerId": "sale" }),
    )
    .await;
    // A hide without an id hides them all.
    press(&backend, &studio, json!({ "kind": "bannerHide" })).await;
    assert_eq!(
        remote_requests(&backend),
        [
            ("banners.hide".to_string(), json!({ "id": "logo" })),
            ("banners.show".to_string(), json!({ "id": "sale" })),
            ("banners.hide".to_string(), json!({})),
        ]
    );

    // A banner the list doesn't have is never sent.
    assert_eq!(
        press(
            &backend,
            &studio,
            json!({ "kind": "bannerShow", "bannerId": "gone" })
        )
        .await,
        refused_ack(remote_copy::BANNER_MISSING)
    );
    assert!(remote_requests(&backend).is_empty());

    // The backend's refusal comes back verbatim.
    backend.with(|script| {
        script.banner_show_refusal =
            Some("banners.show failed: Four banners are showing. Hide one first.".to_string());
    });
    assert_eq!(
        press(
            &backend,
            &studio,
            json!({ "kind": "bannerShow", "bannerId": "sale" })
        )
        .await,
        refused_ack("Four banners are showing. Hide one first.")
    );
}

#[tokio::test]
async fn sound_keys_press_a_sound_on_the_board_and_stop_them() {
    let (backend, studio) = remote_studio(|script| {
        script.sound_ids = Some(vec!["airhorn".to_string()]);
    })
    .await;
    assert_eq!(
        press(
            &backend,
            &studio,
            json!({ "kind": "soundPlay", "soundId": "airhorn" })
        )
        .await,
        accepted_ack()
    );
    press(
        &backend,
        &studio,
        json!({ "kind": "soundStop", "soundId": "airhorn" }),
    )
    .await;
    press(&backend, &studio, json!({ "kind": "soundStop" })).await;
    assert_eq!(
        remote_requests(&backend),
        [
            ("sounds.press".to_string(), json!({ "id": "airhorn" })),
            ("sounds.stop".to_string(), json!({ "id": "airhorn" })),
            ("sounds.stop".to_string(), json!({})),
        ]
    );
    assert_eq!(
        press(
            &backend,
            &studio,
            json!({ "kind": "soundPlay", "soundId": "gone" })
        )
        .await,
        refused_ack(remote_copy::SOUND_MISSING)
    );
    assert!(remote_requests(&backend).is_empty());
}

#[tokio::test]
async fn takeover_keys_put_a_listed_takeover_on_air_and_clear_it() {
    let (backend, studio) = remote_studio(|script| {
        script.takeovers = vec!["brb".to_string()];
    })
    .await;
    assert_eq!(
        press(
            &backend,
            &studio,
            json!({ "kind": "takeoverShow", "assetId": "brb" })
        )
        .await,
        accepted_ack()
    );
    assert_eq!(
        press(&backend, &studio, json!({ "kind": "takeoverHide" })).await,
        accepted_ack()
    );
    assert_eq!(
        remote_requests(&backend),
        [
            ("screens.activate".to_string(), json!({ "screenId": "brb" })),
            ("screens.clear".to_string(), Value::Null),
        ]
    );
    assert_eq!(
        press(
            &backend,
            &studio,
            json!({ "kind": "takeoverShow", "assetId": "gone" })
        )
        .await,
        refused_ack(remote_copy::TAKEOVER_MISSING)
    );
    assert!(remote_requests(&backend).is_empty());
}

#[tokio::test]
async fn hide_screen_keys_hide_show_and_toggle_the_screen() {
    let (backend, studio) = remote_studio(|_| {}).await;
    assert_eq!(
        press(&backend, &studio, json!({ "kind": "screenHide" })).await,
        accepted_ack()
    );
    // Hidden: the toggle shows it again.
    press(&backend, &studio, json!({ "kind": "screenHideToggle" })).await;
    press(&backend, &studio, json!({ "kind": "screenHideToggle" })).await;
    press(&backend, &studio, json!({ "kind": "screenShow" })).await;
    assert_eq!(
        remote_requests(&backend),
        [
            ("screen.hide".to_string(), json!({ "reason": "you" })),
            ("screen.show".to_string(), Value::Null),
            ("screen.hide".to_string(), json!({ "reason": "you" })),
            ("screen.show".to_string(), Value::Null),
        ]
    );
}

#[tokio::test]
async fn a_layout_key_switches_to_the_first_scene_with_that_layout() {
    let (backend, studio) = scenes_studio(capture_config_with_camera()).await;
    assert_eq!(
        studio.snapshot().scenes.on_stream_id.as_deref(),
        Some("default-screen-camera")
    );
    assert_eq!(
        press(
            &backend,
            &studio,
            json!({ "kind": "sceneApply", "layoutPreset": "screen-only" })
        )
        .await,
        accepted_ack()
    );
    settled(&studio).await;
    assert_eq!(
        studio.snapshot().scenes.on_stream_id.as_deref(),
        Some("default-screen-only")
    );
    let commits = layout_commits(&backend);
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].1["layout"]["layoutPreset"], "screen-only");

    // By id, as the scene keys send it.
    assert_eq!(
        press(
            &backend,
            &studio,
            json!({ "kind": "sceneApply", "sceneId": "default-screen-camera" })
        )
        .await,
        accepted_ack()
    );
    settled(&studio).await;
    assert_eq!(
        studio.snapshot().scenes.on_stream_id.as_deref(),
        Some("default-screen-camera")
    );

    // A screen the device list doesn't have.
    assert_eq!(
        press(
            &backend,
            &studio,
            json!({ "kind": "sceneApply", "screenId": "screen:screencapturekit:9" })
        )
        .await,
        refused_ack(remote_copy::SCREEN_MISSING)
    );
}

fn backend_event(event: &str, payload: Value) -> BackendEvent {
    BackendEvent::Untyped {
        event: event.to_string(),
        payload,
    }
}

fn surface(studio: &Studio<Scripted>) -> Value {
    serde_json::to_value(studio.remote_surface()).unwrap()
}

#[tokio::test]
async fn the_surface_reads_its_lists_once_and_then_follows_their_events() {
    let (_backend, studio) = remote_studio(|script| {
        script.takeovers = vec!["brb".to_string()];
        script.banners = Some(json!([
            { "id": "sale", "name": "Sale", "shown": true, "imageFile": "sale.png" }
        ]));
        script.sound_ids = Some(vec!["airhorn".to_string()]);
        script.screen_hidden = true;
        script.cohost = Some(json!({ "enabled": true }));
    })
    .await;
    studio.read_remote_lists().await;
    let read = surface(&studio);
    assert_eq!(
        read["describe"]["takeovers"],
        json!([{ "id": "brb", "name": "brb" }])
    );
    assert_eq!(
        read["describe"]["banners"],
        json!([{ "id": "sale", "name": "Sale", "shown": true }])
    );
    assert_eq!(
        read["describe"]["sounds"],
        json!([{ "id": "airhorn", "name": "airhorn", "playing": false }])
    );
    assert_eq!(read["state"]["screenHidden"], json!(true));
    assert_eq!(read["state"]["buddyLive"], json!(true));
    assert_eq!(read["state"]["activeTakeoverId"], json!(null));

    // Pushed: each event is the truth, and a later read on the same
    // connection never takes it back.
    for (event, payload) in [
        ("screens.changed", json!([])),
        (
            "screens.active.changed",
            json!({ "id": "brb", "name": "brb" }),
        ),
        (
            "banners.changed",
            json!([{ "id": "sale", "name": "Sale", "shown": false }]),
        ),
        (
            "sounds.playback",
            json!({ "voices": [{ "voiceId": "v1", "soundId": "airhorn" }] }),
        ),
        (
            "screen.privacy.changed",
            json!({ "hidden": false, "generation": 3 }),
        ),
    ] {
        studio.handle_event(backend_event(event, payload)).await;
    }
    studio.read_remote_lists().await;
    let pushed = surface(&studio);
    assert_eq!(pushed["describe"]["takeovers"], json!([]));
    assert_eq!(pushed["state"]["activeTakeoverId"], json!("brb"));
    assert_eq!(pushed["describe"]["banners"][0]["shown"], json!(false));
    assert_eq!(pushed["describe"]["sounds"][0]["playing"], json!(true));
    assert_eq!(pushed["state"]["screenHidden"], json!(false));

    // A new connection reads afresh; nothing plays on it yet.
    studio
        .handle_event(BackendEvent::ConnectionClosed {
            reason: "gone".to_string(),
        })
        .await;
    studio.handle_event(ready()).await;
    studio.read_remote_lists().await;
    let again = surface(&studio);
    assert_eq!(again["describe"], read["describe"]);
    for field in ["screenHidden", "buddyLive", "activeTakeoverId"] {
        assert_eq!(again["state"][field], read["state"][field], "{field}");
    }
}

#[tokio::test]
async fn the_driver_reads_the_lists_after_the_bootstrap() {
    let backend = Scripted::new();
    backend.with(|script| script.takeovers = vec!["brb".to_string()]);
    let studio = new_studio(&backend);
    let (events, receiver) = broadcast::channel(16);
    let driver = tokio::spawn(Arc::clone(&studio).drive(receiver));
    events.send(ready()).unwrap();
    eventually("the backend holds the takeovers", || {
        backend
            .script
            .lock()
            .unwrap()
            .remote_surfaces
            .last()
            .is_some_and(|published| {
                published["describe"]["takeovers"] == json!([{ "id": "brb", "name": "brb" }])
            })
    })
    .await;
    driver.abort();
}

/// An `entitlements.get` answer with Sidekick Live in the plan.
fn sidekick_plan() -> Value {
    json!({
        "schemaVersion": 1,
        "tier": "premium",
        "source": "creem",
        "capabilities": [{ "featureId": "live-cohost", "state": "enabled" }],
        "limits": {
            "recording": { "maxWidth": 3840, "maxHeight": 2160, "maxFps": 60 },
            "streaming": {
                "maxWidth": 1920, "maxHeight": 1080, "maxFps": 60,
                "maxBitrateKbps": 6000, "maxDestinations": 4
            }
        }
    })
}

fn said_ack(message: &str) -> RemoteIntentAckParams {
    RemoteIntentAckParams {
        intent_id: "key-1".to_string(),
        ok: true,
        message: Some(message.to_string()),
    }
}

#[tokio::test]
async fn sidekick_keys_check_the_plan_and_the_consent_only_to_turn_it_on() {
    use videorc_app_core::studio::remote_app::buddy_copy;

    // The settings never read: "Loading".
    let (backend, studio) = remote_studio(|_| {}).await;
    assert_eq!(
        press(&backend, &studio, json!({ "kind": "buddyLiveOn" })).await,
        refused_ack(buddy_copy::LOADING)
    );

    // No plan: Premium's lock. Then the plan, without Cloud AI's consent.
    let (backend, studio) = remote_studio(|script| {
        script.cohost = Some(json!({ "enabled": false, "listen": true }));
    })
    .await;
    assert_eq!(
        press(&backend, &studio, json!({ "kind": "buddyLiveOn" })).await,
        refused_ack(buddy_copy::PREMIUM)
    );
    backend.with(|script| script.entitlements = Some(sidekick_plan()));
    assert_eq!(
        press(&backend, &studio, json!({ "kind": "buddyLiveToggle" })).await,
        refused_ack(buddy_copy::CONSENT)
    );
    // Off is always allowed, and already off saves nothing.
    assert_eq!(
        press(&backend, &studio, json!({ "kind": "buddyLiveOff" })).await,
        said_ack(buddy_copy::OFF)
    );
    assert!(remote_requests(&backend).is_empty());

    // Premium and the consent: on, then the toggle turns it off.
    let (backend, studio) = remote_studio(|script| {
        script.cohost = Some(json!({ "enabled": false, "listen": true }));
        script.entitlements = Some(sidekick_plan());
        script
            .settings
            .insert(keys::AI_CONSENT.to_string(), Value::String("1".to_string()));
    })
    .await;
    assert_eq!(
        press(&backend, &studio, json!({ "kind": "buddyLiveOn" })).await,
        said_ack(buddy_copy::ON)
    );
    assert_eq!(surface(&studio)["state"]["buddyLive"], json!(true));
    assert_eq!(
        press(&backend, &studio, json!({ "kind": "buddyLiveToggle" })).await,
        said_ack(buddy_copy::OFF)
    );
    assert_eq!(surface(&studio)["state"]["buddyLive"], json!(false));
    // `enabled` alone: never the microphone.
    assert_eq!(
        remote_requests(&backend),
        [
            (
                "cohost.settings.set".to_string(),
                json!({ "enabled": true })
            ),
            (
                "cohost.settings.set".to_string(),
                json!({ "enabled": false })
            ),
        ]
    );
}

#[tokio::test]
async fn window_keys_reach_the_app_and_without_it_ask_for_an_update() {
    use videorc_app_core::studio::remote::accepted;
    use videorc_app_core::studio::remote_app::{AppRemoteAction, RemoteWindow};

    let (backend, studio) = remote_studio(|_| {}).await;
    assert_eq!(
        press(
            &backend,
            &studio,
            json!({ "kind": "windowFront", "window": "notes" })
        )
        .await,
        refused_ack(remote_copy::UNSUPPORTED)
    );
    let (listener, mut keys) = tokio::sync::mpsc::unbounded_channel();
    studio.set_remote_app_listener(Some(listener));
    let app = tokio::spawn(async move {
        let key = keys.recv().await.expect("a key");
        let action = key.action;
        key.answer(accepted());
        action
    });
    assert_eq!(
        press(
            &backend,
            &studio,
            json!({ "kind": "windowFront", "window": "comments" })
        )
        .await,
        accepted_ack()
    );
    assert_eq!(
        app.await.unwrap(),
        AppRemoteAction::WindowFront(RemoteWindow::Comments)
    );
}

// ── A takeover's microphone mute (`studio::takeover_mute`) ──────────────

const TAKEOVER_RECORD: &str = "videorc.screenTakeoverMuteOwnership.v1";

fn stored_record(backend: &Scripted) -> Option<Value> {
    backend
        .script
        .lock()
        .unwrap()
        .settings
        .get(TAKEOVER_RECORD)
        .cloned()
}

fn takeover_event(payload: Value) -> BackendEvent {
    BackendEvent::Untyped {
        event: "screens.active.changed".to_string(),
        payload,
    }
}

#[tokio::test]
async fn a_relaunch_releases_the_mute_a_takeover_left() {
    let backend = Scripted::new();
    backend.with(|script| {
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(json!({ "audio": { "microphoneMuted": true } }).to_string()),
        );
        script.settings.insert(
            TAKEOVER_RECORD.to_string(),
            Value::String(json!({ "priorMicrophoneMuted": false }).to_string()),
        );
    });
    let studio = new_studio(&backend);
    let (events, receiver) = broadcast::channel(16);
    let driver = tokio::spawn(Arc::clone(&studio).drive(receiver));
    events.send(ready()).unwrap();
    // The backend retired the last run's takeover: the read says none.
    eventually("the record is released", || {
        stored_record(&backend).is_none()
    })
    .await;
    assert_eq!(stored_audio(&backend)["microphoneMuted"], json!(false));
    assert!(!studio.snapshot().settings.capture.audio.microphone_muted);
    driver.abort();
}

#[tokio::test]
async fn a_takeover_on_air_mutes_the_microphone_and_gives_it_back() {
    let backend = Scripted::new();
    let studio = new_studio(&backend);
    let (events, receiver) = broadcast::channel(16);
    let driver = tokio::spawn(Arc::clone(&studio).drive(receiver));
    events.send(ready()).unwrap();
    eventually("the bootstrap", || studio.snapshot().bootstrapped).await;
    assert!(!studio.snapshot().settings.capture.audio.microphone_muted);

    events
        .send(takeover_event(
            json!({ "id": "brb", "name": "Be right back" }),
        ))
        .unwrap();
    eventually("the takeover mutes", || {
        studio.snapshot().settings.capture.audio.microphone_muted
            && stored_record(&backend).is_some()
    })
    .await;
    assert_eq!(
        stored_record(&backend),
        Some(Value::String(
            json!({ "priorMicrophoneMuted": false }).to_string()
        ))
    );

    events.send(takeover_event(Value::Null)).unwrap();
    eventually("the takeover gives the mute back", || {
        !studio.snapshot().settings.capture.audio.microphone_muted
            && stored_record(&backend).is_none()
    })
    .await;
    driver.abort();
}

#[tokio::test]
async fn a_microphone_muted_before_the_takeover_stays_muted_after_it() {
    let backend = Scripted::new();
    backend.with(|script| {
        script.settings.insert(
            keys::CAPTURE_CONFIG.to_string(),
            Value::String(json!({ "audio": { "microphoneMuted": true } }).to_string()),
        );
    });
    let studio = new_studio(&backend);
    let (events, receiver) = broadcast::channel(16);
    let driver = tokio::spawn(Arc::clone(&studio).drive(receiver));
    events.send(ready()).unwrap();
    eventually("the bootstrap", || studio.snapshot().bootstrapped).await;
    events.send(takeover_event(json!({ "id": "brb" }))).unwrap();
    eventually("the record", || stored_record(&backend).is_some()).await;
    assert_eq!(
        stored_record(&backend),
        Some(Value::String(
            json!({ "priorMicrophoneMuted": true }).to_string()
        ))
    );
    events.send(takeover_event(Value::Null)).unwrap();
    eventually("the record is released", || {
        stored_record(&backend).is_none()
    })
    .await;
    assert!(studio.snapshot().settings.capture.audio.microphone_muted);
    driver.abort();
}
