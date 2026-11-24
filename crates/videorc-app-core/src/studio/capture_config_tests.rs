//! The renderer's normalizer tests, ported (plan 220 S3.0d): `lib/capture.test.ts`
//! (the load, normalize and persist cases), `layout-framing-memory.test.ts`,
//! `camera-look.test.ts` (the normalizer), `separate-source-recordings.test.ts`
//! (the normalizer) and `scheduled-streams.test.ts` (the stream target's
//! saved event). Each `it(...)` keeps its name.

use super::*;

const NOW: &str = "2026-11-09T10:00:00.000Z";

/// `seedStoredCaptureConfig(raw)` then `loadCaptureConfig()`.
fn load(raw: Value) -> Value {
    load_capture_config(Some(&Value::String(raw.to_string())), NOW)
}

fn audio(value: Value) -> Value {
    normalize_audio_settings(Some(&value))
}

fn layout(value: Value) -> Value {
    normalize_layout_settings(Some(&value))
}

// --- normalizeMicrophoneSyncOffsetMs ---

#[test]
fn preserves_exact_measured_millisecond_offsets_when_the_user_has_set_one() {
    assert_eq!(
        normalize_microphone_sync_offset_ms(Some(&json!(-166)), 0.0),
        -166.0
    );
    assert_eq!(
        audio(json!({"microphoneSyncOffsetMs": -166, "microphoneSyncOffsetUserSet": true}))["microphoneSyncOffsetMs"],
        json!(-166)
    );
}

#[test]
fn applies_the_structural_default_0_until_the_user_sets_an_offset() {
    assert_eq!(
        audio(json!({"microphoneSyncOffsetMs": -750}))["microphoneSyncOffsetMs"],
        json!(0)
    );
    assert_eq!(audio(json!({}))["microphoneSyncOffsetMs"], json!(0));
}

#[test]
fn clamps_to_the_backend_supported_range() {
    assert_eq!(
        normalize_microphone_sync_offset_ms(Some(&json!(-1200)), 0.0),
        -1000.0
    );
    assert_eq!(
        normalize_microphone_sync_offset_ms(Some(&json!(1200)), 0.0),
        1000.0
    );
}

#[test]
fn uses_the_provided_fallback_when_the_value_is_not_numeric() {
    assert_eq!(
        normalize_microphone_sync_offset_ms(Some(&json!("nope")), -120.0),
        -120.0
    );
}

// --- system audio settings (plan 069) ---

#[test]
fn system_audio_defaults_to_off_at_minus_6_db() {
    let defaults = default_capture_config(NOW);
    assert_eq!(defaults["audio"]["systemAudioEnabled"], json!(false));
    assert_eq!(defaults["audio"]["systemAudioGainDb"], json!(-6));
}

#[test]
fn loads_a_config_stored_before_system_audio_existed_as_off_at_minus_6_db() {
    assert_eq!(
        audio(json!({"microphoneGainDb": 4, "microphoneMuted": true, "microphoneSyncOffsetMs": 0})),
        json!({
            "microphoneNoiseSuppression": "off",
            "microphoneGainDb": 4,
            "microphoneMuted": true,
            "microphoneSyncOffsetMs": 0,
            "microphoneSyncOffsetUserSet": false,
            "systemAudioEnabled": false,
            "systemAudioGainDb": -6,
            "systemAudioEchoGuard": true
        })
    );
    assert_eq!(
        normalize_audio_settings(None)["systemAudioEnabled"],
        json!(false)
    );
    assert_eq!(
        audio(json!({"systemAudioEchoGuard": false}))["systemAudioEchoGuard"],
        json!(false)
    );
    assert_eq!(audio(Value::Null)["systemAudioGainDb"], json!(-6));
}

#[test]
fn treats_anything_but_an_explicit_true_as_off() {
    assert_eq!(
        audio(json!({"systemAudioEnabled": true}))["systemAudioEnabled"],
        json!(true)
    );
    assert_eq!(
        audio(json!({"systemAudioEnabled": false}))["systemAudioEnabled"],
        json!(false)
    );
    for junk in [json!("true"), json!(1), Value::Null, json!({})] {
        assert_eq!(
            audio(json!({"systemAudioEnabled": junk}))["systemAudioEnabled"],
            json!(false)
        );
    }
}

