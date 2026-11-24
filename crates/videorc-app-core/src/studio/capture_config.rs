//! The capture config as Electron holds it (plan 220 S3.0d): `CaptureConfig`
//! in `lib/capture.ts`, read through `loadCaptureConfig` and its
//! normalizers, written through `persistableCaptureConfig`.
//!
//! **The model is the JSON.** The renderer keeps the config as a plain
//! object: `loadCaptureConfig` spreads the stored JSON over the defaults
//! (every top-level field it does not know survives, and so does every
//! unknown field of `sources` and `layout`), repairs each known field, and
//! every edit (`setCaptureConfig`) changes that object and stores
//! `JSON.stringify(persistableCaptureConfig(config))`. The Rust model does
//! exactly that on a [`serde_json::Value`]: [`load_capture_config`] is
//! `loadCaptureConfig`, an edit patches the loaded object in place, and
//! [`persistable_capture_config`] is the writer. Nothing is ever written back
//! from a typed struct, so nothing Electron keeps is lost, and what
//! Electron's normalizers drop (an unknown field inside `audio`, `video`,
//! `captions`, `replayBuffer`, `separateSourceRecordings` or a stream
//! target) is dropped here too: the stored JSON is the one Electron's writer
//! produces for the same edits (`protocol-fixtures/settings-model-parity.json`).
//!
//! [`CaptureConfig`] is the typed view a start reads, built from the loaded
//! object section by section.
//!
//! Every function keeps its TypeScript name in its doc line; the repair
//! rules (defaults, clamps, migrations) are byte for byte the renderer's.
//! JavaScript's conversions (`Number()`, `Math.round`, spreads, `trim`,
//! `Date.parse`) come from [`super::js_value`].

use std::collections::BTreeMap;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use videorc_protocol::streaming::StreamingSettings;
use videorc_protocol::{
    AudioSettings, LayoutPreset, LayoutSettings, RtmpPreset, SeparateSourceRecordingsSettings,
    SourceSelection, VerticalScreenFraming, VideoSettings, default_layout_settings,
};

use super::camera_background::{normalize_camera_background, normalize_camera_key_edges};
use super::js_value::{
    bool_or, clamp_number, date_parses, finite_number, get, is_nullish, is_object_like, json_parse,
    number_value, or_nullish, spread_entries, spread_into, stored_text, string, to_number, trim,
    truthy,
};

/// `videoPresets`: name, width, height, fps, bitrate (kbps).
pub const VIDEO_PRESETS: [(&str, u32, u32, u32, u32); 14] = [
    ("tutorial-540p30", 960, 540, 30, 2500),
    ("tutorial-720p30", 1280, 720, 30, 4000),
    ("tutorial-1080p30", 1920, 1080, 30, 6000),
    ("tutorial-1440p30", 2560, 1440, 30, 8000),
    ("record-4k30", 3840, 2160, 30, 30000),
    ("record-4k60-experimental", 3840, 2160, 60, 50000),
    ("stream-safe-1080p30", 1920, 1080, 30, 6000),
    ("stream-safe-1080p60", 1920, 1080, 60, 6000),
    ("stream-youtube-1080p30", 1920, 1080, 30, 10000),
    ("stream-youtube-1080p60", 1920, 1080, 60, 12000),
    ("stream-youtube-4k30", 3840, 2160, 30, 30000),
    ("stream-1080p60", 1920, 1080, 60, 9000),
    ("vertical-1080x1920", 1080, 1920, 30, 9000),
    ("custom", 1920, 1080, 30, 6000),
];

/// `HORIZONTAL_LAYOUT_PRESETS` (`shared/backend.ts`).
pub const HORIZONTAL_LAYOUT_PRESETS: [&str; 4] = [
    "screen-camera",
    "screen-only",
    "camera-only",
    "side-by-side",
];

/// `VERTICAL_LAYOUT_PRESETS`.
pub const VERTICAL_LAYOUT_PRESETS: [&str; 6] = [
    "vertical-camera-top",
    "vertical-camera-bottom",
    "vertical-split",
    "vertical-screen-camera",
    "vertical-screen-only",
    "vertical-camera-only",
];

/// `rtmpDefaults.youtube`.
pub const RTMP_DEFAULT_YOUTUBE: &str = "rtmp://a.rtmp.youtube.com/live2";
const RTMP_DEFAULT_TWITCH: &str = "rtmp://live.twitch.tv/app";
const RTMP_DEFAULT_KICK: &str = "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app";
/// `FACEBOOK_STREAM_SERVER_URL`.
const FACEBOOK_STREAM_SERVER_URL: &str = "rtmps://live-api-s.facebook.com:443/rtmp/";

/// `STREAM_PLATFORMS` (`shared/stream-platforms.ts`).
pub const STREAM_PLATFORMS: [&str; 8] = [
    "youtube",
    "twitch",
    "kick",
    "x",
    "facebook",
    "tiktok",
    "instagram",
    "custom",
];

/// One built-in destination card (`STREAM_TARGET_DEFS`).
#[derive(Debug, Clone, Copy)]
pub struct StreamTargetDef {
    pub id: &'static str,
    pub platform: &'static str,
    pub label: &'static str,
    pub server_url: &'static str,
    /// `outputOrientation: 'vertical'`; the others carry none.
    pub vertical: bool,
}

/// `STREAM_TARGET_DEFS`, in card order.
pub const STREAM_TARGET_DEFS: [StreamTargetDef; 9] = [
    def("youtube", "youtube", "YouTube", RTMP_DEFAULT_YOUTUBE, false),
    def("twitch", "twitch", "Twitch", RTMP_DEFAULT_TWITCH, false),
    def("kick", "kick", "Kick", RTMP_DEFAULT_KICK, false),
    def("x", "x", "X", "", false),
    def(
        "facebook",
        "facebook",
        "Facebook",
        FACEBOOK_STREAM_SERVER_URL,
        false,
    ),
    def(
        "youtube-vertical",
        "youtube",
        "YouTube Vertical",
        RTMP_DEFAULT_YOUTUBE,
        true,
    ),
    def("tiktok", "tiktok", "TikTok", "", true),
    def(
        "instagram",
        "instagram",
        "Instagram",
        "rtmps://live-upload.instagram.com:443/rtmp/",
        true,
    ),
    def("custom", "custom", "Custom RTMP", "", false),
];

const fn def(
    id: &'static str,
    platform: &'static str,
    label: &'static str,
    server_url: &'static str,
    vertical: bool,
) -> StreamTargetDef {
    StreamTargetDef {
        id,
        platform,
        label,
        server_url,
        vertical,
    }
}

/// `MICROPHONE_SYNC_OFFSET_MIN_MS` / `MAX_MS`.
pub const MICROPHONE_SYNC_OFFSET_MIN_MS: f64 = -1000.0;
pub const MICROPHONE_SYNC_OFFSET_MAX_MS: f64 = 1000.0;
/// `SYSTEM_AUDIO_GAIN_DB_DEFAULT` / `MIN` / `MAX` (`shared/backend.ts`).
pub const SYSTEM_AUDIO_GAIN_DB_DEFAULT: f64 = -6.0;
pub const SYSTEM_AUDIO_GAIN_DB_MIN: f64 = -24.0;
pub const SYSTEM_AUDIO_GAIN_DB_MAX: f64 = 12.0;

const DEFAULT_VIDEO_PRESET: &str = "tutorial-1080p30";
const DEFAULT_LAST_HORIZONTAL_PRESET: &str = "screen-camera";
const DEFAULT_LAST_VERTICAL_PRESET: &str = "vertical-camera-top";

fn video_preset_spec(name: &str) -> Option<(&'static str, u32, u32, u32, u32)> {
    VIDEO_PRESETS
        .iter()
        .copied()
        .find(|(preset, ..)| *preset == name)
}

