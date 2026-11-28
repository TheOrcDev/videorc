//! The Studio's projection for agents (plan 209 S6, Electron's
//! `lib/agent-surface.ts`): what `get_status` and the `list_*` tools read
//! about the renderer-owned truth, published through `agent.surface.publish`
//! and merged by the backend with its own truth (`agent_look.rs`).
//!
//! Built by ALLOWLIST, field by field, like [`super::remote`]: never a token,
//! a key, a server URL, an account id, or a file path (D9).
//!
//! Published only while Agents is on (`agents.status`), or while Sidekick may
//! act (Premium, `buddy_can_act`). Debounced by 150 ms, deduplicated per
//! connection, republished on every `backend.ready`, and retried on
//! `[1s, 2s, 4s]` when a publish fails.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use videorc_protocol::{DeviceKind, DeviceStatus};

use super::audio_mixer;
use super::families;
use super::inspector::{StartGates, live_stream_blocked_reason, record_blocked_reason};
use super::remote::RemoteExtras;
use super::{Connection, Studio, StudioBackend, StudioSnapshot};
use crate::account::entitlements::live_cohost_gate;
use crate::desktop::accelerator::accelerator_label;
use crate::livestream::accounts::destination_label;
use crate::livestream::details::MetadataDraft;
use crate::livestream::lifecycle::start_ready;
use crate::livestream::targets::targets as stream_targets;
use crate::scenes::list::scene_shortcut_bindings;
use crate::scenes::section::shows_words;
use crate::scenes::v2::{layout_shows_screen, shows_from_sources};

/// Coalesce state bursts (`PUBLISH_DEBOUNCE_MS`).
pub const AGENT_PUBLISH_DEBOUNCE: Duration = Duration::from_millis(150);
/// Bounded retries after a failed publish (`PUBLISH_RETRY_DELAYS_MS`).
pub const AGENT_PUBLISH_RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];

const CAPTIONS_RUNNING: [&str; 4] = ["starting", "listening", "reconnecting", "degraded"];

