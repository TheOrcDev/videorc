//! Settings → General → Import from OBS… (plan 220 S3.11a), the renderer's
//! half of the OBS import: `lib/obs-import-map.ts` (the mapping and the
//! three-verdict report), `lib/obs-import-apply.ts` (the merge into the
//! capture config and the background into Assets) and the dialog's states
//! (`components/obs-import-dialog.tsx`).
//!
//! The backend reads OBS's files (S1.6b: `obs.discover`, `obs.read`,
//! `obs.streamKey`, admin only); the app's resources turn the recording
//! folder into a plain path the store keeps (P3-D1) and copy image sources
//! into the managed backgrounds, as main does for Electron.
//!
//! THE law of the report holds: every OBS source the streamer can see lands
//! in it as imported, approximated or skipped with its reason, and the apply
//! does exactly what it says.

use serde::Deserialize;
use serde_json::{Map, Value, json};
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

use crate::encoding::encode_uri_component;

/// `MANAGED_BACKGROUND_ROOT`: where the managed copy of an imported picture
/// lives, as the backgrounds library names it.
pub const MANAGED_BACKGROUND_ROOT: &str = "videorc-asset://background/";

/// The Output line's words: `formatVideoQualityFull` ("1920 × 1080 · 30
/// fps"). It belongs to the account's entitlements (L6), which implement
/// this once `account::entitlements` lands.
pub trait QualityLabel {
    fn video_quality_full(&self, width: u32, height: u32, fps: u32) -> String;
}

/// What the import needs from the backgrounds library (`background-library.ts`,
/// the Assets registry, L7): where an unattended import goes, and the
/// picture into that slot.
pub trait BackgroundLibrary {
    /// `unattendedImportSlot`: the first empty slot, else the last slot
    /// holding a bundled picture, else the last slot.
    fn unattended_import_slot(&self) -> Option<BackgroundTarget>;
    /// `importIntoSlot` then `applySlot`: the picture into the slot, and that
    /// slot the scene background (no live background stays on). False when
    /// the slot is gone.
    fn import_and_apply(&mut self, slot_id: &str, picture: &ManagedBackground, now: &str) -> bool;
}

/// `OBS_IMPORT_TIMEOUT_MS`: each of the three admin reads.
pub const OBS_IMPORT_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(15_000);

/// The dialog's words (`obs-import-dialog.tsx`).
pub mod copy {
    pub const TITLE: &str = "Import from OBS";
    pub const DESCRIPTION: &str =
        "Nothing changes until you import. The list below is exactly what will happen.";
    pub const SCENE_COLLECTION: &str = "Scene collection";
    pub const PROFILE: &str = "Profile";
    pub const PICK_COLLECTION: &str = "Pick a scene collection";
    pub const PICK_PROFILE: &str = "Pick a profile";
    pub const LOOKING: &str = "Looking for OBS Studio…";
    pub const NOT_FOUND: &str =
        "No OBS Studio installation with scene collections was found on this device.";
    pub const NO_PROFILE: &str = "OBS has no profile to read.";
    pub const PICK_BOTH: &str = "Pick a scene collection and a profile.";
    pub const READING: &str = "Reading your OBS setup…";
    pub const TRY_AGAIN: &str = "Try again";
    pub const CANCEL: &str = "Cancel";
    pub const IMPORT: &str = "Import setup";
    pub const IMPORTING: &str = "Importing…";
    pub const WILL_IMPORT: &str = "Will import";
    pub const APPROXIMATED: &str = "Approximated";
    pub const WONT_IMPORT: &str = "Won't import";
    /// `OBS_PROFILE_UNREADABLE`.
    pub const PROFILE_UNREADABLE: &str =
        "Its scene collection or profile is missing, or its files are unreadable.";
    /// A discovery that answered nothing.
    pub const NO_ANSWER: &str = "No answer came back.";
    pub const IMPORTED_TITLE: &str = "OBS setup imported";
    pub const IMPORTED_DESCRIPTION: &str = "Check Sources and Scene.";

    /// "Couldn't look for OBS Studio. {reason}"
    pub fn discovery_failed(reason: &str) -> String {
        format!("Couldn't look for OBS Studio. {reason}")
    }

    /// "Couldn't read this OBS profile. {reason}"
    pub fn read_failed(reason: &str) -> String {
        format!("Couldn't read this OBS profile. {reason}")
    }
}

// --- what the backend reads -------------------------------------------------

/// `ObsDiscovery`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsDiscovery {
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub collections: Vec<String>,
    #[serde(default)]
    pub profiles: Vec<String>,
    #[serde(default)]
    pub current_collection: Option<String>,
    #[serde(default)]
    pub current_profile: Option<String>,
}

/// An image source's managed copy (`BackgroundImportResult`), made by the
/// app's resources from the source's file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedBackground {
    pub id: String,
    pub name: String,
    /// `videorc-asset://background/<file>`.
    pub asset_path: String,
    pub thumbnail_path: String,
}