/// `videoPresets[name]` as the renderer's object.
pub fn video_preset(name: &str) -> Option<Value> {
    video_preset_spec(name).map(|(preset, width, height, fps, bitrate)| {
        json!({
            "preset": preset,
            "width": width,
            "height": height,
            "fps": fps,
            "bitrateKbps": bitrate,
        })
    })
}

fn is_youtube_provider_preset(preset: &str) -> bool {
    matches!(
        preset,
        "stream-youtube-1080p30" | "stream-youtube-1080p60" | "stream-youtube-4k30"
    )
}

/// `isLayoutPreset`.
pub fn is_layout_preset(value: Option<&Value>) -> bool {
    string(value).is_some_and(|preset| {
        HORIZONTAL_LAYOUT_PRESETS.contains(&preset) || VERTICAL_LAYOUT_PRESETS.contains(&preset)
    })
}

/// `layoutPresetOrientation(preset) === 'vertical'`.
pub fn layout_preset_is_vertical(preset: &str) -> bool {
    VERTICAL_LAYOUT_PRESETS.contains(&preset)
}

/// `isPlatformOAuthAvailable`: Facebook, TikTok, Instagram and Custom RTMP
/// use a stream key only.
pub fn is_platform_oauth_available(platform: &str) -> bool {
    !matches!(platform, "facebook" | "custom" | "tiktok" | "instagram")
}

// --- the defaults ---

/// `defaultCaptureConfig.layout`.
pub fn default_layout() -> Value {
    json!({
        "layoutPreset": "screen-camera",
        "cameraTransformMode": "preset",
        "cameraTransform": null,
        "cameraCorner": "bottom-right",
        "cameraSize": "medium",
        "cameraShape": "rectangle",
        "cameraCornerRadiusPct": 12,
        "cameraAspect": "source",
        "cameraChromaKeyEnabled": false,
        "cameraChromaKeyColor": "#00FF00",
        "cameraChromaKeySimilarityPct": 40,
        "cameraChromaKeySmoothnessPct": 8,
        "cameraChromaKeySpillPct": 10,
        "cameraMargin": 32,
        "cameraFit": "fill",
        "cameraMirror": false,
        "cameraZoom": 100,
        "cameraOffsetX": 0,
        "cameraOffsetY": 0,
        "sideBySideSplit": "70-30",
        "sideBySideCameraSide": "right",
        "verticalScreenFraming": "fill",
        "horizontalScreenFraming": "fit",
        "arrangementMode": "preset",
        "sourceTransformOverrides": {},
        "sourceVisibility": {"camera": true, "capture": true},
    })
}

/// `defaultCaptureConfig.audio`.
pub fn default_audio() -> Value {
    json!({
        "microphoneNoiseSuppression": "off",
        "microphoneGainDb": 0,
        "microphoneMuted": false,
        "microphoneSyncOffsetMs": 0,
        "microphoneSyncOffsetUserSet": false,
        "systemAudioEnabled": false,
        "systemAudioGainDb": SYSTEM_AUDIO_GAIN_DB_DEFAULT as i64,
        "systemAudioEchoGuard": true,
    })
}

/// `makeStreamTarget(def, now)`.
fn make_stream_target(def: &StreamTargetDef, now: &str) -> Map<String, Value> {
    let mut target = Map::new();
    target.insert("id".into(), json!(def.id));
    target.insert("platform".into(), json!(def.platform));
    target.insert("label".into(), json!(def.label));
    target.insert("enabled".into(), json!(false));
    target.insert("serverUrl".into(), json!(def.server_url));
    target.insert("urlMode".into(), json!("server-and-key"));
    target.insert("streamKey".into(), json!(""));
    target.insert("streamKeyPresent".into(), json!(false));
    target.insert("authMode".into(), json!("manual-rtmp"));
    if def.vertical {
        target.insert("outputOrientation".into(), json!("vertical"));
    }
    target.insert("status".into(), json!({"state": "not-configured"}));
    target.insert("createdAt".into(), json!(now));
    target.insert("updatedAt".into(), json!(now));
    target
}

/// `defaultStreamingSettings()`.
pub fn default_streaming_settings(now: &str) -> Value {
    json!({
        "enabled": false,
        "mode": "single",
        "targets": STREAM_TARGET_DEFS
            .iter()
            .map(|def| Value::Object(make_stream_target(def, now)))
            .collect::<Vec<_>>(),
        "defaultOutputPreset": DEFAULT_VIDEO_PRESET,
        "defaultBitrateKbps": 6000,
        "enabledTargetIds": [],
    })
}

/// `defaultCaptionsCaptureSettings()`.
pub fn default_captions_capture_settings() -> Value {
    json!({
        "enabled": false,
        "burnTarget": "stream",
        "styleId": "classic",
        "language": "auto",
        "styleRevision": 0,
        "position": "bottom",
        "textSize": "m",
    })
}

/// `defaultCaptureConfig`. `now` stands for the time `capture.ts` built its
/// default stream targets.
pub fn default_capture_config(now: &str) -> Value {
    json!({
        "sources": {},
        "verticalRestoreVideo": null,
        "layoutFramingMemory": normalize_layout_framing_memory(None, None),
        "lastHorizontalPreset": DEFAULT_LAST_HORIZONTAL_PRESET,
        "lastVerticalPreset": DEFAULT_LAST_VERTICAL_PRESET,
        "simulcastScreenFraming": "fit",
        "simulcastFollowsProgram": true,
        "layout": default_layout(),
        "audio": default_audio(),
        "video": video_preset(DEFAULT_VIDEO_PRESET),
        "recordEnabled": true,
        "separateSourceRecordings": {"enabled": false, "keepCombined": true},
        "streamEnabled": false,
        "rtmpPreset": "youtube",
        "rtmpServerUrl": RTMP_DEFAULT_YOUTUBE,
        "streamKey": "",
        "streaming": default_streaming_settings(now),
        "captions": default_captions_capture_settings(),
        "replayBuffer": {"enabled": true, "explicit": false},
    })
}

// --- loading ---

/// `loadCaptureConfig()`, for the value the store holds under
/// `videorc.captureConfig` (`None` when absent). `loadJson` first: no value
/// or an empty one, or text that is not JSON, is the defaults; otherwise the
/// parsed JSON spread over the defaults. Then every known field is repaired.
pub fn load_capture_config(stored: Option<&Value>, now: &str) -> Value {
    let defaults = default_capture_config(now);
    let mut loaded = defaults.as_object().cloned().unwrap_or_default();
    if let Some(text) = stored_text(stored).filter(|text| !text.is_empty())
        && let Some(parsed) = json_parse(&text)
    {
        spread_into(&mut loaded, &parsed);
    }
    load_from_loaded(&loaded, now)
}

