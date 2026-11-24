//! OBS setup import, O1 (plan: vault "2026-07-07 - Videorc OBS Import Plan"),
//! in the backend since plan 260 S1.5d. Read-only over OBS Studio's own
//! config files, never OBS code (the Phase 0 ADR boundary). Parsing is pure
//! and fixture-tested; only the discovery entry points touch the file system.
//! `.bak` twins are the corruption fallback.
//!
//! Admin only (`obs.discover`, `obs.read`, `obs.readStreamKey`): Electron main
//! asks, then issues the recording folder's capability and imports image
//! sources before the renderer sees the setup. The stream key never rides
//! `obs.read`; `obs.readStreamKey` hands it out once, at apply time.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};

type IniSection = HashMap<String, String>;
type Ini = HashMap<String, IniSection>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ObsPlatform {
    Mac,
    Windows,
    Linux,
}

impl ObsPlatform {
    fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// What `obs_root_path` reads from the environment.
#[derive(Debug, Clone, Default)]
pub(crate) struct ObsRootEnv {
    /// `VIDEORC_OBS_ROOT` (smokes and fixtures).
    pub override_root: Option<String>,
    /// `%APPDATA%` (Windows).
    pub app_data: Option<String>,
    /// `$XDG_CONFIG_HOME` (Linux).
    pub xdg_config_home: Option<String>,
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

impl ObsRootEnv {
    fn from_process() -> Self {
        Self {
            override_root: env_value("VIDEORC_OBS_ROOT"),
            app_data: env_value("APPDATA"),
            xdg_config_home: env_value("XDG_CONFIG_HOME"),
        }
    }
}

fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Where OBS Studio keeps its config: `%APPDATA%\obs-studio` on Windows,
/// `$XDG_CONFIG_HOME/obs-studio` (default `~/.config`) on Linux and
/// `~/Library/Application Support/obs-studio` on macOS. `VIDEORC_OBS_ROOT`
/// overrides it everywhere.
pub(crate) fn obs_root_path(platform: ObsPlatform, env: &ObsRootEnv, home: &Path) -> PathBuf {
    if let Some(root) = &env.override_root {
        return PathBuf::from(root);
    }
    match platform {
        ObsPlatform::Windows => env
            .app_data
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("obs-studio"),
        ObsPlatform::Linux => env
            .xdg_config_home
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("obs-studio"),
        ObsPlatform::Mac => home
            .join("Library")
            .join("Application Support")
            .join("obs-studio"),
    }
}

fn process_obs_root() -> PathBuf {
    obs_root_path(
        ObsPlatform::current(),
        &ObsRootEnv::from_process(),
        &home_dir(),
    )
}

// ---------------------------------------------------------------------------
// INI
// ---------------------------------------------------------------------------

/// A minimal INI parser covering OBS's basic.ini/global.ini shape. A key
/// before any section lands in the `""` section.
pub(crate) fn parse_ini(text: &str) -> Ini {
    let mut sections = Ini::new();
    let mut current = String::new();
    for raw_line in text.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line).trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.len() > 2 && line.starts_with('[') && line.ends_with(']') {
            current = line[1..line.len() - 1].to_string();
            sections.entry(current.clone()).or_default();
            continue;
        }
        if let Some(eq) = line.find('=')
            && eq > 0
        {
            sections.entry(current.clone()).or_default().insert(
                line[..eq].trim().to_string(),
                line[eq + 1..].trim().to_string(),
            );
        }
    }
    sections
}

// ---------------------------------------------------------------------------
// JavaScript's number rules, which OBS's own files were read with
// ---------------------------------------------------------------------------

