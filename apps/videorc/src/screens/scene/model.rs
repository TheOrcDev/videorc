//! What the Scene page draws (plan 260 Phase 3, L1), mapped from one Studio
//! snapshot. Pure, so it is tested without a window: the rules are the
//! core's (`scenes::{list, section, model, store}`, `editor::inspector`),
//! and this module only puts them together the way `scene-list.tsx`,
//! `scene-entries.tsx`, `layout-tab.tsx` and `hide-screen-section.tsx` do.

use serde_json::{Value, json};
use videorc_app_core::StudioSnapshot;
use videorc_app_core::desktop::global_shortcuts::{
    DEFAULT_SCREEN_HIDE_SHORTCUT, GlobalShortcutsConfig, scene_shortcut_bindings,
};
use videorc_app_core::editor::inspector::{
    HideScreenView, LayoutInput, LayoutSectionView, hide_screen_view, layout_section_view,
};
use videorc_app_core::scenes::list::saved_scene_blocked_reason;
use videorc_app_core::scenes::model::{SavedScene, scene_audio, scene_source_problems};
use videorc_app_core::scenes::section::{
    scene_card_words, scene_cards_camera_gaps, scene_slot_keys_line,
};
use videorc_app_core::scenes::store::{DeleteRule, can_delete_scene};
use videorc_app_core::scenes::v2::SceneShows;
use videorc_app_core::studio::scenes_section::scene_keeps_audio;
use videorc_app_core::studio::transport::transport_active;

/// The scene list's words (`scene-entries.tsx`, `scene-dialogs.tsx`,
/// `lib/edit-scene.ts`), byte for byte.
pub mod copy {
    pub const SCENES_TITLE: &str = "Scenes";
    /// `SCENES_READ_ONLY_REASON`.
    pub const READ_ONLY_REASON: &str = "Update Videorc to change your scenes.";
    pub const SCENES_LINE_LEAD: &str = "Each scene shows its own screen. ";
    pub const SCENES_LINE_TO: &str = " to ";
    pub const SCENES_LINE_TAIL: &str = " switch them from any app.";
    pub const SCENES_LINE_CUSTOM: &str =
        "Each scene shows its own screen. A scene's key switches to it from any app.";
    pub const APPLYING: &str = "Applying…";
    pub const RESOLVE_SOURCES: &str = "Resolve sources";
    pub const FOLLOWS: &str = "Follows";
    pub const ON_STREAM: &str = "On stream";
    pub const OPEN_SOURCES: &str = "Open Sources";
    pub const ADD_SCENE: &str = "Add scene…";
    pub const RENAME: &str = "Rename…";
    pub const CHANGE_SCREEN: &str = "Change screen…";
    pub const FOLLOW_THE_APP: &str = "Follow the app";
    pub const STOP_FOLLOWING: &str = "Stop following";
    pub const SAVE_AUDIO: &str = "Save audio to scene";
    pub const SAVE_AUDIO_SAME: &str = "The scene already keeps this microphone and System audio.";
    pub const DUPLICATE: &str = "Duplicate";
    pub const DELETE: &str = "Delete";
    // Rename scene.
    pub const RENAME_TITLE: &str = "Rename scene";
    pub const NAME_LABEL: &str = "Name";
    pub const NAME_HELPER: &str = "Names must be unique.";
    pub const RENAME_FAILED: &str =
        "Couldn't rename the scene. Check your free space, then try again.";
    pub const CANCEL: &str = "Cancel";
    pub const RENAME_BUTTON: &str = "Rename";
    // Delete scene?
    pub const DELETE_TITLE: &str = "Delete scene?";
    pub const DELETE_BUTTON: &str = "Delete scene";
    // Hide screen.
    pub const HIDE_SCREEN_TITLE: &str = "Hide screen";
    pub const HIDE_SCREEN_DESCRIPTION: &str = "Your screen turns into a frosted picture on the recording and every stream, so nothing on it can be read. Your camera and voice stay on.";
    pub const SHORTCUT: &str = "Shortcut";
    pub const PASSWORD_MANAGER_SWITCH: &str = "Hide when a password manager is in front";
    pub const PASSWORD_MANAGER_DESCRIPTION: &str = "Only while a whole screen is on stream. Your screen comes back when the app leaves the front, unless you hid it yourself.";
    pub const PASSWORD_MANAGERS: &str = "Password managers";
    pub const REMOVE: &str = "Remove";
    pub const RESTORE_BUILT_IN: &str = "Restore built-in apps";
    pub const ADD_APP: &str = "Add app…";
    pub const OPEN_APPS: &str = "Open apps";
    pub const SEARCH_OPEN_APPS: &str = "Search open apps…";
    pub const SEARCH_OPEN_APPS_LABEL: &str = "Search open apps";
    // Layout.
    pub const LAYOUT_TITLE: &str = "Layout";
    pub const ORIENTATION: &str = "Orientation";
    pub const HORIZONTAL_TIP: &str = "Horizontal · 16:9";
    pub const HORIZONTAL_NAME: &str = "Horizontal (16:9)";
    pub const VERTICAL_NAME: &str = "Vertical (9:16)";
    pub const VERTICAL_TIP: &str = "Vertical · 9:16";
    pub const SCREEN: &str = "Screen";
    pub const SCREEN_FRAMING: &str = "Screen framing";
    pub const FILL: &str = "Fill";
    pub const FIT: &str = "Fit";
    pub const ANIMATE: &str = "Animate scene changes";
    pub const ANIMATE_DESCRIPTION: &str =
        "Layout switches glide into place instead of cutting, on stream and in recordings.";

