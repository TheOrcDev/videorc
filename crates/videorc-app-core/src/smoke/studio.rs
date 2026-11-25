//! The Studio's smoke commands on the GPUI app (plan 260 Phase 3, L6): what
//! Electron's smokes reach through the renderer, here on the core's Studio.
//! Only the smoke command server ever calls them.
//!
//! - `enable-synthetic-source {settleMs?}`: the Sources page's development
//!   switch, the test pattern, on (Electron clicks the same switch).
//! - `studio-state`: the session, the connection and the test pattern.
//! - `studio-record {timeoutMs?}`: Record, answered once the take runs.
//! - `studio-stop {timeoutMs?}`: Stop, answered once the session ended.
//! - `studio-capture-configure {config}`: `config` merged over the capture
//!   config (Electron's smokes seed `videorc.captureConfig` and reload).
//! - `studio-replay-buffer {armed, seconds?}`: the clip buffer armed for
//!   this run with a shorter ring, never saved
//!   (`__videorcSmokeSetReplayBuffer`).
//! - `select-screen-device {sourceId?}`, `select-camera-device {cameraId?,
//!   off?}`: the Sources page's pickers (`__videorcSmokeSelectScreen`,
//!   `__videorcSmokeSelectFirstCamera`); without an id, the first available
//!   ScreenCaptureKit screen or window, or the first available camera.
//! - `select-layout-preset {preset}`: the Scene page's layout button.
//! - The saved scenes (`__videorcSmokeScenePresets`): `studio-scenes-state`,
//!   `studio-scene-save {name, updateId?}` (the look on stream, then on
//!   stream as that scene), `studio-scene-apply {id}`, `studio-scene-delete
//!   {id}`, `studio-scene-layout {patch}` (`applyCameraPreset`) and
//!   `studio-scene-background {background}` (a saved background or `null`).
//!
//! The rest of [`STUDIO_COMMANDS`](super::STUDIO_COMMANDS) answer "not
//! supported" by name until they land here.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::sync::watch;

use super::{CommandFuture, SmokeCommandHandler};
use crate::scenes::model::SavedScene;
use crate::scenes::view::scene_from_saved;
use crate::studio::source_selection::SourceKind;
use crate::studio::{Connection, StudioSnapshot};
use crate::{BackendClient, SessionPhase, StartOutcome, Studio};
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

/// The commands this handler takes.
pub const STUDIO_SMOKE_COMMANDS: &[&str] = &[
    "enable-synthetic-source",
    "select-camera-device",
    "select-layout-preset",
    "select-screen-device",
    "preview-surface-scene-state",
    "studio-capture-configure",
    "studio-record",
    "studio-replay-buffer",
    "studio-scene-apply",
    "studio-scene-background",
    "studio-scene-delete",
    "studio-scene-layout",
    "studio-scene-save",
    "studio-scenes-state",
    "studio-state",
    "studio-stop",
];

/// The concrete Studio the app runs (`Studio<BackendClient>`).
pub type AppStudio = Studio<BackendClient>;

/// Electron's `enable-synthetic-source` settle after the switch flips.
const DEFAULT_SETTLE_MS: u64 = 600;
/// How long the switch may take to read back on (Electron's 5 s).
const SWITCH_WAIT: Duration = Duration::from_secs(5);
/// How long a take may take to start or stop by default.
const DEFAULT_SESSION_WAIT_MS: u64 = 30_000;
/// The longest wait a smoke may ask for.
const MAX_WAIT_MS: u64 = 5 * 60_000;

pub struct StudioSmoke {
    studio: Arc<AppStudio>,
}

impl StudioSmoke {
    pub fn new(studio: Arc<AppStudio>) -> Self {
        Self { studio }
    }
}

fn millis(params: &Map<String, Value>, key: &str, default: u64) -> u64 {
    params
        .get(key)
        .and_then(Value::as_u64)
        .unwrap_or(default)
        .min(MAX_WAIT_MS)
}

fn test_pattern(snapshot: &StudioSnapshot) -> bool {
    snapshot.settings.capture.sources.test_pattern
}

fn session_active(phase: SessionPhase) -> bool {
    !matches!(phase, SessionPhase::Idle | SessionPhase::Failed)
}