/// `Number(text)`: blank is 0, junk is NaN.
fn js_number(text: &str) -> f64 {
    let text = text.trim();
    if text.is_empty() {
        return 0.0;
    }
    let unsigned = text.trim_start_matches(['+', '-']);
    let negative = text.starts_with('-');
    if unsigned == "Infinity" && text.len() - unsigned.len() <= 1 {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("inf") || lower.contains("nan") {
        return f64::NAN;
    }
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = lower.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).map_or(f64::NAN, |value| value as f64);
        }
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number.parseFloat(text)`: the longest leading decimal, NaN when none.
fn js_parse_float(text: &str) -> f64 {
    let text = text.trim_start();
    let bytes = text.as_bytes();
    let mut end = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        end = 1;
    }
    if text[end..].starts_with("Infinity") {
        return js_number(&text[..end + "Infinity".len()]);
    }
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count()
    };
    let whole = digits(end);
    end += whole;
    let mut fraction = 0;
    if bytes.get(end) == Some(&b'.') {
        fraction = digits(end + 1);
        if whole > 0 || fraction > 0 {
            end += 1 + fraction;
        }
    }
    if whole == 0 && fraction == 0 {
        return f64::NAN;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let mut exponent = end + 1;
        if matches!(bytes.get(exponent), Some(b'+' | b'-')) {
            exponent += 1;
        }
        let exponent_digits = digits(exponent);
        if exponent_digits > 0 {
            end = exponent + exponent_digits;
        }
    }
    text[..end].parse::<f64>().unwrap_or(f64::NAN)
}

/// `Math.round`: halves go up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// A frame rate of at least 1; a nonsense one reads as 30.
fn whole_fps(value: f64) -> u32 {
    let rounded = js_round(value);
    if rounded.is_nan() {
        return 30;
    }
    rounded.clamp(1.0, f64::from(u32::MAX)) as u32
}

/// OBS's FPS settings as a Videorc-usable integer frame rate.
pub(crate) fn parse_obs_fps(video: &IniSection) -> u32 {
    let get = |key: &str| video.get(key).map(String::as_str);
    let present = |key: &str| get(key).is_some_and(|value| !value.is_empty());
    let kind = get("FPSType").unwrap_or("0");
    if kind == "1" && present("FPSInt") {
        return whole_fps(js_number(get("FPSInt").unwrap_or_default()));
    }
    if kind == "2" && present("FPSNum") && present("FPSDen") {
        let den = js_number(get("FPSDen").unwrap_or_default());
        let den = if den == 0.0 || den.is_nan() { 1.0 } else { den };
        return whole_fps(js_number(get("FPSNum").unwrap_or_default()) / den);
    }
    // "24 NTSC" = 23.976, "29.97", "59.94": round to the container integer.
    let numeric = js_parse_float(get("FPSCommon").unwrap_or("30").trim());
    if numeric.is_finite() && numeric > 0.0 {
        return whole_fps(numeric);
    }
    30
}

/// `String(value ?? fallback)`.
fn js_string(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None | Some(Value::Null) => fallback.to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() < 1e21 => {
                format!("{}", float as i128)
            }
            _ => number.to_string(),
        },
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_string(Some(item), ""),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// Truthy, as JavaScript reads it.
fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// Canvas sizes and positions are JavaScript numbers: whole ones go out as
/// integers.
fn serialize_js_number<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

// ---------------------------------------------------------------------------
// The wire shapes (shared/backend.ts `ObsDiscovery`, `ObsSetup`, …)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ObsSourceKind {
    Display,
    Window,
    Application,
    Camera,
    Microphone,
    Image,
    Browser,
    Text,
    Media,
    Other,
}

/// One OBS input source, reduced to the kinds Videorc can reason about.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObsSource {
    pub name: String,
    pub kind: ObsSourceKind,
    /// The raw OBS source id (`screen_capture`) for the report.
    pub obs_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application_hint: Option<String>,
    /// Main imports it and sends the renderer the managed copy instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_width: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_height: Option<u64>,
}

impl ObsSource {
    fn new(name: String, kind: ObsSourceKind, obs_kind: String) -> Self {
        Self {
            name,
            kind,
            obs_kind,
            device_name: None,
            application_hint: None,
            file_path: None,
            volume: None,
            muted: None,
            preset_width: None,
            preset_height: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObsSceneItem {
    pub source_name: String,
    pub visible: bool,
    #[serde(serialize_with = "serialize_js_number")]
    pub x: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub y: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub scale_x: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub scale_y: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub bounds_type: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub bounds_x: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub bounds_y: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub crop_left: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub crop_top: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub crop_right: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub crop_bottom: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct ObsScene {
    pub name: String,
    pub current: bool,
    pub items: Vec<ObsSceneItem>,
}

/// The renderer's view of OBS's stream service: never the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObsStreamService {
    #[serde(rename = "type")]
    pub service_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    pub has_key: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObsSetup {
    pub collection_name: String,
    #[serde(serialize_with = "serialize_js_number")]
    pub canvas_width: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub canvas_height: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub output_width: f64,
    #[serde(serialize_with = "serialize_js_number")]
    pub output_height: f64,
    pub fps: u32,
    /// Main turns it into a capability and drops it before the renderer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recording_path: Option<String>,
    pub sources: Vec<ObsSource>,
    pub scenes: Vec<ObsScene>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global_mic_device_name: Option<String>,
    pub has_desktop_audio: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<ObsStreamService>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObsDiscovery {
    pub available: bool,
    pub collections: Vec<String>,
    pub profiles: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_collection: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_profile: Option<String>,
}

impl ObsDiscovery {
    fn unavailable() -> Self {
        Self {
            available: false,
            collections: Vec::new(),
            profiles: Vec::new(),
            current_collection: None,
            current_profile: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ObsReadParams {
    pub collection: String,
    pub profile: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ObsReadStreamKeyParams {
    pub profile: String,
}

// ---------------------------------------------------------------------------
// Scene collection
// ---------------------------------------------------------------------------

fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn non_empty_string<'a>(settings: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a str> {
    settings
        .and_then(|settings| settings.get(key))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn classify_source(raw: &Map<String, Value>) -> Option<ObsSource> {
    let obs_kind = js_string(raw.get("id"), "");
    let name = js_string(raw.get("name"), "");
    if obs_kind.is_empty() || name.is_empty() || obs_kind == "scene" || obs_kind == "group" {
        return None;
    }
    let settings = object(raw.get("settings"));
    let text = |key: &str| non_empty_string(settings, key).map(str::to_string);
    let with_mixer = |mut source: ObsSource| {
        source.volume = raw.get("volume").and_then(Value::as_f64);
        source.muted = (raw.get("muted") == Some(&Value::Bool(true))).then_some(true);
        source
    };
    let source = |kind: ObsSourceKind| ObsSource::new(name.clone(), kind, obs_kind.clone());

    match obs_kind.as_str() {
        "screen_capture" => {
            // ScreenCaptureKit: type 0 is a display, 1 a window, 2 an application.
            let capture_type = match settings.and_then(|settings| settings.get("type")) {
                None | Some(Value::Null) => 0.0,
                Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
                Some(Value::String(text)) => js_number(text),
                Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
                Some(_) => f64::NAN,
            };
            if capture_type == 0.0 {
                return Some(source(ObsSourceKind::Display));
            }
            let mut window = source(if capture_type == 2.0 {
                ObsSourceKind::Application
            } else {
                ObsSourceKind::Window
            });
            window.application_hint = text("application")
                .or_else(|| text("window_name"))
                .or_else(|| Some(name.clone()));
            Some(window)
        }
        // Windows (monitor_capture, game_capture), Linux (PipeWire, X11) and
        // the older mac display_capture land on the same Videorc kinds. OBS's
        // PipeWire plugin registers hyphenated ids: screen capture (current),
        // desktop capture (older) and window capture. The current screen
        // capture can pick a monitor or a window and saves only a portal
        // token, so it lands on display and the report says the target is
        // unknown.
        "display_capture"
        | "monitor_capture"
        | "pipewire-screen-capture-source"
        | "pipewire-desktop-capture-source"
        | "xshm_input" => Some(source(ObsSourceKind::Display)),
        "window_capture"
        | "game_capture"
        | "pipewire-window-capture-source"
        | "xcomposite_input" => {
            let mut window = source(ObsSourceKind::Window);
            window.application_hint = text("window_name")
                .or_else(|| text("window"))
                .or_else(|| text("capture_window"))
                .or_else(|| Some(name.clone()));
            Some(window)
        }
        "dshow_input" | "v4l2_input" => {
            // DirectShow ids read "HP HD Camera:\\?\usb#vid_..."; the name is
            // before the first colon. V4L2 carries the node path and names
            // the device aside.
            let mut camera = source(ObsSourceKind::Camera);
            camera.device_name = if obs_kind == "dshow_input" {
                text("video_device_id")
                    .or_else(|| text("device_id"))
                    .and_then(|id| id.split(':').next().map(str::to_string))
                    .filter(|name| !name.is_empty())
            } else {
                text("device_name")
            };
            Some(with_mixer(camera))
        }
        "wasapi_input_capture" | "pulse_input_capture" | "coreaudio_input_capture" => {
            let mut microphone = source(ObsSourceKind::Microphone);
            microphone.device_name = text("device_name");
            Some(with_mixer(microphone))
        }
        "av_capture_input" => {
            // "AVCaptureSessionPreset3840x2160" carries the capture size.
            let mut camera = source(ObsSourceKind::Camera);
            camera.device_name = text("device_name");
            if let Some((width, height)) = text("preset").as_deref().and_then(preset_size) {
                camera.preset_width = Some(width);
                camera.preset_height = Some(height);
            }
            Some(with_mixer(camera))
        }
        "image_source" => {
            let mut image = source(ObsSourceKind::Image);
            image.file_path = text("file");
            Some(image)
        }
        "browser_source" => Some(source(ObsSourceKind::Browser)),
        kind if kind.starts_with("text_") => Some(source(ObsSourceKind::Text)),
        "ffmpeg_source" | "vlc_source" => Some(source(ObsSourceKind::Media)),
        _ => Some(source(ObsSourceKind::Other)),
    }
}

/// The first `Preset<width>x<height>` in `preset`.
fn preset_size(preset: &str) -> Option<(u64, u64)> {
    let digits = |text: &str| -> Option<(u64, usize)> {
        let count = text.bytes().take_while(u8::is_ascii_digit).count();
        (count > 0)
            .then(|| text[..count].parse().ok().map(|value| (value, count)))
            .flatten()
    };
    preset.match_indices("Preset").find_map(|(index, _)| {
        let rest = &preset[index + "Preset".len()..];
        let (width, width_len) = digits(rest)?;
        let rest = rest[width_len..].strip_prefix('x')?;
        let (height, _) = digits(rest)?;
        Some((width, height))
    })
}

fn scene_items(raw: &Map<String, Value>) -> Vec<ObsSceneItem> {
    let Some(items) = object(raw.get("settings"))
        .and_then(|settings| settings.get("items"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let empty = Map::new();
    items
        .iter()
        .map(|item| {
            let record = item.as_object().unwrap_or(&empty);
            let finite = |value: Option<&Value>| {
                value
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite())
            };
            let point = |key: &str, axis: &str| {
                finite(object(record.get(key)).and_then(|point| point.get(axis))).unwrap_or(0.0)
            };
            let number = |key: &str| finite(record.get(key)).unwrap_or(0.0);
            let scale = |axis: &str| {
                let scale = point("scale", axis);
                if scale == 0.0 { 1.0 } else { scale }
            };
            ObsSceneItem {
                source_name: js_string(record.get("name"), ""),
                visible: record.get("visible") != Some(&Value::Bool(false)),
                x: point("pos", "x"),
                y: point("pos", "y"),
                scale_x: scale("x"),
                scale_y: scale("y"),
                bounds_type: number("bounds_type"),
                bounds_x: point("bounds", "x"),
                bounds_y: point("bounds", "y"),
                crop_left: number("crop_left"),
                crop_top: number("crop_top"),
                crop_right: number("crop_right"),
                crop_bottom: number("crop_bottom"),
            }
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ObsCollection {
    pub name: String,
    pub sources: Vec<ObsSource>,
    pub scenes: Vec<ObsScene>,
    pub global_mic_device_name: Option<String>,
    pub has_desktop_audio: bool,
}

/// One scene collection's JSON. Err when it isn't JSON at all.
pub(crate) fn parse_scene_collection(json: &str) -> Result<ObsCollection, String> {
    let doc: Value = serde_json::from_str(json)
        .map_err(|error| format!("The OBS scene collection isn't JSON: {error}"))?;
    if doc.is_null() {
        return Err("The OBS scene collection is empty.".to_string());
    }
    let empty = Map::new();
    let doc = doc.as_object().unwrap_or(&empty);
    let current_scene = js_string(
        doc.get("current_program_scene")
            .filter(|value| !value.is_null())
            .or_else(|| doc.get("current_scene")),
        "",
    );

    let mut sources = Vec::new();
    let mut scenes = Vec::new();
    for raw in doc
        .get("sources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let raw = raw.as_object().unwrap_or(&empty);
        if raw.get("id").and_then(Value::as_str) == Some("scene") {
            let name = js_string(raw.get("name"), "");
            scenes.push(ObsScene {
                current: name == current_scene,
                name,
                items: scene_items(raw),
            });
            continue;
        }
        if let Some(source) = classify_source(raw) {
            sources.push(source);
        }
    }

    let aux = object(doc.get("AuxAudioDevice1"));
    let aux_device = non_empty_string(object(aux.and_then(|aux| aux.get("settings"))), "device_id");
    // Plan 069: OBS's global Desktop Audio becomes Videorc's System audio. A
    // muted one was not being recorded, so it imports as Off.
    let desktop = doc.get("DesktopAudioDevice1");
    let has_desktop_audio = js_truthy(desktop)
        && desktop.and_then(|desktop| desktop.get("muted")) != Some(&Value::Bool(true));
    Ok(ObsCollection {
        name: js_string(doc.get("name"), "OBS collection"),
        sources,
        scenes,
        global_mic_device_name: aux_device
            .filter(|device| *device != "default")
            .map(|_| js_string(aux.and_then(|aux| aux.get("name")), "Mic/Aux")),
        has_desktop_audio,
    })
}

/// OBS's `service.json`, key included: only `obs.readStreamKey` hands it on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ObsService {
    pub stream: ObsStreamService,
    pub key: Option<String>,
}

pub(crate) fn parse_service(json: &str) -> Option<ObsService> {
    let doc: Value = serde_json::from_str(json).ok()?;
    let doc = doc.as_object()?;
    let service_type = doc.get("type").and_then(Value::as_str)?;
    if service_type != "rtmp_common" && service_type != "rtmp_custom" {
        return None;
    }
    let settings = object(doc.get("settings"));
    let field = |key: &str| {
        settings
            .and_then(|settings| settings.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    Some(ObsService {
        stream: ObsStreamService {
            service_type: service_type.to_string(),
            service: field("service"),
            server: field("server"),
            has_key: js_truthy(settings.and_then(|settings| settings.get("key"))),
        },
        key: field("key"),
    })
}

// ---------------------------------------------------------------------------
// The file system
// ---------------------------------------------------------------------------

/// `path`, else its `.bak` twin: never through a symlink, and only inside
/// `allowed_root` once both are resolved.
fn read_with_bak_fallback(path: &Path, allowed_root: &Path) -> Option<String> {
    let mut bak = path.as_os_str().to_owned();
    bak.push(".bak");
    for candidate in [path.to_path_buf(), PathBuf::from(bak)] {
        let Ok(metadata) = fs::symlink_metadata(&candidate) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let (Ok(real), Ok(root)) = (fs::canonicalize(&candidate), fs::canonicalize(allowed_root))
        else {
            continue;
        };
        if !real.starts_with(&root) {
            continue;
        }
        if let Ok(bytes) = fs::read(&candidate) {
            return Some(String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    None
}

/// Entry names in `dir` whose own type (never a link's target) passes `keep`.
fn entry_names(dir: &Path, keep: impl Fn(&fs::FileType) -> bool) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| keep(&kind)))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .collect()
}

pub(crate) fn discover_obs(root: &Path) -> ObsDiscovery {
    let scenes_dir = root.join("basic").join("scenes");
    let profiles_dir = root.join("basic").join("profiles");
    if !scenes_dir.exists() {
        return ObsDiscovery::unavailable();
    }
    let mut collections: Vec<String> = Vec::new();
    for name in entry_names(&scenes_dir, fs::FileType::is_file) {
        let collection = name
            .strip_suffix(".json.bak")
            .or_else(|| name.strip_suffix(".json"));
        if let Some(collection) = collection
            && !collections.iter().any(|known| known == collection)
        {
            collections.push(collection.to_string());
        }
    }
    let profiles = entry_names(&profiles_dir, fs::FileType::is_dir);
    let ini =
        |name: &str| parse_ini(&read_with_bak_fallback(&root.join(name), root).unwrap_or_default());
    let mut basic = ini("global.ini").remove("Basic").unwrap_or_default();
    basic.extend(ini("user.ini").remove("Basic").unwrap_or_default());
    ObsDiscovery {
        available: !collections.is_empty(),
        current_collection: basic
            .get("SceneCollection")
            .cloned()
            .or_else(|| collections.first().cloned()),
        current_profile: basic
            .get("Profile")
            .cloned()
            .or_else(|| profiles.first().cloned()),
        collections,
        profiles,
    }
}

/// `Number(value ?? fallback) || fallback`.
fn size_or(value: Option<&String>, fallback: f64) -> f64 {
    match value.map(|value| js_number(value)) {
        None => fallback,
        Some(size) if size == 0.0 || size.is_nan() => fallback,
        Some(size) => size,
    }
}

/// One collection and profile, both exactly as discovery named them. The
/// stream key stays here: the setup carries `hasKey` only.
pub(crate) fn read_obs_setup(
    collection: &str,
    profile: &str,
    root: &Path,
) -> Result<Option<ObsSetup>, String> {
    let discovery = discover_obs(root);
    if !discovery.collections.iter().any(|name| name == collection)
        || !discovery.profiles.iter().any(|name| name == profile)
    {
        return Ok(None);
    }
    let scenes_root = root.join("basic").join("scenes");
    let profile_root = root.join("basic").join("profiles").join(profile);
    let Some(collection_json) = read_with_bak_fallback(
        &scenes_root.join(format!("{collection}.json")),
        &scenes_root,
    ) else {
        return Ok(None);
    };
    let parsed = parse_scene_collection(&collection_json)?;
    let mut ini = parse_ini(
        &read_with_bak_fallback(&profile_root.join("basic.ini"), &profile_root).unwrap_or_default(),
    );
    let video = ini.remove("Video").unwrap_or_default();
    let service = parse_service(
        &read_with_bak_fallback(&profile_root.join("service.json"), &profile_root)
            .unwrap_or_else(|| "null".to_string()),
    );
    let setting = |section: &str, key: &str| ini.get(section).and_then(|section| section.get(key));
    let recording_path = setting("SimpleOutput", "FilePath")
        .or_else(|| setting("AdvOut", "RecFilePath"))
        .or_else(|| setting("Output", "RecFilePath"))
        .cloned();
    Ok(Some(ObsSetup {
        collection_name: parsed.name,
        canvas_width: size_or(video.get("BaseCX"), 1920.0),
        canvas_height: size_or(video.get("BaseCY"), 1080.0),
        output_width: size_or(video.get("OutputCX").or(video.get("BaseCX")), 1920.0),
        output_height: size_or(video.get("OutputCY").or(video.get("BaseCY")), 1080.0),
        fps: parse_obs_fps(&video),
        recording_path,
        sources: parsed.sources,
        scenes: parsed.scenes,
        global_mic_device_name: parsed.global_mic_device_name,
        has_desktop_audio: parsed.has_desktop_audio,
        service: service.map(|service| service.stream),
    }))
}

pub(crate) fn read_obs_stream_key(profile: &str, root: &Path) -> Option<String> {
    if !discover_obs(root)
        .profiles
        .iter()
        .any(|name| name == profile)
    {
        return None;
    }
    let profile_root = root.join("basic").join("profiles").join(profile);
    parse_service(&read_with_bak_fallback(
        &profile_root.join("service.json"),
        &profile_root,
    )?)?
    .key
}

// ---------------------------------------------------------------------------
// The RPCs, off the async workers
// ---------------------------------------------------------------------------

pub(crate) async fn discover_for_rpc() -> ObsDiscovery {
    tokio::task::spawn_blocking(|| discover_obs(&process_obs_root()))
        .await
        .unwrap_or_else(|_| ObsDiscovery::unavailable())
}

pub(crate) async fn read_setup_for_rpc(params: ObsReadParams) -> Result<Option<ObsSetup>, String> {
    tokio::task::spawn_blocking(move || {
        read_obs_setup(&params.collection, &params.profile, &process_obs_root())
    })
    .await
    .map_err(|error| format!("The OBS read stopped: {error}"))?
}

pub(crate) async fn read_stream_key_for_rpc(params: ObsReadStreamKeyParams) -> Option<String> {
    tokio::task::spawn_blocking(move || read_obs_stream_key(&params.profile, &process_obs_root()))
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests;
