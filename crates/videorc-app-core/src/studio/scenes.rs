//! Plan 260 S1.6b part 3: the Studio's scenes on plan 231's library
//! (`use-studio.tsx` ~3414 and ~5268–5400, `hooks/use-scene-library.ts`).
//!
//! - **Launch.** Once the settings snapshot is in, the library is read as
//!   `prepareScenes` and `loadScenes` read it ([`load_scenes`]): #1706's
//!   repair is stored first (the working setup, then the library), and a
//!   profile with no v2 library is migrated from v1 and stored once,
//!   quietly. The working setup (`videorc.working-scene.v1`) is then laid
//!   over the capture config, as the renderer's first `captureConfig` state
//!   is, and the scene on stream is the one the library names while the
//!   look has its layout (`sceneOnStreamAtLaunch`). D15's moved keys go
//!   into `settings.globalShortcuts` in the same write that lets the
//!   library forget them (one `ui.settings.set`, so both land or neither).
//! - **The device list** names the main display for the scenes made before
//!   it did (`nameMainDisplay`), and forgets what each app scene's resolver
//!   said.
//! - **The scenes as listed** ([`ScenesView::scenes`]) are each stored scene
//!   in the studio's orientation with the one camera every scene shares
//!   (D9), the shape the apply and list code reads. App states are given
//!   only where a leg that is on draws a screen for the scene (review #6).
//! - **The edits** ([`Studio::insert_scenes`] and the rest) each write the
//!   whole library under `videorc.scenes.v2` over `ui.settings`; a write the
//!   store refuses says "Couldn't save the scene", as `localStorage.setItem`
//!   failing does.
//!
//! A library from a newer Videorc is today's setup in memory and never
//! written. The scene switch (`requestLayoutTransaction`, the apply, the
//! delete flow) is [`super::scene_switch`] (part 3b).

use std::collections::HashMap;

use serde_json::Value;
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

use super::capture_config::{coerce_video_to_orientation, simulcast_armed};
use super::scene_switch::{LayoutTarget, ReloadMark, SwitchCore};
use super::settings::{SettingWrite, StudioSettings, encode, keys};
use super::{Inner, Studio, StudioBackend};
use crate::notices::{NoticeCommand, ToastRequest};
use crate::scenes::library::{Refused, ScenesState, StoredScenes, load_scenes};
use crate::scenes::migration::StoredForMigration;
use crate::scenes::model::{
    SavedScene, hydrate_working_scene, load_json, merge_visual_sources, same_scene_audio,
    same_scene_visual, scene_audio, without_scene_app,
};
use crate::scenes::store::hydrate_scenes;
use crate::scenes::switch_progress::{
    SceneSwitchProgress, SceneSwitchStatusLine, SwitchCamera, scene_switch_status_line,
    scene_switch_status_visible, scene_switch_status_visible_at,
};
use crate::scenes::v2::{MainDisplay, Orientation, Scene, SceneLibrary, SceneShows};
use crate::scenes::view::{
    saved_scene_view, scene_display_refreshed, scene_draws_screen, scene_from_saved,
    scene_on_stream_at_launch, scene_with_shows,
};
use crate::scenes::window::{
    RememberedSceneApps, SceneAppState, remembered_scene_apps, scene_app_state,
};

/// The library's words (`hooks/use-scenes.ts`).
pub mod copy {
    pub const SAVE_FAILED: &str = "Couldn't save the scene";
    pub const SAVE_FAILED_BODY: &str = "Free up disk space, then save it again.";
    pub const SAVE_FAILED_ID: &str = "scene-save-storage";
}

/// `hostPlatform()`: `process.platform`'s name for this build's OS.
pub fn host_platform() -> Option<&'static str> {
    match std::env::consts::OS {
        "macos" => Some("darwin"),
        "windows" => Some("win32"),
        "linux" => Some("linux"),
        _ => None,
    }
}

