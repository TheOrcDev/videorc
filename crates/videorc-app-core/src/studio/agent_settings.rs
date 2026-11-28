//! `get_settings` and `update_settings` (plan 209 S14, D16; Electron's
//! `lib/studio-actions/settings.ts`): the curated settings an agent may read
//! and change, and nothing else.

use serde_json::{Value, json};
use videorc_protocol::{VideoSettings, VirtualCameraPlatformStep, VirtualCameraStatus};

use super::agent::AgentIntentOutcome;
use super::capture_config;
use super::settings::{SettingWrite, keys};
use super::virtual_camera::{camera_copy, camera_hidden};
use super::{Studio, StudioBackend, StudioSnapshot};
use crate::account::entitlements::{ProfileKind, video_profile_entitlement_gate};
use crate::captions;

/// D16: every name `update_settings` takes. Matches `protocol-fixtures/agent-tools.json`.
pub const CURATED_SETTINGS: [&str; 10] = [
    "resolution",
    "frameRate",
    "keepOriginalRecording",
    "recordingFolder",
    "separateSourceRecordings",
    "clips",
    "captionsLanguage",
    "chatInStudio",
    "theme",
    "videorcCamera",
];

const THEMES: [&str; 3] = ["light", "dark", "system"];
const FRAME_RATE_MIN: u32 = 24;
const FRAME_RATE_MAX: u32 = 60;

pub mod copy {
    pub const UNAVAILABLE: &str = "Settings aren't available in this Studio.";
    pub const EMPTY: &str = "Say which settings to change.";
    pub const SESSION_LOCK_REASON: &str =
        "Locked while you're recording or live. Changes apply the next time you record or go live.";
    pub const RECORD_OFF: &str = "Turn on Save a local recording in Videorc → Output first: the size and rate are the recording file’s.";
    pub const FOLDER_PICKER: &str = "Only \"default\" is accepted: choose another recordings folder in Videorc → Output → Choose….";
    pub const SEPARATE_SOURCES_UNSUPPORTED: &str =
        "Separate source recordings are only available on macOS right now.";

