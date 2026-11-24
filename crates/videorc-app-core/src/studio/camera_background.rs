//! A camera's background (plan 258, `lib/camera-background.ts`): the
//! normalizers the capture config's loader and the settings read (plan 260
//! S1.6a). One background per camera, kept beside the camera looks in
//! `videorc.settings` (`cameraBackgrounds`), and put on the layout only at
//! the output boundary, so the store never holds it on the layout.
//!
//! S1.6b part 4: the output half (`cameraBackgroundLayout`, the key taken
//! from the camera once the D4 migration settled, `cameraOutputLayout`).

use serde_json::{Map, Value, json};

use super::js_value::{clamp_number, finite_number, is_object_like, round, string, truthy};

/// `CAMERA_BACKGROUND_MODES` (`shared/backend.ts`).
pub const MODES: [&str; 7] = ["off", "blur", "image", "video", "cutout", "green", "blue"];
/// `CAMERA_BACKGROUND_EDGES`.
pub const EDGES: [&str; 3] = ["soft", "balanced", "sharp"];
/// `CAMERA_BACKGROUND_STRONG_BLUR_PCT`: `DEFAULT_CAMERA_BACKGROUND`'s blur.
pub const STRONG_BLUR_PCT: f64 = 70.0;
/// `CAMERA_KEY_EDGE_MAX_PCT`: Hide edges' most per side (plan 227 B).
pub const KEY_EDGE_MAX_PCT: f64 = 25.0;
/// `ASSET_ID_MAX`.
const ASSET_ID_MAX: usize = 256;
/// `DEFAULT_KEY`: the scene key's defaults, for a key stored without one.
const DEFAULT_KEY: [(&str, f64); 3] = [
    ("similarityPct", 40.0),
    ("smoothnessPct", 8.0),
    ("spillPct", 10.0),
];
const SIDES: [&str; 4] = ["leftPct", "topPct", "rightPct", "bottomPct"];

/// `clampInt` (`lib/camera-background.ts`): a finite number, rounded and
/// clamped; anything else (a string included) is the fallback.
fn clamp_int(value: Option<&Value>, fallback: f64, min: f64, max: f64) -> f64 {
    match finite_number(value) {
        Some(number) => max.min(min.max(round(number))),
        None => fallback,
    }
}

fn whole(number: f64) -> Value {
    json!(number as i64)
}

/// `normalizeCameraKeyEdges` (`lib/capture.ts`): the layout's Hide edges,
/// each side a whole percent in 0–25 (`clampNumber`, so `"12"` reads as 12),
/// or `None` when every side is 0, so a layout without edges matches one
/// saved before them.
pub fn normalize_camera_key_edges(raw: Option<&Value>) -> Option<Value> {
    let value = if truthy(raw) && is_object_like(raw) {
        raw
    } else {
        None
    };
    edges_from(|side| clamp_number(value.and_then(|v| v.get(side)), 0.0, 0.0, KEY_EDGE_MAX_PCT))
}

/// `normalizeHideEdges`: a key's Hide edges (`clampInt`).
pub fn normalize_hide_edges(raw: Option<&Value>) -> Option<Value> {
    if !(truthy(raw) && is_object_like(raw)) {
        return None;
    }
    edges_from(|side| clamp_int(raw.and_then(|v| v.get(side)), 0.0, 0.0, KEY_EDGE_MAX_PCT))
}

fn edges_from(side: impl Fn(&str) -> f64) -> Option<Value> {
    let values: Vec<f64> = SIDES.iter().map(|name| side(name)).collect();
    if values.iter().all(|pct| *pct <= 0.0) {
        return None;
    }
    let mut edges = Map::new();
    for (name, pct) in SIDES.iter().zip(values) {
        edges.insert((*name).to_string(), whole(pct));
    }
    Some(Value::Object(edges))
}

/// `normalizeKey`: a green or blue screen's tuning.
pub fn normalize_key(raw: Option<&Value>) -> Option<Value> {
    if !(truthy(raw) && is_object_like(raw)) {
        return None;
    }
    let mut key = Map::new();
    for (name, fallback) in DEFAULT_KEY {
        key.insert(
            name.to_string(),
            whole(clamp_int(
                raw.and_then(|v| v.get(name)),
                fallback,
                0.0,
                100.0,
            )),
        );
    }
    if let Some(edges) = normalize_hide_edges(raw.and_then(|v| v.get("hideEdges"))) {
        key.insert("hideEdges".into(), edges);
    }
    Some(Value::Object(key))
}