#[test]
fn clamps_the_level_to_minus_24_plus_12_db_and_falls_back_to_minus_6_for_junk() {
    assert_eq!(
        audio(json!({"systemAudioGainDb": -3}))["systemAudioGainDb"],
        json!(-3)
    );
    assert_eq!(
        audio(json!({"systemAudioGainDb": -60}))["systemAudioGainDb"],
        json!(-24)
    );
    assert_eq!(
        audio(json!({"systemAudioGainDb": 40}))["systemAudioGainDb"],
        json!(12)
    );
    // NaN and ±Infinity have no JSON form; `'0'`, `null` and `true` do.
    for junk in [json!("0"), Value::Null, json!(true)] {
        assert_eq!(normalize_system_audio_gain_db(Some(&junk)), -6.0);
    }
    assert_eq!(normalize_system_audio_gain_db(None), -6.0);
}

#[test]
fn reads_a_stored_config_without_system_audio_keys_as_off() {
    let loaded = load(json!({"audio": {"microphoneGainDb": 2, "microphoneMuted": false}}));
    assert_eq!(loaded["audio"]["microphoneGainDb"], json!(2));
    assert_eq!(loaded["audio"]["systemAudioEnabled"], json!(false));
    assert_eq!(loaded["audio"]["systemAudioGainDb"], json!(-6));
}

// --- videoPresets ---

#[test]
fn includes_first_class_4k_recording_and_platform_safe_streaming_presets() {
    assert_eq!(
        video_preset("record-4k60-experimental").unwrap(),
        json!({"preset": "record-4k60-experimental", "width": 3840, "height": 2160, "fps": 60, "bitrateKbps": 50000})
    );
    assert_eq!(
        video_preset("stream-youtube-1080p60").unwrap(),
        json!({"preset": "stream-youtube-1080p60", "width": 1920, "height": 1080, "fps": 60, "bitrateKbps": 12000})
    );
    assert_eq!(
        video_preset("stream-safe-1080p60").unwrap()["bitrateKbps"],
        json!(6000)
    );
}

#[test]
fn normalizes_persisted_first_class_presets_through_the_shared_map() {
    for preset in ["record-4k30", "stream-safe-1080p30", "stream-youtube-4k30"] {
        assert_eq!(
            normalize_video_settings(Some(&json!({"preset": preset}))),
            video_preset(preset).unwrap()
        );
    }
    assert_eq!(
        normalize_video_settings(Some(&json!({
            "preset": "stream-youtube-1080p60", "width": 1280, "height": 720, "fps": 24, "bitrateKbps": 1000
        }))),
        video_preset("stream-youtube-1080p60").unwrap()
    );
    let streaming = normalize_streaming_settings(
        Some(&json!({
            "defaultOutputPreset": "stream-youtube-1080p30",
            "defaultBitrateKbps": 1234,
            "targets": [{
                "id": "youtube", "platform": "youtube",
                "outputPreset": "stream-youtube-1080p60", "outputBitrateKbps": 2345
            }]
        })),
        NOW,
    );
    assert_eq!(
        streaming["defaultOutputPreset"],
        json!("stream-youtube-1080p30")
    );
    assert_eq!(streaming["defaultBitrateKbps"], json!(10000));
    assert_eq!(streaming["targets"][0]["platform"], json!("youtube"));
    assert_eq!(
        streaming["targets"][0]["outputPreset"],
        json!("stream-youtube-1080p60")
    );
    assert_eq!(streaming["targets"][0]["outputBitrateKbps"], json!(12000));
}

// --- persistable capture settings ---

#[test]
fn keeps_live_microphone_gain_and_mute_as_next_session_defaults() {
    let mut config = default_capture_config(NOW);
    set_path(&mut config, &["audio", "microphoneGainDb"], Some(json!(6)));
    set_path(
        &mut config,
        &["audio", "microphoneMuted"],
        Some(json!(true)),
    );
    let persisted = persistable_capture_config(&config);
    assert_eq!(persisted["audio"]["microphoneGainDb"], json!(6));
    assert_eq!(persisted["audio"]["microphoneMuted"], json!(true));
}

// --- legacy stream key migration (the persistence cases) ---

