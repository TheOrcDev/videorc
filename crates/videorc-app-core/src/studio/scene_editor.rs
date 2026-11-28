//! Plan 260 S1.6b part 4b-2 (L7): what the Scene page's canvas editor and
//! inspector ask of the Studio, from videorc-rust's `studio::{stage,
//! scene_inspector}` on plan 231's scene switch (`use-studio.tsx`:
//! `setSceneSourceTransform` with `commitSceneTransform`,
//! `nudgeSceneSource`, `syncSourceTransformsToLayout`,
//! `setSceneEditorDraft` / `clearSceneEditorDraft`, `undoLayoutPatch`,
//! `applyLayoutPatch`, `applyCameraLook`, `setSceneSourceVisible`,
//! `resetSceneSource`, `applyWorkingBackgroundStyle`, the banners' and the
//! overlay layout's saves, and `lib/freeform-memory.ts`).
//!
//! A released drag commits through `scene.source.transform.update` with
//! `snap: none`, a nudge through `scene.source.nudge`; each answer is the
//! committed scene, which the Studio takes, and whose boxes go back into
//! the capture config (Freeform: every source's override; a preset: the
//! camera's custom box), the working setup and, by D11, the scene on stream.
//! Every layout edit from the inspector is one layout transaction.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Map, Value, json};
use videorc_protocol::{Scene, SceneSource, SceneSourceKind};

use super::capture_config;
use super::families::{PrivacySettings, save_privacy_settings};
use super::js_value::string;
use super::scene_switch::{ApplyOptions, PresetOptions, SwitchRefusal, TransactionOptions};
use super::settings::{SettingWrite, keys};
use super::{Connection, Inner, Studio, StudioBackend};
use crate::client::RpcError;
use crate::editor::inspector::normalize_camera_look;
use crate::editor::stage::{CommitOutcome, StageRect};
use crate::log::Logger;
use crate::notices::{NoticeCommand, ToastRequest};
use crate::scenes::background::{resolve_saved_background, snapshot_background};
use crate::scenes::framing::vertical_orientation_video_patch;
use crate::scenes::model::Origin;
use crate::user_error::{Failure, UserErrorContext, backend_error_toast, toast_user_error};

/// The backend's methods the editor calls.
pub const TRANSFORM_UPDATE_METHOD: &str = "scene.source.transform.update";
pub const NUDGE_METHOD: &str = "scene.source.nudge";
pub const DRAFT_SET_METHOD: &str = "scene.editor.draft.set";
pub const DRAFT_CLEAR_METHOD: &str = "scene.editor.draft.clear";
pub const OVERLAY_LAYOUT_GET_METHOD: &str = "overlays.layout.get";
pub const OVERLAY_LAYOUT_SET_METHOD: &str = "overlays.layout.set";
pub const BANNERS_LIST_METHOD: &str = "banners.list";
pub const BANNERS_UPDATE_METHOD: &str = "banners.update";
pub const BANNERS_SHOW_METHOD: &str = "banners.show";
pub const BANNERS_HIDE_METHOD: &str = "banners.hide";
pub const BANNERS_REORDER_METHOD: &str = "banners.reorder";
pub const VISIBILITY_UPDATE_METHOD: &str = "scene.source.visibility.update";
pub const TRANSFORM_RESET_METHOD: &str = "scene.source.transform.reset";
/// The backend's code for a draft refused while a session runs.
pub const DRAFT_REFUSED_CODE: &str = "editor-draft-refused";

/// `{action: 'change', object: 'the scene'}`.
pub const CHANGE_THE_SCENE: UserErrorContext = UserErrorContext {
    action: "change",
    object: "the scene",
};
pub const MOVE_THE_OVERLAY: UserErrorContext = UserErrorContext {
    action: "move",
    object: "the overlay",
};
pub const MOVE_THE_BANNER: UserErrorContext = UserErrorContext {
    action: "move",
    object: "the banner",
};
pub const SHOW_THE_BANNER: UserErrorContext = UserErrorContext {
    action: "show",
    object: "the banner",
};
pub const HIDE_THE_BANNER: UserErrorContext = UserErrorContext {
    action: "hide",
    object: "the banner",
};
pub const CHANGE_THE_BANNER: UserErrorContext = UserErrorContext {
    action: "change",
    object: "the banner",
};
pub const RENAME_THE_BANNER: UserErrorContext = UserErrorContext {
    action: "rename",
    object: "the banner",
};

/// `updateBanner`'s words: a patch with a name renames, one with a rect
/// moves, any other changes the banner.
pub fn banner_update_context(patch: &Map<String, Value>) -> UserErrorContext {
    let truthy = |key: &str| {
        patch
            .get(key)
            .is_some_and(|value| !value.is_null() && value != &Value::Bool(false))
    };
    if patch.contains_key("name") {
        RENAME_THE_BANNER
    } else if truthy("horizontal") || truthy("vertical") {
        MOVE_THE_BANNER
    } else {
        CHANGE_THE_BANNER
    }
}
const SCENE_EDIT_TOAST_ID: &str = "scene-edit";
const BANNER_REFUSAL_TOAST_ID: &str = "banner-refusal";
/// `commitSceneTransform`'s own sentences.
pub const EDITING_UNAVAILABLE: &str = "Scene editing is unavailable. Reconnect and try again.";
pub const NOT_APPLIED: &str = "Scene transform wasn't applied.";
pub const SOURCE_GONE: &str = "The edited source is no longer available.";
/// The Images page's background refusal (#2491): the title, and the
/// reasons when the switch itself gave none.
pub const BACKGROUND_NOT_APPLIED: &str = "Couldn't apply the background";
pub const BACKGROUND_UNAVAILABLE: &str =
    "This background isn't available. Choose another background or import the image again.";
