//! Plan 231: the scene library as the Studio holds it (`hooks/use-scenes.ts`):
//! loading it (the #1706 repair first, the v1 migration when there is no
//! usable library), and its edits. Every write is the whole library under
//! `videorc.scenes.v2`; `videorc.scene-presets.v1` is read once to migrate and
//! never written, so a downgrade still finds its scenes.
//!
//! Pure: each edit answers the library to store, or why not; the Studio
//! stores it (over `ui.settings`) and then calls [`ScenesState::written`].
//! A store that refused keeps the state as it was, as the hook's
//! `localStorage.setItem` failure does.

use serde_json::Value;

use super::migration::{Migrated, StoredForMigration, migrate_stored_scenes};
use super::model::{moved_scenes, scene_name_error};
use super::store::{
    DeleteRule, VerticalRepair, can_delete_scene, hydrate_scenes, normalize_scene,
    repair_stored_scene_verticals, with_main_display,
};
use super::v2::{MainDisplay, Scene, SceneLibrary};

/// What the Studio reads at launch.
pub struct StoredScenes<'a> {
    /// `videorc.scenes.v2`.
    pub scenes: Option<&'a Value>,
    /// The v1 keys, the capture config and the shortcuts, for a migration.
    pub migration: StoredForMigration<'a>,
}

/// `loadScenes`' state, plus what launch must store first.
#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
    pub state: ScenesState,
    /// #1706's repair, stored before the Studio reads anything: the
    /// working setup first, then the library.
    pub repair: Option<VerticalRepair>,
}

/// `ScenesState`.
#[derive(Debug, Clone, PartialEq)]
pub struct ScenesState {
    pub library: SceneLibrary,
    /// A version this build doesn't know: the scenes are today's setup, in
    /// memory, never written over the stored data.
    pub read_only: bool,
    pub error: Option<&'static str>,
    /// D15: the shortcuts after the layout keys moved to scene keys, from
    /// the launch that migrated until the settings holding them are stored
    /// (`settle_shortcuts`).
    pub migrated_shortcuts: Option<Value>,
    /// The migrated library is not stored yet.
    pub unwritten: bool,
}

/// `prepareScenes` + `loadScenes`: the library as stored (repaired once),
/// or the one migrated from v1 and the working setup when v2 is missing.
pub fn load_scenes(stored: &StoredScenes) -> Loaded {
    let hydrated = hydrate_scenes(stored.scenes);
    if let Some(library) = hydrated.library {
        let repair = repair_stored_scene_verticals(
            stored.scenes.unwrap_or(&Value::Null),
            stored.migration.working_scene,
        );
        // The repaired library is what the Studio reads.
        let library = repair
            .as_ref()
            .and_then(|repair| hydrate_scenes(Some(&repair.library)).library)
            .unwrap_or(library);
        let migrated_shortcuts = library.pending_shortcuts.clone();
        return Loaded {
            state: ScenesState {
                library,
                read_only: false,
                error: hydrated.error,
                migrated_shortcuts,
                unwritten: false,
            },
            repair,
        };
    }
    let read_only = hydrated.read_only;
    let Migrated {
        library,
        global_shortcuts,
    } = migrate_stored_scenes(&StoredForMigration {
        read_only,
        ..stored.migration.clone()
    });
    let library = if read_only {
        library
    } else {
        SceneLibrary {
            pending_shortcuts: Some(global_shortcuts.clone()),
            ..library
        }
    };
    Loaded {
        state: ScenesState {
            library,
            read_only,
            error: hydrated.error,
            migrated_shortcuts: (!read_only).then_some(global_shortcuts),
            unwritten: !read_only,
        },
        repair: None,
    }
}

