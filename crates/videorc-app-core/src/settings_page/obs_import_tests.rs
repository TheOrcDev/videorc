//! `lib/obs-import-map.test.ts`, `lib/obs-import-apply.test.ts` and the
//! dialog's states, on the same fixture (`protocol-fixtures/obs/collection.parsed.json`,
//! the backend parser's pinned output).

use serde_json::{Value, json};
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

use super::*;

const PARSED: &str = include_str!("../../../../protocol-fixtures/obs/collection.parsed.json");

/// `formatVideoQualityFull` for the tests (L6's account module answers it in
/// the app).
struct TestQuality;

impl QualityLabel for TestQuality {
    fn video_quality_full(&self, width: u32, height: u32, fps: u32) -> String {
        format!("{width} × {height} · {fps} fps")
    }
}

fn map(setup: &ObsSetup, devices: &[Device], target: Option<&BackgroundTarget>) -> ObsImportPlan {
    map_obs_setup(setup, devices, target, &TestQuality)
}

fn device(kind: DeviceKind, id: &str, name: &str) -> Device {
    let mut device: Device = serde_json::from_value(json!({
        "id": id,
        "name": name,
        "kind": "camera",
        "status": "available",
    }))
    .unwrap();
    device.kind = kind;
    device
}

fn devices() -> Vec<Device> {
    vec![
        device(DeviceKind::Screen, "screen:1", "Display 1"),
        device(
            DeviceKind::Window,
            "window:42",
            "Visual Studio Code: videorc",
        ),
        device(DeviceKind::Camera, "camera:mbp", "MacBook Pro Camera"),
        device(DeviceKind::Microphone, "mic:usb", "USB PnP Audio Device"),
    ]
}

fn setup(sources: Value, scenes: Value) -> ObsSetup {
    serde_json::from_value(json!({
        "collectionName": "Test",
        "canvasWidth": 1920,
        "canvasHeight": 1080,
        "outputWidth": 1920,
        "outputHeight": 1080,
        "fps": 30,
        "sources": sources,
        "scenes": scenes,
        "hasDesktopAudio": false,
    }))
    .unwrap()
}

fn item(name: &str, extra: Value) -> Value {
    let mut item = json!({
        "sourceName": name, "visible": true, "x": 0, "y": 0, "scaleX": 1, "scaleY": 1,
        "boundsType": 0, "boundsX": 0, "boundsY": 0,
        "cropLeft": 0, "cropTop": 0, "cropRight": 0, "cropBottom": 0,
    });
    if let (Some(item), Some(extra)) = (item.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            item.insert(key.clone(), value.clone());
        }
    }
    item
}

fn notes(plan: &ObsImportPlan, verdict: Option<Verdict>) -> Vec<String> {
    plan.report
        .iter()
        .filter(|line| verdict.is_none_or(|verdict| line.verdict == verdict))
        .map(|line| format!("{}: {}", line.subject, line.note))
        .collect()
}

fn display() -> Value {
    json!({"name": "Screen", "kind": "display", "obsKind": "screen_capture"})
}

fn camera() -> Value {
    json!({
        "name": "Cam", "kind": "camera", "obsKind": "av_capture_input",
        "deviceName": "MacBook Pro Camera", "presetWidth": 1920, "presetHeight": 1080,
    })
}

fn screen_scene() -> Value {
    json!([{"name": "S", "current": true, "items": [item("Screen", json!({}))]}])
}

fn with_service(service: Value) -> ObsSetup {
    let mut setup = setup(json!([display()]), screen_scene());
    setup.service = Some(serde_json::from_value(service).unwrap());
    setup
}

