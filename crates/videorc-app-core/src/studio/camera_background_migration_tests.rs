//! `lib/camera-background.test.ts`' D4 migration cases, run by run.

use serde_json::{Value, json};

use super::*;
use crate::studio::capture_config::default_capture_config;
use crate::studio::settings::CAMERA_BACKGROUND_MIGRATION_VERSION as VERSION;

fn layout() -> Value {
    default_capture_config("2026-11-24T00:00:00.000Z")["layout"].clone()
}

fn keyed_layout(color: &str, tuning: Value) -> Value {
    let mut out = layout();
    out["cameraChromaKeyEnabled"] = json!(true);
    out["cameraChromaKeyColor"] = json!(color);
    out["cameraChromaKeySimilarityPct"] = json!(35);
    out["cameraChromaKeySmoothnessPct"] = json!(6);
    out["cameraChromaKeySpillPct"] = json!(20);
    for (key, value) in tuning.as_object().cloned().unwrap_or_default() {
        out[key] = value;
    }
    out
}

struct Owned {
    id: String,
    horizontal: Value,
    vertical: Value,
}

fn scene(id: &str) -> Owned {
    Owned {
        id: id.into(),
        horizontal: layout(),
        vertical: layout(),
    }
}

fn keyed(id: &str, horizontal: Value) -> Owned {
    Owned {
        horizontal,
        ..scene(id)
    }
}

#[derive(Default)]
struct Options {
    no_camera: bool,
    backgrounds: Option<Value>,
    version: Option<f64>,
    settle: bool,
}

fn migrate(scenes: &[Owned], on: &str, options: Options) -> Option<Migration> {
    let views: Vec<MigrationScene> = scenes
        .iter()
        .map(|scene| MigrationScene {
            id: &scene.id,
            horizontal: &scene.horizontal,
            vertical: &scene.vertical,
        })
        .collect();
    migrate_camera_backgrounds(&MigrationInput {
        camera_backgrounds: options.backgrounds.as_ref(),
        version: options.version,
        camera_id: (!options.no_camera).then_some("camera-a"),
        scenes: &views,
        on_stream_id: Some(on),
        settle: options.settle,
    })
}

fn default_with(mode: &str, key: Value) -> Value {
    let mut background = default_camera_background();
    background["mode"] = json!(mode);
    background["key"] = key;
    background
}

#[test]
fn with_no_keyed_scene_the_camera_keeps_off() {
    assert_eq!(
        migrate(&[scene("a"), scene("b")], "a", Options::default()),
        None
    );
    assert_eq!(
        migrate(
            &[scene("a"), scene("b")],
            "a",
            Options {
                settle: true,
                ..Options::default()
            }
        ),
        Some(Migration {
            camera_backgrounds: None,
            version: Some(VERSION)
        })
    );
    assert_eq!(
        migrate(
            &[scene("a")],
            "a",
            Options {
                no_camera: true,
                ..Options::default()
            }
        ),
        None
    );
}

#[test]
fn takes_the_key_and_its_tuning_from_the_scene_on_stream_when_it_keys() {
    let edges = json!({"leftPct": 4, "topPct": 0, "rightPct": 2, "bottomPct": 0});
    let result = migrate(
        &[
            keyed("first", keyed_layout("#0000FF", json!({}))),
            keyed(
                "live",
                keyed_layout(
                    "#00FF00",
                    json!({"cameraChromaKeySimilarityPct": 51, "cameraChromaKeyEdges": edges}),
                ),
            ),
        ],
        "live",
        Options::default(),
    )
    .unwrap();
    assert_eq!(
        result.camera_backgrounds.unwrap()["camera-a"],
        default_with(
            "green",
            json!({"similarityPct": 51, "smoothnessPct": 6, "spillPct": 20, "hideEdges": edges})
        )
    );
    assert_eq!(result.version, None);
}

#[test]
fn takes_the_first_keyed_scene_when_the_scene_on_stream_does_not_key() {
    let result = migrate(
        &[
            scene("live"),
            scene("plain"),
            keyed("second", keyed_layout("#00ff00", json!({}))),
            keyed("third", keyed_layout("#0000FF", json!({}))),
        ],
        "live",
        Options::default(),
    )
    .unwrap();
    assert_eq!(
        result.camera_backgrounds.unwrap()["camera-a"],
        default_with(
            "green",
            json!({"similarityPct": 35, "smoothnessPct": 6, "spillPct": 20})
        )
    );
    let vertical = Owned {
        vertical: keyed_layout("#0000FF", json!({})),
        ..scene("vertical")
    };
    let result = migrate(&[scene("live"), vertical], "live", Options::default()).unwrap();
    assert_eq!(
        result.camera_backgrounds.unwrap()["camera-a"]["mode"],
        "blue"
    );
}

#[test]
fn keeps_both_colours() {
    for (color, mode) in [
        ("#00FF00", "green"),
        ("#00ff00", "green"),
        ("#0000FF", "blue"),
        ("#0000ff", "blue"),
        ("#FF00FF", "green"),
    ] {
        let result = migrate(
            &[keyed("live", keyed_layout(color, json!({})))],
            "live",
            Options::default(),
        )
        .unwrap();
        assert_eq!(
            result.camera_backgrounds.unwrap()["camera-a"]["mode"],
            mode,
            "{color}"
        );
    }
}

