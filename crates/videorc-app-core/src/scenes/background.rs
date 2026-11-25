//! A saved scene's background (`lib/scene-presets.ts`: `snapshotBackground`,
//! `normalizeSavedBackground`, `resolveSavedBackground`), with the ids the
//! renderer's eager bundle knows (`BUNDLED_BACKGROUND_MANIFEST` in
//! `shared/background-import.ts`, `parseLivePosterAssetId` in
//! `shared/live-background-ids.ts`).
//!
//! A saved background never keeps a path: a bundled picture or a live
//! background's poster by its stable id, a managed picture by its id and its
//! file's name (`<id>.<ext>`). The scene's commit sends the backend the
//! managed-asset URL (`videorc-asset://background/<file>`), which the backend
//! resolves inside the app's own roots.

use serde_json::{Map, Value, json};

use crate::studio::js_value::{finite_number, get, number_value, string};

/// `BUNDLED_BACKGROUND_MANIFEST`: id and file.
pub const BUNDLED_BACKGROUNDS: [(&str, &str); 10] = [
    ("builtin-bg-01", "code-demo.webp"),
    ("builtin-bg-02", "product-launch.webp"),
    ("builtin-bg-03", "tutorial.webp"),
    ("builtin-bg-04", "livestream.webp"),
    ("builtin-bg-05", "minimal-desk.webp"),
    ("builtin-bg-06", "podcast.webp"),
    ("builtin-bg-07", "webinar.webp"),
    ("builtin-bg-08", "dark-mode.webp"),
    ("builtin-bg-09", "light-mode.webp"),
    ("builtin-bg-10", "focus.webp"),
];

/// `BUNDLED_BACKGROUND_MANIFEST`'s names, by id (the Images page's preset
/// tiles).
pub fn bundled_background_name(id: &str) -> Option<&'static str> {
    Some(match id {
        "builtin-bg-01" => "Code Demo",
        "builtin-bg-02" => "Product Launch",
        "builtin-bg-03" => "Tutorial",
        "builtin-bg-04" => "Livestream",
        "builtin-bg-05" => "Minimal Desk",
        "builtin-bg-06" => "Podcast",
        "builtin-bg-07" => "Webinar",
        "builtin-bg-08" => "Dark Mode",
        "builtin-bg-09" => "Light Mode",
        "builtin-bg-10" => "Focus",
        _ => return None,
    })
}

/// `LIVE_BACKGROUND_IDS`, in `LIVE_BACKGROUND_DEFAULT_LOOKS`' order.
pub const LIVE_BACKGROUND_IDS: [&str; 10] = [
    "silk",
    "side-rays",
    "plasma-wave",
    "liquid-chrome",
    "line-waves",
    "beams",
    "color-bends",
    "dither",
    "ferrofluid",
    "ghost-fibers",
];

/// The managed-asset URL root a saved background resolves under.
pub const MANAGED_BACKGROUND_ROOT: &str = "videorc-asset://background/";

fn bundled_file(asset_id: &str) -> Option<&'static str> {
    BUNDLED_BACKGROUNDS
        .iter()
        .find(|(id, _)| *id == asset_id)
        .map(|(_, file)| *file)
}

/// `isLiveBackgroundLook`: `^[a-z][a-z0-9-]{0,31}$`.
fn is_look(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some('a'..='z'))
        && text.len() <= 32
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `parseLivePosterAssetId`: `live-<id>-<look>` split back into its
/// background and look. The id list is tried as the regex's alternation is:
/// the first id whose `live-<id>-` prefix leaves a well-formed look.
pub fn parse_live_poster_asset_id(asset_id: &str) -> Option<(&'static str, String)> {
    let rest = asset_id.strip_prefix("live-")?;
    LIVE_BACKGROUND_IDS.iter().find_map(|id| {
        let look = rest.strip_prefix(id)?.strip_prefix('-')?;
        is_look(look).then(|| (*id, look.to_string()))
    })
}