/// The repairs `loadCaptureConfig` makes on `loaded` (the stored JSON over
/// the defaults).
fn load_from_loaded(loaded: &Map<String, Value>, now: &str) -> Value {
    let field = |name: &str| loaded.get(name);
    let mut config = loaded.clone();

    // `const { testPattern, ...loadedSources } = loaded.sources ?? {}`.
    let mut sources = Map::new();
    let empty = json!({});
    for (key, value) in spread_entries(or_nullish(field("sources"), &empty)) {
        if key != "testPattern" {
            sources.insert(key, value);
        }
    }
    sources.insert("testPattern".into(), json!(false));
    config.insert("sources".into(), Value::Object(sources));

    let layout = normalize_layout_settings(field("layout"));
    let vertical =
        string(get(Some(&layout), "layoutPreset")).is_some_and(layout_preset_is_vertical);
    config.insert("audio".into(), normalize_audio_settings(field("audio")));
    config.insert(
        "video".into(),
        coerce_video_to_orientation(&normalize_video_settings(field("video")), vertical),
    );
    config.insert(
        "verticalRestoreVideo".into(),
        if is_nullish(field("verticalRestoreVideo")) {
            Value::Null
        } else {
            coerce_video_to_orientation(
                &normalize_video_settings(field("verticalRestoreVideo")),
                false,
            )
        },
    );
    config.insert(
        "layoutFramingMemory".into(),
        normalize_layout_framing_memory(field("layoutFramingMemory"), Some(&layout)),
    );
    config.insert(
        "lastHorizontalPreset".into(),
        json!(normalize_remembered_preset(
            field("lastHorizontalPreset"),
            false
        )),
    );
    config.insert(
        "lastVerticalPreset".into(),
        json!(normalize_remembered_preset(
            field("lastVerticalPreset"),
            true
        )),
    );
    config.insert(
        "simulcastScreenFraming".into(),
        match string(field("simulcastScreenFraming")) {
            Some(framing @ ("fill" | "fit")) => json!(framing),
            _ => json!("fit"),
        },
    );
    config.insert(
        "simulcastFollowsProgram".into(),
        json!(bool_or(field("simulcastFollowsProgram"), true)),
    );
    config.insert(
        "recordEnabled".into(),
        json!(bool_or(field("recordEnabled"), true)),
    );
    config.insert(
        "separateSourceRecordings".into(),
        normalize_separate_source_recordings(field("separateSourceRecordings")),
    );
    config.insert(
        "streamEnabled".into(),
        json!(bool_or(field("streamEnabled"), false)),
    );
    config.insert(
        "rtmpPreset".into(),
        or_nullish(field("rtmpPreset"), &json!("youtube")).clone(),
    );
    config.insert(
        "rtmpServerUrl".into(),
        or_nullish(field("rtmpServerUrl"), &json!(RTMP_DEFAULT_YOUTUBE)).clone(),
    );
    config.insert(
        "streamKey".into(),
        or_nullish(field("streamKey"), &json!("")).clone(),
    );
    config.insert("streaming".into(), migrate_streaming_settings(loaded, now));
    config.insert(
        "captions".into(),
        normalize_captions_capture_settings(field("captions")),
    );
    config.insert(
        "replayBuffer".into(),
        normalize_replay_buffer_settings(field("replayBuffer")),
    );
    config.insert("layout".into(), layout);
    Value::Object(config)
}

/// `normalizeRememberedPreset`: a per-mode scene memory of its own mode, else
/// the mode's default.
fn normalize_remembered_preset(value: Option<&Value>, vertical: bool) -> String {
    match string(value) {
        Some(preset)
            if is_layout_preset(value) && layout_preset_is_vertical(preset) == vertical =>
        {
            preset.to_string()
        }
        _ if vertical => DEFAULT_LAST_VERTICAL_PRESET.to_string(),
        _ => DEFAULT_LAST_HORIZONTAL_PRESET.to_string(),
    }
}

/// `normalizeCameraTransform`: four finite numbers (`Number()` of each), a
/// positive size, each clamped to 0..1; else `null`.
fn normalize_camera_transform(value: Option<&Value>) -> Option<Map<String, Value>> {
    if !truthy(value) || !is_object_like(value) {
        return None;
    }
    let x = to_number(get(value, "x"));
    let y = to_number(get(value, "y"));
    let width = to_number(get(value, "width"));
    let height = to_number(get(value, "height"));
    if ![x, y, width, height].iter().all(|entry| entry.is_finite()) || width <= 0.0 || height <= 0.0
    {
        return None;
    }
    let unit = |number: f64| number_value(number.clamp(0.0, 1.0));
    let mut transform = Map::new();
    transform.insert("x".into(), unit(x));
    transform.insert("y".into(), unit(y));
    transform.insert("width".into(), unit(width));
    transform.insert("height".into(), unit(height));
    Some(transform)
}

/// `normalizeSourceVisibility`.
pub fn normalize_source_visibility(raw: Option<&Value>) -> Value {
    let value = if truthy(raw) && is_object_like(raw) {
        raw
    } else {
        None
    };
    json!({
        "camera": get(value, "camera") != Some(&Value::Bool(false)),
        "capture": get(value, "capture") != Some(&Value::Bool(false)),
    })
}

/// `normalizeCameraLook` (`lib/camera-look.ts`): each control clamped, a
/// neutral look as none.
pub fn normalize_camera_look(value: Option<&Value>) -> Option<Value> {
    if !truthy(value) || !is_object_like(value) {
        return None;
    }
    let clamp = |raw: Option<&Value>, fallback: f64, min: f64, max: f64| {
        finite_number(raw).map_or(fallback, |number| max.min(min.max(number)))
    };
    let brightness = clamp(get(value, "brightness"), 0.0, -0.25, 0.25);
    let contrast = clamp(get(value, "contrast"), 1.0, 0.5, 1.5);
    let saturation = clamp(get(value, "saturation"), 1.0, 0.0, 2.0);
    if brightness == 0.0 && contrast == 1.0 && saturation == 1.0 {
        return None;
    }
    Some(json!({
        "brightness": number_value(brightness),
        "contrast": number_value(contrast),
        "saturation": number_value(saturation),
    }))
}

/// `normalizeSourceCrop`: each side `Number()`ed, kept when above 0, at most
/// 0.95; a side that crops nothing left out.
pub fn normalize_source_crop(value: Option<&Value>) -> Map<String, Value> {
    let candidate = if truthy(value) && is_object_like(value) {
        value
    } else {
        None
    };
    let mut crop = Map::new();
    for side in ["cropLeft", "cropTop", "cropRight", "cropBottom"] {
        let amount = to_number(get(candidate, side));
        if amount.is_finite() && amount > 0.0 {
            crop.insert(side.into(), number_value(amount.min(0.95)));
        }
    }
    crop
}

/// `normalizeSourceTransformOverrides`: only well-formed entries.
fn normalize_source_transform_overrides(overrides: Option<&Value>) -> Value {
    let Some(Value::Object(entries)) = overrides else {
        return json!({});
    };
    let mut normalized = Map::new();
    for (source_id, value) in entries {
        if source_id.is_empty() {
            continue;
        }
        if let Some(mut transform) = normalize_camera_transform(Some(value)) {
            transform.extend(normalize_source_crop(Some(value)));
            normalized.insert(source_id.clone(), Value::Object(transform));
        }
    }
    Value::Object(normalized)
}

