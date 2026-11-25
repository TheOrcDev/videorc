//! Parse and content-key helpers for the cloud scene contract.

use serde_json::{Map, Value};

use super::types::{
    BACKGROUND_ASSET_MAX_SIDE, BACKGROUND_DIM_MAX, BACKGROUND_STILL_REASONS, BackgroundCapability,
    BackgroundCrop, BackgroundDrawn, BackgroundMime, BackgroundRendering, BackgroundStillReason,
    CloudScene, CloudSceneExtension, LIVE_BACKGROUND_IDS, LiveBackgroundClock,
    SCENE_EXTENSION_VERSION, SCENE_LEASE_MS, SCENE_MAX_GUEST_SLOTS, SCENE_MOTION_MAX_MS,
    SceneApplied, SceneBackground, SceneCapability, SceneCrop, SceneFit, SceneGuests, SceneItem,
    SceneMask, SceneOrientation, SceneOutput, ScenePage, SceneRect, SceneRole, SceneSnapshot,
    SceneTransition, SceneTransitionKind,
};
use crate::studio::js_value;

fn as_map(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

fn safe_integer(value: &Value) -> Option<i64> {
    let n = finite(value)?;
    if n.fract() != 0.0 || n.abs() > 9_007_199_254_740_991.0 {
        return None;
    }
    Some(n as i64)
}

fn positive(value: &Value) -> Option<i64> {
    let n = safe_integer(value)?;
    (n > 0).then_some(n)
}

fn sid(value: &Value) -> Option<&str> {
    let text = value.as_str()?;
    let rest = text.strip_prefix("PA_")?;
    if rest.is_empty() || rest.len() > 64 || !rest.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(text)
}

fn dimension(value: &Value) -> Option<i64> {
    let n = safe_integer(value)?;
    (1..=BACKGROUND_ASSET_MAX_SIDE).contains(&n).then_some(n)
}

/// `isBackgroundHash`.
pub fn is_background_hash(value: &Value) -> Option<&str> {
    let text = value.as_str()?;
    (text.len() == 64 && text.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))).then_some(text)
}

/// `isBackgroundMime`.
pub fn is_background_mime(value: &Value) -> Option<BackgroundMime> {
    match value.as_str()? {
        "image/webp" => Some(BackgroundMime::Webp),
        "image/jpeg" => Some(BackgroundMime::Jpeg),
        "image/png" => Some(BackgroundMime::Png),
        _ => None,
    }
}

/// `isLiveBackgroundId`.
pub fn is_live_background_id(value: &Value) -> Option<&str> {
    let text = value.as_str()?;
    LIVE_BACKGROUND_IDS.contains(&text).then_some(text)
}

fn background_crop(value: &Value) -> Option<BackgroundCrop> {
    let object = as_map(value)?;
    let l = finite(object.get("l")?)?;
    let t = finite(object.get("t")?)?;
    let r = finite(object.get("r")?)?;
    let b = finite(object.get("b")?)?;
    for n in [l, t, r, b] {
        if !(0.0..=0.95).contains(&n) {
            return None;
        }
    }
    if l + r >= 0.96 || t + b >= 0.96 {
        return None;
    }
    Some(BackgroundCrop { l, t, r, b })
}

/// `parseSceneBackground`.
pub fn parse_scene_background(value: &Value) -> Option<SceneBackground> {
    let object = as_map(value)?;
    match object.get("kind").and_then(Value::as_str)? {
        "picture" => {
            let crop = background_crop(object.get("crop")?)?;
            let hash = is_background_hash(object.get("hash")?)?.to_string();
            let mime = is_background_mime(object.get("mime")?)?;
            let width = dimension(object.get("width")?)?;
            let height = dimension(object.get("height")?)?;
            let fit = match object.get("fit").and_then(Value::as_str)? {
                "contain" => SceneFit::Contain,
                "cover" => SceneFit::Cover,
                _ => return None,
            };
            Some(SceneBackground::Picture {
                hash,
                mime,
                width,
                height,
                fit,
                crop,
            })
        }
        "live" => {
            let id = is_live_background_id(object.get("id")?)?.to_string();
            let look = object.get("look").and_then(Value::as_str)?;
            if look.is_empty()
                || look.len() > 32
                || !look
                    .chars()
                    .all(|c| matches!(c, 'a'..='z' | '0'..='9' | '-'))
            {
                return None;
            }
            let dim = finite(object.get("dim")?)?;
            if !(0.0..=BACKGROUND_DIM_MAX).contains(&dim) {
                return None;
            }
            let clock = as_map(object.get("clock")?)?;
            let anchor_at = positive(clock.get("anchorAt")?)?;
            let anchor_phase = finite(clock.get("anchorPhase")?)?;
            if anchor_phase.abs() > 1e7 {
                return None;
            }
            let rate = finite(clock.get("rate")?)?;
            if !(0.0..=100.0).contains(&rate) {
                return None;
            }
            Some(SceneBackground::Live {
                id,
                look: look.to_string(),
                dim,
                clock: LiveBackgroundClock {
                    anchor_at,
                    anchor_phase,
                    rate,
                },
            })
        }
        _ => None,
    }
}

