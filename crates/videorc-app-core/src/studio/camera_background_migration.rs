//! Plan 258 D4 (`lib/camera-background-migration.ts`): the scenes' green or
//! blue screen moves to the camera, once. Since S5 it settles on its first
//! run (`CAMERA_BACKGROUND_MIGRATION_SETTLES`): the camera's choice is then
//! what keys ([`super::camera_background::camera_output_layout`]), and the
//! scenes keep their key fields, so a rollback loses nothing.

use serde_json::{Map, Value, json};

use super::camera_background::{
    default_camera_background, normalize_camera_backgrounds, normalize_hide_edges, normalize_key,
};
use super::js_value::{canonical_eq, finite_number, string};
use super::settings::{CAMERA_BACKGROUND_MIGRATION_VERSION, StudioSettings};
use crate::scenes::v2::Scene;

/// `CAMERA_BACKGROUND_MIGRATION_SETTLES`.
pub const MIGRATION_SETTLES: bool = true;

/// What the migration reads of a scene (`CameraBackgroundMigrationScene`):
/// its id and both layouts.
#[derive(Debug, Clone, Copy)]
pub struct MigrationScene<'a> {
    pub id: &'a str,
    pub horizontal: &'a Value,
    pub vertical: &'a Value,
}

impl<'a> From<&'a Scene> for MigrationScene<'a> {
    fn from(scene: &'a Scene) -> Self {
        Self {
            id: &scene.id,
            horizontal: &scene.horizontal,
            vertical: &scene.vertical,
        }
    }
}

/// `keyedLayout`: the scene's keyed layout, the landscape one first (the
/// vertical leg takes the program's key).
fn keyed_layout<'a>(scene: &MigrationScene<'a>) -> Option<&'a Value> {
    [scene.horizontal, scene.vertical]
        .into_iter()
        .find(|layout| layout["cameraChromaKeyEnabled"] == Value::Bool(true))
}

/// `keyColor`: blue only for blue, any other hex keys green.
fn key_color(layout: &Value) -> &'static str {
    if string(layout.get("cameraChromaKeyColor"))
        .is_some_and(|color| color.eq_ignore_ascii_case("#0000FF"))
    {
        "blue"
    } else {
        "green"
    }
}

/// `CameraBackgroundMigration`: the two settings it writes.
#[derive(Debug, Clone, PartialEq)]
pub struct Migration {
    /// `cameraBackgrounds`, `None` for none.
    pub camera_backgrounds: Option<Value>,
    /// `cameraBackgroundMigration`.
    pub version: Option<f64>,
}

/// `migrateCameraBackgrounds`' input.
pub struct MigrationInput<'a> {
    pub camera_backgrounds: Option<&'a Value>,
    pub version: Option<f64>,
    pub camera_id: Option<&'a str>,
    pub scenes: &'a [MigrationScene<'a>],
    pub on_stream_id: Option<&'a str>,
    /// `settle` (default [`MIGRATION_SETTLES`]).
    pub settle: bool,
}

fn migrated(version: Option<f64>) -> bool {
    version.is_some_and(|version| version >= CAMERA_BACKGROUND_MIGRATION_VERSION)
}

/// `migrateCameraBackgrounds` (D4): the camera's choice becomes Green or
/// Blue screen with the tuning of the scene on stream if that scene keys,
/// else of the first scene that does; with no keyed scene, a screen the
/// camera has goes Off, keeping its tuning. An effect already picked for the
/// camera (blur, a picture, Cut out) is never replaced by a key. A key waits
/// for a selected camera rather than being lost. `None` when there is
/// nothing to write.
pub fn migrate_camera_backgrounds(input: &MigrationInput) -> Option<Migration> {
    if migrated(input.version) {
        return None;
    }
    let backgrounds = normalize_camera_backgrounds(input.camera_backgrounds)
        .and_then(|all| all.as_object().cloned())
        .unwrap_or_default();
    let result = |next: Map<String, Value>| -> Option<Migration> {
        let migration = Migration {
            camera_backgrounds: (!next.is_empty()).then_some(Value::Object(next)),
            version: if input.settle {
                Some(CAMERA_BACKGROUND_MIGRATION_VERSION)
            } else {
                input.version
            },
        };
        let same_backgrounds = match (&migration.camera_backgrounds, input.camera_backgrounds) {
            (None, None) => true,
            (Some(next), Some(before)) => canonical_eq(next, before),
            _ => false,
        };
        let unchanged = migration.version == input.version && same_backgrounds;
        (!unchanged).then_some(migration)
    };
    let on_stream = input
        .scenes
        .iter()
        .find(|scene| Some(scene.id) == input.on_stream_id);
    let keyed = on_stream
        .and_then(keyed_layout)
        .or_else(|| input.scenes.iter().find_map(keyed_layout));
    let Some(keyed) = keyed else {
        if let Some(camera) = input.camera_id
            && let Some(current) = backgrounds.get(camera)
            && matches!(string(current.get("mode")), Some("green" | "blue"))
        {
            let mut off = current.clone();
            off["mode"] = json!("off");
            let mut next = backgrounds.clone();
            next.insert(camera.to_string(), off);
            return result(next);
        }
        return result(backgrounds);
    };
    let camera = input.camera_id?;
    let current = backgrounds
        .get(camera)
        .cloned()
        .unwrap_or_else(default_camera_background);
    if !matches!(string(current.get("mode")), Some("off" | "green" | "blue")) {
        return result(backgrounds);
    }
    let mut key = Map::new();
    for (field, from) in [
        ("similarityPct", "cameraChromaKeySimilarityPct"),
        ("smoothnessPct", "cameraChromaKeySmoothnessPct"),
        ("spillPct", "cameraChromaKeySpillPct"),
    ] {
        if let Some(value) = keyed.get(from) {
            key.insert(field.into(), value.clone());
        }
    }
    if let Some(edges) = normalize_hide_edges(keyed.get("cameraChromaKeyEdges")) {
        key.insert("hideEdges".into(), edges);
    }
    let mut next_background = current.as_object().cloned().unwrap_or_default();
    next_background.insert("mode".into(), json!(key_color(keyed)));
    if let Some(key) = normalize_key(Some(&Value::Object(key))) {
        next_background.insert("key".into(), key);
    }
    let mut next = backgrounds.clone();
    next.insert(camera.to_string(), Value::Object(next_background));
    result(next)
}

/// `migratedSettings`: the settings with the migration applied, or `None`
/// when there is nothing to write.
pub fn migrated_settings(
    settings: &StudioSettings,
    camera_id: Option<&str>,
    scenes: &[MigrationScene],
    on_stream_id: Option<&str>,
) -> Option<StudioSettings> {
    let migration = migrate_camera_backgrounds(&MigrationInput {
        camera_backgrounds: settings.get("cameraBackgrounds"),
        version: finite_number(settings.get("cameraBackgroundMigration")),
        camera_id,
        scenes,
        on_stream_id,
        settle: MIGRATION_SETTLES,
    })?;
    let mut next = settings.clone();
    match migration.camera_backgrounds {
        Some(backgrounds) => next.set("cameraBackgrounds", backgrounds),
        None => next.remove("cameraBackgrounds"),
    }
    match migration.version {
        Some(version) => next.set("cameraBackgroundMigration", json!(version as i64)),
        None => next.remove("cameraBackgroundMigration"),
    }
    Some(next)
}

#[cfg(test)]
#[path = "camera_background_migration_tests.rs"]
mod tests;
