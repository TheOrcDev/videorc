use super::*;
use crate::test_temp_dir::TestTempDir;

// The fixture is a scrubbed copy of a real OBS collection (multi-scene,
// multi-camera): the realistic case, not a toy.
const COLLECTION: &str = include_str!("../../../../protocol-fixtures/obs/collection.json");
const BASIC_INI: &str = include_str!("../../../../protocol-fixtures/obs/basic.ini");
const SERVICE: &str = include_str!("../../../../protocol-fixtures/obs/service.json");
/// What the renderer's mapping tests feed `mapObsSetup`: this parser's
/// answer for `COLLECTION`, pinned.
const PARSED: &str = include_str!("../../../../protocol-fixtures/obs/collection.parsed.json");

/// Equal JSON, numbers within float noise (OBS writes 17 digits).
fn assert_json_close(actual: &Value, expected: &Value, at: &str) {
    match (actual, expected) {
        (Value::Number(actual), Value::Number(expected)) => {
            let (actual, expected) = (actual.as_f64().unwrap(), expected.as_f64().unwrap());
            assert!(
                (actual - expected).abs() <= 1e-9 * expected.abs().max(1.0),
                "{at}: {actual} != {expected}"
            );
        }
        (Value::Array(actual), Value::Array(expected)) => {
            assert_eq!(actual.len(), expected.len(), "{at}: length");
            for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
                assert_json_close(actual, expected, &format!("{at}[{index}]"));
            }
        }
        (Value::Object(actual), Value::Object(expected)) => {
            let mut keys: Vec<&String> = actual.keys().collect();
            keys.sort();
            let mut expected_keys: Vec<&String> = expected.keys().collect();
            expected_keys.sort();
            assert_eq!(keys, expected_keys, "{at}: keys");
            for key in keys {
                assert_json_close(&actual[key], &expected[key], &format!("{at}.{key}"));
            }
        }
        (actual, expected) => assert_eq!(actual, expected, "{at}"),
    }
}