fn parse_background_rendering(value: &Value) -> Option<BackgroundRendering> {
    match value.as_str()? {
        "picture" => Some(BackgroundRendering::Picture),
        "shader" => Some(BackgroundRendering::Shader),
        "half" => Some(BackgroundRendering::Half),
        "still" => Some(BackgroundRendering::Still),
        "none" => Some(BackgroundRendering::None),
        _ => None,
    }
}

fn parse_background_still_reason(value: &Value) -> Option<BackgroundStillReason> {
    let text = value.as_str()?;
    if !BACKGROUND_STILL_REASONS.contains(&text) {
        return None;
    }
    match text {
        "no-webgl2" => Some(BackgroundStillReason::NoWebgl2),
        "shader-compile-failed" => Some(BackgroundStillReason::ShaderCompileFailed),
        "context-lost" => Some(BackgroundStillReason::ContextLost),
        "gpu-budget" => Some(BackgroundStillReason::GpuBudget),
        "unknown-look" => Some(BackgroundStillReason::UnknownLook),
        "asset-missing" => Some(BackgroundStillReason::AssetMissing),
        "asset-invalid" => Some(BackgroundStillReason::AssetInvalid),
        _ => None,
    }
}

/// `parseBackgroundCapability`.
pub fn parse_background_capability(value: &Value) -> Option<BackgroundCapability> {
    let object = as_map(value)?;
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let live = object.get("live").and_then(Value::as_u64)?;
    if live != 0 && live != 1 {
        return None;
    }
    let drawn = match object.get("drawn") {
        None => None,
        Some(drawn) => {
            let drawn = as_map(drawn)?;
            let key = drawn.get("key").and_then(Value::as_str)?;
            let key_ok = key == "none"
                || (key.len() == 8 && key.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
            if !key_ok {
                return None;
            }
            let rendering = parse_background_rendering(drawn.get("rendering")?)?;
            let reason = match drawn.get("reason") {
                None => None,
                Some(reason) => Some(parse_background_still_reason(reason)?),
            };
            Some(BackgroundDrawn {
                key: key.to_string(),
                rendering,
                reason,
            })
        }
    };
    Some(BackgroundCapability {
        version: 1,
        live: live as u8,
        drawn,
    })
}

/// Mirrors Rust `scene_geometry` bounds (plan 215 E3): position -3..4, size up to 4.
pub fn scene_rect(value: &Value) -> Option<SceneRect> {
    let object = as_map(value)?;
    let x = finite(object.get("x")?)?;
    let y = finite(object.get("y")?)?;
    let w = finite(object.get("w")?)?;
    let h = finite(object.get("h")?)?;
    if !((-3.0..=4.0).contains(&x)
        && (-3.0..=4.0).contains(&y)
        && w > 0.0
        && w <= 4.0
        && h > 0.0
        && h <= 4.0)
    {
        return None;
    }
    Some(SceneRect { x, y, w, h })
}

/// A region on the canvas: inside it, with some size.
pub fn scene_region(value: &Value) -> Option<SceneRect> {
    let rect = scene_rect(value)?;
    if rect.x >= 0.0
        && rect.y >= 0.0
        && rect.w >= 0.05
        && rect.h >= 0.05
        && rect.x + rect.w <= 1.00001
        && rect.y + rect.h <= 1.00001
    {
        Some(rect)
    } else {
        None
    }
}

fn scene_crop(value: &Value) -> Option<SceneCrop> {
    let object = as_map(value)?;
    let l = finite(object.get("l")?)?;
    let t = finite(object.get("t")?)?;
    let r = finite(object.get("r")?)?;
    let b = finite(object.get("b")?)?;
    for n in [l, t, r, b] {
        if !(0.0..0.95).contains(&n) {
            return None;
        }
    }
    if l + r >= 0.95 || t + b >= 0.95 {
        return None;
    }
    Some(SceneCrop { l, t, r, b })
}

fn scene_mask(value: &Value) -> Option<SceneMask> {
    let object = as_map(value)?;
    match object.get("shape").and_then(Value::as_str)? {
        "rectangle" => Some(SceneMask::Rectangle),
        "circle" => Some(SceneMask::Circle),
        "rounded" => {
            let radius = finite(object.get("radius")?)?;
            (0.0..=0.5)
                .contains(&radius)
                .then_some(SceneMask::Rounded { radius })
        }
        _ => None,
    }
}

/// `parseSceneGuests`.
pub fn parse_scene_guests(value: &Value) -> Option<SceneGuests> {
    let object = as_map(value)?;
    let host = scene_region(object.get("host")?)?;
    let region = scene_region(object.get("region")?)?;
    let slots = object.get("slots").and_then(Value::as_array)?;
    if slots.len() > SCENE_MAX_GUEST_SLOTS {
        return None;
    }
    let slots = slots.iter().map(scene_region).collect::<Option<Vec<_>>>()?;
    Some(SceneGuests {
        host,
        region,
        slots,
    })
}

/// `parseCloudScene`.
pub fn parse_cloud_scene(value: &Value) -> Option<CloudScene> {
    let object = as_map(value)?;
    let id = object.get("id").and_then(Value::as_str)?;
    if id.len() != 8 || !id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        return None;
    }
    let items_value = object.get("items").and_then(Value::as_array)?;
    if items_value.len() > 2 {
        return None;
    }
    let guests = parse_scene_guests(object.get("guests")?)?;
    let background = match object.get("background") {
        None => None,
        Some(background) => Some(parse_scene_background(background)?),
    };
    let mut items = Vec::with_capacity(items_value.len());
    for item in items_value {
        let item = as_map(item)?;
        let role = match item.get("role").and_then(Value::as_str)? {
            "host-camera" => SceneRole::HostCamera,
            "screen" => SceneRole::Screen,
            _ => return None,
        };
        if items.iter().any(|other: &SceneItem| other.role == role) {
            return None;
        }
        let rect = scene_rect(item.get("rect")?)?;
        let crop = scene_crop(item.get("crop")?)?;
        let fit = match item.get("fit").and_then(Value::as_str)? {
            "contain" => SceneFit::Contain,
            "cover" => SceneFit::Cover,
            _ => return None,
        };
        let mirror = item.get("mirror").and_then(Value::as_bool)?;
        let z = safe_integer(item.get("z")?)?;
        if !(0..=16).contains(&z) {
            return None;
        }
        let mask = scene_mask(item.get("mask")?)?;
        items.push(SceneItem {
            role,
            rect,
            crop,
            fit,
            mirror,
            mask,
            z,
        });
    }
    Some(CloudScene {
        id: id.to_string(),
        items,
        guests,
        background,
    })
}