/// `normalizeLayoutSettings`: the defaults, then everything stored (fields it
/// does not know included), then each known field repaired. `cameraLook`
/// comes back only when it is not neutral, `cameraBackground` only when it
/// is not Off (plan 258), and `cameraChromaKeyEdges` only when a side hides
/// something (plan 227 B).
pub fn normalize_layout_settings(layout: Option<&Value>) -> Value {
    let source = if truthy(layout) && is_object_like(layout) {
        layout.cloned().unwrap_or(Value::Null)
    } else {
        json!({})
    };
    let mut candidate = Map::new();
    let mut stored_look = None;
    let mut stored_background = None;
    let mut stored_key_edges = None;
    for (key, value) in spread_entries(&source) {
        match key.as_str() {
            "cameraLook" => stored_look = Some(value),
            // Plan 258 S1 and plan 227 B: repaired below, kept only when set.
            "cameraBackground" => stored_background = Some(value),
            "cameraChromaKeyEdges" => stored_key_edges = Some(value),
            _ => {
                candidate.insert(key, value);
            }
        }
    }
    let candidate_value = Value::Object(candidate.clone());
    let pick = |name: &str| get(Some(&candidate_value), name);
    let defaults = default_layout();
    let default_number = |name: &str| defaults[name].as_f64().unwrap_or(0.0);

    let mut out = defaults.as_object().cloned().unwrap_or_default();
    out.extend(candidate.clone());
    if let Some(look) = normalize_camera_look(stored_look.as_ref()) {
        out.insert("cameraLook".into(), look);
    }
    if let Some(background) = normalize_camera_background(stored_background.as_ref())
        && background["mode"] != "off"
    {
        out.insert("cameraBackground".into(), background);
    }
    if let Some(edges) = normalize_camera_key_edges(stored_key_edges.as_ref()) {
        out.insert("cameraChromaKeyEdges".into(), edges);
    }

    let preset = pick("layoutPreset");
    let layout_preset = if is_layout_preset(preset) {
        preset.cloned().unwrap_or(Value::Null)
    } else if string(preset) == Some("vertical") {
        json!("vertical-camera-top")
    } else {
        defaults["layoutPreset"].clone()
    };
    out.insert("layoutPreset".into(), layout_preset);

    let transform = normalize_camera_transform(pick("cameraTransform"));
    let custom = string(pick("cameraTransformMode")) == Some("custom") && transform.is_some();
    out.insert(
        "cameraTransformMode".into(),
        json!(if custom { "custom" } else { "preset" }),
    );
    out.insert(
        "cameraTransform".into(),
        match transform {
            Some(transform) if custom => Value::Object(transform),
            _ => Value::Null,
        },
    );
    let mut clamped = |name: &str, min: f64, max: f64| {
        let value = clamp_number(pick(name), default_number(name), min, max);
        out.insert(name.into(), number_value(value));
    };
    clamped("cameraMargin", 0.0, 96.0);
    clamped("cameraZoom", 100.0, 200.0);
    clamped("cameraOffsetX", -100.0, 100.0);
    clamped("cameraOffsetY", -100.0, 100.0);
    clamped("cameraCornerRadiusPct", 0.0, 50.0);
    clamped("cameraChromaKeySimilarityPct", 0.0, 100.0);
    clamped("cameraChromaKeySmoothnessPct", 0.0, 100.0);
    clamped("cameraChromaKeySpillPct", 0.0, 100.0);

    let one_of = |name: &str, allowed: &[&str]| -> Value {
        match string(pick(name)) {
            Some(value) if allowed.contains(&value) => json!(value),
            _ => defaults[name].clone(),
        }
    };
    let choices = [
        ("cameraFit", one_of("cameraFit", &["fit", "fill"])),
        (
            "cameraShape",
            one_of("cameraShape", &["rectangle", "rounded", "circle"]),
        ),
        (
            "cameraAspect",
            one_of("cameraAspect", &["source", "square", "portrait"]),
        ),
        (
            "sideBySideSplit",
            one_of("sideBySideSplit", &["50-50", "60-40", "70-30"]),
        ),
        (
            "sideBySideCameraSide",
            one_of("sideBySideCameraSide", &["left", "right"]),
        ),
        (
            "verticalScreenFraming",
            one_of("verticalScreenFraming", &["fill", "fit"]),
        ),
    ];
    for (name, value) in choices {
        out.insert(name.into(), value);
    }
    out.insert(
        "cameraMirror".into(),
        json!(bool_or(pick("cameraMirror"), false)),
    );
    out.insert(
        "cameraChromaKeyEnabled".into(),
        json!(bool_or(pick("cameraChromaKeyEnabled"), false)),
    );
    let color = string(pick("cameraChromaKeyColor")).filter(|color| {
        color.len() == 7
            && color.starts_with('#')
            && color[1..].chars().all(|c| c.is_ascii_hexdigit())
    });
    out.insert(
        "cameraChromaKeyColor".into(),
        color.map_or_else(|| defaults["cameraChromaKeyColor"].clone(), |c| json!(c)),
    );
    out.insert(
        "horizontalScreenFraming".into(),
        json!(if string(pick("horizontalScreenFraming")) == Some("fill") {
            "fill"
        } else {
            "fit"
        }),
    );
    out.insert(
        "arrangementMode".into(),
        json!(if string(pick("arrangementMode")) == Some("freeform") {
            "freeform"
        } else {
            "preset"
        }),
    );
    out.insert(
        "sourceTransformOverrides".into(),
        normalize_source_transform_overrides(pick("sourceTransformOverrides")),
    );
    out.insert(
        "sourceVisibility".into(),
        normalize_source_visibility(pick("sourceVisibility")),
    );
    Value::Object(out)
}

/// `normalizeMicrophoneSyncOffsetMs`.
pub fn normalize_microphone_sync_offset_ms(value: Option<&Value>, fallback: f64) -> f64 {
    clamp_number(
        value,
        fallback,
        MICROPHONE_SYNC_OFFSET_MIN_MS,
        MICROPHONE_SYNC_OFFSET_MAX_MS,
    )
}

/// `normalizeSystemAudioGainDb`: a number, clamped to -24..+12 dB; anything
/// else -6 dB.
pub fn normalize_system_audio_gain_db(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(_)) => clamp_number(
            value,
            SYSTEM_AUDIO_GAIN_DB_DEFAULT,
            SYSTEM_AUDIO_GAIN_DB_MIN,
            SYSTEM_AUDIO_GAIN_DB_MAX,
        ),
        _ => SYSTEM_AUDIO_GAIN_DB_DEFAULT,
    }
}

/// `normalizeAudioSettings`: a fresh object of the known fields only. The
/// sync offset follows the default (0) until the user set one; System audio
/// is On only for an explicit `true`.
pub fn normalize_audio_settings(audio: Option<&Value>) -> Value {
    let candidate = if truthy(audio) && is_object_like(audio) {
        audio
    } else {
        None
    };
    let user_set = get(candidate, "microphoneSyncOffsetUserSet") == Some(&Value::Bool(true));
    let sync = if user_set {
        normalize_microphone_sync_offset_ms(get(candidate, "microphoneSyncOffsetMs"), 0.0)
    } else {
        0.0
    };
    json!({
        "microphoneNoiseSuppression":
            if string(get(candidate, "microphoneNoiseSuppression")) == Some("rnnoise") {
                "rnnoise"
            } else {
                "off"
            },
        "microphoneGainDb": number_value(clamp_number(
            get(candidate, "microphoneGainDb"), 0.0, -24.0, 24.0,
        )),
        "microphoneMuted": bool_or(get(candidate, "microphoneMuted"), false),
        "microphoneSyncOffsetMs": number_value(sync),
        "microphoneSyncOffsetUserSet": user_set,
        "systemAudioEnabled": get(candidate, "systemAudioEnabled") == Some(&Value::Bool(true)),
        "systemAudioGainDb": number_value(normalize_system_audio_gain_db(
            get(candidate, "systemAudioGainDb"),
        )),
        "systemAudioEchoGuard": get(candidate, "systemAudioEchoGuard") != Some(&Value::Bool(false)),
    })
}