fn section(pairs: &[(&str, &str)]) -> IniSection {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

fn fake_obs_root(name: &str) -> (TestTempDir, PathBuf) {
    let guard = TestTempDir::new(name);
    let root = guard.to_path_buf();
    let scenes = root.join("basic").join("scenes");
    let profile = root.join("basic").join("profiles").join("Fixture Profile");
    fs::create_dir_all(&scenes).unwrap();
    fs::create_dir_all(&profile).unwrap();
    fs::write(scenes.join("Fixture Collection.json"), COLLECTION).unwrap();
    fs::write(profile.join("basic.ini"), BASIC_INI).unwrap();
    fs::write(profile.join("service.json"), SERVICE).unwrap();
    fs::write(
        root.join("global.ini"),
        "[Basic]\nSceneCollection=Fixture Collection\nProfile=Fixture Profile\n",
    )
    .unwrap();
    (guard, root)
}

#[test]
fn ini_sections_parse_around_comments_and_blank_lines() {
    let ini = parse_ini("# c\n[Video]\nBaseCX=3840\r\n\n;x\n[Output]\nMode = Simple\nloose\n");
    assert_eq!(ini["Video"]["BaseCX"], "3840");
    assert_eq!(ini["Output"]["Mode"], "Simple");
    assert_eq!(ini["Output"].len(), 1);
    assert_eq!(parse_ini("Early=1\n")[""]["Early"], "1");
}

#[test]
fn obs_frame_rates_become_container_integers() {
    for (pairs, fps) in [
        (&[("FPSType", "0"), ("FPSCommon", "24 NTSC")][..], 24),
        (&[("FPSType", "0"), ("FPSCommon", "29.97")][..], 30),
        (&[("FPSType", "0"), ("FPSCommon", "60")][..], 60),
        (&[("FPSType", "1"), ("FPSInt", "48")][..], 48),
        (
            &[("FPSType", "2"), ("FPSNum", "30000"), ("FPSDen", "1001")][..],
            30,
        ),
        (
            &[("FPSType", "2"), ("FPSNum", "60"), ("FPSDen", "0")][..],
            60,
        ),
        (&[("FPSType", "1"), ("FPSInt", "0")][..], 1),
        (&[("FPSType", "0"), ("FPSCommon", "fast")][..], 30),
        (&[][..], 30),
    ] {
        assert_eq!(parse_obs_fps(&section(pairs)), fps, "{pairs:?}");
    }
}

#[test]
fn javascript_number_rules_hold() {
    assert_eq!(js_number(""), 0.0);
    assert_eq!(js_number(" 3840 "), 3840.0);
    assert_eq!(js_number("0x10"), 16.0);
    assert!(js_number("12px").is_nan());
    assert!(js_number("inf").is_nan());
    assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
    assert_eq!(js_parse_float("24 NTSC"), 24.0);
    assert_eq!(js_parse_float("59.94fps"), 59.94);
    assert_eq!(js_parse_float(".5"), 0.5);
    assert_eq!(js_parse_float("1e2x"), 100.0);
    assert_eq!(js_parse_float("1e"), 1.0);
    assert!(js_parse_float("NTSC").is_nan());
    assert_eq!(js_round(2.5), 3.0);
    assert_eq!(js_round(-2.5), -2.0);
    assert_eq!(js_string(Some(&serde_json::json!(5)), ""), "5");
    assert_eq!(js_string(Some(&Value::Null), "x"), "x");
}

#[test]
fn the_real_fixture_sources_get_videorc_kinds() {
    let parsed = parse_scene_collection(COLLECTION).unwrap();
    assert_eq!(parsed.name, "Fixture Collection");
    let find = |name: &str| {
        parsed
            .sources
            .iter()
            .find(|source| source.name == name)
            .unwrap_or_else(|| panic!("{name}"))
    };
    // ScreenCaptureKit: type 2 is an application, 0 (or none) a display.
    let vs_code = find("VS Code");
    assert_eq!(vs_code.kind, ObsSourceKind::Application);
    assert_eq!(
        vs_code.application_hint.as_deref(),
        Some("com.microsoft.VSCode")
    );
    assert_eq!(find("Whole Monitor").kind, ObsSourceKind::Display);
    assert_eq!(find("bg browser").kind, ObsSourceKind::Display);
    // Cameras keep their device names and capture presets for matching.
    let camera = find("Batarang");
    assert_eq!(camera.kind, ObsSourceKind::Camera);
    assert_eq!(camera.device_name.as_deref(), Some("MacBook Pro Camera"));
    assert_eq!(
        (camera.preset_width, camera.preset_height),
        (Some(3840), Some(2160))
    );
    assert_eq!(camera.volume, Some(1.0));
    assert_eq!(camera.muted, None);
    assert_eq!(find("Batarang wide").preset_width, None);
    let microphone = find("BatMic");
    assert_eq!(microphone.kind, ObsSourceKind::Microphone);
    assert_eq!(microphone.volume, Some(1.0));
    // Scene and group pseudo-sources never leak into the source list.
    assert_eq!(parsed.sources.len(), 22);
    assert!(
        parsed
            .sources
            .iter()
            .all(|source| source.obs_kind != "scene")
    );
    // The aux mic is OBS's default device, and there is no desktop audio.
    assert_eq!(parsed.global_mic_device_name, None);
    assert!(!parsed.has_desktop_audio);
}

#[test]
fn the_parsed_fixture_is_what_this_parser_reads() {
    let parsed = parse_scene_collection(COLLECTION).unwrap();
    let mut actual = serde_json::json!({
        "name": parsed.name,
        "sources": parsed.sources,
        "scenes": parsed.scenes,
        "hasDesktopAudio": parsed.has_desktop_audio,
    });
    if let Some(device) = parsed.global_mic_device_name {
        actual["globalMicDeviceName"] = Value::String(device);
    }
    assert_json_close(&actual, &serde_json::from_str(PARSED).unwrap(), "parsed");
}

#[test]
fn an_unmuted_desktop_audio_is_on_and_a_muted_or_missing_one_is_off() {
    let has_desktop_audio = |desktop: Value| {
        parse_scene_collection(
            &serde_json::json!({ "name": "C", "sources": [], "DesktopAudioDevice1": desktop })
                .to_string(),
        )
        .unwrap()
        .has_desktop_audio
    };
    assert!(has_desktop_audio(
        serde_json::json!({ "name": "Desktop Audio" })
    ));
    assert!(!has_desktop_audio(
        serde_json::json!({ "name": "Desktop Audio", "muted": true })
    ));
    assert!(!has_desktop_audio(Value::Null));
}

#[test]
fn scenes_keep_their_items_transforms_and_the_current_flag() {
    let parsed = parse_scene_collection(COLLECTION).unwrap();
    let names: Vec<(&str, usize)> = parsed
        .scenes
        .iter()
        .map(|scene| (scene.name.as_str(), scene.items.len()))
        .collect();
    assert_eq!(
        names,
        [
            ("YouTube Shorts", 10),
            ("Long", 14),
            ("zen", 1),
            ("talking head", 2),
            ("voice", 1)
        ]
    );
    let current: Vec<&str> = parsed
        .scenes
        .iter()
        .filter(|scene| scene.current)
        .map(|scene| scene.name.as_str())
        .collect();
    assert_eq!(current, ["voice"]);
    let item = &parsed.scenes[1].items[0];
    assert!(!item.source_name.is_empty());
    assert!(item.scale_x != 0.0 && item.scale_y != 0.0);
}

#[test]
fn windows_and_linux_source_ids_get_videorc_kinds_too() {
    let parsed = parse_scene_collection(
        r#"{
            "name": "Windows",
            "current_program_scene": "Main",
            "sources": [
                { "id": "monitor_capture", "name": "Display", "settings": { "monitor_id": "x" } },
                { "id": "game_capture", "name": "Game", "settings": { "window": "Doom:Class:doom.exe" } },
                {
                    "id": "dshow_input",
                    "name": "Webcam",
                    "settings": { "video_device_id": "HP HD Camera:\\\\?\\usb#vid_04f2&pid_b6c2" },
                    "volume": 0.5,
                    "muted": true
                },
                { "id": "wasapi_input_capture", "name": "Mic", "settings": { "device_id": "default" } },
                { "id": "pipewire-screen-capture-source", "name": "Portal", "settings": {} },
                { "id": "pipewire-desktop-capture-source", "name": "Old portal", "settings": {} },
                { "id": "pipewire-window-capture-source", "name": "Portal window", "settings": {} },
                { "id": "v4l2_input", "name": "USB cam", "settings": { "device_id": "/dev/video0" } },
                { "id": "image_source", "name": "Logo", "settings": { "file": "C:\\logo.png" } },
                { "id": "text_gdiplus_v3", "name": "Title" },
                { "id": "vlc_source", "name": "Playlist" },
                { "id": "browser_source", "name": "Alerts" },
                { "id": "color_source_v3", "name": "Fill" },
                { "id": "group", "name": "Grouped" },
                { "id": "scene", "name": "Main", "settings": { "items": [] } }
            ],
            "DesktopAudioDevice1": { "name": "Desktop Audio" },
            "AuxAudioDevice1": { "name": "Mic/Aux", "settings": { "device_id": "{0.0.1}" } }
}"#,
    )
    .unwrap();
    let kinds: Vec<(&str, ObsSourceKind)> = parsed
        .sources
        .iter()
        .map(|source| (source.name.as_str(), source.kind))
        .collect();
    assert_eq!(
        kinds,
        [
            ("Display", ObsSourceKind::Display),
            ("Game", ObsSourceKind::Window),
            ("Webcam", ObsSourceKind::Camera),
            ("Mic", ObsSourceKind::Microphone),
            ("Portal", ObsSourceKind::Display),
            ("Old portal", ObsSourceKind::Display),
            ("Portal window", ObsSourceKind::Window),
            ("USB cam", ObsSourceKind::Camera),
            ("Logo", ObsSourceKind::Image),
            ("Title", ObsSourceKind::Text),
            ("Playlist", ObsSourceKind::Media),
            ("Alerts", ObsSourceKind::Browser),
            ("Fill", ObsSourceKind::Other),
        ]
    );
    let webcam = &parsed.sources[2];
    assert_eq!(webcam.device_name.as_deref(), Some("HP HD Camera"));
    assert_eq!((webcam.volume, webcam.muted), (Some(0.5), Some(true)));
    assert_eq!(
        parsed.sources[1].application_hint.as_deref(),
        Some("Doom:Class:doom.exe")
    );
    assert_eq!(
        parsed.sources[6].application_hint.as_deref(),
        Some("Portal window")
    );
    assert_eq!(parsed.sources[8].file_path.as_deref(), Some("C:\\logo.png"));
    assert_eq!(parsed.global_mic_device_name.as_deref(), Some("Mic/Aux"));
    assert!(parsed.has_desktop_audio);
    assert!(parsed.scenes[0].current);
}

