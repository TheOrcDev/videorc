//! The Studio's agent tools (plan 209 S6, S10–S15; Electron's
//! `lib/studio-actions/{tools,run-the-show,buddy,library}.ts`).
//!
//! Dispatches every `runsIn: studio` tool in `protocol-fixtures/agent-tools.json`
//! on [`Studio`], reusing the same handlers as buttons and remote keys and
//! matching Electron's exact copy, structured `result` payloads, and error shapes.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde_json::{Map, Value, json};
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

use super::agent::{AgentIntentEnvelope, AgentIntentOutcome, AppAgentAction};
use super::audio_mixer;
use super::capture_config::{HORIZONTAL_LAYOUT_PRESETS, VERTICAL_LAYOUT_PRESETS};
use super::families;
use super::latency::LatencyKind;
use super::remote::{copy as remote_copy, text_field};
use super::remote_actions::{PrivacyMode, SoundVerb};
use super::remote_app::{
    COHOST_SETTINGS_GET_METHOD, COHOST_SETTINGS_SET_METHOD, ENTITLEMENTS_GET_METHOD, RemoteWindow,
    buddy_copy, buddy_live_refusal,
};
use super::scene_switch::ApplyOptions;
use super::session::session_is_live;
use super::source_selection::SourceKind;
use super::{MicrophoneMode, StartOutcome, Studio, StudioBackend};
use crate::account::entitlements::{live_cohost_gate, read_snapshot};
use crate::assets::view::{live_background_name, live_background_style};
use crate::scenes::background::LIVE_BACKGROUND_IDS;
use crate::scenes::v2::layout_preset_label;
use crate::stream_manager::buddy::{CohostSettingsView, enable_patch};

pub const MICROPHONE_GAIN_DB_MIN: i64 = -24;
pub const MICROPHONE_GAIN_DB_MAX: i64 = 24;
pub const SYSTEM_AUDIO_GAIN_DB_MIN: i64 = -24;
pub const SYSTEM_AUDIO_GAIN_DB_MAX: i64 = 12;

pub mod copy {
    pub const SET_AUDIO_EMPTY: &str =
        "Say what to change: microphone (muted, gainDb, deviceId) or systemAudio (on, gainDb).";
    pub const MICROPHONE_MISSING: &str =
        "That microphone isn't available. Use an id from list_sources.";
    pub const SET_SOURCES_EMPTY: &str = "Say what to change: screenId, windowId or cameraId.";
    pub const SCREEN_OR_WINDOW: &str = "Choose a screen or a window, not both.";
    pub const SCREEN_MISSING: &str = "That screen isn't available. Use an id from list_sources.";
    pub const WINDOW_MISSING: &str = "That window isn't available. Use an id from list_sources.";
    pub const CAMERA_MISSING: &str = "That camera isn't available. Use an id from list_sources.";
    pub const BACKGROUND_MISSING: &str =
        "That live background isn't available. Use an id from list_assets.";
    pub const BACKGROUND_FAILED: &str = "Couldn't change the background.";
    pub const NOTIFY_EMPTY: &str = "Say what the notice should say: message.";
    pub const BUDDY_EMPTY: &str = "Say what to change: on, talk or onStream.";
    pub const BUDDY_UNAVAILABLE: &str = "Sidekick isn't available in this Studio.";
    /// Owner rule (plan 211 D12): Sidekick and agents never post in chat on their own.
    pub const BUDDY_AUTO_GONE: &str =
        "Auto is gone: Sidekick never posts in chat on its own. Use talk: bubble.";
    pub const BUDDY_CHAT_MODE: &str = "chatMode is now talk: off, bubble or suggest.";
    pub const LIBRARY_UNAVAILABLE: &str = "The Library isn't available in this Studio.";
    pub const LIBRARY_MISSING_ID: &str = "Say which recording: recordingId from list_recordings.";
    pub const LIBRARY_MISSING: &str = "That recording isn't in the Library.";
    pub const LIBRARY_HOLD: &str = crate::library::copy::CAPTURE_HOLD_REASON;
    pub const LIBRARY_EXPORTING: &str =
        "Exporting the MP4 now. get_recording shows its file when it is done.";
}

fn gain_db(value: Option<&Value>, min: i64, max: i64) -> Option<i64> {
    let raw = value?.as_f64().filter(|v| v.is_finite())?;
    let rounded = (raw + 0.5).floor() as i64;
    Some(rounded.clamp(min, max))
}

