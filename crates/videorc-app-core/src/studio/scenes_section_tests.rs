//! Studio's Scenes section as data: the cards' words, states and keys, the
//! toggle's lock, the macOS-only switch, the room's line and the switch's
//! status clock.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

use super::*;
use crate::scenes::model::{CAMERA_GONE_PROBLEM, normalize_scene_visual};
use crate::scenes::switch_progress::start_scene_switch_progress;
use crate::studio::capture_config::default_layout;

fn layout(preset: &str) -> Value {
    let mut layout = default_layout();
    layout["layoutPreset"] = json!(preset);
    layout
}

fn scene(id: &str, name: &str, sources: Value, preset: &str) -> SavedScene {
    SavedScene {
        id: id.into(),
        name: name.into(),
        created_at: "2026-11-25".into(),
        updated_at: "2026-11-25".into(),
        visual: normalize_scene_visual(
            &json!({"layout": layout(preset), "sources": sources, "background": null}),
        )
        .unwrap(),
        audio: None,
        cloud: None,
    }
}

fn talk() -> SavedScene {
    scene("talk", "Talk", json!({"cameraId": "camera"}), "camera-only")
}

fn display() -> SavedScene {
    scene(
        "display",
        "Display",
        json!({"cameraId": "camera", "screenId": "screen:1", "screenName": "Display 1"}),
        "screen-camera",
    )
}

fn figma() -> SavedScene {
    scene(
        "figma",
        "Figma",
        json!({
            "cameraId": "camera",
            "app": {"bundleId": "com.figma.Desktop", "name": "Figma", "follows": true}
        }),
        "screen-camera",
    )
}

fn device(id: &str, name: &str, kind: DeviceKind) -> Device {
    serde_json::from_value(json!({
        "id": id,
        "name": name,
        "kind": kind,
        "status": DeviceStatus::Available,
    }))
    .unwrap()
}

struct Fixture {
    scenes: ScenesView,
    devices: Vec<Device>,
    shortcuts: Value,
    layout: Value,
    registered: BTreeMap<String, bool>,
    platform: &'static str,
    session_active: bool,
    capture_reason: Option<String>,
    working_audio: SceneAudio,
    room_open: bool,
    now_ms: u64,
}

impl Fixture {
    fn new() -> Self {
        Self {
            scenes: ScenesView {
                loaded: true,
                scenes: vec![talk(), display(), figma()],
                on_stream_id: Some("talk".into()),
                ..ScenesView::default()
            },
            devices: vec![device("camera", "C920", DeviceKind::Camera)],
            shortcuts: json!({}),
            layout: layout("camera-only"),
            registered: BTreeMap::new(),
            platform: "darwin",
            session_active: false,
            capture_reason: None,
            working_audio: scene_audio(&json!({"microphoneId": "mic:1"}), true),
            room_open: false,
            now_ms: 0,
        }
    }

    fn view(&self) -> ScenesSectionView {
        ScenesSectionView::of(ScenesSectionInput {
            scenes: &self.scenes,
            devices: &self.devices,
            shortcuts: &self.shortcuts,
            layout: &self.layout,
            camera_id: Some("camera"),
            session_active: self.session_active,
            follow_front_app: true,
            capture_reason: self.capture_reason.as_deref(),
            working_audio: &self.working_audio,
            extras: ScenesExtras {
                room_open: self.room_open,
                platform: Some(self.platform),
                registered: &self.registered,
                camera_low: None,
                now_ms: self.now_ms,
            },
        })
    }

    fn gallery(&self) -> ScenesGalleryView {
        match self.view() {
            ScenesSectionView::Gallery(gallery) => gallery,
            other => panic!("expected the gallery, got {other:?}"),
        }
    }
}

#[test]
fn the_room_and_the_unread_library_hold_the_gallery() {
    let mut fixture = Fixture::new();
    fixture.room_open = true;
    assert_eq!(fixture.view(), ScenesSectionView::RoomOpen);
    assert_eq!(
        ScenesSectionView::room_open_line(),
        "Scenes are off while the room is open. Pick a layout on the Show stage."
    );
    fixture.room_open = false;
    fixture.scenes.loaded = false;
    assert_eq!(fixture.view(), ScenesSectionView::Loading);
}