/// `normalizeCameraBackground`: a stored or received background, bounded;
/// `None` when it isn't one (not an object, or an array). An unknown mode
/// reads as Off, never as an effect it might not be.
pub fn normalize_camera_background(raw: Option<&Value>) -> Option<Value> {
    let object = raw.and_then(Value::as_object)?;
    let field = |name: &str| object.get(name);
    let mode = string(field("mode"))
        .filter(|mode| MODES.contains(mode))
        .unwrap_or("off");
    let edges = string(field("edges"))
        .filter(|edges| EDGES.contains(edges))
        .unwrap_or("balanced");
    let mut out = Map::new();
    out.insert("mode".into(), json!(mode));
    out.insert(
        "blurPct".into(),
        whole(clamp_int(field("blurPct"), STRONG_BLUR_PCT, 0.0, 100.0)),
    );
    out.insert("edges".into(), json!(edges));
    if let Some(asset_id) = string(field("assetId"))
        .filter(|id| !id.is_empty() && id.encode_utf16().count() <= ASSET_ID_MAX)
    {
        out.insert("assetId".into(), json!(asset_id));
    }
    if let Some(key) = normalize_key(field("key")) {
        out.insert("key".into(), key);
    }
    Some(Value::Object(out))
}

/// `normalizeCameraBackgrounds`: every camera's stored background, bounded;
/// cameras with nothing usable are dropped, and `None` when none is left.
pub fn normalize_camera_backgrounds(raw: Option<&Value>) -> Option<Value> {
    let object = raw.and_then(Value::as_object)?;
    let mut out = Map::new();
    for (camera_id, stored) in object {
        if camera_id.is_empty() {
            continue;
        }
        if let Some(background) = normalize_camera_background(Some(stored)) {
            out.insert(camera_id.clone(), background);
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// `DEFAULT_CAMERA_BACKGROUND`: what a camera has before anything is
/// picked: Off, with Strong blur ready.
pub fn default_camera_background() -> Value {
    json!({"mode": "off", "blurPct": STRONG_BLUR_PCT as i64, "edges": "balanced"})
}

/// `KEY_HEX`: the two screen colours as the key's hex.
const KEY_HEX: [(&str, &str); 2] = [("green", "#00FF00"), ("blue", "#0000FF")];

/// `cameraKeyLayout`: the layout's key fields from the camera's choice
/// (D4): on, with the colour and tuning, for Green or Blue screen; off for
/// anything else, so a key never runs with a blur or a picture. Only the
/// switch changes for Off, so the fields a rollback reads keep their last
/// tuning.
fn camera_key_layout(
    mut base: Map<String, Value>,
    background: Option<&Value>,
) -> Map<String, Value> {
    let mode = background.and_then(|background| string(background.get("mode")));
    let Some(hex) = KEY_HEX
        .iter()
        .find(|(screen, _)| Some(*screen) == mode)
        .map(|(_, hex)| *hex)
    else {
        if truthy(base.get("cameraChromaKeyEnabled")) {
            base.insert("cameraChromaKeyEnabled".into(), json!(false));
        }
        return base;
    };
    let key = background.and_then(|background| background.get("key"));
    let tuning = |name: &str| -> Value {
        key.and_then(|key| key.get(name))
            .cloned()
            .unwrap_or_else(|| {
                let fallback = DEFAULT_KEY
                    .iter()
                    .find(|(field, _)| *field == name)
                    .map_or(0.0, |(_, value)| *value);
                whole(fallback)
            })
    };
    base.remove("cameraChromaKeyEdges");
    base.insert("cameraChromaKeyEnabled".into(), json!(true));
    base.insert("cameraChromaKeyColor".into(), json!(hex));
    base.insert(
        "cameraChromaKeySimilarityPct".into(),
        tuning("similarityPct"),
    );
    base.insert(
        "cameraChromaKeySmoothnessPct".into(),
        tuning("smoothnessPct"),
    );
    base.insert("cameraChromaKeySpillPct".into(), tuning("spillPct"));
    if let Some(edges) = key.and_then(|key| key.get("hideEdges")) {
        base.insert("cameraChromaKeyEdges".into(), edges.clone());
    }
    base
}

/// `cameraBackgroundLayout`: the layout an output gets, with the selected
/// camera's background on it, or none while that camera's is Off (so
/// layouts from before plan 258 go out as they were). A previous camera's
/// background never carries over. With `key_from_camera` (the D4 migration
/// settled) the key fields come from the camera's choice too.
pub fn camera_background_layout(
    layout: &Value,
    camera_id: Option<&str>,
    backgrounds: Option<&Value>,
    key_from_camera: bool,
) -> Value {
    let mut rest = layout.as_object().cloned().unwrap_or_default();
    rest.remove("cameraBackground");
    let background = camera_id
        .filter(|id| !id.is_empty())
        .and_then(|id| normalize_camera_background(backgrounds.and_then(|all| all.get(id))));
    let mut base = if key_from_camera {
        camera_key_layout(rest, background.as_ref())
    } else {
        rest
    };
    if let Some(background) = background.filter(|background| background["mode"] != "off") {
        base.insert("cameraBackground".into(), background);
    }
    Value::Object(base)
}

/// `cameraOutputLayout`: the output boundary. The selected camera's look and
/// background go on the layout, from the settings that keep them per camera.
/// Every session start, live layout change and Preview update goes through
/// here.
pub fn camera_output_layout(
    layout: &Value,
    camera_id: Option<&str>,
    studio: &super::settings::StudioSettings,
) -> Value {
    let mut looked = layout.as_object().cloned().unwrap_or_default();
    looked.remove("cameraLook");
    if let Some(look) = studio.camera_look(camera_id) {
        looked.insert("cameraLook".into(), look);
    }
    camera_background_layout(
        &Value::Object(looked),
        camera_id,
        studio.get("cameraBackgrounds"),
        studio.camera_background_migrated(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_background_is_bounded_and_an_unknown_mode_is_off() {
        assert_eq!(normalize_camera_background(None), None);
        assert_eq!(normalize_camera_background(Some(&json!([]))), None);
        assert_eq!(normalize_camera_background(Some(&json!("blur"))), None);
        assert_eq!(
            normalize_camera_background(Some(&json!({}))),
            Some(json!({"mode": "off", "blurPct": 70, "edges": "balanced"}))
        );
        assert_eq!(
            normalize_camera_background(Some(&json!({
                "mode": "sparkle", "blurPct": 140.6, "edges": "jagged", "assetId": ""
            }))),
            Some(json!({"mode": "off", "blurPct": 100, "edges": "balanced"}))
        );
        assert_eq!(
            normalize_camera_background(Some(&json!({
                "mode": "green", "blurPct": "30", "edges": "sharp", "assetId": "bg-1",
                "key": {"similarityPct": 55.4, "spillPct": -3,
                        "hideEdges": {"leftPct": 30, "topPct": 0}}
            }))),
            Some(json!({
                "mode": "green", "blurPct": 70, "edges": "sharp", "assetId": "bg-1",
                "key": {"similarityPct": 55, "smoothnessPct": 8, "spillPct": 0,
                        "hideEdges": {"leftPct": 25, "topPct": 0, "rightPct": 0, "bottomPct": 0}}
            }))
        );
        let long = "a".repeat(257);
        assert!(
            normalize_camera_background(Some(&json!({"mode": "image", "assetId": long})))
                .is_some_and(|background| background.get("assetId").is_none())
        );
    }

    #[test]
    fn layout_key_edges_read_numbers_like_clamp_number_and_vanish_at_zero() {
        assert_eq!(normalize_camera_key_edges(None), None);
        assert_eq!(
            normalize_camera_key_edges(Some(&json!({"leftPct": 0}))),
            None
        );
        assert_eq!(
            normalize_camera_key_edges(Some(
                &json!({"leftPct": "12", "bottomPct": 99, "topPct": 2.4})
            )),
            Some(json!({"leftPct": 12, "topPct": 2, "rightPct": 0, "bottomPct": 25}))
        );
    }

    #[test]
    fn cameras_with_nothing_usable_are_dropped() {
        assert_eq!(
            normalize_camera_backgrounds(Some(&json!({"": {}, "cam": 3}))),
            None
        );
        assert_eq!(
            normalize_camera_backgrounds(Some(&json!({"cam": {"mode": "blur"}}))),
            Some(json!({"cam": {"mode": "blur", "blurPct": 70, "edges": "balanced"}}))
        );
    }

    fn fixture() -> Value {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../protocol-fixtures/camera-background.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn layout() -> Value {
        crate::studio::capture_config::default_capture_config("2026-11-24T00:00:00.000Z")["layout"]
            .clone()
    }

    fn studio(settings: Value) -> crate::studio::settings::StudioSettings {
        crate::studio::settings::StudioSettings::load(Some(&Value::String(settings.to_string())))
    }

    #[test]
    fn the_output_follows_the_selected_camera_and_leaves_off_off_the_wire() {
        let minimal = fixture()["minimal"].clone();
        let mut off = minimal.clone();
        off["mode"] = json!("off");
        let backgrounds = json!({"camera-a": minimal, "camera-b": off});
        let with_a =
            camera_background_layout(&layout(), Some("camera-a"), Some(&backgrounds), false);
        assert_eq!(with_a["cameraBackground"], minimal);
        for camera in [Some("camera-b"), Some("camera-c"), None] {
            let out = camera_background_layout(&with_a, camera, Some(&backgrounds), false);
            assert!(out.get("cameraBackground").is_none(), "{camera:?}");
        }
    }

    #[test]
    fn the_look_and_the_background_go_on_together_each_per_camera() {
        let full = fixture()["full"].clone();
        let look = json!({"brightness": 0.1, "contrast": 1, "saturation": 1});
        let out = camera_output_layout(
            &layout(),
            Some("camera-a"),
            &studio(json!({"cameraLooks": {"camera-a": look},
                           "cameraBackgrounds": {"camera-a": full}})),
        );
        assert!(out.get("cameraLook").is_some());
        assert_eq!(out["cameraBackground"], full);
        // Before the D4 migration the scene's own key goes out as it was.
        assert_eq!(
            out["cameraChromaKeyEnabled"],
            layout()["cameraChromaKeyEnabled"]
        );
    }

    #[test]
    fn once_migrated_the_cameras_choice_is_what_keys() {
        let mut keyed = layout();
        keyed["cameraChromaKeyEnabled"] = json!(true);
        keyed["cameraChromaKeyColor"] = json!("#00FF00");
        keyed["cameraChromaKeySimilarityPct"] = json!(12);
        keyed["cameraChromaKeyEdges"] =
            json!({"leftPct": 9, "topPct": 0, "rightPct": 0, "bottomPct": 0});
        let edges = json!({"leftPct": 3, "topPct": 1, "rightPct": 0, "bottomPct": 0});
        let blue = json!({"mode": "blue", "blurPct": 70, "edges": "balanced",
            "key": {"similarityPct": 44, "smoothnessPct": 5, "spillPct": 21, "hideEdges": edges}});
        let migrated = |backgrounds: Value| {
            studio(json!({"cameraBackgrounds": backgrounds, "cameraBackgroundMigration": 1}))
        };
        let out = camera_output_layout(
            &keyed,
            Some("camera-a"),
            &migrated(json!({"camera-a": blue})),
        );
        assert_eq!(out["cameraChromaKeyEnabled"], true);
        assert_eq!(out["cameraChromaKeyColor"], "#0000FF");
        assert_eq!(out["cameraChromaKeySimilarityPct"], 44);
        assert_eq!(out["cameraChromaKeySmoothnessPct"], 5);
        assert_eq!(out["cameraChromaKeySpillPct"], 21);
        assert_eq!(out["cameraChromaKeyEdges"], edges);
        assert_eq!(out["cameraBackground"], blue);
        // Without its own Hide edges the scene's are dropped, not kept.
        let green = json!({"mode": "green", "blurPct": 70, "edges": "balanced"});
        let plain = camera_output_layout(
            &keyed,
            Some("camera-a"),
            &migrated(json!({"camera-a": green})),
        );
        assert_eq!(plain["cameraChromaKeyColor"], "#00FF00");
        assert_eq!(plain["cameraChromaKeySimilarityPct"], 40);
        assert!(plain.get("cameraChromaKeyEdges").is_none());
        // A blur, a picture, Off, another camera's pick or no camera: never a key.
        let mut off = blue.clone();
        off["mode"] = json!("off");
        for (camera, backgrounds) in [
            (Some("camera-a"), json!({"camera-a": {"mode": "blur"}})),
            (
                Some("camera-a"),
                json!({"camera-a": {"mode": "image", "assetId": "loft"}}),
            ),
            (Some("camera-a"), json!({"camera-a": off})),
            (Some("camera-b"), json!({"camera-a": blue})),
            (None, json!({"camera-a": blue})),
        ] {
            let out = camera_output_layout(&keyed, camera, &migrated(backgrounds.clone()));
            assert_eq!(out["cameraChromaKeyEnabled"], false, "{backgrounds}");
            // Off touches only the switch: a rollback still reads the tuning.
            assert_eq!(out["cameraChromaKeySimilarityPct"], 12);
        }
    }

    #[test]
    fn every_commit_takes_the_background_from_the_settings() {
        let strong = json!({"mode": "blur", "blurPct": 70, "edges": "balanced"});
        let stored = studio(json!({"cameraBackgrounds": {"camera-a": strong},
                                   "cameraBackgroundMigration": 1}));
        let mut from_scene = layout();
        from_scene["layoutPreset"] = json!("camera-only");
        assert!(from_scene.get("cameraBackground").is_none());
        assert_eq!(
            camera_output_layout(&from_scene, Some("camera-a"), &stored)["cameraBackground"],
            strong
        );
        let mut stale = from_scene.clone();
        stale["cameraBackground"] = json!({"mode": "off", "blurPct": 70, "edges": "balanced"});
        assert_eq!(
            camera_output_layout(&stale, Some("camera-a"), &stored)["cameraBackground"],
            strong
        );
    }
}