impl ManagedBackground {
    /// The managed URLs of an imported file and its tile.
    pub fn from_files(id: &str, name: &str, asset_file: &str, thumbnail_file: &str) -> Self {
        let url = |file: &str| format!("{}{}", MANAGED_BACKGROUND_ROOT, encode_uri_component(file));
        Self {
            id: id.to_string(),
            name: name.to_string(),
            asset_path: url(asset_file),
            thumbnail_path: url(thumbnail_file),
        }
    }
}

/// `ObsSource`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsSource {
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub obs_kind: String,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub application_hint: Option<String>,
    /// The image's file (the backend's answer; the app turns it into
    /// `managed_background` and drops it).
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(skip)]
    pub managed_background: Option<ManagedBackground>,
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub muted: Option<bool>,
    #[serde(default)]
    pub preset_width: Option<f64>,
    #[serde(default)]
    pub preset_height: Option<f64>,
}

/// `ObsSceneItem`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ObsSceneItem {
    pub source_name: String,
    pub visible: bool,
    pub x: f64,
    pub y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub bounds_type: f64,
    pub bounds_x: f64,
    pub bounds_y: f64,
    pub crop_left: f64,
    pub crop_top: f64,
    pub crop_right: f64,
    pub crop_bottom: f64,
}

/// `ObsScene`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ObsScene {
    pub name: String,
    pub current: bool,
    pub items: Vec<ObsSceneItem>,
}

/// `ObsStreamService`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsStreamService {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub service: Option<String>,
    #[serde(default)]
    pub server: Option<String>,
    #[serde(default)]
    pub has_key: bool,
}

/// The recording folder OBS names, once the app could authorize it
/// (Electron's `recordingDirectory`): a plain path the store keeps (P3-D1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordingDirectory {
    pub path: std::path::PathBuf,
    pub display_name: String,
}

/// `ObsSetup`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsSetup {
    #[serde(default)]
    pub collection_name: String,
    #[serde(default)]
    pub canvas_width: f64,
    #[serde(default)]
    pub canvas_height: f64,
    #[serde(default)]
    pub output_width: f64,
    #[serde(default)]
    pub output_height: f64,
    #[serde(default)]
    pub fps: f64,
    /// The backend's answer; the app turns it into `recording_directory`.
    #[serde(default)]
    pub recording_path: Option<String>,
    #[serde(skip)]
    pub recording_directory: Option<RecordingDirectory>,
    #[serde(default)]
    pub sources: Vec<ObsSource>,
    #[serde(default)]
    pub scenes: Vec<ObsScene>,
    #[serde(default)]
    pub global_mic_device_name: Option<String>,
    #[serde(default)]
    pub has_desktop_audio: bool,
    #[serde(default)]
    pub service: Option<ObsStreamService>,
}

// --- the plan ---------------------------------------------------------------

/// `ObsImportVerdict`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Imported,
    Approximated,
    Skipped,
}

impl Verdict {
    pub const ALL: [Verdict; 3] = [Verdict::Imported, Verdict::Approximated, Verdict::Skipped];

    /// `VERDICT_META`'s title.
    pub fn title(self) -> &'static str {
        match self {
            Verdict::Imported => copy::WILL_IMPORT,
            Verdict::Approximated => copy::APPROXIMATED,
            Verdict::Skipped => copy::WONT_IMPORT,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Imported => "imported",
            Verdict::Approximated => "approximated",
            Verdict::Skipped => "skipped",
        }
    }
}

/// `ObsImportReportLine`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportLine {
    pub verdict: Verdict,
    pub subject: String,
    pub note: String,
}

/// `CameraTransform`, fractions of the canvas.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraTransform {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The stream destination the plan imports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamPlan {
    RtmpCustom {
        server_url: String,
        has_key: bool,
    },
    RtmpPlatform {
        platform: &'static str,
        service_label: String,
        server_url: String,
        has_key: bool,
    },
    OauthSuggest {
        platform: &'static str,
        service_label: String,
    },
}

impl StreamPlan {
    /// The destination card's platform a key goes to (`custom` for a
    /// custom server), none for a sign-in suggestion.
    pub fn key_platform(&self) -> Option<&'static str> {
        match self {
            StreamPlan::RtmpCustom { .. } => Some("custom"),
            StreamPlan::RtmpPlatform { platform, .. } => Some(platform),
            StreamPlan::OauthSuggest { .. } => None,
        }
    }

    pub fn has_key(&self) -> bool {
        match self {
            StreamPlan::RtmpCustom { has_key, .. } | StreamPlan::RtmpPlatform { has_key, .. } => {
                *has_key
            }
            StreamPlan::OauthSuggest { .. } => false,
        }
    }
}

/// `ObsImportPlanResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct ObsImportPlan {
    /// `Partial<SourceSelection>`: the picks, by their config names.
    pub sources: Map<String, Value>,
    pub layout_preset: &'static str,
    pub camera_transform: Option<CameraTransform>,
    pub camera_aspect: Option<&'static str>,
    pub video: (f64, f64, f64),
    pub microphone_gain_db: Option<f64>,
    pub microphone_muted: Option<bool>,
    pub system_audio_enabled: Option<bool>,
    pub output_directory: Option<RecordingDirectory>,
    pub stream: Option<StreamPlan>,
    pub background_asset: Option<ManagedBackground>,
    /// Set exactly when the report promises the background (plan 174, C-7).
    pub background_slot_id: Option<String>,
    pub report: Vec<ReportLine>,
}

