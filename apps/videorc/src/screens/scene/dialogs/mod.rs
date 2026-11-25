//! The scene dialogs (`scene-dialogs.tsx`'s `useSceneDialogs`), shared:
//! Rename scene, Delete scene?, the picker (Add scene…, Change screen…),
//! Set key…, Guests in the room… and Resolve scene sources. One
//! [`SceneDialogs`] entity per window holds their state and draws them; the
//! Scene page and the Studio's Scenes ⋯ menu open them with the scene's id
//! and a done callback (true when the dialog's write or apply went
//! through, false when it was cancelled or dismissed).
//!
//! Shared interface (plan 260 queues, "Shared interfaces"): L1 owns it, L7's
//! Studio Scenes section uses it.

mod guests;
mod picker;
mod rename;
mod resolve;
mod setkey;

use std::sync::Arc;

use gpui::{App, Context, Entity, Window, div, prelude::*};
use videorc_app_core::scenes::store::{DeleteRule, can_delete_scene};
use videorc_app_core::studio::transport::transport_active;
use videorc_kit::command::InputEvent;
use videorc_kit::dialog::DialogHandle;
use videorc_kit::input::InputState;

use super::AppStudio;
use picker::PickerMode;

/// Called once when the dialog it was opened with closes: `true` when its
/// write or apply went through.
/// The ⋯ menu's words for the dialogs whose copy lives here.
pub const SET_KEY_LABEL: &str = setkey::copy::MENU_ITEM;
pub const GUESTS_LABEL: &str = guests::copy::MENU_ITEM;

pub type Done = Box<dyn FnOnce(bool, &mut Window, &mut App)>;

/// The Rename dialog while it is open.
struct Renaming {
    id: String,
    error: Option<String>,
    busy: bool,
}

/// The Delete confirmation while it is open.
struct Deleting {
    id: String,
    name: String,
    next: Option<String>,
    busy: bool,
}

pub struct SceneDialogs {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    /// The global keys, kept quiet while Set key… records.
    hotkeys: crate::app::hotkeys::Hotkeys,
    rename: DialogHandle,
    rename_input: Entity<InputState>,
    renaming: Option<Renaming>,
    delete: DialogHandle,
    deleting: Option<Deleting>,
    picker: DialogHandle,
    picker_search: Entity<InputState>,
    picking: Option<picker::Picking>,
    guests: DialogHandle,
    guesting: Option<guests::Guesting>,
    resolve: DialogHandle,
    resolving: Option<resolve::Resolving>,
    set_key: DialogHandle,
    setting_key: Option<setkey::SettingKey>,
    /// The open dialog's callback, and whether its write went through.
    on_done: Option<Done>,
    succeeded: bool,
}