#[test]
fn waits_for_a_camera_keeps_other_cameras_and_never_replaces_an_effect() {
    let scenes = [keyed("live", keyed_layout("#0000FF", json!({})))];
    assert_eq!(
        migrate(
            &scenes,
            "live",
            Options {
                no_camera: true,
                ..Options::default()
            }
        ),
        None
    );
    assert_eq!(
        migrate(
            &scenes,
            "live",
            Options {
                no_camera: true,
                settle: true,
                ..Options::default()
            }
        ),
        None
    );
    let minimal = json!({"mode": "blur", "blurPct": 70, "edges": "balanced"});
    let mut other = minimal.clone();
    other["mode"] = json!("cutout");
    let mut off = minimal.clone();
    off["mode"] = json!("off");
    off["blurPct"] = json!(30);
    let result = migrate(
        &scenes,
        "live",
        Options {
            backgrounds: Some(json!({"camera-b": other, "camera-a": off})),
            ..Options::default()
        },
    )
    .unwrap();
    assert_eq!(
        result.camera_backgrounds.unwrap(),
        json!({
            "camera-b": other,
            "camera-a": {"mode": "blue", "blurPct": 30, "edges": "balanced",
                         "key": {"similarityPct": 35, "smoothnessPct": 6, "spillPct": 20}}
        })
    );
    let blurred = json!({"camera-a": minimal});
    assert_eq!(
        migrate(
            &scenes,
            "live",
            Options {
                backgrounds: Some(blurred.clone()),
                ..Options::default()
            }
        ),
        None
    );
    assert_eq!(
        migrate(
            &scenes,
            "live",
            Options {
                backgrounds: Some(blurred.clone()),
                settle: true,
                ..Options::default()
            }
        ),
        Some(Migration {
            camera_backgrounds: Some(blurred),
            version: Some(VERSION)
        })
    );
}

#[test]
#[allow(clippy::assertions_on_constants)] // pins the flag S5 flips
fn settles_by_default_and_never_runs_again() {
    assert!(MIGRATION_SETTLES);
    let scenes = [keyed(
        "live",
        keyed_layout("#0000FF", json!({"cameraChromaKeySpillPct": 33})),
    )];
    let first = migrate(
        &scenes,
        "live",
        Options {
            settle: true,
            ..Options::default()
        },
    )
    .unwrap();
    assert_eq!(
        first,
        Migration {
            camera_backgrounds: Some(json!({"camera-a": default_with(
                "blue",
                json!({"similarityPct": 35, "smoothnessPct": 6, "spillPct": 33})
            )})),
            version: Some(VERSION)
        }
    );
    for later in [
        vec![keyed("live", keyed_layout("#00FF00", json!({})))],
        vec![scene("live")],
        vec![keyed("other", keyed_layout("#00FF00", json!({})))],
    ] {
        assert_eq!(
            migrate(
                &later,
                "live",
                Options {
                    backgrounds: Some(
                        json!({"camera-a": {"mode": "blur", "blurPct": 70, "edges": "balanced"}})
                    ),
                    version: first.version,
                    settle: true,
                    ..Options::default()
                }
            ),
            None
        );
    }
    assert_eq!(
        migrate(
            &[scene("live")],
            "live",
            Options {
                no_camera: true,
                settle: true,
                ..Options::default()
            }
        ),
        Some(Migration {
            camera_backgrounds: None,
            version: Some(VERSION)
        })
    );
}

#[test]
fn follows_the_scenes_on_runs_that_do_not_settle() {
    assert_eq!(migrate(&[scene("live")], "live", Options::default()), None);
    let keyed_later = migrate(
        &[keyed("live", keyed_layout("#00FF00", json!({})))],
        "live",
        Options::default(),
    )
    .unwrap();
    let backgrounds = keyed_later.camera_backgrounds.clone().unwrap();
    let green = backgrounds["camera-a"].clone();
    assert_eq!(green["mode"], "green");
    assert_eq!(
        migrate(
            &[keyed("live", keyed_layout("#00FF00", json!({})))],
            "live",
            Options {
                backgrounds: Some(backgrounds),
                ..Options::default()
            }
        ),
        None
    );
    let mut off = green.clone();
    off["mode"] = json!("off");
    assert_eq!(
        migrate(
            &[scene("live")],
            "live",
            Options {
                backgrounds: Some(json!({"camera-a": green})),
                ..Options::default()
            }
        )
        .unwrap()
        .camera_backgrounds,
        Some(json!({"camera-a": off}))
    );
}

#[test]
fn the_settings_get_the_migration_merged_and_nothing_once_settled() {
    let base = StudioSettings::default();
    let scenes = [keyed("live", keyed_layout("#0000FF", json!({})))];
    let views: Vec<MigrationScene> = scenes
        .iter()
        .map(|scene| MigrationScene {
            id: &scene.id,
            horizontal: &scene.horizontal,
            vertical: &scene.vertical,
        })
        .collect();
    let merged = migrated_settings(&base, Some("camera-a"), &views, Some("live")).unwrap();
    assert_eq!(merged.get("cameraBackgroundMigration"), Some(&json!(1)));
    assert_eq!(
        merged.get("cameraBackgrounds").unwrap()["camera-a"]["mode"],
        "blue"
    );
    assert!(merged.camera_background_migrated());
    assert_eq!(
        migrated_settings(&merged, Some("camera-a"), &[], Some("live")),
        None
    );
}
