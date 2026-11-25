//! Plan 260 Phase 3: Studio's Scenes section as data
//! (`components/studio/studio-dashboard-bottom-row.tsx`,
//! `components/studio/scenes-gallery.tsx`, `components/scene-presets.tsx`,
//! `components/scene/scene-entries.tsx`, `scene-switch-status.tsx`,
//! `scene-shortcut-keys.tsx` and `follow-front-app-switch.tsx`).
//!
//! Every word, every enabled state, every reason and which card is on
//! stream, going on or blocked is decided here, so the GPUI section only
//! draws it and calls the Studio:
//!
//! - while a talk-show room is open the section is its title and one line
//!   ([`ScenesSectionView::RoomOpen`], P272);
//! - before the library is read it is its title and a placeholder
//!   ([`ScenesSectionView::Loading`], P287);
//! - then the gallery ([`ScenesGalleryView`]): the keys line under the
//!   title (P274), the 16:9 / 9:16 toggle, locked while a session runs
//!   (P277), "Follow the app in front" on macOS (P278), the library's error
//!   (P279), one card per scene in library order (P288–P291, P293), the
//!   switch's status line (P284) and the camera's one reason (P285).
//!
//! The status line has a clock: it shows a moment after a switch starts.
//! The view says when ([`ScenesGalleryView::status_at`]) so the UI draws
//! again then, once, with no frame loop.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use videorc_protocol::Device;

use super::StudioSnapshot;
use super::camera_frame_rate::CameraLowFrameRate;
use super::scenes::ScenesView;
use crate::desktop::accelerator::{accelerator_label, global_shortcut_conflict_reason};
use crate::guests::view::SCENES_OFF_WHILE_ROOM_OPEN;
use crate::scenes::list::{
    SceneGlyph, saved_scene_blocked_reason, scene_glyph, scene_shortcut_bindings,
};
use crate::scenes::model::{SavedScene, scene_source_problems};
use crate::scenes::section::{scene_card_words, scene_cards_camera_gaps, scene_slot_keys_line};
use crate::scenes::switch_progress::{SceneSwitchStatusLine, SwitchCamera};
use crate::scenes::v2::{Orientation, layout_preset};

/// The section's words, as Electron says them.
pub mod copy {
    pub const TITLE: &str = "Scenes";
    /// `EDIT_SCENE_LABEL` (plan 215 D4).
    pub const EDIT_SCENE: &str = "Edit scene";
    /// The toggle's name (`aria-label="Studio orientation"`).
    pub const ORIENTATION_LABEL: &str = "Studio orientation";
    /// The toggle's values (`layoutPresetOrientation`).
    pub const HORIZONTAL: &str = "horizontal";
    pub const VERTICAL: &str = "vertical";
    /// Each segment's visible words. Electron draws a display and a phone
    /// glyph; the kit's segments carry words only, so the shapes' ratios.
    pub const HORIZONTAL_SEGMENT: &str = "16:9";
    pub const VERTICAL_SEGMENT: &str = "9:16";
    /// Each segment's tooltip.
    pub const HORIZONTAL_TOOLTIP: &str = "Horizontal · 16:9";
    pub const VERTICAL_TOOLTIP: &str = "Vertical · 9:16";
    /// Why the toggle is off while a session runs.
    pub const ORIENTATION_LOCKED: &str =
        "Locked while you’re recording or live. Stop to switch orientation.";
    /// `FollowFrontAppSwitch`'s label (plan 210 D10).
    pub const FOLLOW_FRONT_APP: &str = "Follow the app in front";
    /// `ScenesLine` once the first or ninth key is the streamer's own.
    pub const LINE_GENERAL: &str =
        "Each scene shows its own screen. A scene's key switches to it from any app.";
    /// `ScenesLine` around the two keys: "… ⌃⌥1 to ⌃⌥9 switch them from any
    /// app."
    pub const LINE_LEAD: &str = "Each scene shows its own screen.";
    pub const LINE_TO: &str = "to";
    pub const LINE_TAIL: &str = "switch them from any app.";
    /// A card whose sources need choosing again (`needsSources`).
    pub const RESOLVE_SOURCES: &str = "Resolve sources";
    /// The gallery reason's door.
    pub const OPEN_SOURCES: &str = "Open Sources";
}