/// Why an edit wrote nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// A library from a newer Videorc is never written over.
    ReadOnly,
    /// No scene with that id, or nothing to change.
    Nothing,
    /// A scene that doesn't read, or a taken id.
    Invalid,
    /// The name can't be taken (said to the streamer on a rename).
    Name(&'static str),
    /// D16's rule (`canDeleteScene`); the reason, when there is one.
    Delete(Option<&'static str>),
}

impl ScenesState {
    fn writable(&self) -> Result<(), Refused> {
        if self.read_only {
            Err(Refused::ReadOnly)
        } else {
            Ok(())
        }
    }

    fn with_scenes(&self, scenes: Vec<Scene>, on_stream_id: Option<String>) -> SceneLibrary {
        SceneLibrary {
            scenes,
            on_stream_id: on_stream_id.unwrap_or_else(|| self.library.on_stream_id.clone()),
            ..self.library.clone()
        }
    }

    /// The store took `library`: it is the state now.
    pub fn written(&mut self, library: SceneLibrary) {
        self.library = library;
        self.unwritten = false;
    }

    /// The migration to store once, after the first render (quietly: a
    /// failed write keeps the scenes in memory for the next change).
    pub fn pending_write(&self) -> Option<SceneLibrary> {
        (self.unwritten && !self.read_only).then(|| self.library.clone())
    }

    /// `settleShortcuts` (D15): the settings now hold the migrated keys and
    /// are stored, so the library stops keeping them. None when there is
    /// nothing to settle; [`ScenesState::shortcuts_settled`] after the write.
    pub fn settle_shortcuts(&self) -> Result<Option<SceneLibrary>, Refused> {
        if self.library.pending_shortcuts.is_none() {
            return Ok(None);
        }
        self.writable()?;
        Ok(Some(SceneLibrary {
            pending_shortcuts: None,
            ..self.library.clone()
        }))
    }

    /// The settled library was stored.
    pub fn shortcuts_settled(&mut self, library: SceneLibrary) {
        self.written(library);
        self.migrated_shortcuts = None;
    }

    /// `insert`: new scenes go at the end, so making one never moves a key
    /// in use (D5); a duplicate goes right after its original. A taken name
    /// is refused, never renamed here.
    pub fn insert(&self, added: &[Scene], after_id: Option<&str>) -> Result<SceneLibrary, Refused> {
        self.writable()?;
        let scenes = &self.library.scenes;
        let mut all = scenes.clone();
        let mut normalized = Vec::new();
        for scene in added {
            let scene = normalize_scene(&scene.to_json()).map_err(|_| Refused::Invalid)?;
            if all.iter().any(|entry| entry.id == scene.id) {
                return Err(Refused::Invalid);
            }
            if let Some(error) = scene_name_error(&scene.name, &all, None) {
                return Err(Refused::Name(error));
            }
            all.push(scene.clone());
            normalized.push(scene);
        }
        let at = after_id
            .and_then(|id| scenes.iter().position(|scene| scene.id == id))
            .map_or(scenes.len(), |index| index + 1);
        let mut next = scenes[..at].to_vec();
        next.extend(normalized);
        next.extend_from_slice(&scenes[at..]);
        Ok(self.with_scenes(next, None))
    }

    /// `replace`: an edit of one scene, in its place (its screen, a layout,
    /// its name, its audio).
    pub fn replace(&self, scene: &Scene) -> Result<SceneLibrary, Refused> {
        self.writable()?;
        let scenes = &self.library.scenes;
        if !scenes.iter().any(|entry| entry.id == scene.id) {
            return Err(Refused::Nothing);
        }
        if let Some(error) = scene_name_error(&scene.name, scenes, Some(&scene.id)) {
            return Err(Refused::Name(error));
        }
        let normalized = normalize_scene(&scene.to_json()).map_err(|_| Refused::Invalid)?;
        let next = scenes
            .iter()
            .map(|entry| {
                if entry.id == scene.id {
                    normalized.clone()
                } else {
                    entry.clone()
                }
            })
            .collect();
        Ok(self.with_scenes(next, None))
    }

    /// `rename`: the name, trimmed; a name that can't be taken is said.
    pub fn rename(&self, id: &str, name: &str, now: &str) -> Result<SceneLibrary, Refused> {
        let scene = self
            .library
            .scenes
            .iter()
            .find(|scene| scene.id == id)
            .ok_or(Refused::Nothing)?;
        if let Some(error) = scene_name_error(name, &self.library.scenes, Some(id)) {
            return Err(Refused::Name(error));
        }
        self.replace(&Scene {
            name: name.trim().to_string(),
            updated_at: now.to_string(),
            ..scene.clone()
        })
    }

    /// `move`: reordering moves the position keys with the positions (D5).
    pub fn move_scene(&self, id: &str, to_index: usize) -> Result<SceneLibrary, Refused> {
        self.writable()?;
        let next = moved_scenes(&self.library.scenes, id, to_index).ok_or(Refused::Nothing)?;
        Ok(self.with_scenes(next, None))
    }

    /// `setOnStream`: which scene is on stream, once the switch is
    /// confirmed. None when it already is.
    pub fn set_on_stream(&self, id: &str) -> Result<Option<SceneLibrary>, Refused> {
        if !self.library.scenes.iter().any(|scene| scene.id == id) {
            return Err(Refused::Nothing);
        }
        if id == self.library.on_stream_id {
            return Ok(None);
        }
        self.writable()?;
        Ok(Some(self.with_scenes(
            self.library.scenes.clone(),
            Some(id.to_string()),
        )))
    }

    /// `remove`, by D16's rule. When the scene on stream goes, the library
    /// names the scene before it in the same write: the Studio switches to
    /// it first.
    pub fn remove(&self, id: &str, session_active: bool) -> Result<SceneLibrary, Refused> {
        let scenes = &self.library.scenes;
        match can_delete_scene(
            scenes,
            id,
            &self.library.on_stream_id,
            session_active,
            false,
        ) {
            DeleteRule::Refused(reason) => Err(Refused::Delete(reason)),
            DeleteRule::Allowed { switch_to } => {
                self.writable()?;
                let next = scenes
                    .iter()
                    .filter(|scene| scene.id != id)
                    .cloned()
                    .collect();
                Ok(self.with_scenes(next, switch_to))
            }
        }
    }

    /// `nameMainDisplay`: the main display, once the device list names it,
    /// for the scenes that show it without knowing which it is. Not an
    /// edit; none when there is nothing to write.
    pub fn name_main_display(&self, display: &MainDisplay) -> Option<SceneLibrary> {
        if self.read_only {
            return None;
        }
        with_main_display(&self.library, display)
    }

    /// `replaceAll`: several scenes edited in one write (first-run setup's
    /// look); the same scenes, in the same order.
    pub fn replace_all(
        &self,
        edit: impl FnOnce(&[Scene]) -> Vec<Scene>,
    ) -> Result<SceneLibrary, Refused> {
        self.writable()?;
        let scenes = &self.library.scenes;
        let edited = edit(scenes);
        let mut normalized = Vec::with_capacity(edited.len());
        for scene in &edited {
            normalized.push(normalize_scene(&scene.to_json()).map_err(|_| Refused::Invalid)?);
        }
        if normalized.len() != scenes.len()
            || normalized
                .iter()
                .zip(scenes)
                .any(|(scene, before)| scene.id != before.id)
        {
            return Err(Refused::Invalid);
        }
        Ok(self.with_scenes(normalized, None))
    }
}