fn present(text: Option<&str>) -> Option<String> {
    text.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSurfaceActiveScene {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub modified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSurfaceSceneEntry {
    pub id: String,
    pub name: String,
    pub position: usize,
    pub key: String,
    pub shows: String,
    pub on_stream: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSurfaceMicrophone {
    pub muted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSurfaceSystemAudio {
    pub on: bool,
    pub available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSurfaceNamed {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSurfaceSound {
    pub id: String,
    pub name: String,
    pub playing: bool,
}

/// Never named `background`: the backend resolves every `background` object in
/// a renderer's params as a managed picture (`assetId`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum AgentSurfaceBackground {
    #[serde(rename_all = "camelCase")]
    Live {
        #[serde(rename = "liveId")]
        live_id: String,
        look: String,
    },
    Picture {
        picture: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSurfaceCaptions {
    pub on: bool,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSurfaceBuddy {
    pub on: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSurfaceDevice {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub available: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSurfaceChosenSources {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub microphone_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSurfaceSources {
    pub devices: Vec<AgentSurfaceDevice>,
    pub chosen: AgentSurfaceChosenSources,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSurfaceDestination {
    pub id: String,
    pub platform: String,
    pub label: String,
    pub on: bool,
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSurfaceWindows {
    pub notes: bool,
    pub stream_manager: bool,
    pub preview: bool,
}

/// The allowlisted Studio projection sent in `agent.surface.publish`
/// (`{ surface: AgentSurface }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSurface {
    pub version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_blocked_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_blocked_reason: Option<String>,
    pub scene: AgentSurfaceActiveScene,
    pub scenes: Vec<AgentSurfaceSceneEntry>,
    pub microphone: AgentSurfaceMicrophone,
    pub system_audio: AgentSurfaceSystemAudio,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub takeover_id: Option<String>,
    pub takeovers: Vec<AgentSurfaceNamed>,
    pub sounds: Vec<AgentSurfaceSound>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_background: Option<AgentSurfaceBackground>,
    pub captions: AgentSurfaceCaptions,
    pub buddy: AgentSurfaceBuddy,
    pub sources: AgentSurfaceSources,
    pub destinations: Vec<AgentSurfaceDestination>,
    pub windows: AgentSurfaceWindows,
    pub cloud_ai_consent: bool,
}

fn device_kind_wire(kind: &DeviceKind) -> Option<&'static str> {
    match kind {
        DeviceKind::Screen => Some("screen"),
        DeviceKind::Window => Some("window"),
        DeviceKind::Camera => Some("camera"),
        DeviceKind::Microphone => Some("microphone"),
        DeviceKind::SystemAudio => None,
    }
}

fn background_of(snapshot: &StudioSnapshot) -> Option<AgentSurfaceBackground> {
    let background = snapshot.scenes.working_background.as_ref()?;
    if let Some(live) = background.get("live").and_then(Value::as_object) {
        let live_id = live.get("id").and_then(Value::as_str)?;
        let look = live.get("look").and_then(Value::as_str).unwrap_or_default();
        return Some(AgentSurfaceBackground::Live {
            live_id: live_id.to_string(),
            look: look.to_string(),
        });
    }
    Some(AgentSurfaceBackground::Picture { picture: true })
}

fn destinations_of(
    capture_doc: &Value,
    draft: Option<&MetadataDraft>,
) -> Vec<AgentSurfaceDestination> {
    stream_targets(capture_doc)
        .into_iter()
        .map(|target| {
            let label = destination_label(&target.label);
            let ready = start_ready(&target);
            let override_entry = draft.and_then(|d| {
                d.target_overrides
                    .iter()
                    .find(|entry| entry.platform == target.platform)
            });
            let title = match override_entry {
                Some(entry) if entry.customize => present(Some(&entry.title)),
                _ => draft.and_then(|d| present(Some(&d.title))),
            };
            let category = override_entry.and_then(|entry| {
                present(
                    entry
                        .twitch_category_name
                        .as_deref()
                        .or(entry.kick_category_name.as_deref())
                        .or(entry.x_category_name.as_deref()),
                )
            });
            AgentSurfaceDestination {
                id: target.id,
                platform: target.platform,
                reason: (!ready).then(|| format!("Finish setting up {label} in Destinations.")),
                label,
                on: target.enabled,
                ready,
                title,
                category,
            }
        })
        .collect()
}

/// Builds the allowlisted agent projection from the Studio snapshot, remote
/// lists/window facts, stream metadata draft, global shortcuts, and Cloud AI
/// consent. Pure so leak rules are unit-tested directly.
pub fn build_agent_surface(
    snapshot: &StudioSnapshot,
    extras: &RemoteExtras,
    draft: Option<&MetadataDraft>,
    global_shortcuts: Option<&Value>,
    cloud_ai_consent: bool,
    cohost_status: Option<&str>,
) -> AgentSurface {
    let platform = current_platform();
    let active_id = snapshot.scenes.on_stream_id.as_deref();
    let scenes: Vec<AgentSurfaceSceneEntry> = snapshot
        .scenes
        .scenes
        .iter()
        .enumerate()
        .map(|(index, saved)| {
            let position = index + 1;
            let key =
                scene_shortcut_bindings(&saved.id, position, global_shortcuts, Some(platform))
                    .into_iter()
                    .map(|(_, accel)| accelerator_label(Some(&accel), Some(platform)))
                    .filter(|label| !label.is_empty())
                    .collect::<Vec<_>>()
                    .join(" / ");
            let layout_val = &saved.visual["layout"];
            let sources_val = &saved.visual["sources"];
            let shows = if layout_shows_screen(layout_val) {
                shows_words(&shows_from_sources(sources_val))
            } else {
                "No screen".to_string()
            };
            AgentSurfaceSceneEntry {
                id: saved.id.clone(),
                name: saved.name.clone(),
                position,
                key,
                shows,
                on_stream: active_id == Some(saved.id.as_str()),
            }
        })
        .collect();
    let active = scenes.iter().find(|entry| entry.on_stream);
    let scene = AgentSurfaceActiveScene {
        id: active
            .map(|entry| entry.id.clone())
            .or_else(|| snapshot.scenes.on_stream_id.clone())
            .unwrap_or_default(),
        name: active.map(|entry| entry.name.clone()).unwrap_or_default(),
        kind: "saved",
        modified: snapshot.scenes.saved_scene_modified,
    };

    let sources_sel = &snapshot.settings.capture.sources;
    let mic_name_doc = snapshot
        .settings
        .capture_doc
        .get("sources")
        .and_then(|s| s.get("microphoneName"))
        .and_then(Value::as_str);
    let mic_name = present(
        sources_sel
            .microphone_id
            .as_deref()
            .and_then(|id| {
                snapshot
                    .sources
                    .devices
                    .devices
                    .iter()
                    .find(|d| d.id == id)
                    .map(|d| d.name.as_str())
            })
            .or(mic_name_doc),
    );
    let mic_muted = snapshot
        .system_audio
        .applied_microphone_muted
        .unwrap_or(snapshot.settings.capture.audio.microphone_muted);

    let system_audio_status = snapshot
        .sources
        .devices
        .devices
        .iter()
        .find(|device| device.kind == DeviceKind::SystemAudio)
        .map(|device| device.status.clone());
    let system_audio_available = system_audio_status == Some(DeviceStatus::Available);
    let system_audio_shown = audio_mixer::system_audio_switch_view(&audio_mixer::SwitchInput {
        status: system_audio_status,
        requested: snapshot.settings.capture.audio.system_audio_enabled,
        session_active: snapshot.session.phase.is_active(),
        confirmed: snapshot.system_audio.confirmed,
        joining: snapshot.system_audio.joining,
        issue: snapshot.system_audio.issue,
        audio_bus_active: snapshot.system_audio.audio_bus_active,
    })
    .checked;

    let devices = snapshot
        .sources
        .devices
        .devices
        .iter()
        .filter_map(|device| {
            let kind = device_kind_wire(&device.kind)?;
            Some(AgentSurfaceDevice {
                id: device.id.clone(),
                name: device.name.clone(),
                kind,
                available: device.status == DeviceStatus::Available,
            })
        })
        .collect();

    let chosen = AgentSurfaceChosenSources {
        screen_id: present(sources_sel.screen_id.as_deref()),
        window_id: present(sources_sel.window_id.as_deref()),
        camera_id: present(sources_sel.camera_id.as_deref()),
        microphone_id: present(sources_sel.microphone_id.as_deref()),
    };

    let captions_state = snapshot
        .captions_status
        .as_ref()
        .and_then(|status| status.get("state"))
        .and_then(Value::as_str)
        .unwrap_or("off")
        .to_string();
    let captions_on = snapshot.settings.capture.captions.enabled
        && CAPTIONS_RUNNING.contains(&captions_state.as_str());

    let gates = StartGates::of_snapshot(snapshot);
    let record_blocked_reason = present(record_blocked_reason(snapshot, &gates).as_deref());
    let live_blocked_reason = present(live_stream_blocked_reason(snapshot, &gates).as_deref());

    AgentSurface {
        version: 1,
        record_blocked_reason,
        live_blocked_reason,
        scene,
        scenes,
        microphone: AgentSurfaceMicrophone {
            muted: mic_muted,
            confirmed: None,
            name: mic_name,
        },
        system_audio: AgentSurfaceSystemAudio {
            on: system_audio_available && system_audio_shown,
            available: system_audio_available,
        },
        takeover_id: extras.active_takeover_id.clone(),
        takeovers: extras
            .takeovers
            .iter()
            .map(|entry| AgentSurfaceNamed {
                id: entry.id.clone(),
                name: entry.name.clone(),
            })
            .collect(),
        sounds: extras
            .sounds
            .iter()
            .map(|sound| AgentSurfaceSound {
                id: sound.id.clone(),
                name: sound.name.clone(),
                playing: sound.playing,
            })
            .collect(),
        scene_background: background_of(snapshot),
        captions: AgentSurfaceCaptions {
            on: captions_on,
            state: captions_state,
        },
        buddy: AgentSurfaceBuddy {
            on: extras.buddy_live,
            status: present(cohost_status),
        },
        sources: AgentSurfaceSources { devices, chosen },
        destinations: destinations_of(&snapshot.settings.capture_doc, draft),
        windows: AgentSurfaceWindows {
            notes: extras.windows.notes,
            stream_manager: extras.windows.comments,
            preview: extras.windows.preview,
        },
        cloud_ai_consent,
    }
}

/// Deduplicating, connection-aware surface publisher state (`AgentSurfacePublisher`).
#[derive(Default)]
pub(super) struct AgentSurfaceState {
    pub(super) agents_enabled: bool,
    pub(super) buddy_can_act: bool,
    pub(super) cohost_status: Option<String>,
    generation: u64,
    pending: Option<(String, Value)>,
    published: Option<String>,
}

impl AgentSurfaceState {
    pub(super) fn enabled(&self) -> bool {
        self.agents_enabled || self.buddy_can_act
    }

    pub(super) fn forget_connection(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.published = None;
        self.pending = None;
    }

    /// Updates `agents_enabled` from `agents.status`; returns true when
    /// publishing transitions from off to on (forcing an immediate republish).
    pub(super) fn set_agents_enabled(&mut self, enabled: bool) -> bool {
        if self.agents_enabled == enabled {
            return false;
        }
        let was = self.enabled();
        self.agents_enabled = enabled;
        let now = self.enabled();
        if !was && now {
            self.published = None;
            return true;
        }
        false
    }

    pub(super) fn set_buddy_can_act(&mut self, can_act: bool) -> bool {
        if self.buddy_can_act == can_act {
            return false;
        }
        let was = self.enabled();
        self.buddy_can_act = can_act;
        let now = self.enabled();
        if !was && now {
            self.published = None;
            return true;
        }
        false
    }

    pub(super) fn note(&mut self, surface: &AgentSurface) -> bool {
        if !self.enabled() {
            return false;
        }
        let Ok(value) = serde_json::to_value(surface) else {
            return false;
        };
        let body = value.to_string();
        if self.published.as_deref() == Some(body.as_str()) {
            self.pending = None;
            return false;
        }
        if self.pending.as_ref().map(|(s, _)| s.as_str()) == Some(body.as_str()) {
            return false;
        }
        self.pending = Some((body, value));
        true
    }

    pub(super) fn due(&self) -> Option<(String, Value, u64)> {
        if !self.enabled() {
            return None;
        }
        let (body, value) = self.pending.as_ref()?;
        (self.published.as_deref() != Some(body.as_str()))
            .then(|| (body.clone(), value.clone(), self.generation))
    }

    pub(super) fn mark_published(&mut self, generation: u64, body: String) {
        if self.generation == generation {
            self.published = Some(body);
        }
    }

    pub(super) fn generation(&self) -> u64 {
        self.generation
    }
}

impl<B: StudioBackend> Studio<B> {
    /// The surface the Studio would publish right now (for tests and diagnostics).
    pub fn agent_surface(&self) -> AgentSurface {
        let snapshot = self.snapshot();
        let extras = self.remote_lock().extras.clone();
        let draft = self.details_now().draft;
        let shortcuts = snapshot.settings.studio.global_shortcuts();
        let consent = self.read_ui_settings(families::ai_consent);
        let cohost_status = self.agent_lock().surface.cohost_status.clone();
        build_agent_surface(
            &snapshot,
            &extras,
            draft.as_ref(),
            Some(&shortcuts),
            consent,
            cohost_status.as_deref(),
        )
    }

    /// Recomputes the surface and kicks the publisher when enabled and changed.
    pub(super) fn note_agent_surface(&self, snapshot: &StudioSnapshot) {
        if !snapshot.bootstrapped || !matches!(snapshot.connection, Connection::Connected { .. }) {
            return;
        }
        let buddy_can_act = live_cohost_gate(snapshot.entitlements.as_ref()).allowed();
        let extras = self.remote_lock().extras.clone();
        let draft = self.details_now().draft;
        let shortcuts = snapshot.settings.studio.global_shortcuts();
        let consent = self.read_ui_settings(families::ai_consent);
        let news = {
            let mut agent = self.agent_lock();
            agent.surface.set_buddy_can_act(buddy_can_act);
            if !agent.surface.enabled() {
                false
            } else {
                let surface = build_agent_surface(
                    snapshot,
                    &extras,
                    draft.as_ref(),
                    Some(&shortcuts),
                    consent,
                    agent.surface.cohost_status.as_deref(),
                );
                agent.surface.note(&surface)
            }
        };
        if news {
            self.agent_publish_kick.notify_one();
        }
    }

    /// Updates `agents_enabled` from `agents.status` and publishes immediately
    /// when Agents transitions from off to on.
    pub(super) fn apply_agents_status(&self, payload: &Value) {
        let Some(enabled) = payload.get("enabled").and_then(Value::as_bool) else {
            return;
        };
        let turned_on = self.agent_lock().surface.set_agents_enabled(enabled);
        if turned_on {
            let snapshot = self.snapshot();
            self.note_agent_surface(&snapshot);
        }
    }

    /// Debounced background publisher loop driven by [`Studio::drive`].
    pub(super) async fn publish_agent_surface_when_kicked(self: &Arc<Self>) {
        loop {
            self.agent_publish_kick.notified().await;
            tokio::time::sleep(AGENT_PUBLISH_DEBOUNCE).await;
            self.flush_agent_surface().await;
        }
    }

    /// Flushes the newest pending agent surface with `[1s, 2s, 4s]` retry.
    #[doc(hidden)]
    pub async fn flush_agent_surface(&self) {
        let mut attempt = 0;
        loop {
            let Some((body, value, generation)) = self.agent_lock().surface.due() else {
                return;
            };
            match self
                .backend
                .agent_surface_publish(serde_json::json!({ "surface": value }))
                .await
            {
                Ok(()) => {
                    attempt = 0;
                    self.agent_lock().surface.mark_published(generation, body);
                }
                Err(error) => {
                    let Some(delay) = AGENT_PUBLISH_RETRY_DELAYS.get(attempt) else {
                        self.config.logger.warn(format!(
                            "Studio: agent.surface.publish failed after retries: {} ({})",
                            error.message, error.code
                        ));
                        return;
                    };
                    attempt += 1;
                    tokio::time::sleep(*delay).await;
                    if self.agent_lock().surface.generation() != generation {
                        return;
                    }
                }
            }
        }
    }
}