/// `ObsBackgroundTarget`: where an imported image goes in Assets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackgroundTarget {
    pub slot_id: String,
    /// The background the slot holds now, `None` for an empty slot.
    pub replaces: Option<String>,
}

/// `FALLBACK_CAMERA_NATIVE`.
const FALLBACK_CAMERA_NATIVE: (f64, f64) = (1920.0, 1080.0);

fn fuzzy_includes(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// `matchDevice`: the exact name, else either name inside the other.
fn match_device<'a>(devices: &'a [Device], kind: DeviceKind, name: &str) -> Option<&'a Device> {
    let pool: Vec<&Device> = devices
        .iter()
        .filter(|device| device.kind == kind)
        .collect();
    if name.is_empty() {
        return None;
    }
    pool.iter()
        .find(|device| device.name == name)
        .or_else(|| {
            pool.iter().find(|device| {
                fuzzy_includes(&device.name, name) || fuzzy_includes(name, &device.name)
            })
        })
        .copied()
}

/// `pickTopmost`: the last visible item of one of `kinds` wins (OBS draws
/// bottom to top); the others are its extras, bottom first.
fn pick_topmost<'a>(
    scene: &'a ObsScene,
    sources: &'a [ObsSource],
    kinds: &[&str],
) -> Option<(&'a ObsSceneItem, &'a ObsSource, Vec<&'a ObsSource>)> {
    let matches: Vec<(&ObsSceneItem, &ObsSource)> = scene
        .items
        .iter()
        .filter(|item| item.visible)
        .filter_map(|item| {
            let source = source_by_name(sources, &item.source_name)?;
            kinds
                .contains(&source.kind.as_str())
                .then_some((item, source))
        })
        .collect();
    let (last, rest) = matches.split_last()?;
    Some((
        last.0,
        last.1,
        rest.iter().map(|(_, source)| *source).collect(),
    ))
}

/// `new Map(sources.map(s => [s.name, s]))`: the last source of a name wins.
fn source_by_name<'a>(sources: &'a [ObsSource], name: &str) -> Option<&'a ObsSource> {
    sources.iter().rev().find(|source| source.name == name)
}

/// `cameraBox`.
fn camera_box(
    item: &ObsSceneItem,
    source: &ObsSource,
    canvas_width: f64,
    canvas_height: f64,
) -> Option<(CameraTransform, bool)> {
    let mut assumed_native = false;
    let (width, height) = if item.bounds_type != 0.0 && item.bounds_x > 0.0 && item.bounds_y > 0.0 {
        (item.bounds_x, item.bounds_y)
    } else {
        let native = match (source.preset_width, source.preset_height) {
            (Some(w), Some(h)) if w != 0.0 && h != 0.0 && !w.is_nan() && !h.is_nan() => (w, h),
            _ => {
                assumed_native = true;
                FALLBACK_CAMERA_NATIVE
            }
        };
        let crop_x = item.crop_left + item.crop_right;
        let crop_y = item.crop_top + item.crop_bottom;
        (
            (native.0 - crop_x).max(1.0) * item.scale_x,
            (native.1 - crop_y).max(1.0) * item.scale_y,
        )
    };
    // `!(width > 0)` is true for NaN too.
    if width.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
        || height.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
        || canvas_width <= 0.0
        || canvas_height <= 0.0
    {
        return None;
    }
    let clamp01 = |value: f64| value.clamp(0.0, 1.0);
    let transform = CameraTransform {
        x: clamp01(item.x / canvas_width),
        y: clamp01(item.y / canvas_height),
        width: clamp01(width / canvas_width),
        height: clamp01(height / canvas_height),
    };
    if transform.width < 0.02 || transform.height < 0.02 {
        return None;
    }
    Some((transform, assumed_native))
}

/// `aspectFromBox`.
fn aspect_from_box(
    transform: &CameraTransform,
    canvas_width: f64,
    canvas_height: f64,
) -> &'static str {
    let ratio = (transform.width * canvas_width) / (transform.height * canvas_height).max(1.0);
    if ratio < 0.9 {
        "portrait"
    } else if ratio <= 1.15 {
        "square"
    } else {
        "source"
    }
}

/// JavaScript's `Math.round`: halves toward +∞.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `volumeToGainDb`.
fn volume_to_gain_db(volume: f64) -> f64 {
    if volume.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        return -20.0;
    }
    js_round(20.0 * volume.log10()).clamp(-20.0, 20.0)
}

/// `KEY_PLATFORM_NAMES`.
fn key_platform_name(platform: &str) -> &'static str {
    match platform {
        "youtube" => "YouTube",
        "kick" => "Kick",
        _ => "Facebook",
    }
}