    /// The Delete confirmation's line (`scene-dialogs.tsx`): curly quotes
    /// round the names, a curly apostrophe in "What’s".
    pub fn delete_description(name: &str, next: Option<&str>) -> String {
        match next {
            Some(next) => {
                format!("“{name}” and its key are deleted. “{next}” goes on stream.")
            }
            None => format!("“{name}” and its key are deleted. What’s on stream stays as it is."),
        }
    }

    /// The ⋯ trigger's accessible name.
    pub fn actions_for(name: &str) -> String {
        format!("Actions for {name}")
    }
}

/// What a row says after its name (`SceneRow`'s `context`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowMeta {
    None,
    /// A switch is putting the scene on: the spinner and "Applying…".
    Pending,
    Text(String),
}

/// One scene row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneRow {
    pub id: String,
    pub name: String,
    /// 0-based place in the library.
    pub index: usize,
    pub on_stream: bool,
    pub disabled: bool,
    /// The hover and focus tooltip of a disabled row (none while pending).
    pub disabled_reason: Option<String>,
    pub meta: RowMeta,
    /// An app scene: whether it follows the app's front window.
    pub follows: Option<bool>,
    /// The position key, then the custom key: (action, Electron
    /// accelerator).
    pub keys: Vec<(String, String)>,
    /// Why Change screen… waits (other than read-only): the scene on
    /// stream's live screen switch (`sourceSwitchReason('capture')`).
    pub change_screen_reason: Option<String>,
    /// Why Save audio to scene is off (other than read-only).
    pub save_audio_reason: Option<&'static str>,
    pub delete: DeleteRule,
    /// The name of the scene a delete puts on stream.
    pub delete_switch_to: Option<String>,
}

/// The Scenes section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScenesList {
    pub read_only: bool,
    /// The default keys' first and last accelerators, or `None` when slot 1
    /// or 9 is customised (the other sentence).
    pub keys_line: Option<(String, String)>,
    pub error: Option<&'static str>,
    pub rows: Vec<SceneRow>,
    /// One line under the rows when scenes need the camera while it is off
    /// or gone (`SceneGalleryReason`).
    pub camera_reason: Option<String>,
}

/// The whole page.
#[derive(Debug, Clone, PartialEq)]
pub struct SceneModel {
    pub list: ScenesList,
    pub layout: LayoutSectionView,
    pub hide: HideScreenView,
    /// The Hide screen key as an accelerator; empty means "Not set".
    pub hide_accelerator: String,
    pub platform: Option<&'static str>,
}

fn global_shortcuts(snapshot: &StudioSnapshot) -> (Value, GlobalShortcutsConfig) {
    let value = snapshot.settings.studio.global_shortcuts();
    let config = serde_json::from_value(value.clone()).unwrap_or_default();
    (value, config)
}

/// `needsSources`: a scene with a remembered app counts only its camera
/// gaps, because its window is found when it goes on.
fn needs_sources(scene: &SavedScene, snapshot: &StudioSnapshot) -> bool {
    let devices = &snapshot.sources.devices.devices;
    let remembered = snapshot
        .scenes
        .remembered_apps
        .0
        .iter()
        .find(|(id, _)| id == &scene.id)
        .map(|(_, bundle)| bundle.clone());
    match remembered {
        Some(bundle_id) => {
            let mut visual = scene.visual.clone();
            if let Some(sources) = visual.get_mut("sources").and_then(Value::as_object_mut) {
                sources.insert(
                    "app".into(),
                    json!({"bundleId": bundle_id, "name": scene.name, "follows": false}),
                );
            }
            !scene_source_problems(&visual, devices).is_empty()
        }
        None => !scene_source_problems(&scene.visual, devices).is_empty(),
    }
}