#[test]
fn the_real_fixture_maps_every_visible_source_and_the_service() {
    let parsed: Value = serde_json::from_str(PARSED).unwrap();
    let mut setup: ObsSetup = serde_json::from_value(json!({
        "collectionName": parsed["name"],
        "canvasWidth": 3840, "canvasHeight": 2160,
        "outputWidth": 3840, "outputHeight": 2160, "fps": 24,
        "sources": parsed["sources"],
        "scenes": parsed["scenes"],
        "hasDesktopAudio": parsed["hasDesktopAudio"],
        "service": {"type": "rtmp_common", "service": "YouTube - RTMPS", "server": "rtmps://x", "hasKey": true},
    }))
    .unwrap();
    setup.recording_directory = Some(RecordingDirectory {
        path: "/Users/someone/Movies".into(),
        display_name: "Movies".into(),
    });
    let plan = map(&setup, &devices(), None);

    assert_eq!(plan.video, (3840.0, 2160.0, 24.0));
    assert_eq!(
        plan.output_directory
            .as_ref()
            .map(|d| d.display_name.as_str()),
        Some("Movies")
    );
    assert!(["screen-camera", "screen-only", "camera-only"].contains(&plan.layout_preset));
    assert_eq!(
        notes(&plan, Some(Verdict::Imported))[0],
        "Output: 3840 × 2160 · 24 fps"
    );

    let scene = setup
        .scenes
        .iter()
        .find(|scene| scene.current && !scene.items.is_empty())
        .or_else(|| setup.scenes.iter().find(|scene| !scene.items.is_empty()))
        .unwrap();
    let mentioned: String = plan
        .report
        .iter()
        .map(|line| line.subject.clone())
        .collect::<Vec<_>>()
        .join("\n");
    for item in scene.items.iter().filter(|item| item.visible) {
        if setup
            .sources
            .iter()
            .any(|source| source.name == item.source_name)
        {
            assert!(
                mentioned.contains(&item.source_name),
                "{}",
                item.source_name
            );
        }
    }

    assert_eq!(
        plan.stream,
        Some(StreamPlan::RtmpPlatform {
            platform: "youtube",
            service_label: "YouTube - RTMPS".into(),
            server_url: "rtmps://x".into(),
            has_key: true,
        })
    );
    let text = format!("{:?}", plan.report);
    for kind in [
        "av_capture_input",
        "coreaudio",
        "screen_capture",
        "rtmp_common",
    ] {
        assert!(!text.contains(kind), "{kind}");
    }
    assert!(
        notes(&plan, Some(Verdict::Skipped))
            .join("\n")
            .contains("one active scene")
    );
    for line in &plan.report {
        assert!(
            line.note.ends_with('.')
                || line.subject == "Output"
                || line.subject == "Recording folder",
            "{line:?}"
        );
    }
}

#[test]
fn screen_and_camera_take_the_screen_camera_preset_with_a_custom_box() {
    let plan = map(
        &setup(
            json!([display(), camera()]),
            json!([{"name": "Main", "current": true, "items": [
                item("Screen", json!({})),
                item("Cam", json!({"x": 1440, "y": 810, "scaleX": 0.25, "scaleY": 0.25})),
            ]}]),
        ),
        &devices(),
        None,
    );
    assert_eq!(plan.layout_preset, "screen-camera");
    assert_eq!(plan.sources["cameraId"], "camera:mbp");
    let transform = plan.camera_transform.unwrap();
    assert_eq!((transform.x, transform.y), (0.75, 0.75));
    assert!((transform.width - 0.25).abs() < 0.005);
    assert_eq!(plan.sources["screenId"], "screen:1");
}

#[test]
fn a_pipewire_capture_never_claims_a_known_display() {
    let portal =
        json!({"name": "Portal", "kind": "display", "obsKind": "pipewire-screen-capture-source"});
    let setup = setup(
        json!([portal]),
        json!([{"name": "Main", "current": true, "items": [item("Portal", json!({}))]}]),
    );
    let plan = map(&setup, &devices(), None);
    let row = plan
        .report
        .iter()
        .find(|line| line.subject == "Portal")
        .unwrap();
    assert_eq!(row.verdict, Verdict::Approximated);
    assert!(
        row.note
            .starts_with("This OBS source can capture a monitor or a window, so it starts on ")
    );
    let no_screen: Vec<Device> = devices()
        .into_iter()
        .filter(|device| device.kind != DeviceKind::Screen)
        .collect();
    let plan = map(&setup, &no_screen, None);
    let row = plan
        .report
        .iter()
        .find(|line| line.subject == "Portal")
        .unwrap();
    assert_eq!(
        row.note,
        "This OBS source can capture a monitor or a window. Pick one in Sources."
    );
}