/// `parseSceneCapability`.
pub fn parse_scene_capability(value: &Value) -> Option<SceneCapability> {
    let object = as_map(value)?;
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let output = match object.get("output").and_then(Value::as_str)? {
        "stream" => SceneOutput::Stream,
        "recording" => SceneOutput::Recording,
        _ => return None,
    };
    let orientation = match object.get("orientation").and_then(Value::as_str)? {
        "h" => SceneOrientation::H,
        "v" => SceneOrientation::V,
        _ => return None,
    };
    let applied = match object.get("applied") {
        None => None,
        Some(applied) => {
            let applied = as_map(applied)?;
            Some(SceneApplied {
                publisher_sid: sid(applied.get("publisherSid")?)?.to_string(),
                revision: positive(applied.get("revision")?)?,
            })
        }
    };
    let background = match object.get("background") {
        None => None,
        Some(background) => Some(parse_background_capability(background)?),
    };
    Some(SceneCapability {
        version: 1,
        output,
        orientation,
        applied,
        background,
    })
}

/// `parseSceneSnapshot`.
pub fn parse_scene_snapshot(value: &Value, page: &ScenePage) -> Option<SceneSnapshot> {
    let object = as_map(value)?;
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    if object.get("show").and_then(Value::as_str) != Some(page.show.as_str()) {
        return None;
    }
    let publisher_sid = sid(object.get("publisherSid")?)?;
    if publisher_sid != page.publisher_sid {
        return None;
    }
    let revision = positive(object.get("revision")?)?;
    let output = match object.get("output").and_then(Value::as_str)? {
        "stream" => SceneOutput::Stream,
        "recording" => SceneOutput::Recording,
        _ => return None,
    };
    if output != page.output {
        return None;
    }
    let orientation = match object.get("orientation").and_then(Value::as_str)? {
        "h" => SceneOrientation::H,
        "v" => SceneOrientation::V,
        _ => return None,
    };
    if orientation != page.orientation {
        return None;
    }
    let expires_at = positive(object.get("expiresAt")?)?;
    if expires_at <= page.now || expires_at > page.now + SCENE_LEASE_MS {
        return None;
    }
    let transition = as_map(object.get("transition")?)?;
    let kind = match transition.get("kind").and_then(Value::as_str)? {
        "cut" => SceneTransitionKind::Cut,
        "motion" => SceneTransitionKind::Motion,
        _ => return None,
    };
    let duration_ms = safe_integer(transition.get("durationMs")?)?;
    if !(0..=SCENE_MOTION_MAX_MS).contains(&duration_ms) {
        return None;
    }
    if kind == SceneTransitionKind::Cut && duration_ms != 0 {
        return None;
    }
    let apply_at = positive(transition.get("applyAt")?)?;
    // TS: `value.scene !== null` — missing/`undefined` fails parseCloudScene;
    // explicit null is a clear.
    let scene = match object.get("scene") {
        None => return None,
        Some(Value::Null) => None,
        Some(scene) => Some(parse_cloud_scene(scene)?),
    };
    Some(SceneSnapshot {
        version: 1,
        show: page.show.clone(),
        publisher_sid: page.publisher_sid.clone(),
        revision,
        output: page.output,
        orientation: page.orientation,
        expires_at,
        scene,
        transition: SceneTransition {
            kind,
            duration_ms,
            apply_at,
        },
    })
}

