//! `hooks/use-scenes.ts`' loading and edits, as pure state.

use std::path::PathBuf;

use serde_json::{Value, json};

use super::library::*;
use crate::scenes::migration::{StoredForMigration, default_scenes};
use crate::scenes::model::{NAME_TAKEN_ERROR, WORKING_SCENE_KEY};
use crate::scenes::v2::{
    DELETE_ON_STREAM_REASON, KEEP_ONE_SCENE_REASON, MainDisplay, SCENES_KEY, SceneLibrary,
    SceneShows,
};
use crate::studio::capture_config::default_capture_config;

const NOW: &str = "2026-11-15T12:00:00.000Z";

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/src/renderer/src/lib/__fixtures__/scenes")
        .join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn load(scenes: Option<&Value>, storage: &Value) -> Loaded {
    let config = default_capture_config(NOW);
    load_scenes(&StoredScenes {
        scenes,
        migration: StoredForMigration {
            read_only: false,
            v1_library: storage.get("videorc.scene-presets.v1"),
            working_scene: storage.get(WORKING_SCENE_KEY),
            capture_config: &config,
            global_shortcuts: storage
                .get("videorc.settings")
                .and_then(|settings| settings.get("globalShortcuts")),
            now: NOW,
            platform: None,
        },
    })
}

fn display_one() -> MainDisplay {
    MainDisplay {
        id: "screen:1".into(),
        name: "Display 1".into(),
        display_uuid: None,
    }
}

fn state() -> ScenesState {
    ScenesState {
        library: SceneLibrary {
            scenes: default_scenes(Some(&display_one()), NOW),
            on_stream_id: "default-screen-camera".into(),
            pending_shortcuts: None,
            vertical_layouts_repaired: true,
        },
        read_only: false,
        error: None,
        migrated_shortcuts: None,
        unwritten: false,
    }
}

fn ids(library: &SceneLibrary) -> Vec<&str> {
    library
        .scenes
        .iter()
        .map(|scene| scene.id.as_str())
        .collect()
}

#[test]
fn a_stored_library_loads_as_it_is() {
    let stored = state().library.to_json();
    let loaded = load(Some(&stored), &json!({}));
    assert_eq!(loaded.repair, None);
    assert_eq!(loaded.state, state());
}

#[test]
fn a_library_from_0_34_is_repaired_before_the_studio_reads_it() {
    let owner = fixture("v2-vertical-camera-only");
    let loaded = load(owner.get(SCENES_KEY), &owner);
    let repair = loaded.repair.expect("a repair to store first");
    assert_eq!(
        repair.repaired,
        ["default-screen-camera", "default-side-by-side"]
    );
    assert!(loaded.state.library.vertical_layouts_repaired);
    assert!(!loaded.state.unwritten);
}

#[test]
fn no_library_migrates_and_keeps_the_moved_keys_until_settled() {
    let storage = fixture("builtin-user-layout-keys");
    let loaded = load(None, &storage);
    assert_eq!(loaded.repair, None);
    let state = loaded.state;
    assert!(state.unwritten);
    assert!(!state.read_only);
    let keys = state.migrated_shortcuts.clone().unwrap();
    assert_eq!(state.library.pending_shortcuts.as_ref(), Some(&keys));
    assert_eq!(keys["scenes"]["default-screen-camera"], "Control+Alt+1");
    // The migration is stored once, with its keys, until the settings hold
    // them.
    assert_eq!(state.pending_write(), Some(state.library.clone()));
    let settled = state.settle_shortcuts().unwrap().unwrap();
    assert_eq!(settled.pending_shortcuts, None);
    let mut after = state.clone();
    after.shortcuts_settled(settled.clone());
    assert_eq!(after.migrated_shortcuts, None);
    assert!(!after.unwritten);
    assert_eq!(after.settle_shortcuts(), Ok(None));
    // A later launch replays keys a launch never settled.
    let replay = load(Some(&state.library.to_json()), &json!({}));
    assert_eq!(replay.state.migrated_shortcuts, Some(keys));
}

#[test]
fn an_unknown_version_is_today_s_setup_in_memory_never_written() {
    let unknown = fixture("unknown-version");
    let loaded = load(unknown.get(SCENES_KEY), &unknown);
    let state = loaded.state;
    assert!(state.read_only);
    assert!(!state.unwritten);
    assert_eq!(state.migrated_shortcuts, None);
    assert_eq!(state.library.pending_shortcuts, None);
    assert_eq!(state.pending_write(), None);
    assert_eq!(
        state.move_scene("default-screen-only", 0),
        Err(Refused::ReadOnly)
    );
    assert_eq!(state.name_main_display(&display_one()), None);
}