#[test]
fn a_portrait_box_is_portrait_and_the_topmost_camera_wins() {
    let plan = map(
        &setup(
            json!([camera()]),
            json!([{"name": "Vertical", "current": true, "items": [
                item("Cam", json!({"boundsType": 2, "boundsX": 607, "boundsY": 1080})),
            ]}]),
        ),
        &devices(),
        None,
    );
    assert_eq!(plan.layout_preset, "camera-only");
    assert_eq!(plan.camera_aspect, Some("portrait"));

    let mut second = camera();
    second["name"] = json!("Cam2");
    second["deviceName"] = json!("Other Cam");
    let plan = map(
        &setup(
            json!([camera(), second]),
            json!([{"name": "S", "current": true, "items": [item("Cam", json!({})), item("Cam2", json!({}))]}]),
        ),
        &devices(),
        None,
    );
    assert!(
        notes(&plan, Some(Verdict::Approximated))
            .join("\n")
            .contains("Cam: Videorc scenes hold one camera")
    );
}

#[test]
fn the_microphone_volume_and_mute_become_gain_and_muted() {
    let mic = json!({
        "name": "Mic", "kind": "microphone", "obsKind": "coreaudio_input_capture",
        "deviceName": "USB PnP Audio Device", "volume": 0.5, "muted": true,
    });
    let plan = map(
        &setup(
            json!([mic]),
            json!([{"name": "S", "current": true, "items": [item("Mic", json!({}))]}]),
        ),
        &devices(),
        None,
    );
    assert_eq!(plan.sources["microphoneId"], "mic:usb");
    assert_eq!(plan.microphone_gain_db, Some(-6.0));
    assert_eq!(plan.microphone_muted, Some(true));
    assert!(
        notes(&plan, Some(Verdict::Approximated))
            .contains(&"Mic level: The OBS volume becomes -6 dB of gain.".to_string())
    );
}

#[test]
fn the_stream_services_land_on_their_cards() {
    let custom = map(
        &with_service(
            json!({"type": "rtmp_custom", "server": "rtmp://my.server/live", "hasKey": true}),
        ),
        &devices(),
        None,
    );
    assert_eq!(
        custom.stream,
        Some(StreamPlan::RtmpCustom {
            server_url: "rtmp://my.server/live".into(),
            has_key: true
        })
    );

    let kick = map(
        &with_service(json!({
            "type": "rtmp_common", "service": "Kick",
            "server": "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app", "hasKey": true,
        })),
        &devices(),
        None,
    );
    assert_eq!(
        kick.stream.as_ref().and_then(StreamPlan::key_platform),
        Some("kick")
    );
    assert!(
        notes(&kick, Some(Verdict::Imported))
            .join("\n")
            .contains("into Kick, set to Stream key")
    );

    let twitch = map(
        &with_service(json!({
            "type": "rtmp_common", "service": "Twitch",
            "server": "rtmps://ingest.global-contribute.live-video.net/app", "hasKey": true,
        })),
        &devices(),
        None,
    );
    assert_eq!(
        twitch.stream,
        Some(StreamPlan::OauthSuggest {
            platform: "twitch",
            service_label: "Twitch".into()
        })
    );

    let facebook = map(
        &with_service(json!({
            "type": "rtmp_common", "service": "Facebook Live",
            "server": "rtmps://rtmp-api.facebook.com:443/rtmp/", "hasKey": true,
        })),
        &devices(),
        None,
    );
    assert_eq!(
        facebook.stream.as_ref().and_then(StreamPlan::key_platform),
        Some("facebook")
    );
    let all = notes(&facebook, None).join("\n");
    assert!(all.contains("into Facebook, set to Stream key"));
    assert!(!all.contains("Connect the account"));

    let custom_facebook = map(
        &with_service(json!({
            "type": "rtmp_custom", "server": "rtmps://live-api-s.facebook.com:443/rtmp/", "hasKey": true,
        })),
        &devices(),
        None,
    );
    assert!(
        notes(&custom_facebook, Some(Verdict::Imported))
            .join("\n")
            .contains("Facebook Live: Imports the server and the stream key into Facebook")
    );
    let lookalike = map(
        &with_service(json!({
            "type": "rtmp_custom", "server": "rtmp://facebook.com.example.net/live", "hasKey": true,
        })),
        &devices(),
        None,
    );
    assert!(matches!(
        lookalike.stream,
        Some(StreamPlan::RtmpCustom { .. })
    ));
}