/// `/^[A-Za-z0-9_-]{1,128}$/`.
fn is_asset_id(text: &str) -> bool {
    (1..=128).contains(&text.len())
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A bundled picture or a live background's poster.
pub fn is_bundled(asset_id: &str) -> bool {
    bundled_file(asset_id).is_some() || parse_live_poster_asset_id(asset_id).is_some()
}

/// `encodeURIComponent`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        let c = byte as char;
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`, or the text as it is when it is not well formed
/// (where the renderer's call throws, the scene would not save; a managed
/// path the backend minted never has a stray `%`).
pub fn decode_uri_component(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(hex) = text.get(index + 1..index + 3)
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

/// `snapshotBackground`: the committed background without its path; a
/// managed picture keeps its file's name.
pub fn snapshot_background(effective: Option<&Value>) -> Option<Value> {
    let Some(Value::Object(background)) = effective else {
        return None;
    };
    let mut style: Map<String, Value> = background.clone();
    let managed = style.remove("managedAssetPath");
    let asset_id = string(style.get("assetId")).unwrap_or_default().to_string();
    if !is_bundled(&asset_id) {
        let path = managed
            .as_ref()
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let last = path.rsplit(['/', '\\']).next().unwrap_or_default();
        style.insert("fileName".into(), json!(decode_uri_component(last)));
    }
    Some(Value::Object(style))
}

/// `sameSceneBackground` (#1225): one picture in one style. Key order is
/// not content: the backend's scene replies write a background's keys
/// alphabetically, the registry in declaration order.
pub fn same_scene_background(a: Option<&Value>, b: Option<&Value>) -> bool {
    let a = snapshot_background(a).unwrap_or(Value::Null);
    let b = snapshot_background(b).unwrap_or(Value::Null);
    crate::studio::js_value::canonical_eq(&a, &b)
}

/// Why a saved background was refused.
pub type Invalid = &'static str;

/// `normalizeSavedBackground`: `null` is no background; anything else must
/// name a bundled background, a live background's poster or a managed
/// picture (`<id>.<ext>`), with each look control clamped. A missing
/// background is not `null`: it is refused, as the renderer refuses it.
pub fn normalize_saved_background(raw: Option<&Value>) -> Result<Option<Value>, Invalid> {
    match raw {
        Some(Value::Null) => return Ok(None),
        Some(Value::Object(_)) => {}
        _ => return Err("Invalid saved background"),
    }
    let asset_id = string(get(raw, "assetId"))
        .filter(|id| is_asset_id(id))
        .ok_or("Invalid background identity")?;
    let live = parse_live_poster_asset_id(asset_id);
    let builtin = bundled_file(asset_id).is_some() || live.is_some();
    let file_name = string(get(raw, "fileName"));
    if !builtin
        && !["png", "jpg", "jpeg", "webp"]
            .iter()
            .any(|ext| file_name == Some(&format!("{asset_id}.{ext}")))
    {
        return Err("Invalid managed background descriptor");
    }
    let clamp = |name: &str, fallback: f64, min: f64, max: f64| {
        number_value(finite_number(get(raw, name)).map_or(fallback, |value| value.clamp(min, max)))
    };
    let mut out = Map::new();
    out.insert("assetId".into(), json!(asset_id));
    if !builtin {
        out.insert("fileName".into(), json!(file_name.unwrap_or_default()));
    }
    let fit = string(get(raw, "fit"))
        .filter(|fit| matches!(*fit, "fit" | "stretch"))
        .unwrap_or("fill");
    out.insert("fit".into(), json!(fit));
    out.insert("scale".into(), clamp("scale", 100.0, 50.0, 200.0));
    out.insert("offsetX".into(), clamp("offsetX", 0.0, -100.0, 100.0));
    out.insert("offsetY".into(), clamp("offsetY", 0.0, -100.0, 100.0));
    out.insert("blurPx".into(), clamp("blurPx", 0.0, 0.0, 40.0));
    out.insert("dimPercent".into(), clamp("dimPercent", 0.0, 0.0, 80.0));
    out.insert(
        "saturationPercent".into(),
        clamp("saturationPercent", 100.0, 0.0, 150.0),
    );
    out.insert(
        "vignettePercent".into(),
        clamp("vignettePercent", 0.0, 0.0, 100.0),
    );
    out.insert(
        "visibilityPercent".into(),
        clamp("visibilityPercent", 20.0, 0.0, 40.0),
    );
    if let Some((id, look)) = live {
        let motion = if string(get(get(raw, "live"), "motion")) == Some("normal") {
            "normal"
        } else {
            "calm"
        };
        out.insert(
            "live".into(),
            json!({"id": id, "look": look, "motion": motion}),
        );
    }
    Ok(Some(Value::Object(out)))
}

/// The managed file a saved background names (the bundled picture's file,
/// a live background's poster, an imported picture's own name).
pub fn managed_file_name(saved: &Value) -> Option<String> {
    let asset_id = string(saved.get("assetId"))?;
    if let Some(file) = bundled_file(asset_id) {
        return Some(file.to_string());
    }
    if parse_live_poster_asset_id(asset_id).is_some() {
        return Some(format!("{asset_id}.webp"));
    }
    string(saved.get("fileName")).map(str::to_string)
}

/// `resolveSavedBackground`: the background the commit sends, at its
/// managed-asset URL; `None` for none (or one that no longer reads).
pub fn resolve_saved_background(background: Option<&Value>) -> Option<Value> {
    let normalized = normalize_saved_background(background).ok()??;
    let mut style = normalized.as_object().cloned().unwrap_or_default();
    let file_name = style.remove("fileName");
    let asset_id = string(style.get("assetId")).unwrap_or_default().to_string();
    let name = match (
        bundled_file(&asset_id),
        parse_live_poster_asset_id(&asset_id),
    ) {
        (Some(file), _) => file.to_string(),
        (None, Some(_)) => format!("{asset_id}.webp"),
        (None, None) => file_name
            .as_ref()
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    };
    style.insert(
        "managedAssetPath".into(),
        json!(format!(
            "{MANAGED_BACKGROUND_ROOT}{}",
            encode_uri_component(&name)
        )),
    );
    Some(Value::Object(style))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `keeps immutable bundled backgrounds by stable identity and blocks
    /// arbitrary paths` (`scene-presets.test.ts`).
    #[test]
    fn bundled_backgrounds_keep_their_id_and_paths_never_survive() {
        let bundled = normalize_saved_background(Some(&json!({"assetId": "builtin-bg-02"})))
            .unwrap()
            .unwrap();
        assert_eq!(bundled["assetId"], "builtin-bg-02");
        assert!(bundled.get("fileName").is_none());
        assert_eq!(bundled["visibilityPercent"], 20);
        let resolved = resolve_saved_background(Some(&bundled)).unwrap();
        assert_eq!(
            resolved["managedAssetPath"],
            "videorc-asset://background/product-launch.webp"
        );
        assert!(normalize_saved_background(Some(&json!({"assetId": "../etc"}))).is_err());
        assert!(
            normalize_saved_background(Some(
                &json!({"assetId": "abc", "fileName": "/Users/x/abc.png"})
            ))
            .is_err()
        );
        let managed =
            normalize_saved_background(Some(&json!({"assetId": "abc", "fileName": "abc.png"})))
                .unwrap()
                .unwrap();
        assert_eq!(
            resolve_saved_background(Some(&managed)).unwrap()["managedAssetPath"],
            "videorc-asset://background/abc.png"
        );
        assert_eq!(normalize_saved_background(Some(&Value::Null)), Ok(None));
        assert!(normalize_saved_background(None).is_err());
    }

    /// `round-trips a live background through a saved scene` and `restores
    /// the shader from the poster id when a spec is missing or wrong`.
    #[test]
    fn a_live_background_comes_back_from_its_poster() {
        let saved = normalize_saved_background(Some(&json!({
            "assetId": "live-liquid-chrome-polished",
            "live": {"id": "silk", "look": "x", "motion": "normal"},
            "scale": 500
        })))
        .unwrap()
        .unwrap();
        assert_eq!(
            saved["live"],
            json!({"id": "liquid-chrome", "look": "polished", "motion": "normal"})
        );
        assert_eq!(saved["scale"], 200);
        let resolved = resolve_saved_background(Some(&saved)).unwrap();
        assert_eq!(
            resolved["managedAssetPath"],
            "videorc-asset://background/live-liquid-chrome-polished.webp"
        );
        let snapshot = snapshot_background(Some(&resolved)).unwrap();
        assert!(snapshot.get("fileName").is_none());
        assert!(snapshot.get("managedAssetPath").is_none());
        assert_eq!(
            parse_live_poster_asset_id("live-side-rays-sunbeam"),
            Some(("side-rays", "sunbeam".to_string()))
        );
        assert_eq!(parse_live_poster_asset_id("live-nope-x"), None);
    }

    #[test]
    fn a_managed_picture_keeps_its_file_name() {
        let snapshot = snapshot_background(Some(&json!({
            "assetId": "bg-7",
            "managedAssetPath": "/Users/x/Backgrounds/bg-7%20.png",
            "fit": "fill"
        })))
        .unwrap();
        assert_eq!(snapshot["fileName"], "bg-7 .png");
    }
}