/// `parseCloudSceneExtension`.
pub fn parse_cloud_scene_extension(value: &Value) -> Option<CloudSceneExtension> {
    let object = as_map(value)?;
    if object.get("version").and_then(Value::as_u64) != Some(u64::from(SCENE_EXTENSION_VERSION)) {
        return None;
    }
    let guests = parse_scene_guests(object.get("guests")?)?;
    Some(CloudSceneExtension {
        version: SCENE_EXTENSION_VERSION,
        guests,
    })
}

/// FNV-1a 32, 8 hex: the same key the S6 stage uses.
pub fn scene_key(text: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in text.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

fn js_numberize(value: &mut Value) {
    match value {
        Value::Number(number) => {
            if let Some(n) = number.as_f64() {
                *value = js_value::number_value(n);
            }
        }
        Value::Array(items) => {
            for item in items {
                js_numberize(item);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                js_numberize(item);
            }
        }
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
}

fn js_stringify(value: Value) -> String {
    let mut value = value;
    js_numberize(&mut value);
    serde_json::to_string(&value).expect("scene content is JSON")
}

/// Content of a scene without its id: equal content is one picture.
pub fn scene_content_key(scene: Option<&CloudScene>) -> String {
    let Some(scene) = scene else {
        return "none".to_string();
    };
    let items = serde_json::to_value(&scene.items).expect("scene items");
    let guests = serde_json::to_value(&scene.guests).expect("scene guests");
    let payload = match &scene.background {
        Some(background) => {
            let background = serde_json::to_value(background).expect("scene background");
            Value::Array(vec![items, guests, background])
        }
        None => Value::Array(vec![items, guests]),
    };
    scene_key(&js_stringify(payload))
}

/// Content key from items + guests (+ optional background), matching TS field order.
pub fn scene_content_key_parts(
    items: &[SceneItem],
    guests: &SceneGuests,
    background: Option<&SceneBackground>,
) -> String {
    let items = serde_json::to_value(items).expect("scene items");
    let guests = serde_json::to_value(guests).expect("scene guests");
    let payload = match background {
        Some(background) => {
            let background = serde_json::to_value(background).expect("scene background");
            Value::Array(vec![items, guests, background])
        }
        None => Value::Array(vec![items, guests]),
    };
    scene_key(&js_stringify(payload))
}

/// Stable guest layout for a scene saved before guest roles (D7).
pub fn default_scene_guests(orientation: SceneOrientation) -> SceneGuests {
    match orientation {
        SceneOrientation::H => SceneGuests {
            host: SceneRect {
                x: 0.0,
                y: 0.125,
                w: 0.75,
                h: 0.75,
            },
            region: SceneRect {
                x: 0.75,
                y: 0.0,
                w: 0.25,
                h: 1.0,
            },
            slots: Vec::new(),
        },
        SceneOrientation::V => SceneGuests {
            host: SceneRect {
                x: 0.15,
                y: 0.0,
                w: 0.7,
                h: 0.7,
            },
            region: SceneRect {
                x: 0.0,
                y: 0.7,
                w: 1.0,
                h: 0.3,
            },
            slots: Vec::new(),
        },
    }
}