#[test]
fn a_collection_that_is_not_json_is_an_error() {
    assert!(parse_scene_collection("{").is_err());
    assert!(parse_scene_collection("null").is_err());
    let empty = parse_scene_collection("[]").unwrap();
    assert_eq!(empty.name, "OBS collection");
    assert!(empty.sources.is_empty());
}

#[test]
fn the_service_reads_rtmp_and_keeps_the_key_beside_it() {
    let service = parse_service(SERVICE).unwrap();
    assert_eq!(
        service.stream,
        ObsStreamService {
            service_type: "rtmp_common".to_string(),
            service: Some("YouTube - RTMPS".to_string()),
            server: Some("rtmps://a.rtmps.youtube.com:443/live2".to_string()),
            has_key: true,
        }
    );
    assert_eq!(service.key.as_deref(), Some("fixture-not-a-real-key"));
    assert!(
        !serde_json::to_string(&service.stream)
            .unwrap()
            .contains("fixture-not-a-real-key")
    );
    assert_eq!(
        parse_service(r#"{"type":"whip_custom","settings":{}}"#),
        None
    );
    assert_eq!(parse_service("not json"), None);
    assert_eq!(parse_service("null"), None);
}

#[test]
fn obs_is_looked_for_where_each_platform_installs_it() {
    let env = ObsRootEnv::default();
    let windows_home = Path::new("C:\\Users\\pat");
    assert_eq!(
        obs_root_path(
            ObsPlatform::Windows,
            &ObsRootEnv {
                app_data: Some("C:\\Users\\pat\\AppData\\Roaming".to_string()),
                ..ObsRootEnv::default()
            },
            windows_home
        ),
        Path::new("C:\\Users\\pat\\AppData\\Roaming").join("obs-studio")
    );
    assert_eq!(
        obs_root_path(ObsPlatform::Windows, &env, windows_home),
        windows_home
            .join("AppData")
            .join("Roaming")
            .join("obs-studio")
    );
    assert_eq!(
        obs_root_path(ObsPlatform::Linux, &env, Path::new("/home/pat")),
        Path::new("/home/pat").join(".config").join("obs-studio")
    );
    assert_eq!(
        obs_root_path(ObsPlatform::Mac, &env, Path::new("/Users/pat")),
        Path::new("/Users/pat")
            .join("Library")
            .join("Application Support")
            .join("obs-studio")
    );
    assert_eq!(
        obs_root_path(
            ObsPlatform::Windows,
            &ObsRootEnv {
                override_root: Some("/fixtures/obs".to_string()),
                ..ObsRootEnv::default()
            },
            windows_home
        ),
        PathBuf::from("/fixtures/obs")
    );
}

#[test]
fn discovery_finds_collections_profiles_and_the_current_ones() {
    let (_guard, root) = fake_obs_root("obs-discover");
    fs::write(
        root.join("basic")
            .join("scenes")
            .join("Fixture Collection.json.bak"),
        COLLECTION,
    )
    .unwrap();
    fs::write(root.join("basic").join("scenes").join("notes.txt"), "x").unwrap();
    assert_eq!(
        discover_obs(&root),
        ObsDiscovery {
            available: true,
            collections: vec!["Fixture Collection".to_string()],
            profiles: vec!["Fixture Profile".to_string()],
            current_collection: Some("Fixture Collection".to_string()),
            current_profile: Some("Fixture Profile".to_string()),
        }
    );
    // user.ini wins over global.ini.
    fs::write(root.join("user.ini"), "[Basic]\nProfile=Other\n").unwrap();
    assert_eq!(
        discover_obs(&root).current_profile.as_deref(),
        Some("Other")
    );
}

#[test]
fn a_machine_without_obs_is_unavailable() {
    let guard = TestTempDir::new("obs-none");
    let discovery = discover_obs(&guard.join("no-obs-here"));
    assert!(!discovery.available);
    assert_eq!(
        serde_json::to_value(&discovery).unwrap(),
        serde_json::json!({ "available": false, "collections": [], "profiles": [] })
    );
}

#[test]
fn the_full_read_has_no_stream_key_and_the_key_comes_separately() {
    let (_guard, root) = fake_obs_root("obs-read");
    let setup = read_obs_setup("Fixture Collection", "Fixture Profile", &root)
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            setup.canvas_width,
            setup.canvas_height,
            setup.output_width,
            setup.output_height,
            setup.fps
        ),
        (3840.0, 2160.0, 3840.0, 2160.0, 24)
    );
    assert_eq!(
        setup.recording_path.as_deref(),
        Some("/Users/orcdev/Movies")
    );
    assert_eq!(
        setup.service.as_ref().map(|service| service.has_key),
        Some(true)
    );
    let wire = serde_json::to_value(&setup).unwrap();
    assert!(!wire.to_string().contains("fixture-not-a-real-key"));
    // Whole numbers go out as integers, the way the renderer read them.
    assert_eq!(wire["canvasWidth"], serde_json::json!(3840));
    assert_eq!(wire["service"]["type"], "rtmp_common");
    assert_eq!(wire["service"]["hasKey"], true);
    assert_eq!(wire["sources"][0]["obsKind"], "coreaudio_input_capture");
    assert!(wire["sources"][0].get("deviceName").is_none());
    assert_eq!(
        read_obs_stream_key("Fixture Profile", &root).as_deref(),
        Some("fixture-not-a-real-key")
    );
}