impl SceneDialogs {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        hotkeys: crate::app::hotkeys::Hotkeys,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let rename_input = cx.new(|cx| {
            InputState::new(window, cx)
                .validate(|value, _| value.chars().count() <= rename::NAME_MAX_CHARS)
        });
        cx.subscribe_in(
            &rename_input,
            window,
            |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::Change) {
                    // Typing clears the error (`sceneNameError` waits for Enter).
                    if let Some(renaming) = &mut this.renaming {
                        renaming.error = None;
                    }
                    cx.notify();
                }
                if matches!(event, InputEvent::PressEnter { .. }) && this.rename.is_open() {
                    this.submit_rename(window, cx);
                }
            },
        )
        .detach();
        let picker_search = cx.new(|cx| InputState::new(window, cx));
        Self {
            studio,
            runtime,
            hotkeys,
            rename: DialogHandle::new(false),
            rename_input,
            renaming: None,
            delete: DialogHandle::new(false),
            deleting: None,
            picker: DialogHandle::new(false),
            picker_search,
            picking: None,
            guests: DialogHandle::new(false),
            guesting: None,
            resolve: DialogHandle::new(false),
            resolving: None,
            set_key: DialogHandle::new(false),
            setting_key: None,
            on_done: None,
            succeeded: false,
        }
    }

    /// Runs a Studio call on the core's runtime.
    fn run(&self, job: impl std::future::Future<Output = ()> + Send + 'static) {
        self.runtime.spawn(job);
    }

    /// A new dialog takes the callback; one still waiting hears false.
    fn begin(&mut self, done: Option<Done>, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(previous) = self.on_done.take() {
            cx.defer_in(window, move |_, window, cx| previous(false, window, cx));
        }
        self.on_done = done;
        self.succeeded = false;
    }

    fn any_open(&self) -> bool {
        self.renaming.is_some()
            || self.deleting.is_some()
            || self.picking.is_some()
            || self.guesting.is_some()
            || self.resolving.is_some()
            || self.setting_key.is_some()
    }

    /// The scene's name and whether it is on stream.
    fn scene_facts(&self, scene_id: &str) -> Option<(String, bool)> {
        let watch = self.studio.watch();
        let snapshot = watch.borrow();
        let scene = snapshot
            .scenes
            .scenes
            .iter()
            .find(|scene| scene.id == scene_id)?;
        let on_stream = snapshot.scenes.on_stream_id.as_deref() == Some(scene_id);
        Some((scene.name.clone(), on_stream))
    }

    /// Rename scene.
    pub fn open_rename(
        &mut self,
        scene_id: &str,
        done: Option<Done>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((name, _)) = self.scene_facts(scene_id) else {
            return;
        };
        self.begin(done, window, cx);
        self.show_rename(scene_id, &name, window, cx);
    }

    /// Delete scene? (only where `canDeleteScene` allows it).
    pub fn open_delete(
        &mut self,
        scene_id: &str,
        done: Option<Done>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (name, next) = {
            let watch = self.studio.watch();
            let snapshot = watch.borrow();
            let view = &snapshot.scenes;
            let Some(scene) = view.scenes.iter().find(|scene| scene.id == scene_id) else {
                return;
            };
            let rule = can_delete_scene(
                &view.scenes,
                scene_id,
                view.on_stream_id.as_deref().unwrap_or_default(),
                transport_active(&snapshot.session),
                view.pending_scene_id.as_deref() == Some(scene_id),
            );
            let next = match rule {
                DeleteRule::Allowed { switch_to } => switch_to.and_then(|next| {
                    view.scenes
                        .iter()
                        .find(|other| other.id == next)
                        .map(|other| other.name.clone())
                }),
                DeleteRule::Refused(_) => return,
            };
            (scene.name.clone(), next)
        };
        self.begin(done, window, cx);
        self.show_delete(scene_id, &name, next, window, cx);
    }

    /// Add scene…: each choice becomes a scene at the end of the list.
    pub fn open_add(&mut self, done: Option<Done>, window: &mut Window, cx: &mut Context<Self>) {
        self.begin(done, window, cx);
        self.show_picker(PickerMode::Add, window, cx);
    }

    /// Change screen… for one scene; `for_layout` is D19's layout that
    /// asked for a screen, applied once the screen lands.
    pub fn open_change_screen(
        &mut self,
        scene_id: &str,
        for_layout: Option<String>,
        done: Option<Done>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((name, on_stream)) = self.scene_facts(scene_id) else {
            return;
        };
        self.begin(done, window, cx);
        let mode = PickerMode::Change {
            scene_id: scene_id.to_string(),
            name,
            on_stream,
            for_layout,
        };
        self.show_picker(mode, window, cx);
    }

    /// Set key….
    pub fn open_set_key(
        &mut self,
        scene_id: &str,
        done: Option<Done>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((name, _)) = self.scene_facts(scene_id) else {
            return;
        };
        self.begin(done, window, cx);
        self.show_set_key(scene_id, &name, window, cx);
    }

    /// Guests in the room….
    pub fn open_guests(
        &mut self,
        scene_id: &str,
        done: Option<Done>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.begin(done, window, cx);
        self.show_guests(scene_id, window, cx);
    }

    /// Resolve scene sources; `apply_failed` adds the failed apply's line
    /// (P485).
    pub fn open_resolve(
        &mut self,
        scene_id: &str,
        apply_failed: bool,
        done: Option<Done>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let scene = self
            .studio
            .watch()
            .borrow()
            .scenes
            .scenes
            .iter()
            .find(|scene| scene.id == scene_id)
            .cloned();
        let Some(scene) = scene else {
            return;
        };
        self.begin(done, window, cx);
        let error = apply_failed.then_some(resolve::copy::FAILED);
        self.show_resolve(scene, error, window, cx);
    }
}

impl Render for SceneDialogs {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Every close path notifies: the callback hears how it went.
        if !self.any_open()
            && let Some(done) = self.on_done.take()
        {
            let succeeded = std::mem::take(&mut self.succeeded);
            cx.defer_in(window, move |_, window, cx| done(succeeded, window, cx));
        }
        div()
            .child(self.rename_dialog(window, cx))
            .child(self.delete_dialog(cx))
            .child(self.picker_dialog(window, cx))
            .child(self.guests_dialog(window, cx))
            .child(self.resolve_dialog(window, cx))
            .child(self.set_key_dialog(window, cx))
    }
}
