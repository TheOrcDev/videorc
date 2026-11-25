//! Look (`buddy-avatar-section.tsx`, `buddy-look-section.tsx`,
//! `buddy-look-tiles.tsx`, plan 168 S-D2, plan 169): Still or Alive, with
//! the living preview beside it, its pause and Test. Still is the four
//! state pictures, or a new look being drawn (`cohost.avatar.*`) and its
//! draft; Alive is a move pack, worn from the list, imported from a
//! page-pet folder, or made with the creator. Everything persists through
//! `cohost.settings.set` with no success toast: the preview confirms.
//!
//! The look's state is app-core's `buddy::look::Look`, one per page:
//! My avatars, this section and the onboarding share it, as Electron's
//! `BuddyLookClientProvider` does.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{
    AnyElement, Context, Entity, Image, ImageFormat, ImageSource, KeyDownEvent, ObjectFit,
    SharedString, Window, div, img, prelude::*, px,
};
use serde::Deserialize;
use serde_json::{Value, json};
use videorc_app_core::buddy::copy as words;
use videorc_app_core::buddy::look::{
    DRAFT_EVENT, Draft, DraftStatus, Effect, Look, PROGRESS_EVENT, Progress, STATES,
};
use videorc_app_core::studio::families;
use videorc_app_core::studio::timecode::format_timecode;
use videorc_app_core::user_error::{Failure, UserErrorContext, user_error_message};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle};
use videorc_kit::empty::Empty;
use videorc_kit::kbd::Kbd;
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::skeleton::Skeleton;
use videorc_kit::spinner::Spinner;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{Theme, radius, text};
use videorc_protocol::buddy_pet::BuddyAvatar;
use videorc_protocol::cohost::{CohostPersona, CohostPersonaSource};

use super::gate::{
    alive_create_gate, gate_alert, images_left_line, look_redo_gate, pet_allowance_line, redo_label,
};
use super::preview::{PetPreview, STILL_PACK_ID};
use super::reactions::SaveSection;
use super::{AvatarScreen, pictures, sync_handle};

/// The preview's size on the page and the draft's (`BUDDY_TAB_PREVIEW_PX`,
/// `DRAFT_PREVIEW_PX`).
pub const TAB_PREVIEW_PX: f32 = 160.;
pub const DRAFT_PREVIEW_PX: f32 = 112.;
const UPDATE_THE_LOOK: UserErrorContext = UserErrorContext {
    action: "update",
    object: "your avatar's look",
};
/// `BUDDY_ONBOARDING_STEP4`'s words the tiles use.
const WORKING_LINE: &str = "Drawing the pictures. This takes one to three minutes.";
const POSE_FAILED: &str = "This pose did not come out. Redo it.";
const USE_AS_MY_AVATAR: &str = "Use as my avatar";
/// A page-pet import's limits (`collectBuddyPetFolder`).
const PET_MAX_FILES: usize = 128;
const PET_FILE_MAX_BYTES: u64 = 32 * 1024 * 1024;
const PET_PACK_MAX_BYTES: u64 = 128 * 1024 * 1024;
const PACK_TOO_LARGE: &str =
    "The pack is too large. Keep each file under 32 MB and the pack under 128 MB.";

/// One pack as `cohost.pet.list` lists it, with what the moves list shows.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRow {
    pub pack_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub gaze_count: u32,
    #[serde(default)]
    pub reactions: Vec<String>,
    /// `videorc-creator`, `page-pet-import` or `still`.
    #[serde(default)]
    pub source: String,
}

impl PackRow {
    /// `isBuddyShippedPack`: bundled or an official one it downloaded;
    /// never removed, never the persona's own.
    pub fn shipped(&self) -> bool {
        self.pack_id.starts_with("bundled:") || self.pack_id.starts_with("official:")
    }

    /// `buddyPetSourceLabel`.
    pub fn source_label(&self) -> &'static str {
        if self.shipped() {
            "Built in"
        } else if self.source == "videorc-creator" {
            "Made in Videorc"
        } else if self.source == "page-pet-import" {
            "Imported"
        } else {
            "Still"
        }
    }

    /// `buddyPetPosesLabel`: "37 poses".
    pub fn poses_label(&self) -> String {
        let count = self.gaze_count as usize + self.reactions.len();
        format!("{count} {}", if count == 1 { "pose" } else { "poses" })
    }
}

/// `buddyPackToWear`: the one worn last, else the persona's own, else the
/// one Videorc ships.
pub fn pack_to_wear<'a>(packs: &'a [PackRow], remembered: Option<&str>) -> Option<&'a PackRow> {
    remembered
        .and_then(|id| packs.iter().find(|pack| pack.pack_id == id))
        .or_else(|| packs.iter().find(|pack| !pack.shipped()))
        .or_else(|| packs.first())
}

/// Still, or Alive (which can show before a pack is worn: the empty state).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LookView {
    Still,
    Alive,
}

/// What the Still panel shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StillView {
    Working,
    Draft,
    Current,
}

/// The Look section's own state.
pub(super) struct LookUi {
    pub look: Look,
    /// Alive picked with nothing worn yet: the empty state, unsaved.
    alive_draft: bool,
    importing: bool,
    import_error: Option<String>,
    action_error: Option<String>,
    /// The elapsed clock runs while a look is drawn.
    clock: bool,
    /// The draft's pictures, read again when one is redrawn.
    draft_pictures: BTreeMap<String, Arc<Image>>,
    draft_key: Option<String>,
    remove: Option<PackRow>,
    remove_handle: DialogHandle,
    remove_want_open: bool,
    remove_was_open: bool,
    delete_handle: DialogHandle,
    delete_want_open: bool,
    delete_was_open: bool,
}

impl LookUi {
    pub fn new() -> Self {
        Self {
            look: Look::default(),
            alive_draft: false,
            importing: false,
            import_error: None,
            action_error: None,
            clock: false,
            draft_pictures: BTreeMap::new(),
            draft_key: None,
            remove: None,
            remove_handle: DialogHandle::new(false),
            remove_want_open: false,
            remove_was_open: false,
            delete_handle: DialogHandle::new(false),
            delete_want_open: false,
            delete_was_open: false,
        }
    }
}

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn refusal(error: &videorc_app_core::client::RpcError) -> (String, String) {
    let copy = user_error_message(Failure::Rpc(error), Some(UPDATE_THE_LOOK));
    (
        error.code.clone(),
        format!("{}. {}", copy.title, copy.description),
    )
}