#[test]
fn clears_plaintext_keys_from_persisted_config_after_backend_store_succeeds() {
    // `applyStoredManualStreamKeyResult` leaves the YouTube card with a
    // secret reference and an empty key, and the legacy top-level key empty.
    let mut config = default_capture_config(NOW);
    config["rtmpPreset"] = json!("youtube");
    config["streamKey"] = json!("");
    config["streaming"]["enabled"] = json!(true);
    let youtube = &mut config["streaming"]["targets"][0];
    youtube["enabled"] = json!(true);
    youtube["streamKey"] = json!("fixture-legacy-key");
    youtube["streamKeySecretRef"] = json!("stream-target:youtube:manual-stream-key");
    youtube["streamKeyPresent"] = json!(true);
    let persisted = persistable_capture_config(&config);
    assert_eq!(persisted["streaming"]["targets"][0]["streamKey"], json!(""));
    assert_eq!(
        persisted["streaming"]["targets"][0]["streamKeyPresent"],
        json!(true)
    );
    assert_eq!(persisted["streamKey"], json!(""));
    assert!(!persisted.to_string().contains("fixture-legacy-key"));
}

#[test]
fn does_not_persist_the_dev_synthetic_diagnostic_source() {
    let mut config = default_capture_config(NOW);
    config["sources"] = json!({
        "screenId": "screen:screencapturekit:1", "screenName": "Display 1", "testPattern": true
    });
    let persisted = persistable_capture_config(&config);
    assert_eq!(
        persisted["sources"]["screenId"],
        json!("screen:screencapturekit:1")
    );
    assert_eq!(persisted["sources"]["screenName"], json!("Display 1"));
    assert!(persisted["sources"].get("testPattern").is_none());
}

#[test]
fn heals_old_persisted_configs_that_still_contain_the_synthetic_diagnostic_source() {
    let loaded = load(json!({"sources": {
        "screenId": "screen:screencapturekit:1", "screenName": "Display 1", "testPattern": true
    }}));
    assert_eq!(
        loaded["sources"],
        json!({"screenId": "screen:screencapturekit:1", "screenName": "Display 1", "testPattern": false})
    );
}

#[test]
fn keeps_per_mode_scene_memory_across_reloads_and_heals_cross_class_values() {
    let loaded = load(
        json!({"lastHorizontalPreset": "side-by-side", "lastVerticalPreset": "vertical-split"}),
    );
    assert_eq!(loaded["lastHorizontalPreset"], json!("side-by-side"));
    assert_eq!(loaded["lastVerticalPreset"], json!("vertical-split"));
    let healed =
        load(json!({"lastHorizontalPreset": "vertical-split", "lastVerticalPreset": "diagonal"}));
    assert_eq!(healed["lastHorizontalPreset"], json!("screen-camera"));
    assert_eq!(healed["lastVerticalPreset"], json!("vertical-camera-top"));
}

// --- normalizeCaptionsCaptureSettings ---

fn captions(value: Option<Value>) -> Value {
    normalize_captions_capture_settings(value.as_ref())
}

#[test]
fn defaults_validates_and_reads_two_outputs_from_any_saved_target() {
    let with = |burn: &str, style: &str, position: &str, size: &str| {
        json!({
            "enabled": false, "burnTarget": burn, "styleId": style, "language": "auto",
            "styleRevision": 0, "position": position, "textSize": size
        })
    };
    assert_eq!(captions(None), with("stream", "classic", "bottom", "m"));
    // #1593: the pre-R1 boolean, `off` and garbage are the stream only.
    assert_eq!(
        captions(Some(json!({"burnInEnabled": true}))),
        with("stream", "glass", "bottom", "m")
    );
    assert_eq!(
        captions(Some(json!({"burnInEnabled": false}))),
        with("stream", "glass", "bottom", "m")
    );
    assert_eq!(
        captions(Some(json!({"burnTarget": "off"}))),
        with("stream", "glass", "bottom", "m")
    );
    assert_eq!(
        captions(Some(json!({"burnTarget": "sideways"}))),
        with("stream", "glass", "bottom", "m")
    );
    // The retired `recording` burns into both, as `both` does.
    assert_eq!(
        captions(Some(json!({
            "burnTarget": "recording", "burnInEnabled": true, "position": "top", "textSize": "l"
        }))),
        with("both", "glass", "top", "l")
    );
    // Idempotent: a loaded value loads to itself.
    let loaded = captions(Some(json!({"burnTarget": "recording"})));
    assert_eq!(captions(Some(loaded.clone())), loaded);
}

#[test]
fn keeps_valid_consent_language_style_and_monotonic_revision_values() {
    assert_eq!(
        captions(Some(json!({
            "enabled": true, "burnTarget": "both", "styleId": "high-contrast",
            "language": " es ", "styleRevision": 7, "position": "top", "textSize": "s"
        }))),
        json!({
            "enabled": true, "burnTarget": "both", "styleId": "high-contrast", "language": "es",
            "styleRevision": 7, "position": "top", "textSize": "s"
        })
    );
}