/// The host of a URL as `new URL(url).hostname` reads it for the ingest
/// URLs OBS keeps (`scheme://host[:port]/…`), lower-cased; `None` for text
/// that is no URL.
fn url_host(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority.rsplit('@').next().unwrap_or_default();
    let host = host_port.split(':').next().unwrap_or_default();
    (!host.is_empty()).then(|| host.to_lowercase())
}

/// `isFacebookIngest`.
fn is_facebook_ingest(server_url: Option<&str>) -> bool {
    url_host(server_url.unwrap_or_default())
        .is_some_and(|host| host == "facebook.com" || host.ends_with(".facebook.com"))
}

/// `detectPlatform`.
fn detect_platform(service_label: &str, server_url: Option<&str>) -> &'static str {
    if fuzzy_includes(service_label, "youtube") {
        return "youtube";
    }
    if fuzzy_includes(service_label, "facebook") || is_facebook_ingest(server_url) {
        return "facebook";
    }
    if fuzzy_includes(service_label, "kick")
        || fuzzy_includes(server_url.unwrap_or_default(), "kick")
    {
        return "kick";
    }
    if fuzzy_includes(service_label, "twitch") {
        return "twitch";
    }
    "other"
}

/// `SKIP_NOTES`.
fn skip_note(kind: &str) -> Option<&'static str> {
    match kind {
        "browser" => Some("Videorc has no browser source."),
        "text" => Some("Videorc has no text overlay source."),
        "media" => Some("Videorc has no media-file source."),
        "other" => Some("Videorc has nothing like it."),
        _ => None,
    }
}