impl AvatarScreen {
    // --- The look's controller (`use-buddy-look.ts`) ----------------------

    /// `cohost.avatar.draft.get`: a fresh window picks up a draft or a job.
    pub(super) fn refresh_look(&self, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let read = self.runtime.spawn(async move {
            backend
                .request("cohost.avatar.draft.get", Value::Null)
                .await
        });
        cx.spawn(async move |this, cx| {
            let answer = read.await;
            let _ = this.update(cx, |screen, cx| {
                match answer {
                    Ok(Ok(value)) => {
                        let status =
                            serde_json::from_value::<DraftStatus>(value).unwrap_or_default();
                        screen.look_ui.look.status(status, wall_ms());
                    }
                    Ok(Err(error)) => {
                        let (code, line) = refusal(&error);
                        screen.look_ui.look.status_failed(code, line);
                    }
                    Err(_) => {}
                }
                screen.look_changed(cx);
            });
        })
        .detach();
    }

    /// `cohost.avatar.progress` and `cohost.avatar.draft`.
    pub(super) fn look_event(&mut self, event: &str, payload: Value, cx: &mut Context<Self>) {
        let effect = if event == PROGRESS_EVENT {
            match serde_json::from_value::<Progress>(payload) {
                Ok(progress) => self.look_ui.look.progress(progress, wall_ms()),
                Err(_) => Effect::None,
            }
        } else if event == DRAFT_EVENT {
            match serde_json::from_value::<Draft>(payload) {
                Ok(draft) => self.look_ui.look.draft_event(draft),
                Err(_) => Effect::None,
            }
        } else {
            Effect::None
        };
        if effect == Effect::RefreshCapabilities {
            self.refresh(cx);
        }
        self.look_changed(cx);
    }