#[test]
fn each_card_says_what_it_shows_and_which_one_is_on_stream() {
    let gallery = Fixture::new().gallery();
    let words: Vec<_> = gallery
        .cards
        .iter()
        .map(|card| card.meta.as_deref())
        .collect();
    assert_eq!(
        words,
        [
            Some("No screen"),
            Some(copy::RESOLVE_SOURCES),
            Some("Front window")
        ]
    );
    let positions: Vec<_> = gallery.cards.iter().map(|card| card.position).collect();
    assert_eq!(positions, [1, 2, 3]);
    assert!(gallery.cards[0].on_stream);
    assert!(!gallery.cards[1].on_stream);
    assert!(gallery.cards.iter().all(|card| !card.disabled));
    assert_eq!(gallery.cards[0].glyph, SceneGlyph::Camera);
    assert_eq!(gallery.cards[0].preset, "camera-only");
    assert!(!gallery.cards[0].vertical);
    assert_eq!(gallery.camera_reason, None);
    assert_eq!(gallery.error, None);
}

#[test]
fn the_scene_going_on_waits_with_no_reason_of_its_own() {
    let mut fixture = Fixture::new();
    fixture.scenes.pending_scene_id = Some("figma".into());
    let gallery = fixture.gallery();
    let figma = &gallery.cards[2];
    assert!(figma.pending && figma.disabled);
    assert_eq!(figma.disabled_reason, None);
    assert!(!gallery.cards[0].pending);
}

#[test]
fn a_missing_camera_is_said_once_and_an_app_scene_keeps_its_own_reason() {
    let mut fixture = Fixture::new();
    fixture.devices.clear();
    let gallery = fixture.gallery();
    let reason = gallery.camera_reason.clone();
    assert!(reason.is_some());
    let talk = &gallery.cards[0];
    assert!(talk.disabled);
    assert_eq!(talk.disabled_reason, reason);
    assert_eq!(talk.meta.as_deref(), Some("No screen"));
    // The camera is the gallery's reason, so the display scene doesn't ask
    // to resolve its sources: it says what it shows.
    let display = &gallery.cards[1];
    assert!(display.disabled);
    assert_eq!(display.meta.as_deref(), Some("Display 1"));
    let figma = &gallery.cards[2];
    assert!(figma.disabled);
    assert_eq!(figma.disabled_reason.as_deref(), Some(CAMERA_GONE_PROBLEM));
    assert_eq!(figma.meta.as_deref(), Some(CAMERA_GONE_PROBLEM));
}

#[test]
fn a_remembered_app_stands_in_for_the_scene_window() {
    let devices = [device("camera", "C920", DeviceKind::Camera)];
    assert!(scene_needs_sources(&display(), None, &devices));
    assert!(!scene_needs_sources(
        &display(),
        Some("com.figma.Desktop"),
        &devices
    ));
}

#[test]
fn the_keys_are_chips_and_a_refused_one_is_said() {
    let mut fixture = Fixture::new();
    fixture.registered.insert("scene-slot-2".to_string(), false);
    let gallery = fixture.gallery();
    let darwin = Some("darwin");
    assert_eq!(
        gallery.cards[0].keys,
        [CardKey::Chip {
            action: "scene-slot-1".into(),
            label: accelerator_label(Some("Control+Alt+1"), darwin),
        }]
    );
    assert_eq!(
        gallery.cards[1].keys,
        [CardKey::Conflict {
            action: "scene-slot-2".into(),
            reason: format!(
                "Another app uses {}",
                accelerator_label(Some("Control+Alt+2"), darwin)
            ),
        }]
    );
}