    pub fn not_curated(name: &str) -> String {
        format!(
            "\"{name}\" isn't a setting agents can change. get_settings lists the ones they can."
        )
    }
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

fn resolution_options(vertical: bool) -> [(&'static str, u32, u32, u32); 4] {
    if vertical {
        [
            ("720p", 720, 1280, 6_000),
            ("1080p", 1080, 1920, 10_000),
            ("1440p", 1440, 2560, 18_000),
            ("4K", 2160, 3840, 35_000),
        ]
    } else {
        [
            ("720p", 1280, 720, 6_000),
            ("1080p", 1920, 1080, 10_000),
            ("1440p", 2560, 1440, 18_000),
            ("4K", 3840, 2160, 35_000),
        ]
    }
}

fn resolution_label(video: &VideoSettings, vertical: bool) -> String {
    resolution_options(vertical)
        .iter()
        .find(|(_, w, h, _)| *w == video.width && *h == video.height)
        .map(|(label, ..)| (*label).to_string())
        .unwrap_or_else(|| format!("{}x{}", video.width, video.height))
}

fn is_vertical(snapshot: &StudioSnapshot) -> bool {
    snapshot
        .settings
        .capture_doc
        .get("layout")
        .and_then(|l| l.get("layoutPreset"))
        .and_then(Value::as_str)
        .is_some_and(capture_config::layout_preset_is_vertical)
}

pub fn curated_settings_json(
    snapshot: &StudioSnapshot,
    virtual_camera: Option<&VirtualCameraStatus>,
) -> Value {
    let vertical = is_vertical(snapshot);
    let video = &snapshot.settings.capture.video;
    let folder = snapshot.settings.studio.output_directory().trim();
    let theme = snapshot
        .settings
        .theme
        .as_deref()
        .filter(|t| THEMES.contains(t))
        .unwrap_or("system");
    let separate_supported = current_platform() == "darwin";
    let separate_enabled = snapshot
        .settings
        .capture_doc
        .get("separateSourceRecordings")
        .and_then(|s| s.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let videorc_camera =
        virtual_camera.is_some_and(|status| status.on && !camera_hidden(Some(status)));
    json!({
        "resolution": resolution_label(video, vertical),
        "frameRate": video.fps,
        "keepOriginalRecording": snapshot.settings.studio.keep_original_recording(),
        "recordingFolder": if folder.is_empty() { "default" } else { folder },
        "separateSourceRecordings": separate_supported && separate_enabled,
        "clips": snapshot.settings.capture.replay_buffer.enabled,
        "captionsLanguage": snapshot.settings.capture.captions.language,
        "chatInStudio": snapshot.settings.studio.studio_chat(),
        "theme": theme,
        "videorcCamera": videorc_camera,
    })
}

pub fn virtual_camera_setting_refusal(
    status: Option<&VirtualCameraStatus>,
    connected: bool,
    os: &str,
    on: bool,
) -> Option<String> {
    if !connected {
        return Some(crate::studio::virtual_camera::OFFLINE_LOCK.to_string());
    }
    let Some(status) = status else {
        return Some(camera_copy::NOT_IN_THIS_STUDIO.to_string());
    };
    if camera_hidden(Some(status)) {
        return Some(camera_copy::UNSUPPORTED.to_string());
    }
    if !status.available {
        if status.platform_step == Some(VirtualCameraPlatformStep::Failed)
            && let Some(msg) = status.message.as_deref().filter(|m| !m.trim().is_empty())
        {
            return Some(msg.to_string());
        }
        return Some(camera_copy::cant_run(crate::format::device_noun(os)));
    }
    if on && status.platform_step == Some(VirtualCameraPlatformStep::NeedsReboot) {
        return Some(camera_copy::needs_restart(crate::format::device_noun(os)));
    }
    None
}

impl<B: StudioBackend> Studio<B> {
    async fn read_virtual_camera_status(&self) -> Option<VirtualCameraStatus> {
        let value = self
            .backend
            .virtual_camera_request("virtualCamera.status", Value::Null)
            .await
            .ok()?;
        serde_json::from_value(value).ok()
    }

    pub(super) async fn agent_get_settings(&self) -> AgentIntentOutcome {
        if !self.is_connected() {
            return AgentIntentOutcome::refused(copy::UNAVAILABLE);
        }
        let snapshot = self.snapshot();
        let vcam = self.read_virtual_camera_status().await;
        AgentIntentOutcome::ok(
            "The settings agents can change, as they stand.",
            curated_settings_json(&snapshot, vcam.as_ref()),
        )
    }

    pub(super) async fn agent_update_settings(&self, args: &Value) -> AgentIntentOutcome {
        if !self.is_connected() {
            return AgentIntentOutcome::refused(copy::UNAVAILABLE);
        }
        let Some(map) = args.as_object() else {
            return AgentIntentOutcome::refused(copy::EMPTY);
        };
        if map.is_empty() {
            return AgentIntentOutcome::refused(copy::EMPTY);
        }
        for name in map.keys() {
            if !CURATED_SETTINGS.contains(&name.as_str()) {
                return AgentIntentOutcome::refused(copy::not_curated(name));
            }
        }

        let snapshot = self.snapshot();
        let session_active = self.session_owns_transport();
        let vertical = is_vertical(&snapshot);
        let os = current_platform();
        let mut said: Vec<String> = Vec::new();

        // Validate everything first so a refusal changes nothing.
        let mut video_patch: Option<(u32, u32, u32, u32)> = None;
        if map.contains_key("resolution") || map.contains_key("frameRate") {
            if session_active {
                return AgentIntentOutcome::refused(copy::SESSION_LOCK_REASON);
            }
            if !snapshot.settings.capture.record_enabled {
                return AgentIntentOutcome::refused(copy::RECORD_OFF);
            }
            let mut video = snapshot.settings.capture.video.clone();
            if let Some(res_val) = map.get("resolution") {
                let Some(label) = res_val.as_str() else {
                    return AgentIntentOutcome::refused(
                        "resolution must be 720p, 1080p, 1440p or 4K.",
                    );
                };
                let Some((_, w, h, bitrate)) = resolution_options(vertical)
                    .into_iter()
                    .find(|(candidate, ..)| *candidate == label)
                else {
                    return AgentIntentOutcome::refused(
                        "resolution must be 720p, 1080p, 1440p or 4K.",
                    );
                };
                video.width = w;
                video.height = h;
                video.bitrate_kbps = bitrate;
                said.push(format!("Resolution {label}."));
            }
            if let Some(fps_val) = map.get("frameRate") {
                let valid_fps = fps_val
                    .as_u64()
                    .filter(|&v| v >= u64::from(FRAME_RATE_MIN) && v <= u64::from(FRAME_RATE_MAX))
                    .and_then(|v| u32::try_from(v).ok());
                let Some(fps) = valid_fps else {
                    return AgentIntentOutcome::refused(format!(
                        "frameRate must be a whole number from {FRAME_RATE_MIN} to {FRAME_RATE_MAX}."
                    ));
                };
                video.fps = fps;
                said.push(format!("{fps} fps."));
            }
            let gate = video_profile_entitlement_gate(
                snapshot.entitlements.as_ref(),
                ProfileKind::Recording,
                &video,
            );
            if !gate.allowed() {
                return AgentIntentOutcome::refused(
                    gate.reason()
                        .unwrap_or("This recording profile requires Videorc Premium.")
                        .to_string(),
                );
            }
            video_patch = Some((video.width, video.height, video.fps, video.bitrate_kbps));
        }

        let mut separate_patch: Option<bool> = None;
        if let Some(val) = map.get("separateSourceRecordings") {
            let Some(on) = val.as_bool() else {
                return AgentIntentOutcome::refused(
                    "separateSourceRecordings must be true or false.",
                );
            };
            if on && os != "darwin" {
                return AgentIntentOutcome::refused(copy::SEPARATE_SOURCES_UNSUPPORTED);
            }
            if session_active {
                return AgentIntentOutcome::refused(copy::SESSION_LOCK_REASON);
            }
            if !snapshot.settings.capture.record_enabled {
                return AgentIntentOutcome::refused(copy::RECORD_OFF);
            }
            separate_patch = Some(on);
            said.push(
                if on {
                    "Separate source recordings on."
                } else {
                    "Separate source recordings off."
                }
                .to_string(),
            );
        }

        let mut captions_lang_patch: Option<&'static str> = None;
        if let Some(val) = map.get("captionsLanguage") {
            let found = val.as_str().and_then(|id| {
                captions::LANGUAGES
                    .iter()
                    .find(|(lang_id, _)| *lang_id == id)
            });
            let Some(&(id, label)) = found else {
                let ids = captions::LANGUAGES
                    .iter()
                    .map(|(id, _)| *id)
                    .collect::<Vec<_>>()
                    .join(", ");
                return AgentIntentOutcome::refused(format!(
                    "captionsLanguage must be one of {ids}."
                ));
            };
            if session_active {
                return AgentIntentOutcome::refused(copy::SESSION_LOCK_REASON);
            }
            captions_lang_patch = Some(id);
            said.push(format!("Captions language: {label}."));
        }

        let mut reset_folder = false;
        if let Some(val) = map.get("recordingFolder") {
            if val.as_str() != Some("default") {
                return AgentIntentOutcome::refused(copy::FOLDER_PICKER);
            }
            reset_folder = true;
            said.push("Recordings go to Videorc's default folder.".to_string());
        }

        let mut keep_original_patch: Option<bool> = None;
        let mut clips_patch: Option<bool> = None;
        let mut chat_in_studio_patch: Option<bool> = None;
        for (name, label) in [
            ("keepOriginalRecording", "Keep original recording"),
            ("clips", "Clips"),
            ("chatInStudio", "Chat in Studio"),
        ] {
            if let Some(val) = map.get(name) {
                let Some(on) = val.as_bool() else {
                    return AgentIntentOutcome::refused(format!("{name} must be true or false."));
                };
                match name {
                    "keepOriginalRecording" => keep_original_patch = Some(on),
                    "clips" => clips_patch = Some(on),
                    _ => chat_in_studio_patch = Some(on),
                }
                said.push(format!("{label} {}.", if on { "on" } else { "off" }));
            }
        }

        let mut theme_patch: Option<&'static str> = None;
        if let Some(val) = map.get("theme") {
            let Some(&theme) = val
                .as_str()
                .and_then(|t| THEMES.iter().find(|&&candidate| candidate == t))
            else {
                return AgentIntentOutcome::refused("theme must be light, dark or system.");
            };
            theme_patch = Some(theme);
            said.push(format!("Theme: {theme}."));
        }

        let mut vcam_patch: Option<bool> = None;
        if let Some(val) = map.get("videorcCamera") {
            let Some(on) = val.as_bool() else {
                return AgentIntentOutcome::refused("videorcCamera must be true or false.");
            };
            let vcam = self.read_virtual_camera_status().await;
            if let Some(refusal) = virtual_camera_setting_refusal(vcam.as_ref(), true, os, on) {
                return AgentIntentOutcome::refused(refusal);
            }
            vcam_patch = Some(on);
            said.push(
                if on {
                    "Videorc Camera on."
                } else {
                    "Videorc Camera off."
                }
                .to_string(),
            );
        }

        // Apply: async virtual camera first so a failure changes nothing else.
        if let Some(on) = vcam_patch {
            let method = if on {
                "virtualCamera.enable"
            } else {
                "virtualCamera.disable"
            };
            if let Err(error) = self
                .backend
                .virtual_camera_request(method, Value::Null)
                .await
            {
                let message = if error.message.trim().is_empty() {
                    copy::UNAVAILABLE.to_string()
                } else {
                    error.message
                };
                return AgentIntentOutcome::refused(message);
            }
        }

        if video_patch.is_some() || separate_patch.is_some() || captions_lang_patch.is_some() {
            let _ = self
                .update_capture_config(move |config| {
                    if let Some((w, h, fps, bitrate)) = video_patch {
                        config["video"]["width"] = json!(w);
                        config["video"]["height"] = json!(h);
                        config["video"]["fps"] = json!(fps);
                        config["video"]["bitrateKbps"] = json!(bitrate);
                    }
                    if let Some(on) = separate_patch {
                        if !config["separateSourceRecordings"].is_object() {
                            config["separateSourceRecordings"] = json!({});
                        }
                        config["separateSourceRecordings"]["enabled"] = json!(on);
                    }
                    if let Some(lang) = captions_lang_patch {
                        if !config["captions"].is_object() {
                            config["captions"] = json!({});
                        }
                        config["captions"]["language"] = json!(lang);
                    }
                })
                .await;
        }

        if reset_folder || keep_original_patch.is_some() || chat_in_studio_patch.is_some() {
            let _ = self
                .update_studio_settings(move |settings| {
                    if reset_folder {
                        settings.set("outputDirectory", json!(""));
                        settings.remove("outputDirectoryHandle");
                    }
                    if let Some(on) = keep_original_patch {
                        settings.set("keepOriginalRecording", json!(on));
                    }
                    if let Some(on) = chat_in_studio_patch {
                        settings.set("studioChat", json!(on));
                    }
                })
                .await;
        }

        if let Some(on) = clips_patch {
            self.set_clips_enabled(on).await;
        }

        if let Some(theme) = theme_patch {
            let _ = self
                .write_settings(vec![SettingWrite::text(keys::THEME, theme)])
                .await;
        }

        AgentIntentOutcome::ok(
            said.join(" "),
            json!({ "changed": Value::Object(map.clone()) }),
        )
    }
}
