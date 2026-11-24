//! Plan 258 S5 (`lib/camera-background-view.ts`): the words and the rules of
//! the camera's Background control, one module for every place it shows
//! (the Studio's Camera row, the Scene page's Background section, ⌘K and the
//! room). Backgrounds are the normalized JSON
//! ([`super::camera_background::normalize_camera_background`]).

use serde_json::{Value, json};
use videorc_protocol::{CameraBackgroundMode, CameraBackgroundStageState, CameraBackgroundStatus};

use super::camera_background::{
    STRONG_BLUR_PCT, default_camera_background, normalize_camera_background,
};
use super::js_value::{finite_number, string};

/// `CAMERA_BACKGROUND_SLIGHT_BLUR_PCT`.
pub const SLIGHT_BLUR_PCT: f64 = 30.0;

pub const LABEL: &str = "Background";
pub const SETTINGS_LABEL: &str = "Background settings";
pub const CHOOSE_IMAGE_LABEL: &str = "Choose image…";
pub const BLUR_STRENGTH_LABEL: &str = "Blur strength";
pub const WHAT_VIEWERS_SEE_LABEL: &str = "What viewers see";
pub const LOCK_LINE: &str = "Done on this Mac, before anything is recorded or sent.";
pub const DESCRIPTION: &str = "Blurs or replaces what's behind you in the recording, the livestream, Clips, Videorc Camera and the room. This camera keeps it in every scene.";
pub const HINT: &str =
    "Works best with light on your face. Done on this Mac, before anything is recorded or sent.";
/// The blur caveat: a blur never promises the room is gone.
pub const BLUR_CAVEAT: &str =
    "A blur can still show large shapes and colors behind you. For full privacy, pick a picture.";
pub const SCREEN_HINT: &str = "Needs an evenly lit green or blue screen behind you.";
pub const NO_CAMERA: &str = "Choose a camera first.";
/// Rooms before S8: the effects are disabled while a room is open.
pub const ROOM_BACKGROUND_UNAVAILABLE: &str = "Background effects come to rooms in a later update.";
pub const ROOM_CAMERA_OFF_FOR_BACKGROUND: &str = "Background effects come to rooms in a later update, so your camera is off in the room. Turn off the background effect to show it.";
/// `COVER_LINE_AFTER_MS`: how long the cover stands in before the Studio says so.
pub const COVER_LINE_AFTER_MS: u64 = 2000;
/// `CAMERA_BACKGROUND_KEYWORDS`: what people type for it in ⌘K.
pub const KEYWORDS: [&str; 8] = [
    "background",
    "blur",
    "background blur",
    "blur background",
    "virtual background",
    "replace background",
    "background image",
    "privacy",
];

/// The groups, in the order the popover and the Scene page show them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    Blur,
    Images,
    Screens,
}

impl Group {
    /// `CAMERA_BACKGROUND_GROUP_LABELS`.
    pub fn label(self) -> &'static str {
        match self {
            Group::Blur => "Blur",
            Group::Images => "Images",
            Group::Screens => "Screen behind you",
        }
    }
}

/// `CameraBackgroundChoiceId`: the tile a pick lights up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChoiceId {
    Off,
    SlightBlur,
    StrongBlur,
    Green,
    Blue,
    /// A picture: its asset's id.
    Image(String),
}

impl ChoiceId {
    /// As Electron spells it (`image:<assetId>` for a picture).
    pub fn as_string(&self) -> String {
        match self {
            ChoiceId::Off => "off".into(),
            ChoiceId::SlightBlur => "slight-blur".into(),
            ChoiceId::StrongBlur => "strong-blur".into(),
            ChoiceId::Green => "green".into(),
            ChoiceId::Blue => "blue".into(),
            ChoiceId::Image(id) => format!("image:{id}"),
        }
    }
}

/// `CameraBackgroundImage`: one picture from the Images library.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub asset_id: String,
    pub name: String,
    pub picture: Option<String>,
}

/// `CameraBackgroundChoice`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub id: ChoiceId,
    pub group: Group,
    pub label: String,
    pub picture: Option<String>,
    /// Why it can't be picked now.
    pub disabled_reason: Option<&'static str>,
}

fn mode(background: &Value) -> &str {
    string(background.get("mode")).unwrap_or("off")
}

fn blur_pct(background: &Value) -> f64 {
    finite_number(background.get("blurPct")).unwrap_or(STRONG_BLUR_PCT)
}