#[test]
fn unsupported_sources_are_skipped_and_desktop_audio_follows_the_device() {
    let browser = json!({"name": "Chat overlay", "kind": "browser", "obsKind": "browser_source"});
    let plan = map(
        &setup(
            json!([display(), browser]),
            json!([{"name": "S", "current": true, "items": [item("Screen", json!({})), item("Chat overlay", json!({}))]}]),
        ),
        &devices(),
        None,
    );
    let skipped = notes(&plan, Some(Verdict::Skipped)).join("\n");
    assert!(skipped.contains("Chat overlay: Videorc has no browser source"));
    assert!(!skipped.contains("Desktop audio"));
    assert_eq!(plan.system_audio_enabled, None);

    let mut audio = setup(json!([display()]), screen_scene());
    audio.has_desktop_audio = true;
    let system = |status: DeviceStatus| {
        let mut device = device(
            DeviceKind::SystemAudio,
            "system-audio:default",
            "System audio",
        );
        device.status = status;
        device
    };
    let mut on_devices = devices();
    on_devices.push(system(DeviceStatus::Available));
    let on = map(&audio, &on_devices, None);
    assert_eq!(on.system_audio_enabled, Some(true));
    assert!(
        notes(&on, Some(Verdict::Imported))
            .contains(&"Desktop audio: Turns System audio on.".to_string())
    );
    let mut asked = devices();
    asked.push(system(DeviceStatus::PermissionRequired));
    assert!(
        notes(&map(&audio, &asked, None), Some(Verdict::Approximated)).contains(
            &"Desktop audio: Turns System audio on, once Screen Recording is allowed.".to_string()
        )
    );
    let none = map(&audio, &devices(), None);
    assert_eq!(none.system_audio_enabled, None);
    assert!(
        notes(&none, Some(Verdict::Skipped))
            .contains(&"Desktop audio: This computer can't capture system audio.".to_string())
    );
}

fn managed() -> ManagedBackground {
    ManagedBackground::from_files("bg-managed", "BG", "bg-managed.png", "bg-managed.png")
}

fn image_setup(managed_background: Option<ManagedBackground>) -> ObsSetup {
    let mut setup = setup(
        json!([display(), {"name": "BG", "kind": "image", "obsKind": "image_source"}]),
        json!([{"name": "S", "current": true, "items": [item("BG", json!({})), item("Screen", json!({}))]}]),
    );
    setup.sources[1].managed_background = managed_background;
    setup
}

#[test]
fn the_background_line_says_what_the_apply_does() {
    let target = |slot: &str, replaces: Option<&str>| BackgroundTarget {
        slot_id: slot.into(),
        replaces: replaces.map(str::to_string),
    };
    let replace = map(
        &image_setup(Some(managed())),
        &devices(),
        Some(&target("bg-10", Some("Focus"))),
    );
    assert_eq!(replace.background_slot_id.as_deref(), Some("bg-10"));
    assert_eq!(
        replace
            .background_asset
            .as_ref()
            .map(|asset| asset.asset_path.as_str()),
        Some("videorc-asset://background/bg-managed.png")
    );
    assert!(
        notes(&replace, Some(Verdict::Approximated)).contains(
            &"BG: Becomes the scene background, in place of Focus in Assets.".to_string()
        )
    );
    let empty = map(
        &image_setup(Some(managed())),
        &devices(),
        Some(&target("bg-04", None)),
    );
    assert!(
        notes(&empty, Some(Verdict::Approximated))
            .contains(&"BG: Becomes the scene background, in an empty slot in Assets.".to_string())
    );
    let no_slot = map(&image_setup(Some(managed())), &devices(), None);
    assert_eq!(no_slot.background_asset, None);
    assert_eq!(no_slot.background_slot_id, None);
    assert!(
        notes(&no_slot, Some(Verdict::Skipped))
            .contains(&"BG: Assets has no slot for it. Import it from Assets.".to_string())
    );
    let not_copied = map(
        &image_setup(None),
        &devices(),
        Some(&target("bg-10", Some("Focus"))),
    );
    assert_eq!(not_copied.background_slot_id, None);
    assert!(
        notes(&not_copied, Some(Verdict::Skipped))
            .join("\n")
            .contains("BG: The image couldn't be copied.")
    );
}