#[test]
fn the_line_names_the_platform_keys_until_one_is_the_streamers_own() {
    assert_eq!(
        scenes_line(&json!({}), Some("darwin")),
        ScenesLine::Keys {
            first: accelerator_label(Some("Control+Alt+1"), Some("darwin")),
            last: accelerator_label(Some("Control+Alt+9"), Some("darwin")),
        }
    );
    assert_eq!(
        scenes_line(&json!({}), Some("win32")),
        ScenesLine::Keys {
            first: accelerator_label(Some("Control+Alt+Shift+1"), Some("win32")),
            last: accelerator_label(Some("Control+Alt+Shift+9"), Some("win32")),
        }
    );
    assert_eq!(
        scenes_line(
            &json!({"sceneSlots": {"1": "Control+Alt+K"}}),
            Some("darwin")
        ),
        ScenesLine::General
    );
}

#[test]
fn the_toggle_locks_for_a_session_and_follow_is_macos_only() {
    let mut fixture = Fixture::new();
    let gallery = fixture.gallery();
    assert_eq!(gallery.orientation_locked, None);
    assert!(!gallery.vertical);
    assert_eq!(gallery.follow_front_app, Some(true));

    fixture.session_active = true;
    fixture.platform = "linux";
    fixture.layout = layout("vertical-camera-top");
    let gallery = fixture.gallery();
    assert_eq!(gallery.orientation_locked, Some(copy::ORIENTATION_LOCKED));
    assert!(gallery.vertical);
    assert_eq!(gallery.follow_front_app, None);
}

#[test]
fn the_status_line_waits_a_moment_and_says_when() {
    let mut fixture = Fixture::new();
    fixture.scenes.switch_progress = Some(start_scene_switch_progress(None, 1, "Talk", 1_000));
    fixture.now_ms = 1_200;
    let gallery = fixture.gallery();
    assert_eq!(gallery.status, None);
    assert_eq!(gallery.status_at, Some(2_500));

    fixture.now_ms = 2_500;
    let gallery = fixture.gallery();
    assert_eq!(gallery.status_at, None);
    let status = gallery.status.expect("the line shows");
    assert_eq!(status.title, "Talk · Getting ready…");
    assert_eq!(status.detail, None);
}

#[test]
fn each_card_asks_a_still_of_what_it_shows_and_none_without_a_screen() {
    let gallery = Fixture::new().gallery();
    assert_eq!(
        gallery.cards[0].picture, None,
        "Camera only draws no screen"
    );
    assert_eq!(
        gallery.cards[1].picture,
        Some(ScenePictureTarget::Display {
            screen_id: "screen:1".into()
        })
    );
    assert_eq!(
        gallery.cards[2].picture,
        Some(ScenePictureTarget::App {
            bundle_id: "com.figma.Desktop".into()
        })
    );
    assert_eq!(
        gallery.cards[2].glyph,
        SceneGlyph::App {
            bundle_id: "com.figma.Desktop".into()
        }
    );
    assert_eq!(gallery.cards[1].glyph, SceneGlyph::Display);
    assert!(!gallery.read_only);
}

#[test]
fn a_dragged_card_lands_on_the_far_side_of_the_one_under_it() {
    assert_eq!(drop_edge(0, 2), Some(DropEdge::After));
    assert_eq!(drop_edge(3, 1), Some(DropEdge::Before));
    assert_eq!(drop_edge(1, 1), None);
}

fn key(name: &str, alt: bool, shift: bool) -> MoveKey<'_> {
    MoveKey {
        key: name,
        alt,
        ctrl: false,
        meta: false,
        shift,
    }
}

#[test]
fn option_and_an_arrow_move_the_card_one_place_within_the_list() {
    assert_eq!(
        card_move_target(key("ArrowLeft", true, false), 1, 3, false),
        Some(0)
    );
    assert_eq!(
        card_move_target(key("ArrowRight", true, false), 1, 3, false),
        Some(2)
    );
    // Past either end, another axis, another modifier, or read-only.
    assert_eq!(
        card_move_target(key("ArrowLeft", true, false), 0, 3, false),
        None
    );
    assert_eq!(
        card_move_target(key("ArrowRight", true, false), 2, 3, false),
        None
    );
    assert_eq!(
        card_move_target(key("ArrowUp", true, false), 1, 3, false),
        None
    );
    assert_eq!(
        card_move_target(key("ArrowLeft", true, true), 1, 3, false),
        None
    );
    assert_eq!(
        card_move_target(key("ArrowLeft", false, false), 1, 3, false),
        None
    );
    assert_eq!(
        card_move_target(key("ArrowLeft", true, false), 1, 3, true),
        None
    );
}