    /// `cohost.avatar.create` (the onboarding's "Create my avatar"): the
    /// params are Electron's (`description`, `inspirationBase64`, `name`,
    /// `personality`, `context`). False when a job already runs.
    #[allow(dead_code)] // The onboarding (batch B) calls it.
    pub(super) fn look_create(&mut self, params: Value, cx: &mut Context<Self>) -> bool {
        if !self.look_ui.look.begin_create(wall_ms()) {
            return false;
        }
        self.look_changed(cx);
        let backend = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { backend.request("cohost.avatar.create", params).await });
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |screen, cx| {
                match answer {
                    Ok(Ok(value)) => {
                        let request = value
                            .get("requestId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        screen.look_ui.look.create_accepted(request);
                    }
                    Ok(Err(error)) => {
                        let (code, line) = refusal(&error);
                        screen.look_ui.look.create_refused(code, line);
                    }
                    Err(_) => {}
                }
                screen.look_changed(cx);
            });
        })
        .detach();
        true
    }

    /// Redo one pose of the draft from its idle (one image).
    pub(super) fn look_redo(&mut self, state: &str, cx: &mut Context<Self>) {
        let Some(request) = self.look_ui.look.begin_redo(state, wall_ms()) else {
            return;
        };
        let params = json!({ "requestId": request, "state": state });
        self.look_changed(cx);
        let backend = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { backend.request("cohost.avatar.redo", params).await });
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |screen, cx| {
                match answer {
                    Ok(Ok(_)) => screen.look_ui.look.redo_accepted(),
                    Ok(Err(error)) => {
                        let (code, line) = refusal(&error);
                        screen.look_ui.look.redo_refused(code, line);
                    }
                    Err(_) => {}
                }
                screen.look_changed(cx);
            });
        })
        .detach();
    }

    /// Cancel while a create runs: the backend drops what it makes.
    pub(super) fn look_cancel(&mut self, cx: &mut Context<Self>) {
        let Some(request) = self.look_ui.look.begin_cancel() else {
            return;
        };
        self.look_discard_request(request, true, cx);
    }

    /// Delete the draft (its pictures go from the account).
    pub(super) fn look_discard(&mut self, cx: &mut Context<Self>) {
        let Some(request) = self.look_ui.look.begin_keep_or_discard(false) else {
            return;
        };
        self.look_discard_request(request, false, cx);
    }

    fn look_discard_request(&mut self, request: String, cancel: bool, cx: &mut Context<Self>) {
        self.look_changed(cx);
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.avatar.discard", json!({ "requestId": request }))
                .await
        });
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |screen, cx| {
                match answer {
                    Ok(Ok(value)) => {
                        let status =
                            serde_json::from_value::<DraftStatus>(value).unwrap_or_default();
                        if cancel {
                            let _ = screen.look_ui.look.cancelled(status);
                        } else {
                            screen.look_ui.look.discarded(status);
                        }
                    }
                    Ok(Err(error)) => {
                        let (code, line) = refusal(&error);
                        screen.look_ui.look.refused(code, line);
                    }
                    Err(_) => {}
                }
                screen.look_changed(cx);
            });
        })
        .detach();
    }

    /// "Use as my avatar": the backend keeps the draft, and its answer's
    /// persona is saved (`patchCohostSettings`). `then` runs once it is.
    pub(super) fn look_keep(
        &mut self,
        then: impl FnOnce(&mut Self, bool, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        let Some(request) = self.look_ui.look.begin_keep_or_discard(true) else {
            return;
        };
        self.look_changed(cx);
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.avatar.keep", json!({ "requestId": request }))
                .await
        });
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |screen, cx| {
                let kept = match answer {
                    Ok(Ok(value)) => {
                        screen.look_ui.look.kept();
                        if let Some(persona) = value.get("persona").cloned() {
                            screen.patch_settings(
                                json!({ "persona": persona }),
                                SaveSection::Look,
                                cx,
                            );
                        }
                        true
                    }
                    Ok(Err(error)) => {
                        let (code, line) = refusal(&error);
                        screen.look_ui.look.refused(code, line);
                        false
                    }
                    Err(_) => false,
                };
                then(screen, kept, cx);
                screen.look_changed(cx);
            });
        })
        .detach();
    }

    /// After every change: the draft's pictures, the clock, a redraw.
    fn look_changed(&mut self, cx: &mut Context<Self>) {
        self.load_draft_pictures(cx);
        self.kick_clock(cx);
        cx.notify();
    }

    /// The draft's pictures, read again on a new draft or a redrawn pose
    /// (its path stays, so the picture cache would keep the old one).
    fn load_draft_pictures(&mut self, cx: &mut Context<Self>) {
        let Some(draft) = self.look_ui.look.draft.clone() else {
            self.look_ui.draft_pictures.clear();
            self.look_ui.draft_key = None;
            return;
        };
        let key = format!(
            "{}:{}:{:?}",
            draft.request_id, self.look_ui.look.revision, draft.images
        );
        if self.look_ui.draft_key.as_deref() == Some(key.as_str()) {
            return;
        }
        self.look_ui.draft_key = Some(key.clone());
        let paths: Vec<(String, PathBuf)> = draft
            .images
            .iter()
            .filter_map(|(state, path)| {
                pictures::managed_path(&self.user_data_dir, path).map(|file| (state.clone(), file))
            })
            .collect();
        let read = cx.background_spawn(async move {
            paths
                .into_iter()
                .filter_map(|(state, path)| {
                    let bytes = std::fs::read(&path).ok()?;
                    let format = if path.extension().is_some_and(|ext| ext == "webp") {
                        ImageFormat::Webp
                    } else {
                        ImageFormat::Png
                    };
                    Some((state, Arc::new(Image::from_bytes(format, bytes))))
                })
                .collect::<BTreeMap<_, _>>()
        });
        cx.spawn(async move |this, cx| {
            let pictures = read.await;
            let _ = this.update(cx, |screen, cx| {
                if screen.look_ui.draft_key.as_deref() == Some(key.as_str()) {
                    screen.look_ui.draft_pictures = pictures;
                    screen.sync_draft_preview(cx);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// The elapsed clock under the tiles: once a second while a look is
    /// drawn, and only then.
    fn kick_clock(&mut self, cx: &mut Context<Self>) {
        if self.look_ui.clock || self.look_ui.look.running.is_none() {
            return;
        }
        self.look_ui.clock = true;
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let go_on = this
                    .update(cx, |screen, cx| {
                        if screen.look_ui.look.running.is_none() {
                            screen.look_ui.clock = false;
                            return false;
                        }
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !go_on {
                    break;
                }
            }
        })
        .detach();
    }

    // --- Still or Alive, the packs ----------------------------------------

    pub(super) fn look_view(&self) -> LookView {
        let worn = self
            .persona
            .as_ref()
            .is_some_and(|persona| matches!(persona.avatar, BuddyAvatar::Alive { .. }));
        if worn || self.look_ui.alive_draft {
            LookView::Alive
        } else {
            LookView::Still
        }
    }

    fn worn_pack(&self) -> Option<String> {
        match &self.persona.as_ref()?.avatar {
            BuddyAvatar::Alive { pack_id } => Some(pack_id.clone()),
            BuddyAvatar::Still => None,
        }
    }

    fn save_avatar(&mut self, avatar: BuddyAvatar, cx: &mut Context<Self>) {
        let Some(persona) = self.persona.as_ref() else {
            return;
        };
        let next = CohostPersona {
            avatar,
            ..persona.clone()
        };
        self.save_persona_with(next, SaveSection::Look, cx);
    }

    /// Wear a pack; Alive comes back to it after Still (G-10).
    fn wear(&mut self, pack_id: String, cx: &mut Context<Self>) {
        if self.worn_pack().as_deref() == Some(pack_id.as_str()) {
            return;
        }
        self.look_ui.import_error = None;
        self.look_ui.action_error = None;
        self.look_ui.alive_draft = false;
        if let Some(persona) = self.persona.as_ref() {
            let write = families::write_buddy_worn_pack(&persona.id, &pack_id);
            let studio = self.studio.clone();
            self.runtime.spawn(async move {
                let _ = studio.write_settings(vec![write]).await;
            });
        }
        self.save_avatar(BuddyAvatar::Alive { pack_id }, cx);
    }

    fn change_view(&mut self, next: LookView, cx: &mut Context<Self>) {
        if next == self.look_view() {
            return;
        }
        self.look_ui.import_error = None;
        self.look_ui.action_error = None;
        match next {
            LookView::Still => {
                self.look_ui.alive_draft = false;
                if self.worn_pack().is_some() {
                    self.save_avatar(BuddyAvatar::Still, cx);
                }
            }
            LookView::Alive => {
                let remembered = self.persona.as_ref().and_then(|persona| {
                    self.studio
                        .read_ui_settings(|cache| families::buddy_worn_pack(cache, &persona.id))
                });
                match pack_to_wear(&self.pack_rows, remembered.as_deref()) {
                    Some(pack) => {
                        let id = pack.pack_id.clone();
                        self.wear(id, cx);
                    }
                    None => self.look_ui.alive_draft = true,
                }
            }
        }
        cx.notify();
    }

    fn ask_remove(&mut self, pack: PackRow, cx: &mut Context<Self>) {
        self.look_ui.remove = Some(pack);
        self.look_ui.remove_want_open = true;
        cx.notify();
    }

    /// Remove: the worn pack goes back to Still first; then the files go.
    fn remove_pack(&mut self, cx: &mut Context<Self>) {
        self.look_ui.remove_want_open = false;
        let Some(pack) = self.look_ui.remove.clone() else {
            return;
        };
        self.look_ui.import_error = None;
        self.look_ui.action_error = None;
        if self.worn_pack().as_deref() == Some(pack.pack_id.as_str()) {
            self.save_avatar(BuddyAvatar::Still, cx);
            self.look_ui.alive_draft = true;
        }
        let backend = self.studio.backend().clone();
        let id = pack.pack_id.clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.pet.remove", json!({ "packId": id }))
                .await
        });
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |screen, cx| {
                if let Ok(Err(error)) = answer {
                    let copy = user_error_message(
                        Failure::Rpc(&error),
                        Some(UserErrorContext {
                            action: "remove",
                            object: "these moves",
                        }),
                    );
                    screen.look_ui.action_error =
                        Some(format!("{}. {}", copy.title, copy.description));
                }
                screen.refresh_packs(cx);
                cx.notify();
            });
        })
        .detach();
    }

    /// Import moves… (key I): pick a page-pet folder, copy its pack files
    /// under the persona's `pets/<uuid>/`, then `cohost.pet.import` checks
    /// and registers it; any refusal removes the copy and shows the reason.
    fn import_pack(&mut self, cx: &mut Context<Self>) {
        if self.look_ui.importing {
            return;
        }
        let Some(persona_id) = self.persona.as_ref().map(|persona| persona.id.clone()) else {
            return;
        };
        self.look_ui.import_error = None;
        self.look_ui.action_error = None;
        self.look_ui.importing = true;
        cx.notify();
        let picked = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Import moves".into()),
        });
        let root = self.user_data_dir.join(pictures::BUDDY_ASSETS_FOLDER);
        let backend = self.studio.backend().clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let folder = match picked.await {
                Ok(Ok(Some(mut paths))) if !paths.is_empty() => paths.remove(0),
                _ => {
                    let _ = this.update(cx, |screen, cx| {
                        screen.look_ui.importing = false;
                        cx.notify();
                    });
                    return;
                }
            };
            let job = runtime.spawn(async move {
                let pack_id = uuid::Uuid::new_v4().to_string();
                let target = root.join(&persona_id).join("pets").join(&pack_id);
                copy_pet_folder(&folder, &target)?;
                let token = format!("{persona_id}/pets/{pack_id}");
                match backend
                    .request("cohost.pet.import", json!({ "folderToken": token }))
                    .await
                {
                    Ok(summary) => Ok((pack_id, summary)),
                    Err(error) => {
                        let _ = std::fs::remove_dir_all(&target);
                        Err(error.message)
                    }
                }
            });
            let answer = job.await;
            let _ = this.update(cx, |screen, cx| {
                screen.look_ui.importing = false;
                match answer {
                    Ok(Ok((pack_id, summary))) => {
                        let id = summary
                            .get("packId")
                            .and_then(Value::as_str)
                            .map_or(pack_id, str::to_string);
                        screen.refresh_packs(cx);
                        screen.wear(id, cx);
                    }
                    Ok(Err(reason)) => screen.look_ui.import_error = Some(reason),
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    // --- The previews ------------------------------------------------------

    /// The preview plays what the section shows: Still's pictures, the worn
    /// pack, or nothing yet.
    pub(super) fn sync_previews(&mut self, cx: &mut Context<Self>) {
        let Some(persona) = self.persona.clone() else {
            return;
        };
        let worn = self.worn_pack();
        let user_data = self.user_data_dir.clone();
        let still = still_pictures(&persona, &user_data);
        self.preview.update(cx, |preview, cx| {
            preview.set_label(persona.name.clone());
            preview.set_motion(persona.motion);
            match (worn, self.look_ui.alive_draft) {
                (Some(pack_id), _) => preview.show_pack(&user_data, &persona.id, &pack_id, cx),
                (None, true) => preview.clear(cx),
                (None, false) => {
                    let key = still
                        .iter()
                        .map(|(state, _)| state.as_str())
                        .collect::<Vec<_>>()
                        .join(",");
                    let key = format!("{}:{key}:{:?}", persona.id, persona.images);
                    preview.show_still(key, still, cx);
                }
            }
        });
    }

    fn sync_draft_preview(&mut self, cx: &mut Context<Self>) {
        let pictures: Vec<(String, ImageSource)> = self
            .look_ui
            .draft_pictures
            .iter()
            .map(|(state, image)| (state.clone(), image.clone().into()))
            .collect();
        if pictures.is_empty() {
            return;
        }
        let key = self.look_ui.draft_key.clone().unwrap_or_default();
        self.draft_preview
            .update(cx, |preview, cx| preview.show_still(key, pictures, cx));
    }

    pub(super) fn sync_look_dialogs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        sync_handle(
            &self.look_ui.remove_handle,
            &mut self.look_ui.remove_want_open,
            &mut self.look_ui.remove_was_open,
            window,
            cx,
        );
        sync_handle(
            &self.look_ui.delete_handle,
            &mut self.look_ui.delete_want_open,
            &mut self.look_ui.delete_was_open,
            window,
            cx,
        );
    }

    fn look_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let modifiers = event.keystroke.modifiers;
        if modifiers.control || modifiers.alt || modifiers.platform {
            if event.keystroke.key == "enter"
                && modifiers.secondary(cx)
                && self.still_view() == StillView::Draft
            {
                cx.stop_propagation();
                self.look_keep(|_, _, _| {}, cx);
            }
            return;
        }
        match event.keystroke.key.as_str() {
            "t" if self.has_preview() => {
                cx.stop_propagation();
                self.open_test(window, cx);
            }
            "i" if self.look_view() == LookView::Alive => {
                cx.stop_propagation();
                self.import_pack(cx);
            }
            _ => {}
        }
    }

    fn has_preview(&self) -> bool {
        self.look_view() == LookView::Still || self.worn_pack().is_some()
    }

    fn still_view(&self) -> StillView {
        let look = &self.look_ui.look;
        let creating = look.creating()
            || look
                .running
                .as_ref()
                .is_some_and(|running| running.kind == "create");
        if creating {
            StillView::Working
        } else if look.draft.is_some() {
            StillView::Draft
        } else {
            StillView::Current
        }
    }
}