/// `studio-state`'s answer.
pub fn state_json(snapshot: &StudioSnapshot) -> Value {
    let session = &snapshot.session;
    json!({
        "connection": match &snapshot.connection {
            Connection::Waiting => json!({ "state": "waiting" }),
            Connection::Connected { pid } => json!({ "state": "connected", "pid": pid }),
            Connection::Disconnected { reason } => {
                json!({ "state": "disconnected", "reason": reason })
            }
        },
        "bootstrapped": snapshot.bootstrapped,
        "phase": format!("{:?}", session.phase).to_lowercase(),
        "status": serde_json::to_value(&session.status).unwrap_or(Value::Null),
        "startPending": session.start_pending,
        "stopPending": session.stop_pending,
        "startFailure": session.start_failure.as_ref().map(|failure| format!("{failure:?}")),
        "testPattern": test_pattern(snapshot),
        "lastError": snapshot.last_error,
    })
}

/// The device a picker takes: `id` when given (it must be available), else
/// the first available one `default` accepts.
pub fn pick_device<'a>(
    devices: &'a [Device],
    kinds: &[DeviceKind],
    id: Option<&str>,
    default: impl Fn(&Device) -> bool,
) -> Option<&'a Device> {
    let available =
        |device: &&Device| kinds.contains(&device.kind) && device.status == DeviceStatus::Available;
    match id {
        Some(id) => devices
            .iter()
            .filter(available)
            .find(|device| device.id == id),
        None => devices
            .iter()
            .filter(available)
            .find(|device| default(device)),
    }
}

/// What the Studio shows now: its sources and its layout preset.
fn sources_json(snapshot: &StudioSnapshot) -> Value {
    let sources = &snapshot.settings.capture.sources;
    json!({
        "screenId": sources.screen_id,
        "windowId": sources.window_id,
        "cameraId": sources.camera_id,
        "cameraOff": snapshot.settings.capture_doc["sources"]["cameraOff"].as_bool().unwrap_or(false),
        "testPattern": sources.test_pattern,
        "layoutPreset": serde_json::to_value(&snapshot.settings.capture.layout.layout_preset)
            .unwrap_or(Value::Null),
        "video": {
            "width": snapshot.settings.capture.video.width,
            "height": snapshot.settings.capture.video.height,
            "fps": snapshot.settings.capture.video.fps,
        },
    })
}

/// `preview-surface-scene-state` on GPUI: the scene the Studio committed,
/// which the preview shows (Electron's native surface scene). The GPUI app
/// keeps no separate surface revision, so `sceneRevision` is the backend's
/// to read (`compositor.status`).
pub fn surface_scene_json(snapshot: &StudioSnapshot) -> Value {
    let scene = snapshot.sources.scene.as_ref();
    let ids = |visible_only: bool| -> Vec<String> {
        scene
            .map(|scene| {
                scene
                    .sources
                    .iter()
                    .filter(|source| !visible_only || source.visible)
                    .map(|source| source.id.clone())
                    .collect()
            })
            .unwrap_or_default()
    };
    json!({
        "sceneRevision": null,
        "layoutPreset": serde_json::to_value(&snapshot.settings.capture.layout.layout_preset)
            .unwrap_or(Value::Null),
        "cameraShape": snapshot.settings.capture_doc["layout"]["cameraShape"],
        "sourceIds": ids(false),
        "visibleSourceIds": ids(true),
        "proofWindowVisible": false,
    })
}

/// `studio-scenes-state`'s answer.
pub fn scenes_json(snapshot: &StudioSnapshot) -> Value {
    let view = &snapshot.scenes;
    json!({
        "loaded": view.loaded,
        "readOnly": view.read_only,
        "error": view.error,
        "onStreamId": view.on_stream_id,
        "pendingSceneId": view.pending_scene_id,
        "modified": view.saved_scene_modified,
        "scenes": view.scenes.iter().map(|scene| json!({
            "id": scene.id,
            "name": scene.name,
            "visual": scene.visual,
        })).collect::<Vec<_>>(),
        "visual": sources_json(snapshot),
    })
}