#[test]
fn missing_video_settings_fall_back_to_1080p30() {
    let (_guard, root) = fake_obs_root("obs-defaults");
    let profile = root.join("basic").join("profiles").join("Fixture Profile");
    fs::write(
        profile.join("basic.ini"),
        "[Video]\nBaseCX=abc\nOutputCX=0\n",
    )
    .unwrap();
    fs::remove_file(profile.join("service.json")).unwrap();
    let setup = read_obs_setup("Fixture Collection", "Fixture Profile", &root)
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            setup.canvas_width,
            setup.canvas_height,
            setup.output_width,
            setup.output_height,
            setup.fps
        ),
        (1920.0, 1080.0, 1920.0, 1080.0, 30)
    );
    assert_eq!(setup.recording_path, None);
    assert_eq!(setup.service, None);
    assert_eq!(read_obs_stream_key("Fixture Profile", &root), None);
}

#[test]
fn a_bak_twin_stands_in_for_a_missing_primary() {
    let (_guard, root) = fake_obs_root("obs-bak");
    fs::write(
        root.join("basic").join("scenes").join("BakOnly.json.bak"),
        COLLECTION,
    )
    .unwrap();
    let setup = read_obs_setup("BakOnly", "Fixture Profile", &root)
        .unwrap()
        .unwrap();
    assert!(!setup.scenes.is_empty());
}

