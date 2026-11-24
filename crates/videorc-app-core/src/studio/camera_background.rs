//! A camera's background (plan 258, `lib/camera-background.ts`): the
//! normalizers the capture config's loader and the settings read (plan 260
//! S1.6a). One background per camera, kept beside the camera looks in
//! `videorc.settings` (`cameraBackgrounds`), and put on the layout only at
//! the output boundary, so the store never holds it on the layout.
//!
//! The rest of plan 258's renderer half (`cameraBackgroundLayout`, the key
//! taken from the camera once the D4 migration settled, and the migration
//! itself) lands with the scenes and the camera look (S1.6b).

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
}