/// JavaScript's `a > b` for two stored values (`normalizeVideoSettings`
/// compares a stored height and width that may not be numbers).
fn js_greater_than(left: &Value, right: &Value) -> bool {
    let primitive = |value: &Value| -> Value {
        match value {
            Value::Array(items) => Value::String(
                items
                    .iter()
                    .map(|item| match item {
                        Value::Null => String::new(),
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(","),
            ),
            Value::Object(_) => Value::String("[object Object]".into()),
            other => other.clone(),
        }
    };
    match (primitive(left), primitive(right)) {
        (Value::String(left), Value::String(right)) => {
            left.encode_utf16().cmp(right.encode_utf16()) == std::cmp::Ordering::Greater
        }
        (left, right) => to_number(Some(&left)) > to_number(Some(&right)),
    }
}

/// `normalizeVideoSettings`: a known preset (else 1080p30); a YouTube
/// provider preset exactly; otherwise each size clamped on its long and
/// short side, so a portrait canvas stays portrait.
pub fn normalize_video_settings(video: Option<&Value>) -> Value {
    let candidate = if truthy(video) && is_object_like(video) {
        video
    } else {
        None
    };
    let (preset, width, height, fps, bitrate) = string(get(candidate, "preset"))
        .and_then(video_preset_spec)
        .or_else(|| video_preset_spec(DEFAULT_VIDEO_PRESET))
        .expect("the default preset is in the table");
    if is_youtube_provider_preset(preset) {
        return video_preset(preset).unwrap_or(Value::Null);
    }
    let fallback_height = json!(height);
    let fallback_width = json!(width);
    let portrait = js_greater_than(
        or_nullish(get(candidate, "height"), &fallback_height),
        or_nullish(get(candidate, "width"), &fallback_width),
    );
    let (min_width, max_width, min_height, max_height) = if portrait {
        (360.0, 2160.0, 640.0, 3840.0)
    } else {
        (640.0, 3840.0, 360.0, 2160.0)
    };
    json!({
        "preset": preset,
        "width": number_value(clamp_number(get(candidate, "width"), f64::from(width), min_width, max_width)),
        "height": number_value(clamp_number(get(candidate, "height"), f64::from(height), min_height, max_height)),
        "fps": number_value(clamp_number(get(candidate, "fps"), f64::from(fps), 24.0, 60.0)),
        "bitrateKbps": number_value(clamp_number(get(candidate, "bitrateKbps"), f64::from(bitrate), 1000.0, 50000.0)),
    })
}

/// `coerceVideoToOrientation`: a canvas that contradicts the mode is
/// transposed and becomes Custom; a square one is never touched.
pub fn coerce_video_to_orientation(video: &Value, vertical: bool) -> Value {
    let width = video.get("width").cloned().unwrap_or(Value::Null);
    let height = video.get("height").cloned().unwrap_or(Value::Null);
    let transpose = if vertical {
        js_greater_than(&width, &height)
    } else {
        js_greater_than(&height, &width)
    };
    if !transpose {
        return video.clone();
    }
    let mut out = video.as_object().cloned().unwrap_or_default();
    out.insert("preset".into(), json!("custom"));
    out.insert("width".into(), height);
    out.insert("height".into(), width);
    Value::Object(out)
}

/// `normalizeLayoutFramingMemory` (`lib/layout-framing-memory.ts`): version
/// 1, one framing per built-in layout. A version-1 memory keeps each
/// layout's own (clamped); anything older seeds only the current layout's.
pub fn normalize_layout_framing_memory(raw: Option<&Value>, current: Option<&Value>) -> Value {
    let data = if truthy(raw) && is_object_like(raw) {
        raw
    } else {
        None
    };
    let version_one = get(data, "version").and_then(Value::as_f64) == Some(1.0);
    let framing = |raw: Option<&Value>| -> Value {
        let candidate = if truthy(raw) && is_object_like(raw) {
            raw
        } else {
            None
        };
        let clamp = |name: &str, fallback: f64, min: f64, max: f64| {
            number_value(
                finite_number(get(candidate, name))
                    .map_or(fallback, |value| min.max(max.min(value))),
            )
        };
        json!({
            "cameraZoom": clamp("cameraZoom", 100.0, 100.0, 200.0),
            "cameraOffsetX": clamp("cameraOffsetX", 0.0, -100.0, 100.0),
            "cameraOffsetY": clamp("cameraOffsetY", 0.0, -100.0, 100.0),
        })
    };
    let mut layouts = Map::new();
    for id in HORIZONTAL_LAYOUT_PRESETS
        .iter()
        .chain(VERTICAL_LAYOUT_PRESETS.iter())
    {
        let source = if version_one {
            get(get(data, "layouts"), id)
        } else if string(get(current, "layoutPreset")) == Some(id) {
            current
        } else {
            None
        };
        layouts.insert((*id).to_string(), framing(source));
    }
    json!({"version": 1, "layouts": layouts})
}

/// `captionsOutputsFromSaved` (#1593): the captions' outputs, from a saved
/// target. `both` and the retired `recording` burn into both outputs;
/// everything else (`off`, `stream`, a pre-R1 `burnInEnabled`, garbage) is
/// the live stream only. Pure and idempotent: it runs on every load.
pub fn captions_outputs_from_saved(saved: Option<&Value>) -> &'static str {
    match saved.and_then(Value::as_str) {
        Some("both" | "recording") => "both",
        _ => "stream",
    }
}

/// `normalizeCaptionsCaptureSettings`: consent only when explicitly given,
/// the outputs from [`captions_outputs_from_saved`], a real legacy object's
/// style Glass.
pub fn normalize_captions_capture_settings(loaded: Option<&Value>) -> Value {
    let present = truthy(loaded);
    let field = |name: &str| get(loaded, name);
    let burn_target = captions_outputs_from_saved(field("burnTarget"));
    let style_id = match string(field("styleId")) {
        Some(style @ ("classic" | "glass" | "lower-third" | "high-contrast")) => style,
        _ if present => "glass",
        _ => "classic",
    };
    let language = string(field("language"))
        .map(trim)
        .filter(|language| !language.is_empty())
        .unwrap_or("auto");
    let style_revision = finite_number(field("styleRevision"))
        .filter(|revision| {
            revision.fract() == 0.0 && revision.abs() <= 9_007_199_254_740_991.0 && *revision >= 0.0
        })
        .unwrap_or(0.0);
    json!({
        "enabled": field("enabled") == Some(&Value::Bool(true)),
        "burnTarget": burn_target,
        "styleId": style_id,
        "language": language,
        "styleRevision": number_value(style_revision),
        "position": if string(field("position")) == Some("top") { "top" } else { "bottom" },
        "textSize": string(field("textSize"))
            .filter(|size| matches!(*size, "s" | "l"))
            .unwrap_or("m"),
    })
}

/// `normalizeReplayBufferSettings`: a stored `seconds` (the removed Length
/// setting) is dropped.
pub fn normalize_replay_buffer_settings(value: Option<&Value>) -> Value {
    json!({
        "enabled": bool_or(get(value, "enabled"), true),
        "explicit": bool_or(get(value, "explicit"), false),
    })
}

/// `normalizeSeparateSourceRecordings`: `keepCombined` is reserved and
/// always true.
pub fn normalize_separate_source_recordings(loaded: Option<&Value>) -> Value {
    json!({
        "enabled": get(loaded, "enabled") == Some(&Value::Bool(true)),
        "keepCombined": true,
    })
}

fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    let hex = |group: &str| group.chars().all(|c| c.is_ascii_hexdigit());
    groups.len() == 5
        && [8, 4, 4, 4, 12]
            .iter()
            .zip(&groups)
            .all(|(len, group)| group.len() == *len && hex(group))
        && matches!(groups[2].as_bytes()[0], b'1'..=b'5')
        && matches!(
            groups[3].as_bytes()[0].to_ascii_lowercase(),
            b'8' | b'9' | b'a' | b'b'
        )
}