/// The line under the title (`ScenesLine`, D5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScenesLine {
    /// The platform's first and ninth position keys, as the platform prints
    /// them ("⌃⌥1", "Ctrl+Alt+Shift+1").
    Keys { first: String, last: String },
    /// One of them is the streamer's own: the general words.
    General,
}

/// One key on a card (`SceneShortcutKeys`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CardKey {
    /// The key as the platform prints it, in a keycap.
    Chip { action: String, label: String },
    /// The OS refused the key: "Another app uses ⌃⌥1", in quiet words.
    Conflict { action: String, reason: String },
}

/// One scene card (`SceneEntry` as `SceneCard` draws it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneCardView {
    pub id: String,
    pub name: String,
    /// Its place in the list, from 1: the position key's number (D5).
    pub position: usize,
    /// The scene on stream: the selected plate, the ring and the check.
    pub on_stream: bool,
    /// Going on stream now: the meta row is the pending mark ("Applying…").
    pub pending: bool,
    /// It takes no click: its own reason, the camera it needs, or pending.
    pub disabled: bool,
    /// Its reason on hover and focus while disabled (its own, else the
    /// camera's line).
    pub disabled_reason: Option<String>,
    /// The meta row's words while not pending: why it can't go on, "Resolve
    /// sources", or what it shows (none when that would repeat its name).
    pub meta: Option<String>,
    /// What it shows, for the glyph in its screen area.
    pub glyph: SceneGlyph,
    /// The layout it draws in the studio's orientation.
    pub preset: String,
    /// A 9:16 layout (drawn upright in a 4:3 well).
    pub vertical: bool,
    /// A 9:16 layout's screen fits rather than fills
    /// (`verticalScreenFraming === 'fit'`).
    pub fit: bool,
    pub keys: Vec<CardKey>,
}

/// The gallery, once the library is read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScenesGalleryView {
    pub line: ScenesLine,
    /// The studio is 9:16.
    pub vertical: bool,
    /// Why the toggle is off (a session runs), or none.
    pub orientation_locked: Option<&'static str>,
    /// "Follow the app in front" and whether it is on; none off macOS
    /// (D12: absent, not disabled).
    pub follow_front_app: Option<bool>,
    /// `sceneLibraryError`.
    pub error: Option<&'static str>,
    pub cards: Vec<SceneCardView>,
    /// The switch's status line, once it shows.
    pub status: Option<SceneSwitchStatusLine>,
    /// When the status line will show (epoch ms), while it waits: the UI
    /// draws again then.
    pub status_at: Option<u64>,
    /// Why the scenes that need the camera are off, said once under the
    /// cards with "Open Sources".
    pub camera_reason: Option<String>,
}

/// The section (`StudioDashboardBottomRow`'s Scenes slot).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScenesSectionView {
    /// A talk-show room is open: the Show stage's layouts are what goes on
    /// air ([`ScenesSectionView::room_open_line`]).
    RoomOpen,
    /// The library isn't read yet: the title over a placeholder.
    Loading,
    Gallery(ScenesGalleryView),
}

/// What the section reads.
#[derive(Debug, Clone, Copy)]
pub struct ScenesSectionInput<'a> {
    pub scenes: &'a ScenesView,
    pub devices: &'a [Device],
    /// `settings.globalShortcuts`.
    pub shortcuts: &'a Value,
    /// The studio's layout (`captureConfig.layout`).
    pub layout: &'a Value,
    /// `captureConfig.sources.cameraId`.
    pub camera_id: Option<&'a str>,
    /// `isSessionActive`: a recording or livestream, or one starting or
    /// stopping.
    pub session_active: bool,
    /// `followSettings.followFrontApp`.
    pub follow_front_app: bool,
    /// What the snapshot doesn't hold.
    pub extras: ScenesExtras<'a>,
}