impl SceneModel {
    pub fn of(snapshot: &StudioSnapshot, platform: Option<&'static str>, wayland: bool) -> Self {
        let view = &snapshot.scenes;
        let devices = &snapshot.sources.devices.devices;
        let session_active = transport_active(&snapshot.session);
        let (shortcuts_value, shortcuts) = global_shortcuts(snapshot);
        let capture = &snapshot.settings.capture_doc;
        let working_audio = scene_audio(
            &capture["sources"],
            capture["audio"]["systemAudioEnabled"] == Value::Bool(true),
        );
        let on_stream_id = view.on_stream_id.clone().unwrap_or_default();

        let triples: Vec<(&str, &str, &Value)> = view
            .scenes
            .iter()
            .map(|scene| (scene.id.as_str(), scene.name.as_str(), &scene.visual))
            .collect();
        let gaps = scene_cards_camera_gaps(&triples, devices);

        let rows = view
            .scenes
            .iter()
            .enumerate()
            .map(|(index, scene)| {
                let app_state = view.app_states.get(&scene.id).copied();
                let blocked = saved_scene_blocked_reason(&scene.visual, app_state, devices);
                let camera_blocked = gaps.blocked.contains(&scene.id);
                let pending = view.pending_scene_id.as_deref() == Some(scene.id.as_str());
                let app = scene.app();
                let meta = if pending {
                    RowMeta::Pending
                } else if let Some(blocked) = &blocked {
                    RowMeta::Text(blocked.clone())
                } else if !camera_blocked && app.is_none() && needs_sources(scene, snapshot) {
                    RowMeta::Text(copy::RESOLVE_SOURCES.to_string())
                } else {
                    scene_card_words(&scene.name, &scene.visual)
                        .map(RowMeta::Text)
                        .unwrap_or(RowMeta::None)
                };
                let disabled_reason = blocked
                    .clone()
                    .or_else(|| camera_blocked.then(|| gaps.reason.clone()).flatten());
                let delete = can_delete_scene(
                    &view.scenes,
                    &scene.id,
                    &on_stream_id,
                    session_active,
                    pending,
                );
                let delete_switch_to = match &delete {
                    DeleteRule::Allowed {
                        switch_to: Some(next),
                    } => view
                        .scenes
                        .iter()
                        .find(|other| &other.id == next)
                        .map(|other| other.name.clone()),
                    _ => None,
                };
                let on_stream = view.on_stream_id.as_deref() == Some(scene.id.as_str());
                SceneRow {
                    change_screen_reason: if on_stream {
                        snapshot.source_reasons[0].clone()
                    } else {
                        None
                    },
                    id: scene.id.clone(),
                    name: scene.name.clone(),
                    index,
                    on_stream,
                    disabled: blocked.is_some() || camera_blocked || pending,
                    disabled_reason,
                    meta,
                    follows: app.map(|app| app.get("follows") == Some(&Value::Bool(true))),
                    keys: scene_shortcut_bindings(&scene.id, index + 1, &shortcuts, platform),
                    // Electron's menu rule, the Studio's too: off only when
                    // the saved audio is exactly the working audio (a scene
                    // with none saved can save it).
                    save_audio_reason: scene_keeps_audio(scene.audio.as_ref(), &working_audio)
                        .then_some(copy::SAVE_AUDIO_SAME),
                    delete,
                    delete_switch_to,
                }
            })
            .collect();

        let list = ScenesList {
            read_only: view.read_only,
            keys_line: scene_slot_keys_line(Some(&shortcuts_value), platform),
            error: view.error,
            rows,
            camera_reason: gaps.reason.clone(),
        };

        let layout = layout_section_view(&LayoutInput {
            layout: &capture["layout"],
            sources: &capture["sources"],
            session_active,
            // The stage's phase is the page's: `layout_section` gates the
            // presets and Freeform on it as it draws.
            stage_busy: false,
            has_scene: view.on_stream_id.is_some(),
            pending: view
                .pending_layout
                .as_ref()
                .map(|target| (target.preset.as_str(), target.freeform)),
            animate: snapshot.settings.studio.animate_scene_changes(),
            on_stream_shows_no_screen: view
                .on_stream()
                .is_some_and(|scene| matches!(scene.shows, SceneShows::None)),
        });

        let hide_accelerator = shortcuts
            .screen_hide_toggle
            .clone()
            .unwrap_or_else(|| DEFAULT_SCREEN_HIDE_SHORTCUT.to_string());
        let hide = hide_screen_view(
            Some(hide_accelerator.clone()),
            platform == Some("darwin"),
            &snapshot.settings.families.privacy,
            wayland,
        );

        Self {
            list,
            layout,
            hide,
            hide_accelerator,
            platform,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::copy;

    #[test]
    fn delete_line_names_the_next_scene_or_keeps_the_stream() {
        assert_eq!(
            copy::delete_description("Intro", Some("Talk")),
            "“Intro” and its key are deleted. “Talk” goes on stream."
        );
        assert_eq!(
            copy::delete_description("Intro", None),
            "“Intro” and its key are deleted. What’s on stream stays as it is."
        );
    }

    #[test]
    fn words_keep_electrons_bytes() {
        // An ellipsis character, never three dots.
        assert!(copy::RENAME.ends_with('\u{2026}'));
        assert!(copy::APPLYING.ends_with('\u{2026}'));
        // The custom-keys line uses an ASCII apostrophe.
        assert!(copy::SCENES_LINE_CUSTOM.contains("scene's"));
        assert_eq!(copy::actions_for("Intro"), "Actions for Intro");
    }
}