/// A Still persona's pictures (`stillImages`): its own for each state,
/// else its idle, else the default pack's.
pub(super) fn still_pictures(
    persona: &CohostPersona,
    user_data: &Path,
) -> Vec<(String, ImageSource)> {
    STATES
        .iter()
        .filter_map(|state| {
            let own = state_picture(persona, state)
                .or(persona.images.idle.as_deref())
                .and_then(|picture| pictures::managed_path(user_data, picture));
            let picture: Option<ImageSource> = match own {
                Some(path) => Some(path.into()),
                None => pictures::default_state(state).map(Into::into),
            };
            picture.map(|picture| ((*state).to_string(), picture))
        })
        .collect()
}

fn state_picture<'a>(persona: &'a CohostPersona, state: &str) -> Option<&'a str> {
    let images = &persona.images;
    match state {
        "idle" => images.idle.as_deref(),
        "talk" => images.talk.as_deref(),
        "laugh" => images.laugh.as_deref(),
        "think" => images.think.as_deref(),
        _ => None,
    }
}

/// `collectBuddyPetFolder` and the copy: the allow-listed files of a
/// page-pet folder (`sources/` one level down), never a link, with
/// page-pet's size and count limits.
fn copy_pet_folder(source: &Path, target: &Path) -> Result<(), String> {
    let mut files: Vec<(String, PathBuf, u64)> = Vec::new();
    let mut visit = |folder: &Path, prefix: &str| -> Result<(), String> {
        let mut entries: Vec<_> = std::fs::read_dir(folder)
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            let file = format!("{prefix}{name}");
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_file() && is_pet_file_name(&file) {
                let size = entry.metadata().map_err(|error| error.to_string())?.len();
                files.push((file, entry.path(), size));
            }
        }
        Ok(())
    };
    visit(source, "")?;
    let sources = source.join("sources");
    if std::fs::symlink_metadata(&sources).is_ok_and(|meta| meta.is_dir()) {
        visit(&sources, "sources/")?;
    }
    if !files.iter().any(|(file, _, _)| file == "manifest.json") {
        return Err("Choose a page-pet folder: it has no manifest.json.".into());
    }
    if files.len() > PET_MAX_FILES {
        return Err(format!("A pack has at most {PET_MAX_FILES} files."));
    }
    let total: u64 = files.iter().map(|(_, _, size)| size).sum();
    if files.iter().any(|(_, _, size)| *size > PET_FILE_MAX_BYTES) || total > PET_PACK_MAX_BYTES {
        return Err(PACK_TOO_LARGE.into());
    }
    let copy = || -> Result<(), String> {
        std::fs::create_dir_all(target.join("sources")).map_err(|error| error.to_string())?;
        for (file, path, _) in &files {
            let parts = Path::new(file);
            if !parts
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            {
                return Err(PACK_TOO_LARGE.into());
            }
            std::fs::copy(path, target.join(parts)).map_err(|error| error.to_string())?;
        }
        if !files
            .iter()
            .any(|(file, _, _)| file.starts_with("sources/"))
        {
            let _ = std::fs::remove_dir_all(target.join("sources"));
        }
        Ok(())
    };
    copy().inspect_err(|_| {
        let _ = std::fs::remove_dir_all(target);
    })
}