#[test]
fn only_exact_discovered_names_are_read() {
    let (_guard, root) = fake_obs_root("obs-exact");
    for (collection, profile) in [
        ("../Fixture Collection", "Fixture Profile"),
        ("Fixture Collection", "../Fixture Profile"),
        ("Fixture Collection.json", "Fixture Profile"),
    ] {
        assert_eq!(
            read_obs_setup(collection, profile, &root).unwrap(),
            None,
            "{collection} {profile}"
        );
    }
    assert_eq!(read_obs_stream_key("../Fixture Profile", &root), None);
}

#[test]
fn a_broken_collection_is_an_error_not_a_missing_one() {
    let (_guard, root) = fake_obs_root("obs-broken");
    fs::write(
        root.join("basic")
            .join("scenes")
            .join("Fixture Collection.json"),
        "{ not json",
    )
    .unwrap();
    assert!(read_obs_setup("Fixture Collection", "Fixture Profile", &root).is_err());
}

#[cfg(unix)]
#[test]
fn symlinked_collections_and_profiles_are_never_discovered_or_followed() {
    use std::os::unix::fs::symlink;

    let (_guard, root) = fake_obs_root("obs-symlinks");
    let outside_guard = TestTempDir::new("obs-outside");
    let outside = outside_guard.to_path_buf();
    let outside_collection = outside.join("outside.json");
    let outside_profile = outside.join("outside-profile");
    fs::write(&outside_collection, COLLECTION).unwrap();
    fs::create_dir_all(&outside_profile).unwrap();
    fs::write(outside_profile.join("basic.ini"), BASIC_INI).unwrap();
    fs::write(outside_profile.join("service.json"), SERVICE).unwrap();
    let scenes = root.join("basic").join("scenes");
    symlink(&outside_collection, scenes.join("Linked.json")).unwrap();
    symlink(
        &outside_profile,
        root.join("basic").join("profiles").join("Linked Profile"),
    )
    .unwrap();

    let discovery = discover_obs(&root);
    assert!(!discovery.collections.iter().any(|name| name == "Linked"));
    assert!(
        !discovery
            .profiles
            .iter()
            .any(|name| name == "Linked Profile")
    );
    assert_eq!(
        read_obs_setup("Linked", "Fixture Profile", &root).unwrap(),
        None
    );
    assert_eq!(read_obs_stream_key("Linked Profile", &root), None);

    // A once-valid entry replaced by a symlink after discovery is refused at
    // read time too.
    let fixture = scenes.join("Fixture Collection.json");
    fs::remove_file(&fixture).unwrap();
    symlink(&outside_collection, &fixture).unwrap();
    assert_eq!(
        read_obs_setup("Fixture Collection", "Fixture Profile", &root).unwrap(),
        None
    );
}

#[cfg(windows)]
#[test]
fn windows_profile_junctions_that_escape_the_obs_root_are_not_discovered() {
    let (_guard, root) = fake_obs_root("obs-junction");
    let outside_guard = TestTempDir::new("obs-junction-profile");
    let outside = outside_guard.to_path_buf();
    fs::write(outside.join("basic.ini"), BASIC_INI).unwrap();
    fs::write(outside.join("service.json"), SERVICE).unwrap();
    let link = root.join("basic").join("profiles").join("Linked Profile");
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&outside)
        .status()
        .unwrap();
    assert!(status.success());

    assert!(
        !discover_obs(&root)
            .profiles
            .iter()
            .any(|name| name == "Linked Profile")
    );
    assert_eq!(read_obs_stream_key("Linked Profile", &root), None);
}