fn pickable<'a>(devices: &'a [Device], id: &str, missing: &str) -> Result<&'a Device, String> {
    let Some(device) = devices.iter().find(|d| d.id == id) else {
        return Err(missing.to_string());
    };
    if device.status != DeviceStatus::Available {
        return Err(format!("{} isn't available right now.", device.name));
    }
    Ok(device)
}

fn trash_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "Recycle Bin"
    } else {
        "Trash"
    }
}

fn talk_label(talk: &str) -> &'static str {
    match talk {
        "off" => "Off",
        "suggest" => "Suggest",
        _ => "Bubble",
    }
}

fn buddy_talk_heading(persona_name: Option<&str>) -> String {
    let name = persona_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Sidekick");
    format!("How {name} talks")
}

impl<B: StudioBackend> Studio<B> {
    /// Dispatches one validated `runsIn: studio` tool call.
    pub(super) async fn execute_agent_tool(
        self: &Arc<Self>,
        envelope: &AgentIntentEnvelope,
        cancelled: &Arc<AtomicBool>,
    ) -> AgentIntentOutcome {
        let args = &envelope.args;
        match envelope.tool.as_str() {
            "start_recording" => {
                self.note_record_click(LatencyKind::Start);
                self.agent_start_recording().await
            }
            "stop" => {
                self.note_record_click(LatencyKind::Stop);
                self.agent_stop().await
            }
            "switch_scene" => self.agent_switch_scene(args).await,
            "set_audio" => self.agent_set_audio(args).await,
            "set_takeover" => self.agent_set_takeover(args).await,
            "play_sound" => self.agent_play_sound(args).await,
            "stop_sounds" => self.agent_stop_sounds(args).await,
            "set_highlight" => self.agent_set_highlight(args).await,
            "open_window" => self.agent_open_window(args).await,
            "notify" => agent_notify(args),
            "hide_screen" => self.agent_hide_screen().await,
            "go_live" => self.agent_go_live(args, cancelled).await,
            "set_sources" => self.agent_set_sources(args).await,
            "set_captions" => self.agent_set_captions(args).await,
            "set_background" => self.agent_set_background(args).await,
            "get_scene_layout" => self.agent_get_scene_layout().await,
            "move_on_scene" => self.agent_move_on_scene(args).await,
            "set_scene_item" => self.agent_set_scene_item(args).await,
            "set_buddy" => self.agent_set_buddy(args).await,
            "update_stream_info" => self.agent_update_stream_info(args).await,
            "set_destinations" => self.agent_set_destinations(args).await,
            "get_settings" => self.agent_get_settings().await,
            "update_settings" => self.agent_update_settings(args).await,
            "delete_recording" => self.agent_delete_recording(args).await,
            "export_recording" => self.agent_export_recording(args).await,
            _ => AgentIntentOutcome::refused(super::agent::copy::UNKNOWN_TOOL),
        }
    }

    async fn agent_start_recording(&self) -> AgentIntentOutcome {
        if self.session_owns_transport() {
            return AgentIntentOutcome::refused(remote_copy::ALREADY_RUNNING);
        }
        match self.start_recording().await {
            StartOutcome::Started => {
                AgentIntentOutcome::ok("Recording.", json!({ "started": true }))
            }
            StartOutcome::Busy => AgentIntentOutcome::refused(remote_copy::ALREADY_RUNNING),
            StartOutcome::Refused { .. } => {
                AgentIntentOutcome::refused(remote_copy::RECORD_DID_NOT_START)
            }
        }
    }

    async fn agent_stop(&self) -> AgentIntentOutcome {
        let snapshot = self.snapshot();
        if !self.session_owns_transport() {
            return AgentIntentOutcome::refused(remote_copy::NOT_RUNNING);
        }
        let live = session_is_live(&snapshot.session.status);
        let stopped = if live { "livestream" } else { "recording" };
        if !self.stop().await {
            return AgentIntentOutcome::refused(remote_copy::DID_NOT_STOP);
        }
        let message = if live {
            "The livestream ended."
        } else {
            "The recording stopped."
        };
        AgentIntentOutcome::ok(message, json!({ "stopped": stopped }))
    }