/// A canvas number as JavaScript prints it in a template string.
fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// `mapObsSetup`: the plan and its report, from what OBS holds, the devices
/// this computer has and where an image would go in Assets.
pub fn map_obs_setup(
    setup: &ObsSetup,
    devices: &[Device],
    background_target: Option<&BackgroundTarget>,
    quality: &impl QualityLabel,
) -> ObsImportPlan {
    let mut report = Vec::new();
    let mut line = |verdict: Verdict, subject: &str, note: String| {
        report.push(ReportLine {
            verdict,
            subject: subject.to_string(),
            note,
        });
    };
    let scene = setup
        .scenes
        .iter()
        .find(|candidate| candidate.current && !candidate.items.is_empty())
        .or_else(|| {
            setup
                .scenes
                .iter()
                .find(|candidate| !candidate.items.is_empty())
        });

    let mut plan = ObsImportPlan {
        sources: Map::new(),
        layout_preset: "screen-only",
        camera_transform: None,
        camera_aspect: None,
        video: (setup.output_width, setup.output_height, setup.fps),
        microphone_gain_db: None,
        microphone_muted: None,
        system_audio_enabled: None,
        output_directory: None,
        stream: None,
        background_asset: None,
        background_slot_id: None,
        report: Vec::new(),
    };

    line(
        Verdict::Imported,
        "Output",
        quality.video_quality_full(
            setup.output_width.max(0.0) as u32,
            setup.output_height.max(0.0) as u32,
            setup.fps.max(0.0) as u32,
        ),
    );
    if let Some(directory) = &setup.recording_directory {
        plan.output_directory = Some(directory.clone());
        line(
            Verdict::Imported,
            "Recording folder",
            directory.display_name.clone(),
        );
    }

    let Some(scene) = scene else {
        line(
            Verdict::Skipped,
            &setup.collection_name,
            "No scene with visible sources was found.".to_string(),
        );
        plan.report = report;
        return plan;
    };

    // --- screen ---
    let screen_pick = pick_topmost(scene, &setup.sources, &["display", "window", "application"]);
    if let Some((_, source, extras)) = &screen_pick {
        if source.kind == "display" {
            let monitor_or_window = source.obs_kind == "pipewire-screen-capture-source";
            let first_screen = devices.iter().find(|device| {
                device.kind == DeviceKind::Screen && device.status == DeviceStatus::Available
            });
            if let Some(screen) = first_screen {
                plan.sources
                    .insert("screenId".into(), json!(screen.id.clone()));
                plan.sources
                    .insert("screenName".into(), json!(screen.name.clone()));
                if let Some(uuid) = &screen.display_uuid {
                    plan.sources.insert("screenUuid".into(), json!(uuid));
                }
                line(
                    Verdict::Approximated,
                    &source.name,
                    if monitor_or_window {
                        format!(
                            "This OBS source can capture a monitor or a window, so it starts on {}. Check it in Sources.",
                            screen.name
                        )
                    } else {
                        format!(
                            "Captures {}. OBS displays can't be matched exactly, so check it in Sources.",
                            screen.name
                        )
                    },
                );
            } else {
                line(
                    Verdict::Approximated,
                    &source.name,
                    if monitor_or_window {
                        "This OBS source can capture a monitor or a window. Pick one in Sources."
                    } else {
                        "Pick the display in Sources once Screen Recording is allowed."
                    }
                    .to_string(),
                );
            }
        } else {
            let hint = source.application_hint.as_deref().unwrap_or(&source.name);
            let window = match_device(devices, DeviceKind::Window, hint)
                .or_else(|| match_device(devices, DeviceKind::Window, &source.name));
            if let Some(window) = window {
                plan.sources
                    .insert("windowId".into(), json!(window.id.clone()));
                plan.sources
                    .insert("windowName".into(), json!(window.name.clone()));
                line(
                    Verdict::Imported,
                    &source.name,
                    format!("Captures the {} window.", window.name),
                );
            } else {
                line(
                    Verdict::Approximated,
                    &source.name,
                    format!("No open window matches \"{hint}\" right now. Pick it in Sources."),
                );
            }
        }
        for extra in extras {
            line(
                Verdict::Approximated,
                &extra.name,
                "Videorc scenes hold one screen, so the topmost one is kept.".to_string(),
            );
        }
    }

    // --- camera ---
    let camera_pick = pick_topmost(scene, &setup.sources, &["camera"]);
    if let Some((item, source, extras)) = &camera_pick {
        let wanted = source.device_name.as_deref().unwrap_or(&source.name);
        if let Some(camera) = match_device(devices, DeviceKind::Camera, wanted) {
            plan.sources
                .insert("cameraId".into(), json!(camera.id.clone()));
            plan.sources
                .insert("cameraName".into(), json!(camera.name.clone()));
            line(
                Verdict::Imported,
                &source.name,
                format!("Uses {}.", camera.name),
            );
        } else {
            line(
                Verdict::Approximated,
                &source.name,
                format!("No connected camera is named \"{wanted}\". Pick one in Sources."),
            );
        }
        if let Some((transform, assumed)) =
            camera_box(item, source, setup.canvas_width, setup.canvas_height)
        {
            plan.camera_transform = Some(transform);
            plan.camera_aspect = Some(aspect_from_box(
                &transform,
                setup.canvas_width,
                setup.canvas_height,
            ));
            if assumed {
                line(
                    Verdict::Approximated,
                    &format!("{} position", source.name),
                    "The camera's size is estimated from a 1080p feed. Adjust it on the Scene stage if it's off.".to_string(),
                );
            }
        }
        for extra in extras {
            line(
                Verdict::Approximated,
                &extra.name,
                "Videorc scenes hold one camera, so the topmost one is kept.".to_string(),
            );
        }
    }

    plan.layout_preset = match (camera_pick.is_some(), screen_pick.is_some()) {
        (true, true) => "screen-camera",
        (true, false) => "camera-only",
        _ => "screen-only",
    };

    // --- microphone ---
    let mic_source = pick_topmost(scene, &setup.sources, &["microphone"])
        .map(|(_, source, _)| source)
        .or_else(|| {
            setup
                .sources
                .iter()
                .find(|source| source.kind == "microphone")
        });
    if let Some(mic) = mic_source {
        let wanted = mic.device_name.as_deref().unwrap_or(&mic.name);
        if let Some(microphone) = match_device(devices, DeviceKind::Microphone, wanted) {
            plan.sources
                .insert("microphoneId".into(), json!(microphone.id.clone()));
            plan.sources
                .insert("microphoneName".into(), json!(microphone.name.clone()));
            line(
                Verdict::Imported,
                &mic.name,
                format!("Uses {}.", microphone.name),
            );
        } else {
            line(
                Verdict::Approximated,
                &mic.name,
                "No microphone matches this name. Pick it in Sources.".to_string(),
            );
        }
        if let Some(volume) = mic.volume.filter(|volume| *volume != 1.0) {
            let gain = volume_to_gain_db(volume);
            plan.microphone_gain_db = Some(gain);
            line(
                Verdict::Approximated,
                &format!("{} level", mic.name),
                format!("The OBS volume becomes {} dB of gain.", js_number(gain)),
            );
        }
        if mic.muted == Some(true) {
            plan.microphone_muted = Some(true);
            line(
                Verdict::Imported,
                &format!("{} mute", mic.name),
                "Muted, as in OBS.".to_string(),
            );
        }
    }

    // --- background image ---
    let image_items: Vec<&ObsSceneItem> = scene
        .items
        .iter()
        .filter(|item| {
            item.visible
                && source_by_name(&setup.sources, &item.source_name)
                    .is_some_and(|source| source.kind == "image")
        })
        .collect();
    if let Some(first) = image_items.first() {
        let bottom = source_by_name(&setup.sources, &first.source_name);
        match (bottom, background_target) {
            (Some(bottom), Some(target)) if bottom.managed_background.is_some() => {
                plan.background_asset = bottom.managed_background.clone();
                plan.background_slot_id = Some(target.slot_id.clone());
                line(
                    Verdict::Approximated,
                    &bottom.name,
                    match &target.replaces {
                        Some(name) => format!(
                            "Becomes the scene background, in place of {name} in Assets."
                        ),
                        None => "Becomes the scene background, in an empty slot in Assets."
                            .to_string(),
                    },
                );
            }
            (Some(bottom), _) => line(
                Verdict::Skipped,
                &bottom.name,
                if bottom.managed_background.is_some() {
                    "Assets has no slot for it. Import it from Assets."
                } else {
                    "The image couldn't be copied. Check that the file still exists and is a PNG, JPEG or WebP."
                }
                .to_string(),
            ),
            (None, _) => {}
        }
        for item in &image_items[1..] {
            line(
                Verdict::Skipped,
                &item.source_name,
                "Videorc uses one background image per scene.".to_string(),
            );
        }
    }

    // --- everything else in the scene ---
    for item in &scene.items {
        let Some(source) = source_by_name(&setup.sources, &item.source_name) else {
            continue;
        };
        if !item.visible {
            continue;
        }
        if let Some(note) = skip_note(&source.kind) {
            line(Verdict::Skipped, &source.name, note.to_string());
        }
    }

    // --- desktop audio ---
    if setup.has_desktop_audio {
        let system_audio = devices
            .iter()
            .find(|device| device.kind == DeviceKind::SystemAudio);
        match system_audio.map(|device| &device.status) {
            Some(DeviceStatus::Available) => {
                plan.system_audio_enabled = Some(true);
                line(
                    Verdict::Imported,
                    "Desktop audio",
                    "Turns System audio on.".to_string(),
                );
            }
            Some(DeviceStatus::PermissionRequired) => {
                plan.system_audio_enabled = Some(true);
                line(
                    Verdict::Approximated,
                    "Desktop audio",
                    "Turns System audio on, once Screen Recording is allowed.".to_string(),
                );
            }
            _ => line(
                Verdict::Skipped,
                "Desktop audio",
                "This computer can't capture system audio.".to_string(),
            ),
        }
    }

    // --- other scenes ---
    for other in &setup.scenes {
        if other.name == scene.name {
            continue;
        }
        line(
            Verdict::Skipped,
            &format!("Scene \"{}\"", other.name),
            "Videorc keeps one active scene, so only the current OBS scene is imported."
                .to_string(),
        );
    }

    // --- stream service ---
    if let Some(service) = &setup.service {
        let server = service
            .server
            .as_deref()
            .filter(|server| !server.is_empty());
        if service.kind == "rtmp_custom"
            && let Some(server) = server.filter(|server| !is_facebook_ingest(Some(server)))
        {
            plan.stream = Some(StreamPlan::RtmpCustom {
                server_url: server.to_string(),
                has_key: service.has_key,
            });
            line(
                Verdict::Imported,
                "Custom RTMP destination",
                if service.has_key {
                    "Imports the server and the stream key."
                } else {
                    "Imports the server. OBS had no stream key."
                }
                .to_string(),
            );
        } else {
            let label = service.service.clone().unwrap_or_else(|| {
                if is_facebook_ingest(service.server.as_deref()) {
                    "Facebook Live".to_string()
                } else {
                    "streaming service".to_string()
                }
            });
            let platform = detect_platform(&label, service.server.as_deref());
            if platform == "twitch" || platform == "other" {
                plan.stream = Some(StreamPlan::OauthSuggest {
                    platform,
                    service_label: label.clone(),
                });
                line(
                    Verdict::Approximated,
                    &label,
                    "Connect the account in Livestream instead. Signing in is safer than a pasted stream key.".to_string(),
                );
            } else if let Some(server) = server {
                let name = key_platform_name(platform);
                plan.stream = Some(StreamPlan::RtmpPlatform {
                    platform,
                    service_label: label.clone(),
                    server_url: server.to_string(),
                    has_key: service.has_key,
                });
                line(
                    Verdict::Imported,
                    &label,
                    if service.has_key {
                        format!(
                            "Imports the server and the stream key into {name}, set to Stream key."
                        )
                    } else {
                        format!(
                            "Imports the server into {name}, set to Stream key. OBS had no stream key."
                        )
                    },
                );
            } else {
                line(
                    Verdict::Approximated,
                    &label,
                    format!(
                        "OBS had no server URL. Set up {} with a stream key in Livestream.",
                        key_platform_name(platform)
                    ),
                );
            }
        }
    }

    plan.report = report;
    plan
}

