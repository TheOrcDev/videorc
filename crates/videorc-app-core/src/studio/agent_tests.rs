use std::collections::BTreeSet;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::mpsc;
use videorc_protocol::overlay_layout::OverlayRect;
use videorc_protocol::ui_settings::{
    UiSettingsChange, UiSettingsGetParams, UiSettingsSetParams, UiSettingsSnapshot,
};
use videorc_protocol::{
    AudioProcessingUpdateParams, AudioProcessingUpdateResult, BackendConnection, BackendHealth,
    Device, DeviceKind, DeviceList, DeviceStatus, PreviewScreenStartParams, PreviewScreenStatus,
    RecordingStatus, Scene, SessionStopParams, StartSessionParams, ToolStatus,
};

use super::*;
use crate::client::methods::AgentIntentAckParams;
use crate::client::{BackendEvent, RpcError};
use crate::livestream::details::{MetadataDraft, Privacy};
use crate::livestream::golive::{DestinationPreflight, Preflight};
use crate::livestream::targets::Target;
use crate::studio::agent_go_live::{
    HeadlessDecision, HeadlessGoLiveInput, decide_headless_go_live, headless_exclusions,
};
use crate::studio::agent_scene::{SceneRect, overlay_placement, preset_corner_rect};
use crate::studio::agent_settings::CURATED_SETTINGS;
use crate::studio::agent_surface::build_agent_surface;
use crate::studio::remote::{RemoteExtras, RemoteWindows};
use crate::studio::settings::keys;
use crate::studio::test_support;
use crate::studio::{Studio, StudioBackend, StudioConfig};

#[derive(Default)]
struct Recorded {
    listened: usize,
    acks: Vec<AgentIntentAckParams>,
    surfaces: Vec<Value>,
    scene_calls: Vec<(String, Value)>,
    agents_enabled: bool,
    settings: serde_json::Map<String, Value>,
    revision: u64,
}

struct AgentFakeBackend {
    state: Mutex<Recorded>,
}