/// The scenes as the Studio holds them (in the snapshot).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScenesView {
    /// The library is read (after the settings snapshot).
    pub loaded: bool,
    /// The stored library, both layouts of each scene.
    pub library: Option<SceneLibrary>,
    /// Each scene as the Studio lists and applies it: its layout in the
    /// studio's orientation, the shared camera (`sceneLibrary.scenes`).
    pub scenes: Vec<SavedScene>,
    /// The scene on stream (`activeSavedSceneId`); always one once loaded.
    pub on_stream_id: Option<String>,
    /// A library from a newer Videorc: nothing is written.
    pub read_only: bool,
    /// `sceneLibrary.error`.
    pub error: Option<&'static str>,
    /// `savedSceneAppStates`: only scenes whose app a leg that is on needs.
    pub app_states: HashMap<String, SceneAppState>,
    /// `videorc.scene-window-apps.v1`, in its stored order.
    pub remembered_apps: RememberedSceneApps,
    /// Part 3b: the layout a switch is applying (`layoutSwitchPending`).
    pub pending_layout: Option<LayoutTarget>,
    /// The scene a switch is putting on stream (`savedScenePendingId`).
    pub pending_scene_id: Option<String>,
    /// A transaction is on its way (`visualTransactionPending`).
    pub transaction_pending: bool,
    /// The working background as the last commit drew it (`workingBackground`).
    pub working_background: Option<Value>,
    /// Part 3c (#1275): the switch running, what was clicked and the phase
    /// it waits on (`sceneSwitchProgress`). Its status line is
    /// [`ScenesView::progress_line`].
    pub switch_progress: Option<SceneSwitchProgress>,
    /// `savedSceneModified`: the look on stream that the scene on stream has
    /// not taken yet, or audio that differs from the audio it pins. Its
    /// screen is not part of it (D18).
    pub saved_scene_modified: bool,
    /// The idle reload's mark, read with this snapshot's capture config: a
    /// reload built from this snapshot confirms with this mark, never with a
    /// newer scene on stream than the sources it carries.
    pub reload_mark: ReloadMark,
}

impl ScenesView {
    /// The switch's status line at `now_ms` (`SceneSwitchStatus`): none
    /// while no switch runs or for its first moment, unless it took over
    /// another. `camera` is the chosen camera's name and slow frame rate.
    pub fn progress_line(
        &self,
        now_ms: u64,
        camera: Option<&SwitchCamera>,
    ) -> Option<SceneSwitchStatusLine> {
        let progress = self.switch_progress.as_ref()?;
        scene_switch_status_visible(progress, now_ms)
            .then(|| scene_switch_status_line(progress, camera))
    }

    /// When the status line shows, for a UI that draws again then (no timer
    /// lives in the Studio).
    pub fn progress_line_at(&self) -> Option<u64> {
        self.switch_progress
            .as_ref()
            .map(scene_switch_status_visible_at)
    }

    /// The stored scene on stream.
    pub fn on_stream(&self) -> Option<&Scene> {
        let id = self.on_stream_id.as_deref()?;
        self.library
            .as_ref()?
            .scenes
            .iter()
            .find(|scene| scene.id == id)
    }
}

/// The Studio's scene memory between events.
#[derive(Default)]
pub(super) struct ScenesCore {
    pub(super) state: Option<ScenesState>,
    /// `activeSavedSceneId`.
    pub(super) on_stream: Option<String>,
    /// The app memory, as last stored.
    pub(super) apps: RememberedSceneApps,
    /// What each app scene's resolver said, until the device list changes.
    pub(super) resolved: HashMap<String, SceneAppState>,
    /// The device list these answers and the main display were read from.
    devices_seen: Option<u64>,
    /// Toasts the next publish posts.
    pub(super) notices: Vec<NoticeCommand>,
    /// A quiet write was staged that no flush has sent yet.
    unflushed: bool,
    /// Part 3b: the switch's memory (`requestLayoutTransaction`'s refs).
    pub(super) switch: SwitchCore,
}

/// `JSON.parse(localStorage.getItem(key))`, as `read` in `use-scenes.ts`.
fn read(inner: &Inner, key: &str) -> Option<Value> {
    load_json(inner.settings.get(key))
}

fn library_write(library: &SceneLibrary) -> SettingWrite {
    SettingWrite::Put {
        key: keys::SCENES.to_string(),
        value: encode(&library.to_json()),
    }
}

fn save_failed() -> NoticeCommand {
    NoticeCommand::Show(
        ToastRequest::error(copy::SAVE_FAILED)
            .id(copy::SAVE_FAILED_ID)
            .description(copy::SAVE_FAILED_BODY)
            .finish(),
    )
}