/// `normalizeStreamTarget(base, saved)`: the card's identity and status from
/// `base`, each stored field checked; credentials of a sign-in the platform
/// does not offer are dropped.
fn normalize_stream_target(base: &Map<String, Value>, saved: &Value) -> Map<String, Value> {
    let field = |name: &str| get(Some(saved), name);
    let platform = base["platform"].as_str().unwrap_or_default();
    let stream_key = string(field("streamKey")).unwrap_or_default().to_string();
    let secret_ref = string(field("streamKeySecretRef")).map(str::to_string);
    let server_url = match string(field("serverUrl")) {
        Some(url) if !trim(url).is_empty() => json!(url),
        _ => base["serverUrl"].clone(),
    };
    let saved_oauth = string(field("authMode")) == Some("oauth");
    let oauth = saved_oauth && is_platform_oauth_available(platform);
    let oauth_unavailable = saved_oauth && !oauth;
    let output_preset =
        string(field("outputPreset")).filter(|preset| video_preset_spec(preset).is_some());
    let output_bitrate = match output_preset {
        Some(preset) if is_youtube_provider_preset(preset) => {
            video_preset_spec(preset).map(|(.., bitrate)| f64::from(bitrate))
        }
        _ => match field("outputBitrateKbps") {
            Some(Value::Number(_)) => Some(clamp_number(
                field("outputBitrateKbps"),
                6000.0,
                1000.0,
                50000.0,
            )),
            _ => None,
        },
    };
    let account_id = string(field("accountId"));
    let scheduled_event_id = string(field("scheduledEventId")).filter(|id| {
        oauth
            && (platform == "youtube" || platform == "x")
            && account_id.is_some_and(|account| !account.is_empty())
            && is_uuid(id)
    });

    let mut target = base.clone();
    let mut put = |name: &str, value: Option<Value>| match value {
        Some(value) => {
            target.insert(name.into(), value);
        }
        None => {
            target.remove(name);
        }
    };
    put(
        "label",
        Some(match string(field("label")) {
            Some(label) if !label.is_empty() => json!(label),
            _ => base["label"].clone(),
        }),
    );
    put("enabled", Some(json!(bool_or(field("enabled"), false))));
    put("serverUrl", Some(server_url));
    put(
        "urlMode",
        Some(json!(if string(field("urlMode")) == Some("full-url") {
            "full-url"
        } else {
            "server-and-key"
        })),
    );
    put(
        "streamKey",
        Some(json!(if oauth_unavailable {
            ""
        } else {
            stream_key.as_str()
        })),
    );
    put(
        "streamKeySecretRef",
        if oauth_unavailable {
            None
        } else {
            secret_ref.clone().map(Value::String)
        },
    );
    put(
        "streamKeyPresent",
        Some(json!(
            !oauth_unavailable
                && (!stream_key.is_empty() || secret_ref.as_deref().is_some_and(|r| !r.is_empty()))
        )),
    );
    put(
        "authMode",
        Some(json!(if oauth { "oauth" } else { "manual-rtmp" })),
    );
    let when_oauth = |name: &str| {
        if oauth {
            string(field(name)).map(|value| json!(value))
        } else {
            None
        }
    };
    put("accountId", when_oauth("accountId"));
    put("accountLabel", when_oauth("accountLabel"));
    put("scheduledEventId", scheduled_event_id.map(|id| json!(id)));
    let when_scheduled = |value: Option<&str>| {
        if scheduled_event_id.is_some() {
            value.map(|value| json!(value))
        } else {
            None
        }
    };
    put(
        "scheduledEventTitle",
        when_scheduled(string(field("scheduledEventTitle"))),
    );
    put(
        "scheduledStartUtc",
        when_scheduled(string(field("scheduledStartUtc")).filter(|start| date_parses(start))),
    );
    put(
        "scheduledPrivacy",
        when_scheduled(
            string(field("scheduledPrivacy"))
                .filter(|privacy| matches!(*privacy, "private" | "unlisted" | "public")),
        ),
    );
    put(
        "scheduledAttemptId",
        when_scheduled(string(field("scheduledAttemptId")).filter(|id| is_uuid(id))),
    );
    put("platformBroadcastId", when_oauth("platformBroadcastId"));
    put("platformStreamId", when_oauth("platformStreamId"));
    put("outputPreset", output_preset.map(|preset| json!(preset)));
    put("outputBitrateKbps", output_bitrate.map(number_value));
    put(
        "outputOrientation",
        match string(field("outputOrientation")) {
            Some(orientation @ ("horizontal" | "vertical")) => Some(json!(orientation)),
            _ => base.get("outputOrientation").cloned(),
        },
    );
    put(
        "createdAt",
        Some(string(field("createdAt")).map_or_else(|| base["createdAt"].clone(), |at| json!(at))),
    );
    put(
        "updatedAt",
        Some(string(field("updatedAt")).map_or_else(|| base["updatedAt"].clone(), |at| json!(at))),
    );
    target
}

/// `normalizeStreamingSettings`: the nine built-in cards, each over what was
/// saved for it (a legacy per-platform target only for the original
/// horizontal cards).
pub fn normalize_streaming_settings(value: Option<&Value>, now: &str) -> Value {
    let candidate = if truthy(value) && is_object_like(value) {
        value
    } else {
        None
    };
    let persisted: &[Value] = match get(candidate, "targets") {
        Some(Value::Array(targets)) => targets,
        _ => &[],
    };
    let targets: Vec<Map<String, Value>> = STREAM_TARGET_DEFS
        .iter()
        .map(|def| {
            let base = make_stream_target(def, now);
            let saved = persisted.iter().find(|target| {
                if !truthy(Some(target)) || !is_object_like(Some(target)) {
                    return false;
                }
                let id = get(Some(target), "id");
                id == Some(&json!(def.id))
                    || (def.id == def.platform
                        && is_nullish(id)
                        && get(Some(target), "platform") == Some(&json!(def.platform)))
            });
            match saved {
                Some(saved) => normalize_stream_target(&base, saved),
                None => base,
            }
        })
        .collect();
    let enabled_ids: Vec<Value> = targets
        .iter()
        .filter(|target| target.get("enabled") == Some(&Value::Bool(true)))
        .filter_map(|target| target.get("id").cloned())
        .collect();
    let default_preset = string(get(candidate, "defaultOutputPreset"))
        .filter(|preset| video_preset_spec(preset).is_some())
        .unwrap_or(DEFAULT_VIDEO_PRESET);
    let default_bitrate = if is_youtube_provider_preset(default_preset) {
        video_preset_spec(default_preset).map_or(6000.0, |(.., bitrate)| f64::from(bitrate))
    } else {
        clamp_number(
            get(candidate, "defaultBitrateKbps"),
            6000.0,
            1000.0,
            50000.0,
        )
    };
    let mut out = Map::new();
    out.insert(
        "enabled".into(),
        json!(bool_or(get(candidate, "enabled"), !enabled_ids.is_empty())),
    );
    out.insert(
        "mode".into(),
        json!(if enabled_ids.len() > 1 {
            "multi"
        } else {
            "single"
        }),
    );
    out.insert(
        "targets".into(),
        Value::Array(targets.into_iter().map(Value::Object).collect()),
    );
    if let Some(selected) = string(get(candidate, "selectedTargetId")) {
        out.insert("selectedTargetId".into(), json!(selected));
    }
    out.insert("defaultOutputPreset".into(), json!(default_preset));
    out.insert("defaultBitrateKbps".into(), number_value(default_bitrate));
    out.insert("enabledTargetIds".into(), Value::Array(enabled_ids));
    Value::Object(out)
}

/// `migrateStreamingSettings(loaded)`: the per-target model normalized; a
/// legacy single-RTMP config moves its server and key into the matching
/// platform's card only.
pub fn migrate_streaming_settings(loaded: &Map<String, Value>, now: &str) -> Value {
    let streaming = loaded.get("streaming");
    if truthy(streaming) && is_object_like(streaming) {
        return normalize_streaming_settings(streaming, now);
    }
    let mut targets: Vec<Map<String, Value>> = STREAM_TARGET_DEFS
        .iter()
        .map(|def| make_stream_target(def, now))
        .collect();
    let legacy_platform = string(loaded.get("rtmpPreset"))
        .filter(|platform| STREAM_PLATFORMS.contains(platform))
        .unwrap_or("youtube");
    let legacy_key = string(loaded.get("streamKey")).unwrap_or_default();
    let legacy_server = string(loaded.get("rtmpServerUrl"))
        .map(trim)
        .unwrap_or_default();
    let enabled = bool_or(loaded.get("streamEnabled"), false);
    let mut enabled_ids = Vec::new();
    if let Some(target) = targets
        .iter_mut()
        .find(|target| target.get("platform") == Some(&json!(legacy_platform)))
    {
        if !legacy_server.is_empty() {
            target.insert("serverUrl".into(), json!(legacy_server));
        }
        target.insert("streamKey".into(), json!(legacy_key));
        target.insert("streamKeyPresent".into(), json!(!legacy_key.is_empty()));
        target.insert("enabled".into(), json!(enabled));
        target.insert("updatedAt".into(), json!(now));
        if enabled {
            enabled_ids.push(target["id"].clone());
        }
    }
    json!({
        "enabled": enabled,
        "mode": "single",
        "targets": targets.into_iter().map(Value::Object).collect::<Vec<_>>(),
        "defaultOutputPreset": DEFAULT_VIDEO_PRESET,
        "defaultBitrateKbps": 6000,
        "enabledTargetIds": enabled_ids,
    })
}