fn text_param<'a>(params: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// `patch` merged over `target`: objects key by key, anything else replaced.
pub fn merge_json(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(target), Value::Object(patch)) => {
            for (key, value) in patch {
                merge_json(target.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (target, patch) => *target = patch.clone(),
    }
}

/// Waits until `done` holds for the Studio's snapshot, or says what it saw.
async fn wait_for(
    mut snapshots: watch::Receiver<StudioSnapshot>,
    wait: Duration,
    what: &str,
    done: impl Fn(&StudioSnapshot) -> bool,
) -> Result<StudioSnapshot, String> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        {
            let snapshot = snapshots.borrow_and_update();
            if done(&snapshot) {
                return Ok(snapshot.clone());
            }
        }
        match tokio::time::timeout_at(deadline, snapshots.changed()).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return Err(format!("The Studio stopped before {what}.")),
            Err(_) => {
                let snapshot = snapshots.borrow();
                return Err(format!(
                    "Timed out after {} ms waiting for {what}: {}",
                    wait.as_millis(),
                    state_json(&snapshot)
                ));
            }
        }
    }
}

impl StudioSmoke {
    async fn enable_synthetic_source(&self, params: Map<String, Value>) -> Result<Value, String> {
        let settle = Duration::from_millis(millis(&params, "settleMs", DEFAULT_SETTLE_MS));
        let snapshot = self.studio.snapshot();
        if test_pattern(&snapshot) {
            tokio::time::sleep(settle).await;
            return Ok(json!({ "enabled": true, "alreadyEnabled": true }));
        }
        // The switch is disabled while a session runs (`SyntheticView`).
        if session_active(snapshot.session.phase) {
            return Err("Synthetic source toggle is disabled.".to_string());
        }
        self.studio
            .set_test_pattern(true)
            .await
            .map_err(|error| format!("The test pattern did not turn on: {error}"))?;
        wait_for(
            self.studio.watch(),
            SWITCH_WAIT,
            "the synthetic source",
            test_pattern,
        )
        .await
        .map_err(|_| "Timed out enabling synthetic source.".to_string())?;
        tokio::time::sleep(settle).await;
        Ok(json!({ "enabled": true }))
    }

    async fn record(&self, params: Map<String, Value>) -> Result<Value, String> {
        let wait = Duration::from_millis(millis(&params, "timeoutMs", DEFAULT_SESSION_WAIT_MS));
        match self.studio.start_recording().await {
            StartOutcome::Started => {}
            StartOutcome::Refused { message } => {
                return Err(format!("Record was refused: {message}"));
            }
            StartOutcome::Busy => {
                return Err("Record: a session is active or a start is in flight.".to_string());
            }
        }
        let snapshot = wait_for(self.studio.watch(), wait, "the take to run", |snapshot| {
            snapshot.session.phase == SessionPhase::Recording
        })
        .await?;
        Ok(json!({ "started": true, "state": state_json(&snapshot) }))
    }

    async fn stop(&self, params: Map<String, Value>) -> Result<Value, String> {
        let wait = Duration::from_millis(millis(&params, "timeoutMs", DEFAULT_SESSION_WAIT_MS));
        if !self.studio.stop().await {
            return Err(format!(
                "Stop failed: {}",
                state_json(&self.studio.snapshot())
            ));
        }
        let snapshot = wait_for(
            self.studio.watch(),
            wait,
            "the session to end",
            |snapshot| !session_active(snapshot.session.phase),
        )
        .await?;
        Ok(json!({ "stopped": true, "state": state_json(&snapshot) }))
    }
}

impl StudioSmoke {
    async fn capture_configure(&self, params: Map<String, Value>) -> Result<Value, String> {
        let patch = params
            .get("config")
            .filter(|config| config.is_object())
            .cloned()
            .ok_or_else(|| "studio-capture-configure needs a config object.".to_string())?;
        self.studio
            .update_capture_config(|config| merge_json(config, &patch))
            .await
            .map_err(|error| format!("The capture config was not saved: {error}"))?;
        Ok(json!({ "configured": true, "state": state_json(&self.studio.snapshot()) }))
    }

    fn replay_buffer(&self, params: Map<String, Value>) -> Result<Value, String> {
        let armed = params
            .get("armed")
            .or_else(|| params.get("enabled"))
            .and_then(Value::as_bool)
            .ok_or_else(|| "studio-replay-buffer needs armed: true or false.".to_string())?;
        let seconds = params
            .get("seconds")
            .and_then(Value::as_u64)
            .map(|seconds| seconds.clamp(1, 3600) as u32);
        self.studio.set_clips_for_run(armed, seconds);
        Ok(json!({ "armed": armed, "seconds": seconds }))
    }
}