/// The report grouped by verdict, in `imported, approximated, skipped`
/// order, empty groups left out (the dialog's `groups`).
pub fn report_groups(plan: &ObsImportPlan) -> Vec<(Verdict, Vec<&ReportLine>)> {
    Verdict::ALL
        .into_iter()
        .map(|verdict| {
            (
                verdict,
                plan.report
                    .iter()
                    .filter(|line| line.verdict == verdict)
                    .collect::<Vec<_>>(),
            )
        })
        .filter(|(_, lines)| !lines.is_empty())
        .collect()
}

// --- the apply ----------------------------------------------------------------

fn object_mut<'a>(value: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    let Value::Object(map) = value else {
        unreachable!("the capture config is an object");
    };
    let slot = map
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !slot.is_object() {
        *slot = Value::Object(Map::new());
    }
    slot.as_object_mut().expect("an object")
}

/// `mergeObsImportIntoConfig`, without the raw key: the picks, the layout,
/// the video and the audio, and the stream card the plan names turned on,
/// on Stream key with OBS's server. The key itself goes to the backend's
/// secrets (`save_manual_stream_key`), never into the config.
pub fn merge_obs_import_into_config(config: &mut Value, plan: &ObsImportPlan, now: &str) {
    if !config.is_object() {
        *config = Value::Object(Map::new());
    }
    {
        let sources = object_mut(config, "sources");
        for (key, value) in &plan.sources {
            sources.insert(key.clone(), value.clone());
        }
        sources.insert("testPattern".into(), json!(false));
    }
    {
        let layout = object_mut(config, "layout");
        layout.insert("layoutPreset".into(), json!(plan.layout_preset));
        if let Some(transform) = plan.camera_transform {
            layout.insert("cameraTransformMode".into(), json!("custom"));
            layout.insert(
                "cameraTransform".into(),
                json!({
                    "x": transform.x,
                    "y": transform.y,
                    "width": transform.width,
                    "height": transform.height,
                }),
            );
        }
        if let Some(aspect) = plan.camera_aspect {
            layout.insert("cameraAspect".into(), json!(aspect));
        }
    }
    {
        let video = object_mut(config, "video");
        video.insert("width".into(), number(plan.video.0));
        video.insert("height".into(), number(plan.video.1));
        video.insert("fps".into(), number(plan.video.2));
    }
    {
        let audio = object_mut(config, "audio");
        if let Some(gain) = plan.microphone_gain_db {
            audio.insert("microphoneGainDb".into(), number(gain));
        }
        if let Some(muted) = plan.microphone_muted {
            audio.insert("microphoneMuted".into(), json!(muted));
        }
        if let Some(on) = plan.system_audio_enabled {
            audio.insert("systemAudioEnabled".into(), json!(on));
        }
    }
    let Some(stream) = &plan.stream else {
        return;
    };
    let (Some(platform), server_url) = (
        stream.key_platform(),
        match stream {
            StreamPlan::RtmpCustom { server_url, .. }
            | StreamPlan::RtmpPlatform { server_url, .. } => server_url.clone(),
            StreamPlan::OauthSuggest { .. } => String::new(),
        },
    ) else {
        return;
    };
    let streaming = object_mut(config, "streaming");
    if let Some(Value::Array(targets)) = streaming.get_mut("targets") {
        for target in targets.iter_mut() {
            let Some(target) = target.as_object_mut() else {
                continue;
            };
            if target.get("id").and_then(Value::as_str) != Some(platform) {
                continue;
            }
            target.insert("enabled".into(), json!(true));
            target.insert("serverUrl".into(), json!(server_url));
            target.insert("authMode".into(), json!("manual-rtmp"));
            target.insert("updatedAt".into(), json!(now));
        }
    }
    let mut enabled: Vec<Value> = match streaming.get("enabledTargetIds") {
        Some(Value::Array(ids)) => ids.clone(),
        _ => Vec::new(),
    };
    if !enabled.iter().any(|id| id.as_str() == Some(platform)) {
        enabled.push(json!(platform));
    }
    streaming.insert("enabledTargetIds".into(), Value::Array(enabled));
}