// --- freeform arrangement (plan phase 4) ---

#[test]
fn defaults_legacy_layouts_to_the_preset_arrangement_with_no_overrides() {
    let normalized = layout(json!({
        "layoutPreset": "screen-camera", "cameraCorner": "bottom-right",
        "cameraSize": "medium", "cameraShape": "rectangle", "cameraMargin": 32
    }));
    assert_eq!(normalized["arrangementMode"], json!("preset"));
    assert_eq!(normalized["sourceTransformOverrides"], json!({}));
}

#[test]
fn keeps_freeform_and_its_well_formed_overrides_across_a_persistence_round_trip() {
    let mut config = default_capture_config(NOW);
    config["layout"]["arrangementMode"] = json!("freeform");
    config["layout"]["sourceTransformOverrides"] = json!({
        "source:base": {"x": 0.05, "y": 0.1, "width": 0.6, "height": 0.6},
        "source:camera": {"x": 0.7, "y": 0.2, "width": 0.25, "height": 0.5}
    });
    let persisted = persistable_capture_config(&config);
    let text = serde_json::to_string(&persisted).unwrap();
    let reparsed: Value = serde_json::from_str(&text).unwrap();
    let normalized = normalize_layout_settings(reparsed.get("layout"));
    assert_eq!(normalized["arrangementMode"], json!("freeform"));
    assert_eq!(
        normalized["sourceTransformOverrides"],
        json!({
            "source:base": {"x": 0.05, "y": 0.1, "width": 0.6, "height": 0.6},
            "source:camera": {"x": 0.7, "y": 0.2, "width": 0.25, "height": 0.5}
        })
    );
}

#[test]
fn drops_malformed_overrides_instead_of_poisoning_the_scene_commit() {
    let normalized = layout(json!({
        "arrangementMode": "freeform",
        "sourceTransformOverrides": {
            "source:base": {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5},
            "source:camera": {"x": "wide", "y": 0.2, "width": 0.25},
            "": {"x": 0, "y": 0, "width": 1, "height": 1}
        }
    }));
    assert_eq!(
        normalized["sourceTransformOverrides"],
        json!({"source:base": {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5}})
    );
}

#[test]
fn keeps_a_screens_crop_on_its_box_and_clamps_it_like_the_backend() {
    let normalized = layout(json!({
        "arrangementMode": "freeform",
        "sourceTransformOverrides": {"source:base": {
            "x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5,
            "cropLeft": 0.25, "cropTop": 0, "cropRight": 1.5, "cropBottom": "lots"
        }}
    }));
    assert_eq!(
        normalized["sourceTransformOverrides"],
        json!({"source:base": {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5, "cropLeft": 0.25, "cropRight": 0.95}})
    );
}

#[test]
fn reads_the_landscape_screen_framing_fit_unless_fill_was_chosen() {
    assert_eq!(layout(json!({}))["horizontalScreenFraming"], json!("fit"));
    assert_eq!(
        layout(json!({"horizontalScreenFraming": "fill"}))["horizontalScreenFraming"],
        json!("fill")
    );
    assert_eq!(
        layout(json!({"horizontalScreenFraming": "stretch"}))["horizontalScreenFraming"],
        json!("fit")
    );
}

#[test]
fn rejects_junk_arrangement_modes_back_to_preset() {
    assert_eq!(
        layout(json!({"arrangementMode": "chaotic"}))["arrangementMode"],
        json!("preset")
    );
    assert_eq!(
        layout(json!({"sourceTransformOverrides": ["nope"]}))["sourceTransformOverrides"],
        json!({})
    );
}

// --- camera shape and aspect (2026-07-06) ---

#[test]
fn defaults_new_fields_for_configs_persisted_before_they_existed() {
    let normalized = layout(json!({
        "layoutPreset": "screen-camera", "cameraCorner": "bottom-right",
        "cameraSize": "medium", "cameraShape": "rectangle", "cameraMargin": 32
    }));
    assert_eq!(normalized["cameraCornerRadiusPct"], json!(12));
    assert_eq!(normalized["cameraAspect"], json!("source"));
}