impl StudioSmoke {
    /// The device list, once `devices.list` answered, waiting up to `wait`
    /// for a device `pick` accepts.
    async fn wait_for_device(
        &self,
        wait: Duration,
        what: &str,
        pick: impl Fn(&[Device]) -> Option<Device>,
    ) -> Result<Device, String> {
        let snapshot = wait_for(self.studio.watch(), wait, what, |snapshot| {
            snapshot.sources.devices_known && pick(&snapshot.sources.devices.devices).is_some()
        })
        .await?;
        pick(&snapshot.sources.devices.devices).ok_or_else(|| format!("{what}: none."))
    }

    async fn select_screen(&self, params: Map<String, Value>) -> Result<Value, String> {
        let wait = Duration::from_millis(millis(&params, "timeoutMs", 15_000));
        let settle = Duration::from_millis(millis(&params, "settleMs", 1000));
        let wanted = text_param(&params, "sourceId").map(str::to_string);
        let what = match &wanted {
            Some(id) => format!("Screen source {id} is not available to select"),
            None => "No available ScreenCaptureKit screen/window source to select".to_string(),
        };
        let device = self
            .wait_for_device(wait, &what, |devices| {
                pick_device(
                    devices,
                    &[DeviceKind::Screen, DeviceKind::Window],
                    wanted.as_deref(),
                    |device| device.id.contains("screencapturekit") || !cfg!(target_os = "macos"),
                )
                .cloned()
            })
            .await
            .map_err(|_| format!("{what}."))?;
        // A real screen replaces the test pattern, as Electron's hook does.
        if test_pattern(&self.studio.snapshot()) {
            self.studio
                .set_test_pattern(false)
                .await
                .map_err(|error| format!("The test pattern did not turn off: {error}"))?;
        }
        self.studio
            .select_source_device(SourceKind::Capture, Some(&device.id))
            .await?;
        tokio::time::sleep(settle).await;
        let kind = if device.kind == DeviceKind::Window {
            "window"
        } else {
            "screen"
        };
        Ok(json!({ "id": device.id, "kind": kind }))
    }

    async fn select_camera(&self, params: Map<String, Value>) -> Result<Value, String> {
        let wait = Duration::from_millis(millis(&params, "timeoutMs", 10_000));
        let settle = Duration::from_millis(millis(&params, "settleMs", 600));
        if params.get("off").and_then(Value::as_bool) == Some(true) {
            self.studio
                .select_source_device(SourceKind::Camera, None)
                .await?;
            tokio::time::sleep(settle).await;
            return Ok(json!({ "cameraId": null, "cameraOff": true }));
        }
        let wanted = text_param(&params, "cameraId").map(str::to_string);
        let device = self
            .wait_for_device(wait, "No camera device available to select", |devices| {
                pick_device(devices, &[DeviceKind::Camera], wanted.as_deref(), |_| true).cloned()
            })
            .await
            .map_err(|_| "No camera device available to select.".to_string())?;
        self.studio
            .select_source_device(SourceKind::Camera, Some(&device.id))
            .await?;
        tokio::time::sleep(settle).await;
        Ok(json!({ "cameraId": device.id }))
    }

    async fn select_layout_preset(&self, params: Map<String, Value>) -> Result<Value, String> {
        let preset = text_param(&params, "preset")
            .unwrap_or("screen-only")
            .to_string();
        let settle = Duration::from_millis(millis(&params, "settleMs", 600));
        let shown = |snapshot: &StudioSnapshot| {
            serde_json::to_value(&snapshot.settings.capture.layout.layout_preset).ok()
                == Some(Value::String(preset.clone()))
        };
        if !shown(&self.studio.snapshot()) {
            // A 9:16 layout needs the 9:16 orientation first, as Electron's
            // command switches it before it presses the button.
            let vertical = preset.starts_with("vertical-");
            if !self.studio.apply_layout_preset(&preset).await
                && !(self.studio.switch_orientation(vertical).await
                    && self.studio.apply_layout_preset(&preset).await)
            {
                return Err(format!("Could not find layout preset {preset}."));
            }
            wait_for(
                self.studio.watch(),
                SWITCH_WAIT * 2,
                &format!("layout preset {preset} to become active"),
                shown,
            )
            .await?;
        }
        tokio::time::sleep(settle).await;
        Ok(json!({ "preset": preset, "pressed": true, "disabled": false }))
    }

