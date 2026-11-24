//! The backend's wire types live in `videorc-protocol` (plan 260 S1.1); this
//! module re-exports them so every `crate::protocol::X` path stays as it was.
//! The tests below stay here and run against the moved types unchanged.

pub use videorc_protocol::*;

#[cfg(test)]
#[allow(unused_imports)]
use crate::overlay_layout::OverlayRect;
#[cfg(test)]
#[allow(unused_imports)]
use crate::repair::GateStatus;
#[cfg(test)]
#[allow(unused_imports)]
use crate::source_registry::SourceRegistrySnapshot;
#[cfg(test)]
#[allow(unused_imports)]
use crate::streaming::StreamingSettings;
#[cfg(test)]
#[allow(unused_imports)]
use serde_json::Value;
#[cfg(test)]
#[allow(unused_imports)]
use std::collections::BTreeMap;

#[cfg(test)]
mod tests {
    /// Plan 189: the soundboard wire shapes match the pinned fixtures exactly,
    /// in both directions, and absent optionals are omitted, never null.
    #[test]
    fn soundboard_wire_shapes_match_the_pinned_fixtures() {
        use super::{SoundMode, SoundPressResult, SoundboardState, SoundsPlayback};
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/high-risk-contracts.json"
        ))
        .unwrap();
        let fixture = &fixtures["sound"];
        for name in ["minimal", "starter"] {
            let sound: super::Sound = serde_json::from_value(fixture[name].clone()).unwrap();
            assert_eq!(
                serde_json::to_value(&sound).unwrap(),
                fixture[name],
                "{name}"
            );
        }
        let minimal: super::Sound = serde_json::from_value(fixture["minimal"].clone()).unwrap();
        assert_eq!(minimal.mode, SoundMode::Toggle);
        assert_eq!(minimal.hotkey, None);
        let mut board = fixture["state"].clone();
        board["sounds"] = serde_json::json!([fixture["starter"], fixture["minimal"]]);
        let state: SoundboardState = serde_json::from_value(board.clone()).unwrap();
        assert_eq!(serde_json::to_value(&state).unwrap(), board);
        let playback: SoundsPlayback = serde_json::from_value(fixture["playback"].clone()).unwrap();
        assert_eq!(
            serde_json::to_value(&playback).unwrap(),
            fixture["playback"]
        );
        assert!(playback.voices[1].r#loop);
        assert!(!playback.session_without_sounds);
        let without: SoundsPlayback =
            serde_json::from_value(fixture["playbackWithoutSounds"].clone()).unwrap();
        assert!(without.session_without_sounds);
        assert_eq!(
            serde_json::to_value(&without).unwrap(),
            fixture["playbackWithoutSounds"]
        );
        let stopped: SoundPressResult =
            serde_json::from_value(fixture["pressStopped"].clone()).unwrap();
        assert_eq!(stopped.voice_id, None);
        assert_eq!(
            serde_json::to_value(&stopped).unwrap(),
            fixture["pressStopped"]
        );
        assert_eq!(
            serde_json::to_value(SoundMode::OneShot).unwrap(),
            serde_json::json!("oneShot")
        );
    }

    #[test]
    fn audio_level_readings_floor_silence_and_omit_missing_sources() {
        use super::{
            AUDIO_LEVEL_CEILING_DB, AUDIO_LEVEL_FLOOR_DB, AudioLevelReading, AudioLevelsEvent,
        };
        // Digital silence never reaches the wire as -Infinity.
        assert_eq!(
            AudioLevelReading::from_window(0.0, 0.0),
            AudioLevelReading {
                peak_db: AUDIO_LEVEL_FLOOR_DB,
                rms_db: AUDIO_LEVEL_FLOOR_DB
            }
        );
        // A hot input past full scale is capped, and a NaN window reads as silence.
        assert_eq!(
            AudioLevelReading::from_window(1000.0, 1.0e6).peak_db,
            AUDIO_LEVEL_CEILING_DB
        );
        assert_eq!(
            AudioLevelReading::from_window(0.5, f64::NAN).rms_db,
            AUDIO_LEVEL_FLOOR_DB
        );
        // A full-scale sine: peak 0 dBFS, RMS 3.01 dB below.
        let sine = AudioLevelReading::from_window(1.0, 0.5);
        assert!(sine.peak_db.abs() < 1.0e-6, "{sine:?}");
        assert!((sine.rms_db + 3.0103).abs() < 1.0e-3, "{sine:?}");
        // Sources without samples are omitted, never null (the serde-null trap).
        let event = AudioLevelsEvent {
            session_id: Some("session-1".into()),
            microphone: Some(sine),
            system_audio: None,
            sounds: None,
            master: None,
            master_clipped_samples: 0,
            microphone_silent: false,
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({
                "sessionId": "session-1",
                "microphone": { "peakDb": sine.peak_db, "rmsDb": sine.rms_db },
                "masterClippedSamples": 0
            })
        );
        // Issue 1064: the watchdog's report rides the event only while true.
        let silent = AudioLevelsEvent {
            microphone_silent: true,
            ..event.clone()
        };
        assert_eq!(
            serde_json::to_value(&silent).unwrap()["microphoneSilent"],
            serde_json::json!(true)
        );
        let decoded: AudioLevelsEvent =
            serde_json::from_value(serde_json::to_value(&event).unwrap()).unwrap();
        assert!(!decoded.microphone_silent);
        // The standby microphone has no session: the key is omitted, not null.
        let standby = AudioLevelsEvent {
            session_id: None,
            ..event
        };
        assert_eq!(
            serde_json::to_value(&standby).unwrap(),
            serde_json::json!({
                "microphone": { "peakDb": sine.peak_db, "rmsDb": sine.rms_db },
                "masterClippedSamples": 0
            })
        );
    }

    #[test]
    fn scene_editor_draft_params_round_trip_with_renderer_handle_ids() {
        let wire = serde_json::json!({
            "sourceId": "source:camera",
            "transform": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
            "chrome": {
                "selected": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
                "handles": true,
                "activeHandle": "se",
                "guides": [{ "axis": "x", "position": 0.5 }],
                "scale": 1.5
            }
        });
        let params: super::SceneEditorDraftParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(params.chrome.active_handle, Some(super::EditorHandleId::Se));
        assert_eq!(params.chrome.guides[0].axis, super::EditorGuideAxis::X);
        assert_eq!(serde_json::to_value(&params).unwrap(), wire);

        // The renderer omits activeHandle and guides when nothing is active.
        let minimal: super::SceneEditorDraftParams = serde_json::from_value(serde_json::json!({
            "sourceId": "source:camera",
            "transform": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
            "chrome": {
                "selected": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
                "handles": false,
                "scale": 1
            }
        }))
        .unwrap();
        assert_eq!(minimal.chrome.active_handle, None);
        assert!(minimal.chrome.guides.is_empty());
        let serialized = serde_json::to_value(&minimal).unwrap();
        assert!(serialized["chrome"].get("activeHandle").is_none());
        for bad_handle in ["north", "", "NE"] {
            let mut wire = wire.clone();
            wire["chrome"]["activeHandle"] = serde_json::json!(bad_handle);
            assert!(serde_json::from_value::<super::SceneEditorDraftParams>(wire).is_err());
        }
    }

    #[test]
    fn scene_editor_draft_without_a_transform_is_chrome_only_on_the_wire() {
        // The idle selection: chrome, no rect. Absent, not null, both ways.
        let wire = serde_json::json!({
            "sourceId": "source:camera",
            "chrome": {
                "selected": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
                "handles": true,
                "scale": 2
            }
        });
        let params: super::SceneEditorDraftParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(params.transform, None);
        assert!(params.chrome.handles);
        let serialized = serde_json::to_value(&params).unwrap();
        assert!(serialized.get("transform").is_none());
        assert_eq!(serialized["sourceId"], "source:camera");

        let status = super::SceneEditorDraftStatus {
            source_id: "source:camera".into(),
            transform: None,
            release_at_revision: None,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({ "sourceId": "source:camera" })
        );
        let parsed: super::SceneEditorDraftStatus =
            serde_json::from_value(serde_json::json!({ "sourceId": "source:camera" })).unwrap();
        assert_eq!(parsed, status);

        // A partial rect is still a malformed draft, never a chrome-only one.
        let mut partial = wire.clone();
        partial["transform"] = serde_json::json!({ "x": 0.1, "y": 0.2 });
        assert!(serde_json::from_value::<super::SceneEditorDraftParams>(partial).is_err());
    }

    #[test]
    fn scene_editor_draft_status_never_serializes_null_release_revision() {
        let status = super::SceneEditorDraftStatus {
            source_id: "source:camera".into(),
            transform: Some(super::CameraTransform {
                x: 0.0,
                y: 0.0,
                width: 0.5,
                height: 0.5,
            }),
            release_at_revision: None,
        };
        let wire = serde_json::to_value(&status).unwrap();
        assert!(wire.get("releaseAtRevision").is_none());
        assert!(wire.get("transform").is_some());
        let ack = super::SceneEditorDraftAck {
            active: false,
            editor_draft: None,
        };
        assert_eq!(
            serde_json::to_value(&ack).unwrap(),
            serde_json::json!({ "active": false })
        );
    }

    #[test]
    fn scene_transform_snap_defaults_to_legacy_for_older_requests() {
        for snap in [None, Some("legacy"), Some("none")] {
            let mut wire = serde_json::json!({
                "sourceId": "source:camera",
                "transform": { "x": 0.012 }
            });
            if let Some(value) = snap {
                wire["snap"] = serde_json::json!(value);
            }
            let params: super::SceneTransformUpdateParams = serde_json::from_value(wire).unwrap();
            assert_eq!(
                params.snap,
                if snap == Some("none") {
                    super::SceneTransformSnap::None
                } else {
                    super::SceneTransformSnap::Legacy
                }
            );
            let serialized = serde_json::to_value(params).unwrap();
            assert_eq!(serialized["snap"], snap.unwrap_or("legacy"));
        }
    }

    #[test]
    fn scene_transform_snap_rejects_invalid_policy() {
        for snap in [
            serde_json::json!("auto"),
            serde_json::json!(false),
            serde_json::Value::Null,
        ] {
            let wire = serde_json::json!({
                "sourceId": "source:camera",
                "transform": { "x": 0.012 },
                "snap": snap
            });
            assert!(serde_json::from_value::<super::SceneTransformUpdateParams>(wire).is_err());
        }
    }

    #[test]
    fn capture_recovery_status_omits_unavailable_and_non_finite_fields() {
        let status = super::CaptureRecoveryStatus {
            revision: 7,
            phase: super::CaptureRecoveryPhase::Idle,
            retryable: false,
            attempts: 0,
            stage: None,
            source: None,
            trigger: None,
            source_generation: None,
            detected_at: None,
            updated_at: None,
            message: None,
            last_error: None,
            last_duration_ms: Some(f64::NAN),
        };
        let wire = serde_json::to_value(status).expect("recovery status serializes");
        assert_eq!(wire["revision"], 7);
        assert_eq!(wire["phase"], "idle");
        assert_eq!(wire["retryable"], false);
        assert_eq!(wire["attempts"], 0);
        for field in [
            "stage",
            "source",
            "trigger",
            "sourceGeneration",
            "detectedAt",
            "updatedAt",
            "message",
            "lastError",
            "lastDurationMs",
        ] {
            assert!(
                wire.get(field).is_none(),
                "unavailable recovery field {field} must be omitted"
            );
        }

        let missing_revision = serde_json::json!({
            "phase": "idle",
            "retryable": false,
            "attempts": 0
        });
        assert!(
            serde_json::from_value::<super::CaptureRecoveryStatus>(missing_revision).is_err(),
            "strict recovery consumers need an explicit ordering revision"
        );
    }

    #[test]
    fn screen_capture_recovery_scope_has_stable_wire_labels() {
        let status = super::CaptureRecoveryStatus {
            revision: 8,
            phase: super::CaptureRecoveryPhase::Verifying,
            retryable: false,
            attempts: 1,
            stage: Some(super::CaptureRecoveryStage::ScreenDelivery),
            source: Some(super::CaptureRecoverySource::Screen),
            trigger: Some(super::CaptureRecoveryTrigger::Automatic),
            source_generation: Some(12),
            detected_at: None,
            updated_at: None,
            message: Some("Verifying replacement screen generation.".to_string()),
            last_error: None,
            last_duration_ms: None,
        };
        let wire = serde_json::to_value(status).expect("screen recovery status serializes");
        assert_eq!(wire["stage"], "screen-delivery");
        assert_eq!(wire["source"], "screen");
        assert_eq!(wire["sourceGeneration"], 12);
    }

    #[test]
    fn mf_input_credit_wait_p95_is_absent_when_none() {
        // 0.9.68 regression: serde emitted `"encoderBridgeMfInputCreditWaitP95Ms": null`
        // and the renderer contract (optional finite number) rejected every
        // diagnostics.stats payload on macOS, blocking session start.
        let stats = crate::diagnostics::idle_diagnostics();
        let json = serde_json::to_value(&stats).expect("stats serialize");
        assert!(
            json.get("encoderBridgeMfInputCreditWaitP95Ms").is_none(),
            "None must serialize as an absent key, not null"
        );
    }

    use super::*;

    #[test]
    fn effective_scene_background_visibility_defaults_when_absent() {
        // Scenes persisted before the visibility slider existed carry no
        // visibilityPercent; they must keep the classic 80%-stage look.
        let json = r#"{"assetId":"a","managedAssetPath":"/tmp/x.webp","fit":"fill","scale":100.0,"offsetX":0.0,"offsetY":0.0,"blurPx":0.0,"dimPercent":0.0,"saturationPercent":100.0,"vignettePercent":0.0}"#;
        let background: EffectiveSceneBackground = serde_json::from_str(json).unwrap();
        assert!(
            (background.visibility_percent - DEFAULT_BACKGROUND_VISIBILITY_PERCENT).abs() < 1e-9
        );
    }

    #[test]
    fn scene_round_trips_background_and_omits_it_when_absent() {
        // No background: the field is omitted on the wire and a legacy scene
        // (saved before this field existed) still deserializes.
        let plain = Scene {
            id: "scene:test".to_string(),
            name: "Test".to_string(),
            sources: Vec::new(),
            outputs: Vec::new(),
            background: None,
        };
        let plain_json = serde_json::to_string(&plain).unwrap();
        assert!(!plain_json.contains("background"));
        let legacy: Scene =
            serde_json::from_str(r#"{"id":"s","name":"n","sources":[],"outputs":[]}"#).unwrap();
        assert_eq!(legacy.background, None);

        // With a background, every field survives a camelCase round trip.
        let scene = Scene {
            background: Some(EffectiveSceneBackground {
                asset_id: "asset-1".to_string(),
                managed_asset_path: "/managed/asset-1.png".to_string(),
                fit: BackgroundFit::Fit,
                scale: 120.0,
                offset_x: -10.0,
                offset_y: 5.0,
                blur_px: 8.0,
                dim_percent: 20.0,
                saturation_percent: 110.0,
                vignette_percent: 30.0,
                visibility_percent: 20.0,
                live: None,
            }),
            ..plain
        };
        let json = serde_json::to_string(&scene).unwrap();
        assert!(json.contains("\"managedAssetPath\":\"/managed/asset-1.png\""));
        assert!(json.contains("\"fit\":\"fit\""));
        let restored: Scene = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, scene);
    }

    /// Plan 194: every live background id (the plan 190 five and the five
    /// more) is its catalogue's kebab-case wire id and survives a scene
    /// background round trip; an unknown id is refused, so the apply fails
    /// on the existing error path.
    #[test]
    fn live_background_ids_round_trip_on_the_wire() {
        use crate::live_background::{ALL_LIVE_BACKGROUNDS, css_id, looks};
        let expected = [
            "silk",
            "side-rays",
            "plasma-wave",
            "liquid-chrome",
            "line-waves",
            "beams",
            "color-bends",
            "dither",
            "ferrofluid",
            "ghost-fibers",
        ];
        assert_eq!(ALL_LIVE_BACKGROUNDS.len(), expected.len());
        for (id, wire) in ALL_LIVE_BACKGROUNDS.into_iter().zip(expected) {
            assert_eq!(serde_json::to_value(id).unwrap(), serde_json::json!(wire));
            assert_eq!(css_id(id), wire);
            let look = looks(id)[0].id;
            let background = EffectiveSceneBackground {
                asset_id: format!("live-{wire}-{look}"),
                managed_asset_path: format!("/bundled/live-{wire}-{look}.webp"),
                fit: BackgroundFit::Fill,
                scale: 100.0,
                offset_x: 0.0,
                offset_y: 0.0,
                blur_px: 0.0,
                dim_percent: 10.0,
                saturation_percent: 100.0,
                vignette_percent: 0.0,
                visibility_percent: 20.0,
                live: Some(LiveBackgroundSpec {
                    id,
                    look: look.to_string(),
                    motion: LiveBackgroundMotion::Normal,
                }),
            };
            let json = serde_json::to_string(&background).unwrap();
            assert!(
                json.contains(&format!("\"live\":{{\"id\":\"{wire}\",\"look\":\"{look}\"")),
                "{json}"
            );
            let restored: EffectiveSceneBackground = serde_json::from_str(&json).unwrap();
            assert_eq!(restored, background);
        }
        let unknown = r#"{"id":"lava-lamp","look":"default","motion":"calm"}"#;
        assert!(serde_json::from_str::<LiveBackgroundSpec>(unknown).is_err());
        // Motion defaults to Calm when a saved spec omits it.
        let calm: LiveBackgroundSpec =
            serde_json::from_str(r#"{"id":"ghost-fibers","look":"violet"}"#).unwrap();
        assert_eq!(calm.id, LiveBackgroundId::GhostFibers);
        assert_eq!(calm.motion, LiveBackgroundMotion::Calm);
    }

    #[test]
    fn scene_config_round_trips_background_and_defaults_absent_background() {
        let plain = SceneConfigParams {
            transition_ms: None,
            sources: SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: true,
            },
            layout: default_layout_settings(),
            video: None,
            background: None,
            protected_overlay_window_ids: Vec::new(),
        };
        let plain_json = serde_json::to_string(&plain).unwrap();
        assert!(!plain_json.contains("background"));
        let legacy: SceneConfigParams = serde_json::from_str(&plain_json).unwrap();
        assert_eq!(legacy.background, None);

        let params = SceneConfigParams {
            transition_ms: None,
            sources: SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: true,
            },
            layout: default_layout_settings(),
            video: None,
            background: Some(EffectiveSceneBackground {
                asset_id: "asset-1".to_string(),
                managed_asset_path: "/managed/asset-1.png".to_string(),
                fit: BackgroundFit::Fill,
                scale: 100.0,
                offset_x: 0.0,
                offset_y: 0.0,
                blur_px: 0.0,
                dim_percent: 0.0,
                saturation_percent: 100.0,
                vignette_percent: 0.0,
                visibility_percent: 20.0,
                live: None,
            }),
            protected_overlay_window_ids: Vec::new(),
        };

        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("\"background\""));
        assert!(json.contains("\"managedAssetPath\":\"/managed/asset-1.png\""));
        let restored: SceneConfigParams = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, params);
    }

    #[test]
    fn layout_preset_serializes_to_kebab_case() {
        assert_eq!(
            serde_json::to_value(LayoutPreset::ScreenCamera).unwrap(),
            serde_json::json!("screen-camera")
        );
        assert_eq!(
            serde_json::to_value(LayoutPreset::SideBySide).unwrap(),
            serde_json::json!("side-by-side")
        );
        assert_eq!(
            serde_json::to_value(LayoutPreset::VerticalCameraTop).unwrap(),
            serde_json::json!("vertical-camera-top")
        );
        assert_eq!(
            serde_json::to_value(LayoutPreset::VerticalCameraBottom).unwrap(),
            serde_json::json!("vertical-camera-bottom")
        );
        assert_eq!(
            serde_json::to_value(LayoutPreset::VerticalSplit).unwrap(),
            serde_json::json!("vertical-split")
        );
        assert_eq!(
            serde_json::to_value(LayoutPreset::VerticalScreenCamera).unwrap(),
            serde_json::json!("vertical-screen-camera")
        );
        assert_eq!(
            serde_json::to_value(LayoutPreset::VerticalScreenOnly).unwrap(),
            serde_json::json!("vertical-screen-only")
        );
        // Explicit wire pin: smokes ride preset custom, so this test is the
        // only CI coverage that the TS list and the Rust enum agree (the
        // 0.9.32 lesson — a preset name missing on one side broke the wire).
        assert_eq!(
            serde_json::to_value(LayoutPreset::VerticalCameraOnly).unwrap(),
            serde_json::json!("vertical-camera-only")
        );
        assert_eq!(
            serde_json::from_value::<LayoutPreset>(serde_json::json!("vertical-camera-only"))
                .unwrap(),
            LayoutPreset::VerticalCameraOnly
        );
    }

    #[test]
    fn layout_preset_orientation_classes_are_exhaustive() {
        // The class gates live scene switches (the canvas is fixed while a
        // session runs) — a misclassified preset silently breaks that gate.
        assert!(!LayoutPreset::ScreenCamera.is_vertical());
        assert!(!LayoutPreset::ScreenOnly.is_vertical());
        assert!(!LayoutPreset::CameraOnly.is_vertical());
        assert!(!LayoutPreset::SideBySide.is_vertical());
        assert!(LayoutPreset::VerticalCameraTop.is_vertical());
        assert!(LayoutPreset::VerticalCameraBottom.is_vertical());
        assert!(LayoutPreset::VerticalSplit.is_vertical());
        assert!(LayoutPreset::VerticalScreenCamera.is_vertical());
        assert!(LayoutPreset::VerticalScreenOnly.is_vertical());
        assert!(LayoutPreset::VerticalCameraOnly.is_vertical());
    }

    #[test]
    fn layout_preset_accepts_the_dev_era_vertical_alias() {
        // "vertical" was the preset's wire name before the orientation-mode
        // split; it never shipped, but dev configs and session rows carry it.
        assert_eq!(
            serde_json::from_value::<LayoutPreset>(serde_json::json!("vertical")).unwrap(),
            LayoutPreset::VerticalCameraTop
        );
    }

    #[test]
    fn h264_backends_match_the_desktop_wire_contract() {
        assert_eq!(
            serde_json::to_value(EncodeBackend::HardwareVaapi).unwrap(),
            serde_json::json!("hardware-vaapi")
        );
        assert_eq!(
            serde_json::to_value(EncodeBackend::HardwareMediaFoundation).unwrap(),
            serde_json::json!("hardware-media-foundation")
        );
        assert_eq!(
            serde_json::to_value(EncodeBackend::SoftwareMediaFoundation).unwrap(),
            serde_json::json!("software-media-foundation")
        );
        assert_eq!(
            serde_json::to_value(EncodeBackend::SoftwareOpenH264).unwrap(),
            serde_json::json!("software-open-h264")
        );
        assert_eq!(
            serde_json::to_value(EncodeBackend::HardwareQsv).unwrap(),
            serde_json::json!("hardware-qsv")
        );
    }

    #[test]
    fn layout_settings_defaults_missing_preset_to_screen_camera() {
        // Settings persisted before layoutPreset existed must migrate to screen-camera.
        let legacy = serde_json::json!({
            "cameraCorner": "bottom-right",
            "cameraSize": "medium",
            "cameraShape": "rectangle",
            "cameraMargin": 32,
            "cameraFit": "fill",
            "cameraMirror": false,
            "cameraZoom": 100,
            "cameraOffsetX": 0,
            "cameraOffsetY": 0
        });
        let layout: LayoutSettings = serde_json::from_value(legacy).unwrap();
        assert_eq!(layout.layout_preset, LayoutPreset::ScreenCamera);
        assert!(
            layout.camera_chroma_key_edges.is_none(),
            "no edges before plan 227"
        );
    }

    /// Plan 227 B: Hide edges ride the layout as `cameraChromaKeyEdges`, stay
    /// off the wire while every side is 0 (layouts saved before them are
    /// unchanged), fill a missing side with 0 and refuse an unknown one.
    #[test]
    fn layout_settings_carry_hide_edges_and_omit_them_when_none() {
        let layout = default_layout_settings();
        let wire = serde_json::to_value(&layout).unwrap();
        assert!(wire.get("cameraChromaKeyEdges").is_none(), "{wire}");

        let mut edged = wire.clone();
        edged["cameraChromaKeyEdges"] =
            serde_json::json!({ "leftPct": 2, "topPct": 0, "rightPct": 0, "bottomPct": 5 });
        let parsed: LayoutSettings = serde_json::from_value(edged).unwrap();
        assert_eq!(
            parsed.camera_chroma_key_edges,
            CameraKeyEdges {
                left_pct: 2,
                top_pct: 0,
                right_pct: 0,
                bottom_pct: 5,
            }
        );
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            back["cameraChromaKeyEdges"],
            serde_json::json!({ "leftPct": 2, "topPct": 0, "rightPct": 0, "bottomPct": 5 })
        );

        let mut partial = wire.clone();
        partial["cameraChromaKeyEdges"] = serde_json::json!({ "rightPct": 3 });
        let parsed: LayoutSettings = serde_json::from_value(partial).unwrap();
        assert_eq!(parsed.camera_chroma_key_edges.right_pct, 3);
        assert_eq!(parsed.camera_chroma_key_edges.left_pct, 0);

        let mut unknown = wire;
        unknown["cameraChromaKeyEdges"] = serde_json::json!({ "centerPct": 1 });
        assert!(serde_json::from_value::<LayoutSettings>(unknown).is_err());
    }

    #[test]
    fn layout_settings_round_trips_explicit_preset() {
        let layout = LayoutSettings {
            layout_preset: LayoutPreset::SideBySide,
            camera_transform_mode: CameraTransformMode::Custom,
            camera_transform: Some(CameraTransform {
                x: 0.5,
                y: 0.25,
                width: 0.3,
                height: 0.2,
            }),
            camera_corner: CameraCorner::BottomRight,
            camera_size: CameraSize::Medium,
            camera_shape: CameraShape::Rectangle,
            camera_corner_radius_pct: 12,
            camera_aspect: crate::protocol::CameraAspect::Source,
            camera_margin: 32,
            camera_fit: CameraFit::Fill,
            camera_mirror: false,
            camera_zoom: 100,
            camera_offset_x: 0,
            camera_offset_y: 0,
            side_by_side_split: SideBySideSplit::SixtyForty,
            side_by_side_camera_side: SideBySideCameraSide::Left,
            vertical_screen_framing: crate::protocol::VerticalScreenFraming::Fill,
            horizontal_screen_framing: crate::protocol::HorizontalScreenFraming::Fit,
            arrangement_mode: crate::protocol::ArrangementMode::Preset,
            source_transform_overrides: std::collections::BTreeMap::new(),
            source_visibility: Default::default(),
            camera_look: Default::default(),
            camera_background: None,
            camera_chroma_key_enabled: false,
            camera_chroma_key_color: "#00FF00".to_string(),
            camera_chroma_key_similarity_pct: 40,
            camera_chroma_key_smoothness_pct: 8,
            camera_chroma_key_spill_pct: 10,
            camera_chroma_key_edges: Default::default(),
        };
        let json = serde_json::to_string(&layout).unwrap();
        assert!(json.contains("\"layoutPreset\":\"side-by-side\""));
        assert!(json.contains("\"cameraTransformMode\":\"custom\""));
        let restored: LayoutSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, layout);
    }

    #[test]
    fn camera_transform_mode_serializes_to_kebab_case() {
        assert_eq!(
            serde_json::to_value(CameraTransformMode::Preset).unwrap(),
            serde_json::json!("preset")
        );
        assert_eq!(
            serde_json::to_value(CameraTransformMode::Custom).unwrap(),
            serde_json::json!("custom")
        );
    }

    #[test]
    fn video_presets_serialize_to_product_profile_labels() {
        assert_eq!(
            serde_json::to_value(VideoPreset::Record4k30).unwrap(),
            serde_json::json!("record-4k30")
        );
        assert_eq!(
            serde_json::to_value(VideoPreset::Record4k60Experimental).unwrap(),
            serde_json::json!("record-4k60-experimental")
        );
        assert_eq!(
            serde_json::to_value(VideoPreset::StreamSafe1080p30).unwrap(),
            serde_json::json!("stream-safe-1080p30")
        );
        assert_eq!(
            serde_json::to_value(VideoPreset::StreamSafe1080p60).unwrap(),
            serde_json::json!("stream-safe-1080p60")
        );
        assert_eq!(
            serde_json::to_value(VideoPreset::StreamYoutube1080p30).unwrap(),
            serde_json::json!("stream-youtube-1080p30")
        );
        assert_eq!(
            serde_json::to_value(VideoPreset::StreamYoutube1080p60).unwrap(),
            serde_json::json!("stream-youtube-1080p60")
        );
        assert_eq!(
            serde_json::to_value(VideoPreset::StreamYoutube4k30).unwrap(),
            serde_json::json!("stream-youtube-4k30")
        );
        // The 0.9.31 wire bug: the renderer's 'vertical-1080x1920' had no Rust
        // variant, so entering vertical mode failed to deserialize. Pin BOTH
        // directions so a renderer-only preset can never ship again.
        assert_eq!(
            serde_json::to_value(VideoPreset::Vertical1080x1920).unwrap(),
            serde_json::json!("vertical-1080x1920")
        );
        assert_eq!(
            serde_json::from_value::<VideoPreset>(serde_json::json!("vertical-1080x1920")).unwrap(),
            VideoPreset::Vertical1080x1920
        );
    }

    #[test]
    fn layout_settings_default_transform_mode_is_preset() {
        // Settings persisted before camera drag existed migrate to preset / no transform.
        let legacy = serde_json::json!({
            "cameraCorner": "bottom-right",
            "cameraSize": "medium",
            "cameraShape": "rectangle",
            "cameraMargin": 32,
            "cameraFit": "fill",
            "cameraMirror": false,
            "cameraZoom": 100,
            "cameraOffsetX": 0,
            "cameraOffsetY": 0
        });
        let layout: LayoutSettings = serde_json::from_value(legacy).unwrap();
        assert_eq!(layout.camera_transform_mode, CameraTransformMode::Preset);
        assert!(layout.camera_transform.is_none());
    }

    #[test]
    fn side_by_side_enums_serialize_to_expected_labels() {
        assert_eq!(
            serde_json::to_value(SideBySideSplit::Even).unwrap(),
            serde_json::json!("50-50")
        );
        assert_eq!(
            serde_json::to_value(SideBySideSplit::SixtyForty).unwrap(),
            serde_json::json!("60-40")
        );
        assert_eq!(
            serde_json::to_value(SideBySideSplit::SeventyThirty).unwrap(),
            serde_json::json!("70-30")
        );
        assert_eq!(
            serde_json::to_value(SideBySideCameraSide::Left).unwrap(),
            serde_json::json!("left")
        );
        assert_eq!(
            serde_json::to_value(SideBySideCameraSide::Right).unwrap(),
            serde_json::json!("right")
        );
    }

    #[test]
    fn legacy_caption_session_settings_migrate_privacy_safe_defaults() {
        let settings: CaptionsSessionParams = serde_json::from_value(serde_json::json!({
            "burnTarget": "stream",
            "position": "bottom",
            "textSize": "m"
        }))
        .unwrap();
        assert!(!settings.enabled);
        assert!(!settings.suppressed_for_session);
        assert_eq!(settings.style_id, crate::captions::CaptionStyleId::Glass);
        assert_eq!(settings.language, "auto");
        assert_eq!(settings.style_revision, 0);
    }

    #[test]
    fn caption_session_style_fields_use_stable_wire_names() {
        let settings = CaptionsSessionParams {
            enabled: true,
            suppressed_for_session: true,
            style_id: crate::captions::CaptionStyleId::HighContrast,
            language: "es".to_string(),
            style_revision: 12,
            ..Default::default()
        };
        let value = serde_json::to_value(settings).unwrap();
        assert_eq!(value["enabled"], true);
        assert_eq!(value["suppressedForSession"], true);
        assert_eq!(value["styleId"], "high-contrast");
        assert_eq!(value["language"], "es");
        assert_eq!(value["styleRevision"], 12);
    }

    fn shared_high_risk_contract_fixture_value(pointer: &str) -> serde_json::Value {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/high-risk-contracts.json"
        ))
        .expect("shared high-risk protocol fixture must be valid JSON");
        fixture
            .pointer(pointer)
            .unwrap_or_else(|| panic!("shared protocol fixture is missing {pointer}"))
            .clone()
    }

    // Plan 185 T4: the `plan` and `cloud` blocks ride the capabilities answer
    // as optional blocks. The shared fixture is the authoritative Max example;
    // the TypeScript side validates the same JSON.
    #[test]
    fn shared_high_risk_contract_fixture_parses_the_plan_and_cloud_blocks() {
        let wire = shared_high_risk_contract_fixture_value("/accountPlans/capabilitiesMax");
        let capabilities: AiCapabilities = serde_json::from_value(wire).unwrap();
        assert_eq!(
            capabilities.entitlement.tier, "premium",
            "Max stays tier premium (D2)"
        );
        let plan = capabilities.plan.expect("plan block");
        assert_eq!(plan.id, "max");
        assert_eq!(plan.name, "Max");
        assert_eq!(EntitlementPlan::parse(&plan.id), Some(EntitlementPlan::Max));
        let cloud = capabilities.cloud.expect("cloud block");
        assert!(cloud.enabled && cloud.talk_shows);
        assert_eq!(cloud.seconds_per_month, 360_000);
        assert_eq!(cloud.seconds_used, 133_200);
        assert_eq!(cloud.seconds_remaining(), 226_800);
        assert_eq!(cloud.reset_at.as_deref(), Some("2026-11-01T00:00:00Z"));
        assert_eq!(cloud.guests_on_stage, Some(5));
        assert_eq!(cloud.room_size, Some(10));
        assert_eq!(cloud.recording_retention_days, Some(30));

        // The Premium block (and `GET /api/cloud/allowance`) is the same shape
        // with the talk-show limits absent.
        let premium: AiCapabilitiesCloud = serde_json::from_value(
            shared_high_risk_contract_fixture_value("/accountPlans/cloudPremium"),
        )
        .unwrap();
        assert!(premium.enabled && !premium.talk_shows);
        assert_eq!(premium.seconds_remaining(), 34_800);
        assert_eq!(premium.guests_on_stage, None);
        // Absent options never serialize as `null` (the serde-null trap).
        let value = serde_json::to_value(&premium).unwrap();
        assert!(value.get("guestsOnStage").is_none());
        assert!(value.get("roomSize").is_none());
        assert!(value.get("recordingRetentionDays").is_none());

        // Unknown plan ids read as "no plan" instead of failing the load.
        assert_eq!(EntitlementPlan::parse("enterprise"), None);
        let mut future = shared_high_risk_contract_fixture_value("/accountPlans/capabilitiesMax");
        future["plan"]["id"] = serde_json::Value::String("enterprise".to_string());
        future["cloud"]["newField"] = serde_json::Value::Bool(true);
        let parsed: AiCapabilities = serde_json::from_value(future).unwrap();
        assert_eq!(
            parsed.plan.as_ref().map(|plan| plan.id.as_str()),
            Some("enterprise")
        );
        assert!(parsed.cloud.is_some());
    }

    #[test]
    fn shared_high_risk_contract_fixture_keeps_the_entitlement_plan_optional() {
        let max = shared_high_risk_contract_fixture_value("/accountPlans/entitlementsMax");
        let snapshot: EntitlementsSnapshot = serde_json::from_value(max.clone()).unwrap();
        assert_eq!(snapshot.tier, EntitlementTier::Premium);
        assert_eq!(snapshot.plan, Some(EntitlementPlan::Max));
        assert_eq!(serde_json::to_value(&snapshot).unwrap(), max);

        let basic = shared_high_risk_contract_fixture_value("/accountPlans/entitlementsBasic");
        let snapshot: EntitlementsSnapshot = serde_json::from_value(basic.clone()).unwrap();
        assert_eq!(snapshot.plan, None);
        let value = serde_json::to_value(&snapshot).unwrap();
        assert!(
            value.get("plan").is_none(),
            "no plan must mean no key, never null"
        );
        assert_eq!(value, basic);
    }

    #[test]
    fn shared_microphone_noise_suppression_contract_and_defaults() {
        let fixture = shared_high_risk_contract_fixture_value("/microphoneNoiseSuppression");
        let settings: AudioSettings =
            serde_json::from_value(fixture["audioSettings"].clone()).unwrap();
        assert_eq!(
            settings.microphone_noise_suppression,
            MicrophoneNoiseSuppression::Rnnoise
        );
        let legacy: AudioSettings =
            serde_json::from_value(fixture["legacyAudioSettings"].clone()).unwrap();
        assert_eq!(
            legacy.microphone_noise_suppression,
            MicrophoneNoiseSuppression::Off
        );
        let update: AudioProcessingUpdateParams =
            serde_json::from_value(fixture["update"].clone()).unwrap();
        assert_eq!(
            update.microphone_noise_suppression,
            Some(MicrophoneNoiseSuppression::Rnnoise)
        );
        let legacy: AudioProcessingUpdateParams =
            serde_json::from_value(fixture["legacyUpdate"].clone()).unwrap();
        assert_eq!(legacy.microphone_noise_suppression, None);
        assert!(
            serde_json::from_value::<AudioSettings>(
                serde_json::json!({"microphoneNoiseSuppression":"unknown"})
            )
            .is_err()
        );
        for key in ["applied", "unavailable"] {
            let result: AudioProcessingUpdateResult =
                serde_json::from_value(fixture[key].clone()).unwrap();
            let wire = serde_json::to_value(&result).unwrap();
            assert_eq!(
                wire["microphoneNoiseSuppression"],
                fixture[key]["microphoneNoiseSuppression"]
            );
            assert_eq!(
                wire["confirmedMicrophoneNoiseSuppression"],
                fixture[key]["confirmedMicrophoneNoiseSuppression"]
            );
            assert_eq!(
                serde_json::from_value::<AudioProcessingUpdateResult>(wire).unwrap(),
                result
            );
        }
    }

    #[test]
    fn shared_high_risk_contract_fixture_preserves_preview_bounds_and_stacking() {
        let wire = shared_high_risk_contract_fixture_value("/previewSurfaceBounds/wire");
        let expected = shared_high_risk_contract_fixture_value("/previewSurfaceBounds/normalized");
        let bounds: PreviewSurfaceBounds = serde_json::from_value(wire).unwrap();
        assert_eq!(bounds.order_above_window_id, Some(4242));
        assert_eq!(bounds.elevated, Some(false));
        assert_eq!(serde_json::to_value(bounds).unwrap(), expected);

        let legacy_wire =
            shared_high_risk_contract_fixture_value("/previewSurfaceBounds/legacyWire");
        let legacy_expected =
            shared_high_risk_contract_fixture_value("/previewSurfaceBounds/legacyNormalized");
        let legacy: PreviewSurfaceBounds = serde_json::from_value(legacy_wire).unwrap();
        assert_eq!(serde_json::to_value(legacy).unwrap(), legacy_expected);
    }

    #[test]
    fn windows_d3d11_main_owned_preview_bounds_preserve_opaque_hwnd_and_generation() {
        let wire = serde_json::json!({
            "bounds": {
                "screenX": 12.0,
                "screenY": 34.0,
                "width": 1280.0,
                "height": 720.0,
                "scaleFactor": 1.25,
                "visible": true,
                "orderAboveWindowId": 42,
                "orderAboveWindowHandle": "0x000000001234abcd",
                "elevated": false,
                "physicalPlacement": {
                    "screenX": 15.0,
                    "screenY": 42.5,
                    "width": 1600.0,
                    "height": 900.0,
                    "clipX": 15.0,
                    "clipY": 60.0,
                    "clipWidth": 1600.0,
                    "clipHeight": 700.0
                }
            },
            "generation": 9
        });
        let request: MainOwnedPreviewSurfaceBoundsParams =
            serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(request.generation, 9);
        assert_eq!(
            request
                .bounds
                .order_above_window_handle
                .as_ref()
                .map(OpaqueNativeWindowHandle::as_u64),
            Some(0x1234_abcd)
        );
        assert_eq!(request.bounds.bounds.order_above_window_id, Some(42));
        assert_eq!(request.bounds.bounds.elevated, Some(false));
        // #1272: the presenter's physical placement survives beside the DIPs.
        let physical = request
            .bounds
            .physical_placement
            .expect("physical placement");
        assert_eq!((physical.width, physical.height), (1600.0, 900.0));
        assert_eq!(physical.clip_height, Some(700.0));
        assert_eq!(request.bounds.bounds.width, 1280.0);
        assert_eq!(serde_json::to_value(request).unwrap(), wire);
    }

    #[test]
    fn windows_d3d11_opaque_hwnd_rejects_unsafe_wire_values() {
        for value in [
            serde_json::json!("0x0000000000000000"),
            serde_json::json!("0x1234"),
            serde_json::json!("0X0000000000000001"),
            serde_json::json!("0x00000000000000AF"),
            serde_json::json!(1234),
        ] {
            assert!(
                serde_json::from_value::<OpaqueNativeWindowHandle>(value).is_err(),
                "unsafe HWND wire value was accepted"
            );
        }
    }

    #[test]
    fn windows_d3d11_renderer_preview_bounds_never_serialize_an_hwnd() {
        let ordinary: PreviewSurfaceBounds = serde_json::from_value(serde_json::json!({
            "screenX": 0.0,
            "screenY": 0.0,
            "width": 640.0,
            "height": 360.0,
            "scaleFactor": 1.0,
            "orderAboveWindowHandle": "0x000000001234abcd"
        }))
        .unwrap();
        let serialized = serde_json::to_value(ordinary).unwrap();
        assert!(serialized.get("orderAboveWindowHandle").is_none());
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_layout_and_scene_defaults() {
        let look_wire = shared_high_risk_contract_fixture_value("/cameraLook");
        let look: CameraLook = serde_json::from_value(look_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(look).unwrap(), look_wire);
        let mut graded = default_layout_settings();
        graded.camera_look = look;
        let wire = serde_json::to_value(&graded).unwrap();
        assert_eq!(wire["cameraLook"], look_wire);
        assert_eq!(
            serde_json::from_value::<LayoutSettings>(wire).unwrap(),
            graded
        );
        assert!(
            serde_json::to_value(default_layout_settings())
                .unwrap()
                .get("cameraLook")
                .is_none()
        );
        let legacy_layout = shared_high_risk_contract_fixture_value("/layout/legacyWire");
        assert!(legacy_layout.get("sourceVisibility").is_none());
        let expected_layout = shared_high_risk_contract_fixture_value("/layout/normalized");
        let layout: LayoutSettings = serde_json::from_value(legacy_layout).unwrap();
        assert_eq!(serde_json::to_value(layout).unwrap(), expected_layout);

        // Plan 213 G2: a freeform screen's crop rides its box both ways, and
        // the camera's uncropped box keeps its four fields.
        let cropped = shared_high_risk_contract_fixture_value("/layout/freeformCrop");
        let layout: LayoutSettings = serde_json::from_value(cropped.clone()).unwrap();
        assert_eq!(
            layout.source_transform_overrides["source:base"].crop_left,
            0.25
        );
        assert_eq!(serde_json::to_value(layout).unwrap(), cropped);

        let scene_wire = shared_high_risk_contract_fixture_value("/scene/wire");
        let scene: Scene = serde_json::from_value(scene_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(scene).unwrap(), scene_wire);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_recording_status_defaults() {
        let wire = shared_high_risk_contract_fixture_value("/recordingStatus/wire");
        let status: RecordingStatus = serde_json::from_value(wire.clone()).unwrap();
        // Plan 215 D1: a running session says whether a source moved now
        // reaches its picture.
        assert_eq!(status.accepts_live_scene_edits, Some(true));
        assert_eq!(serde_json::to_value(status).unwrap(), wire);

        // A session on the legacy FFmpeg graph composes a fixed picture.
        let fixed = shared_high_risk_contract_fixture_value("/recordingStatus/fixedSceneWire");
        let status: RecordingStatus = serde_json::from_value(fixed.clone()).unwrap();
        assert_eq!(status.accepts_live_scene_edits, Some(false));
        assert_eq!(serde_json::to_value(status).unwrap(), fixed);

        let minimal = shared_high_risk_contract_fixture_value("/recordingStatus/minimalWire");
        let expected =
            shared_high_risk_contract_fixture_value("/recordingStatus/minimalNormalized");
        let status: RecordingStatus = serde_json::from_value(minimal).unwrap();
        // Nothing running: no flag at all, on the wire or off it.
        assert_eq!(status.accepts_live_scene_edits, None);
        assert_eq!(serde_json::to_value(status).unwrap(), expected);

        // Plan 069: the one mixed track reports its sources; an unmixed track
        // (the `wire` fixture above) keeps omitting `mixSources`.
        let mixed = shared_high_risk_contract_fixture_value("/recordingStatus/mixedAudioWire");
        let status: RecordingStatus = serde_json::from_value(mixed.clone()).unwrap();
        assert_eq!(
            status.audio_tracks[0].mix_sources,
            vec![AudioTrackSource::Microphone, AudioTrackSource::SystemAudio]
        );
        assert_eq!(serde_json::to_value(status).unwrap(), mixed);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_replay_buffer_shapes() {
        // Plan 181: the ring request, the buffer-only status mark, the state
        // event in every state, and the save envelopes.
        let params = shared_high_risk_contract_fixture_value("/replay/params");
        let replay: ReplayParams = serde_json::from_value(params.clone()).unwrap();
        assert_eq!(replay.seconds, 30);
        assert_eq!(serde_json::to_value(replay).unwrap(), params);

        let status_wire = shared_high_risk_contract_fixture_value("/replay/replayOnlyStatus");
        let status: RecordingStatus = serde_json::from_value(status_wire.clone()).unwrap();
        assert!(status.replay_only);
        assert_eq!(serde_json::to_value(&status).unwrap(), status_wire);
        // Every other session omits the mark on the wire.
        let plain = shared_high_risk_contract_fixture_value("/recordingStatus/wire");
        let plain_status: RecordingStatus = serde_json::from_value(plain).unwrap();
        assert!(!plain_status.replay_only);
        assert!(
            serde_json::to_value(&plain_status)
                .unwrap()
                .get("replayOnly")
                .is_none()
        );

        // The request: `auto` rides the wire only when true (redesign R2).
        let params_wire = shared_high_risk_contract_fixture_value("/replay/params");
        let params: ReplayParams = serde_json::from_value(params_wire.clone()).unwrap();
        assert!(!params.auto);
        assert_eq!(serde_json::to_value(params).unwrap(), params_wire);
        let auto_wire = shared_high_risk_contract_fixture_value("/replay/paramsAuto");
        let auto: ReplayParams = serde_json::from_value(auto_wire.clone()).unwrap();
        assert!(auto.auto);
        assert_eq!(serde_json::to_value(auto).unwrap(), auto_wire);

        for pointer in ["/replay/stateOn", "/replay/stateOff", "/replay/stateError"] {
            let wire = shared_high_risk_contract_fixture_value(pointer);
            let event: ReplayStateEvent = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(event).unwrap(), wire, "{pointer}");
        }
        for pointer in ["/replay/saveAccepted", "/replay/saveAcceptedMinimal"] {
            let wire = shared_high_risk_contract_fixture_value(pointer);
            let accepted: ReplaySaveAccepted = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(accepted).unwrap(), wire, "{pointer}");
        }
        // Plan 199: the accepted save names its length, always.
        let accepted: ReplaySaveAccepted = serde_json::from_value(
            shared_high_risk_contract_fixture_value("/replay/saveAcceptedMinimal"),
        )
        .unwrap();
        assert_eq!(accepted.seconds, 30);
        assert!(
            serde_json::from_value::<ReplaySaveAccepted>(serde_json::json!({
                "saveId": "save-fixture",
                "sessionId": "replay-session-fixture"
            }))
            .is_err(),
            "seconds is required on the accepted save"
        );
        // Plan 199: `replay.save` and `clip.mark` take an optional length;
        // no length never rides the wire as null.
        for (pointer, seconds) in [
            ("/replay/saveParams", None),
            ("/replay/saveParamsLong", Some(60)),
        ] {
            let wire = shared_high_risk_contract_fixture_value(pointer);
            let params: ReplaySaveParams = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(params.seconds, seconds, "{pointer}");
            assert_eq!(serde_json::to_value(params).unwrap(), wire, "{pointer}");
        }
        for (pointer, seconds) in [
            ("/clip/markParams", None),
            ("/clip/markParamsLong", Some(60)),
        ] {
            let wire = shared_high_risk_contract_fixture_value(pointer);
            let params: ClipMarkParams = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(params.seconds, seconds, "{pointer}");
            assert_eq!(serde_json::to_value(params).unwrap(), wire, "{pointer}");
        }
        let saved_wire = shared_high_risk_contract_fixture_value("/replay/savedEvent");
        let saved: ReplaySavedEvent = serde_json::from_value(saved_wire.clone()).unwrap();
        assert_eq!(saved.source, Some(ClipMarkSource::Manual));
        assert_eq!(serde_json::to_value(saved).unwrap(), saved_wire);
        let failed_wire = shared_high_risk_contract_fixture_value("/replay/saveFailedEvent");
        let failed: ReplaySaveFailedEvent = serde_json::from_value(failed_wire.clone()).unwrap();
        assert_eq!(failed.reason, "probe");
        assert_eq!(serde_json::to_value(failed).unwrap(), failed_wire);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_stopped_compositor_nullability() {
        let wire = shared_high_risk_contract_fixture_value("/compositorStatus/stoppedWire");
        let status: CompositorStatus = serde_json::from_value(wire.clone()).unwrap();
        assert!(status.render_fps.is_none());
        assert!(status.frame_age_ms.is_none());
        assert!(status.frame_time_p95_ms.is_none());
        assert_eq!(serde_json::to_value(status).unwrap(), wire);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_account_sign_in_params() {
        let wire = shared_high_risk_contract_fixture_value("/account/completeSignInParams");
        let params: AccountCompleteSignInParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(params).unwrap(), wire);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_comment_pagination_and_deletion_dtos() {
        let list_wire = shared_high_risk_contract_fixture_value("/comments/listParamsWire");
        let list_expected =
            shared_high_risk_contract_fixture_value("/comments/listParamsNormalized");
        let list: SessionCommentsListParams = serde_json::from_value(list_wire).unwrap();
        assert_eq!(list.limit, DEFAULT_SESSION_COMMENTS_PAGE_LIMIT);
        assert_eq!(serde_json::to_value(list).unwrap(), list_expected);

        let page_expected = shared_high_risk_contract_fixture_value("/comments/page");
        let page = crate::storage::LiveChatMessagesPage {
            messages: Vec::new(),
            next_cursor: page_expected["nextCursor"].as_str().map(str::to_string),
        };
        assert_eq!(serde_json::to_value(page).unwrap(), page_expected);
        assert!(
            page_expected["nextCursor"]
                .as_str()
                .is_some_and(|cursor| cursor.contains('\n'))
        );

        let terminal_page_expected =
            shared_high_risk_contract_fixture_value("/comments/terminalPage");
        let terminal_page = crate::storage::LiveChatMessagesPage {
            messages: Vec::new(),
            next_cursor: None,
        };
        assert_eq!(
            serde_json::to_value(terminal_page).unwrap(),
            terminal_page_expected
        );

        let delete_params_wire = shared_high_risk_contract_fixture_value("/comments/deleteParams");
        let delete_params: SessionDeleteParams =
            serde_json::from_value(delete_params_wire.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(delete_params).unwrap(),
            delete_params_wire
        );

        let operation_wire = shared_high_risk_contract_fixture_value("/comments/deletionOperation");
        let operation: SessionDeletionHandle =
            serde_json::from_value(operation_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(operation).unwrap(), operation_wire);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_chat_event_details() {
        use crate::live_chat::{LiveChatEventDetails, LiveChatEventType, LiveChatMessage};

        let wire = shared_high_risk_contract_fixture_value("/comments/eventMessages");
        let messages: Vec<LiveChatMessage> = serde_json::from_value(wire.clone()).unwrap();
        // Round-trips exactly: a plain row gains no `details: null`, and every
        // variant keeps its kebab-case tag with camelCase fields.
        assert_eq!(serde_json::to_value(&messages).unwrap(), wire);
        assert!(messages[0].details.is_none() && messages[0].reply.is_none());
        assert!(!messages[0].first_message);
        assert!(messages[1].first_message);
        assert_eq!(
            messages[1].details,
            Some(LiveChatEventDetails::Cheer { bits: 1500 })
        );
        assert_eq!(messages[5].event_type, LiveChatEventType::Follow);
        assert!(matches!(
            messages[5].details,
            Some(LiveChatEventDetails::Follow { .. })
        ));
        assert_eq!(messages[6].event_type, LiveChatEventType::Paid);
        assert_eq!(
            messages[6].details,
            Some(LiveChatEventDetails::Kicks {
                amount: 500,
                gift_name: Some("Rage Quit".to_string()),
            })
        );
        assert_eq!(messages[8].event_type, LiveChatEventType::System);
        assert_eq!(
            messages[8].details,
            Some(LiveChatEventDetails::WatchStreak {
                streak_count: 20,
                channel_points_awarded: Some(450),
            })
        );
        // Plan 155: a Twitch GIF Keyboard row is a plain message whose one
        // `gif` fragment carries Twitch's URL; no new field, no `zeroWidth`.
        assert_eq!(messages[9].event_type, LiveChatEventType::Message);
        assert_eq!(messages[9].fragments[0].fragment_type, "gif");
        assert_eq!(
            messages[9].fragments[0].image_url.as_deref(),
            Some("https://media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif")
        );
        // Plan 162: Activity-only Twitch Power-up and channel point rows.
        assert_eq!(messages[10].event_type, LiveChatEventType::PowerUp);
        assert_eq!(
            messages[10].details,
            Some(LiveChatEventDetails::PowerUp {
                bits: 50,
                power_up: crate::live_chat::PowerUpKind::GigantifyAnEmote,
                emote_name: Some("orcdevBONK".to_string()),
                title: None,
            })
        );
        assert_eq!(messages[11].event_type, LiveChatEventType::Redemption);
        assert_eq!(
            messages[11].details,
            Some(LiveChatEventDetails::Redemption {
                reward: crate::live_chat::RedemptionKind::Custom,
                channel_points: 500,
                title: Some("Hydrate".to_string()),
                emote_name: None,
                points_name: Some("Orc Gold".to_string()),
            })
        );
        assert!(messages[0].author_affiliation.is_none());
        assert_eq!(
            messages[7]
                .author_affiliation
                .as_ref()
                .and_then(|badge| badge.description.as_deref()),
            Some("Neon")
        );
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_clip_mark_dtos() {
        let saved_wire = shared_high_risk_contract_fixture_value("/clip/markedSaved");
        let saved: ClipMarkedEvent = serde_json::from_value(saved_wire.clone()).unwrap();
        assert!(saved.saved);
        assert_eq!(saved.source, ClipMarkSource::Manual);
        assert_eq!(saved.reason, None);
        // Omitted, never null: the serde-null trap.
        assert_eq!(serde_json::to_value(saved).unwrap(), saved_wire);

        let unsaved_wire = shared_high_risk_contract_fixture_value("/clip/markedUnsaved");
        let unsaved: ClipMarkedEvent = serde_json::from_value(unsaved_wire.clone()).unwrap();
        assert!(!unsaved.saved);
        assert_eq!(unsaved.reason.as_deref(), Some("recording-off"));
        assert_eq!(serde_json::to_value(unsaved).unwrap(), unsaved_wire);

        let params_wire = shared_high_risk_contract_fixture_value("/clip/listParams");
        let params: ClipMarksListParams = serde_json::from_value(params_wire).unwrap();
        assert_eq!(params.session_id, "session-fixture");

        let marks_wire = shared_high_risk_contract_fixture_value("/clip/marks");
        let marks: Vec<ClipMark> = serde_json::from_value(marks_wire.clone()).unwrap();
        assert_eq!(marks[0].source, ClipMarkSource::Voice);
        assert_eq!(marks[0].phrase.as_deref(), Some("clip that"));
        assert_eq!(marks[1].phrase, None);
        // Plan 199 D8: a mark made before the plan has no length on the
        // wire; a 1-min press carries its 60.
        assert_eq!(marks[0].lookback_seconds, None);
        assert_eq!(marks[1].lookback_seconds, None);
        assert_eq!(marks[2].lookback_seconds, Some(60));
        assert_eq!(serde_json::to_value(marks).unwrap(), marks_wire);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_clean_cut_dtos() {
        let start_wire = shared_high_risk_contract_fixture_value("/cleanCut/startParams");
        let start: CleanCutStartParams = serde_json::from_value(start_wire.clone()).unwrap();
        assert_eq!(start.mode, CleanCutMode::Clean);
        assert!(start.consent_to_upload_audio);
        assert_eq!(start.target_duration_seconds, None);
        // Omitted, never null: the serde-null trap.
        assert_eq!(serde_json::to_value(start).unwrap(), start_wire);
        let condensed_wire =
            shared_high_risk_contract_fixture_value("/cleanCut/condensedStartParams");
        let condensed: CleanCutStartParams =
            serde_json::from_value(condensed_wire.clone()).unwrap();
        assert_eq!(condensed.mode, CleanCutMode::Condensed);
        assert_eq!(condensed.target_duration_seconds, Some(900));
        assert_eq!(serde_json::to_value(condensed).unwrap(), condensed_wire);
        let get_wire = shared_high_risk_contract_fixture_value("/cleanCut/getParams");
        let get: CleanCutGetParams = serde_json::from_value(get_wire).unwrap();
        assert_eq!(get.session_id, "session-fixture");

        for pointer in [
            "/cleanCut/queuedJob",
            "/cleanCut/readyJob",
            "/cleanCut/failedJob",
        ] {
            let wire = shared_high_risk_contract_fixture_value(pointer);
            let job: CleanCutJob = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(job).unwrap(), wire, "{pointer}");
        }
        let ready: CleanCutJob = serde_json::from_value(shared_high_risk_contract_fixture_value(
            "/cleanCut/readyJob",
        ))
        .unwrap();
        assert_eq!(ready.state, CleanCutJobState::Ready);
        assert!(!ready.state.is_active());
        let ready_summary = ready.edl_summary.clone().unwrap();
        assert_eq!(ready_summary.removal_count, 3);
        let failed: CleanCutJob = serde_json::from_value(shared_high_risk_contract_fixture_value(
            "/cleanCut/failedJob",
        ))
        .unwrap();
        assert_eq!(
            failed.error_code.as_deref(),
            Some("clean-cut-monthly-quota-exhausted")
        );
        assert_eq!(failed.step.as_deref(), Some("upload"));

        let edl_wire = shared_high_risk_contract_fixture_value("/cleanCut/edl");
        let edl: CleanCutEdl = serde_json::from_value(edl_wire.clone()).unwrap();
        assert_eq!(
            edl.frame_rate,
            CleanCutFrameRate {
                num: 30_000,
                den: 1_001
            }
        );
        assert_eq!(edl.removals[1].kind, CleanCutRemovalKind::Retake);
        assert_eq!(edl.removals[2].kind, CleanCutRemovalKind::FalseStart);
        assert!(!edl.removals[2].enabled);
        assert_eq!(edl.removals[0].confidence, None);
        assert_eq!(edl.summary(), ready_summary);
        assert_eq!(serde_json::to_value(edl).unwrap(), edl_wire);

        let result_wire = shared_high_risk_contract_fixture_value("/cleanCut/getResult");
        let result: CleanCutGetResult = serde_json::from_value(result_wire.clone()).unwrap();
        assert_eq!(result.jobs.len(), 1);
        assert!(result.jobs[0].edl.is_some());
        assert_eq!(serde_json::to_value(result).unwrap(), result_wire);

        let update_wire = shared_high_risk_contract_fixture_value("/cleanCut/updateEdlParams");
        let update: CleanCutUpdateEdlParams = serde_json::from_value(update_wire.clone()).unwrap();
        assert_eq!(update.revision, 0);
        assert!(update.remove_manual.is_empty());
        assert_eq!(update.add_manual[0].end_ms, 601_000);
        assert_eq!(update.removals[0].id, "r3");
        assert_eq!(serde_json::to_value(update).unwrap(), update_wire);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_clean_cut_render_dtos() {
        // Plan 119 S13: `cleanCut.render`, `cleanCut.transcript` and the
        // Condensed keeps on `cleanCut.get`.
        let render_wire = shared_high_risk_contract_fixture_value("/cleanCut/renderParams");
        let render: CleanCutRenderParams = serde_json::from_value(render_wire.clone()).unwrap();
        assert_eq!(render.job_id, "clean-cut-fixture-1");
        assert_eq!(serde_json::to_value(render).unwrap(), render_wire);
        let transcript_params: CleanCutTranscriptParams = serde_json::from_value(
            shared_high_risk_contract_fixture_value("/cleanCut/transcriptParams"),
        )
        .unwrap();
        assert_eq!(transcript_params.job_id, "clean-cut-fixture-1");

        for pointer in ["/cleanCut/renderingJob", "/cleanCut/completedJob"] {
            let wire = shared_high_risk_contract_fixture_value(pointer);
            let job: CleanCutJob = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(job).unwrap(), wire, "{pointer}");
        }
        let rendering: CleanCutJob = serde_json::from_value(
            shared_high_risk_contract_fixture_value("/cleanCut/renderingJob"),
        )
        .unwrap();
        assert_eq!(rendering.state, CleanCutJobState::Rendering);
        assert!(rendering.state.is_active());
        assert_eq!(rendering.step.as_deref(), Some("render"));
        assert_eq!(rendering.output_session_id, None);
        let completed: CleanCutJob = serde_json::from_value(
            shared_high_risk_contract_fixture_value("/cleanCut/completedJob"),
        )
        .unwrap();
        assert_eq!(completed.state, CleanCutJobState::Completed);
        assert!(!completed.state.is_active());
        assert_eq!(
            completed.output_session_id.as_deref(),
            Some("session-fixture-clean-cut")
        );

        let transcript_wire = shared_high_risk_contract_fixture_value("/cleanCut/transcript");
        let transcript: CleanCutTranscript =
            serde_json::from_value(transcript_wire.clone()).unwrap();
        assert_eq!(transcript.language.as_deref(), Some("en"));
        assert!(!transcript.words[0].filler && transcript.words[1].filler);
        assert_eq!(transcript.segments[0].id, "s1");
        assert_eq!(
            serde_json::to_value(transcript).unwrap(),
            transcript_wire,
            "filler is written only when true"
        );
        let without_wire =
            shared_high_risk_contract_fixture_value("/cleanCut/transcriptWithoutLanguage");
        let without: CleanCutTranscript = serde_json::from_value(without_wire.clone()).unwrap();
        assert_eq!(without.language, None);
        assert!(without.words.is_empty() && without.segments.is_empty());
        assert_eq!(
            serde_json::to_value(without).unwrap(),
            without_wire,
            "language is null, never absent"
        );

        let condensed_wire =
            shared_high_risk_contract_fixture_value("/cleanCut/condensedGetResult");
        let condensed: CleanCutGetResult = serde_json::from_value(condensed_wire.clone()).unwrap();
        assert_eq!(condensed.jobs[0].job.mode, CleanCutMode::Condensed);
        assert_eq!(condensed.jobs[0].condensed_keeps.len(), 2);
        assert_eq!(
            condensed.jobs[0].condensed_keeps[1].title,
            "Deploying to Vercel"
        );
        assert_eq!(serde_json::to_value(condensed).unwrap(), condensed_wire);
        let clean: CleanCutGetResult = serde_json::from_value(
            shared_high_risk_contract_fixture_value("/cleanCut/getResult"),
        )
        .unwrap();
        assert!(clean.jobs[0].condensed_keeps.is_empty());
        assert!(
            serde_json::to_value(&clean.jobs[0])
                .unwrap()
                .get("condensedKeeps")
                .is_none(),
            "omitted when empty"
        );
    }

    /// Plan 192 D7 and S2.2: the report carries greeting skip counts and
    /// who wrote each greeting; zero counts, the empty block and the source
    /// of a manual post are omitted; rows from before parse.
    #[test]
    fn shared_high_risk_contract_fixture_report_carries_greeting_skips_and_post_sources() {
        let report_wire = shared_high_risk_contract_fixture_value("/cohost/reportPayload/report");
        let report = CohostSessionReport::from_stored_json(&report_wire.to_string()).unwrap();
        assert_eq!(
            report.greetings.skipped,
            Some(CohostReportGreetingsSkipped {
                no_line: 1,
                held: 4,
                youtube_paused: 2,
                no_bubble: 3,
                ..CohostReportGreetingsSkipped::default()
            })
        );
        assert_eq!(report.posts.len(), 3);
        assert_eq!(report.posts[0].source, Some(CohostReportPostSource::Ai));
        assert_eq!(report.posts[1].source, Some(CohostReportPostSource::Line));
        assert_eq!(report.posts[2].source, None);
        // Plan 211 D11: what Buddy said in its bubble rides beside the posts,
        // with a greeting's source and none on a manual line.
        assert_eq!(report.said.len(), 2);
        assert_eq!(
            report.said[0],
            CohostReportSaid {
                id: "utt-4-fixture".to_string(),
                at: "2026-08-22T10:08:00Z".to_string(),
                trigger: crate::cohost::CohostUtteranceTriggerKind::Greeting,
                text: "Welcome, Ada!".to_string(),
                source: Some(CohostReportPostSource::Line),
            }
        );
        assert_eq!(
            report.said[1].trigger,
            crate::cohost::CohostUtteranceTriggerKind::Manual
        );
        assert_eq!(report.said[1].source, None);
        assert_eq!(serde_json::to_value(&report).unwrap(), report_wire);
        // A said line folds in like a post; the same id is kept once.
        let folded = report.clone().merged_with(CohostSessionReport::said_only(
            "session-fixture",
            CohostReportSaid {
                id: "utt-6-fixture".to_string(),
                at: "2026-08-22T10:10:00Z".to_string(),
                trigger: crate::cohost::CohostUtteranceTriggerKind::Answer,
                text: "@Ada It's Rust today.".to_string(),
                source: None,
            },
        ));
        assert_eq!(folded.said.len(), 3);
        assert_eq!(folded.said[2].id, "utt-6-fixture");
        assert_eq!(
            report.clone().merged_with(report.clone()).said.len(),
            2,
            "the same lines twice are kept once"
        );
        let only = CohostSessionReport::said_only("s", report.said[1].clone());
        assert_eq!(only.segments, 0);
        assert!(only.posts.is_empty());
        assert_eq!(
            serde_json::to_value(&only).unwrap()["said"][0]["trigger"],
            "manual"
        );

        let at = "2026-08-22T10:00:00Z";
        let empty = CohostSessionReport::greeting_skips_only(
            "s",
            CohostReportGreetingsSkipped::default(),
            at,
        );
        assert_eq!(empty.greetings.skipped, None);
        assert!(
            serde_json::to_value(&empty).unwrap()["greetings"]
                .get("skipped")
                .is_none()
        );
        let one = CohostReportGreetingsSkipped {
            deduped: 3,
            ..CohostReportGreetingsSkipped::default()
        };
        assert_eq!(
            serde_json::to_value(one).unwrap(),
            serde_json::json!({ "deduped": 3 })
        );
        let merged = CohostSessionReport::greeting_skips_only("s", one, at).merged_with(
            CohostSessionReport::greeting_skips_only(
                "s",
                CohostReportGreetingsSkipped {
                    deduped: 1,
                    stale: 2,
                    ..CohostReportGreetingsSkipped::default()
                },
                at,
            ),
        );
        assert_eq!(
            merged.greetings.skipped,
            Some(CohostReportGreetingsSkipped {
                deduped: 4,
                stale: 2,
                ..CohostReportGreetingsSkipped::default()
            })
        );
        assert_eq!(merged.segments, 0, "partial writes are not sessions");
        let old_post: CohostReportPost = serde_json::from_value(serde_json::json!({
            "id": "u",
            "at": at,
            "trigger": "greeting",
            "text": "hi",
            "result": "sent"
        }))
        .unwrap();
        assert_eq!(old_post.source, None);
        assert!(
            serde_json::to_value(&old_post)
                .unwrap()
                .get("source")
                .is_none()
        );
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_cohost_dtos() {
        let start_wire = shared_high_risk_contract_fixture_value("/cohost/startParams");
        let start: CohostStartParams = serde_json::from_value(start_wire.clone()).unwrap();
        assert!(start.consent_to_process_chat);
        assert_eq!(serde_json::to_value(start).unwrap(), start_wire);

        let minimal_start: CohostStartParams =
            serde_json::from_value(serde_json::json!({ "sessionId": "session-fixture" })).unwrap();
        assert!(!minimal_start.consent_to_process_chat);
        assert_eq!(minimal_start.stream_title, None);

        let question_wire = shared_high_risk_contract_fixture_value("/cohost/questionParams");
        let question: CohostQuestionParams = serde_json::from_value(question_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(question).unwrap(), question_wire);

        let flag_wire = shared_high_risk_contract_fixture_value("/cohost/flagParams");
        let flag: CohostFlagParams = serde_json::from_value(flag_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(flag).unwrap(), flag_wire);

        let patch_wire = shared_high_risk_contract_fixture_value("/cohost/settingsPatch");
        let patch: CohostSettingsPatch = serde_json::from_value(patch_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&patch).unwrap(), patch_wire);
        let empty_patch: CohostSettingsPatch =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(empty_patch, CohostSettingsPatch::default());

        let settings_wire = shared_high_risk_contract_fixture_value("/cohost/settings");
        let settings: crate::cohost::CohostSettings =
            serde_json::from_value(settings_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(settings).unwrap(), settings_wire);

        let state_wire = shared_high_risk_contract_fixture_value("/cohost/state");
        let state: crate::cohost::CohostState = serde_json::from_value(state_wire.clone()).unwrap();
        // Presence fields (W1): pending delta, scheduled next pass, in-flight
        // flag, and the session lifetime counters ride every state payload.
        assert!(!state.tick_in_flight);
        assert_eq!(state.pending_messages, 4);
        assert_eq!(state.next_tick_at.as_deref(), Some("2026-08-22T10:00:28Z"));
        assert_eq!(state.messages_seen, 84);
        assert_eq!(state.questions_total, 5);
        assert_eq!(serde_json::to_value(state).unwrap(), state_wire);

        let off_wire = shared_high_risk_contract_fixture_value("/cohost/offState");
        let off: crate::cohost::CohostState = serde_json::from_value(off_wire.clone()).unwrap();
        assert_eq!(off, crate::cohost::CohostState::off());
        assert_eq!(serde_json::to_value(off).unwrap(), off_wire);

        // `detail` rides a failed tick: server envelope code + message + HTTP
        // status, or a desktop-assigned code with no status.
        let error_wire = shared_high_risk_contract_fixture_value("/cohost/errorState");
        let errored: crate::cohost::CohostState =
            serde_json::from_value(error_wire.clone()).unwrap();
        assert_eq!(
            errored.detail,
            Some(crate::cohost::CohostErrorDetail {
                code: "ai-gateway-error".to_string(),
                message: "The Sidekick tick failed on every configured model.".to_string(),
                status: Some(502),
            })
        );
        assert_eq!(serde_json::to_value(errored).unwrap(), error_wire);
        let timeout_wire = shared_high_risk_contract_fixture_value("/cohost/timeoutState");
        let timed_out: crate::cohost::CohostState =
            serde_json::from_value(timeout_wire.clone()).unwrap();
        assert_eq!(
            timed_out.detail.as_ref().map(|detail| detail.code.as_str()),
            Some("timeout")
        );
        assert_eq!(
            timed_out.detail.as_ref().and_then(|detail| detail.status),
            None
        );
        assert_eq!(serde_json::to_value(timed_out).unwrap(), timeout_wire);

        // Wire v2: flag extras, suggested highlights, alerts and mood scores
        // round-trip; absent optionals stay absent (never null), and an
        // unknown flag kind rides as "unknown".
        let v2_wire = shared_high_risk_contract_fixture_value("/cohost/stateV2");
        let v2: crate::cohost::CohostState = serde_json::from_value(v2_wire.clone()).unwrap();
        assert_eq!(v2.flags[1].rule.as_deref(), Some("No spoilers"));
        assert_eq!(v2.flags[2].kind, crate::cohost::CohostFlagKind::Unknown);
        assert_eq!(v2.flags[2].confidence, None);
        assert!(v2.alerts[0].active);
        // Plan 060 S1: the engine's automatic on-stream command rides the
        // state with a kebab-case source; absent (never null) until it exists.
        assert_eq!(
            v2.auto_highlight,
            Some(crate::cohost::CohostAutoHighlight {
                generation: 4,
                message_id: "session-fixture:twitch:default:message-highlight".to_string(),
                source: crate::cohost::CohostAutoHighlightSource::Pick,
                refresh: false,
            })
        );
        // Plan 060 S3: the spotlight (the comment the streamer is talking
        // about) and the voice-resolved questions ride the state; both are
        // absent (never null / never `[]`) until they exist.
        assert_eq!(
            v2.spotlight,
            Some(crate::cohost::CohostSpotlight {
                message_id: "session-fixture:twitch:default:message-highlight".to_string(),
                question_id: Some("q_fixture".to_string()),
                score: 0.91,
                at: "2026-08-22T10:00:20Z".to_string(),
                expires_at: "2026-08-22T10:00:35Z".to_string(),
            })
        );
        assert_eq!(v2.recently_resolved.len(), 1);
        assert_eq!(
            v2.recently_resolved[0].reason,
            crate::cohost::CohostResolveReason::Voice
        );
        assert_eq!(v2.recently_resolved[0].question.id, "q_fixture");
        assert_eq!(v2.recently_resolved[0].resolved_at, "2026-08-22T10:00:20Z");
        assert_eq!(serde_json::to_value(&v2).unwrap(), v2_wire);
        // `voiceHighlight` (plan 060) defaults off on a settings row or patch
        // from before the field.
        assert!(settings_wire.get("voiceHighlight").is_some());
        let legacy_settings: crate::cohost::CohostSettings = serde_json::from_value(
            serde_json::json!({ "enabled": true, "tone": "short", "notes": "", "autoHighlight": true }),
        )
        .unwrap();
        assert!(legacy_settings.auto_highlight);
        assert!(!legacy_settings.voice_highlight);
        assert_eq!(patch.voice_highlight, Some(true));
        // `listen` (plan 068) defaults off on a settings row from before the
        // field; the patch carries it explicitly.
        assert!(!legacy_settings.listen);
        assert_eq!(patch.listen, Some(true));
        assert_eq!(
            v2.listening,
            Some(crate::cohost::CohostListening {
                state: crate::cohost::CohostListeningState::Blocked,
                reason_code: Some("listen-monthly-quota-exhausted".to_string()),
                message: Some(
                    "Sidekick's listening allowance for this month is used up.".to_string()
                ),
                remaining_seconds: Some(0),
            })
        );

        // A payload from before `detail` and the presence fields existed still
        // parses (serde defaults).
        let legacy_wire = shared_high_risk_contract_fixture_value("/cohost/legacyState");
        assert!(legacy_wire.get("detail").is_none());
        assert!(legacy_wire.get("tickInFlight").is_none());
        assert!(legacy_wire.get("pendingMessages").is_none());
        assert!(legacy_wire.get("nextTickAt").is_none());
        assert!(legacy_wire.get("messagesSeen").is_none());
        assert!(legacy_wire.get("questionsTotal").is_none());
        assert!(legacy_wire.get("autoHighlight").is_none());
        assert!(legacy_wire.get("spotlight").is_none());
        assert!(legacy_wire.get("recentlyResolved").is_none());
        let legacy: crate::cohost::CohostState = serde_json::from_value(legacy_wire).unwrap();
        assert_eq!(legacy, crate::cohost::CohostState::off());
        assert_eq!(legacy.auto_highlight, None);
        assert_eq!(legacy.spotlight, None);
        assert!(legacy.recently_resolved.is_empty());
        // The restore RPC reuses the question params verbatim.
        let restore: CohostQuestionParams = serde_json::from_value(question_wire).unwrap();
        assert_eq!(restore.question_id, "q_fixture");
        // Plan 068 S5 (tick v3): promise and recap params, and the topic,
        // promises, reminder, recap and on-topic flag on the state; every one
        // of them absent (never null) on the legacy payload.
        let promise_wire = shared_high_risk_contract_fixture_value("/cohost/promiseParams");
        let promise: CohostPromiseParams = serde_json::from_value(promise_wire.clone()).unwrap();
        assert_eq!(promise.promise_id, "p_fixture");
        assert_eq!(serde_json::to_value(promise).unwrap(), promise_wire);
        let recap_wire = shared_high_risk_contract_fixture_value("/cohost/recapParams");
        let recap: CohostRecapParams = serde_json::from_value(recap_wire.clone()).unwrap();
        assert_eq!(recap.session_id, "session-fixture");
        assert_eq!(serde_json::to_value(recap).unwrap(), recap_wire);
        assert_eq!(v2.topic.as_deref(), Some("Mechanical keyboards"));
        assert_eq!(v2.promises.len(), 2);
        assert_eq!(
            v2.promises[0].trigger,
            crate::cohost::CohostPromiseTrigger {
                kind: crate::cohost::CohostPromiseTriggerKind::Viewers,
                value: Some(100),
            }
        );
        assert_eq!(
            v2.promises[1].trigger.kind,
            crate::cohost::CohostPromiseTriggerKind::None
        );
        assert_eq!(v2.promises[1].trigger.value, None);
        assert_eq!(
            v2.promise_reminder.as_ref().map(|r| r.promise_id.as_str()),
            Some("p_fixture")
        );
        assert_eq!(
            v2.recap.as_ref().map(|r| r.expires_at.as_str()),
            Some("2026-08-22T10:05:20Z")
        );
        assert!(v2.questions[0].on_topic);
        assert_eq!(legacy.topic, None);
        assert!(legacy.promises.is_empty());
        assert_eq!(legacy.promise_reminder, None);
        assert_eq!(legacy.recap, None);
        // Plan 068 S6: the Greeted params, "Say hi" and the dead-air nudge;
        // both absent (never null) on the legacy payload.
        let author_wire = shared_high_risk_contract_fixture_value("/cohost/authorParams");
        let author: CohostAuthorParams = serde_json::from_value(author_wire.clone()).unwrap();
        assert_eq!(author.author_key, "\"twitch\":viewer-fixture");
        assert_eq!(serde_json::to_value(author).unwrap(), author_wire);
        assert_eq!(v2.say_hi.len(), 1);
        assert_eq!(v2.say_hi[0].name, "x_Dark_Knight_x");
        assert_eq!(
            v2.say_hi[0].platform,
            crate::streaming::StreamPlatform::Twitch
        );
        assert_eq!(
            v2.dead_air_nudge.as_ref().map(|nudge| nudge.key.as_str()),
            Some("dead-air-1-1")
        );
        assert!(legacy.say_hi.is_empty());
        assert_eq!(legacy.dead_air_nudge, None);

        // Plan 140 S3: the voice-command settings, the command RPC params, and
        // the latest command with the kill switches. All of them absent (never
        // null) from the older payloads; old settings load with the defaults.
        assert!(!settings_wire["wakeWordRequired"].as_bool().unwrap());
        assert_eq!(settings_wire["removeConfirm"], "confirm");
        assert!(!legacy_settings.wake_word_required);
        assert_eq!(
            legacy_settings.remove_confirm,
            crate::live_chat_moderation::RemoveConfirmMode::Confirm
        );
        assert_eq!(patch.wake_word_required, Some(true));
        assert_eq!(
            patch.remove_confirm,
            Some(crate::live_chat_moderation::RemoveConfirmMode::Countdown)
        );
        let choose_wire = shared_high_risk_contract_fixture_value("/cohost/commandChooseParams");
        let choose: CohostCommandChooseParams =
            serde_json::from_value(choose_wire.clone()).unwrap();
        assert_eq!(choose.index, 1);
        assert_eq!(serde_json::to_value(choose).unwrap(), choose_wire);
        let answer_wire = shared_high_risk_contract_fixture_value("/cohost/commandParams");
        let answer: CohostCommandParams = serde_json::from_value(answer_wire.clone()).unwrap();
        assert!(answer.command_id.starts_with("cmd-"));
        assert_eq!(serde_json::to_value(answer).unwrap(), answer_wire);
        let command_wire = shared_high_risk_contract_fixture_value("/cohost/commandState");
        let with_command: crate::cohost::CohostState =
            serde_json::from_value(command_wire.clone()).unwrap();
        let command = with_command.command.as_ref().unwrap();
        assert_eq!(command.kind, crate::cohost::CohostCommandKind::Remove);
        assert_eq!(command.status, crate::cohost::CohostCommandStatus::Confirm);
        assert!(command.operation_id.is_some() && command.candidates.is_empty());
        assert_eq!(
            with_command.command_availability,
            Some(crate::cohost::CohostCommandAvailability {
                voice_commands: crate::cohost::CohostSwitchState::On,
                remove: crate::cohost::CohostSwitchState::Paused,
            })
        );
        assert_eq!(serde_json::to_value(&with_command).unwrap(), command_wire);
        let chooser_wire = shared_high_risk_contract_fixture_value("/cohost/chooserState");
        let chooser: crate::cohost::CohostState =
            serde_json::from_value(chooser_wire.clone()).unwrap();
        let command = chooser.command.as_ref().unwrap();
        assert_eq!(
            command.status,
            crate::cohost::CohostCommandStatus::Ambiguous
        );
        assert_eq!(command.candidates.len(), 2);
        assert!(command.target.is_none() && command.operation_id.is_none());
        assert_eq!(chooser.command_availability, None);
        assert_eq!(serde_json::to_value(&chooser).unwrap(), chooser_wire);
        for wire in [&state_wire, &v2_wire, &off_wire] {
            assert!(wire.get("command").is_none());
            assert!(wire.get("commandAvailability").is_none());
        }
        assert_eq!(legacy.command, None);
        assert_eq!(legacy.command_availability, None);
    }

    #[test]
    fn shared_high_risk_contract_fixture_matches_cohost_report_dtos() {
        let params_wire = shared_high_risk_contract_fixture_value("/cohost/reportGetParams");
        let params: CohostReportGetParams = serde_json::from_value(params_wire.clone()).unwrap();
        assert_eq!(params.session_id, "session-fixture");
        assert_eq!(serde_json::to_value(params).unwrap(), params_wire);

        let saved_wire = shared_high_risk_contract_fixture_value("/cohost/reportSaved");
        let saved: CohostReportSavedEvent = serde_json::from_value(saved_wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(saved).unwrap(), saved_wire);

        let report_wire = shared_high_risk_contract_fixture_value("/cohost/report");
        let report: CohostSessionReport = serde_json::from_value(report_wire.clone()).unwrap();
        assert_eq!(report.version, COHOST_SESSION_REPORT_VERSION);
        assert_eq!(report.questions.items.len(), 2);
        assert_eq!(
            report.questions.items[0].outcome,
            CohostReportQuestionOutcome::Replied
        );
        assert!(report.questions.items[1].askers.is_empty());
        assert_eq!(report.alerts[0].kind, crate::cohost::CohostAlertKind::Audio);
        assert_eq!(
            report.flags.by_kind[0].kind,
            crate::cohost::CohostFlagKind::SelfPromo
        );
        // Optional lists ride only when they have entries: no null anywhere.
        assert_eq!(serde_json::to_value(&report).unwrap(), report_wire);
        assert_eq!(
            CohostSessionReport::from_stored_json(&report_wire.to_string()),
            Some(report.clone())
        );

        let payload_wire = shared_high_risk_contract_fixture_value("/cohost/reportPayload");
        let payload: CohostReportPayload = serde_json::from_value(payload_wire.clone()).unwrap();
        let minimal = payload
            .report
            .as_ref()
            .expect("the payload carries the minimal report");
        assert_eq!(minimal.segments, 2);
        assert_eq!(minimal.stream_title, None);
        assert!(minimal.alerts.is_empty() && minimal.questions.items.is_empty());
        assert_eq!(payload.moments.len(), 3);
        assert_eq!(payload.moments[0].source, Some(ClipMomentSource::Voice));
        assert_eq!(payload.chat.messages, 84);
        assert_eq!(serde_json::to_value(&payload).unwrap(), payload_wire);

        let empty_wire =
            shared_high_risk_contract_fixture_value("/cohost/reportPayloadWithoutReport");
        let empty: CohostReportPayload = serde_json::from_value(empty_wire.clone()).unwrap();
        assert_eq!(empty.report, None);
        assert!(empty.moments.is_empty() && empty.chat.by_platform.is_empty());
        // `report` is the one explicit null: the renderer keys on it.
        assert_eq!(serde_json::to_value(&empty).unwrap(), empty_wire);

        // Plan 140 S3: the voice-command counts ride the full report and are
        // absent (never null) from a report without commands.
        let commands = report
            .commands
            .as_ref()
            .expect("the full report counts commands");
        assert_eq!(commands.highlighted, 3);
        assert_eq!(commands.hidden_locally, 1);
        assert_eq!(commands.not_found, 2);
        assert_eq!(minimal.commands, None);
        assert!(
            payload_wire["report"].get("commands").is_none(),
            "omitted, never null"
        );
        // Plan 211 D11: a report from before `said` reads unchanged and
        // writes no `said` key; the payload's report carries two lines.
        assert!(report.said.is_empty());
        assert!(report_wire.get("said").is_none());
        assert_eq!(minimal.said.len(), 2);
    }

    #[test]
    fn cohost_report_commands_merge_by_sum_and_stay_absent_without_commands() {
        let base: CohostSessionReport =
            serde_json::from_value(shared_high_risk_contract_fixture_value("/cohost/report"))
                .unwrap();
        let counted = base.commands.clone().unwrap();
        let mut without = base.clone();
        without.commands = None;

        // Buddy off and on mid-stream: the counts add up.
        let merged = base.clone().merged_with(base.clone());
        let doubled = merged.commands.unwrap();
        assert_eq!(doubled.highlighted, counted.highlighted * 2);
        assert_eq!(doubled.cleared, counted.cleared * 2);
        assert_eq!(doubled.removed, counted.removed * 2);
        assert_eq!(doubled.hidden_locally, counted.hidden_locally * 2);
        assert_eq!(doubled.cancelled, counted.cancelled * 2);
        assert_eq!(doubled.not_found, counted.not_found * 2);
        // Either side alone keeps its counts.
        assert_eq!(
            without.clone().merged_with(base.clone()).commands,
            Some(counted.clone())
        );
        assert_eq!(
            base.clone().merged_with(without.clone()).commands,
            Some(counted)
        );
        // Neither side: still absent, and the key never appears.
        let neither = without.clone().merged_with(without);
        assert_eq!(neither.commands, None);
        assert!(
            serde_json::to_value(&neither)
                .unwrap()
                .get("commands")
                .is_none()
        );
        // A stored report from before plan 140 reads with no commands.
        let legacy = serde_json::json!({
            "version": 1,
            "sessionId": "s-1",
            "startedAt": "2026-10-04T10:00:00Z",
            "endedAt": "2026-10-04T11:00:00Z"
        });
        let legacy = CohostSessionReport::from_stored_json(&legacy.to_string()).unwrap();
        assert_eq!(legacy.commands, None);
        assert!(CohostReportCommands::default().is_empty());
        // Partial counts default the rest.
        let partial: CohostReportCommands =
            serde_json::from_value(serde_json::json!({ "removed": 2 })).unwrap();
        assert_eq!(partial.removed, 2);
        assert_eq!(partial.highlighted, 0);
    }

    #[test]
    fn cohost_session_report_defaults_missing_blocks_and_reads_other_versions_as_unavailable() {
        let minimal: CohostSessionReport = serde_json::from_value(serde_json::json!({
            "version": 1,
            "sessionId": "s-1",
            "startedAt": "2026-10-04T10:00:00Z",
            "endedAt": "2026-10-04T11:00:00Z"
        }))
        .unwrap();
        assert_eq!(minimal.segments, 0);
        assert_eq!(minimal.questions, CohostReportQuestions::default());
        assert_eq!(minimal.greetings, CohostReportGreetings::default());
        let wire = serde_json::to_value(&minimal).unwrap();
        for key in ["streamTitle", "alerts"] {
            assert!(wire.get(key).is_none(), "{key} is omitted, never null");
        }
        assert!(wire["questions"].get("items").is_none());
        assert!(wire["flags"].get("byKind").is_none());
        assert!(wire["promises"].get("open").is_none());
        assert_eq!(
            CohostSessionReport::from_stored_json(&wire.to_string()),
            Some(minimal)
        );
        assert_eq!(
            CohostSessionReport::from_stored_json(
                r#"{"version":2,"sessionId":"s-1","startedAt":"t","endedAt":"t"}"#
            ),
            None,
            "a newer format reads as unavailable, never as an error"
        );
        assert_eq!(CohostSessionReport::from_stored_json("not json"), None);
        assert_eq!(
            CohostSessionReport::from_stored_json(
                r#"{"version":1,"sessionId":"s","startedAt":"t","endedAt":"t","questions":{"items":[{"id":"q","text":"?","priority":"high","firstSeenAt":"t","outcome":"teleported"}]}}"#
            ),
            None,
            "an outcome this build does not know"
        );
    }

    #[test]
    fn cohost_session_report_merge_sums_counts_and_keeps_the_later_outcome() {
        let base: CohostSessionReport =
            serde_json::from_value(shared_high_risk_contract_fixture_value("/cohost/report"))
                .unwrap();
        let mut later = base.clone();
        later.started_at = "2026-08-22T11:31:00Z".to_string();
        later.ended_at = "2026-08-22T12:00:00Z".to_string();
        later.stream_title = None;
        later.questions.items.truncate(1);
        later.questions.items[0].outcome = CohostReportQuestionOutcome::MarkedAnswered;
        later.questions.items.push(CohostReportQuestion {
            id: "q_new".to_string(),
            text: "Is this live?".to_string(),
            askers: Vec::new(),
            platforms: Vec::new(),
            priority: crate::cohost::CohostPriority::Low,
            first_seen_at: "2026-08-22T11:45:00Z".to_string(),
            outcome: CohostReportQuestionOutcome::Open,
        });
        later.promises.open.push(CohostReportOpenPromise {
            text: "Raid someone after".to_string(),
            first_seen_at: "2026-08-22T11:50:00Z".to_string(),
        });
        later.flags.by_kind = vec![CohostReportFlagKindCount {
            kind: crate::cohost::CohostFlagKind::Spam,
            count: 3,
        }];
        later.alerts[0].peak_viewers = 5;
        later.alerts[0].first_seen_at = "2026-08-22T11:40:00Z".to_string();
        later.alerts.push(CohostReportAlert {
            kind: crate::cohost::CohostAlertKind::Video,
            peak_viewers: 1,
            active: false,
            first_seen_at: "2026-08-22T11:55:00Z".to_string(),
        });

        let merged = base.clone().merged_with(later);
        assert_eq!(merged.version, COHOST_SESSION_REPORT_VERSION);
        assert_eq!(merged.started_at, "2026-08-22T10:00:00Z");
        assert_eq!(merged.ended_at, "2026-08-22T12:00:00Z");
        assert_eq!(merged.segments, 2);
        assert_eq!(
            merged.stream_title.as_deref(),
            Some("Rust night"),
            "a later report without a title keeps the earlier one"
        );
        assert_eq!(merged.messages_seen, 168);
        assert_eq!(merged.shown_on_stream, 4);
        assert_eq!(merged.questions.total, 10);
        assert_eq!(merged.questions.replied, 2);
        assert_eq!(merged.questions.items.len(), 3);
        assert_eq!(
            merged.questions.items[0].outcome,
            CohostReportQuestionOutcome::MarkedAnswered,
            "the later outcome wins"
        );
        assert_eq!(merged.questions.items[1].id, "q_fixture_2");
        assert_eq!(merged.questions.items[2].id, "q_new");
        assert_eq!(merged.promises.heard, 4);
        assert_eq!(
            merged
                .promises
                .open
                .iter()
                .map(|open| open.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Giveaway at 100 viewers", "Raid someone after"],
            "open promises union by text"
        );
        assert_eq!(merged.flags.raised, 4);
        assert_eq!(merged.flags.by_kind.len(), 2);
        assert_eq!(
            merged.flags.by_kind[1].kind,
            crate::cohost::CohostFlagKind::Spam
        );
        assert_eq!(merged.flags.by_kind[1].count, 4);
        assert_eq!(merged.flags.by_severity[0].count, 4);
        assert_eq!(merged.alerts.len(), 2);
        assert_eq!(merged.alerts[0].peak_viewers, 5);
        assert!(merged.alerts[0].active);
        assert_eq!(merged.alerts[0].first_seen_at, "2026-08-22T10:40:00Z");
        assert_eq!(merged.alerts[1].kind, crate::cohost::CohostAlertKind::Video);
        assert_eq!(merged.greetings.first_timers, 6);
        assert_eq!(merged.recap.offered, 2);

        // A later report that started earlier moves the start back, and a
        // shorter one never shortens the span.
        let mut earlier = base.clone();
        earlier.started_at = "2026-08-22T09:00:00Z".to_string();
        earlier.ended_at = "2026-08-22T09:30:00Z".to_string();
        let merged = base.merged_with(earlier);
        assert_eq!(merged.started_at, "2026-08-22T09:00:00Z");
        assert_eq!(merged.ended_at, "2026-08-22T11:30:00Z");
    }

    #[test]
    fn performance_check_contract_has_no_nulls_and_rejects_unknown_params() {
        let video = VideoSettings {
            preset: VideoPreset::Tutorial720p30,
            width: 1280,
            height: 720,
            fps: 30,
            bitrate_kbps: 4000,
        };
        let result = PerformanceCheckResult {
            capability_key: "performance-check-v1:abc".to_string(),
            checked_at: "2026-09-20T00:00:00Z".to_string(),
            app_version: "0.9.0".to_string(),
            duration_ms: 6_000,
            recommended: video.clone(),
            below_floor: false,
            rungs: vec![PerformanceCheckRung {
                video,
                verdict: PerformanceCheckRungVerdict::Passed,
                encode_backend: None,
                compositor_backend: None,
                encoder_speed: Some(1.0),
                delivered_fps: None,
                drain_after_stop_ms: None,
                reasons: Vec::new(),
            }],
        };
        let state = PerformanceCheckState {
            last_run_not_recorded: None,
            running: false,
            result: Some(result.clone()),
            stale: false,
        };
        let text = serde_json::to_string(&state).unwrap();
        // serde null → contract trap: an Option without skip_serializing_if
        // has taken the app down three times.
        assert!(!text.contains("null"), "{text}");
        assert!(text.contains("\"preset\":\"tutorial-720p30\""));
        assert!(text.contains("\"verdict\":\"passed\""));
        let decoded: PerformanceCheckState = serde_json::from_str(&text).unwrap();
        assert_eq!(decoded.result, Some(result));
        let idle = serde_json::to_string(&PerformanceCheckState {
            last_run_not_recorded: None,
            running: true,
            result: None,
            stale: false,
        })
        .unwrap();
        assert_eq!(idle, "{\"running\":true,\"stale\":false}");

        assert!(
            serde_json::from_value::<PerformanceCheckRunParams>(serde_json::json!({
                "ceilingWidth": 1920, "ceilingHeight": 1080, "ceilingFps": 30,
                "ffmpegPath": "/tmp/evil"
            }))
            .is_err(),
            "unknown fields are rejected: the check never takes a client FFmpeg path"
        );
    }

    #[test]
    fn stream_output_topology_probe_contract_is_secret_free_and_stable() {
        let params: StreamOutputTopologyProbeParams = serde_json::from_value(serde_json::json!({
            "streamProfile": {
                "preset": "stream-safe-1080p60",
                "width": 1920,
                "height": 1080,
                "fps": 60,
                "bitrateKbps": 6000
            },
            "recordingProfile": {
                "preset": "tutorial-1080p30",
                "width": 1920,
                "height": 1080,
                "fps": 30,
                "bitrateKbps": 6000
            },
            "outputRoles": ["recording", "stream"]
        }))
        .unwrap();
        assert_eq!(
            params.output_roles,
            vec![
                StreamOutputTopologyRole::Recording,
                StreamOutputTopologyRole::Stream
            ]
        );

        let result = StreamOutputTopologyProbeResult {
            capability_key: format!("stream-output-topology-v1:{}", "a".repeat(64)),
            stream_profile: params.stream_profile,
            recording_profile: params.recording_profile,
            output_roles: params.output_roles,
            requested_bridge_output: StreamOutputBridge::WindowsMediaFoundationH264MpegTs,
            effective_bridge_output: StreamOutputBridge::RawYuv420p,
            effective_encode_backend: EncodeBackend::SoftwareOpenH264,
            probe_state: StreamOutputTopologyProbeState::Rejected,
            fallback_reason: Some("hardware profile rejected".to_string()),
            encoder_selection_reason: None,
        };
        let wire = serde_json::to_value(result).unwrap();
        assert_eq!(
            wire["requestedBridgeOutput"],
            "windows-media-foundation-h264-mpegts"
        );
        assert_eq!(wire["effectiveBridgeOutput"], "raw-yuv420p");
        assert_eq!(wire["effectiveEncodeBackend"], "software-open-h264");
        assert_eq!(wire["probeState"], "rejected");
        let serialized = wire.to_string().to_ascii_lowercase();
        for forbidden in [
            "serverurl",
            "streamkey",
            "accesstoken",
            "refreshtoken",
            "oauth",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "topology result exposed forbidden field {forbidden}"
            );
        }

        let rejected =
            serde_json::from_value::<StreamOutputTopologyProbeParams>(serde_json::json!({
                "streamProfile": {
                    "preset": "custom",
                    "width": 1920,
                    "height": 1080,
                    "fps": 30,
                    "bitrateKbps": 6000
                },
                "outputRoles": ["shared"],
                "streamKey": "must-not-enter-the-contract"
            }));
        assert!(
            rejected.is_err(),
            "unknown secret-bearing fields must be rejected"
        );
    }

    #[test]
    fn windows_d3d11_synchronization_timeout_counter_is_stable_on_the_wire() {
        let diagnostics = WindowsD3d11MediaDiagnostics {
            synchronization_timeouts: 3,
            ..Default::default()
        };
        let wire = serde_json::to_value(&diagnostics).unwrap();
        assert_eq!(wire["synchronizationTimeouts"], 3);
        for field in [
            "messagePumpLagP95Ms",
            "messagePumpLagMaxMs",
            "mediaCommandLagP95Ms",
            "mediaCommandLagMaxMs",
        ] {
            assert!(
                wire.get(field).is_none(),
                "unset optional timing field {field} must be omitted rather than serialized as null"
            );
        }

        let legacy: WindowsD3d11MediaDiagnostics = serde_json::from_value(serde_json::json!({
            "state": "unavailable"
        }))
        .unwrap();
        assert_eq!(legacy.synchronization_timeouts, 0);
    }

    #[test]
    fn windows_d3d11_media_stage_timings_are_stable_on_the_wire() {
        // #1042: the media thread's per-stage time, so one stalled moment
        // names the call that blocked.
        let stage = |samples, p95_ms, max_ms| WindowsD3d11StageTimingDiagnostics {
            samples,
            p95_ms,
            max_ms,
        };
        let diagnostics = WindowsD3d11MediaDiagnostics {
            media_stage_timings: Some(WindowsD3d11MediaStageTimingDiagnostics {
                compose: stage(480, 4.5, 101.0),
                device_lock_wait: stage(480, 0.01, 96.5),
                encoder_process_output: stage(470, 1.2, 68.75),
                encoder_queue_wait: stage(470, 9.5, 66.0),
                encoder_dropped_inputs: 2,
                slowest_loop: WindowsD3d11MediaLoopBreakdownDiagnostics {
                    total_ms: 119.0,
                    encoder_submit_ms: 118.5,
                    commands: 3,
                    ..Default::default()
                },
                slowest_compose: WindowsD3d11ComposeBreakdownDiagnostics {
                    total_ms: 101.0,
                    device_lock_wait_ms: 96.5,
                    ..Default::default()
                },
                gpu: Some(WindowsD3d11ComposeGpuTimingDiagnostics {
                    total: stage(470, 3.1, 9.0),
                    completion_latency: stage(470, 20.0, 140.0),
                    disjoint: 1,
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        let wire = serde_json::to_value(&diagnostics).unwrap();
        let timings = &wire["mediaStageTimings"];
        assert_eq!(timings["compose"]["maxMs"], 101.0);
        assert_eq!(timings["deviceLockWait"]["p95Ms"], 0.01);
        assert_eq!(timings["encoderProcessOutput"]["samples"], 470);
        assert_eq!(timings["encoderQueueWait"]["p95Ms"], 9.5);
        assert_eq!(timings["encoderDroppedInputs"], 2);
        assert!(timings["slowestLoop"].get("encoderPollMs").is_none());
        assert_eq!(timings["slowestLoop"]["encoderSubmitMs"], 118.5);
        assert_eq!(timings["slowestCompose"]["deviceLockWaitMs"], 96.5);
        assert_eq!(timings["gpu"]["completionLatency"]["maxMs"], 140.0);
        assert_eq!(timings["gpu"]["disjoint"], 1);
        let decoded: WindowsD3d11MediaDiagnostics = serde_json::from_value(wire).unwrap();
        assert_eq!(decoded, diagnostics);

        let without_gpu = WindowsD3d11MediaDiagnostics {
            media_stage_timings: Some(WindowsD3d11MediaStageTimingDiagnostics::default()),
            ..Default::default()
        };
        let wire = serde_json::to_value(&without_gpu).unwrap();
        assert!(
            wire["mediaStageTimings"].get("gpu").is_none(),
            "a device that refused timestamp queries omits the GPU block"
        );
        let unset = serde_json::to_value(WindowsD3d11MediaDiagnostics::default()).unwrap();
        assert!(unset.get("mediaStageTimings").is_none());
    }

    #[test]
    fn windows_d3d11_capture_route_reason_and_embedded_wgc_cursor_are_stable_on_the_wire() {
        // Issue #906: a hybrid-graphics laptop captures through WGC with the
        // cursor drawn by Windows and names why in the diagnostics.
        let diagnostics = WindowsD3d11MediaDiagnostics {
            state: WindowsD3d11MediaState::Live,
            capture_backend: Some(WindowsD3d11CaptureBackend::WindowsGraphicsCaptureMonitor),
            cursor_mode: Some(WindowsD3d11CursorMode::EmbeddedWgc),
            cursor_requested: true,
            capture_route_reason: Some(
                "d3d11-capture-desktop-duplication-cross-adapter".to_string(),
            ),
            ..Default::default()
        };
        let wire = serde_json::to_value(&diagnostics).unwrap();
        assert_eq!(wire["cursorMode"], "embedded-wgc");
        assert_eq!(
            wire["captureRouteReason"],
            "d3d11-capture-desktop-duplication-cross-adapter"
        );
        assert!(
            wire.get("fallbackReason").is_none(),
            "a named capture route is not a fallback out of the D3D11 path"
        );
        let decoded: WindowsD3d11MediaDiagnostics = serde_json::from_value(wire).unwrap();
        assert_eq!(decoded, diagnostics);

        let requested_backend_opened = WindowsD3d11MediaDiagnostics {
            capture_backend: Some(WindowsD3d11CaptureBackend::DesktopDuplication),
            ..Default::default()
        };
        let wire = serde_json::to_value(&requested_backend_opened).unwrap();
        assert!(
            wire.get("captureRouteReason").is_none(),
            "the route reason is omitted when the requested backend opened"
        );
    }

    #[test]
    fn diagnostic_stats_omit_an_unavailable_compositor_backend_on_the_wire() {
        let diagnostics = crate::diagnostics::idle_diagnostics();
        let wire = serde_json::to_value(diagnostics).unwrap();

        assert!(
            wire.get("compositorBackend").is_none(),
            "optional compositor backend must be omitted rather than serialized as null"
        );
    }

    #[test]
    fn diagnostic_capture_pressure_idle_fixture_omits_unavailable_fields_without_nulls() {
        let wire = serde_json::to_value(crate::diagnostics::idle_diagnostics())
            .expect("idle diagnostics serialize");

        for field in [
            "previewCameraCaptureCallbackAgeMs",
            "previewCameraLatestSequence",
            "previewCameraCapturePixelFormat",
            "previewScreenCaptureCallbackAgeMs",
            "previewScreenLatestSequence",
            "compositorMetalCachedCaptureSourceImportsLiveCount",
            "compositorMetalCachedCaptureSourceImportsPeakCount",
            "compositorMetalCachedCaptureSourceImportsCeiling",
            "compositorMetalTargetRingSlotsLiveCount",
            "compositorMetalTargetRingSlotsPeakCount",
            "compositorMetalTargetRingSlotsCeiling",
            "encoderBridgeMetalTargetRefsInFlightLiveCount",
            "encoderBridgeMetalTargetRefsInFlightPeakCount",
            "encoderBridgeMetalTargetRefsInFlightCeiling",
            "nativePreviewIosurfaceImportLiveCount",
            "nativePreviewIosurfaceImportPeakCount",
            "nativePreviewIosurfaceImportCeiling",
        ] {
            assert!(
                wire.get(field).is_none(),
                "unset optional capture field {field} must be omitted rather than null"
            );
        }
        for field in ["previewCameraSurfaceBacking", "previewScreenSurfaceBacking"] {
            let surface = wire
                .get(field)
                .and_then(serde_json::Value::as_object)
                .unwrap_or_else(|| panic!("required surface diagnostics object {field}"));
            assert!(
                !surface.contains_key("oldestAgeMs"),
                "unset optional {field}.oldestAgeMs must be omitted rather than null"
            );
            assert!(
                surface.values().all(|value| !value.is_null()),
                "required {field} counters must never serialize as null"
            );
        }
    }

    #[test]
    fn capture_pipeline_degraded_stage_is_omitted_when_healthy_and_a_string_when_set() {
        // The serde-null → contract trap (0.9.68, 0.9.79): an Option without
        // skip_serializing_if serializes null, and the renderer contract's
        // optionalSchema rejects null. Healthy pipelines must OMIT the field.
        let wire = serde_json::to_value(crate::diagnostics::idle_diagnostics())
            .expect("idle diagnostics serialize");
        assert!(
            wire.get("capturePipelineDegradedStage").is_none(),
            "healthy capturePipelineDegradedStage must be omitted rather than null"
        );

        let mut degraded = crate::diagnostics::idle_diagnostics();
        degraded.capture_pipeline_degraded_stage = Some("camera-delivery".to_string());
        let wire = serde_json::to_value(degraded).expect("degraded diagnostics serialize");
        assert_eq!(
            wire.get("capturePipelineDegradedStage")
                .and_then(serde_json::Value::as_str),
            Some("camera-delivery")
        );
    }

    #[test]
    fn diagnostic_capture_pressure_maximal_fixture_round_trips_without_nulls() {
        let mut diagnostics = crate::diagnostics::idle_diagnostics();
        diagnostics.compositor_source_capture_texture_reuses = 120;
        diagnostics.compositor_camera_source_capture_texture_reuses = 70;
        diagnostics.compositor_screen_source_capture_texture_reuses = 50;
        diagnostics.compositor_source_texture_cache_flushes = 6;
        diagnostics.preview_camera_capture_callback_count = 1_001;
        diagnostics.preview_camera_did_drop_callback_count = 17;
        diagnostics.preview_camera_frame_store_publications = 984;
        diagnostics.preview_camera_capture_callback_age_ms = Some(12);
        diagnostics.preview_camera_latest_sequence = Some(984);
        diagnostics.preview_camera_capture_pixel_format = Some("BGRA".to_string());
        diagnostics.preview_camera_drop_reasons = PreviewCameraDropReasonStats {
            frame_was_late: 3,
            out_of_buffers: 5,
            discontinuity: 7,
            unknown: 2,
        };
        diagnostics.preview_camera_surface_backing = PreviewSourceSurfaceBackingStats {
            live_count: 2,
            peak_count: 4,
            estimated_bytes: 66_355_200,
            peak_estimated_bytes: 132_710_400,
            oldest_age_ms: Some(42),
        };
        diagnostics.preview_screen_capture_callback_count = 1_010;
        diagnostics.preview_screen_frame_store_publications = 990;
        diagnostics.preview_screen_capture_callback_age_ms = Some(9);
        diagnostics.preview_screen_latest_sequence = Some(990);
        diagnostics.preview_screen_frame_statuses = PreviewScreenFrameStatusStats {
            complete: 990,
            idle: 4,
            blank: 3,
            suspended: 2,
            started: 1,
            stopped: 1,
            unknown: 9,
        };
        diagnostics.preview_screen_surface_backing = PreviewSourceSurfaceBackingStats {
            live_count: 3,
            peak_count: 6,
            estimated_bytes: 99_532_800,
            peak_estimated_bytes: 199_065_600,
            oldest_age_ms: Some(31),
        };

        let wire = serde_json::to_value(&diagnostics).expect("maximal diagnostics serialize");
        for field in [
            "previewCameraCaptureCallbackAgeMs",
            "previewCameraLatestSequence",
            "previewCameraCapturePixelFormat",
            "previewScreenCaptureCallbackAgeMs",
            "previewScreenLatestSequence",
        ] {
            assert_ne!(wire.get(field), Some(&serde_json::Value::Null), "{field}");
        }
        assert_eq!(wire["previewCameraDropReasons"]["outOfBuffers"], 5);
        assert_eq!(wire["previewCameraSurfaceBacking"]["oldestAgeMs"], 42);
        assert_eq!(wire["previewScreenFrameStatuses"]["suspended"], 2);
        assert_eq!(wire["previewScreenSurfaceBacking"]["peakCount"], 6);
        assert_eq!(wire["compositorSourceCaptureTextureReuses"], 120);
        assert_eq!(wire["compositorCameraSourceCaptureTextureReuses"], 70);
        assert_eq!(wire["compositorScreenSourceCaptureTextureReuses"], 50);
        assert_eq!(wire["compositorSourceTextureCacheFlushes"], 6);

        let restored: DiagnosticStats =
            serde_json::from_value(wire).expect("maximal diagnostics deserialize");
        assert_eq!(restored, diagnostics);
    }

    #[test]
    fn windows_d3d11_presenter_media_generation_is_stable_on_the_wire() {
        let diagnostics = WindowsD3d11PresenterDiagnostics {
            media_generation: 41,
            ..Default::default()
        };
        let wire = serde_json::to_value(&diagnostics).unwrap();
        assert_eq!(wire["mediaGeneration"], 41);

        let mut legacy_wire =
            serde_json::to_value(WindowsD3d11PresenterDiagnostics::default()).unwrap();
        legacy_wire
            .as_object_mut()
            .expect("presenter diagnostics serialize as an object")
            .remove("mediaGeneration");
        let legacy: WindowsD3d11PresenterDiagnostics = serde_json::from_value(legacy_wire).unwrap();
        assert_eq!(legacy.media_generation, 0);
    }

    mod system_audio_protocol {
        use super::super::{
            AudioProcessingUpdateParams, AudioSettings, AudioTrack, AudioTrackSource,
            SYSTEM_AUDIO_GAIN_DB_DEFAULT, SYSTEM_AUDIO_GAIN_DB_MAX, SYSTEM_AUDIO_GAIN_DB_MIN,
            clamp_system_audio_gain_db,
        };
        use serde_json::json;

        #[test]
        fn audio_settings_without_system_audio_keys_load_as_off_at_minus_six_db() {
            let legacy: AudioSettings = serde_json::from_value(json!({
                "microphoneGainDb": 3.0,
                "microphoneMuted": false,
                "microphoneSyncOffsetMs": 0
            }))
            .unwrap();
            assert!(!legacy.system_audio_enabled);
            assert_eq!(legacy.system_audio_gain_db, -6.0);
            assert_eq!(legacy.system_audio_gain_db, SYSTEM_AUDIO_GAIN_DB_DEFAULT);
            assert_eq!(legacy.microphone_gain_db, 3.0);

            let empty: AudioSettings = serde_json::from_value(json!({})).unwrap();
            assert_eq!(empty, AudioSettings::default());
            assert!(!empty.system_audio_enabled);
            assert_eq!(empty.system_audio_gain_db, -6.0);
        }

        #[test]
        fn audio_settings_round_trip_explicit_system_audio_values_in_camel_case() {
            let off: AudioSettings = serde_json::from_value(json!({
                "systemAudioEnabled": false,
                "systemAudioGainDb": 4.5
            }))
            .unwrap();
            assert!(!off.system_audio_enabled);
            assert_eq!(off.system_audio_gain_db, 4.5);

            let on = AudioSettings {
                system_audio_enabled: true,
                system_audio_gain_db: -12.0,
                ..AudioSettings::default()
            };
            let wire = serde_json::to_value(&on).unwrap();
            assert_eq!(wire["systemAudioEnabled"], true);
            assert_eq!(wire["systemAudioGainDb"], -12.0);
            let back: AudioSettings = serde_json::from_value(wire).unwrap();
            assert_eq!(back, on);

            // Off is sent explicitly, never dropped.
            let wire_off = serde_json::to_value(AudioSettings::default()).unwrap();
            assert_eq!(wire_off["systemAudioEnabled"], false);
            assert_eq!(wire_off["systemAudioGainDb"], -6.0);
        }

        #[test]
        fn system_audio_gain_clamps_to_the_shared_range() {
            assert_eq!(SYSTEM_AUDIO_GAIN_DB_MIN, -24.0);
            assert_eq!(SYSTEM_AUDIO_GAIN_DB_MAX, 12.0);
            assert_eq!(clamp_system_audio_gain_db(-40.0), -24.0);
            assert_eq!(clamp_system_audio_gain_db(40.0), 12.0);
            assert_eq!(clamp_system_audio_gain_db(-3.5), -3.5);
            assert_eq!(clamp_system_audio_gain_db(f32::NAN), -6.0);
            assert_eq!(clamp_system_audio_gain_db(f32::INFINITY), -6.0);
        }

        #[test]
        fn audio_processing_update_omits_untouched_system_audio_fields() {
            let mic_only: AudioProcessingUpdateParams = serde_json::from_value(json!({
                "sessionId": "session-1",
                "microphoneGainDb": 2.0,
                "microphoneMuted": true
            }))
            .unwrap();
            assert_eq!(mic_only.system_audio_enabled, None);
            assert_eq!(mic_only.system_audio_gain_db, None);
            let wire = serde_json::to_value(&mic_only).unwrap();
            let object = wire.as_object().unwrap();
            assert!(!object.contains_key("systemAudioEnabled"), "{wire}");
            assert!(!object.contains_key("systemAudioGainDb"), "{wire}");

            let toggle: AudioProcessingUpdateParams = serde_json::from_value(json!({
                "sessionId": "session-1",
                "microphoneGainDb": 2.0,
                "microphoneMuted": true,
                "systemAudioEnabled": false,
                "systemAudioGainDb": -9.0
            }))
            .unwrap();
            assert_eq!(toggle.system_audio_enabled, Some(false));
            assert_eq!(toggle.system_audio_gain_db, Some(-9.0));
            let wire = serde_json::to_value(&toggle).unwrap();
            assert_eq!(wire["systemAudioEnabled"], false);
            assert_eq!(wire["systemAudioGainDb"], -9.0);
        }

        #[test]
        fn audio_track_source_system_audio_is_kebab_case_on_the_wire() {
            assert_eq!(
                serde_json::to_value(AudioTrackSource::SystemAudio).unwrap(),
                json!("system-audio")
            );
            assert_eq!(
                serde_json::to_value(AudioTrackSource::TestTone).unwrap(),
                json!("test-tone")
            );
            let parsed: AudioTrackSource = serde_json::from_value(json!("system-audio")).unwrap();
            assert_eq!(parsed, AudioTrackSource::SystemAudio);
        }

        #[test]
        fn audio_track_omits_empty_mix_sources_and_round_trips_a_mixed_track() {
            let mic_only = AudioTrack {
                id: "microphone".to_string(),
                label: "Microphone".to_string(),
                source: AudioTrackSource::Microphone,
                mix_sources: Vec::new(),
            };
            let wire = serde_json::to_value(&mic_only).unwrap();
            assert!(
                !wire.as_object().unwrap().contains_key("mixSources"),
                "an unmixed track keeps the legacy wire shape: {wire}"
            );
            let legacy: AudioTrack = serde_json::from_value(json!({
                "id": "microphone",
                "label": "Microphone",
                "source": "microphone"
            }))
            .unwrap();
            assert_eq!(legacy, mic_only);

            let mixed = AudioTrack {
                mix_sources: vec![AudioTrackSource::Microphone, AudioTrackSource::SystemAudio],
                ..mic_only
            };
            let wire = serde_json::to_value(&mixed).unwrap();
            assert_eq!(wire["id"], "microphone");
            assert_eq!(wire["mixSources"], json!(["microphone", "system-audio"]));
            let back: AudioTrack = serde_json::from_value(wire).unwrap();
            assert_eq!(back, mixed);
        }

        #[test]
        fn diagnostic_stats_omit_absent_system_audio_fields_instead_of_null() {
            let idle = crate::diagnostics::idle_diagnostics();
            let wire = serde_json::to_value(&idle).unwrap();
            let object = wire.as_object().unwrap();
            for key in [
                "systemAudioLiveLevel",
                "systemAudioLivePeakDb",
                "systemAudioCapturedFrames",
                "systemAudioActive",
                "audioMixClippedSamples",
            ] {
                assert!(
                    !object.contains_key(key),
                    "{key} must be omitted, never null (the serde-null trap)"
                );
            }

            let mut live = idle;
            live.system_audio_live_level = Some(0.5);
            live.system_audio_live_peak_db = Some(-12.0);
            live.system_audio_captured_frames = Some(48_000);
            live.system_audio_active = Some(true);
            live.audio_mix_clipped_samples = Some(3);
            let wire = serde_json::to_value(&live).unwrap();
            assert_eq!(wire["systemAudioLiveLevel"], 0.5);
            assert_eq!(wire["systemAudioLivePeakDb"], -12.0);
            assert_eq!(wire["systemAudioCapturedFrames"], 48_000);
            assert_eq!(wire["systemAudioActive"], true);
            assert_eq!(wire["audioMixClippedSamples"], 3);
        }
    }
}