#[test]
fn keeps_valid_persisted_values_and_clamps_the_radius() {
    let normalized = layout(json!({
        "layoutPreset": "screen-camera", "cameraShape": "rounded",
        "cameraCornerRadiusPct": 900, "cameraAspect": "portrait"
    }));
    assert_eq!(normalized["cameraShape"], json!("rounded"));
    assert_eq!(normalized["cameraCornerRadiusPct"], json!(50));
    assert_eq!(normalized["cameraAspect"], json!("portrait"));
}

#[test]
fn rejects_junk_shape_aspect_values_back_to_defaults() {
    let normalized = layout(json!({"cameraShape": "triangle", "cameraAspect": "ultrawide"}));
    assert_eq!(normalized["cameraShape"], json!("rectangle"));
    assert_eq!(normalized["cameraAspect"], json!("source"));
}

#[test]
fn migrates_the_dev_era_vertical_preset_to_its_renamed_variant() {
    assert_eq!(
        layout(json!({"layoutPreset": "vertical"}))["layoutPreset"],
        json!("vertical-camera-top")
    );
    assert_eq!(
        layout(json!({"layoutPreset": "diagonal"}))["layoutPreset"],
        json!("screen-camera")
    );
}

// --- canvas orientation lock ---

#[test]
fn transposes_a_landscape_canvas_entering_a_vertical_scene_and_marks_it_custom() {
    let landscape = video_preset("tutorial-1440p30").unwrap();
    assert_eq!(
        coerce_video_to_orientation(&landscape, true),
        json!({"preset": "custom", "width": 1440, "height": 2560, "fps": 30, "bitrateKbps": 8000})
    );
}

#[test]
fn transposes_a_portrait_canvas_under_a_horizontal_scene() {
    let portrait = video_preset("vertical-1080x1920").unwrap();
    assert_eq!(
        coerce_video_to_orientation(&portrait, false),
        json!({"preset": "custom", "width": 1920, "height": 1080, "fps": 30, "bitrateKbps": 9000})
    );
}

#[test]
fn keeps_a_matching_canvas_untouched_preset_included() {
    let landscape = video_preset("tutorial-1440p30").unwrap();
    assert_eq!(coerce_video_to_orientation(&landscape, false), landscape);
    let portrait = video_preset("vertical-1080x1920").unwrap();
    assert_eq!(coerce_video_to_orientation(&portrait, true), portrait);
    let square =
        json!({"preset": "custom", "width": 1080, "height": 1080, "fps": 30, "bitrateKbps": 8000});
    assert_eq!(coerce_video_to_orientation(&square, true), square);
    assert_eq!(coerce_video_to_orientation(&square, false), square);
}

#[test]
fn normalizes_a_persisted_landscape_canvas_under_a_vertical_scene_on_load() {
    let loaded = load(json!({
        "layout": {"layoutPreset": "vertical-split"},
        "video": {"preset": "custom", "width": 2560, "height": 1440, "fps": 30, "bitrateKbps": 8000}
    }));
    assert_eq!(loaded["video"]["preset"], json!("custom"));
    assert_eq!(loaded["video"]["width"], json!(1440));
    assert_eq!(loaded["video"]["height"], json!(2560));
    let restored = load(json!({
        "layout": {"layoutPreset": "vertical-split"},
        "video": {"preset": "custom", "width": 1080, "height": 1920, "fps": 30, "bitrateKbps": 9000},
        "verticalRestoreVideo": {"preset": "custom", "width": 1080, "height": 1920, "fps": 30, "bitrateKbps": 9000}
    }));
    assert_eq!(restored["verticalRestoreVideo"]["width"], json!(1920));
    assert_eq!(restored["verticalRestoreVideo"]["height"], json!(1080));
}

// --- microphone noise suppression settings ---

#[test]
fn keeps_old_and_invalid_settings_off_and_preserves_explicit_rnnoise() {
    for value in [
        None,
        Some(Value::Null),
        Some(json!({})),
        Some(json!({"microphoneNoiseSuppression": true})),
        Some(json!({"microphoneNoiseSuppression": "other"})),
    ] {
        assert_eq!(
            normalize_audio_settings(value.as_ref())["microphoneNoiseSuppression"],
            json!("off")
        );
    }
    assert_eq!(
        audio(json!({"microphoneNoiseSuppression": "rnnoise"}))["microphoneNoiseSuppression"],
        json!("rnnoise")
    );
}

// --- layout-framing-memory.test.ts ---