    async fn scene_save(&self, params: Map<String, Value>) -> Result<Value, String> {
        let name = text_param(&params, "name")
            .ok_or("studio-scene-save needs a name.")?
            .to_string();
        let update = text_param(&params, "updateId").map(str::to_string);
        let snapshot = self.studio.snapshot();
        let library = snapshot
            .scenes
            .library
            .as_ref()
            .ok_or("The scene library has not loaded.")?;
        if snapshot.scenes.read_only {
            return Err("The scene library is read-only.".into());
        }
        let template_id = update.as_deref().unwrap_or(&library.on_stream_id);
        let template = library
            .scenes
            .iter()
            .find(|scene| scene.id == template_id)
            .or_else(|| library.scenes.first())
            .ok_or("There is no scene to save from.")?;
        if update.is_some() && template.id != template_id {
            return Err(format!("No scene {template_id} to update."));
        }
        let visual = self
            .studio
            .working_scene_visual()
            .ok_or("The look on stream cannot be saved yet.")?;
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let id = update
            .clone()
            .unwrap_or_else(|| format!("scene-{}", uuid::Uuid::new_v4()));
        let saved = SavedScene {
            id: id.clone(),
            name,
            created_at: if update.is_some() {
                template.created_at.clone()
            } else {
                now.clone()
            },
            updated_at: now,
            visual,
            audio: update.as_ref().and(template.audio.clone()),
            cloud: update.as_ref().and(template.cloud.clone()),
        };
        let scene = scene_from_saved(&saved, template);
        let stored = if update.is_some() {
            self.studio.edit_scene(&scene, None).await
        } else {
            self.studio
                .insert_scenes(&[scene], None, &std::collections::HashMap::new())
                .await
        };
        if !stored {
            return Err(format!(
                "The scene was not saved: {}",
                self.studio.snapshot().last_error.unwrap_or_default()
            ));
        }
        let applied = self.studio.apply_saved_scene_by_id(&id).await;
        Ok(json!({ "id": id, "saved": true, "applied": applied }))
    }

    async fn scene_apply(&self, params: Map<String, Value>) -> Result<Value, String> {
        let id = text_param(&params, "id")
            .ok_or("studio-scene-apply needs an id.")?
            .to_string();
        let wait = Duration::from_millis(millis(&params, "timeoutMs", DEFAULT_SESSION_WAIT_MS));
        if !self.studio.apply_saved_scene_by_id(&id).await {
            return Err(format!(
                "Scene {id} did not go on stream: {}",
                self.studio.snapshot().last_error.unwrap_or_default()
            ));
        }
        let snapshot = wait_for(
            self.studio.watch(),
            wait,
            "the scene on stream",
            |snapshot| {
                snapshot.scenes.on_stream_id.as_deref() == Some(id.as_str())
                    && snapshot.scenes.pending_scene_id.is_none()
            },
        )
        .await?;
        Ok(json!({ "applied": true, "state": scenes_json(&snapshot) }))
    }

    async fn scene_delete(&self, params: Map<String, Value>) -> Result<Value, String> {
        let id = text_param(&params, "id").ok_or("studio-scene-delete needs an id.")?;
        if !self.studio.delete_scene(id).await {
            return Err(format!("Scene {id} was not deleted."));
        }
        Ok(json!({ "deleted": true, "state": scenes_json(&self.studio.snapshot()) }))
    }

    async fn scene_layout(&self, params: Map<String, Value>) -> Result<Value, String> {
        let patch = params
            .get("patch")
            .and_then(Value::as_object)
            .cloned()
            .ok_or("studio-scene-layout needs a patch object.")?;
        if !self.studio.apply_camera_preset(patch, false).await {
            return Err("The layout change was refused.".into());
        }
        Ok(json!({ "applied": true, "state": scenes_json(&self.studio.snapshot()) }))
    }

    async fn scene_background(&self, params: Map<String, Value>) -> Result<Value, String> {
        let background = match params.get("background") {
            None | Some(Value::Null) => None,
            Some(background) if background.is_object() => Some(background),
            Some(_) => return Err("studio-scene-background takes an object or null.".into()),
        };
        if !self.studio.set_working_background(background).await {
            return Err("The background did not apply.".into());
        }
        Ok(json!({ "applied": true, "state": scenes_json(&self.studio.snapshot()) }))
    }
}