// --- writing ---

/// `wantedSourceSelection`: every stand-in folded back to its pick, no
/// `wanted*` field left (plan 213 E1).
pub fn wanted_source_selection(sources: &Value) -> Value {
    let field = |name: &str| get(Some(sources), name);
    let mut next = Map::new();
    for (key, value) in spread_entries(sources) {
        if !matches!(
            key.as_str(),
            "wantedScreenId"
                | "wantedScreenName"
                | "wantedScreenUuid"
                | "wantedWindowId"
                | "wantedWindowName"
                | "wantedCameraId"
                | "wantedCameraName"
        ) {
            next.insert(key, value);
        }
    }
    let set = |next: &mut Map<String, Value>, name: &str, value: Option<&Value>| match value {
        Some(value) => {
            next.insert(name.into(), value.clone());
        }
        None => {
            next.remove(name);
        }
    };
    let window_stand_in = truthy(field("wantedWindowId")) || truthy(field("wantedWindowName"));
    let screen_stand_in = truthy(field("wantedScreenId")) || truthy(field("wantedScreenName"));
    if window_stand_in {
        set(&mut next, "screenId", None);
        set(&mut next, "screenName", None);
        set(&mut next, "screenUuid", None);
        set(&mut next, "windowId", field("wantedWindowId"));
        set(&mut next, "windowName", field("wantedWindowName"));
    } else if screen_stand_in {
        set(&mut next, "screenId", field("wantedScreenId"));
        set(&mut next, "screenName", field("wantedScreenName"));
        set(&mut next, "screenUuid", field("wantedScreenUuid"));
        set(&mut next, "windowId", None);
        set(&mut next, "windowName", None);
    }
    if truthy(field("wantedCameraId")) || truthy(field("wantedCameraName")) {
        set(&mut next, "cameraId", field("wantedCameraId"));
        set(&mut next, "cameraName", field("wantedCameraName"));
    }
    Value::Object(next)
}

/// `removeUnavailableOAuthState`: a sign-in the platform does not offer
/// becomes a stream-key card with nothing saved.
fn remove_unavailable_oauth_state(target: &Value) -> Value {
    let platform = string(get(Some(target), "platform")).unwrap_or_default();
    let unavailable = string(get(Some(target), "authMode")) == Some("oauth")
        && !is_platform_oauth_available(platform);
    if !unavailable {
        return target.clone();
    }
    let mut out = target.as_object().cloned().unwrap_or_default();
    out.insert("authMode".into(), json!("manual-rtmp"));
    out.insert("streamKey".into(), json!(""));
    out.insert("streamKeyPresent".into(), json!(false));
    for gone in [
        "streamKeySecretRef",
        "accountId",
        "accountLabel",
        "scheduledEventId",
        "scheduledAttemptId",
        "scheduledEventTitle",
        "scheduledStartUtc",
        "scheduledPrivacy",
        "platformBroadcastId",
        "platformStreamId",
    ] {
        out.remove(gone);
    }
    out.insert("status".into(), json!({"state": "not-configured"}));
    Value::Object(out)
}

/// `persistableCaptureConfig`: what the store gets. No camera look or
/// background (both are derived from the settings), no test pattern (a development switch for
/// this run), the sources as picked, and no plain stream key where a secret
/// reference or a sign-in holds it.
pub fn persistable_capture_config(config: &Value) -> Value {
    let mut out = config.as_object().cloned().unwrap_or_default();
    let field = |name: &str| config.get(name);

    let mut layout = Map::new();
    for (key, value) in spread_entries(field("layout").unwrap_or(&Value::Null)) {
        // Plan 258 S1: the camera's background is put on the layout at the
        // output boundary, like the look, and never stored there.
        if key != "cameraLook" && key != "cameraBackground" {
            layout.insert(key, value);
        }
    }
    out.insert("layout".into(), Value::Object(layout));

    let mut sources = match wanted_source_selection(field("sources").unwrap_or(&json!({}))) {
        Value::Object(sources) => sources,
        _ => Map::new(),
    };
    sources.remove("testPattern");
    out.insert("sources".into(), Value::Object(sources));

    let streaming = field("streaming").cloned().unwrap_or(Value::Null);
    let targets: Vec<Value> = match get(Some(&streaming), "targets") {
        Some(Value::Array(targets)) => targets
            .iter()
            .map(|item| {
                let target = remove_unavailable_oauth_state(item);
                let secret_ref = truthy(get(Some(&target), "streamKeySecretRef"));
                if !secret_ref && string(get(Some(&target), "authMode")) != Some("oauth") {
                    return target;
                }
                let mut out = target.as_object().cloned().unwrap_or_default();
                if string(get(Some(&target), "urlMode")) == Some("full-url") {
                    out.insert("serverUrl".into(), json!(""));
                }
                out.insert("streamKey".into(), json!(""));
                out.insert("streamKeyPresent".into(), json!(secret_ref));
                Value::Object(out)
            })
            .collect(),
        // `config.streaming.targets.map` on a config whose streaming lost its
        // targets would throw in the renderer; the loader never builds one.
        _ => Vec::new(),
    };
    let mut streaming_out = Map::new();
    spread_into(&mut streaming_out, &streaming);
    streaming_out.insert("targets".into(), Value::Array(targets.clone()));
    out.insert("streaming".into(), Value::Object(streaming_out));

    let rtmp_preset = field("rtmpPreset");
    let primary = targets
        .iter()
        .find(|target| get(Some(target), "platform") == rtmp_preset && rtmp_preset.is_some());
    let primary_secret =
        primary.is_some_and(|primary| truthy(get(Some(primary), "streamKeySecretRef")));
    if primary.is_some_and(|primary| string(get(Some(primary), "urlMode")) == Some("full-url"))
        && primary_secret
    {
        out.insert("rtmpServerUrl".into(), json!(""));
    }
    let stream_key = match primary {
        Some(primary)
            if string(get(Some(primary), "authMode")) == Some("oauth") || primary_secret =>
        {
            Some(json!(""))
        }
        Some(primary) => match get(Some(primary), "streamKey") {
            Some(key) if !key.is_null() => Some(key.clone()),
            _ => field("streamKey").cloned(),
        },
        None => field("streamKey").cloned(),
    };
    match stream_key {
        Some(key) => {
            out.insert("streamKey".into(), key);
        }
        None => {
            out.remove("streamKey");
        }
    }
    Value::Object(out)
}

/// What the store holds after a write: `JSON.stringify(persistableCaptureConfig(config))`.
pub fn stored_capture_config(config: &Value) -> Value {
    Value::String(
        serde_json::to_string(&persistable_capture_config(config)).unwrap_or_else(|_| "{}".into()),
    )
}

// --- edits ---

/// `{...config, a: {...config.a, b: value}}` along `path`: each object on
/// the way copied (spread), the last key set, or removed for `None` (a key
/// set to `undefined`, which `JSON.stringify` leaves out).
pub fn set_path(config: &mut Value, path: &[&str], value: Option<Value>) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut node = config;
    for key in parents {
        if !node.is_object() {
            let mut spread = Map::new();
            spread_into(&mut spread, node);
            *node = Value::Object(spread);
        }
        let object = node.as_object_mut().expect("made an object above");
        let child = object.entry((*key).to_string()).or_insert(Value::Null);
        if !child.is_object() {
            let mut spread = Map::new();
            spread_into(&mut spread, child);
            *child = Value::Object(spread);
        }
        node = child;
    }
    if !node.is_object() {
        let mut spread = Map::new();
        spread_into(&mut spread, node);
        *node = Value::Object(spread);
    }
    let object = node.as_object_mut().expect("made an object above");
    match value {
        Some(value) => {
            object.insert((*last).to_string(), value);
        }
        None => {
            object.remove(*last);
        }
    }
}