#[test]
fn migrates_only_the_current_layout_and_defaults_every_other_canonical_layout() {
    let mut current = default_layout();
    current["cameraZoom"] = json!(150);
    current["cameraOffsetX"] = json!(-25);
    current["cameraOffsetY"] = json!(30);
    let memory = normalize_layout_framing_memory(Some(&Value::Null), Some(&current));
    assert_eq!(
        memory["layouts"]["screen-camera"],
        json!({"cameraZoom": 150, "cameraOffsetX": -25, "cameraOffsetY": 30})
    );
    for id in HORIZONTAL_LAYOUT_PRESETS
        .iter()
        .chain(VERTICAL_LAYOUT_PRESETS.iter())
    {
        if *id != "screen-camera" {
            assert_eq!(
                memory["layouts"][id],
                json!({"cameraZoom": 100, "cameraOffsetX": 0, "cameraOffsetY": 0})
            );
        }
    }
    assert_eq!(memory["layouts"].as_object().unwrap().len(), 10);
    assert_eq!(
        normalize_layout_framing_memory(Some(&memory), Some(&current)),
        memory
    );
}

#[test]
fn clamps_malformed_storage_without_sharing_framing_objects_between_layouts() {
    // NaN has no JSON form; a string stands in for "not a finite number".
    let memory = normalize_layout_framing_memory(
        Some(&json!({"version": 1, "layouts": {
            "camera-only": {"cameraZoom": 400, "cameraOffsetX": "NaN", "cameraOffsetY": -500}
        }})),
        None,
    );
    assert_eq!(
        memory["layouts"]["camera-only"],
        json!({"cameraZoom": 200, "cameraOffsetX": 0, "cameraOffsetY": -100})
    );
    assert_eq!(
        memory["layouts"]["vertical-screen-only"]["cameraZoom"],
        json!(100)
    );
}

// --- camera-look.test.ts ---

#[test]
fn loads_older_settings_as_neutral_and_bounds_stored_values() {
    assert_eq!(normalize_camera_look(None), None);
    assert_eq!(normalize_camera_look(Some(&json!({}))), None);
    // Infinity has no JSON form; a string is not a finite number either.
    assert_eq!(
        normalize_camera_look(Some(
            &json!({"brightness": "Infinity", "contrast": 0, "saturation": 3})
        )),
        Some(json!({"brightness": 0, "contrast": 0.5, "saturation": 2}))
    );
    // A stored look on the layout comes back only when it is not neutral,
    // and the writer leaves it out (the look lives in the settings).
    let with_look =
        layout(json!({"cameraLook": {"brightness": 0.05, "contrast": 1.1, "saturation": 0.8}}));
    assert_eq!(with_look["cameraLook"]["contrast"], json!(1.1));
    assert!(
        layout(json!({"cameraLook": {}}))
            .get("cameraLook")
            .is_none()
    );
    let mut config = default_capture_config(NOW);
    config["layout"] = with_look;
    assert!(
        persistable_capture_config(&config)["layout"]
            .get("cameraLook")
            .is_none()
    );
}

#[test]
fn a_layout_keeps_a_background_that_is_on_and_edges_that_hide_something() {
    // Plan 258 S1: Off is no background; anything else comes back bounded.
    assert!(
        layout(json!({"cameraBackground": {"mode": "off", "blurPct": 30}}))
            .get("cameraBackground")
            .is_none()
    );
    assert!(
        layout(json!({"cameraBackground": {"mode": "sparkle"}}))
            .get("cameraBackground")
            .is_none()
    );
    let blurred = layout(json!({"cameraBackground": {"mode": "blur", "blurPct": 30}}));
    assert_eq!(
        blurred["cameraBackground"],
        json!({"mode": "blur", "blurPct": 30, "edges": "balanced"})
    );
    // Plan 227 B: whole percents in 0-25, and none when nothing is hidden.
    assert!(
        layout(json!({"cameraChromaKeyEdges": {"leftPct": 0, "topPct": 0}}))
            .get("cameraChromaKeyEdges")
            .is_none()
    );
    assert_eq!(
        layout(json!({"cameraChromaKeyEdges": {"leftPct": 40, "rightPct": 3.6}}))["cameraChromaKeyEdges"],
        json!({"leftPct": 25, "topPct": 0, "rightPct": 4, "bottomPct": 0})
    );
    // The writer leaves the background out (it lives in the settings), and
    // keeps the edges (they are the scene's).
    let mut config = default_capture_config(NOW);
    config["layout"] = layout(json!({
        "cameraBackground": {"mode": "blur"},
        "cameraChromaKeyEdges": {"leftPct": 5}
    }));
    let persisted = persistable_capture_config(&config);
    assert!(persisted["layout"].get("cameraBackground").is_none());
    assert_eq!(
        persisted["layout"]["cameraChromaKeyEdges"]["leftPct"],
        json!(5)
    );
}