/// `cameraBackgroundIsEffect`: a blur, a picture, a video or Cut out (what
/// the effect stage draws), as opposed to Off or a screen key.
pub fn is_effect(background: Option<&Value>) -> bool {
    background
        .is_some_and(|background| matches!(mode(background), "blur" | "image" | "video" | "cutout"))
}

/// `cameraBackgroundFor`: the selected camera's background, Off with Strong
/// blur ready when it has none.
pub fn background_for(backgrounds: Option<&Value>, camera_id: Option<&str>) -> Value {
    camera_id
        .filter(|id| !id.is_empty())
        .and_then(|id| normalize_camera_background(backgrounds.and_then(|all| all.get(id))))
        .unwrap_or_else(default_camera_background)
}

/// `platformBackgroundReason` (D13): the stage runs on macOS first.
pub fn platform_reason(platform: Option<&str>) -> Option<&'static str> {
    match platform {
        Some("win32") => Some("Background effects come to Windows in a later update."),
        Some("linux") => Some("Background effects come to Linux in a later update."),
        _ => None,
    }
}

/// `cameraBackgroundChoiceId`: the tile the background lights (the nearer
/// blur mark for a slider value), or none for one no tile shows.
pub fn choice_id(background: &Value) -> Option<ChoiceId> {
    match mode(background) {
        "off" => Some(ChoiceId::Off),
        "blur" => Some(
            if blur_pct(background) <= (SLIGHT_BLUR_PCT + STRONG_BLUR_PCT) / 2.0 {
                ChoiceId::SlightBlur
            } else {
                ChoiceId::StrongBlur
            },
        ),
        "image" => string(background.get("assetId"))
            .filter(|id| !id.is_empty())
            .map(|id| ChoiceId::Image(id.to_string())),
        "green" => Some(ChoiceId::Green),
        "blue" => Some(ChoiceId::Blue),
        _ => None,
    }
}

/// `cameraBackgroundForChoice`: the background a pick makes. Off keeps
/// everything else; a screen keeps its key; Slight and Strong set the
/// strength at their marks.
pub fn background_for_choice(current: &Value, choice: &ChoiceId) -> Value {
    let mut next = current.clone();
    let (mode, blur, asset) = match choice {
        ChoiceId::Off => ("off", None, None),
        ChoiceId::SlightBlur => ("blur", Some(SLIGHT_BLUR_PCT), None),
        ChoiceId::StrongBlur => ("blur", Some(STRONG_BLUR_PCT), None),
        ChoiceId::Green => ("green", None, None),
        ChoiceId::Blue => ("blue", None, None),
        ChoiceId::Image(id) => ("image", None, Some(id.as_str())),
    };
    next["mode"] = json!(mode);
    if let Some(blur) = blur {
        next["blurPct"] = json!(blur as i64);
    }
    if let Some(asset) = asset {
        next["assetId"] = json!(asset);
    }
    next
}

/// `cameraBackgroundValueLabel`: the pick in words.
pub fn value_label(background: &Value, images: &[Image]) -> String {
    match mode(background) {
        "blur" => {
            let pct = blur_pct(background);
            if pct == SLIGHT_BLUR_PCT {
                "Slight blur".into()
            } else if pct == STRONG_BLUR_PCT {
                "Strong blur".into()
            } else {
                format!("Blur {pct}%")
            }
        }
        "image" => {
            let asset = string(background.get("assetId"));
            images
                .iter()
                .find(|image| Some(image.asset_id.as_str()) == asset)
                .map_or_else(|| "Picture".into(), |image| image.name.clone())
        }
        "video" => "Video".into(),
        "cutout" => "Cut out".into(),
        "green" => "Green screen".into(),
        "blue" => "Blue screen".into(),
        _ => "Off".into(),
    }
}

/// `cameraBackgroundChoices`' input.
pub struct ChoicesInput<'a> {
    pub images: &'a [Image],
    pub camera_selected: bool,
    pub room_open: bool,
    pub platform: Option<&'a str>,
    pub image_limit: Option<usize>,
}