/// What the app adds to the snapshot.
#[derive(Debug, Clone, Copy)]
pub struct ScenesExtras<'a> {
    /// `cloudStatus.room.phase === 'open'`.
    pub room_open: bool,
    /// Node's name for the platform (`darwin`, `win32`, `linux`).
    pub platform: Option<&'a str>,
    /// The last global-shortcut registration: each action, true when its
    /// key took.
    pub registered: &'a BTreeMap<String, bool>,
    /// The live camera held under its rate (#1271), for the status line.
    pub camera_low: Option<CameraLowFrameRate>,
    /// Now, in epoch ms (the switch's clock).
    pub now_ms: u64,
}

/// `isSessionActive` without the talk-show session (the room hides the
/// gallery while it is open): a session that owns the transport, or one
/// starting or stopping.
pub fn session_active(snapshot: &StudioSnapshot) -> bool {
    let session = &snapshot.session;
    (session.phase.is_active() && !session.status.replay_only)
        || session.start_pending
        || session.stop_pending
}

/// `needsSources`: the scene's sources have a problem, with the app the
/// scene remembers standing in for its window.
pub fn scene_needs_sources(
    scene: &SavedScene,
    remembered: Option<&str>,
    devices: &[Device],
) -> bool {
    let Some(bundle_id) = remembered else {
        return !scene_source_problems(&scene.visual, devices).is_empty();
    };
    let mut visual = scene.visual.clone();
    let app = json!({"bundleId": bundle_id, "name": scene.name, "follows": false});
    if let Some(object) = visual.as_object_mut() {
        match object.get_mut("sources").and_then(Value::as_object_mut) {
            Some(sources) => {
                sources.insert("app".into(), app);
            }
            None => {
                object.insert("sources".into(), json!({ "app": app }));
            }
        }
    }
    !scene_source_problems(&visual, devices).is_empty()
}

/// The ScenesLine's keys, or the general words.
pub fn scenes_line(shortcuts: &Value, platform: Option<&str>) -> ScenesLine {
    match scene_slot_keys_line(Some(shortcuts), platform) {
        Some((first, last)) => ScenesLine::Keys {
            first: accelerator_label(Some(&first), platform),
            last: accelerator_label(Some(&last), platform),
        },
        None => ScenesLine::General,
    }
}

/// A card's keys: its position key and its own key, each as a chip, or
/// the OS's refusal in words.
pub fn card_keys(
    scene_id: &str,
    position: usize,
    shortcuts: &Value,
    platform: Option<&str>,
    registered: &BTreeMap<String, bool>,
) -> Vec<CardKey> {
    scene_shortcut_bindings(scene_id, position, Some(shortcuts), platform)
        .into_iter()
        .map(|(action, accelerator)| {
            let failed = registered.get(&action) == Some(&false);
            match global_shortcut_conflict_reason(Some(&accelerator), platform, failed) {
                Some(reason) => CardKey::Conflict { action, reason },
                None => CardKey::Chip {
                    label: accelerator_label(Some(&accelerator), platform),
                    action,
                },
            }
        })
        .collect()
}