/// The stream cards a fetched key goes to (`target.id === platform`).
pub fn key_target_ids(config: &Value, plan: &ObsImportPlan) -> Vec<String> {
    let Some(platform) = plan.stream.as_ref().and_then(StreamPlan::key_platform) else {
        return Vec::new();
    };
    config
        .pointer("/streaming/targets")
        .and_then(Value::as_array)
        .map(|targets| {
            targets
                .iter()
                .filter(|target| target.get("id").and_then(Value::as_str) == Some(platform))
                .filter_map(|target| target.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

// --- the background into Assets (`background-library.ts`) -------------------

/// `withObsBackground`: the image into the slot the report named, and that
/// slot the scene background. A plan that promised no background, or a slot
/// that is gone, leaves the library alone. True when it changed.
pub fn with_obs_background(
    library: &mut impl BackgroundLibrary,
    plan: &ObsImportPlan,
    now: &str,
) -> bool {
    let (Some(picture), Some(slot_id)) = (&plan.background_asset, &plan.background_slot_id) else {
        return false;
    };
    library.import_and_apply(slot_id, picture, now)
}

// --- the dialog -----------------------------------------------------------------

/// The discovery's state (`Discovery`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum DiscoveryState {
    #[default]
    Looking,
    Found(ObsDiscovery),
    Failed(String),
}

/// The read of the chosen collection and profile.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum ReadState {
    /// Nothing chosen yet, or the dialog is closed.
    #[default]
    Idle,
    Reading,
    Read(Box<ObsSetup>),
    Failed(String),
}

/// The dialog as the app holds it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ObsDialogState {
    pub open: bool,
    pub discovery: DiscoveryState,
    pub collection: Option<String>,
    pub profile: Option<String>,
    pub read: ReadState,
    /// The read the answer must match to count (`ObsImportReadAuthority`).
    pub read_ticket: u64,
    pub applying: bool,
}

impl ObsDialogState {
    /// Opened: looking for OBS.
    pub fn opened(&mut self) {
        *self = ObsDialogState {
            open: true,
            read_ticket: self.read_ticket.wrapping_add(1),
            collection: self.collection.take(),
            profile: self.profile.take(),
            ..ObsDialogState::default()
        };
    }

    /// Closed: no read counts any more.
    pub fn closed(&mut self) {
        self.open = false;
        self.applying = false;
        self.read = ReadState::Idle;
        self.read_ticket = self.read_ticket.wrapping_add(1);
    }

    /// The discovery answered: the current collection and profile chosen
    /// unless one already is. Returns the read to start, if any.
    pub fn discovered(&mut self, found: ObsDiscovery) -> Option<(String, String, u64)> {
        if self.collection.is_none() {
            self.collection = found.current_collection.clone();
        }
        if self.profile.is_none() {
            self.profile = found.current_profile.clone();
        }
        self.discovery = DiscoveryState::Found(found);
        self.begin_read()
    }

    /// A pick changed: the old read no longer counts; a new one starts when
    /// both are chosen.
    pub fn pick(
        &mut self,
        collection: Option<String>,
        profile: Option<String>,
    ) -> Option<(String, String, u64)> {
        if let Some(collection) = collection {
            self.collection = Some(collection);
        }
        if let Some(profile) = profile {
            self.profile = Some(profile);
        }
        self.begin_read()
    }

    /// Starts the read for the current picks (Try again too).
    pub fn begin_read(&mut self) -> Option<(String, String, u64)> {
        self.read_ticket = self.read_ticket.wrapping_add(1);
        match (&self.collection, &self.profile) {
            (Some(collection), Some(profile)) if self.open => {
                self.read = ReadState::Reading;
                Some((collection.clone(), profile.clone(), self.read_ticket))
            }
            _ => {
                self.read = ReadState::Idle;
                None
            }
        }
    }

    /// A read answered; taken only when it is the latest for these picks.
    pub fn read_answered(&mut self, ticket: u64, answer: Result<Option<ObsSetup>, String>) -> bool {
        if !self.open || ticket != self.read_ticket {
            return false;
        }
        self.read = match answer {
            Ok(Some(setup)) => ReadState::Read(Box::new(setup)),
            Ok(None) => ReadState::Failed(copy::PROFILE_UNREADABLE.to_string()),
            Err(reason) => ReadState::Failed(reason),
        };
        true
    }

    /// The setup read for the current picks.
    pub fn setup(&self) -> Option<&ObsSetup> {
        match &self.read {
            ReadState::Read(setup) => Some(setup),
            _ => None,
        }
    }
}

/// What the dialog shows.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ObsDialogView {
    pub open: bool,
    /// The failed discovery's line (with Try again), else "".
    pub discovery_error: String,
    /// The pickers show (OBS is there).
    pub pickers: bool,
    pub collections: Vec<String>,
    pub profiles: Vec<String>,
    pub collection_index: Option<usize>,
    pub profile_index: Option<usize>,
    /// The failed read's line (with Try again), else "".
    pub read_error: String,
    /// The quiet line in place of the report ("Looking…", "Reading…", …).
    pub status: String,
    /// The report, grouped.
    pub groups: Vec<(Verdict, Vec<ReportLine>)>,
    pub can_import: bool,
    pub applying: bool,
}