/// `cameraBackgroundChoices`: every tile, grouped, with why one can't be
/// picked now. Effects wait for the platform's stage and for a closed room;
/// Off and the two screens always stay. With no camera nothing can be picked.
pub fn choices(input: &ChoicesInput) -> Vec<Choice> {
    let effect_reason = if !input.camera_selected {
        Some(NO_CAMERA)
    } else {
        platform_reason(input.platform).or(input.room_open.then_some(ROOM_BACKGROUND_UNAVAILABLE))
    };
    let any_reason = (!input.camera_selected).then_some(NO_CAMERA);
    let images = match input.image_limit {
        Some(limit) => &input.images[..limit.min(input.images.len())],
        None => input.images,
    };
    let tile = |id: ChoiceId, group: Group, label: &str, reason: Option<&'static str>| Choice {
        id,
        group,
        label: label.into(),
        picture: None,
        disabled_reason: reason,
    };
    let mut out = vec![
        tile(ChoiceId::Off, Group::Blur, "Off", any_reason),
        tile(
            ChoiceId::SlightBlur,
            Group::Blur,
            "Slight blur",
            effect_reason,
        ),
        tile(
            ChoiceId::StrongBlur,
            Group::Blur,
            "Strong blur",
            effect_reason,
        ),
    ];
    out.extend(images.iter().map(|image| Choice {
        id: ChoiceId::Image(image.asset_id.clone()),
        group: Group::Images,
        label: image.name.clone(),
        picture: image.picture.clone(),
        disabled_reason: effect_reason,
    }));
    out.push(tile(
        ChoiceId::Green,
        Group::Screens,
        "Green screen",
        any_reason,
    ));
    out.push(tile(
        ChoiceId::Blue,
        Group::Screens,
        "Blue screen",
        any_reason,
    ));
    out
}

/// `imagesPickedFirst`: the picked picture first, then the rest in library
/// order, so the pick never hides behind Choose image….
pub fn images_picked_first(images: &[Image], picked: Option<&str>) -> Vec<Image> {
    let Some(index) = images
        .iter()
        .position(|image| Some(image.asset_id.as_str()) == picked)
    else {
        return images.to_vec();
    };
    let mut out = vec![images[index].clone()];
    out.extend(
        images
            .iter()
            .enumerate()
            .filter(|(at, _)| *at != index)
            .map(|(_, image)| image.clone()),
    );
    out
}

/// `cameraBackgroundStageLine`: the line under the Camera row (never a
/// toast): the cover after 2 s, or a stage that can't run here. None while
/// it runs, or for Off and a screen. Always a warning.
pub fn stage_line(status: Option<&CameraBackgroundStatus>) -> Option<String> {
    let status = status?;
    let sees = match status.mode {
        CameraBackgroundMode::Blur => "Viewers see your whole camera blurred",
        CameraBackgroundMode::Cutout => "Viewers see your scene without you",
        CameraBackgroundMode::Image | CameraBackgroundMode::Video => {
            "Viewers see only your picture"
        }
        _ => return None,
    };
    match status.state {
        CameraBackgroundStageState::Unavailable => Some(format!(
            "Background effects can't run on this Mac right now. {sees} until you turn the effect off."
        )),
        CameraBackgroundStageState::Cover
            if status.cover_for_ms.unwrap_or(0) >= COVER_LINE_AFTER_MS =>
        {
            Some(format!(
                "Background is catching up. {sees} until it's back."
            ))
        }
        _ => None,
    }
}

/// `cameraBackgroundCommand`: ⌘K's quick command by state.
pub fn command(background: &Value) -> (&'static str, ChoiceId) {
    if is_effect(Some(background)) {
        ("Turn off background effect", ChoiceId::Off)
    } else {
        ("Blur background", ChoiceId::StrongBlur)
    }
}

/// `cameraBackgroundKeyOf`: a screen's tuning, with the scene key's defaults
/// for a camera that never had one.
pub fn key_of(background: &Value) -> Value {
    background
        .get("key")
        .filter(|key| key.is_object())
        .cloned()
        .unwrap_or_else(|| json!({"similarityPct": 40, "smoothnessPct": 8, "spillPct": 10}))
}

// --- Hide edges (`components/scene/camera-key-edges.ts`, plan 227 B) ---

/// `CAMERA_KEY_EDGE_IDS` with `CAMERA_KEY_EDGE_LABELS`, in the order the
/// screen's Crop fields use.
pub const KEY_EDGES: [(&str, &str); 4] = [
    ("leftPct", "Left"),
    ("topPct", "Top"),
    ("rightPct", "Right"),
    ("bottomPct", "Bottom"),
];