fn base_config() -> Value {
    json!({
        "sources": {"screenId": "old", "testPattern": true},
        "layout": {"layoutPreset": "screen-only", "cameraTransformMode": "preset"},
        "video": {"width": 1280, "height": 720, "fps": 60, "bitrateKbps": 6000},
        "audio": {"microphoneGainDb": 0},
        "streaming": {
            "targets": [
                {"id": "youtube", "platform": "youtube", "enabled": false, "serverUrl": "", "authMode": "oauth"},
                {"id": "custom", "platform": "custom", "enabled": false, "serverUrl": "", "authMode": "manual-rtmp"},
            ],
            "enabledTargetIds": [],
        },
        "other": {"kept": true},
    })
}

#[test]
fn the_merge_applies_the_plan_and_turns_on_the_named_card_without_the_key() {
    let mut plan = map(
        &with_service(json!({
            "type": "rtmp_common", "service": "YouTube - RTMPS", "server": "rtmps://a.rtmp.youtube.com/live2", "hasKey": true,
        })),
        &devices(),
        None,
    );
    plan.microphone_gain_db = Some(-6.0);
    let mut config = base_config();
    merge_obs_import_into_config(&mut config, &plan, "2026-11-12T00:00:00.000Z");
    assert_eq!(config["sources"]["screenId"], "screen:1");
    assert_eq!(config["sources"]["testPattern"], false);
    assert_eq!(config["layout"]["layoutPreset"], "screen-only");
    assert_eq!(
        config["layout"]["cameraTransformMode"], "preset",
        "no custom box"
    );
    assert_eq!(
        config["video"],
        json!({"width": 1920, "height": 1080, "fps": 30, "bitrateKbps": 6000})
    );
    assert_eq!(config["audio"]["microphoneGainDb"], -6);
    assert_eq!(config["other"], json!({"kept": true}));
    let youtube = &config["streaming"]["targets"][0];
    assert_eq!(youtube["enabled"], true);
    assert_eq!(youtube["serverUrl"], "rtmps://a.rtmp.youtube.com/live2");
    assert_eq!(youtube["authMode"], "manual-rtmp");
    assert!(
        youtube.get("streamKey").is_none(),
        "the key never rides the config"
    );
    assert_eq!(config["streaming"]["targets"][1]["enabled"], false);
    assert_eq!(config["streaming"]["enabledTargetIds"], json!(["youtube"]));
    assert_eq!(key_target_ids(&config, &plan), ["youtube"]);

    let suggest = map(
        &with_service(
            json!({"type": "rtmp_common", "service": "Twitch", "server": "rtmp://x", "hasKey": true}),
        ),
        &devices(),
        None,
    );
    let mut untouched = base_config();
    merge_obs_import_into_config(&mut untouched, &suggest, "now");
    assert_eq!(untouched["streaming"], base_config()["streaming"]);
    assert!(key_target_ids(&untouched, &suggest).is_empty());
}

/// A backgrounds library with three slots, as the Assets registry answers.
#[derive(Debug, Default, PartialEq)]
struct FakeLibrary {
    slots: Vec<(String, Option<String>)>,
    active: Option<String>,
    live: Option<String>,
}

impl BackgroundLibrary for FakeLibrary {
    fn unattended_import_slot(&self) -> Option<BackgroundTarget> {
        let (id, _) = self
            .slots
            .iter()
            .find(|(_, picture)| picture.is_none())
            .or_else(|| self.slots.last())?;
        Some(BackgroundTarget {
            slot_id: id.clone(),
            replaces: None,
        })
    }

    fn import_and_apply(&mut self, slot_id: &str, picture: &ManagedBackground, _now: &str) -> bool {
        let Some(slot) = self.slots.iter_mut().find(|(id, _)| id == slot_id) else {
            return false;
        };
        slot.1 = Some(picture.id.clone());
        self.active = Some(slot_id.to_string());
        self.live = None;
        true
    }
}