/// The device list's main display (`kind === 'screen'`, available).
fn main_display(devices: &[Device]) -> Option<MainDisplay> {
    devices
        .iter()
        .find(|device| {
            device.kind == DeviceKind::Screen && device.status == DeviceStatus::Available
        })
        .map(|device| MainDisplay {
            id: device.id.clone(),
            name: device.name.clone(),
            display_uuid: device.display_uuid.clone(),
        })
}

impl Inner {
    /// Stages `writes` without a logger: the launch's writes are quiet (a
    /// refused one is read again next launch).
    pub(super) fn stage_quietly(&mut self, writes: &[SettingWrite]) -> bool {
        let staged = self
            .stage_writes(writes, &crate::log::Logger::silent())
            .is_ok();
        self.scenes.unflushed |= staged;
        staged
    }

    /// Part 3: the library read once the snapshot is in, then kept in step
    /// with the device list. Every write here is quiet, and is sent with the
    /// next flush (the bootstrap's, or the device list's).
    pub(super) fn sync_scenes(&mut self) {
        if !self.settings.hydrated() {
            return;
        }
        if self.scenes.state.is_none() {
            let now = (self.capture.clock)();
            self.load_scenes(&now);
        }
        let revision = self.sources.devices_revision;
        if self.sources.devices_known && self.scenes.devices_seen != Some(revision) {
            self.scenes.devices_seen = Some(revision);
            self.scenes.resolved.clear();
            if let Some(display) = main_display(&self.sources.devices.devices) {
                self.name_main_display(&display);
            }
        }
        self.remember_scene_apps();
    }

    fn load_scenes(&mut self, now: &str) {
        let scenes = read(self, keys::SCENES);
        let v1 = read(self, keys::SCENE_PRESETS);
        let working = read(self, keys::WORKING_SCENE);
        let shortcuts = StudioSettings::load(self.settings.get(keys::SETTINGS))
            .get("globalShortcuts")
            .cloned();
        self.capture.sync(self.settings.get(keys::CAPTURE_CONFIG));
        let stored_config = self.capture.config.clone();
        let mut loaded = load_scenes(&StoredScenes {
            scenes: scenes.as_ref(),
            migration: StoredForMigration {
                read_only: false,
                v1_library: v1.as_ref(),
                working_scene: working.as_ref(),
                capture_config: &stored_config,
                global_shortcuts: shortcuts.as_ref(),
                now,
                platform: host_platform(),
            },
        });
        // #1706: stored before anything reads it, the working setup first.
        if let Some(repair) = loaded.repair.take() {
            let mut writes = Vec::new();
            if let Some(working) = &repair.working {
                writes.push(SettingWrite::Put {
                    key: keys::WORKING_SCENE.to_string(),
                    value: encode(working),
                });
            }
            writes.push(SettingWrite::Put {
                key: keys::SCENES.to_string(),
                value: encode(&repair.library),
            });
            if !self.stage_quietly(&writes) {
                // Kept as stored: the next launch repairs it.
                if let Some(library) = hydrate_scenes(scenes.as_ref()).library {
                    loaded.state.library = library;
                }
            }
        }
        let mut state = loaded.state;
        self.overlay_working_scene();
        // The migration, stored once, quietly (`useScenes`' first effect).
        if let Some(library) = state.pending_write()
            && self.stage_quietly(&[library_write(&library)])
        {
            state.written(library);
        }
        let layout = self.capture.config["layout"].clone();
        let on_stream =
            scene_on_stream_at_launch(&state.library.scenes, &state.library.on_stream_id, &layout);
        // D15: the moved keys into the settings, and the library lets them
        // go in the same write.
        if let Some(migrated) = state.migrated_shortcuts.clone()
            && let Ok(Some(settled)) = state.settle_shortcuts()
        {
            let mut settings = StudioSettings::load(self.settings.get(keys::SETTINGS));
            settings.set("globalShortcuts", migrated);
            let writes = [
                SettingWrite::Put {
                    key: keys::SETTINGS.to_string(),
                    value: settings.stored(),
                },
                library_write(&settled),
            ];
            if self.stage_quietly(&writes) {
                state.shortcuts_settled(settled);
            }
        }
        self.scenes.apps = RememberedSceneApps(Vec::new());
        self.scenes.state = Some(state);
        self.set_scene_on_stream(&on_stream);
    }