impl AgentFakeBackend {
    fn new(agents_enabled: bool) -> Arc<Self> {
        let mut state = Recorded {
            agents_enabled,
            ..Recorded::default()
        };
        state.settings.insert(
            keys::CAPTURE_CONFIG.into(),
            Value::String(
                json!({
                    "sources": { "microphoneId": "mic-1", "microphoneName": "Studio Mic" },
                    "audio": { "microphoneMuted": false, "microphoneGainDb": 0, "systemAudioEnabled": false },
                    "video": { "width": 1920, "height": 1080, "fps": 30, "bitrateKbps": 10000 },
                    "layout": { "layoutPreset": "screen-camera" },
                    "recordEnabled": true,
                    "captions": { "enabled": false, "language": "auto" },
                    "replayBuffer": { "enabled": false },
                    "streaming": {
                        "targets": [
                            {
                                "id": "t1",
                                "platform": "twitch",
                                "label": "Twitch",
                                "enabled": true,
                                "authMode": "manual-rtmp",
                                "serverUrl": "rtmp://secret.example/live",
                                "streamKey": "live_super_secret_key_12345",
                                "streamKeyPresent": true
                            }
                        ],
                        "enabledTargetIds": ["t1"]
                    }
                })
                .to_string(),
            ),
        );
        Arc::new(Self {
            state: Mutex::new(state),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Recorded> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl StudioBackend for AgentFakeBackend {
    async fn health(&self) -> Result<BackendHealth, RpcError> {
        Ok(BackendHealth {
            status: "ok".into(),
            version: "test".into(),
            platform: "darwin".into(),
            ffmpeg: ToolStatus {
                path: "/ffmpeg".into(),
                available: true,
                version: None,
                message: None,
            },
            database_path: "/db".into(),
            secret_store_backend: "keychain".into(),
        })
    }

    async fn devices(&self) -> Result<DeviceList, RpcError> {
        Ok(DeviceList {
            devices: vec![
                Device {
                    id: "mic-1".into(),
                    name: "Studio Mic".into(),
                    kind: DeviceKind::Microphone,
                    status: DeviceStatus::Available,
                    width: None,
                    height: None,
                    app: None,
                    window_title: None,
                    detail: None,
                    display_uuid: None,
                },
                Device {
                    id: "sys-1".into(),
                    name: "System audio".into(),
                    kind: DeviceKind::SystemAudio,
                    status: DeviceStatus::Available,
                    width: None,
                    height: None,
                    app: None,
                    window_title: None,
                    detail: None,
                    display_uuid: None,
                },
            ],
            warnings: vec![],
        })
    }

    async fn recording_status(&self) -> Result<RecordingStatus, RpcError> {
        Ok(serde_json::from_value(json!({ "state": "idle" })).expect("idle status"))
    }

    async fn scene(&self) -> Result<Scene, RpcError> {
        Ok(Scene {
            id: "scene-1".into(),
            name: "Scene 1".into(),
            sources: vec![],
            outputs: vec![],
            background: None,
        })
    }

    async fn settings_get(
        &self,
        _params: UiSettingsGetParams,
    ) -> Result<UiSettingsSnapshot, RpcError> {
        let state = self.lock();
        Ok(UiSettingsSnapshot {
            revision: state.revision,
            entries: state
                .settings
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            local_storage_migrated: true,
        })
    }

    async fn settings_set(
        &self,
        params: UiSettingsSetParams,
    ) -> Result<UiSettingsChange, RpcError> {
        let mut state = self.lock();
        state.revision += 1;
        let mut put = std::collections::BTreeMap::new();
        for (k, v) in params.put {
            state.settings.insert(k.clone(), v.clone());
            put.insert(k, v);
        }
        let mut delete = Vec::new();
        for k in params.delete {
            state.settings.remove(&k);
            delete.push(k);
        }
        Ok(UiSettingsChange {
            revision: state.revision,
            put,
            delete,
            writer: params.writer,
        })
    }

    async fn session_start(
        &self,
        _params: StartSessionParams,
    ) -> Result<RecordingStatus, RpcError> {
        self.recording_status().await
    }

    async fn session_stop(&self, _params: SessionStopParams) -> Result<RecordingStatus, RpcError> {
        self.recording_status().await
    }

    async fn audio_processing_update(
        &self,
        _params: AudioProcessingUpdateParams,
    ) -> Result<AudioProcessingUpdateResult, RpcError> {
        Err(RpcError::not_connected("audio.processing.update"))
    }

    async fn remote_intent_ack(
        &self,
        _params: crate::client::methods::RemoteIntentAckParams,
    ) -> Result<(), RpcError> {
        Ok(())
    }

    async fn remote_surface_publish(&self, _snapshot: Value) -> Result<(), RpcError> {
        Ok(())
    }

    async fn preview_screen_start(
        &self,
        _params: PreviewScreenStartParams,
    ) -> Result<PreviewScreenStatus, RpcError> {
        Err(RpcError::not_connected("preview.screen.start"))
    }

    async fn agent_intent_listen(&self) -> Result<(), RpcError> {
        self.lock().listened += 1;
        Ok(())
    }

    async fn agent_intent_ack(&self, params: AgentIntentAckParams) -> Result<(), RpcError> {
        self.lock().acks.push(params);
        Ok(())
    }

    async fn agent_surface_publish(&self, payload: Value) -> Result<(), RpcError> {
        self.lock().surfaces.push(payload);
        Ok(())
    }

    async fn agents_status(&self) -> Result<Value, RpcError> {
        let enabled = self.lock().agents_enabled;
        Ok(json!({ "enabled": enabled }))
    }

    async fn screens_list(&self) -> Result<Vec<videorc_protocol::StreamScreen>, RpcError> {
        Ok(vec![videorc_protocol::StreamScreen {
            id: "brb".into(),
            name: "BRB".into(),
            image_path: "/screens/brb.png".into(),
            thumbnail_path: None,
            sort_order: 0,
            status: videorc_protocol::StreamScreenStatus::Ready,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }])
    }

    async fn screens_activate(
        &self,
        _screen_id: &str,
    ) -> Result<videorc_protocol::StreamScreen, RpcError> {
        Ok(self.screens_list().await?.remove(0))
    }

    async fn screens_clear(&self) -> Result<(), RpcError> {
        Ok(())
    }

    async fn scene_request(&self, method: &'static str, params: Value) -> Result<Value, RpcError> {
        self.lock().scene_calls.push((method.to_string(), params));
        if method == "overlays.layout.get" {
            return Ok(json!({
                "highlight": { "horizontal": { "x": 0.04, "y": 0.7, "w": 0.6, "h": 0.26 }, "vertical": { "x": 0.11, "y": 0.58, "w": 0.78, "h": 0.2 }, "showOnStream": true, "showInRecording": true },
                "captions": { "horizontal": { "x": 0.04, "y": 0.8, "w": 0.92, "h": 0.16 }, "vertical": { "x": 0.12, "y": 0.64, "w": 0.76, "h": 0.14 }, "showOnStream": false, "showInRecording": false },
                "buddy": { "horizontal": { "x": 0.78, "y": 0.64, "w": 0.18, "h": 0.32 }, "vertical": { "x": 0.34, "y": 0.6, "w": 0.32, "h": 0.18 }, "showOnStream": true, "showInRecording": true },
                "chat": { "horizontal": { "x": 0.66, "y": 0.04, "w": 0.3, "h": 0.44 }, "vertical": { "x": 0.1, "y": 0.08, "w": 0.8, "h": 0.3 }, "showOnStream": false, "showInRecording": false }
            }));
        }
        if method == "banners.list" {
            return Ok(json!([]));
        }
        if method == "screen.hide" {
            return Ok(json!({ "hidden": true, "reason": "you" }));
        }
        Err(RpcError::not_connected(method))
    }
}

fn intent(id: &str, agent_id: &str, tool: &str, args: Value) -> AgentIntentEnvelope {
    AgentIntentEnvelope {
        intent_id: id.into(),
        agent_id: agent_id.into(),
        agent_name: "Smoke Agent".into(),
        tool: tool.into(),
        args,
        deadline_at: None,
        generation: Some(1),
    }
}

#[test]
fn catalog_parity_matches_protocol_fixtures_agent_tools_json() {
    let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../protocol-fixtures/agent-tools.json");
    let raw = std::fs::read_to_string(&fixture_path)
        .expect("protocol-fixtures/agent-tools.json should be readable");
    let doc: Value = serde_json::from_str(&raw).expect("valid JSON");
    let tools = doc["tools"].as_array().expect("tools array");

    let expected_studio: BTreeSet<&str> = tools
        .iter()
        .filter(|t| t["runsIn"].as_str() == Some("studio"))
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    let actual_studio: BTreeSet<&str> = STUDIO_AGENT_TOOLS.iter().copied().collect();
    assert_eq!(actual_studio, expected_studio);

    let expected_buddy: BTreeSet<&str> = tools
        .iter()
        .filter(|t| t["runsIn"].as_str() == Some("studio") && t["buddy"].as_bool() == Some(true))
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    let actual_buddy: BTreeSet<&str> = BUDDY_ALLOWED_STUDIO_TOOLS.iter().copied().collect();
    assert_eq!(actual_buddy, expected_buddy);

    let update_settings_tool = tools
        .iter()
        .find(|t| t["name"].as_str() == Some("update_settings"))
        .expect("update_settings tool");
    let expected_curated: BTreeSet<&str> = update_settings_tool["inputSchema"]["properties"]
        .as_object()
        .expect("properties")
        .keys()
        .map(String::as_str)
        .collect();
    let actual_curated: BTreeSet<&str> = CURATED_SETTINGS.iter().copied().collect();
    assert_eq!(actual_curated, expected_curated);
}

#[test]
fn cancel_and_deadline_rules_match_electron() {
    let agent_call = intent("i1", "agent-1", "notify", json!({ "message": "hi" }));
    let buddy_call = intent("i2", BUDDY_AGENT_ID, "set_audio", json!({}));

    let stop_all = AgentIntentCancel {
        generation: 2,
        agent_id: None,
    };
    assert!(agent_cancel_reaches(&agent_call, &stop_all));
    // Stop agents / Off never cancels Sidekick (Buddy).
    assert!(!agent_cancel_reaches(&buddy_call, &stop_all));

    // Newer generation is never cancelled by an older or equal cancel.
    let same_gen = AgentIntentCancel {
        generation: 1,
        agent_id: None,
    };
    assert!(!agent_cancel_reaches(&agent_call, &same_gen));

    // Targeted cancel reaches only that agent.
    let remove_other = AgentIntentCancel {
        generation: 2,
        agent_id: Some("agent-2".into()),
    };
    assert!(!agent_cancel_reaches(&agent_call, &remove_other));
    let remove_same = AgentIntentCancel {
        generation: 2,
        agent_id: Some("agent-1".into()),
    };
    assert!(agent_cancel_reaches(&agent_call, &remove_same));

    assert_eq!(
        agent_intent_drop_reason(&agent_call, true, 100),
        Some(copy::CANCELLED)
    );
    let mut late = agent_call.clone();
    late.deadline_at = Some(500);
    assert_eq!(agent_intent_drop_reason(&late, false, 499), None);
    assert_eq!(
        agent_intent_drop_reason(&late, false, 500),
        Some(copy::LATE)
    );
}

#[test]
fn agent_surface_allowlists_and_never_leaks_secrets_or_background_key() {
    let mut snapshot = test_support::fresh_snapshot();
    snapshot.settings.capture_doc["streaming"] = json!({
        "targets": [{
            "id": "t1",
            "platform": "twitch",
            "label": "Twitch",
            "enabled": true,
            "authMode": "manual-rtmp",
            "serverUrl": "rtmp://live.twitch.tv/app",
            "streamKey": "live_secret_token_xyz",
            "streamKeyPresent": true
        }],
        "enabledTargetIds": ["t1"]
    });
    snapshot.scenes.working_background = Some(json!({
        "live": { "id": "silk", "look": "satin" }
    }));

    let extras = RemoteExtras {
        windows: RemoteWindows {
            notes: true,
            comments: true,
            preview: false,
        },
        ..RemoteExtras::default()
    };
    let surface = build_agent_surface(&snapshot, &extras, None, None, true, None);
    let serialized = serde_json::to_value(&surface).expect("serializes");
    let raw = serialized.to_string();

    assert!(!raw.contains("live_secret_token_xyz"));
    assert!(!raw.contains("rtmp://live.twitch.tv"));
    assert!(serialized.get("background").is_none());
    assert_eq!(
        serialized["sceneBackground"],
        json!({ "liveId": "silk", "look": "satin" })
    );
    assert_eq!(serialized["windows"]["streamManager"], json!(true));
    assert_eq!(serialized["windows"]["notes"], json!(true));
    assert_eq!(serialized["windows"]["preview"], json!(false));
    assert_eq!(serialized["cloudAiConsent"], json!(true));
    assert_eq!(serialized["version"], json!(1));
}

#[test]
fn headless_go_live_decisions_match_electron() {
    let targets = vec![
        Target {
            id: "yt".into(),
            platform: "youtube".into(),
            label: "YouTube".into(),
            enabled: true,
            auth_mode: "oauth".into(),
            ..Target::default()
        },
        Target {
            id: "tw".into(),
            platform: "twitch".into(),
            label: "Twitch".into(),
            enabled: false,
            auth_mode: "manual-rtmp".into(),
            ..Target::default()
        },
    ];
    assert_eq!(headless_exclusions(&targets, None), Ok(vec![]));
    assert!(
        headless_exclusions(&targets, Some(&["tw".into()]))
            .unwrap_err()
            .contains("is off")
    );
    assert!(
        headless_exclusions(&targets, Some(&["kick".into()]))
            .unwrap_err()
            .contains("No destination that is on matches")
    );

    let preflight = Preflight {
        valid: true,
        destinations: vec![DestinationPreflight {
            target_id: "yt".into(),
            platform: "youtube".into(),
            label: "YouTube".into(),
            auth_mode: "oauth".into(),
            ready: true,
            ..DestinationPreflight::default()
        }],
        issues: vec![],
    };
    let draft = MetadataDraft {
        title: "Test stream".into(),
        description: String::new(),
        default_privacy: Privacy::Unlisted,
        target_overrides: vec![],
        thumbnail_asset_id: None,
        updated_at: String::new(),
    };
    // Non-public YouTube refuses unless allowNonPublic is true.
    let refused = decide_headless_go_live(HeadlessGoLiveInput {
        preflight: &preflight,
        draft: Some(&draft),
        sent_targets: &targets,
        captions_blocks_start: false,
        captions_description: "",
        entitlement_reason: None,
        allow_partial: false,
        allow_non_public: false,
    });
    assert!(matches!(refused, HeadlessDecision::Refuse(_)));

    let confirmed = decide_headless_go_live(HeadlessGoLiveInput {
        preflight: &preflight,
        draft: Some(&draft),
        sent_targets: &targets,
        captions_blocks_start: false,
        captions_description: "",
        entitlement_reason: None,
        allow_partial: false,
        allow_non_public: true,
    });
    assert_eq!(confirmed, HeadlessDecision::Confirm);
}

#[test]
fn scene_placement_and_preset_corner_math_work() {
    let rect = overlay_placement(
        "highlight",
        false,
        &OverlayRect::new(0.04, 0.7, 0.6, 0.26),
        Some("top-right"),
        None,
    );
    assert!(rect.x > 0.3 && rect.y < 0.1);

    let flipped = preset_corner_rect(
        &json!({ "cameraCorner": "bottom-right", "cameraTransformMode": "preset" }),
        SceneRect {
            x: 0.72,
            y: 0.68,
            width: 0.24,
            height: 0.28,
        },
        "top-left",
    )
    .expect("preset corner");
    assert!((flipped.x - 0.04).abs() < 1e-6);
    assert!((flipped.y - 0.04).abs() < 1e-6);
}

#[tokio::test]
async fn studio_connects_listens_publishes_and_acks_agent_intents() {
    let backend = AgentFakeBackend::new(true);
    let studio = Arc::new(Studio::new(backend.clone(), StudioConfig::default()));

    // Simulate backend.ready bootstrap + agent connect.
    studio
        .handle_event(BackendEvent::Ready(BackendConnection {
            host: "127.0.0.1".into(),
            port: 12345,
            token: "tok".into(),
            pid: 42,
            parent_pid: None,
        }))
        .await;
    studio.connect_agent_link().await;
    studio.flush_agent_surface().await;

    assert_eq!(backend.lock().listened, 1);
    assert_eq!(backend.lock().surfaces.len(), 1);
    assert!(
        backend.lock().surfaces[0]["surface"]
            .get("background")
            .is_none()
    );

    // 1. notify succeeds.
    studio
        .run_agent_intent(intent(
            "id-notify",
            "agent-1",
            "notify",
            json!({ "message": "Hello from agent" }),
        ))
        .await;

    // 2. Owner rule: set_buddy with chatMode: "auto" is strictly refused.
    studio
        .run_agent_intent(intent(
            "id-buddy-auto",
            "agent-1",
            "set_buddy",
            json!({ "chatMode": "auto" }),
        ))
        .await;

    // 3. D15 Buddy allowlist: Buddy cannot call update_settings.
    studio
        .run_agent_intent(intent(
            "id-buddy-blocked",
            BUDDY_AGENT_ID,
            "update_settings",
            json!({ "theme": "dark" }),
        ))
        .await;

    // 4. update_settings refuses non-curated setting and accepts theme.
    studio
        .run_agent_intent(intent(
            "id-not-curated",
            "agent-1",
            "update_settings",
            json!({ "streamKey": "nope" }),
        ))
        .await;
    studio
        .run_agent_intent(intent(
            "id-theme",
            "agent-1",
            "update_settings",
            json!({ "theme": "light" }),
        ))
        .await;

    // 5. set_scene_item refuses captions switches.
    studio
        .run_agent_intent(intent(
            "id-captions-switch",
            "agent-1",
            "set_scene_item",
            json!({ "item": "captions", "showOnStream": false }),
        ))
        .await;

    // 6. delete_recording routes to the app listener.
    let (tx, mut rx) = mpsc::unbounded_channel();
    studio.set_agent_app_listener(Some(tx));
    let responder = tokio::spawn(async move {
        if let Some(req) = rx.recv().await {
            assert_eq!(
                req.action,
                AppAgentAction::DeleteRecording {
                    recording_id: "rec-99".into()
                }
            );
            req.answer(Ok(AppAgentAnswer::Deleted {
                title: Some("My Take".into()),
            }));
        }
    });
    studio
        .run_agent_intent(intent(
            "id-delete",
            "agent-1",
            "delete_recording",
            json!({ "recordingId": "rec-99" }),
        ))
        .await;
    responder.await.unwrap();

    let acks = backend.lock().acks.clone();
    assert_eq!(acks.len(), 7);

    assert!(acks[0].ok);
    assert_eq!(acks[0].result, Some(json!({ "shown": true })));

    assert!(!acks[1].ok);
    assert_eq!(
        acks[1].message.as_deref(),
        Some("Auto is gone: Sidekick never posts in chat on its own. Use talk: bubble.")
    );

    assert!(!acks[2].ok);
    assert_eq!(acks[2].message.as_deref(), Some(copy::NOT_BUDDYS));

    assert!(!acks[3].ok);
    assert!(
        acks[3]
            .message
            .as_deref()
            .unwrap()
            .contains("\"streamKey\" isn't a setting agents can change")
    );

    assert!(acks[4].ok);
    assert_eq!(
        acks[4].result,
        Some(json!({ "changed": { "theme": "light" } }))
    );
    assert_eq!(studio.snapshot().settings.theme.as_deref(), Some("light"));

    assert!(!acks[5].ok);
    assert!(
        acks[5]
            .message
            .as_deref()
            .unwrap()
            .contains("Use set_captions")
    );

    assert!(acks[6].ok);
    assert_eq!(
        acks[6].result,
        Some(json!({ "recordingId": "rec-99", "trashed": true }))
    );

    // 7. Queued intent cancelled before running is dropped with copy::CANCELLED.
    let cancelled = Arc::new(AtomicBool::new(true));
    let outcome = studio
        .dispatch_agent_intent(
            &intent(
                "id-cancelled",
                "agent-1",
                "notify",
                json!({ "message": "x" }),
            ),
            &cancelled,
        )
        .await;
    assert!(!outcome.ok);
    assert_eq!(outcome.message.as_deref(), Some(copy::CANCELLED));
}

#[tokio::test]
async fn set_takeover_hide_releases_mute_before_subsequent_set_audio() {
    let backend = AgentFakeBackend::new(true);
    let studio = Arc::new(Studio::new(backend.clone(), StudioConfig::default()));
    studio
        .handle_event(BackendEvent::Ready(BackendConnection {
            host: "127.0.0.1".into(),
            port: 12345,
            token: "tok".into(),
            pid: 42,
            parent_pid: None,
        }))
        .await;
    assert!(!studio.snapshot().settings.capture.audio.microphone_muted);

    // Show takeover: immediately claims ownership and mutes the microphone.
    studio
        .run_agent_intent(intent(
            "tk-show",
            "agent-1",
            "set_takeover",
            json!({ "takeoverId": "brb" }),
        ))
        .await;
    assert!(studio.snapshot().settings.capture.audio.microphone_muted);

    // Hide takeover: immediately restores mic and clears ownership before acking.
    studio
        .run_agent_intent(intent(
            "tk-hide",
            "agent-1",
            "set_takeover",
            json!({ "takeoverId": null }),
        ))
        .await;
    assert!(!studio.snapshot().settings.capture.audio.microphone_muted);

    // Immediate manual mute right after hiding the takeover.
    studio
        .run_agent_intent(intent(
            "mic-mute",
            "agent-1",
            "set_audio",
            json!({ "microphone": { "muted": true } }),
        ))
        .await;
    assert!(studio.snapshot().settings.capture.audio.microphone_muted);

    // A delayed `screens.active.changed (null)` event must NOT undo the manual mute.
    studio.commit_takeover(false).await;
    assert!(studio.snapshot().settings.capture.audio.microphone_muted);
    assert!(studio.agent_surface().microphone.muted);

    // hide_screen must send `screen.hide` (never `screen.show`).
    studio
        .run_agent_intent(intent("hide-1", "agent-1", "hide_screen", json!({})))
        .await;
    let last_ack = backend.lock().acks.last().cloned().unwrap();
    assert!(last_ack.ok);
    assert_eq!(last_ack.result, Some(json!({ "hidden": true })));
    assert!(
        backend
            .lock()
            .scene_calls
            .iter()
            .any(|(m, p)| m == "screen.hide" && p == &json!({ "reason": "you" }))
    );
}