#[test]
fn new_scenes_go_at_the_end_and_a_duplicate_after_its_original() {
    let state = state();
    let mut added = state.library.scenes[1].clone();
    added.id = "figma".into();
    added.name = "Figma".into();
    let at_end = state.insert(std::slice::from_ref(&added), None).unwrap();
    assert_eq!(ids(&at_end).last(), Some(&"figma"));
    let after = state
        .insert(std::slice::from_ref(&added), Some("default-screen-camera"))
        .unwrap();
    assert_eq!(ids(&after)[1], "figma");
    // A taken name or id is refused, never renamed here.
    let mut taken = added.clone();
    taken.name = "screen only".into();
    assert_eq!(
        state.insert(&[taken], None),
        Err(Refused::Name(NAME_TAKEN_ERROR))
    );
    let mut same_id = added;
    same_id.id = "default-screen-only".into();
    assert_eq!(state.insert(&[same_id], None), Err(Refused::Invalid));
}

#[test]
fn a_scene_is_replaced_and_renamed_in_its_place() {
    let state = state();
    let mut edited = state.library.scenes[2].clone();
    edited.shows = SceneShows::TestPattern;
    let replaced = state.replace(&edited).unwrap();
    assert_eq!(replaced.scenes[2].shows, SceneShows::TestPattern);
    let renamed = state
        .rename("default-camera-only", "  Talk  ", "later")
        .unwrap();
    assert_eq!(renamed.scenes[2].name, "Talk");
    assert_eq!(renamed.scenes[2].updated_at, "later");
    assert_eq!(
        state.rename("default-camera-only", "Screen only", "later"),
        Err(Refused::Name(NAME_TAKEN_ERROR))
    );
    assert_eq!(state.rename("gone", "Talk", "later"), Err(Refused::Nothing));
}

#[test]
fn reordering_and_the_scene_on_stream() {
    let state = state();
    let moved = state.move_scene("default-side-by-side", 0).unwrap();
    assert_eq!(ids(&moved)[0], "default-side-by-side");
    assert_eq!(
        state.move_scene("default-screen-camera", 0),
        Err(Refused::Nothing)
    );
    assert_eq!(state.set_on_stream("default-screen-camera"), Ok(None));
    let on = state.set_on_stream("default-camera-only").unwrap().unwrap();
    assert_eq!(on.on_stream_id, "default-camera-only");
    assert_eq!(state.set_on_stream("gone"), Err(Refused::Nothing));
}

#[test]
fn deleting_the_scene_on_stream_names_the_one_before_it_in_the_same_write() {
    let mut state = state();
    state.library.on_stream_id = "default-camera-only".into();
    let removed = state.remove("default-camera-only", false).unwrap();
    assert_eq!(removed.on_stream_id, "default-screen-only");
    assert!(!ids(&removed).contains(&"default-camera-only"));
    assert_eq!(
        state.remove("default-camera-only", true),
        Err(Refused::Delete(Some(DELETE_ON_STREAM_REASON)))
    );
    let other = state.remove("default-side-by-side", true).unwrap();
    assert_eq!(other.on_stream_id, "default-camera-only");
    let mut last = state.clone();
    last.library.scenes.truncate(1);
    last.library.on_stream_id = last.library.scenes[0].id.clone();
    assert_eq!(
        last.remove("default-screen-camera", false),
        Err(Refused::Delete(Some(KEEP_ONE_SCENE_REASON)))
    );
}

#[test]
fn the_main_display_is_named_once_and_first_run_edits_keep_the_scenes() {
    let mut waiting = state();
    waiting.library.scenes = default_scenes(None, NOW);
    let named = waiting.name_main_display(&display_one()).unwrap();
    assert_eq!(named.scenes, default_scenes(Some(&display_one()), NOW));
    waiting.written(named);
    assert_eq!(waiting.name_main_display(&display_one()), None);
    let state = state();
    let looked = state
        .replace_all(|scenes| {
            scenes
                .iter()
                .cloned()
                .map(|mut scene| {
                    scene.horizontal["cameraShape"] = json!("circle");
                    scene
                })
                .collect()
        })
        .unwrap();
    assert!(
        looked
            .scenes
            .iter()
            .all(|scene| scene.horizontal["cameraShape"] == "circle")
    );
    assert_eq!(
        state.replace_all(|scenes| scenes[..1].to_vec()),
        Err(Refused::Invalid)
    );
}