/// `isBuddyPetFileName`: the manifest and sidecars, sheets, and
/// `sources/*.png`.
fn is_pet_file_name(file: &str) -> bool {
    let plain = |name: &str| {
        !name.is_empty()
            && name.len() <= 96
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    if [
        "manifest.json",
        "buddy.json",
        "build-report.json",
        "provenance.json",
    ]
    .contains(&file)
    {
        return true;
    }
    if let Some(name) = file.strip_prefix("sources/") {
        return name.strip_suffix(".png").is_some_and(plain);
    }
    file.strip_suffix(".webp")
        .or_else(|| file.strip_suffix(".png"))
        .is_some_and(plain)
}

// --- Drawing --------------------------------------------------------------

pub(super) fn render_look(
    screen: &AvatarScreen,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) -> Option<AnyElement> {
    let persona = screen.persona.as_ref()?;
    let t = theme::resolve(None, window, cx);
    let entity = cx.entity();
    let view = screen.look_view();
    let name = persona.name.clone();

    let view_entity = entity.clone();
    let kind = SegmentedControl::new("avatar-look-kind")
        .small(true)
        .manual(true)
        .accessibility_label(words::LOOK_LABEL)
        .value(Some(if view == LookView::Still {
            "still"
        } else {
            "alive"
        }))
        .option(Segment::new("still", words::AVATAR_STILL))
        .option(Segment::new("alive", words::AVATAR_ALIVE))
        .on_change(move |value, _, cx| {
            let next = if value.as_ref() == "alive" {
                LookView::Alive
            } else {
                LookView::Still
            };
            view_entity.update(cx, |screen, cx| screen.change_view(next, cx));
        });

    let mut section = PanelSection::new("avatar-look")
        .title(words::LOOK_TITLE)
        .description(words::look_description(&name))
        .action(kind);

    // A new look under Still that Alive would hide (plan 174 G-10).
    let pending = match screen.still_view() {
        StillView::Working => Some(words::look_working(&name)),
        StillView::Draft => Some(words::look_waiting(&name)),
        StillView::Current => None,
    };
    if view == LookView::Alive
        && let Some(line) = pending
    {
        let to_still = entity.clone();
        section = section.child(
            Alert::new("avatar-look-pending").title(line).action(
                Button::new("avatar-look-switch-to-still")
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .label(words::SWITCH_TO_STILL)
                    .on_click(move |_, _, cx| {
                        to_still.update(cx, |screen, cx| screen.change_view(LookView::Still, cx))
                    }),
            ),
        );
    }

    let preview_column = screen
        .has_preview()
        .then(|| preview_column(screen, &name, t, cx));
    let panel = match view {
        LookView::Still => still_panel(screen, persona, t, cx),
        LookView::Alive => alive_panel(screen, t, cx),
    };
    let mut body = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w(px(0.))
        .gap(px(12.))
        .child(panel);
    if let Some(error) = screen
        .look_ui
        .action_error
        .clone()
        .or(screen.save_error(SaveSection::Look))
    {
        body = body.child(
            Alert::new("avatar-look-error")
                .variant(AlertVariant::Destructive)
                .title(error),
        );
    }
    section = section.child(
        div()
            .id("avatar-look-body")
            .flex()
            .flex_wrap()
            .items_start()
            .gap(px(16.))
            .on_key_down(cx.listener(|screen, event: &KeyDownEvent, window, cx| {
                screen.look_key(event, window, cx)
            }))
            .children(preview_column)
            .child(body),
    );
    Some(section.into_any_element())
}

/// The preview, "Click it to react" with its pause, and Test (key T).
fn preview_column(
    screen: &AvatarScreen,
    name: &str,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let entity = cx.entity();
    let preview = screen.preview.read(cx);
    let paused = preview.paused();
    let error = preview.error().map(str::to_string);
    let mut column = div()
        .flex()
        .flex_col()
        .items_center()
        .gap(px(8.))
        .flex_none()
        .child(screen.preview.clone());
    if let Some(error) = error {
        column = column.child(
            div()
                .max_w(px(TAB_PREVIEW_PX))
                .type_scale(text::META)
                .text_color(hsla(t.destructive))
                .child(error),
        );
        return column.into_any_element();
    }
    let pause = entity.clone();
    let test = entity;
    column
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .child(
                    div()
                        .type_scale(text::LABEL)
                        .font_weight(gpui::FontWeight::NORMAL)
                        .text_color(hsla(t.subtle))
                        .child("Click it to react"),
                )
                .child(
                    Button::new("avatar-preview-pause")
                        .variant(ButtonVariant::Ghost)
                        .size(ButtonSize::Xs)
                        .accessibility_label(if paused {
                            format!("Play {name}")
                        } else {
                            format!("Pause {name}")
                        })
                        .label(if paused { "Play" } else { "Pause" })
                        .on_click(move |_, _, cx| {
                            pause.update(cx, |screen, cx| {
                                screen
                                    .preview
                                    .update(cx, |preview, cx| preview.set_paused(!paused, cx))
                            })
                        }),
                ),
        )
        .child(
            Button::new("avatar-test-open")
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .label("Test")
                .child(Kbd::new("T"))
                .on_click(move |_, window, cx| {
                    test.update(cx, |screen, cx| screen.open_test(window, cx))
                }),
        )
        .into_any_element()
}