// --- separate-source-recordings.test.ts ---

#[test]
fn normalizes_the_separate_source_recordings_setting() {
    let off = json!({"enabled": false, "keepCombined": true});
    let on = json!({"enabled": true, "keepCombined": true});
    assert_eq!(normalize_separate_source_recordings(None), off);
    assert_eq!(
        normalize_separate_source_recordings(Some(&json!({"enabled": true}))),
        on
    );
    assert_eq!(
        normalize_separate_source_recordings(Some(&json!({"enabled": "yes", "keepCombined": 0}))),
        off
    );
    assert_eq!(
        normalize_separate_source_recordings(Some(
            &json!({"enabled": true, "keepCombined": false})
        )),
        on
    );
}

#[test]
fn loads_a_stored_config_without_the_key_as_off() {
    assert_eq!(
        load(json!({"recordEnabled": true}))["separateSourceRecordings"],
        json!({"enabled": false, "keepCombined": true})
    );
}

// --- scheduled-streams.test.ts ---

const EVENT_ID: &str = "11111111-1111-4111-8111-111111111111";

fn scheduled_target() -> Value {
    json!({
        "id": "youtube", "platform": "youtube", "label": "Channel", "authMode": "oauth",
        "enabled": true, "accountId": "channel", "scheduledEventId": EVENT_ID,
        "scheduledAttemptId": EVENT_ID, "scheduledEventTitle": "Saved title",
        "streamKey": "", "streamKeyPresent": true, "streamKeySecretRef": "event-secret-ref",
        "serverUrl": "rtmp://example/live", "platformBroadcastId": "event",
        "platformStreamId": "ingest", "createdAt": "", "updatedAt": ""
    })
}