/// The Sources page's development switch (`video-sources.tsx`): on, the
/// screen and window picks are cleared and the test pattern replaces them;
/// off, only the flag changes.
pub fn set_test_pattern(config: &mut Value, on: bool) {
    if on {
        for cleared in [
            "screenId",
            "screenName",
            "screenUuid",
            "windowId",
            "windowName",
        ] {
            set_path(config, &["sources", cleared], None);
        }
    }
    set_path(config, &["sources", "testPattern"], Some(json!(on)));
}

// --- the typed view ---

/// `CaptionsCaptureSettings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionsCaptureSettings {
    pub enabled: bool,
    /// `CaptionsOutputs`: `stream` | `both` (#1593; never `off` or
    /// `recording` again).
    pub burn_target: String,
    pub style_id: String,
    pub language: String,
    pub style_revision: u64,
    /// `top` | `bottom`.
    pub position: String,
    /// `s` | `m` | `l`.
    pub text_size: String,
}

impl Default for CaptionsCaptureSettings {
    fn default() -> Self {
        serde_json::from_value(default_captions_capture_settings())
            .expect("the default captions settings fit their type")
    }
}

/// `ReplayBufferSettings`: the Clips switch (on by default) and whether the
/// user set it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayBufferSettings {
    pub enabled: bool,
    pub explicit: bool,
}

impl Default for ReplayBufferSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            explicit: false,
        }
    }
}

/// `CaptureConfig` in `lib/capture.ts`, typed: the view of the loaded
/// config a start and the pages read. Built section by section from the
/// object [`load_capture_config`] returns; a section whose stored value
/// still does not fit its wire type (a `cameraSize` of `0.25`, which
/// `normalizeLayoutSettings` passes through as the renderer does) reads as
/// that section's default and is named in [`CaptureConfigView::issues`].
/// Never written back: the writer is [`persistable_capture_config`] over the
/// loaded object.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureConfig {
    pub sources: SourceSelection,
    pub layout: LayoutSettings,
    pub audio: AudioSettings,
    pub video: VideoSettings,
    /// The landscape canvas remembered while a vertical scene holds the
    /// output in portrait.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertical_restore_video: Option<VideoSettings>,
    pub last_horizontal_preset: LayoutPreset,
    pub last_vertical_preset: LayoutPreset,
    pub simulcast_screen_framing: VerticalScreenFraming,
    pub simulcast_follows_program: bool,
    /// "Save local recording" (Output page).
    pub record_enabled: bool,
    pub stream_enabled: bool,
    pub separate_source_recordings: SeparateSourceRecordingsSettings,
    /// The legacy single-RTMP fields the renderer still sends (`rtmp`):
    /// the preset as stored (see [`CaptureConfig::rtmp`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rtmp_preset: Option<String>,
    pub rtmp_server_url: String,
    pub stream_key: String,
    /// `None` only when the stored destinations do not fit the wire type.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming: Option<StreamingSettings>,
    pub captions: CaptionsCaptureSettings,
    pub replay_buffer: ReplayBufferSettings,
    /// Every top-level field the type does not name (`layoutFramingMemory`,
    /// fields a newer build wrote), as loaded.
    #[serde(flatten)]
    pub rest: BTreeMap<String, Value>,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        CaptureConfigView::from_loaded(&load_capture_config(None, DEFAULT_NOW)).config
    }
}

impl CaptureConfig {
    /// The legacy `rtmp` block a start sends: the stored preset (Custom when
    /// it is not one the backend knows), server and key, trimmed.
    pub fn rtmp(&self) -> videorc_protocol::RtmpSettings {
        videorc_protocol::RtmpSettings {
            preset: self
                .rtmp_preset
                .as_ref()
                .and_then(|preset| serde_json::from_value(json!(preset)).ok())
                .unwrap_or(RtmpPreset::Custom),
            server_url: trim(&self.rtmp_server_url).to_string(),
            stream_key: trim(&self.stream_key).to_string(),
        }
    }
}

/// The time the defaults' stream targets carry when no clock is at hand.
const DEFAULT_NOW: &str = "1970-01-01T00:00:00.000Z";

const TYPED_FIELDS: [&str; 18] = [
    "sources",
    "layout",
    "audio",
    "video",
    "verticalRestoreVideo",
    "lastHorizontalPreset",
    "lastVerticalPreset",
    "simulcastScreenFraming",
    "simulcastFollowsProgram",
    "recordEnabled",
    "streamEnabled",
    "separateSourceRecordings",
    "rtmpPreset",
    "rtmpServerUrl",
    "streamKey",
    "streaming",
    "captions",
    "replayBuffer",
];

/// The typed view and what did not fit it.
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureConfigView {
    pub config: CaptureConfig,
    /// One sentence per section that read as its default.
    pub issues: Vec<String>,
}

impl CaptureConfigView {
    /// The typed view of a loaded config (what [`load_capture_config`]
    /// returns, or the Studio's edited copy of it).
    pub fn from_loaded(loaded: &Value) -> Self {
        let mut issues = Vec::new();
        let object = loaded.as_object().cloned().unwrap_or_default();
        fn section<T: DeserializeOwned>(
            object: &Map<String, Value>,
            name: &str,
            fallback: impl FnOnce() -> T,
            issues: &mut Vec<String>,
        ) -> T {
            match object.get(name).map(|value| T::deserialize(value)) {
                Some(Ok(value)) => value,
                Some(Err(error)) => {
                    issues.push(format!(
                        "The capture config's {name} reads as its default: {error}"
                    ));
                    fallback()
                }
                None => fallback(),
            }
        }
        let default_video = || {
            serde_json::from_value(video_preset(DEFAULT_VIDEO_PRESET).unwrap_or(Value::Null))
                .expect("the default preset fits VideoSettings")
        };
        let config = CaptureConfig {
            sources: section(
                &object,
                "sources",
                || SourceSelection {
                    screen_id: None,
                    window_id: None,
                    camera_id: None,
                    microphone_id: None,
                    test_pattern: false,
                },
                &mut issues,
            ),
            layout: section(&object, "layout", default_layout_settings, &mut issues),
            audio: section(&object, "audio", AudioSettings::default, &mut issues),
            video: section(&object, "video", default_video, &mut issues),
            vertical_restore_video: section(&object, "verticalRestoreVideo", || None, &mut issues),
            last_horizontal_preset: section(
                &object,
                "lastHorizontalPreset",
                || LayoutPreset::ScreenCamera,
                &mut issues,
            ),
            last_vertical_preset: section(
                &object,
                "lastVerticalPreset",
                || LayoutPreset::VerticalCameraTop,
                &mut issues,
            ),
            simulcast_screen_framing: section(
                &object,
                "simulcastScreenFraming",
                || VerticalScreenFraming::Fit,
                &mut issues,
            ),
            simulcast_follows_program: section(
                &object,
                "simulcastFollowsProgram",
                || true,
                &mut issues,
            ),
            record_enabled: section(&object, "recordEnabled", || true, &mut issues),
            stream_enabled: section(&object, "streamEnabled", || false, &mut issues),
            separate_source_recordings: section(
                &object,
                "separateSourceRecordings",
                SeparateSourceRecordingsSettings::default,
                &mut issues,
            ),
            rtmp_preset: string(object.get("rtmpPreset")).map(str::to_string),
            rtmp_server_url: string(object.get("rtmpServerUrl"))
                .unwrap_or_default()
                .to_string(),
            stream_key: string(object.get("streamKey"))
                .unwrap_or_default()
                .to_string(),
            streaming: section(&object, "streaming", || None, &mut issues),
            captions: section(
                &object,
                "captions",
                CaptionsCaptureSettings::default,
                &mut issues,
            ),
            replay_buffer: section(
                &object,
                "replayBuffer",
                ReplayBufferSettings::default,
                &mut issues,
            ),
            rest: object
                .iter()
                .filter(|(key, _)| !TYPED_FIELDS.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        };
        Self { config, issues }
    }
}

#[cfg(test)]
#[path = "capture_config_tests.rs"]
mod tests;