/// Still: the current look's four tiles, a look being drawn, or its draft.
fn still_panel(
    screen: &AvatarScreen,
    persona: &CohostPersona,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let entity = cx.entity();
    let look = &screen.look_ui.look;
    let view = screen.still_view();
    let busy = look.pending.is_some() || look.running.is_some();
    let (label, description) = match view {
        StillView::Working => (
            "Making the new look…".to_string(),
            "Idle first, then talk, laugh and think from it.".to_string(),
        ),
        StillView::Draft => (
            "Your new look".to_string(),
            format!(
                "Use it to give {} this look. Redo remakes one pose from this idle.",
                persona.name
            ),
        ),
        StillView::Current => (
            words::CURRENT_LOOK.to_string(),
            if persona.source == CohostPersonaSource::Default {
                words::DEFAULT_LOOK_DESCRIPTION.to_string()
            } else {
                words::own_look_description(&persona.name)
            },
        ),
    };
    let mut column = div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(field_label(&label, t))
        .child(meta(description, t));

    let mut tiles = div().flex().flex_wrap().gap(px(12.));
    for (state, pose) in words::POSE_LABELS {
        let tile = match view {
            StillView::Current => {
                let own = state_picture(persona, state);
                let fallback = own
                    .or(persona.images.idle.as_deref())
                    .and_then(|picture| pictures::managed_path(&screen.user_data_dir, picture));
                let (picture, badge): (Option<ImageSource>, Option<&str>) = match fallback {
                    Some(path) if own.is_some() => (Some(path.into()), None),
                    Some(path) => (Some(path.into()), Some(words::POSE_USES_IDLE)),
                    None => (
                        pictures::default_state(state).map(Into::into),
                        Some(words::POSE_DEFAULT),
                    ),
                };
                pose_tile(state, pose, picture, badge, None, t)
            }
            StillView::Working | StillView::Draft => {
                let drawn = screen
                    .look_ui
                    .draft_pictures
                    .get(state)
                    .map(|image| ImageSource::from(image.clone()));
                let failed = look.state_errors.contains_key(state)
                    || look
                        .draft
                        .as_ref()
                        .is_some_and(|draft| draft.failed.contains_key(state));
                let redo = (view == StillView::Draft && state != "idle").then(|| {
                    let gate = look_redo_gate(&screen.gate_input());
                    let redo = entity.clone();
                    let reason = gate.as_ref().map(|gate| gate.reason.clone());
                    let mut button =
                        Button::new(SharedString::from(format!("avatar-look-redo-{state}")))
                            .variant(ButtonVariant::Ghost)
                            .size(ButtonSize::Xs)
                            .label(redo_label("Redo"))
                            .disabled(busy || gate.is_some())
                            .on_click(move |_, _, cx| {
                                redo.update(cx, |screen, cx| screen.look_redo(state, cx))
                            });
                    if let Some(reason) = reason {
                        button = button.tooltip(reason);
                    }
                    button.into_any_element()
                });
                let mut tile = pose_tile(state, pose, drawn, None, redo, t);
                if failed {
                    tile = tile.child(
                        div()
                            .max_w(px(112.))
                            .type_scale(text::META)
                            .text_color(hsla(t.destructive))
                            .child(POSE_FAILED),
                    );
                }
                tile
            }
        };
        tiles = tiles.child(tile);
    }
    column = column.child(tiles);
    if view == StillView::Draft
        && let Some(line) = images_left_line(screen.capabilities.as_ref())
    {
        column = column.child(meta(line, t));
    }

    if view == StillView::Working {
        let elapsed = look
            .started_at
            .map(|started| format_timecode(wall_ms().saturating_sub(started) as i64));
        let cancelling = look.pending == Some(videorc_app_core::buddy::look::Pending::Cancel);
        let cancel = entity.clone();
        column = column.child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(12.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .text_size(px(14.))
                        .text_color(hsla(t.muted_foreground))
                        .child(Spinner::new("avatar-look-working").size(16.))
                        .child(WORKING_LINE),
                )
                .children(elapsed.map(|elapsed| meta(elapsed, t)))
                .child(
                    Button::new("avatar-look-cancel")
                        .variant(ButtonVariant::Ghost)
                        .size(ButtonSize::Xs)
                        .label(if cancelling { "Canceling…" } else { "Cancel" })
                        .disabled(cancelling)
                        .on_click(move |_, _, cx| {
                            cancel.update(cx, |screen, cx| screen.look_cancel(cx))
                        }),
                ),
        );
    }

    if view == StillView::Draft {
        let (keep, delete) = (entity.clone(), entity.clone());
        column = column.child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(16.))
                .child(screen.draft_preview.clone())
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w(px(192.))
                        .gap(px(8.))
                        .child(meta("The new look in motion. Click it to react.", t))
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    Button::new("avatar-look-keep")
                                        .label(USE_AS_MY_AVATAR)
                                        .disabled(busy)
                                        .on_click(move |_, _, cx| {
                                            keep.update(cx, |screen, cx| {
                                                screen.look_keep(|_, _, _| {}, cx)
                                            })
                                        }),
                                )
                                .child(
                                    Button::new("avatar-look-discard")
                                        .variant(ButtonVariant::Ghost)
                                        .label("Delete…")
                                        .disabled(busy)
                                        .on_click(move |_, _, cx| {
                                            delete.update(cx, |screen, cx| {
                                                screen.look_ui.delete_want_open = true;
                                                cx.notify();
                                            })
                                        }),
                                ),
                        ),
                ),
        );
    }

    if view == StillView::Current && persona.source != CohostPersonaSource::Default {
        let alive = entity.clone();
        column = column.child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(12.))
                .child(
                    Button::new("avatar-look-make-alive")
                        .variant(ButtonVariant::Outline)
                        .label(words::LIBRARY_MAKE_ALIVE)
                        .on_click(move |_, _, cx| {
                            alive.update(cx, |screen, cx| screen.open_alive_creator(cx))
                        }),
                )
                .child(meta(words::MAKE_IT_ALIVE_HINT, t)),
        );
    }

    if let Some((_, problem)) = look.problem.clone() {
        column = column.child(
            Alert::new("avatar-look-problem")
                .variant(AlertVariant::Destructive)
                .title(problem),
        );
    }
    column.into_any_element()
}