#[test]
fn the_background_goes_into_the_slot_the_report_named() {
    let mut library = FakeLibrary {
        slots: vec![("s1".into(), Some("bundled".into())), ("s2".into(), None)],
        active: None,
        live: Some("silk".into()),
    };
    let target = library.unattended_import_slot().unwrap();
    assert_eq!(target.slot_id, "s2");
    let plan = map(&image_setup(Some(managed())), &devices(), Some(&target));
    assert!(with_obs_background(&mut library, &plan, "now"));
    assert_eq!(library.active.as_deref(), Some("s2"));
    assert_eq!(library.live, None);
    assert_eq!(library.slots[1].1.as_deref(), Some("bg-managed"));

    // A plan that promised no background leaves the library alone.
    let mut same = FakeLibrary::default();
    let nothing = map(&image_setup(Some(managed())), &devices(), None);
    assert!(!with_obs_background(&mut same, &nothing, "now"));
    assert_eq!(same, FakeLibrary::default());
    // A slot that is gone too.
    let mut gone = FakeLibrary::default();
    assert!(!with_obs_background(&mut gone, &plan, "now"));
}

#[test]
fn the_dialog_reads_the_current_picks_and_takes_only_the_latest_answer() {
    let mut state = ObsDialogState::default();
    state.opened();
    assert_eq!(obs_dialog_view(&state, None).status, copy::LOOKING);

    let read = state
        .discovered(ObsDiscovery {
            available: true,
            collections: vec!["A".into(), "B".into()],
            profiles: vec!["P".into()],
            current_collection: Some("B".into()),
            current_profile: Some("P".into()),
        })
        .expect("a read starts");
    assert_eq!((read.0.as_str(), read.1.as_str()), ("B", "P"));
    let view = obs_dialog_view(&state, None);
    assert!(view.pickers);
    assert_eq!(view.collection_index, Some(1));
    assert_eq!(view.status, copy::READING);
    assert!(!view.can_import);

    // A pick while the read runs: the old answer no longer counts.
    let next = state.pick(Some("A".into()), None).unwrap();
    assert!(!state.read_answered(read.2, Ok(Some(ObsSetup::default()))));
    assert!(state.read_answered(next.2, Ok(None)));
    let view = obs_dialog_view(&state, None);
    assert_eq!(
        view.read_error,
        "Couldn't read this OBS profile. Its scene collection or profile is missing, or its files are unreadable."
    );

    let again = state.begin_read().unwrap();
    let setup =
        with_service(json!({"type": "rtmp_custom", "server": "rtmp://x/live", "hasKey": false}));
    assert!(state.read_answered(again.2, Ok(Some(setup.clone()))));
    let plan = map(state.setup().unwrap(), &devices(), None);
    let view = obs_dialog_view(&state, Some(&plan));
    assert!(view.can_import);
    assert_eq!(view.groups[0].0, Verdict::Imported);

    state.closed();
    assert!(!state.read_answered(again.2, Ok(Some(setup))));

    let mut missing = ObsDialogState::default();
    missing.opened();
    missing.discovered(ObsDiscovery::default());
    assert_eq!(obs_dialog_view(&missing, None).status, copy::NOT_FOUND);
    let mut failed = ObsDialogState::default();
    failed.opened();
    failed.discovery = DiscoveryState::Failed(copy::NO_ANSWER.into());
    assert_eq!(
        obs_dialog_view(&failed, None).discovery_error,
        "Couldn't look for OBS Studio. No answer came back."
    );
}

/// The dialog's words are still Electron's.
#[test]
fn the_dialogs_words_are_the_renderers() {
    let dialog =
        include_str!("../../../../apps/desktop/src/renderer/src/components/obs-import-dialog.tsx");
    let words = |text: &str| {
        text.replace("&apos;", "'")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let renderer = words(dialog);
    for line in [
        copy::TITLE,
        copy::DESCRIPTION,
        copy::SCENE_COLLECTION,
        copy::PROFILE,
        copy::PICK_COLLECTION,
        copy::PICK_PROFILE,
        copy::LOOKING,
        copy::NOT_FOUND,
        copy::NO_PROFILE,
        copy::PICK_BOTH,
        copy::READING,
        copy::TRY_AGAIN,
        copy::CANCEL,
        copy::IMPORT,
        copy::IMPORTING,
        copy::WILL_IMPORT,
        copy::APPROXIMATED,
        copy::WONT_IMPORT,
        copy::PROFILE_UNREADABLE,
        copy::NO_ANSWER,
        copy::IMPORTED_TITLE,
        copy::IMPORTED_DESCRIPTION,
        "Couldn't look for OBS Studio.",
        "Couldn't read this OBS profile.",
    ] {
        assert!(renderer.contains(&words(line)), "{line}");
    }
}