/// The dialog's view from its state and the plan.
pub fn obs_dialog_view(state: &ObsDialogState, plan: Option<&ObsImportPlan>) -> ObsDialogView {
    let mut view = ObsDialogView {
        open: state.open,
        applying: state.applying,
        ..ObsDialogView::default()
    };
    match &state.discovery {
        DiscoveryState::Failed(reason) => {
            view.discovery_error = copy::discovery_failed(reason);
        }
        DiscoveryState::Looking => view.status = copy::LOOKING.to_string(),
        DiscoveryState::Found(found) if !found.available => {
            view.status = copy::NOT_FOUND.to_string();
        }
        DiscoveryState::Found(found) => {
            view.pickers = true;
            view.collections = found.collections.clone();
            view.profiles = found.profiles.clone();
            view.collection_index = state
                .collection
                .as_ref()
                .and_then(|name| found.collections.iter().position(|item| item == name));
            view.profile_index = state
                .profile
                .as_ref()
                .and_then(|name| found.profiles.iter().position(|item| item == name));
            let groups = plan.map(report_groups).unwrap_or_default();
            if let ReadState::Failed(reason) = &state.read {
                view.read_error = copy::read_failed(reason);
            } else if state.collection.is_none() || state.profile.is_none() {
                view.status = if found.profiles.is_empty() {
                    copy::NO_PROFILE
                } else {
                    copy::PICK_BOTH
                }
                .to_string();
            } else if state.read == ReadState::Reading || groups.is_empty() {
                view.status = copy::READING.to_string();
            } else {
                view.groups = groups
                    .into_iter()
                    .map(|(verdict, lines)| (verdict, lines.into_iter().cloned().collect()))
                    .collect();
            }
            view.can_import = plan.is_some()
                && view.read_error.is_empty()
                && state.read != ReadState::Reading
                && !state.applying;
        }
    }
    view
}

#[cfg(test)]
#[path = "obs_import_tests.rs"]
mod tests;