    /// The working setup over the capture config (`use-studio.tsx` ~3420):
    /// its sources (never its app), its layout, the canvas turned to its
    /// orientation. Not a write: the stored config stays what it syncs on.
    fn overlay_working_scene(&mut self) {
        let working = hydrate_working_scene(read(self, keys::WORKING_SCENE).as_ref());
        // Part 3b: the working app, background and origin come back with it.
        self.scenes.switch.launch(working.as_ref());
        let Some(working) = working else {
            return;
        };
        let mut config = self.capture.config.clone();
        let sources = merge_visual_sources(
            &config["sources"],
            working.visual.get("sources").unwrap_or(&Value::Null),
        );
        config["sources"] = without_scene_app(&sources);
        config["layout"] = working.visual["layout"].clone();
        let vertical = Orientation::of_layout(&working.visual["layout"]) == Orientation::Vertical;
        config["video"] = coerce_video_to_orientation(&config["video"], vertical);
        self.capture.replace_config(config);
    }

    /// `setActiveSavedSceneId` and its effect: the library keeps the scene
    /// on stream for the next launch.
    pub(super) fn set_scene_on_stream(&mut self, id: &str) {
        self.scenes.on_stream = Some(id.to_string());
        let Some(state) = &self.scenes.state else {
            return;
        };
        if let Ok(Some(library)) = state.set_on_stream(id) {
            self.write_library(library, false);
        }
    }

    /// `write`: the whole library over `ui.settings`; a refused write says
    /// so unless it is quiet, and keeps the state as it was.
    pub(super) fn write_library(&mut self, library: SceneLibrary, quiet: bool) -> bool {
        if self
            .scenes
            .state
            .as_ref()
            .is_none_or(|state| state.read_only)
        {
            return false;
        }
        if !self.stage_quietly(&[library_write(&library)]) {
            if !quiet {
                self.scenes.notices.push(save_failed());
            }
            return false;
        }
        if let Some(state) = &mut self.scenes.state {
            state.written(library);
        }
        self.remember_scene_apps();
        true
    }

    /// An edit's answer written, or nothing when it was refused.
    fn write_edit(&mut self, edit: Result<SceneLibrary, Refused>) -> bool {
        match edit {
            Ok(library) => self.write_library(library, false),
            Err(_) => false,
        }
    }

    /// `nameMainDisplay`: quiet, and only when something changes.
    fn name_main_display(&mut self, display: &MainDisplay) {
        let next = self
            .scenes
            .state
            .as_ref()
            .and_then(|state| state.name_main_display(display));
        if let Some(library) = next {
            self.write_library(library, true);
        }
    }

    /// The app memory (`videorc.scene-window-apps.v1`) bounded to the scenes
    /// that exist; stored when that changes it (best effort).
    pub(super) fn remember_scene_apps(&mut self) {
        if self.scenes.state.is_none() {
            return;
        }
        let members = super::js_value::stored_text(self.settings.get(keys::SCENE_WINDOW_APPS))
            .map(|text| RememberedSceneApps::parse(&text))
            .unwrap_or_default();
        let listed = self.listed_scenes();
        let next = remembered_scene_apps(&members, &listed);
        let stored = RememberedSceneApps(
            members
                .iter()
                .map(|(id, bundle)| (id.clone(), bundle.as_str().unwrap_or_default().to_string()))
                .collect(),
        );
        if next != stored || self.settings.get(keys::SCENE_WINDOW_APPS).is_none() {
            let text = next.to_json_text();
            let _ = self.stage_quietly(&[SettingWrite::Put {
                key: keys::SCENE_WINDOW_APPS.to_string(),
                value: Value::String(text),
            }]);
        }
        self.scenes.apps = next;
    }

    /// The studio's orientation (`layoutPresetOrientation(layoutPreset)`).
    pub(super) fn scene_orientation(&self) -> Orientation {
        Orientation::of_layout(&self.capture.config["layout"])
    }

    /// `sceneLibrary.scenes`: each stored scene in the studio's orientation,
    /// with the one camera (D9).
    pub(super) fn listed_scenes(&self) -> Vec<SavedScene> {
        let Some(state) = &self.scenes.state else {
            return Vec::new();
        };
        let orientation = self.scene_orientation();
        let camera = &self.capture.config["sources"];
        state
            .library
            .scenes
            .iter()
            .map(|scene| saved_scene_view(scene, orientation, camera))
            .collect()
    }