pub const BACKGROUND_TRY_AGAIN: &str =
    "Check your scene, then try again. If it keeps happening, open Health.";
pub const BACKGROUND_INVALID_CODE: &str = "background-invalid";
pub const BACKGROUND_NOT_APPLIED_CODE: &str = "background-not-applied";
/// `setSceneSourceVisible`'s own sentence.
pub const VISIBILITY_NOT_ACKNOWLEDGED: &str = "Source visibility wasn't acknowledged.";

/// `BANNER_REFUSALS` (`lib/banners.ts`): the backend's refusals, said as
/// they are (a warning), never as a generic failure.
pub const BANNER_REFUSALS: [&str; 13] = [
    "This file isn't a PNG, JPEG or WebP image.",
    "Animated images aren't supported yet. Export a still PNG.",
    "This image is too large. Use one under 25 MB and 40 megapixels.",
    "This image is too small. Use one at least 16 × 16 px.",
    "You have 24 banners. Delete one to import another.",
    "Four banners are showing. Hide one first.",
    "This recording can't add banners after it starts. Show the banner before you press Record.",
    "Hide this banner before you delete it.",
    "This isn't an HTML file. Choose an .html file or a folder with index.html.",
    "This folder has no index.html.",
    "This HTML banner is too large. Use one under 64 MB and 512 files.",
    "This HTML banner has a link to a file outside its folder. Copy the file in.",
    "HTML banners can't join this recording. Hide it, or record at 30 fps.",
];

/// `BANNER_ACTION_COPY` (`lib/banners.ts`): what a show or hide away from
/// Studio (a remote, the Stream Manager) says when it can't run.
pub const BANNER_ACTION_MISSING: &str = "That banner isn't available anymore.";
pub const BANNER_ACTION_SHOW: &str = "Couldn't show the banner.";
pub const BANNER_ACTION_HIDE: &str = "Couldn't hide the banner.";
pub const BANNER_ACTION_HIDE_ALL: &str = "Couldn't hide the banners.";

/// `bannerRefusalError`: the refusal a backend message carries, if any.
pub fn banner_refusal(message: &str) -> Option<&'static str> {
    BANNER_REFUSALS
        .iter()
        .copied()
        .find(|sentence| message.contains(sentence))
}

// --- the layout undo and the Freeform memory (`lib/freeform-memory.ts`) ---

/// `LayoutUndoEntry`: a committed layout a single ⌘Z returns to, with the
/// scene it belonged to.
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutUndoEntry {
    pub layout: Value,
    pub saved_id: Option<String>,
    pub origin: Origin,
}

/// `layoutUndoAfterCommit`: a commit that leaves the layout as it was (a
/// background change, a reconciliation) keeps the slot; any other takes the
/// layout it replaced.
pub fn layout_undo_after_commit(
    slot: Option<LayoutUndoEntry>,
    previous: Option<LayoutUndoEntry>,
    next: &Value,
) -> Option<LayoutUndoEntry> {
    match previous {
        Some(previous) if previous.layout != *next => Some(previous),
        _ => slot,
    }
}

/// The overrides a preset replaced, by orientation (`horizontal`,
/// `vertical`), so Freeform comes back as it was left instead of re-seeding
/// from the preset (plan 174 C-4).
pub type FreeformMemory = BTreeMap<&'static str, Map<String, Value>>;

/// `layoutPresetOrientation`, as the memory's key.
pub fn layout_orientation(layout: &Value) -> &'static str {
    if string(layout.get("layoutPreset")).is_some_and(capture_config::layout_preset_is_vertical) {
        "vertical"
    } else {
        "horizontal"
    }
}

/// `rememberFreeform`: a Freeform layout's overrides go under its
/// orientation; any other layout, or one with no overrides, changes nothing.
pub fn remember_freeform(memory: &mut FreeformMemory, layout: &Value) {
    if string(layout.get("arrangementMode")) != Some("freeform") {
        return;
    }
    let Some(overrides) = layout
        .get("sourceTransformOverrides")
        .and_then(Value::as_object)
        .filter(|overrides| !overrides.is_empty())
    else {
        return;
    };
    memory.insert(layout_orientation(layout), overrides.clone());
}

/// `freeformEntryOverrides`: the remembered placement of every source the
/// scene still has; a source with no memory starts at `seed`, so nothing
/// else moves.
pub fn freeform_entry_overrides(
    memory: &FreeformMemory,
    orientation: &str,
    sources: &[SceneSource],
    mut seed: impl FnMut(&SceneSource) -> Value,
) -> Map<String, Value> {
    let remembered = memory.get(orientation);
    sources
        .iter()
        .map(|source| {
            let value = remembered
                .and_then(|overrides| overrides.get(&source.id))
                .cloned()
                .unwrap_or_else(|| seed(source));
            (source.id.clone(), value)
        })
        .collect()
}

// --- the committed scene's boxes (`syncSourceTransformsToLayout`) ---