    async fn agent_switch_scene(self: &Arc<Self>, args: &Value) -> AgentIntentOutcome {
        let Some(scene_id) = text_field(args, "sceneId").filter(|s| !s.is_empty()) else {
            return AgentIntentOutcome::refused(remote_copy::SCENE_MISSING);
        };
        let snapshot = self.snapshot();
        let all_presets: Vec<&str> = HORIZONTAL_LAYOUT_PRESETS
            .iter()
            .chain(VERTICAL_LAYOUT_PRESETS.iter())
            .copied()
            .collect();
        let is_preset = all_presets.contains(&scene_id);
        let saved = snapshot
            .scenes
            .scenes
            .iter()
            .find(|s| s.id == scene_id)
            .or_else(|| {
                if !is_preset {
                    return None;
                }
                snapshot.scenes.scenes.iter().find(|s| {
                    s.visual["layout"]
                        .get("layoutPreset")
                        .and_then(Value::as_str)
                        == Some(scene_id)
                        && s.visual["layout"]
                            .get("arrangementMode")
                            .and_then(Value::as_str)
                            != Some("freeform")
                })
            })
            .cloned();
        let Some(saved) = saved else {
            if is_preset {
                let label = layout_preset_label(scene_id, true);
                return AgentIntentOutcome::refused(format!("No scene uses {label}"));
            }
            return AgentIntentOutcome::refused(remote_copy::SCENE_MISSING);
        };
        let outcome = self
            .apply_saved_scene(&saved.id, None, ApplyOptions::default())
            .await;
        if outcome.ok {
            AgentIntentOutcome::ok(
                format!("Switched to {}.", saved.name),
                json!({ "scene": { "id": saved.id, "name": saved.name } }),
            )
        } else {
            let message = outcome
                .message
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| remote_copy::SCENE_FAILED.to_string());
            AgentIntentOutcome {
                ok: false,
                message: Some(message),
                result: None,
            }
        }
    }

    async fn agent_set_audio(&self, args: &Value) -> AgentIntentOutcome {
        let mic = args.get("microphone").and_then(Value::as_object);
        let sys = args.get("systemAudio").and_then(Value::as_object);
        let muted = mic.and_then(|m| m.get("muted")).and_then(Value::as_bool);
        let mic_gain = mic.and_then(|m| {
            gain_db(
                m.get("gainDb"),
                MICROPHONE_GAIN_DB_MIN,
                MICROPHONE_GAIN_DB_MAX,
            )
        });
        let device_id: Option<Option<&str>> = mic.and_then(|m| match m.get("deviceId") {
            Some(Value::String(id)) => Some(Some(id.as_str())),
            Some(Value::Null) => Some(None),
            _ => None,
        });
        let sys_on = sys.and_then(|s| s.get("on")).and_then(Value::as_bool);
        let sys_gain = sys.and_then(|s| {
            gain_db(
                s.get("gainDb"),
                SYSTEM_AUDIO_GAIN_DB_MIN,
                SYSTEM_AUDIO_GAIN_DB_MAX,
            )
        });

        if muted.is_none()
            && mic_gain.is_none()
            && device_id.is_none()
            && sys_on.is_none()
            && sys_gain.is_none()
        {
            return AgentIntentOutcome::refused(copy::SET_AUDIO_EMPTY);
        }

        let mut said: Vec<String> = Vec::new();
        let mut mic_result = Map::new();
        let mut sys_result = Map::new();
        let refuse = |said: &[String], msg: &str| {
            let mut parts = said.to_vec();
            parts.push(msg.to_string());
            AgentIntentOutcome::refused(parts.join(" "))
        };

        if let Some(target_id) = device_id {
            let name = if let Some(id) = target_id {
                let devices: Vec<Device> = self
                    .snapshot()
                    .sources
                    .devices
                    .devices
                    .into_iter()
                    .filter(|d| d.kind == DeviceKind::Microphone)
                    .collect();
                match pickable(&devices, id, copy::MICROPHONE_MISSING) {
                    Ok(dev) => Some(dev.name.clone()),
                    Err(msg) => return refuse(&said, &msg),
                }
            } else {
                None
            };
            if let Err(msg) = self
                .select_source_device(SourceKind::Microphone, target_id)
                .await
            {
                return refuse(&said, &msg);
            }
            mic_result.insert(
                "deviceId".into(),
                target_id.map_or(Value::Null, |id| json!(id)),
            );
            if let Some(ref name) = name {
                mic_result.insert("name".into(), json!(name));
                said.push(format!("The microphone is {name}."));
            } else {
                said.push("The microphone is off.".to_string());
            }
        }

        if let Some(muted) = muted {
            let mode = if muted {
                MicrophoneMode::Mute
            } else {
                MicrophoneMode::Unmute
            };
            if !self.set_microphone_muted(mode).await {
                return refuse(&said, remote_copy::MICROPHONE);
            }
            mic_result.insert("muted".into(), json!(muted));
            said.push(
                if muted {
                    "The microphone is muted."
                } else {
                    "The microphone is on."
                }
                .to_string(),
            );
        }

        if let Some(gain) = mic_gain {
            self.set_microphone_gain(gain as f32).await;
            mic_result.insert("gainDb".into(), json!(gain));
            said.push(format!("Microphone gain is {gain} dB."));
        }

        if let Some(on) = sys_on {
            let snapshot = self.snapshot();
            let status = snapshot
                .sources
                .devices
                .devices
                .iter()
                .find(|d| d.kind == DeviceKind::SystemAudio)
                .map(|d| d.status.clone());
            let shown = audio_mixer::system_audio_switch_view(&audio_mixer::SwitchInput {
                status: status.clone(),
                requested: snapshot.settings.capture.audio.system_audio_enabled,
                session_active: snapshot.session.phase.is_active(),
                confirmed: snapshot.system_audio.confirmed,
                joining: snapshot.system_audio.joining,
                issue: snapshot.system_audio.issue,
                audio_bus_active: snapshot.system_audio.audio_bus_active,
            })
            .checked;
            let mode = if on { "on" } else { "off" };
            match audio_mixer::system_audio_target(mode, status.as_ref(), shown) {
                Some(target) => {
                    self.set_system_audio_enabled(target).await;
                    sys_result.insert("on".into(), json!(on));
                    said.push(
                        if on {
                            "System audio is on."
                        } else {
                            "System audio is off."
                        }
                        .to_string(),
                    );
                }
                None => return refuse(&said, remote_copy::SYSTEM_AUDIO),
            }
        }

        if let Some(gain) = sys_gain {
            let available =
                self.snapshot().sources.devices.devices.iter().any(|d| {
                    d.kind == DeviceKind::SystemAudio && d.status == DeviceStatus::Available
                });
            if !available {
                return refuse(&said, remote_copy::SYSTEM_AUDIO);
            }
            self.set_system_audio_gain(gain as f32).await;
            sys_result.insert("gainDb".into(), json!(gain));
            said.push(format!("System audio gain is {gain} dB."));
        }

        let mut result = Map::new();
        if !mic_result.is_empty() {
            result.insert("microphone".into(), Value::Object(mic_result));
        }
        if !sys_result.is_empty() {
            result.insert("systemAudio".into(), Value::Object(sys_result));
        }
        AgentIntentOutcome::ok(said.join(" "), Value::Object(result))
    }

    async fn agent_set_takeover(&self, args: &Value) -> AgentIntentOutcome {
        let Some(raw) = args.get("takeoverId") else {
            return AgentIntentOutcome::refused(remote_copy::TAKEOVER_MISSING);
        };
        if raw.is_null() {
            let (ok, message) = self.remote_takeover_hide().await;
            return if ok {
                AgentIntentOutcome::ok("The takeover is down.", json!({ "takeoverId": null }))
            } else {
                AgentIntentOutcome::refused(
                    message.unwrap_or_else(|| remote_copy::TAKEOVER_HIDE.into()),
                )
            };
        }
        let id = raw.as_str();
        let (ok, message) = self.remote_takeover_show(id).await;
        if ok {
            AgentIntentOutcome::ok("The takeover is up.", json!({ "takeoverId": raw }))
        } else {
            AgentIntentOutcome::refused(
                message.unwrap_or_else(|| remote_copy::TAKEOVER_SHOW.into()),
            )
        }
    }

    async fn agent_play_sound(&self, args: &Value) -> AgentIntentOutcome {
        let sound_id = text_field(args, "soundId").filter(|s| !s.is_empty());
        let (ok, message) = self.remote_sound(SoundVerb::Press, sound_id).await;
        let Some(sound_id) = sound_id.filter(|_| ok) else {
            return AgentIntentOutcome::refused(
                message.unwrap_or_else(|| remote_copy::SOUND_MISSING.into()),
            );
        };
        let name = self
            .remote_lock()
            .extras
            .sounds
            .iter()
            .find(|s| s.id == sound_id)
            .map(|s| s.name.clone());
        let msg = match name {
            Some(name) if !name.is_empty() => format!("Pressed {name}."),
            _ => "Pressed.".to_string(),
        };
        AgentIntentOutcome::ok(msg, json!({ "soundId": sound_id }))
    }

    async fn agent_stop_sounds(&self, args: &Value) -> AgentIntentOutcome {
        let sound_id = text_field(args, "soundId").filter(|s| !s.is_empty());
        let (ok, message) = self.remote_sound(SoundVerb::Stop, sound_id).await;
        if !ok {
            return AgentIntentOutcome::refused(
                message.unwrap_or_else(|| remote_copy::FAILED.into()),
            );
        }
        let Some(sound_id) = sound_id else {
            return AgentIntentOutcome::ok("Every sound stopped.", json!({ "all": true }));
        };
        let name = self
            .remote_lock()
            .extras
            .sounds
            .iter()
            .find(|s| s.id == sound_id)
            .map(|s| s.name.clone());
        let msg = match name {
            Some(name) if !name.is_empty() => format!("{name} stopped."),
            _ => "Stopped.".to_string(),
        };
        AgentIntentOutcome::ok(msg, json!({ "soundId": sound_id, "all": false }))
    }

    async fn agent_set_highlight(&self, args: &Value) -> AgentIntentOutcome {
        let Some(raw) = args.get("messageId") else {
            return AgentIntentOutcome::refused(remote_copy::MESSAGE_MISSING);
        };
        if raw.is_null() {
            let (ok, message) = self.remote_comment_highlight_clear().await;
            return if ok {
                AgentIntentOutcome::ok(
                    "The comment is off the stream.",
                    json!({ "messageId": null }),
                )
            } else {
                AgentIntentOutcome::refused(message.unwrap_or_else(|| remote_copy::FAILED.into()))
            };
        }
        let Some(message_id) = raw.as_str().filter(|s| !s.is_empty()) else {
            return AgentIntentOutcome::refused(remote_copy::MESSAGE_MISSING);
        };
        let (ok, message) = self.remote_comment_highlight(message_id).await;
        if ok {
            AgentIntentOutcome::ok(
                "The comment is on the stream.",
                json!({ "messageId": message_id }),
            )
        } else {
            AgentIntentOutcome::refused(message.unwrap_or_else(|| remote_copy::FAILED.into()))
        }
    }

    async fn agent_open_window(&self, args: &Value) -> AgentIntentOutcome {
        let Some(window_name) = text_field(args, "window").filter(|s| !s.is_empty()) else {
            return AgentIntentOutcome::refused(remote_copy::WINDOW_MISSING);
        };
        let target = match window_name {
            "stream-manager" => Some(RemoteWindow::Comments),
            "notes" => Some(RemoteWindow::Notes),
            "preview" => Some(RemoteWindow::Preview),
            _ => None,
        };
        let Some(target) = target else {
            return AgentIntentOutcome::refused(remote_copy::WINDOW_MISSING);
        };
        let (ok, message) = self.ask_app_window(target).await;
        if ok {
            AgentIntentOutcome::ok("It is in front.", json!({ "window": window_name }))
        } else {
            AgentIntentOutcome::refused(
                message.unwrap_or_else(|| remote_copy::WINDOW_MISSING.into()),
            )
        }
    }

    async fn agent_hide_screen(&self) -> AgentIntentOutcome {
        let (ok, message) = self.remote_screen_privacy(PrivacyMode::Hide).await;
        if ok {
            AgentIntentOutcome::ok("Screen hidden.", json!({ "hidden": true }))
        } else {
            AgentIntentOutcome::refused(message.unwrap_or_else(|| remote_copy::FAILED.into()))
        }
    }

    async fn agent_set_sources(&self, args: &Value) -> AgentIntentOutcome {
        let screen_id = text_field(args, "screenId").filter(|s| !s.is_empty());
        let window_id = text_field(args, "windowId").filter(|s| !s.is_empty());
        let camera_id: Option<Option<&str>> = match args.get("cameraId") {
            Some(Value::String(id)) => Some(Some(id.as_str())),
            Some(Value::Null) => Some(None),
            _ => None,
        };
        if screen_id.is_some() && window_id.is_some() {
            return AgentIntentOutcome::refused(copy::SCREEN_OR_WINDOW);
        }
        if screen_id.is_none() && window_id.is_none() && camera_id.is_none() {
            return AgentIntentOutcome::refused(copy::SET_SOURCES_EMPTY);
        }

        let devices = self.snapshot().sources.devices.devices;
        let mut said: Vec<String> = Vec::new();
        let mut result = Map::new();

        if let Some(capture_id) = screen_id.or(window_id) {
            let is_screen = screen_id.is_some();
            let wanted_kind = if is_screen {
                DeviceKind::Screen
            } else {
                DeviceKind::Window
            };
            let kind_str = if is_screen { "screen" } else { "window" };
            let filtered: Vec<Device> = devices
                .iter()
                .filter(|d| d.kind == wanted_kind)
                .cloned()
                .collect();
            let found = match pickable(
                &filtered,
                capture_id,
                if is_screen {
                    copy::SCREEN_MISSING
                } else {
                    copy::WINDOW_MISSING
                },
            ) {
                Ok(dev) => dev.clone(),
                Err(msg) => return AgentIntentOutcome::refused(msg),
            };
            if let Err(msg) = self
                .select_source_device(SourceKind::Capture, Some(capture_id))
                .await
            {
                return AgentIntentOutcome::refused(msg);
            }
            result.insert(
                kind_str.into(),
                json!({ "id": capture_id, "name": found.name }),
            );
            said.push(format!("The {kind_str} is {}.", found.name));
        }

        if let Some(cam_target) = camera_id {
            let name = if let Some(id) = cam_target {
                let cameras: Vec<Device> = devices
                    .iter()
                    .filter(|d| d.kind == DeviceKind::Camera)
                    .cloned()
                    .collect();
                match pickable(&cameras, id, copy::CAMERA_MISSING) {
                    Ok(dev) => Some(dev.name.clone()),
                    Err(msg) => {
                        let mut parts = said;
                        parts.push(msg);
                        return AgentIntentOutcome::refused(parts.join(" "));
                    }
                }
            } else {
                None
            };
            if let Err(msg) = self
                .select_source_device(SourceKind::Camera, cam_target)
                .await
            {
                let mut parts = said;
                if !msg.is_empty() {
                    parts.push(msg);
                }
                return AgentIntentOutcome::refused(parts.join(" "));
            }
            if let Some(id) = cam_target {
                result.insert("camera".into(), json!({ "id": id, "name": name }));
                if let Some(name) = name {
                    said.push(format!("The camera is {name}."));
                }
            } else {
                result.insert("camera".into(), Value::Null);
                said.push("The camera is off.".to_string());
            }
        }

        AgentIntentOutcome::ok(said.join(" "), Value::Object(result))
    }

    async fn agent_set_captions(&self, args: &Value) -> AgentIntentOutcome {
        let on = args.get("on").and_then(Value::as_bool) == Some(true);
        let message = if on {
            "Live captions are on."
        } else {
            "Live captions are off."
        };
        let snapshot = self.snapshot();
        if on == snapshot.settings.capture.captions.enabled {
            return AgentIntentOutcome::ok(message, json!({ "on": on }));
        }
        if on {
            let gate =
                crate::account::entitlements::cloud_ai_upload_gate(snapshot.entitlements.as_ref());
            if !gate.allowed() {
                return AgentIntentOutcome::refused(
                    gate.reason()
                        .unwrap_or("Live captions require Videorc Premium.")
                        .to_string(),
                );
            }
        }
        let _ = self
            .update_capture_config(move |config| {
                if !config["captions"].is_object() {
                    config["captions"] = json!({});
                }
                config["captions"]["enabled"] = json!(on);
            })
            .await;
        AgentIntentOutcome::ok(message, json!({ "on": on }))
    }

    async fn agent_set_background(self: &Arc<Self>, args: &Value) -> AgentIntentOutcome {
        let Some(raw) = args.get("liveId") else {
            return AgentIntentOutcome::refused(copy::BACKGROUND_MISSING);
        };
        let current = self.snapshot().scenes.working_background;
        if raw.is_null() {
            if current.is_none() {
                return AgentIntentOutcome::ok(
                    "There is no background.",
                    json!({ "liveId": null }),
                );
            }
            return match self.apply_working_background(None).await {
                Ok(()) => {
                    AgentIntentOutcome::ok("The background is off.", json!({ "liveId": null }))
                }
                Err(_) => AgentIntentOutcome::refused(copy::BACKGROUND_FAILED),
            };
        }
        let Some(live_id) = raw.as_str().filter(|id| LIVE_BACKGROUND_IDS.contains(id)) else {
            return AgentIntentOutcome::refused(copy::BACKGROUND_MISSING);
        };
        let name = live_background_name(live_id);
        let current_live_id = current
            .as_ref()
            .and_then(|bg| bg.get("live"))
            .and_then(|live| live.get("id"))
            .and_then(Value::as_str);
        if current_live_id == Some(live_id) {
            return AgentIntentOutcome::ok(
                format!("{name} is on the scene."),
                json!({ "liveId": live_id, "name": name }),
            );
        }
        let Some(style) = live_background_style(live_id) else {
            return AgentIntentOutcome::refused(copy::BACKGROUND_MISSING);
        };
        match self.apply_working_background(Some(&style)).await {
            Ok(()) => AgentIntentOutcome::ok(
                format!("{name} is on the scene."),
                json!({ "liveId": live_id, "name": name }),
            ),
            Err(_) => AgentIntentOutcome::refused(copy::BACKGROUND_FAILED),
        }
    }

    async fn agent_set_buddy(&self, args: &Value) -> AgentIntentOutcome {
        // Owner rule: Sidekick and agents never post anything in chat on their own.
        if let Some(chat_mode) = args.get("chatMode") {
            return AgentIntentOutcome::refused(if chat_mode.as_str() == Some("auto") {
                copy::BUDDY_AUTO_GONE
            } else {
                copy::BUDDY_CHAT_MODE
            });
        }
        let on = args.get("on").and_then(Value::as_bool);
        let talk = args
            .get("talk")
            .and_then(Value::as_str)
            .filter(|m| matches!(*m, "off" | "bubble" | "suggest"));
        let on_stream = args.get("onStream").and_then(Value::as_bool);
        if on.is_none() && talk.is_none() && on_stream.is_none() {
            return AgentIntentOutcome::refused(copy::BUDDY_EMPTY);
        }

        let current_raw = self
            .backend
            .buddy_request(COHOST_SETTINGS_GET_METHOD, json!({}))
            .await
            .ok();
        let current = current_raw.as_ref().and_then(CohostSettingsView::from_json);
        if (on.is_some() || talk.is_some()) && current.is_none() {
            return AgentIntentOutcome::refused(buddy_copy::LOADING);
        }
        if let Some(ref view) = current {
            self.note_buddy_live(view.enabled);
        }

        let turning_on = on == Some(true) && current.as_ref().is_none_or(|c| !c.enabled);
        if turning_on {
            let gate = match self
                .backend
                .buddy_request(ENTITLEMENTS_GET_METHOD, Value::Null)
                .await
            {
                Ok(value) => live_cohost_gate(read_snapshot(&value).as_ref()),
                Err(_) => live_cohost_gate(self.snapshot().entitlements.as_ref()),
            };
            let consented = self.read_ui_settings(families::ai_consent);
            if let Some(refusal) = buddy_live_refusal(&gate, consented) {
                return AgentIntentOutcome::refused(refusal);
            }
        }

        let mut said: Vec<String> = Vec::new();
        let mut saved_raw = current_raw.clone();
        if on.is_some() || talk.is_some() {
            let target_enabled = on.unwrap_or_else(|| current.as_ref().is_some_and(|c| c.enabled));
            let auto_chat = talk.map(|t| {
                let mut block = current_raw
                    .as_ref()
                    .and_then(|v| v.get("autoChat"))
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                block.insert("talk".into(), json!(t));
                Value::Object(block)
            });
            let mut patch = enable_patch(
                current.as_ref().map(|c| c.enabled),
                target_enabled,
                None,
                false,
            );
            if let Some(auto_chat) = auto_chat {
                patch.insert("autoChat".into(), auto_chat);
            }
            if !patch.is_empty() {
                match self
                    .backend
                    .buddy_request(COHOST_SETTINGS_SET_METHOD, Value::Object(patch))
                    .await
                {
                    Ok(saved) => {
                        self.note_cohost_settings(&saved);
                        saved_raw = Some(saved);
                    }
                    Err(error) => {
                        self.config.logger.warn(format!(
                            "[agents] Sidekick settings did not save: {} ({})",
                            error.message, error.code
                        ));
                        return AgentIntentOutcome::refused(super::agent::copy::FAILED);
                    }
                }
            }
            if let Some(on) = on {
                said.push(if on { buddy_copy::ON } else { buddy_copy::OFF }.to_string());
            }
            if let Some(talk) = talk {
                let persona_name = current_raw
                    .as_ref()
                    .and_then(|v| v.get("persona"))
                    .and_then(|p| p.get("name"))
                    .and_then(Value::as_str);
                said.push(format!(
                    "{}: {}.",
                    buddy_talk_heading(persona_name),
                    talk_label(talk)
                ));
            }
        }

        let mut final_on_stream = true;
        if let Ok(mut layout) = self.overlay_layout().await {
            final_on_stream = layout["buddy"]["showOnStream"].as_bool().unwrap_or(true);
            if let Some(want) = on_stream {
                if want != final_on_stream {
                    layout["buddy"]["showOnStream"] = json!(want);
                    if self.set_overlay_layout(layout).await.is_none() {
                        return AgentIntentOutcome::refused(super::agent::copy::FAILED);
                    }
                    final_on_stream = want;
                }
                said.push(
                    if want {
                        "Your avatar is on stream."
                    } else {
                        "Your avatar is off the stream."
                    }
                    .to_string(),
                );
            }
        } else if on_stream.is_some() {
            return AgentIntentOutcome::refused(copy::BUDDY_UNAVAILABLE);
        }

        let final_on = saved_raw
            .as_ref()
            .and_then(|v| v.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let final_talk = saved_raw
            .as_ref()
            .and_then(|v| v.get("autoChat"))
            .and_then(|ac| ac.get("talk"))
            .and_then(Value::as_str)
            .unwrap_or("bubble");

        AgentIntentOutcome::ok(
            said.join(" "),
            json!({
                "on": final_on,
                "talk": final_talk,
                "onStream": final_on_stream,
            }),
        )
    }

    async fn agent_delete_recording(&self, args: &Value) -> AgentIntentOutcome {
        let Some(id) = args
            .get("recordingId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return AgentIntentOutcome::refused(copy::LIBRARY_MISSING_ID);
        };
        if self.session_owns_transport() {
            return AgentIntentOutcome::refused(copy::LIBRARY_HOLD);
        }
        match self
            .ask_agent_app(AppAgentAction::DeleteRecording {
                recording_id: id.to_string(),
            })
            .await
        {
            Ok(super::agent::AppAgentAnswer::Deleted { title }) => {
                let trash = trash_name();
                let message = match title {
                    Some(title) if !title.is_empty() => {
                        format!("Moved \"{title}\" to the {trash}. It can be put back from there.")
                    }
                    _ => format!(
                        "Moved the recording to the {trash}. It can be put back from there."
                    ),
                };
                AgentIntentOutcome::ok(message, json!({ "recordingId": id, "trashed": true }))
            }
            Ok(_) => AgentIntentOutcome::refused(copy::LIBRARY_UNAVAILABLE),
            Err(message) => AgentIntentOutcome::refused(normalize_library_error(
                &message,
                "Videorc couldn't delete that recording.",
            )),
        }
    }

    async fn agent_export_recording(&self, args: &Value) -> AgentIntentOutcome {
        let Some(id) = args
            .get("recordingId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return AgentIntentOutcome::refused(copy::LIBRARY_MISSING_ID);
        };
        let session_active = self.session_owns_transport();
        match self
            .ask_agent_app(AppAgentAction::ExportRecording {
                recording_id: id.to_string(),
                session_active,
            })
            .await
        {
            Ok(super::agent::AppAgentAnswer::Exported {
                already_mp4,
                exported,
                path,
            }) => {
                if already_mp4 {
                    let mut result = json!({ "recordingId": id, "exported": true });
                    if let Some(p) = path {
                        result["path"] = json!(p);
                    }
                    AgentIntentOutcome::ok("That recording is already an MP4.", result)
                } else if !exported {
                    AgentIntentOutcome::ok(
                        copy::LIBRARY_EXPORTING,
                        json!({ "recordingId": id, "exported": false }),
                    )
                } else {
                    let mut result = json!({ "recordingId": id, "exported": true });
                    if let Some(p) = path {
                        result["path"] = json!(p);
                    }
                    AgentIntentOutcome::ok("Exported the MP4.", result)
                }
            }
            Ok(_) => AgentIntentOutcome::refused(copy::LIBRARY_UNAVAILABLE),
            Err(message) => AgentIntentOutcome::refused(normalize_library_error(
                &message,
                "Videorc couldn't export that recording.",
            )),
        }
    }
}

fn agent_notify(args: &Value) -> AgentIntentOutcome {
    let valid = args
        .get("message")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty());
    if !valid {
        return AgentIntentOutcome::refused(copy::NOTIFY_EMPTY);
    }
    AgentIntentOutcome::ok("Shown in Videorc.", json!({ "shown": true }))
}

fn normalize_library_error(text: &str, fallback: &str) -> String {
    let trimmed = text.trim();
    if trimmed.to_lowercase().contains("not found") {
        copy::LIBRARY_MISSING.to_string()
    } else if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}