    /// A stored scene, as it is now (`stored(id)`).
    pub(super) fn stored_scene(&self, id: &str) -> Option<Scene> {
        self.scenes
            .state
            .as_ref()?
            .library
            .scenes
            .iter()
            .find(|scene| scene.id == id)
            .cloned()
    }

    /// The scenes for the snapshot.
    pub(super) fn scenes_view(&self) -> ScenesView {
        let Some(state) = &self.scenes.state else {
            return ScenesView {
                reload_mark: self.reload_mark(),
                ..ScenesView::default()
            };
        };
        let scenes = self.listed_scenes();
        let vertical_leg = simulcast_armed(&self.capture.config);
        let devices = &self.sources.devices.devices;
        let app_states = scenes
            .iter()
            .zip(&state.library.scenes)
            .filter(|(listed, own)| scene_draws_screen(own, &listed.visual["layout"], vertical_leg))
            .filter_map(|(listed, _)| {
                scene_app_state(
                    &listed.visual,
                    devices,
                    self.scenes.resolved.get(&listed.id).copied(),
                )
                .map(|app| (listed.id.clone(), app))
            })
            .collect();
        let saved_scene_modified = self.saved_scene_modified(&scenes);
        ScenesView {
            loaded: true,
            library: Some(state.library.clone()),
            scenes,
            on_stream_id: self.scenes.on_stream.clone(),
            read_only: state.read_only,
            error: state.error,
            app_states,
            remembered_apps: self.scenes.apps.clone(),
            pending_layout: self.scenes.switch.pending_layout.clone(),
            pending_scene_id: self.scenes.switch.pending_id.clone(),
            transaction_pending: self.scenes.switch.transaction_pending,
            working_background: self.scenes.switch.working_background.clone(),
            switch_progress: self.scenes.switch.progress.clone(),
            saved_scene_modified,
            reload_mark: self.reload_mark(),
        }
    }

    /// `savedSceneModified` (use-studio.tsx ~12328): the scene on stream, as
    /// listed, against the working look with the scene's sources set to the
    /// working ones, and its audio against the working audio.
    fn saved_scene_modified(&self, listed: &[SavedScene]) -> bool {
        let Some(id) = self.scenes.on_stream.as_deref() else {
            return false;
        };
        let Some(working) = self.working_visual() else {
            return false;
        };
        let config = &self.capture.config;
        let working_audio = scene_audio(
            &config["sources"],
            config["audio"]["systemAudioEnabled"] == Value::Bool(true),
        );
        listed.iter().any(|entry| {
            if entry.id != id {
                return false;
            }
            let mut visual = entry.visual.clone();
            visual["sources"] = working["sources"].clone();
            !same_scene_visual(&visual, &working)
                || !same_scene_audio(entry.audio.as_ref(), &working_audio)
        })
    }
}

impl<B: StudioBackend> Studio<B> {
    /// Sends the quiet writes a device list made (the main display named,
    /// the app memory bounded). A failed send stays journaled and retried.
    pub(super) async fn flush_scene_writes(&self) {
        let staged = std::mem::take(&mut self.lock().scenes.unflushed);
        if staged {
            let _ = self.flush_settings().await;
        }
    }

    /// Runs one library edit under the lock, then publishes, posts what it
    /// said and sends the write.
    async fn edit_scenes(&self, edit: impl FnOnce(&mut Inner) -> bool) -> bool {
        let wrote = {
            let mut inner = self.lock();
            if inner.scenes.state.is_none() {
                return false;
            }
            edit(&mut inner)
        };
        self.publish();
        if wrote {
            let _ = self.flush_settings().await;
        }
        wrote
    }

    /// Add scene… and Duplicate (D5): stored scenes at the end, or right
    /// after `after_id` (a duplicate's original). A taken name or id is
    /// refused, never renamed here. An app scene looks for its window in
    /// `window_hints` first (the picker's front window, plan 210 D5), which
    /// are taken even when the write is refused (as the renderer's
    /// `Object.assign` before `insert`).
    pub async fn insert_scenes(
        &self,
        added: &[Scene],
        after_id: Option<&str>,
        window_hints: &HashMap<String, String>,
    ) -> bool {
        self.edit_scenes(|inner| {
            inner.scenes.switch.window_hints.extend(
                window_hints
                    .iter()
                    .map(|(id, hint)| (id.clone(), hint.clone())),
            );
            let edit = inner
                .scenes
                .state
                .as_ref()
                .expect("checked")
                .insert(added, after_id);
            inner.write_edit(edit)
        })
        .await
    }