fn youtube_of(streaming: &Value) -> Value {
    streaming["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["id"] == "youtube")
        .cloned()
        .unwrap()
}

#[test]
fn preserves_the_selected_event_across_normalization() {
    let normalized = youtube_of(&normalize_streaming_settings(
        Some(&json!({"targets": [scheduled_target()]})),
        NOW,
    ));
    assert_eq!(normalized["scheduledEventId"], json!(EVENT_ID));
    assert_eq!(normalized["scheduledAttemptId"], json!(EVENT_ID));
    assert_eq!(normalized["scheduledEventTitle"], json!("Saved title"));
    assert_eq!(normalized["status"], json!({"state": "not-configured"}));
}

#[test]
fn rejects_malformed_persisted_selection_fields_before_rendering() {
    let mut target = scheduled_target();
    target["scheduledEventTitle"] = json!({});
    target["scheduledStartUtc"] = json!({});
    target["scheduledPrivacy"] = json!({});
    target["scheduledAttemptId"] = json!("not-a-uuid");
    let normalized = youtube_of(&normalize_streaming_settings(
        Some(&json!({"targets": [target]})),
        NOW,
    ));
    for gone in [
        "scheduledEventTitle",
        "scheduledStartUtc",
        "scheduledPrivacy",
        "scheduledAttemptId",
    ] {
        assert!(normalized.get(gone).is_none(), "{gone}");
    }
    let mut malformed = scheduled_target();
    malformed["scheduledEventId"] = json!("-".repeat(36));
    let normalized = youtube_of(&normalize_streaming_settings(
        Some(&json!({"targets": [malformed]})),
        NOW,
    ));
    assert!(normalized.get("scheduledEventId").is_none());
    assert!(normalized.get("scheduledEventTitle").is_none());
}

// --- beyond the renderer's own cases: the loader's composition ---

#[test]
fn a_missing_or_unreadable_config_is_the_defaults_and_unknown_fields_survive() {
    let defaults = default_capture_config(NOW);
    let mut expected = defaults.clone();
    expected["sources"]["testPattern"] = json!(false);
    assert_eq!(load_capture_config(None, NOW), expected);
    assert_eq!(load_capture_config(Some(&json!("")), NOW), expected);
    assert_eq!(load_capture_config(Some(&json!("not json")), NOW), expected);
    let loaded = load(json!({
        "futureTopLevel": {"a": 1},
        "sources": {"windowName": "Terminal", "screenId": "screen:1"},
        "layout": {"futureLayoutField": true, "cameraSize": "large"},
        "audio": {"futureAudioField": 1}
    }));
    assert_eq!(loaded["futureTopLevel"], json!({"a": 1}));
    assert_eq!(loaded["sources"]["windowName"], json!("Terminal"));
    assert_eq!(loaded["layout"]["futureLayoutField"], json!(true));
    assert_eq!(loaded["layout"]["cameraSize"], json!("large"));
    // `normalizeAudioSettings` builds a fresh object: unknown audio fields go.
    assert!(loaded["audio"].get("futureAudioField").is_none());
}

#[test]
fn a_legacy_single_rtmp_config_moves_its_key_into_its_platform_card_only() {
    let loaded = load(json!({
        "streaming": null,
        "rtmpPreset": "twitch",
        "rtmpServerUrl": " rtmp://live.twitch.tv/custom ",
        "streamKey": "legacy",
        "streamEnabled": true
    }));
    let twitch = loaded["streaming"]["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["id"] == "twitch")
        .unwrap();
    assert_eq!(twitch["serverUrl"], json!("rtmp://live.twitch.tv/custom"));
    assert_eq!(twitch["streamKey"], json!("legacy"));
    assert_eq!(twitch["enabled"], json!(true));
    assert_eq!(loaded["streaming"]["enabledTargetIds"], json!(["twitch"]));
    assert_eq!(youtube_of(&loaded["streaming"])["streamKey"], json!(""));
    // Without an explicit `streaming`, `loadJson` puts the default object in
    // its place, so the legacy fields are not migrated (as in the renderer).
    let defaults_streaming = load(json!({"rtmpPreset": "twitch", "streamKey": "legacy"}));
    assert_eq!(
        defaults_streaming["streaming"]["enabledTargetIds"],
        json!([])
    );
}

#[test]
fn the_writer_folds_stand_ins_and_drops_credentials_a_card_cannot_use() {
    let mut config = load(json!({}));
    config["sources"] = json!({
        "screenId": "screen:standin", "screenName": "Stand-in",
        "wantedScreenId": "screen:wanted", "wantedScreenName": "Wanted",
        "cameraId": "camera:standin", "wantedCameraId": "camera:wanted",
        "testPattern": true
    });
    let facebook = config["streaming"]["targets"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|target| target["id"] == "facebook")
        .unwrap();
    facebook["authMode"] = json!("oauth");
    facebook["accountId"] = json!("page");
    facebook["streamKey"] = json!("k");
    let persisted = persistable_capture_config(&config);
    assert_eq!(
        persisted["sources"],
        json!({"screenId": "screen:wanted", "screenName": "Wanted", "cameraId": "camera:wanted"})
    );
    let facebook = persisted["streaming"]["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["id"] == "facebook")
        .unwrap();
    assert_eq!(facebook["authMode"], json!("manual-rtmp"));
    assert_eq!(facebook["streamKey"], json!(""));
    assert!(facebook.get("accountId").is_none());
}

#[test]
fn the_typed_view_reads_every_section_and_names_what_does_not_fit() {
    let loaded = load(json!({
        "sources": {"screenId": "screen:1"},
        "video": {"preset": "custom", "width": 640, "height": 360, "fps": 30, "bitrateKbps": 2000},
        "rtmpPreset": "twitch"
    }));
    let view = CaptureConfigView::from_loaded(&loaded);
    assert!(view.issues.is_empty(), "{:?}", view.issues);
    assert_eq!(view.config.sources.screen_id.as_deref(), Some("screen:1"));
    assert_eq!(view.config.video.width, 640);
    assert!(view.config.streaming.is_some());
    assert_eq!(view.config.rtmp_preset.as_deref(), Some("twitch"));
    assert!(matches!(view.config.rtmp().preset, RtmpPreset::Twitch));
    assert!(view.config.rest.contains_key("layoutFramingMemory"));
    // The previous release's layout carried a numeric camera size, which the
    // renderer passes through; the typed layout reads as its default.
    let odd = load(json!({"layout": {"cameraSize": 0.25}}));
    let view = CaptureConfigView::from_loaded(&odd);
    assert_eq!(view.issues.len(), 1, "{:?}", view.issues);
    assert!(view.issues[0].contains("layout"));
    assert_eq!(view.config.layout, default_layout_settings());
}