/// One pose tile (`BuddyPoseTile`): its picture, its name, a badge, Redo.
fn pose_tile(
    state: &'static str,
    pose: &'static str,
    picture: Option<ImageSource>,
    badge: Option<&'static str>,
    redo: Option<AnyElement>,
    t: &Theme,
) -> gpui::Div {
    let frame = div()
        .size(px(112.))
        .rounded(px(radius::CHIP))
        .overflow_hidden()
        .border_1()
        .border_color(hsla(t.border))
        .bg(hsla(t.inset))
        .child(match picture {
            Some(picture) => img(picture)
                .size_full()
                .p(px(6.))
                .object_fit(ObjectFit::Contain)
                .into_any_element(),
            None => Skeleton::new(SharedString::from(format!("avatar-pose-{state}")))
                .size_full()
                .into_any_element(),
        });
    div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(frame)
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(pose),
                )
                .children(badge.map(|badge| Badge::new(badge).variant(BadgeVariant::Outline))),
        )
        .children(redo)
}

/// Alive: the gate, the moves (radio rows: a click wears), Create, Import
/// moves… (I) and Remove, the allowance and the import's refusal.
fn alive_panel(screen: &AvatarScreen, t: &Theme, cx: &mut Context<AvatarScreen>) -> AnyElement {
    let entity = cx.entity();
    let gate = alive_create_gate(&screen.gate_input());
    let worn = screen.worn_pack();
    let mut column = div().flex().flex_col().gap(px(12.));
    if let Some(gate) = gate.as_ref() {
        let (sign_in, consent) = (entity.clone(), entity.clone());
        column = column.child(gate_alert(
            "avatar-alive-gate",
            gate,
            move |_, cx| sign_in.update(cx, |screen, cx| screen.sign_in(cx)),
            move |_, cx| consent.update(cx, |screen, cx| screen.open_consent(cx)),
        ));
    }
    let create = {
        let create = entity.clone();
        Button::new("avatar-pack-create")
            .variant(ButtonVariant::Outline)
            .label("Create")
            .disabled(gate.is_some())
            .on_click(move |_, _, cx| create.update(cx, |screen, cx| screen.open_alive_creator(cx)))
    };
    let import = {
        let import = entity.clone();
        Button::new("avatar-pack-import")
            .variant(ButtonVariant::Outline)
            .label(if screen.look_ui.importing {
                "Importing…"
            } else {
                words::IMPORT_MOVES
            })
            .disabled(screen.look_ui.importing)
            .child(Kbd::new("I"))
            .on_click(move |_, _, cx| import.update(cx, |screen, cx| screen.import_pack(cx)))
    };
    if let Some(error) = screen.packs_error.clone() {
        column = column.child(
            Alert::new("avatar-packs-error")
                .variant(AlertVariant::Destructive)
                .title(words::MOVES_LIST_FAILED)
                .description(div().child(error)),
        );
    } else if !screen.packs_loaded {
        column = column.child(meta(words::MOVES_LOADING, t));
    } else if screen.pack_rows.is_empty() {
        column = column.child(
            Empty::new().description(words::MOVES_EMPTY).child(
                div()
                    .flex()
                    .flex_wrap()
                    .justify_center()
                    .gap(px(8.))
                    .child(create)
                    .child(import),
            ),
        );
    } else {
        let mut list = GroupedList::new().label(words::MOVES_GROUP);
        for pack in &screen.pack_rows {
            let worn_here = worn.as_deref() == Some(pack.pack_id.as_str());
            let wear = entity.clone();
            let id = pack.pack_id.clone();
            let mut row = ListRow::new(
                SharedString::from(format!("avatar-pack-{}", pack.pack_id.replace(':', "-"))),
                pack.name.clone(),
            )
            .context(format!("{} · {}", pack.poses_label(), pack.source_label()))
            .selected(worn_here)
            .interactive(true)
            .on_click(move |_, _, cx| {
                let id = id.clone();
                wear.update(cx, |screen, cx| screen.wear(id, cx))
            });
            if worn_here {
                row = row.meta(words::MOVES_WEARING);
            }
            list = list.row(row);
        }
        let worn_row = screen
            .pack_rows
            .iter()
            .find(|pack| worn.as_deref() == Some(pack.pack_id.as_str()))
            .cloned();
        let remove = entity.clone();
        column = column.child(list).child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.))
                .child(create)
                .child(import)
                .child(div().flex_1())
                .child(
                    Button::new("avatar-pack-remove")
                        .variant(ButtonVariant::Ghost)
                        .label("Remove")
                        .disabled(worn_row.as_ref().is_none_or(PackRow::shipped))
                        .on_click(move |_, _, cx| {
                            if let Some(pack) = worn_row.clone() {
                                remove.update(cx, |screen, cx| screen.ask_remove(pack, cx))
                            }
                        }),
                ),
        );
    }
    if let Some(line) = pet_allowance_line(screen.capabilities.as_ref()) {
        column = column.child(meta(line, t));
    }
    if let Some(error) = screen.look_ui.import_error.clone() {
        column = column.child(
            Alert::new("avatar-import-error")
                .variant(AlertVariant::Destructive)
                .title("Couldn't import those moves")
                .description(div().child(error)),
        );
    }
    column.into_any_element()
}