    /// Change screen…: a stored scene in its place; its app's window is
    /// looked for at `window_hint` first.
    pub async fn edit_scene(&self, scene: &Scene, window_hint: Option<&str>) -> bool {
        self.edit_scenes(|inner| {
            if let Some(hint) = window_hint.filter(|hint| !hint.is_empty()) {
                inner
                    .scenes
                    .switch
                    .window_hints
                    .insert(scene.id.clone(), hint.to_string());
            }
            let edit = inner.scenes.state.as_ref().expect("checked").replace(scene);
            inner.write_edit(edit)
        })
        .await
    }

    /// A ⋯ edit made on the scene as listed (following, audio, repaired
    /// sources): the stored scene with it, in its place.
    pub async fn replace_listed_scene(&self, scene: &SavedScene) -> bool {
        self.edit_scenes(|inner| {
            // An app scene's window is where it looks first.
            let sources = scene.visual.get("sources");
            if super::js_value::truthy(super::js_value::get(sources, "app"))
                && let Some(window) =
                    super::js_value::string(super::js_value::get(sources, "windowId"))
                        .filter(|window| !window.is_empty())
            {
                inner
                    .scenes
                    .switch
                    .window_hints
                    .insert(scene.id.clone(), window.to_string());
            }
            let Some(previous) = inner.stored_scene(&scene.id) else {
                return false;
            };
            let next = scene_from_saved(scene, &previous);
            let edit = inner.scenes.state.as_ref().expect("checked").replace(&next);
            inner.write_edit(edit)
        })
        .await
    }

    /// `rename`: the name trimmed; one that can't be taken is said.
    pub async fn rename_scene(&self, id: &str, name: &str) -> bool {
        let now = (self.config.clock)();
        self.edit_scenes(|inner| {
            let edit = inner
                .scenes
                .state
                .as_ref()
                .expect("checked")
                .rename(id, name, &now);
            if let Err(Refused::Name(error)) = &edit {
                inner
                    .scenes
                    .notices
                    .push(NoticeCommand::Show(ToastRequest::error(*error).finish()));
            }
            inner.write_edit(edit)
        })
        .await
    }

    /// `move`: the position keys move with the positions (D5).
    pub async fn move_scene(&self, id: &str, to_index: usize) -> bool {
        self.edit_scenes(|inner| {
            let edit = inner
                .scenes
                .state
                .as_ref()
                .expect("checked")
                .move_scene(id, to_index);
            inner.write_edit(edit)
        })
        .await
    }

    /// D2: a Screen pick changes the screen of scene `id`.
    pub async fn set_scene_shows(&self, id: &str, shows: SceneShows) -> bool {
        let now = (self.config.clock)();
        self.edit_scenes(|inner| {
            let Some(next) = inner
                .stored_scene(id)
                .and_then(|scene| scene_with_shows(&scene, shows, &now))
            else {
                return false;
            };
            let edit = inner.scenes.state.as_ref().expect("checked").replace(&next);
            inner.write_edit(edit)
        })
        .await
    }

    /// Plan 213 F1: a display scene's display as the device list names it
    /// now (not an edit: `updatedAt` stays).
    pub async fn refresh_scene_display(&self, id: &str) -> bool {
        self.edit_scenes(|inner| {
            let Some(next) = inner
                .stored_scene(id)
                .and_then(|scene| scene_display_refreshed(&scene, &inner.sources.devices.devices))
            else {
                return false;
            };
            let edit = inner.scenes.state.as_ref().expect("checked").replace(&next);
            inner.write_edit(edit)
        })
        .await
    }

    /// Several scenes edited in one write (first-run setup's look); the same
    /// scenes in the same order.
    pub async fn edit_all_scenes(&self, edit: impl FnOnce(&[Scene]) -> Vec<Scene>) -> bool {
        self.edit_scenes(|inner| {
            let edit = inner
                .scenes
                .state
                .as_ref()
                .expect("checked")
                .replace_all(edit);
            inner.write_edit(edit)
        })
        .await
    }

    /// The scenes as the Studio holds them now.
    pub fn scenes(&self) -> ScenesView {
        self.lock().scenes_view()
    }
}