impl ScenesSectionView {
    /// The line under the title while a room is open.
    pub fn room_open_line() -> &'static str {
        SCENES_OFF_WHILE_ROOM_OPEN
    }

    /// The section over the Studio's snapshot.
    pub fn from_snapshot(snapshot: &StudioSnapshot, extras: ScenesExtras<'_>) -> Self {
        let shortcuts = snapshot.settings.studio.global_shortcuts();
        let config = &snapshot.settings.capture_doc;
        let camera_id = config
            .get("sources")
            .and_then(|sources| sources.get("cameraId"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let layout = config.get("layout").unwrap_or(&Value::Null);
        Self::of(ScenesSectionInput {
            scenes: &snapshot.scenes,
            devices: &snapshot.sources.devices.devices,
            shortcuts: &shortcuts,
            layout,
            camera_id,
            session_active: session_active(snapshot),
            follow_front_app: snapshot.settings.families.follow.follow_front_app,
            extras,
        })
    }

    /// The section over what it reads.
    pub fn of(input: ScenesSectionInput<'_>) -> Self {
        let extras = input.extras;
        if extras.room_open {
            return Self::RoomOpen;
        }
        let scenes = input.scenes;
        if !scenes.loaded {
            return Self::Loading;
        }
        let devices = input.devices;
        let listed: Vec<(&str, &str, &Value)> = scenes
            .scenes
            .iter()
            .map(|scene| (scene.id.as_str(), scene.name.as_str(), &scene.visual))
            .collect();
        let camera = scene_cards_camera_gaps(&listed, devices);
        let cards = scenes
            .scenes
            .iter()
            .enumerate()
            .map(|(index, scene)| {
                let position = index + 1;
                let pending = scenes.pending_scene_id.as_deref() == Some(scene.id.as_str());
                let blocked = saved_scene_blocked_reason(
                    &scene.visual,
                    scenes.app_states.get(&scene.id).copied(),
                    devices,
                );
                let camera_blocked = camera.blocked.contains(&scene.id);
                let meta = match &blocked {
                    Some(reason) => Some(reason.clone()),
                    None if !camera_blocked
                        && scene.app().is_none()
                        && scene_needs_sources(
                            scene,
                            scenes.remembered_apps.get(&scene.id),
                            devices,
                        ) =>
                    {
                        Some(copy::RESOLVE_SOURCES.to_string())
                    }
                    None => scene_card_words(&scene.name, &scene.visual),
                };
                let disabled_reason = blocked
                    .clone()
                    .or_else(|| camera_blocked.then(|| camera.reason.clone()).flatten());
                let layout = scene.visual.get("layout").unwrap_or(&Value::Null);
                let preset = layout_preset(layout).to_string();
                SceneCardView {
                    id: scene.id.clone(),
                    name: scene.name.clone(),
                    position,
                    on_stream: scenes.on_stream_id.as_deref() == Some(scene.id.as_str()),
                    pending,
                    disabled: blocked.is_some() || camera_blocked || pending,
                    disabled_reason,
                    meta,
                    glyph: scene_glyph(&scene.visual, devices),
                    vertical: Orientation::of_preset(&preset) == Orientation::Vertical,
                    fit: layout.get("verticalScreenFraming").and_then(Value::as_str) == Some("fit"),
                    preset,
                    keys: card_keys(
                        &scene.id,
                        position,
                        input.shortcuts,
                        extras.platform,
                        extras.registered,
                    ),
                }
            })
            .collect();
        let switch_camera = SwitchCamera {
            name: input.camera_id.and_then(|id| {
                devices
                    .iter()
                    .find(|device| device.id == id)
                    .map(|device| device.name.clone())
            }),
            low_frame_rate: extras.camera_low,
        };
        let status = scenes.progress_line(extras.now_ms, Some(&switch_camera));
        let status_at = scenes
            .progress_line_at()
            .filter(|at| status.is_none() && *at > extras.now_ms);
        Self::Gallery(ScenesGalleryView {
            line: scenes_line(input.shortcuts, extras.platform),
            vertical: Orientation::of_layout(input.layout) == Orientation::Vertical,
            orientation_locked: input.session_active.then_some(copy::ORIENTATION_LOCKED),
            follow_front_app: (extras.platform == Some("darwin")).then_some(input.follow_front_app),
            error: scenes.error,
            cards,
            status,
            status_at,
            camera_reason: camera.reason,
        })
    }
}

#[cfg(test)]
#[path = "scenes_section_tests.rs"]
mod tests;