/// `cameraKeyEdgesOf`: a key's edges, every side present (none set reads
/// as all 0).
pub fn key_edges_of(edges: Option<&Value>) -> Value {
    let mut out = serde_json::Map::new();
    for (side, _) in KEY_EDGES {
        let pct = edges
            .and_then(|edges| edges.get(side))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        out.insert(side.into(), json!(pct as i64));
    }
    Value::Object(out)
}

/// `parseCameraKeyEdgePct`: a typed side as a whole percent in 0–25, or
/// none when the text is not a number. Accepts a trailing % and a comma
/// decimal.
pub fn parse_key_edge_pct(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    let cleaned = trimmed
        .strip_suffix('%')
        .unwrap_or(trimmed)
        .trim()
        .replacen(',', ".", 1);
    if cleaned.is_empty() {
        return None;
    }
    let parsed = super::js_value::to_number(Some(&Value::String(cleaned)));
    parsed.is_finite().then(|| {
        super::camera_background::KEY_EDGE_MAX_PCT.min(0f64.max(super::js_value::round(parsed)))
    })
}

/// `cameraKeyEdgesPatch`: the edges with one side changed, or none when
/// nothing changes.
pub fn key_edges_patch(edges: &Value, side: &str, text: &str) -> Option<Value> {
    let pct = parse_key_edge_pct(text)?;
    let all = key_edges_of(Some(edges));
    if all.get(side).and_then(Value::as_f64) == Some(pct) {
        return None;
    }
    let mut next = all;
    next[side] = json!(pct as i64);
    Some(next)
}

/// `cameraKeyEdgesSet`: some side hides something.
pub fn key_edges_set(edges: &Value) -> bool {
    KEY_EDGES.iter().any(|(side, _)| {
        edges
            .get(side)
            .and_then(Value::as_f64)
            .is_some_and(|pct| pct > 0.0)
    })
}

// --- green screen in reach (`lib/green-screen.ts`) ---

pub const CHROMA_KEY_GREEN: &str = "#00FF00";
pub const CHROMA_KEY_BLUE: &str = "#0000FF";
/// `GREEN_SCREEN_KEYWORDS`.
pub const GREEN_SCREEN_KEYWORDS: [&str; 10] = [
    "green screen",
    "greenscreen",
    "blue screen",
    "bluescreen",
    "chroma",
    "chroma key",
    "key out",
    "remove background",
    "background removal",
    "transparent background",
];

/// `greenScreenColor`: the key's colour; the stored hex may be either case.
pub fn green_screen_is_blue(layout: &Value) -> bool {
    string(layout.get("cameraChromaKeyColor"))
        .is_some_and(|hex| hex.eq_ignore_ascii_case(CHROMA_KEY_BLUE))
}

/// `greenScreenLabel`: "Blue screen" once a blue key is on, else "Green
/// screen".
pub fn green_screen_label(layout: &Value) -> &'static str {
    if layout["cameraChromaKeyEnabled"] == Value::Bool(true) && green_screen_is_blue(layout) {
        "Blue screen"
    } else {
        "Green screen"
    }
}

/// `greenScreenCommandLabel`: ⌘K's words for the switch.
pub fn green_screen_command_label(layout: &Value) -> String {
    if layout["cameraChromaKeyEnabled"] == Value::Bool(true) {
        format!("Turn off {}", green_screen_label(layout).to_lowercase())
    } else {
        "Turn on green screen".into()
    }
}

// --- the control's state (`components/camera-background/use-camera-background.ts`) ---

/// A slider's value mid-drag, for the camera it was dragged on: the control
/// shows it until the drop, and a drop after the camera changed commits
/// nothing.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BackgroundDraft(Option<(String, Value)>);

impl BackgroundDraft {
    /// The background the control shows for `camera_id`.
    pub fn shown(&self, backgrounds: Option<&Value>, camera_id: Option<&str>) -> Value {
        match &self.0 {
            Some((camera, value)) if Some(camera.as_str()) == camera_id => value.clone(),
            _ => background_for(backgrounds, camera_id),
        }
    }

    /// `set(next, {commit: false})`: held for this camera.
    pub fn hold(&mut self, camera_id: Option<&str>, value: Value) {
        if let Some(camera) = camera_id.filter(|id| !id.is_empty()) {
            self.0 = Some((camera.to_string(), value));
        }
    }