/// The Remove confirm and the Delete-the-new-look confirm.
pub(super) fn look_dialogs(screen: &AvatarScreen, cx: &mut Context<AvatarScreen>) -> AnyElement {
    let entity = cx.entity();
    let name = screen
        .persona
        .as_ref()
        .map(|persona| persona.name.clone())
        .unwrap_or_default();
    let worn = screen.worn_pack();
    let library_pack = screen.persona.as_ref().and_then(|persona| {
        let id = persona.library_avatar_id.as_ref()?;
        screen
            .library
            .as_ref()?
            .mine
            .as_ref()?
            .iter()
            .find(|entry| &entry.id == id)?
            .alive
            .as_ref()
            .map(|alive| alive.pack_id.clone())
    });
    let mut dialogs = div();
    if let Some(pack) = screen.look_ui.remove.as_ref() {
        let mut body = if library_pack.as_deref() == Some(pack.pack_id.as_str()) {
            "Its files are deleted from this computer and from your Videorc library, so no other computer gets them.".to_string()
        } else {
            "Its files are deleted from this computer.".to_string()
        };
        body.push_str(if pack.source == "videorc-creator" {
            " Making it again uses one of your creations."
        } else {
            " You can import it again from its folder."
        });
        if worn.as_deref() == Some(pack.pack_id.as_str()) {
            body.push_str(&format!(" {name} goes back to Still."));
        }
        let (keep, remove) = (entity.clone(), entity.clone());
        dialogs = dialogs.child(
            Dialog::new(
                "avatar-pack-remove-confirm",
                &screen.look_ui.remove_handle,
                format!("Remove {}?", pack.name),
            )
            .description(body)
            .close_button(false)
            .footer(
                Button::new("avatar-pack-remove-keep")
                    .variant(ButtonVariant::Ghost)
                    .label("Keep it")
                    .on_click(move |_, _, cx| {
                        keep.update(cx, |screen, cx| {
                            screen.look_ui.remove_want_open = false;
                            cx.notify();
                        })
                    }),
            )
            .footer(
                Button::new("avatar-pack-remove-confirm-action")
                    .variant(ButtonVariant::Destructive)
                    .label("Remove")
                    .on_click(move |_, _, cx| {
                        remove.update(cx, |screen, cx| screen.remove_pack(cx))
                    }),
            ),
        );
    }
    let (keep, delete) = (entity.clone(), entity);
    dialogs = dialogs.child(
        Dialog::new(
            "avatar-look-delete-confirm",
            &screen.look_ui.delete_handle,
            "Delete the new look?",
        )
        .description(format!(
            "Its pictures are removed from your Videorc account. {name} keeps the current look."
        ))
        .close_button(false)
        .footer(
            Button::new("avatar-look-delete-keep")
                .variant(ButtonVariant::Ghost)
                .label("Keep it")
                .on_click(move |_, _, cx| {
                    keep.update(cx, |screen, cx| {
                        screen.look_ui.delete_want_open = false;
                        cx.notify();
                    })
                }),
        )
        .footer(
            Button::new("avatar-look-delete-confirm-action")
                .variant(ButtonVariant::Destructive)
                .label("Delete look")
                .on_click(move |_, _, cx| {
                    delete.update(cx, |screen, cx| {
                        screen.look_ui.delete_want_open = false;
                        screen.look_discard(cx);
                    })
                }),
        ),
    );
    dialogs.into_any_element()
}

fn field_label(label: &str, t: &Theme) -> gpui::Div {
    div()
        .text_size(px(14.))
        .line_height(px(20.))
        .font_weight(gpui::FontWeight::MEDIUM)
        .text_color(hsla(t.foreground))
        .child(label.to_string())
}

fn meta(line: impl Into<SharedString>, t: &Theme) -> gpui::Div {
    div()
        .type_scale(text::META)
        .text_color(hsla(t.muted_foreground))
        .child(line.into())
}

/// The two previews the page owns: the section's and the draft's.
pub(super) fn new_previews(
    cx: &mut Context<AvatarScreen>,
) -> (Entity<PetPreview>, Entity<PetPreview>) {
    let preview = cx.new(|_| PetPreview::new(TAB_PREVIEW_PX, STILL_PACK_ID));
    let draft = cx.new(|_| PetPreview::new(DRAFT_PREVIEW_PX, "draft"));
    cx.observe(&preview, |_, _, cx| cx.notify()).detach();
    (preview, draft)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, source: &str) -> PackRow {
        PackRow {
            pack_id: id.into(),
            name: id.into(),
            gaze_count: 9,
            reactions: vec!["wave".into()],
            source: source.into(),
        }
    }

    #[test]
    fn packs_say_where_they_came_from_and_which_alive_wears() {
        let packs = [
            row("bundled:buddy", "still"),
            row("3f2c", "page-pet-import"),
        ];
        assert_eq!(packs[0].source_label(), "Built in");
        assert_eq!(packs[1].source_label(), "Imported");
        assert_eq!(packs[1].poses_label(), "10 poses");
        assert_eq!(
            pack_to_wear(&packs, None).map(|pack| pack.pack_id.as_str()),
            Some("3f2c")
        );
        assert_eq!(
            pack_to_wear(&packs, Some("bundled:buddy")).map(|pack| pack.pack_id.as_str()),
            Some("bundled:buddy")
        );
    }

    #[test]
    fn only_page_pet_files_are_imported() {
        for ok in [
            "manifest.json",
            "buddy.json",
            "sheet_1.webp",
            "a-b.png",
            "sources/pilot.png",
        ] {
            assert!(is_pet_file_name(ok), "{ok}");
        }
        for no in [
            "notes.txt",
            "../x.png",
            "sources/a.webp",
            "sources/x/y.png",
            ".hidden.png",
            "sheet.gif",
        ] {
            assert!(!is_pet_file_name(no), "{no}");
        }
    }

    #[test]
    fn an_import_copies_the_pack_and_refuses_a_folder_without_a_manifest() {
        let base = std::env::temp_dir().join(format!("videorc-pet-{}", uuid::Uuid::new_v4()));
        let source = base.join("source");
        std::fs::create_dir_all(source.join("sources")).unwrap();
        std::fs::write(source.join("sheet.webp"), b"x").unwrap();
        std::fs::write(source.join("readme.txt"), b"x").unwrap();
        let target = base.join("target");
        assert!(copy_pet_folder(&source, &target).is_err());
        assert!(!target.exists());
        std::fs::write(source.join("manifest.json"), b"{}").unwrap();
        std::fs::write(source.join("sources").join("pilot.png"), b"x").unwrap();
        copy_pet_folder(&source, &target).unwrap();
        assert!(target.join("manifest.json").exists());
        assert!(target.join("sheet.webp").exists());
        assert!(target.join("sources").join("pilot.png").exists());
        assert!(!target.join("readme.txt").exists());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