/// What a commit's answer was checked against (`isCurrent`): the scene, its
/// sources and the layout's intent when the edit was sent.
#[derive(Debug, Clone, PartialEq)]
struct EditIdentity {
    scene_id: Option<String>,
    sources: Vec<(String, String, Option<String>, bool, bool)>,
    layout_intent: Value,
    capture: Value,
    intent: u64,
}

fn source_identity(scene: Option<&Scene>) -> Vec<(String, String, Option<String>, bool, bool)> {
    scene
        .map(|scene| {
            scene
                .sources
                .iter()
                .map(|source| {
                    (
                        source.id.clone(),
                        format!("{:?}", source.kind),
                        source.device_id.clone(),
                        source.locked,
                        source.visible,
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `sceneVisibilityIdentity`: the scene as JSON with the edited source's
/// `visible` left out, so the request's own echo doesn't retire it but any
/// other edit of the scene does.
pub fn scene_visibility_identity(scene: Option<&Scene>, source_id: &str) -> Value {
    let Some(mut value) = scene.and_then(|scene| serde_json::to_value(scene).ok()) else {
        return Value::Null;
    };
    if let Some(Value::Array(sources)) = value.get_mut("sources") {
        for source in sources {
            if source.get("id").and_then(Value::as_str) == Some(source_id)
                && let Value::Object(source) = source
            {
                source.remove("visible");
            }
        }
    }
    value
}

/// What a Show or Hide was checked against when its answer came
/// (`setSceneSourceVisible`'s guards): the request, the layout intent, the
/// scene without the source's `visible`, and the layout's transform intent.
#[derive(Debug, Clone, PartialEq)]
struct VisibilityIdentity {
    request: u64,
    intent: u64,
    scene: Value,
    layout_intent: Value,
}

impl VisibilityIdentity {
    /// Read with the capture config synced.
    fn of(inner: &Inner, source_id: &str) -> Self {
        Self {
            request: inner.scenes.switch.visibility_request,
            intent: inner.scenes.switch.intent(),
            scene: scene_visibility_identity(inner.sources.scene.as_ref(), source_id),
            layout_intent: transform_layout_intent(&inner.capture.config["layout"]),
        }
    }
}

/// `transformLayoutIntent`: the layout without the committed boxes' echo.
pub fn transform_layout_intent(layout: &Value) -> Value {
    let mut intent = layout.clone();
    if let Value::Object(map) = &mut intent {
        map.remove("sourceTransformOverrides");
        map.remove("cameraTransform");
        map.remove("cameraTransformMode");
    }
    intent
}

/// `sourceOverrideOf`: a source as Freeform saves it (the screen side's
/// crop with it, each side over 0, at most 95%).
pub fn source_override(source: &SceneSource) -> Value {
    let transform = &source.transform;
    let mut value = json!({
        "x": transform.x,
        "y": transform.y,
        "width": transform.width,
        "height": transform.height,
    });
    if matches!(
        source.kind,
        SceneSourceKind::Screen | SceneSourceKind::Window
    ) {
        for (key, amount) in [
            ("cropLeft", transform.crop_left),
            ("cropTop", transform.crop_top),
            ("cropRight", transform.crop_right),
            ("cropBottom", transform.crop_bottom),
        ] {
            if amount.is_finite() && amount > 0.0 {
                value[key] = json!(amount.min(0.95));
            }
        }
    }
    value
}

/// `syncSourceTransformsToLayout`: the layout patch a committed scene
/// writes back. Freeform keeps every source's box; a preset keeps only the
/// camera's, as its custom box, when the camera is what changed.
pub fn layout_patch_for(
    layout: &Value,
    scene: &Scene,
    changed: Option<&str>,
) -> Option<Map<String, Value>> {
    let mut patch = Map::new();
    if string(layout.get("arrangementMode")) == Some("freeform") {
        let overrides: Map<String, Value> = scene
            .sources
            .iter()
            .map(|source| (source.id.clone(), source_override(source)))
            .collect();
        patch.insert("sourceTransformOverrides".into(), Value::Object(overrides));
        return Some(patch);
    }
    let camera = scene
        .sources
        .iter()
        .find(|source| source.kind == SceneSourceKind::Camera)?;
    if changed.is_some_and(|id| id != camera.id) {
        return None;
    }
    patch.insert("cameraTransformMode".into(), json!("custom"));
    patch.insert(
        "cameraTransform".into(),
        json!({
            "x": camera.transform.x,
            "y": camera.transform.y,
            "width": camera.transform.width,
            "height": camera.transform.height,
        }),
    );
    Some(patch)
}

/// The stage's reading of a committed scene.
pub fn commit_outcome(applied: bool, scene: &Scene) -> CommitOutcome {
    CommitOutcome {
        applied,
        scene_id: scene.id.clone(),
        sources: scene
            .sources
            .iter()
            .map(|source| (source.id.clone(), StageRect::of(&source.transform)))
            .collect(),
    }
}

/// `sourceVisibilityFromScene`: the layout's `sourceVisibility` as the
/// committed scene shows it.
pub fn source_visibility_from_scene(scene: &Scene, current: Option<&Value>) -> Value {
    let mut visibility = json!({ "camera": true, "capture": true });
    if let Some(Value::Object(current)) = current {
        for key in ["camera", "capture"] {
            if let Some(Value::Bool(on)) = current.get(key) {
                visibility[key] = json!(on);
            }
        }
    }
    for source in &scene.sources {
        match source.kind {
            SceneSourceKind::Camera => visibility["camera"] = json!(source.visible),
            SceneSourceKind::Screen | SceneSourceKind::Window | SceneSourceKind::TestPattern => {
                visibility["capture"] = json!(source.visible);
            }
        }
    }
    visibility
}

impl Inner {
    /// An editor commit (a drag, a nudge, a visibility, a reset) landed in
    /// the scene: its layout patch goes into the capture config at once
    /// (#1697), and the working setup and the scene on stream (D11) take it
    /// (`persistWorkingVisual`). True when the store took the capture config.
    pub(super) fn commit_editor_layout(
        &mut self,
        patch: Map<String, Value>,
        now: &str,
        logger: &Logger,
    ) -> bool {
        self.capture.sync(self.settings.get(keys::CAPTURE_CONFIG));
        let mut next = self.capture.config.clone();
        if let Value::Object(layout) = &mut next["layout"] {
            layout.extend(patch);
        }
        let stored = capture_config::stored_capture_config(&next);
        let write = SettingWrite::Put {
            key: keys::CAPTURE_CONFIG.to_string(),
            value: stored.clone(),
        };
        let kept = match self.stage_writes(&[write], logger) {
            Ok(()) => {
                self.capture.set(next.clone(), Some(stored));
                true
            }
            Err(error) => {
                logger.warn(format!(
                    "[scenes] the edited scene was not saved: {}",
                    error.message
                ));
                self.capture.replace_config(next.clone());
                false
            }
        };
        let background = self.scenes.switch.working_background.clone();
        let saved_id = self.scenes.on_stream.clone();
        self.persist_working_visual(
            &next["layout"],
            &next["sources"],
            background.as_ref(),
            saved_id.as_deref(),
            now,
            logger,
            "editor commit",
        );
        kept
    }
}

/// ⌘Z's entry while its undo runs, put back if the undo's future is dropped
/// before it ends (Electron's `undoLayout` always reaches its restore on a
/// refusal). Back only into an empty slot, as `restoreLayoutUndo` does, so
/// a commit that landed meanwhile keeps its own entry. Disarmed once the
/// undo answered. Dropped with the Studio's lock free.
struct UndoInFlight<'a, B: StudioBackend> {
    studio: &'a Studio<B>,
    entry: Option<LayoutUndoEntry>,
}

impl<B: StudioBackend> UndoInFlight<'_, B> {
    fn answered(mut self) {
        self.entry = None;
    }
}

impl<B: StudioBackend> Drop for UndoInFlight<'_, B> {
    fn drop(&mut self) {
        if let Some(entry) = self.entry.take() {
            self.studio.restore_layout_undo(entry);
        }
    }
}

impl<B: StudioBackend> Studio<B> {
    fn edit_identity(&self) -> EditIdentity {
        let inner = self.lock();
        let config = &inner.capture.config;
        EditIdentity {
            scene_id: inner.sources.scene.as_ref().map(|scene| scene.id.clone()),
            sources: source_identity(inner.sources.scene.as_ref()),
            layout_intent: transform_layout_intent(&config["layout"]),
            capture: json!({ "sources": config["sources"], "video": config["video"] }),
            intent: inner.scenes.switch.intent(),
        }
    }

    /// Electron reports a failed Show or Hide only while it is still the
    /// latest request under the same layout intent.
    fn visibility_request_current(&self, before: &VisibilityIdentity) -> bool {
        let inner = self.lock();
        inner.scenes.switch.visibility_request == before.request
            && inner.scenes.switch.intent() == before.intent
    }

    fn report_scene_error(&self, failure: Failure<'_>) {
        if let Some(command) = toast_user_error(failure, CHANGE_THE_SCENE, SCENE_EDIT_TOAST_ID) {
            self.post(vec![command]);
        }
    }

    fn report_rpc(&self, error: &RpcError, context: UserErrorContext) {
        let connected = matches!(self.lock().connection, Connection::Connected { .. });
        if let Some(command) = backend_error_toast(error, connected, context) {
            self.post(vec![command]);
        }
    }

    /// `reportBannerError`: a refusal is a warning with its sentence, else
    /// the usual failure.
    fn report_banner_error(&self, error: &RpcError, context: UserErrorContext) {
        match banner_refusal(&error.message) {
            Some(sentence) => {
                if let Some(command) = toast_user_error(
                    Failure::Sentence {
                        text: sentence,
                        warning: true,
                    },
                    context,
                    BANNER_REFUSAL_TOAST_ID,
                ) {
                    self.post(vec![command]);
                }
            }
            None => self.report_rpc(error, context),
        }
    }

    /// The committed scene lands (`applyCommittedScene`), and its boxes go
    /// back into the layout and the scene on stream.
    async fn land_committed_scene(&self, scene: Scene, changed: Option<&str>) {
        let kept = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            let patch = layout_patch_for(&inner.capture.config["layout"], &scene, changed);
            inner.sources.set_scene(scene);
            patch.map(|patch| {
                let now = (self.config.clock)();
                inner.commit_editor_layout(patch, &now, &self.config.logger)
            })
        };
        self.publish();
        if kept.is_some() {
            let _ = self.flush_settings().await;
        }
    }

    /// `setSceneSourceTransform`: one released gesture's commit. Answers the
    /// stage's reading of the committed scene, or `None` when it didn't
    /// land (refused, lost, or answered for a scene that is no longer the
    /// one edited); a refusal or a lost request is reported once.
    pub async fn commit_source_transform(
        &self,
        source_id: &str,
        patch: Value,
    ) -> Option<CommitOutcome> {
        let before = self.edit_identity();
        let editable =
            {
                let inner = self.lock();
                matches!(inner.connection, Connection::Connected { .. })
                    && inner.sources.scene.as_ref().is_some_and(|scene| {
                        scene.sources.iter().any(|source| source.id == source_id)
                    })
            };
        if !editable {
            self.report_scene_error(Failure::Sentence {
                text: EDITING_UNAVAILABLE,
                warning: false,
            });
            return None;
        }
        let answer = self
            .backend
            .scene_request(
                TRANSFORM_UPDATE_METHOD,
                json!({ "sourceId": source_id, "transform": patch, "snap": "none" }),
            )
            .await;
        let status = match answer {
            Ok(status) => status,
            Err(error) => {
                self.report_scene_error(Failure::Rpc(&error));
                return None;
            }
        };
        let applied = status.get("applied").and_then(Value::as_bool) == Some(true);
        let Ok(scene) = serde_json::from_value::<Scene>(status["scene"].clone()) else {
            self.report_scene_error(Failure::Sentence {
                text: NOT_APPLIED,
                warning: false,
            });
            return None;
        };
        // `isCurrent`: nothing replaced the scene or the layout meanwhile.
        let after = self.edit_identity();
        if after != before || before.scene_id.as_deref() != Some(scene.id.as_str()) {
            return None;
        }
        if !applied {
            let message = status
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or(NOT_APPLIED)
                .to_string();
            self.config
                .logger
                .warn(format!("[scenes] the scene edit wasn't applied: {message}"));
            // `status.message ?? "Scene transform wasn't applied."`: the
            // backend's reason is what the streamer reads.
            self.report_scene_error(Failure::Sentence {
                text: &message,
                warning: false,
            });
            return None;
        }
        if !scene.sources.iter().any(|source| source.id == source_id) {
            self.report_scene_error(Failure::Sentence {
                text: SOURCE_GONE,
                warning: false,
            });
            return None;
        }
        let outcome = commit_outcome(true, &scene);
        self.land_committed_scene(scene, Some(source_id)).await;
        Some(outcome)
    }

    /// `nudgeSceneSource`: an arrow's step, the backend's own size.
    pub async fn nudge_source(
        &self,
        source_id: &str,
        direction_x: i8,
        direction_y: i8,
        large: bool,
    ) -> bool {
        let answer = self
            .backend
            .scene_request(
                NUDGE_METHOD,
                json!({
                    "sourceId": source_id,
                    "directionX": direction_x,
                    "directionY": direction_y,
                    "large": large,
                }),
            )
            .await;
        match answer.map(|status| serde_json::from_value::<Scene>(status["scene"].clone())) {
            Ok(Ok(scene)) => {
                self.land_committed_scene(scene, Some(source_id)).await;
                true
            }
            Ok(Err(_)) => false,
            Err(error) => {
                self.report_scene_error(Failure::Rpc(&error));
                false
            }
        }
    }

    /// `scene.editor.draft.set`: `Err(true)` when the backend refuses drafts
    /// (a session runs), `Err(false)` for any other failure.
    pub async fn set_editor_draft(&self, params: Value) -> Result<(), bool> {
        match self.backend.scene_request(DRAFT_SET_METHOD, params).await {
            Ok(_) => Ok(()),
            Err(error) => Err(error.code == DRAFT_REFUSED_CODE),
        }
    }

    /// `scene.editor.draft.clear`.
    pub async fn clear_editor_draft(&self) -> Result<(), RpcError> {
        self.backend
            .scene_request(DRAFT_CLEAR_METHOD, Value::Null)
            .await
            .map(|_| ())
    }

    /// The overlay layout (`overlays.layout.get`).
    pub async fn overlay_layout(&self) -> Result<Value, RpcError> {
        self.backend
            .scene_request(OVERLAY_LAYOUT_GET_METHOD, Value::Null)
            .await
    }

    /// `overlays.layout.set` (an overlay item's released gesture): answers
    /// the saved layout; a failure is reported.
    pub async fn set_overlay_layout(&self, layout: Value) -> Option<Value> {
        match self
            .backend
            .scene_request(OVERLAY_LAYOUT_SET_METHOD, layout)
            .await
        {
            Ok(saved) => Some(saved),
            Err(error) => {
                if let Some(command) =
                    toast_user_error(Failure::Rpc(&error), MOVE_THE_OVERLAY, "overlay-layout")
                {
                    self.post(vec![command]);
                }
                None
            }
        }
    }

    /// The banners (`banners.list`).
    pub async fn banners(&self) -> Result<Value, RpcError> {
        self.backend
            .scene_request(BANNERS_LIST_METHOD, Value::Null)
            .await
    }

    /// `banners.update` with one orientation's rect (a banner's released
    /// gesture): answers the updated banner; a failure is reported.
    pub async fn update_banner(
        &self,
        id: &str,
        orientation: &str,
        rect: StageRect,
    ) -> Option<Value> {
        let mut params = json!({ "id": id });
        params[orientation] =
            json!({ "x": rect.x, "y": rect.y, "w": rect.width, "h": rect.height });
        match self
            .backend
            .scene_request(BANNERS_UPDATE_METHOD, params)
            .await
        {
            Ok(banner) => Some(banner),
            Err(error) => {
                self.report_banner_error(&error, MOVE_THE_BANNER);
                None
            }
        }
    }

    /// `undoLayoutPatch`: the remembered layout goes back through the same
    /// transaction, with the scene it belonged to and the canvas coupling a
    /// preset switch carries. Plan 231: when the undone commit put another
    /// scene on stream, undo switches back to that scene, its screen
    /// included. False, with the entry kept, when there is nothing to undo
    /// or the commit was refused.
    pub async fn undo_layout(self: &Arc<Self>) -> bool {
        let (entry, current, session_active, on_stream) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let Some(entry) = inner.scenes.switch.undo.take() else {
                return false;
            };
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            (
                entry,
                inner.capture.config.clone(),
                inner.session.is_active(),
                inner.scenes.on_stream.clone(),
            )
        };
        self.publish();
        if let Some(id) = entry
            .saved_id
            .clone()
            .filter(|id| Some(id) != on_stream.as_ref())
        {
            let in_flight = UndoInFlight {
                studio: &**self,
                entry: Some(entry.clone()),
            };
            let switched = self
                .apply_saved_scene(&id, None, ApplyOptions::default())
                .await
                .ok;
            in_flight.answered();
            if !switched {
                self.restore_layout_undo(entry);
            }
            return switched;
        }
        let from = string(current["layout"].get("layoutPreset")).unwrap_or_default();
        let to = string(entry.layout.get("layoutPreset")).unwrap_or_default();
        let crosses = capture_config::layout_preset_is_vertical(from)
            != capture_config::layout_preset_is_vertical(to);
        if session_active && crosses {
            // The canvas is fixed mid-session: the entry stays for after it.
            self.restore_layout_undo(entry);
            self.post(vec![NoticeCommand::Show(
                crate::notices::ToastRequest::error(
                    "Stop the recording or stream before switching orientation",
                )
                .id("scene-orientation-lock")
                .finish(),
            )]);
            return false;
        }
        // Undoing an entry into Freeform leaves it: remember the arrangement,
        // as a preset click would (C-4).
        if string(current["layout"].get("arrangementMode")) == Some("freeform")
            && string(entry.layout.get("arrangementMode")) != Some("freeform")
        {
            self.note_layout_leaving_freeform(&current["layout"]);
        }
        let coupling = (!session_active)
            .then(|| {
                vertical_orientation_video_patch(
                    from,
                    to,
                    &current["video"],
                    &current["verticalRestoreVideo"],
                )
            })
            .flatten();
        let in_flight = UndoInFlight {
            studio: &**self,
            entry: Some(entry.clone()),
        };
        let committed = self
            .request_layout_transaction(
                entry.layout.clone(),
                TransactionOptions {
                    saved_scene_id: Some(entry.saved_id.clone()),
                    origin: Some(entry.origin),
                    video_override: coupling.as_ref().map(|(video, _)| video.clone()),
                    capture_patch: coupling,
                    ..TransactionOptions::default()
                },
            )
            .await;
        in_flight.answered();
        if !committed {
            self.restore_layout_undo(entry);
        }
        committed
    }

    /// `peekLayoutUndo`: whether ⌘Z has a layout to return to.
    pub fn layout_undo_available(&self) -> bool {
        self.lock().scenes.switch.undo.is_some()
    }

    /// `restoreLayoutUndo`: back in the slot unless a newer change took it.
    fn restore_layout_undo(&self, entry: LayoutUndoEntry) {
        {
            let mut inner = self.lock();
            if inner.scenes.switch.undo.is_none() {
                inner.scenes.switch.undo = Some(entry);
            }
        }
        self.publish();
    }

    /// `noteLayoutLeavingFreeform`: a preset (or an undo) is about to
    /// replace `layout`; a Freeform arrangement is remembered for the next
    /// Freeform in its orientation (plan 174 C-4).
    pub(super) fn note_layout_leaving_freeform(&self, layout: &Value) {
        remember_freeform(&mut self.lock().scenes.switch.freeform_memory, layout);
    }

    /// `rememberedFreeform()`: what Freeform starts from.
    pub fn remembered_freeform(&self) -> FreeformMemory {
        self.lock().scenes.switch.freeform_memory.clone()
    }

    /// A corner drop re-enters the preset at that corner
    /// (`applyCameraPreset({ cameraCorner })`).
    pub async fn snap_camera_corner(self: &Arc<Self>, corner: &str) -> bool {
        let mut patch = Map::new();
        patch.insert("cameraCorner".into(), json!(corner));
        self.request_camera_preset_transaction(patch, PresetOptions::default())
            .await
    }

    /// Posts toasts (the app's own stage failures).
    pub fn post_notice(&self, commands: Vec<NoticeCommand>) {
        self.post(commands);
    }

    fn current_layout(&self) -> Value {
        let mut guard = self.lock();
        let inner = &mut *guard;
        inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
        inner.capture.config["layout"].clone()
    }

    /// `applyLayoutPatch`: the layout on with the patch, as one transaction.
    pub async fn apply_layout_patch(self: &Arc<Self>, patch: Map<String, Value>) -> bool {
        let mut layout = self.current_layout();
        if let Value::Object(map) = &mut layout {
            map.extend(patch);
        }
        self.request_layout_transaction(layout, TransactionOptions::default())
            .await
    }

    /// `applyCameraLook`: the chosen camera's look into `settings.cameraLooks`
    /// (gone when neutral), then a quiet look-only transaction, so a drag
    /// never reopens the camera.
    pub async fn apply_camera_look(self: &Arc<Self>, look: Value) -> bool {
        let camera_id = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            string(inner.capture.config["sources"].get("cameraId"))
                .filter(|id| !id.is_empty())
                .map(str::to_string)
        };
        let Some(camera_id) = camera_id else {
            return false;
        };
        let normalized = normalize_camera_look(&look);
        let written = self
            .update_studio_settings(|settings| {
                let mut looks = settings
                    .get("cameraLooks")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                match normalized {
                    Some(look) => {
                        looks.insert(camera_id, look);
                    }
                    None => {
                        looks.remove(&camera_id);
                    }
                }
                settings.set("cameraLooks", Value::Object(looks));
            })
            .await;
        if let Err(error) = written {
            self.config.logger.warn(format!(
                "[scenes] the camera look was not saved: {}",
                error.message
            ));
        }
        let layout = self.current_layout();
        self.request_layout_transaction(
            layout,
            TransactionOptions {
                quiet: true,
                camera_look_only: true,
                ..TransactionOptions::default()
            },
        )
        .await
    }

    /// `setSceneSourceVisible`: the backend shows or hides the source; the
    /// layout's `sourceVisibility` and the working setup keep it. An answer
    /// that lands after a newer Show or Hide, a layout intent, another edit
    /// of the scene or a newer committed scene is dropped quietly; one that
    /// doesn't show the request is reported, unless it was overtaken.
    pub async fn set_source_visible(&self, source_id: &str, visible: bool) -> bool {
        let before = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let known = inner
                .sources
                .scene
                .as_ref()
                .is_some_and(|scene| scene.sources.iter().any(|source| source.id == source_id));
            if !known {
                return false;
            }
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            inner.scenes.switch.visibility_request += 1;
            VisibilityIdentity::of(inner, source_id)
        };
        let answer = self
            .backend
            .scene_request(
                VISIBILITY_UPDATE_METHOD,
                json!({ "sourceId": source_id, "visible": visible }),
            )
            .await;
        let status = match answer {
            Ok(status) => status,
            Err(error) => {
                if self.visibility_request_current(&before) {
                    self.report_scene_error(Failure::Rpc(&error));
                }
                return false;
            }
        };
        let revision = status
            .get("sceneRevision")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            let now = VisibilityIdentity::of(inner, source_id);
            if now != before || inner.scenes.switch.committed_revision() > revision {
                return false;
            }
        }
        let applied = status.get("applied").and_then(Value::as_bool) == Some(true);
        let scene = serde_json::from_value::<Scene>(status["scene"].clone()).ok();
        let Some(scene) = scene.filter(|scene| {
            applied
                && scene_visibility_identity(Some(scene), source_id) == before.scene
                && scene
                    .sources
                    .iter()
                    .find(|source| source.id == source_id)
                    .is_some_and(|source| source.visible == visible)
        }) else {
            self.report_scene_error(Failure::Sentence {
                text: VISIBILITY_NOT_ACKNOWLEDGED,
                warning: false,
            });
            return false;
        };
        let kept = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            let visibility = source_visibility_from_scene(
                &scene,
                inner.capture.config["layout"].get("sourceVisibility"),
            );
            inner.sources.set_scene(scene);
            let mut patch = Map::new();
            patch.insert("sourceVisibility".into(), visibility);
            let now = (self.config.clock)();
            inner.commit_editor_layout(patch, &now, &self.config.logger)
        };
        self.publish();
        if kept {
            let _ = self.flush_settings().await;
        }
        true
    }

    /// `resetSceneSource`: the source back to its layout's box. Freeform
    /// keeps the reset value as the source's override; a preset's camera
    /// goes back to the preset.
    pub async fn reset_source(&self, source_id: &str) -> bool {
        let answer = self
            .backend
            .scene_request(TRANSFORM_RESET_METHOD, json!({ "sourceId": source_id }))
            .await;
        let scene =
            match answer.map(|status| serde_json::from_value::<Scene>(status["scene"].clone())) {
                Ok(Ok(scene)) => scene,
                Ok(Err(_)) => return false,
                Err(error) => {
                    self.report_scene_error(Failure::Rpc(&error));
                    return false;
                }
            };
        let kept = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            let freeform =
                string(inner.capture.config["layout"].get("arrangementMode")) == Some("freeform");
            let camera = scene
                .sources
                .iter()
                .find(|source| source.id == source_id)
                .is_some_and(|source| source.kind == SceneSourceKind::Camera);
            let patch = if freeform {
                layout_patch_for(&inner.capture.config["layout"], &scene, None)
            } else if camera {
                let mut patch = Map::new();
                patch.insert("cameraTransformMode".into(), json!("preset"));
                patch.insert("cameraTransform".into(), Value::Null);
                Some(patch)
            } else {
                None
            };
            inner.sources.set_scene(scene);
            patch.map(|patch| {
                let now = (self.config.clock)();
                inner.commit_editor_layout(patch, &now, &self.config.logger)
            })
        };
        self.publish();
        if kept == Some(true) {
            let _ = self.flush_settings().await;
        }
        true
    }

    /// The smokes' `studio-scene-background` (`applyBackgroundSlot`): the
    /// working look with `background` (a saved background, or `None` for
    /// none) as one quiet transaction. False when it does not resolve.
    pub async fn set_working_background(self: &Arc<Self>, background: Option<&Value>) -> bool {
        self.apply_working_background(background).await.is_ok()
    }

    /// [`Self::set_working_background`] with the reason a refused change
    /// gives, for the Images page to say why next to the tiles (#2491):
    /// "This scene needs a screen or window…" when the layout draws a
    /// screen and none is picked.
    pub async fn apply_working_background(
        self: &Arc<Self>,
        background: Option<&Value>,
    ) -> Result<(), SwitchRefusal> {
        let layout = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            inner.capture.config["layout"].clone()
        };
        let resolved = match background {
            Some(style) => match resolve_saved_background(Some(style)) {
                Some(resolved) => Some(resolved),
                None => {
                    self.config
                        .logger
                        .warn("[background] refused invalid saved background");
                    self.post(vec![NoticeCommand::Show(
                        ToastRequest::warning(BACKGROUND_NOT_APPLIED)
                            .id("background-invalid")
                            .description(BACKGROUND_UNAVAILABLE)
                            .finish(),
                    )]);
                    return Err(SwitchRefusal {
                        code: BACKGROUND_INVALID_CODE.to_string(),
                        reason: BACKGROUND_UNAVAILABLE.to_string(),
                    });
                }
            },
            None => None,
        };
        self.config.logger.info(format!(
            "[background] applying {}",
            resolved
                .as_ref()
                .and_then(|value| value["assetId"].as_str())
                .unwrap_or("none"),
        ));
        let result = self
            .request_layout_transaction_explained(
                layout,
                TransactionOptions {
                    quiet: true,
                    background_override: Some(resolved),
                    ..TransactionOptions::default()
                },
            )
            .await;
        match &result {
            Ok(()) => self.config.logger.info("[background] applied"),
            Err(refusal) => self.config.logger.warn(format!(
                "[background] not applied: {}",
                refusal
                    .as_ref()
                    .map_or("no refusal reported", |refusal| refusal.code.as_str()),
            )),
        }
        result.map_err(|refusal| {
            refusal.unwrap_or_else(|| SwitchRefusal {
                code: BACKGROUND_NOT_APPLIED_CODE.to_string(),
                reason: BACKGROUND_TRY_AGAIN.to_string(),
            })
        })
    }

    /// `applyWorkingBackgroundStyle({ visibilityPercent })` (Screen size):
    /// the scene's background with its Visibility, as one quiet transaction.
    pub async fn set_background_visibility(self: &Arc<Self>, visibility_percent: f64) -> bool {
        let (current, layout) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            (
                inner.scenes.switch.working_background.clone(),
                inner.capture.config["layout"].clone(),
            )
        };
        let Some(mut style) = snapshot_background(current.as_ref()) else {
            return false;
        };
        style["visibilityPercent"] = json!(visibility_percent);
        let background = resolve_saved_background(Some(&style));
        if background.is_none() {
            return false;
        }
        self.request_layout_transaction(
            layout,
            TransactionOptions {
                quiet: true,
                background_override: Some(background),
                ..TransactionOptions::default()
            },
        )
        .await
    }

    async fn banner_call(
        &self,
        method: &'static str,
        params: Value,
        context: UserErrorContext,
    ) -> bool {
        match self.backend.scene_request(method, params).await {
            Ok(_) => true,
            Err(error) => {
                self.report_banner_error(&error, context);
                false
            }
        }
    }

    /// `showBanner`: refused with the backend's sentence (four showing, a
    /// recording that can't add one).
    pub async fn show_banner(&self, id: &str) -> bool {
        self.banner_call(BANNERS_SHOW_METHOD, json!({ "id": id }), SHOW_THE_BANNER)
            .await
    }

    /// `hideBanner`.
    pub async fn hide_banner(&self, id: &str) -> bool {
        self.banner_call(BANNERS_HIDE_METHOD, json!({ "id": id }), HIDE_THE_BANNER)
            .await
    }

    /// `reorderBanners`: the drawing order (later is on top). Electron says
    /// it as moving the banner.
    pub async fn reorder_banners(&self, ids: Vec<String>) -> bool {
        self.banner_call(
            BANNERS_REORDER_METHOD,
            json!({ "ids": ids }),
            MOVE_THE_BANNER,
        )
        .await
    }

    /// `updateBanner` with the inspector's own fields (opacity, the two
    /// switches, the timer, a snapped rect, the name).
    pub async fn patch_banner(&self, id: &str, patch: Map<String, Value>) -> bool {
        let context = banner_update_context(&patch);
        let mut params = Value::Object(patch);
        params["id"] = json!(id);
        self.banner_call(BANNERS_UPDATE_METHOD, params, context)
            .await
    }

    /// `updatePrivacySettings`: the password-manager hide and its list.
    pub async fn set_privacy_settings(&self, settings: &PrivacySettings) -> Result<(), RpcError> {
        self.write_settings(vec![save_privacy_settings(settings)])
            .await
    }

    /// "Animate scene changes" (`settings.animateSceneChanges`).
    pub async fn set_animate_scene_changes(&self, on: bool) -> Result<(), RpcError> {
        self.update_studio_settings(|settings| settings.set("animateSceneChanges", json!(on)))
            .await
    }
}

#[cfg(test)]
#[path = "scene_editor_tests.rs"]
mod tests;