    /// `set(next)` / `choose`: the draft goes; the value to apply, or none
    /// when the draft belonged to another camera.
    pub fn commit(&mut self, camera_id: Option<&str>, value: Value) -> Option<Value> {
        let stale = self
            .0
            .as_ref()
            .is_some_and(|(camera, _)| Some(camera.as_str()) != camera_id);
        self.0 = None;
        (!stale).then_some(value)
    }
}

// --- the Scene page's Background section (`camera-background-section.tsx`) ---

/// `SECTION_IMAGES`: the pictures the section's row shows before Choose image….
pub const SECTION_IMAGES: usize = 2;
/// `BLUR_MARKS` and the slider's range.
pub const BLUR_MARKS: [(f64, &str); 2] = [(SLIGHT_BLUR_PCT, "Slight"), (STRONG_BLUR_PCT, "Strong")];
pub const BLUR_MIN_PCT: f64 = 10.0;
pub const BLUR_MAX_PCT: f64 = 100.0;

/// A screen's tuning, as its sliders and Hide edges show it.
#[derive(Debug, Clone, PartialEq)]
pub struct ScreenTuningView {
    pub similarity_pct: f64,
    pub smoothness_pct: f64,
    pub spill_pct: f64,
    /// Every side present (`NO_CAMERA_KEY_EDGES` when none is set).
    pub hide_edges: Value,
}

/// The camera's Background section on the Scene page.
#[derive(Debug, Clone, PartialEq)]
pub struct BackgroundSectionView {
    pub label: &'static str,
    pub description: &'static str,
    /// Off, the blurs, the first two pictures (the picked one first), the
    /// screens.
    pub tiles: Vec<Choice>,
    pub selected: Option<ChoiceId>,
    /// Why the effects can't be picked (no camera first).
    pub reason: Option<&'static str>,
    /// Choose image… opens the Images list (a camera is selected).
    pub choose_image: bool,
    /// Blur strength, for a blur.
    pub blur_pct: Option<f64>,
    /// The key's tuning, for Green or Blue screen.
    pub screen: Option<ScreenTuningView>,
    /// The line under the section: the hint, with the blur caveat for a blur
    /// and the screen hint for a key; none without a camera.
    pub hint: Option<String>,
}

/// The section for the selected camera's background (the shown one: a
/// draft mid-drag, else the stored pick).
pub fn background_section_view(
    background: &Value,
    images: &[Image],
    camera_selected: bool,
    room_open: bool,
    platform: Option<&str>,
) -> BackgroundSectionView {
    let shown_images = images_picked_first(images, string(background.get("assetId")));
    let tiles = choices(&ChoicesInput {
        images: &shown_images,
        camera_selected,
        room_open,
        platform,
        image_limit: Some(SECTION_IMAGES),
    });
    let effect_reason =
        platform_reason(platform).or(room_open.then_some(ROOM_BACKGROUND_UNAVAILABLE));
    let mode = mode(background);
    let screen = matches!(mode, "green" | "blue");
    let key = key_of(background);
    let tuning =
        |name: &str, fallback: f64| key.get(name).and_then(Value::as_f64).unwrap_or(fallback);
    BackgroundSectionView {
        label: LABEL,
        description: DESCRIPTION,
        tiles,
        selected: choice_id(background),
        reason: if camera_selected {
            effect_reason
        } else {
            Some(NO_CAMERA)
        },
        choose_image: camera_selected,
        blur_pct: (mode == "blur").then(|| blur_pct(background)),
        screen: screen.then(|| ScreenTuningView {
            similarity_pct: tuning("similarityPct", 40.0),
            smoothness_pct: tuning("smoothnessPct", 8.0),
            spill_pct: tuning("spillPct", 10.0),
            hide_edges: key_edges_of(key.get("hideEdges")),
        }),
        hint: camera_selected.then(|| match mode {
            "blur" => format!("{HINT} {BLUR_CAVEAT}"),
            _ if screen => SCREEN_HINT.to_string(),
            _ => HINT.to_string(),
        }),
    }
}

/// `setKey(patch)`: the background with its key's tuning changed.
pub fn background_with_key(background: &Value, patch: &serde_json::Map<String, Value>) -> Value {
    let mut key = key_of(background).as_object().cloned().unwrap_or_default();
    key.extend(patch.clone());
    let mut next = background.clone();
    next["key"] = Value::Object(key);
    next
}

#[cfg(test)]
#[path = "camera_background_view_tests.rs"]
mod tests;