impl SmokeCommandHandler for StudioSmoke {
    fn handles(&self, command: &str) -> bool {
        STUDIO_SMOKE_COMMANDS.contains(&command)
    }

    fn run<'a>(&'a self, command: &'a str, params: Map<String, Value>) -> CommandFuture<'a> {
        Box::pin(async move {
            match command {
                "enable-synthetic-source" => self.enable_synthetic_source(params).await,
                "studio-state" => Ok(state_json(&self.studio.snapshot())),
                "studio-record" => self.record(params).await,
                "studio-stop" => self.stop(params).await,
                "studio-capture-configure" => self.capture_configure(params).await,
                "studio-replay-buffer" => self.replay_buffer(params),
                "select-screen-device" => self.select_screen(params).await,
                "select-camera-device" => self.select_camera(params).await,
                "select-layout-preset" => self.select_layout_preset(params).await,
                "studio-scenes-state" => Ok(scenes_json(&self.studio.snapshot())),
                "preview-surface-scene-state" => Ok(surface_scene_json(&self.studio.snapshot())),
                "studio-scene-save" => self.scene_save(params).await,
                "studio-scene-apply" => self.scene_apply(params).await,
                "studio-scene-delete" => self.scene_delete(params).await,
                "studio-scene-layout" => self.scene_layout(params).await,
                "studio-scene-background" => self.scene_background(params).await,
                other => Err(format!("The Studio smoke handler does not take {other}.")),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_takes_only_studio_commands() {
        for command in STUDIO_SMOKE_COMMANDS {
            assert!(super::super::STUDIO_COMMANDS.contains(command), "{command}");
        }
    }

    #[test]
    fn a_patch_merges_objects_and_replaces_the_rest() {
        let mut config = json!({"video": {"fps": 30, "width": 1920}, "recordEnabled": false});
        merge_json(
            &mut config,
            &json!({"video": {"fps": 60}, "recordEnabled": true, "layout": {"layoutPreset": "screen-only"}}),
        );
        assert_eq!(
            config,
            json!({
                "video": {"fps": 60, "width": 1920},
                "recordEnabled": true,
                "layout": {"layoutPreset": "screen-only"}
            })
        );
    }

    fn device(id: &str, kind: &str, status: &str) -> Device {
        serde_json::from_value(json!({"id": id, "name": id, "kind": kind, "status": status}))
            .expect("a device")
    }

    #[test]
    fn a_picker_takes_the_named_device_or_the_first_available_one() {
        let devices = vec![
            device("camera:busy", "camera", "unavailable"),
            device("camera:a", "camera", "available"),
            device("screen:screencapturekit:1", "screen", "available"),
            device("window:screencapturekit:9", "window", "permission-required"),
        ];
        let camera = pick_device(&devices, &[DeviceKind::Camera], None, |_| true);
        assert_eq!(camera.map(|device| device.id.as_str()), Some("camera:a"));
        assert!(
            pick_device(&devices, &[DeviceKind::Camera], Some("camera:busy"), |_| {
                true
            })
            .is_none()
        );
        let screens = [DeviceKind::Screen, DeviceKind::Window];
        let screen = pick_device(&devices, &screens, None, |device| {
            device.id.contains("screencapturekit")
        });
        assert_eq!(
            screen.map(|device| device.id.as_str()),
            Some("screen:screencapturekit:1")
        );
        assert!(
            pick_device(
                &devices,
                &screens,
                Some("window:screencapturekit:9"),
                |_| true
            )
            .is_none()
        );
    }

    #[test]
    fn waits_are_capped() {
        let mut params = Map::new();
        params.insert("timeoutMs".into(), json!(u64::MAX));
        assert_eq!(millis(&params, "timeoutMs", 1), MAX_WAIT_MS);
        assert_eq!(millis(&Map::new(), "settleMs", 600), 600);
    }

    #[test]
    fn only_idle_and_failed_are_not_a_running_session() {
        assert!(!session_active(SessionPhase::Idle));
        assert!(!session_active(SessionPhase::Failed));
        assert!(session_active(SessionPhase::Starting));
        assert!(session_active(SessionPhase::Recording));
        assert!(session_active(SessionPhase::Stopping));
    }
}