#[test]
fn a_cut_line_shows_the_whole_name_and_the_cut_meta() {
    assert_eq!(cut_tooltip("Talk", false, Some("No screen"), false), None);
    assert_eq!(
        cut_tooltip("A very long scene name", true, Some("No screen"), false).as_deref(),
        Some("A very long scene name")
    );
    assert_eq!(
        cut_tooltip("Figma", false, Some("Figma · front window"), true).as_deref(),
        Some("Figma\nFigma · front window")
    );
    assert_eq!(cut_tooltip("Talk", false, None, true), None);
}

#[test]
fn the_menu_is_all_on_for_a_scene_off_stream_and_set_key_never_waits() {
    let gallery = Fixture::new().gallery();
    let display = &gallery.cards[1];
    assert!(display.needs_sources);
    assert_eq!(
        display.menu,
        SceneCardMenu {
            read_only_reason: None,
            change_screen_reason: None,
            follows: None,
            save_audio_reason: None,
            delete_disabled: false,
            delete_reason: None,
        }
    );
    assert!(!gallery.cards[0].needs_sources);
    // An app scene follows its app or doesn't.
    assert_eq!(gallery.cards[2].menu.follows, Some(true));
    assert!(!gallery.cards[2].needs_sources);
}

#[test]
fn a_newer_library_turns_every_write_off_with_its_reason() {
    let mut fixture = Fixture::new();
    fixture.scenes.read_only = true;
    let menu = fixture.gallery().cards[1].menu.clone();
    assert_eq!(
        menu.read_only_reason,
        Some("Update Videorc to change your scenes.")
    );
    assert_eq!(
        menu.change_screen_reason.as_deref(),
        Some(copy::READ_ONLY_REASON)
    );
    assert_eq!(menu.save_audio_reason, Some(copy::READ_ONLY_REASON));
    assert!(menu.delete_disabled);
    assert_eq!(menu.delete_reason, Some(copy::READ_ONLY_REASON));
}

#[test]
fn change_screen_waits_for_the_screen_switch_only_on_the_scene_on_stream() {
    let mut fixture = Fixture::new();
    fixture.capture_reason = Some("Switching screens…".into());
    let gallery = fixture.gallery();
    assert_eq!(
        gallery.cards[0].menu.change_screen_reason.as_deref(),
        Some("Switching screens…")
    );
    assert_eq!(gallery.cards[1].menu.change_screen_reason, None);
}

#[test]
fn save_audio_waits_only_while_the_scene_keeps_the_working_audio() {
    let mut fixture = Fixture::new();
    // Kept nothing yet: it can save.
    assert_eq!(fixture.gallery().cards[0].menu.save_audio_reason, None);
    fixture.scenes.scenes[0].audio = Some(fixture.working_audio.clone());
    assert_eq!(
        fixture.gallery().cards[0].menu.save_audio_reason,
        Some("The scene already keeps this microphone and System audio.")
    );
    fixture.scenes.scenes[0].audio = Some(scene_audio(&json!({"microphoneId": "mic:2"}), true));
    assert_eq!(fixture.gallery().cards[0].menu.save_audio_reason, None);
    assert!(!scene_keeps_audio(None, &fixture.working_audio));
}

#[test]
fn delete_keeps_the_last_scene_and_the_scene_on_stream_while_live() {
    let mut fixture = Fixture::new();
    fixture.session_active = true;
    let gallery = fixture.gallery();
    assert!(gallery.cards[0].menu.delete_disabled);
    assert_eq!(
        gallery.cards[0].menu.delete_reason,
        Some("Switch to another scene first.")
    );
    assert!(!gallery.cards[1].menu.delete_disabled);
    fixture.session_active = false;
    fixture.scenes.scenes.truncate(1);
    let only = &fixture.gallery().cards[0];
    assert!(only.menu.delete_disabled);
    assert_eq!(only.menu.delete_reason, Some("Keep at least one scene."));
}
