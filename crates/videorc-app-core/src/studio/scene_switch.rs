//! Plan 260 S1.6b part 3b: the Studio's scene switch on plan 231's library
//! (`use-studio.tsx`: `requestLayoutTransaction` ~11238,
//! `applyLayoutTransactionState` ~10963, `requestCameraPresetTransaction`
//! ~12110, `holdSceneGoingOn` / `sceneIsGoingOn` / `deleteSavedScene`
//! ~12341, `applySavedSceneResult` ~12418, `switchToSceneWithLayout` /
//! `applySavedScene` / `applyCameraPreset` ~12751, `persistWorkingVisual`
//! ~5440, `loadScene` ~10148), from `videorc-rust`'s plan 220 port, moved
//! onto plan 231.
//!
//! - **The transaction.** A switch mints a layout intent, checks a saved
//!   scene's sources and background first (plan 210 S3), and commits
//!   through `scene.layout.apply_preview` (idle) or `.apply_live` (a
//!   session). It carries D18/D4's screen flags: `verticalLegScreen` when
//!   the running vertical leg of the scene draws the selected screen, else
//!   `retainScreen` when a program with no screen keeps the capture of the
//!   same target running. The backend's commit is the truth the Studio
//!   reconciles to at once ([`Studio::request_layout_transaction`]); the
//!   proof follows on its own and only a missed proof says anything.
//! - **The state.** A commit sets the scene, the working background, the
//!   scene on stream (a scene is always on stream, D2; one the library lost
//!   is replaced and put on again, D16), the capture config (canvas,
//!   sources, each orientation's last layout, the layout, and the framing
//!   an edit made) and the working setup, whose write runs D11's autosave:
//!   an edit made while a scene is on stream saves into it.
//! - **A saved scene.** [`Studio::apply_saved_scene`] puts a stored scene on
//!   stream in the studio's orientation with the shared camera (D9); a scene
//!   no leg draws a screen for keeps the running capture (D18) and needs no
//!   app window of its own.
//! - **A layout.** [`Studio::request_camera_preset_transaction`] changes the
//!   layout of the scene on stream; a screen layout on a scene that shows no
//!   screen is refused (D19); a scene whose capture is borrowed goes on
//!   again with its own screen (D18).
//! - **Delete** ([`Studio::delete_scene`]) and **the Screen pick**
//!   ([`Studio::set_scene_on_stream_shows`]).
//!
//! Not here yet: rooms, the Clips ring and the start races (part 3c), the
//! switch's progress phases (part 3c), the vertical leg's own sends (part
//! 4), the camera's background on the layout (part 4), the backend-truth
//! read after a failed switch, and the bell's routing of these toasts.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use super::capture_config::{self, simulcast_armed};
use super::js_value::{get, string, truthy};
use super::settings::{SettingWrite, StudioSettings, encode, keys};
use super::source_selection::{SourceKind, merge_source_kind};
use super::{Connection, Inner, Studio, StudioBackend};
use crate::client::RpcError;
use crate::log::Logger;
use crate::notices::{NoticeCommand, NotifyOnce, ToastRequest};
use crate::scenes::background::{resolve_saved_background, snapshot_background};
use crate::scenes::framing::{
    layout_preset_memory_patch, orientation_default_preset, recalled_layout_framing,
    remember_layout_framing, vertical_orientation_video_patch,
};
use crate::scenes::model::{
    Origin, WorkingScene, normalize_scene_visual, scene_microphone, scene_source_problems,
    using_visual_sources, visual_sources, with_scene_display, without_scene_app,
};
use crate::scenes::preflight::{
    Judgement, judge_scene_sources, preflight_visual, run_saved_scene_preflight,
};
use crate::scenes::store::{DeleteRule, EditAutosave, can_delete_scene, scene_edit_autosave};
use crate::scenes::v2::{
    GOING_ON_STREAM_REASON, Orientation, Scene, SceneShows, first_scene_with_layout,
    layout_is_freeform, layout_preset, layout_preset_label, layout_shows_screen,
    shows_from_sources,
};
use crate::scenes::view::{
    CAMERA_KEYS, apply_capture_sources, no_screen_layout_reason, same_capture_target,
    saved_scene_view, scene_capture_is_borrowed, scene_display_refreshed, scene_draws_screen,
    scene_keeps_capture, scene_with_shows,
};
use crate::scenes::window::{
    AppWindowResolution, SceneAppState, SceneWindowResolution, held_app_window,
    remember_scene_window_app, resolve_scene_window, resolved_for_apply,
    saved_scene_apply_retry_allowed, scene_window_refusal,
};
use crate::user_error::{Failure, OFFLINE_TOAST_ID, backend_error_toast, toast_user_error};

/// `scene.layout.apply_preview` and `scene.layout.apply_live`.
pub const APPLY_PREVIEW_METHOD: &str = "scene.layout.apply_preview";
pub const APPLY_LIVE_METHOD: &str = "scene.layout.apply_live";
/// `sources.resolve_app_window`.
pub const RESOLVE_APP_WINDOW_METHOD: &str = "sources.resolve_app_window";
/// `compositor.status` and `diagnostics.stats`, for the live proof.
pub const COMPOSITOR_STATUS_METHOD: &str = "compositor.status";
pub const DIAGNOSTICS_STATS_METHOD: &str = "diagnostics.stats";

/// `SCENE_TRANSITION_MS`: "Animate scene changes" glides a commit in.
pub const SCENE_TRANSITION_MS: u64 = 320;
/// `LIVE_LAYOUT_PROOF_WAIT_TIMEOUT_MS` and its interval.
pub const LIVE_PROOF_WAIT: Duration = Duration::from_millis(5000);
const LIVE_PROOF_EVERY: Duration = Duration::from_millis(100);
/// `NATIVE_PREVIEW_SCENE_PROOF_WAIT_TIMEOUT_MS` and its interval.
pub const PREVIEW_PROOF_WAIT: Duration = Duration::from_millis(3000);
const PREVIEW_PROOF_EVERY: Duration = Duration::from_millis(33);

/// `SCENE_RELOAD_SUPERSEDED_CODE` (#1639): the backend refused an idle
/// scene reload because a session took the slot first. Nothing failed.
pub const SCENE_RELOAD_SUPERSEDED_CODE: &str = "scene-reload-superseded";

/// The switch's words (`use-studio.tsx`), each where the renderer says it.
pub mod copy {
    use crate::user_error::UserErrorContext;

    /// `{action: 'switch', object: 'the scene'}`.
    pub const SWITCH_THE_SCENE: UserErrorContext = UserErrorContext {
        action: "switch",
        object: "the scene",
    };
    /// `{action: 'confirm', object: 'the scene change'}`.
    pub const CONFIRM_THE_SCENE_CHANGE: UserErrorContext = UserErrorContext {
        action: "confirm",
        object: "the scene change",
    };
    pub const ORIENTATION_LOCK: &str = "Stop the recording or stream before switching orientation";
    pub const ORIENTATION_LOCK_ID: &str = "scene-orientation-lock";
    pub const RECONNECTING: &str = "Videorc is reconnecting";
    pub const SCENE_DID_NOT_CHANGE: &str = "The scene didn't change. Try again in a moment.";
    pub const SOURCE_UNAVAILABLE_ID: &str = "layout-source-unavailable";
    pub const NO_SCREEN_ID: &str = "scene-layout-no-screen";
    pub const DELETE_REFUSED_ID: &str = "scene-delete-refused";
    pub const PROOF_LAG_KEY: &str = "layout-preview-proof-lag";
    pub const PROOF_LAG_TITLE: &str = "The preview may be behind";
    pub const PROOF_LAG_BODY: &str =
        "Your stream and recording have the new scene. Reopen the preview if it looks stale.";
    pub const CHECK_THE_PREVIEW: &str =
        "Check the preview, and choose the scene again if it's wrong.";
    pub const REMEMBER_FAILED: &str = "Couldn't remember this scene for next time";
    pub const REMEMBER_FAILED_BODY: &str = "Your stream and recording aren't affected.";
    pub const REMEMBER_FAILED_ID: &str = "working-scene-storage";
    pub const APP_UNAVAILABLE_ID: &str = "scene-app-unavailable";
    pub const MICROPHONE_MISSING_FALLBACK: &str = "The scene's microphone";
    pub const MICROPHONE_MISSING_BODY: &str =
        "The scene kept your current microphone. Connect it, then choose the scene again.";
    pub const MICROPHONE_MISSING_ID: &str = "saved-scene-microphone";
}

/// What the preview element can prove right now: whether it shows the
/// scene (the docked slot in view, or the Preview window shown) and the
/// scene revision of the last frame it presented.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Presentation {
    pub can_present: bool,
    pub presented_revision: Option<u64>,
}

/// The preview element's presentation, read when a switch is proved.
pub type PresentationProbe = Arc<dyn Fn() -> Presentation + Send + Sync>;

/// The layout a switch is applying (`LayoutSwitchTarget`): its preset, and
/// whether it lands in Freeform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutTarget {
    pub preset: String,
    pub freeform: bool,
}

impl LayoutTarget {
    /// `layoutSwitchTarget`.
    pub fn of(layout: &Value) -> Self {
        Self {
            preset: layout_preset(layout).to_string(),
            freeform: layout_is_freeform(layout),
        }
    }

    /// `pendingLayoutEvidence`: the preset, or `freeform`.
    pub fn evidence(&self) -> &str {
        if self.freeform {
            "freeform"
        } else {
            &self.preset
        }
    }
}

/// How a transaction is asked for (`requestLayoutTransaction`'s options).
/// An `Option<Option<_>>` is a key given (`Some`) or absent (`None`), as
/// the renderer's `'key' in options` reads it.
#[derive(Debug, Clone, Default)]
pub struct TransactionOptions {
    /// `pendingIndicator: false`: a background-only commit lights no
    /// "Switching…".
    pub quiet: bool,
    pub camera_look_only: bool,
    /// The canvas the commit carries (an orientation switch's).
    pub video_override: Option<Value>,
    /// `captureConfigPatch`: the video and `verticalRestoreVideo` it lands.
    pub capture_patch: Option<(Value, Value)>,
    /// `sceneApp` when given (`Some(None)` clears it).
    pub scene_app: Option<Option<Value>>,
    pub sources_override: Option<Value>,
    /// `backgroundOverride` when given (`Some(None)` takes it off).
    pub background_override: Option<Option<Value>>,
    pub strict_sources: bool,
    /// `savedSceneId` when given (`Some(None)`: the commit names none, and
    /// the scene on stream stays, D2).
    pub saved_scene_id: Option<Option<String>>,
    pub origin: Option<Origin>,
    pub scene_switch: bool,
}

/// `SavedSceneApplyOptions` (plan 210 S10, plan 231).
#[derive(Debug, Clone, Default)]
pub struct ApplyOptions {
    /// The scene goes on with this screen (a remote's `sceneId` and
    /// `screenId` together), which it keeps once the switch lands (D2).
    pub shows: Option<SceneShows>,
    /// The scene goes on with this layout (D11, D18), which it keeps once
    /// the switch lands. Its orientation is the layout's own.
    pub layout: Option<Value>,
    /// `origin: 'follow'`: the follower's own apply. The follower's
    /// manual-apply listeners are not ported yet; nothing reads it here.
    pub origin_follow: bool,
    /// The window to prefer over the scene's own, as the follower's swap in
    /// place (`preferWindowId`).
    pub prefer_window: Option<String>,
}

/// `SavedSceneApplyResult`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ApplyResult {
    pub ok: bool,
    /// The refusal in words ("Figma isn't open", "No scene uses …").
    pub message: Option<String>,
    /// A newer switch took this one over before it landed (#1275).
    pub superseded: bool,
}

impl ApplyResult {
    fn failed() -> Self {
        Self::default()
    }

    fn superseded() -> Self {
        Self {
            superseded: true,
            ..Self::default()
        }
    }

    fn landed(ok: bool) -> Self {
        Self {
            ok,
            ..Self::default()
        }
    }
}

/// `requestCameraPresetTransaction`'s options.
#[derive(Debug, Clone, Default)]
pub struct PresetOptions {
    /// `backgroundOverride` when given (`Some(None)` takes it off).
    pub background_override: Option<Option<Value>>,
    /// The orientation toggle: the scene on stream goes on in its own layout
    /// for the other orientation (the preset only names the orientation).
    pub to_orientation: bool,
}

/// What `loadScene` reads before its request: the scene on stream and the
/// latest intent, so a reload a switch overtook saves nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReloadMark {
    scene_id: Option<String>,
    intent: u64,
}

/// What the backend committed and the Studio reconciles to
/// (`LayoutTransactionSnapshot`).
struct Committed {
    scene: Value,
    layout: Value,
    capture_patch: Option<(Value, Value)>,
    sources: Value,
    scene_app: Option<Value>,
    saved_id: Option<String>,
    origin: Origin,
    scene_switch: bool,
}

/// `persistedWorkingRef`: the scene and look last persisted, so a commit
/// that only repeats them is not taken for an edit, and what the capture
/// showed then (D2's pick is a change of it).
#[derive(Debug, Clone, Default)]
struct Persisted {
    scene_id: Option<String>,
    visual: Option<Value>,
    shows: Option<SceneShows>,
}

/// The switch's memory between events (the renderer's refs).
#[derive(Default)]
pub(super) struct SwitchCore {
    /// `layoutIntentIdRef`.
    intent_id: u64,
    /// `layoutIntentAwaitingProofRef`.
    awaiting_proof: Option<u64>,
    /// `visualTransactionPending`.
    pub(super) transaction_pending: bool,
    /// `layoutSwitchPending`.
    pub(super) pending_layout: Option<LayoutTarget>,
    /// `savedScenePendingId`.
    pub(super) pending_id: Option<String>,
    /// `workingAppRef`.
    working_app: Option<Value>,
    /// `workingBackgroundRef`.
    pub(super) working_background: Option<Value>,
    /// `workingOriginRef`.
    origin: Origin,
    persisted: Persisted,
    /// `scenesGoingOnRef` (D16).
    going_on: HashMap<String, usize>,
    /// `latestLayoutTransactionCommitRef.current.savedSceneId`.
    last_commit_scene: Option<Option<String>>,
    /// `savedSceneResolveGenerationRef`.
    resolve_generation: u64,
    /// `sceneWindowHintsRef` (plan 210 D5).
    window_hints: HashMap<String, String>,
    presentation: Option<PresentationProbe>,
    proof_notices: NotifyOnce,
}

impl SwitchCore {
    /// The working setup's app, background and origin at launch
    /// (`workingAppRef`, `workingBackground`, `workingOriginRef`).
    pub(super) fn launch(&mut self, working: Option<&WorkingScene>) {
        self.working_app = working
            .and_then(|working| get(working.visual.get("sources"), "app"))
            .filter(|app| app.is_object())
            .cloned();
        self.working_background =
            working.and_then(|working| resolve_saved_background(working.visual.get("background")));
        self.origin = working.map_or(Origin::Saved, |working| working.origin);
    }
}

/// D18/D4's screen flags on a commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ScreenFlags {
    /// `verticalLegScreen`: the running vertical leg of the scene draws the
    /// selected screen, so it is needed (started, or switched to, and kept).
    pub vertical_leg_screen: bool,
    /// `retainScreen`: a program with no screen keeps an existing capture of
    /// that same target.
    pub retain_screen: bool,
}

/// What [`transaction_screen_flags`] reads.
pub struct ScreenFlagsInput<'a> {
    /// The commit goes through `scene.layout.apply_live`.
    pub live_method: bool,
    pub session_active: bool,
    /// The layout the commit sends.
    pub layout: &'a Value,
    /// The sources the commit sends.
    pub sources: &'a Value,
    /// The capture config the commit was built from.
    pub config: &'a Value,
    /// The stored scene this commit puts or keeps on stream.
    pub leg_scene: Option<&'a Scene>,
    /// The preview's screen capture is live or starting.
    pub screen_capture_running: bool,
}

/// `requestLayoutTransaction`'s `verticalLegScreen` and `retainScreen`
/// (plan 231 D4, D18), exactly as the renderer computes them.
pub fn transaction_screen_flags(input: &ScreenFlagsInput) -> ScreenFlags {
    let program_draws_screen = layout_shows_screen(input.layout);
    let capture_off = input.sources.get("captureOff") == Some(&Value::Bool(true));
    let selects_screen = !capture_off
        && (truthy(input.sources.get("screenId")) || truthy(input.sources.get("windowId")));
    let mut leg_config = input.config.clone();
    if let Value::Object(map) = &mut leg_config {
        map.insert("layout".into(), input.layout.clone());
    }
    let vertical_leg_screen = input.live_method
        && input.session_active
        && !program_draws_screen
        && selects_screen
        && input.leg_scene.is_some_and(|scene| {
            simulcast_armed(&leg_config) && layout_shows_screen(&scene.vertical)
        });
    let retain_screen = !program_draws_screen
        && !vertical_leg_screen
        && !capture_off
        && same_capture_target(input.sources, &input.config["sources"])
        && input.screen_capture_running;
    ScreenFlags {
        vertical_leg_screen,
        retain_screen,
    }
}

/// `cameraLookLayout` on the JSON layout: the chosen camera's look replaces
/// whatever look the layout held; none for a camera without one. (The
/// camera's background half of `cameraOutputLayout` is part 4.)
pub fn camera_look_on_layout(
    layout: &Value,
    camera_id: Option<&str>,
    studio: &StudioSettings,
) -> Value {
    let mut layout = layout.clone();
    if let Value::Object(map) = &mut layout {
        map.remove("cameraLook");
        if let Some(look) = studio.camera_look(camera_id) {
            map.insert("cameraLook".into(), look);
        }
    }
    layout
}

/// `withoutSceneShortcut` (`shared/global-shortcuts.ts`): deletion
/// releases the scene's key; the other keys stay.
pub fn without_scene_shortcut(config: Option<&Value>, id: &str) -> Value {
    let mut next = config
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut scenes = get(config, "scenes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    scenes.remove(id);
    next.insert("scenes".into(), Value::Object(scenes));
    Value::Object(next)
}

/// `isSceneReloadSuperseded` (#1639).
pub fn is_scene_reload_superseded(error: &RpcError) -> bool {
    error.code == SCENE_RELOAD_SUPERSEDED_CODE
}

/// `sceneReloadRetryDelayMs` (#1639): 1 s, doubling, at most 15 s.
pub fn scene_reload_retry_delay(attempt: u32) -> Duration {
    let ms = 1_000u64.saturating_mul(1u64 << attempt.min(16));
    Duration::from_millis(ms.min(15_000))
}

/// `{...sources, ...cameraSources(from)}`: every camera key written, an
/// absent one removed.
fn apply_camera_sources(sources: &mut Map<String, Value>, from: &Value) {
    for key in CAMERA_KEYS {
        match from.get(key) {
            Some(value) => sources.insert(key.into(), value.clone()),
            None => sources.remove(key),
        };
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// The intent a transaction minted (or the latest one when it was refused
/// before minting), and whether the backend committed it.
struct TransactionOutcome {
    committed: bool,
    intent: u64,
}

/// `holdSceneGoingOn`'s release, on drop (D16): a scene can't be deleted
/// from the click until its last transaction settles.
pub(super) struct GoingOn<B: StudioBackend> {
    studio: Arc<Studio<B>>,
    id: String,
}

impl<B: StudioBackend> Drop for GoingOn<B> {
    fn drop(&mut self) {
        let mut inner = self.studio.lock();
        let holds = &mut inner.scenes.switch.going_on;
        match holds.get_mut(&self.id) {
            Some(count) if *count > 1 => *count -= 1,
            _ => {
                holds.remove(&self.id);
            }
        }
    }
}

fn remember_failed() -> NoticeCommand {
    NoticeCommand::Show(
        ToastRequest::error(copy::REMEMBER_FAILED)
            .id(copy::REMEMBER_FAILED_ID)
            .description(copy::REMEMBER_FAILED_BODY)
            .finish(),
    )
}

fn warning(title: impl Into<String>, id: &str, description: Option<&str>) -> NoticeCommand {
    NoticeCommand::Show(
        ToastRequest::warning(title)
            .id(id)
            .maybe_description(description.map(str::to_string))
            .finish(),
    )
}

impl Inner {
    /// `persistWorkingVisual`: the working setup's checkpoint
    /// (`videorc.working-scene.v1`) and, out of band, D11's autosave: a
    /// confirmed edit made while a scene is on stream saves into it (its
    /// look, and a picked screen; never its audio). A refused checkpoint
    /// says "Couldn't remember this scene for next time".
    pub(super) fn persist_working_visual(
        &mut self,
        layout: &Value,
        sources: &Value,
        background: Option<&Value>,
        saved_id: Option<&str>,
        now: &str,
        logger: &Logger,
    ) {
        let mut with_app = sources.clone();
        if let Value::Object(map) = &mut with_app {
            match &self.scenes.switch.working_app {
                Some(app) => map.insert("app".into(), app.clone()),
                None => map.remove("app"),
            };
        }
        let raw = json!({
            "layout": layout,
            "sources": visual_sources(&with_app),
            "background": snapshot_background(background),
        });
        let visual = match normalize_scene_visual(&raw) {
            Ok(visual) => visual,
            Err(error) => {
                logger.warn(format!("[scenes] the working scene did not read: {error}"));
                return;
            }
        };
        let persisted = self.scenes.switch.persisted.clone();
        let autosave = (persisted.scene_id.as_deref() != saved_id
            || persisted.visual.as_ref() != Some(&visual))
        .then(|| {
            self.scenes.switch.persisted = Persisted {
                scene_id: saved_id.map(str::to_string),
                visual: Some(visual.clone()),
                shows: Some(shows_from_sources(
                    visual.get("sources").unwrap_or(&Value::Null),
                )),
            };
            persisted
        });
        let working = WorkingScene {
            origin: self.scenes.switch.origin,
            scene_id: saved_id.map(str::to_string),
            visual: visual.clone(),
        };
        let write = SettingWrite::Put {
            key: keys::WORKING_SCENE.to_string(),
            value: encode(&working.to_json()),
        };
        if let Err(error) = self.stage_writes(&[write], logger) {
            logger.warn(format!(
                "[scenes] the working scene was not saved: {}",
                error.message
            ));
            self.scenes.notices.push(remember_failed());
        }
        // `autosaveSavedScene(persisted, savedSceneId, visual)`.
        let Some(previous) = autosave else {
            return;
        };
        let Some(state) = &self.scenes.state else {
            return;
        };
        let scene = scene_edit_autosave(&EditAutosave {
            previous_scene_id: previous.scene_id.as_deref(),
            previous_shows: previous.shows.as_ref(),
            scene_id: saved_id,
            scenes: &state.library.scenes,
            visual: &visual,
            now,
        });
        if let Some(library) = scene.and_then(|scene| state.replace(&scene).ok()) {
            self.write_library(library, false);
        }
    }

    /// `sceneIsGoingOn` (D16): a switch to it runs, or it committed and the
    /// stream waits for its proof.
    pub(super) fn scene_is_going_on(&self, id: &str) -> bool {
        let switch = &self.scenes.switch;
        switch.going_on.contains_key(id)
            || (switch.awaiting_proof.is_some()
                && switch.last_commit_scene.as_ref().and_then(Option::as_deref) == Some(id)
                && self.scenes.on_stream.as_deref() != Some(id))
    }

    /// What the capture shows now, with the working app
    /// (`showsFromSources(visualSources({...sources, app}))`).
    fn working_shows(&self) -> SceneShows {
        let mut sources = self.capture.config["sources"].clone();
        if let (Value::Object(map), Some(app)) = (&mut sources, &self.scenes.switch.working_app) {
            map.insert("app".into(), app.clone());
        }
        shows_from_sources(&visual_sources(&sources))
    }

    /// A stored scene edited in place and written (a refusal writes nothing).
    fn replace_scene(&mut self, scene: &Scene) -> bool {
        let edit = self
            .scenes
            .state
            .as_ref()
            .and_then(|state| state.replace(scene).ok());
        match edit {
            Some(library) => self.write_library(library, false),
            None => false,
        }
    }
}

impl<B: StudioBackend> Studio<B> {
    /// The preview element's presentation, for the transaction's proof
    /// (`getPreviewWindowState` and the surface's presented revision).
    pub fn set_presentation_probe(&self, probe: PresentationProbe) {
        self.lock().scenes.switch.presentation = Some(probe);
        self.publish();
    }

    /// `reportError(error, {action: 'switch', object: 'the scene'})`.
    fn report_switch_error(&self, error: &RpcError) {
        let connected = matches!(self.lock().connection, Connection::Connected { .. });
        if let Some(command) = backend_error_toast(error, connected, copy::SWITCH_THE_SCENE) {
            self.post(vec![command]);
        }
    }

    /// D18: the preview's screen capture is live or starting
    /// (`previewScreenStatusRef`), as the `preview.screen.status` reads and
    /// events the Health telemetry keeps say.
    fn screen_capture_running(&self) -> bool {
        self.telemetry
            .borrow()
            .preview_screen
            .as_ref()
            .and_then(|status| status.get("state"))
            .and_then(Value::as_str)
            .is_some_and(|state| state == "live" || state == "starting")
    }

    /// `holdSceneGoingOn(id)`: released when the guard drops.
    fn hold_going_on(self: &Arc<Self>, id: &str) -> GoingOn<B> {
        *self
            .lock()
            .scenes
            .switch
            .going_on
            .entry(id.to_string())
            .or_default() += 1;
        GoingOn {
            studio: self.clone(),
            id: id.to_string(),
        }
    }

    /// D16: whether a switch is putting scene `id` on stream.
    pub fn scene_is_going_on(&self, id: &str) -> bool {
        self.lock().scene_is_going_on(id)
    }

    /// `requestLayoutTransaction` (plan 231): answers the commit receipt
    /// (the backend committed this intent), which is what a deck's ack
    /// waits for. The Studio follows the commit at once; the proof and its
    /// notices follow on their own.
    pub async fn request_layout_transaction(
        self: &Arc<Self>,
        layout: Value,
        options: TransactionOptions,
    ) -> bool {
        self.layout_transaction(layout, options, None)
            .await
            .committed
    }

    async fn layout_transaction(
        self: &Arc<Self>,
        layout: Value,
        options: TransactionOptions,
        hold: Option<GoingOn<B>>,
    ) -> TransactionOutcome {
        let (session_active, crosses, connected, generation, latest) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            (
                inner.session.is_active(),
                Orientation::of_layout(&layout)
                    != Orientation::of_layout(&inner.capture.config["layout"]),
                matches!(inner.connection, Connection::Connected { .. }),
                inner.bootstrap_generation,
                inner.scenes.switch.intent_id,
            )
        };
        let refused = TransactionOutcome {
            committed: false,
            intent: latest,
        };
        if session_active && crosses {
            self.post(vec![warning(
                copy::ORIENTATION_LOCK,
                copy::ORIENTATION_LOCK_ID,
                None,
            )]);
            return refused;
        }
        if !connected {
            self.post(vec![warning(
                copy::RECONNECTING,
                OFFLINE_TOAST_ID,
                Some(copy::SCENE_DID_NOT_CHANGE),
            )]);
            return refused;
        }

        // The intent, and the pending state.
        let (intent, requested, studio, background, leg_scene, protected) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let switch = &mut inner.scenes.switch;
            let intent = (switch.intent_id + 1).max(now_ms());
            switch.intent_id = intent;
            switch.awaiting_proof = Some(intent);
            switch.transaction_pending = true;
            switch.pending_id = options.saved_scene_id.clone().flatten();
            // Background-only commits keep the same preset: no pending mark.
            if !options.quiet {
                switch.pending_layout = Some(LayoutTarget::of(&layout));
            }
            let background = match &options.background_override {
                Some(background) => background.clone(),
                None => switch.working_background.clone(),
            };
            let leg_id = match &options.saved_scene_id {
                Some(id) => id.clone(),
                None => inner.scenes.on_stream.clone(),
            };
            let leg_scene = leg_id.and_then(|id| inner.stored_scene(&id));
            (
                intent,
                inner.capture.config.clone(),
                StudioSettings::load(inner.settings.get(keys::SETTINGS)),
                background,
                leg_scene,
                inner.exclusion.wanted.clone(),
            )
        };
        self.publish();

        let sources = options
            .sources_override
            .clone()
            .unwrap_or_else(|| requested["sources"].clone());
        let layout = camera_look_on_layout(&layout, string(sources.get("cameraId")), &studio);

        // Plan 210 S3: the strict check, against the held devices (one fresh
        // list only for a source missing from it).
        if options.strict_sources {
            let devices = self.lock().sources.devices.devices.clone();
            let scene_app = options.scene_app.clone().flatten();
            let visual = preflight_visual(&layout, &sources, background.as_ref());
            let backend = self.backend.clone();
            // The managed background's file check is the app's (S1.6c); a
            // saved background is taken as there.
            let result = run_saved_scene_preflight(
                &visual,
                scene_app.as_ref(),
                &devices,
                async move { backend.devices().await.ok().map(|list| list.devices) },
                None::<std::future::Ready<bool>>,
            )
            .await;
            if !result.issues.is_empty() {
                self.config.logger.warn(format!(
                    "[scenes] the switch was refused before it was sent: {}",
                    result.issues.join(" ")
                ));
                if self.lock().scenes.switch.intent_id == intent {
                    // A plain `Error` in the renderer: its words go to the
                    // log, never to the toast.
                    let error = RpcError::new(
                        "scene.preflight",
                        "scene-preflight-refused",
                        result.issues.join(" "),
                    );
                    self.report_switch_error(&error);
                }
                self.end_transaction(intent);
                return TransactionOutcome {
                    committed: false,
                    intent,
                };
            }
        }

        let method = if session_active || options.camera_look_only {
            APPLY_LIVE_METHOD
        } else {
            APPLY_PREVIEW_METHOD
        };
        let flags = transaction_screen_flags(&ScreenFlagsInput {
            live_method: method == APPLY_LIVE_METHOD,
            session_active,
            layout: &layout,
            sources: &sources,
            config: &requested,
            leg_scene: leg_scene.as_ref(),
            screen_capture_running: self.screen_capture_running(),
        });
        let video = options
            .video_override
            .clone()
            .unwrap_or_else(|| requested["video"].clone());
        let mut params = json!({
            "intentId": intent,
            "sources": sources.clone(),
            "layout": layout.clone(),
            "video": video,
            "protectedOverlayWindowIds": protected,
        });
        if let Some(background) = &background {
            params["background"] = background.clone();
        }
        if flags.vertical_leg_screen {
            params["verticalLegScreen"] = json!(true);
        } else if flags.retain_screen {
            params["retainScreen"] = json!(true);
        }
        if studio.animate_scene_changes() && !options.camera_look_only {
            params["transitionMs"] = json!(SCENE_TRANSITION_MS);
        }
        let status = match self.backend.scene_request(method, params).await {
            Ok(status) => status,
            Err(error) => {
                // The last commit stays: the renderer reads the backend's
                // truth here first (`readLayoutTransactionBackendTruth`).
                self.config.logger.warn(format!(
                    "[scenes] {method} failed: {} ({})",
                    error.message, error.code
                ));
                if self.lock().scenes.switch.intent_id == intent {
                    self.report_switch_error(&error);
                }
                self.end_transaction(intent);
                return TransactionOutcome {
                    committed: false,
                    intent,
                };
            }
        };
        let revision = status.get("sceneRevision").and_then(Value::as_u64);
        let committed_layout = get(status.get("compositorStatus"), "sceneLayout")
            .filter(|layout| layout.is_object())
            .cloned()
            .unwrap_or(layout);
        let latest = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let saved_id = match &options.saved_scene_id {
                Some(id) => id.clone(),
                None => inner.scenes.on_stream.clone(),
            };
            // `rememberLayoutTransactionSnapshot`.
            inner.scenes.switch.last_commit_scene = Some(saved_id.clone());
            let committed = Committed {
                scene: status.get("scene").cloned().unwrap_or(Value::Null),
                layout: committed_layout,
                capture_patch: options.capture_patch.clone(),
                sources,
                scene_app: match &options.scene_app {
                    Some(app) => app.clone(),
                    None => inner.scenes.switch.working_app.clone(),
                },
                saved_id,
                origin: options.origin.unwrap_or(inner.scenes.switch.origin),
                scene_switch: options.scene_switch,
            };
            (inner.scenes.switch.intent_id == intent).then_some(committed)
        };
        // The backend's commit is authoritative: the controls follow it now,
        // and the proof below only says when the picture lags.
        if let Some(committed) = latest {
            self.apply_transaction_state(committed).await;
        }
        let studio = self.clone();
        tokio::spawn(async move {
            studio
                .prove_commit(intent, revision, session_active, generation)
                .await;
            studio.end_transaction(intent);
            drop(hold);
        });
        TransactionOutcome {
            committed: true,
            intent,
        }
    }

    /// The transaction's `finally`: the pending state goes once it is the
    /// latest.
    fn end_transaction(&self, intent: u64) {
        {
            let mut inner = self.lock();
            let switch = &mut inner.scenes.switch;
            if switch.awaiting_proof == Some(intent) {
                switch.awaiting_proof = None;
            }
            if switch.intent_id != intent {
                return;
            }
            switch.pending_layout = None;
            switch.pending_id = None;
            switch.transaction_pending = false;
        }
        self.publish();
    }

    /// `rememberLayoutCommit`: a session's output shows the revision
    /// (`waitForLiveLayoutProof`), then the preview presents it when it can
    /// (`waitForNativePreviewSurfaceSceneRevision`). A missed output proof
    /// is an error, unless the connection went away meanwhile (#1674: the
    /// status says so, and the reconnect reads the scene again); a missed
    /// preview proof only says the preview may be behind.
    async fn prove_commit(
        &self,
        intent: u64,
        revision: Option<u64>,
        session_active: bool,
        generation: u64,
    ) {
        let Some(revision) = revision else {
            return;
        };
        if session_active && !self.wait_live_proof(revision).await {
            let (latest, gone) = {
                let inner = self.lock();
                (
                    inner.scenes.switch.intent_id == intent,
                    !matches!(inner.connection, Connection::Connected { .. })
                        || inner.bootstrap_generation != generation,
                )
            };
            if !latest {
                return;
            }
            if gone {
                self.config.logger.warn(format!(
                    "[scenes] Layout committed at revision {revision}, but preview proof was not observed before its engine connection closed."
                ));
                return;
            }
            self.config.logger.warn(format!(
                "[scenes] Layout committed at revision {revision}, but preview proof was not observed. The controls were reconciled to the backend commit."
            ));
            if let Some(command) = toast_user_error(
                Failure::Sentence {
                    text: copy::CHECK_THE_PREVIEW,
                    warning: false,
                },
                copy::CONFIRM_THE_SCENE_CHANGE,
                "layout-proof",
            ) {
                self.post(vec![command]);
            }
            return;
        }
        let Some(presentation) = self.lock().scenes.switch.presentation.clone() else {
            return;
        };
        if !presentation().can_present {
            return;
        }
        let deadline = Instant::now() + PREVIEW_PROOF_WAIT;
        loop {
            let now = presentation();
            if !now.can_present
                || now
                    .presented_revision
                    .is_some_and(|shown| shown >= revision)
            {
                return;
            }
            if Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(PREVIEW_PROOF_EVERY).await;
        }
        if self.lock().scenes.switch.intent_id != intent {
            return;
        }
        self.config.logger.warn(format!(
            "[scenes] Layout committed at revision {revision}; native preview presentation proof was not observed."
        ));
        let id = self
            .lock()
            .scenes
            .switch
            .proof_notices
            .id(copy::PROOF_LAG_KEY, Instant::now());
        self.post(vec![NoticeCommand::Show(
            ToastRequest::info(copy::PROOF_LAG_TITLE)
                .id(id)
                .description(copy::PROOF_LAG_BODY)
                .finish(),
        )]);
    }

    /// `waitForLiveLayoutProof`: the compositor drew the revision and the
    /// session's output is on it.
    async fn wait_live_proof(&self, revision: u64) -> bool {
        let deadline = Instant::now() + LIVE_PROOF_WAIT;
        loop {
            let (compositor, diagnostics) = tokio::join!(
                self.backend
                    .scene_request(COMPOSITOR_STATUS_METHOD, Value::Null),
                self.backend
                    .scene_request(DIAGNOSTICS_STATS_METHOD, Value::Null),
            );
            if let (Ok(compositor), Ok(diagnostics)) = (compositor, diagnostics) {
                let drawn = compositor.get("sceneRevision").and_then(Value::as_u64)
                    == Some(revision)
                    && compositor.get("frameSceneRevision").and_then(Value::as_u64)
                        == Some(revision);
                let live = diagnostics
                    .get("activeSceneRevision")
                    .and_then(Value::as_u64)
                    .is_some_and(|active| active >= revision);
                if drawn && live {
                    return true;
                }
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(LIVE_PROOF_EVERY).await;
        }
    }

    /// `applyLayoutTransactionState` (plan 231): the scene, the working
    /// background and origin, the scene on stream (the committed one, else
    /// the one on; a scene the library lost is replaced and put on again,
    /// D16), the capture config (the canvas patch, the sources, each
    /// orientation's last layout, the layout, and the framing every commit
    /// that is not a switch remembers), the working app, then
    /// `persistWorkingVisual` (and D11's autosave).
    async fn apply_transaction_state(self: &Arc<Self>, committed: Committed) {
        let restore = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            if let Ok(scene) =
                serde_json::from_value::<videorc_protocol::Scene>(committed.scene.clone())
            {
                inner.sources.set_scene(scene);
            }
            let background = committed
                .scene
                .get("background")
                .filter(|background| background.is_object())
                .cloned();
            inner.scenes.switch.working_background = background.clone();
            inner.scenes.switch.origin = committed.origin;
            // A scene going on stream is not an edit of it (D3): its commit
            // saves nothing, even when it was already on.
            if committed.scene_switch {
                inner.scenes.switch.persisted = Persisted::default();
            }
            // A scene is always on stream (D2): a commit that names none
            // keeps it. A scene the library no longer has is never named on
            // stream (D16): the one on stays (the first one, if that went
            // too) and goes on again.
            let current_id = inner.scenes.on_stream.clone();
            let named = committed.saved_id.clone().or(current_id.clone());
            let gone = named
                .as_deref()
                .is_some_and(|id| inner.stored_scene(id).is_none());
            let saved_id = if gone {
                current_id
                    .as_deref()
                    .and_then(|id| inner.stored_scene(id))
                    .or_else(|| {
                        inner
                            .scenes
                            .state
                            .as_ref()
                            .and_then(|state| state.library.scenes.first().cloned())
                    })
                    .map(|scene| scene.id)
            } else {
                named.clone()
            };
            if let Some(id) = &saved_id {
                inner.set_scene_on_stream(id);
            }
            let restore = saved_id.clone().filter(|_| gone);
            if let Some(id) = &restore {
                self.config.logger.warn(format!(
                    "[scenes] committed scene {} is gone; putting {id} back on",
                    named.as_deref().unwrap_or_default()
                ));
            }
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            let current = inner.capture.config.clone();
            let mut next = current.clone();
            let to = layout_preset(&committed.layout).to_string();
            let patch = committed.capture_patch.clone().or_else(|| {
                vertical_orientation_video_patch(
                    layout_preset(&current["layout"]),
                    &to,
                    &current["video"],
                    &current["verticalRestoreVideo"],
                )
            });
            if let Some((video, restore_video)) = patch {
                next["video"] = video;
                next["verticalRestoreVideo"] = restore_video;
            }
            next["sources"] = committed.sources.clone();
            let (memory_key, memory_value) = layout_preset_memory_patch(&to);
            next[memory_key] = memory_value;
            next["layout"] = committed.layout.clone();
            // A scene going on stream brings its own framing; an edit is
            // remembered.
            if !committed.scene_switch {
                next["layoutFramingMemory"] =
                    remember_layout_framing(&current["layoutFramingMemory"], &committed.layout);
            }
            inner.scenes.switch.working_app = committed.scene_app.clone();
            let stored = capture_config::stored_capture_config(&next);
            let write = SettingWrite::Put {
                key: keys::CAPTURE_CONFIG.to_string(),
                value: stored.clone(),
            };
            match inner.stage_writes(&[write], &self.config.logger) {
                Ok(()) => inner.capture.set(next.clone(), Some(stored)),
                Err(error) => {
                    self.config.logger.warn(format!(
                        "[scenes] the committed capture config was not saved: {}",
                        error.message
                    ));
                    inner.capture.replace_config(next.clone());
                }
            }
            inner.persist_working_visual(
                &next["layout"],
                &next["sources"],
                background.as_ref(),
                saved_id.as_deref(),
                &(self.config.clock)(),
                &self.config.logger,
            );
            restore
        };
        self.publish();
        let _ = self.flush_settings().await;
        if let Some(id) = restore {
            self.spawn_restore(id);
        }
    }

    /// `queueMicrotask(() => applySavedSceneResult(restore))`: the scene on
    /// stream goes on again, so the stream shows a scene the list has.
    fn spawn_restore(self: &Arc<Self>, id: String) {
        let studio = self.clone();
        let restore: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
            Box::pin(async move {
                studio
                    .apply_saved_scene(&id, None, ApplyOptions::default())
                    .await;
            });
        tokio::spawn(restore);
    }

    /// `requestCameraPresetTransaction` (plan 231): choosing a layout sets
    /// the layout of the scene on stream (it stays on). A preset of the
    /// other orientation starts from the scene's own layout there; the
    /// orientation toggle takes that layout as it is. Choosing a preset
    /// leaves Freeform; each layout's framing comes back with it. A scene
    /// whose sources are gone is refused with what's missing; off air, a
    /// vertical layout flips the canvas. A layout that starts drawing a
    /// screen shows the scene's own (D18), and a scene that shows none is
    /// refused (D19).
    pub async fn request_camera_preset_transaction(
        self: &Arc<Self>,
        patch: Map<String, Value>,
        options: PresetOptions,
    ) -> bool {
        let (current, devices, session_active, scene, working) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            let scene = inner
                .scenes
                .on_stream
                .clone()
                .and_then(|id| inner.stored_scene(&id));
            (
                inner.capture.config.clone(),
                inner.sources.devices.devices.clone(),
                inner.session.is_active(),
                scene,
                inner.working_shows(),
            )
        };
        let current_layout = &current["layout"];
        let patch_preset = string(patch.get("layoutPreset")).map(str::to_string);
        let target_orientation = Orientation::of_preset(
            patch_preset
                .as_deref()
                .unwrap_or_else(|| layout_preset(current_layout)),
        );
        let own = scene
            .as_ref()
            .filter(|_| target_orientation != Orientation::of_layout(current_layout))
            .map(|scene| scene.layout(target_orientation).clone());
        let keeps_own = own.is_some() && options.to_orientation;
        let base = own.clone().unwrap_or_else(|| current_layout.clone());
        let next_preset = if keeps_own {
            layout_preset(&base).to_string()
        } else {
            patch_preset
                .clone()
                .unwrap_or_else(|| layout_preset(&base).to_string())
        };
        // Choosing a preset leaves Freeform (unless the patch says
        // otherwise); its overrides go.
        let leaves_arrangement = patch_preset.is_some() && !patch.contains_key("arrangementMode");
        let next_layout = if keeps_own {
            base.clone()
        } else {
            let mut layout = base.as_object().cloned().unwrap_or_default();
            layout.extend(recalled_layout_framing(
                &current["layoutFramingMemory"],
                layout_preset(&base),
                &next_preset,
            ));
            if leaves_arrangement {
                layout.insert("arrangementMode".into(), json!("preset"));
                layout.insert("sourceTransformOverrides".into(), json!({}));
            }
            layout.extend(patch.clone());
            layout.insert("cameraTransformMode".into(), json!("preset"));
            layout.insert("cameraTransform".into(), Value::Null);
            Value::Object(layout)
        };
        if patch_preset.is_some() {
            let checked = if keeps_own {
                base.clone()
            } else {
                let mut layout = base.clone();
                if let Value::Object(map) = &mut layout {
                    map.insert("layoutPreset".into(), json!(next_preset));
                    map.insert("arrangementMode".into(), json!("preset"));
                }
                layout
            };
            let issues = scene_source_problems(
                &json!({
                    "layout": checked,
                    "sources": using_visual_sources(&current["sources"]),
                    "background": null,
                }),
                &devices,
            );
            if !issues.is_empty() {
                self.post(vec![warning(
                    issues.join(" "),
                    copy::SOURCE_UNAVAILABLE_ID,
                    None,
                )]);
                return false;
            }
        }
        // The vertical ⇄ canvas coupling, off air only.
        let coupling = (!session_active)
            .then(|| {
                vertical_orientation_video_patch(
                    layout_preset(current_layout),
                    &next_preset,
                    &current["video"],
                    &current["verticalRestoreVideo"],
                )
            })
            .flatten();
        // D18, D19: a layout that starts drawing a screen shows the scene's
        // own, never a capture an earlier scene left running under it.
        if let Some(scene) = &scene
            && layout_shows_screen(&next_layout)
            && !scene_draws_screen(scene, current_layout, simulcast_armed(&current))
        {
            if scene.shows == SceneShows::None {
                self.post(vec![warning(
                    no_screen_layout_reason(&scene.name),
                    copy::NO_SCREEN_ID,
                    None,
                )]);
                return false;
            }
            if scene_capture_is_borrowed(scene, &working) && options.background_override.is_none() {
                return self
                    .apply_saved_scene(
                        &scene.id,
                        None,
                        ApplyOptions {
                            layout: Some(next_layout),
                            ..ApplyOptions::default()
                        },
                    )
                    .await
                    .ok;
            }
        }
        self.request_layout_transaction(
            next_layout,
            TransactionOptions {
                video_override: coupling.as_ref().map(|(video, _)| video.clone()),
                capture_patch: coupling,
                background_override: options.background_override,
                ..TransactionOptions::default()
            },
        )
        .await
    }

    /// `applyCameraPreset(patch, {toOrientation})`: a card, a key, a deck.
    pub async fn apply_camera_preset(
        self: &Arc<Self>,
        patch: Map<String, Value>,
        to_orientation: bool,
    ) -> bool {
        self.request_camera_preset_transaction(
            patch,
            PresetOptions {
                to_orientation,
                ..PresetOptions::default()
            },
        )
        .await
    }

    /// `applyCameraPreset({layoutPreset})`.
    pub async fn apply_layout_preset(self: &Arc<Self>, preset: &str) -> bool {
        let mut patch = Map::new();
        patch.insert("layoutPreset".into(), json!(preset));
        self.apply_camera_preset(patch, false).await
    }

    /// The 16:9 / 9:16 toggle (`switchMode` in `scene-presets.tsx`): the
    /// scene on stream goes on in its own layout for that orientation
    /// (`ORIENTATION_DEFAULT_PRESET` only names it, and is the layout when
    /// there is no scene on stream).
    pub async fn switch_orientation(self: &Arc<Self>, vertical: bool) -> bool {
        let mode = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            inner.scene_orientation()
        };
        if (mode == Orientation::Vertical) == vertical {
            return true;
        }
        let mut patch = Map::new();
        patch.insert(
            "layoutPreset".into(),
            json!(orientation_default_preset(vertical)),
        );
        self.apply_camera_preset(patch, true).await
    }

    /// `switchToSceneWithLayout` (D14): a remote that names a layout
    /// switches to the first scene with that layout in the studio's
    /// orientation (with a remote's screen), or is refused.
    pub async fn switch_to_scene_with_layout(
        self: &Arc<Self>,
        preset: &str,
        shows: Option<SceneShows>,
    ) -> ApplyResult {
        let (target, orientation) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            let orientation = inner.scene_orientation();
            let target = inner.scenes.state.as_ref().and_then(|state| {
                first_scene_with_layout(&state.library.scenes, orientation, preset)
                    .map(|scene| scene.id.clone())
            });
            (target, orientation)
        };
        match target {
            Some(id) => {
                self.apply_saved_scene(
                    &id,
                    None,
                    ApplyOptions {
                        shows,
                        ..ApplyOptions::default()
                    },
                )
                .await
            }
            None => {
                let label =
                    layout_preset_label(preset, Orientation::of_preset(preset) != orientation);
                ApplyResult {
                    message: Some(format!("No scene uses {label}")),
                    ..ApplyResult::default()
                }
            }
        }
    }

    /// `applySavedScene(id, repaired)`.
    pub async fn apply_saved_scene_by_id(self: &Arc<Self>, id: &str) -> bool {
        self.apply_saved_scene(id, None, ApplyOptions::default())
            .await
            .ok
    }

    /// `applySavedSceneResult(id, repaired, options)` (plan 231): the stored
    /// scene, with what this switch brings (a remote's screen, a layout
    /// chosen on it), goes on stream in the studio's orientation with the
    /// shared camera (D9: only `repaired` sources may carry a camera, and
    /// then it becomes the camera). A scene no leg draws a screen for keeps
    /// the running capture and its app (D18) and needs no window of its own
    /// app; otherwise an app scene's window is found first (from the held
    /// list, else the resolver; one more try over the backend while the
    /// pick is still the latest). The commit is strict. Idle, the scene's
    /// microphone rides in its sources; once on, System audio follows it.
    pub async fn apply_saved_scene(
        self: &Arc<Self>,
        id: &str,
        repaired: Option<Value>,
        options: ApplyOptions,
    ) -> ApplyResult {
        let Some((stored, config)) = ({
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            inner
                .stored_scene(id)
                .map(|scene| (scene, inner.capture.config.clone()))
        }) else {
            return ApplyResult::failed();
        };
        let orientation =
            Orientation::of_layout(options.layout.as_ref().unwrap_or(&config["layout"]));
        let mut target = stored.clone();
        if let Some(shows) = &options.shows {
            target.shows = shows.clone();
        }
        if let Some(layout) = &options.layout {
            target.set_layout(orientation, layout.clone());
        }
        let saved = saved_scene_view(&target, orientation, &config["sources"]);
        let generation = {
            let mut inner = self.lock();
            inner.scenes.switch.resolve_generation += 1;
            inner.scenes.switch.resolve_generation
        };
        // D16: the scene can't be deleted under its switch.
        let _going_on = self.hold_going_on(id);
        let superseded = |studio: &Self, intent_before: u64| {
            let inner = studio.lock();
            generation != inner.scenes.switch.resolve_generation
                || intent_before != inner.scenes.switch.intent_id
        };
        let mut intent_before = self.lock().scenes.switch.intent_id;
        let vertical_leg = simulcast_armed(&config);
        let keeps_capture = repaired.is_none()
            && scene_keeps_capture(Some(&target), &saved.visual["layout"], vertical_leg);
        let mut visual = Value::Null;
        let mut microphone = None;
        let mut applied = false;
        let mut last_intent = intent_before;
        for attempt in 0..2u32 {
            let devices = self.lock().sources.devices.devices.clone();
            let Ok(base) = normalize_scene_visual(repaired.as_ref().unwrap_or(&saved.visual))
            else {
                return ApplyResult::failed();
            };
            visual = with_scene_display(&base, &devices);
            let hint = self.lock().scenes.switch.window_hints.get(id).cloned();
            if let (Some(hint), Some(Value::Object(sources))) = (hint, visual.get_mut("sources"))
                && sources.get("app").is_some_and(Value::is_object)
                && !truthy(sources.get("windowId"))
            {
                sources.insert("windowId".into(), json!(hint));
            }
            if !keeps_capture {
                let fallback = self.lock().scenes.apps.get(id).map(str::to_string);
                let resolution = self
                    .resolve_scene_window_for_apply(
                        &visual,
                        &devices,
                        fallback.as_deref(),
                        options.prefer_window.as_deref(),
                        attempt > 0,
                    )
                    .await;
                if superseded(self, intent_before) {
                    return ApplyResult::superseded();
                }
                match resolution {
                    Err(error) => {
                        self.report_switch_error(&error);
                        return ApplyResult::failed();
                    }
                    Ok(SceneWindowResolution::Blocked(failure)) => {
                        self.lock()
                            .scenes
                            .resolved
                            .insert(id.to_string(), SceneAppState::Failed(failure));
                        self.publish();
                        let message = scene_window_refusal(&visual, failure);
                        self.post(vec![warning(
                            message.clone(),
                            copy::APP_UNAVAILABLE_ID,
                            None,
                        )]);
                        return ApplyResult {
                            message: Some(message),
                            ..ApplyResult::default()
                        };
                    }
                    Ok(SceneWindowResolution::Ready(sources)) => {
                        let has_app = get(Some(&sources), "app").is_some_and(Value::is_object);
                        visual["sources"] = sources;
                        if has_app {
                            self.lock()
                                .scenes
                                .resolved
                                .insert(id.to_string(), SceneAppState::Ready);
                        }
                    }
                    Ok(_) => {}
                }
            } else if superseded(self, intent_before) {
                return ApplyResult::superseded();
            }
            let (current, live, active, working_app) = {
                let mut guard = self.lock();
                let inner = &mut *guard;
                inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
                (
                    inner.capture.config.clone(),
                    inner.session.is_active()
                        && !super::session_is_replay_only(inner.session.status()),
                    inner.session.is_active(),
                    inner.scenes.switch.working_app.clone(),
                )
            };
            // Idle, the scene's microphone rides in its sources and the
            // commit makes it the pick.
            microphone = saved
                .audio
                .as_ref()
                .and_then(|audio| scene_microphone(audio, &devices));
            let coupling = (!active)
                .then(|| {
                    vertical_orientation_video_patch(
                        layout_preset(&current["layout"]),
                        layout_preset(&visual["layout"]),
                        &current["video"],
                        &current["verticalRestoreVideo"],
                    )
                })
                .flatten();
            let mut sources = current["sources"].as_object().cloned().unwrap_or_default();
            if !keeps_capture {
                apply_capture_sources(&mut sources, &visual["sources"]);
            }
            if repaired.is_some() {
                apply_camera_sources(&mut sources, &visual["sources"]);
            }
            if !live && let Some(microphone) = &microphone {
                for (key, value) in [
                    ("microphoneId", microphone.microphone_id.as_ref()),
                    ("microphoneName", microphone.microphone_name.as_ref()),
                ] {
                    match value {
                        Some(value) => sources.insert(key.into(), json!(value)),
                        None => sources.remove(key),
                    };
                }
                sources.insert("microphoneOff".into(), json!(microphone.microphone_off));
            }
            let scene_app = if keeps_capture {
                working_app
            } else {
                get(visual.get("sources"), "app")
                    .filter(|app| app.is_object())
                    .cloned()
            };
            let hold = self.hold_going_on(id);
            let outcome = self
                .layout_transaction(
                    visual["layout"].clone(),
                    TransactionOptions {
                        scene_app: Some(scene_app.clone()),
                        sources_override: Some(without_scene_app(&Value::Object(sources))),
                        background_override: Some(resolve_saved_background(
                            visual.get("background"),
                        )),
                        saved_scene_id: Some(Some(id.to_string())),
                        origin: Some(Origin::Saved),
                        scene_switch: true,
                        strict_sources: true,
                        video_override: coupling.as_ref().map(|(video, _)| video.clone()),
                        capture_patch: coupling,
                        ..TransactionOptions::default()
                    },
                    Some(hold),
                )
                .await;
            last_intent = outcome.intent;
            applied = outcome.committed;
            if applied {
                break;
            }
            let (latest_generation, latest_intent, devices) = {
                let inner = self.lock();
                (
                    inner.scenes.switch.resolve_generation,
                    inner.scenes.switch.intent_id,
                    inner.sources.devices.devices.clone(),
                )
            };
            // A source turned off on purpose refuses the same way twice.
            if !saved_scene_apply_retry_allowed(
                attempt,
                generation,
                latest_generation,
                outcome.intent,
                latest_intent,
            ) || matches!(
                judge_scene_sources(
                    &visual,
                    &devices,
                    get(visual.get("sources"), "app").filter(|app| app.is_object()),
                ),
                Judgement::Refused(_)
            ) {
                break;
            }
            intent_before = outcome.intent;
        }
        // A newer click took the switch over (#1275): not a failure.
        if !applied && self.lock().scenes.switch.intent_id != last_intent {
            return ApplyResult::superseded();
        }
        if applied {
            self.after_saved_scene_applied(id, &visual, orientation, &options, repaired.is_none())
                .await;
        }
        let Some(audio) = saved.audio.as_ref().filter(|_| applied) else {
            return ApplyResult::landed(applied);
        };
        let system_audio_now =
            self.lock().capture.config["audio"]["systemAudioEnabled"] == Value::Bool(true);
        if audio.system_audio_enabled != system_audio_now {
            let enabled = audio.system_audio_enabled;
            if let Err(error) = self
                .update_capture_config(|config| {
                    capture_config::set_path(
                        config,
                        &["audio", "systemAudioEnabled"],
                        Some(json!(enabled)),
                    );
                })
                .await
            {
                self.config.logger.warn(format!(
                    "[scenes] the scene's System audio was not saved: {}",
                    error.message
                ));
            }
        }
        if microphone.is_none() {
            if audio.microphone_id.is_some() {
                let name = audio
                    .microphone_name
                    .clone()
                    .unwrap_or_else(|| copy::MICROPHONE_MISSING_FALLBACK.to_string());
                self.post(vec![warning(
                    format!("{name} isn't available"),
                    copy::MICROPHONE_MISSING_ID,
                    Some(copy::MICROPHONE_MISSING_BODY),
                )]);
            }
            return ApplyResult::landed(true);
        }
        // A recording or livestream switches to the scene's microphone
        // through the session's source switch, which lands with the live
        // sources (S1.6b part 5); the session keeps its microphone here.
        ApplyResult::landed(true)
    }

    /// After a saved scene went on: what it went on with is its own (D2,
    /// D11), its window is the next switch's hint, its display as listed
    /// now (unless repaired sources went on), and the app it went on with
    /// is remembered.
    async fn after_saved_scene_applied(
        &self,
        id: &str,
        visual: &Value,
        orientation: Orientation,
        options: &ApplyOptions,
        refresh: bool,
    ) {
        {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let now = (self.config.clock)();
            if (options.shows.is_some() || options.layout.is_some())
                && let Some(mut latest) = inner.stored_scene(id)
            {
                if let Some(shows) = &options.shows {
                    latest.shows = shows.clone();
                }
                if let Some(layout) = &options.layout {
                    latest.set_layout(orientation, layout.clone());
                }
                latest.updated_at = now.clone();
                inner.replace_scene(&latest);
            }
            let sources = visual.get("sources").cloned().unwrap_or(Value::Null);
            let window = string(sources.get("windowId")).map(str::to_string);
            match window.filter(|_| truthy(sources.get("app"))) {
                Some(window) => {
                    inner
                        .scenes
                        .switch
                        .window_hints
                        .insert(id.to_string(), window);
                }
                None => {
                    inner.scenes.switch.window_hints.remove(id);
                }
            }
            let devices = inner.sources.devices.devices.clone();
            if refresh
                && let Some(next) = inner
                    .stored_scene(id)
                    .and_then(|scene| scene_display_refreshed(&scene, &devices))
            {
                inner.replace_scene(&next);
            }
            let listed = inner.listed_scenes();
            let remembered =
                remember_scene_window_app(&inner.scenes.apps, id, &sources, &devices, &listed);
            if remembered != inner.scenes.apps {
                // Best effort, as `localStorage.setItem` is.
                inner.stage_quietly(&[SettingWrite::Put {
                    key: keys::SCENE_WINDOW_APPS.to_string(),
                    value: Value::String(remembered.to_json_text()),
                }]);
                inner.remember_scene_apps();
            }
        }
        self.publish();
        let _ = self.flush_settings().await;
    }

    /// `resolveSceneWindowForApply`: an app scene's window from the held
    /// list when it names the remembered (or preferred) window, else the
    /// backend's resolver.
    async fn resolve_scene_window_for_apply(
        &self,
        visual: &Value,
        devices: &[videorc_protocol::Device],
        fallback: Option<&str>,
        prefer_window: Option<&str>,
        force_resolve: bool,
    ) -> Result<SceneWindowResolution, RpcError> {
        let initial = resolve_scene_window(visual, devices, fallback, None);
        let SceneWindowResolution::ResolveApp(bundle) = initial else {
            return Ok(initial);
        };
        let preferred = prefer_window
            .map(str::to_string)
            .or_else(|| string(get(visual.get("sources"), "windowId")).map(str::to_string));
        let held = (!force_resolve)
            .then(|| held_app_window(devices, &bundle, preferred.as_deref()))
            .flatten();
        let resolution = match held {
            Some(window) => AppWindowResolution::Found {
                window_id: window.id.clone(),
                title: window.window_title.clone().unwrap_or_default(),
            },
            None => {
                let mut params = json!({"bundleId": bundle});
                if let Some(preferred) = &preferred {
                    params["preferWindowId"] = json!(preferred);
                }
                let answer = self
                    .backend
                    .scene_request(RESOLVE_APP_WINDOW_METHOD, params)
                    .await?;
                AppWindowResolution::from_json(&answer).ok_or_else(|| {
                    RpcError::new(
                        RESOLVE_APP_WINDOW_METHOD,
                        crate::client::codes::INVALID_RESPONSE,
                        "The app window answer did not read.",
                    )
                })?
            }
        };
        Ok(resolved_for_apply(visual, devices, fallback, &resolution))
    }

    /// `deleteSavedScene` (D16): the last scene stays; a scene going on
    /// stream can't be deleted. Off air, deleting the scene on stream first
    /// switches to the scene before it (and gives up if that fails); while
    /// recording or live it can't be deleted. Its key goes with it.
    pub async fn delete_scene(self: &Arc<Self>, id: &str) -> bool {
        let (session_active, verdict) = {
            let inner = self.lock();
            let Some(state) = &inner.scenes.state else {
                return false;
            };
            let session_active = inner.session.is_active();
            let verdict = can_delete_scene(
                &state.library.scenes,
                id,
                inner.scenes.on_stream.as_deref().unwrap_or_default(),
                session_active,
                inner.scene_is_going_on(id),
            );
            (session_active, verdict)
        };
        let switch_to = match verdict {
            DeleteRule::Refused(reason) => {
                if let Some(reason) = reason {
                    self.post(vec![warning(reason, copy::DELETE_REFUSED_ID, None)]);
                }
                return false;
            }
            DeleteRule::Allowed { switch_to } => switch_to,
        };
        if let Some(switch_to) = switch_to
            && !self
                .apply_saved_scene(&switch_to, None, ApplyOptions::default())
                .await
                .ok
        {
            return false;
        }
        let removed = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            // The switch may have handed over to another meanwhile: never
            // delete a scene that is now going on.
            if inner.scene_is_going_on(id) {
                drop(guard);
                self.post(vec![warning(
                    GOING_ON_STREAM_REASON,
                    copy::DELETE_REFUSED_ID,
                    None,
                )]);
                return false;
            }
            let edit = inner
                .scenes
                .state
                .as_ref()
                .and_then(|state| state.remove(id, session_active).ok());
            let removed = edit.is_some_and(|library| inner.write_library(library, false));
            if removed {
                let mut settings = StudioSettings::load(inner.settings.get(keys::SETTINGS));
                let shortcuts = without_scene_shortcut(settings.get("globalShortcuts"), id);
                settings.set("globalShortcuts", shortcuts);
                let write = SettingWrite::Put {
                    key: keys::SETTINGS.to_string(),
                    value: settings.stored(),
                };
                if let Err(error) = inner.stage_writes(&[write], &self.config.logger) {
                    self.config.logger.warn(format!(
                        "[scenes] the deleted scene's key was not released: {}",
                        error.message
                    ));
                }
            }
            removed
        };
        self.publish();
        if removed {
            let _ = self.flush_settings().await;
        }
        removed
    }

    /// D2: a Screen pick changes the screen of the scene on stream
    /// (`switchSourceDeviceLive('capture', …)`'s scene half). It never
    /// leaves the scene, and a scene made for an app shows the picked
    /// screen from now on. Idle, the pick is the scene's screen at once
    /// (true when written). A recording or livestream confirms the switch
    /// first, and that commit saves it (D11,
    /// [`Studio::note_session_sources_confirmed`]): false here.
    pub async fn set_scene_on_stream_shows(&self, shows: SceneShows) -> bool {
        let now = (self.config.clock)();
        let wrote = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.scenes.switch.working_app = None;
            let owns_transport =
                inner.session.is_active() && !super::session_is_replay_only(inner.session.status());
            if owns_transport {
                false
            } else {
                let next = inner
                    .scenes
                    .on_stream
                    .clone()
                    .and_then(|id| inner.stored_scene(&id))
                    .and_then(|scene| scene_with_shows(&scene, shows, &now));
                next.is_some_and(|scene| inner.replace_scene(&scene))
            }
        };
        self.publish();
        if wrote {
            let _ = self.flush_settings().await;
        }
        wrote
    }

    /// The session confirmed a source switch (the live sources controller's
    /// `changed`): the capture config takes the confirmed sources (only the
    /// microphone while a scene switch waits for its proof, so the next
    /// screen is never saved into the scene being left), and a changed
    /// picture is persisted, which saves a picked screen into the scene on
    /// stream (D2, D11).
    pub async fn note_session_sources_confirmed(&self, confirmed: Value) {
        let changed = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            let current = inner.capture.config.clone();
            let sources = if inner.scenes.switch.awaiting_proof.is_some() {
                merge_source_kind(&current["sources"], &confirmed, SourceKind::Microphone)
            } else {
                confirmed
            };
            if sources == current["sources"] {
                false
            } else {
                let mut next = current.clone();
                next["sources"] = sources.clone();
                let stored = capture_config::stored_capture_config(&next);
                let write = SettingWrite::Put {
                    key: keys::CAPTURE_CONFIG.to_string(),
                    value: stored.clone(),
                };
                match inner.stage_writes(&[write], &self.config.logger) {
                    Ok(()) => inner.capture.set(next, Some(stored)),
                    Err(_) => inner.capture.replace_config(next),
                }
                if visual_sources(&sources) != visual_sources(&current["sources"]) {
                    let background = inner.scenes.switch.working_background.clone();
                    let on_stream = inner.scenes.on_stream.clone();
                    inner.persist_working_visual(
                        &current["layout"],
                        &sources,
                        background.as_ref(),
                        on_stream.as_deref(),
                        &(self.config.clock)(),
                        &self.config.logger,
                    );
                }
                true
            }
        };
        if changed {
            self.publish();
            let _ = self.flush_settings().await;
        }
    }

    /// What the preview feed's idle reload (`loadScene`) reads before its
    /// request.
    pub fn scene_reload_mark(&self) -> ReloadMark {
        let inner = self.lock();
        ReloadMark {
            scene_id: inner.scenes.on_stream.clone(),
            intent: inner.scenes.switch.intent_id,
        }
    }

    /// `loadScene`'s `persistWorkingVisual`: the reload committed the
    /// capture config's scene (`layout` and `sources` as sent, the
    /// committed `background`), which is the confirmed working setup. A
    /// reload a key or switch overtook saves nothing: its old source is not
    /// a screen pick made in the new scene (D2, D11). True when persisted.
    pub async fn note_scene_reloaded(
        &self,
        mark: ReloadMark,
        layout: &Value,
        sources: &Value,
        background: Option<Value>,
    ) -> bool {
        {
            let mut guard = self.lock();
            let inner = &mut *guard;
            if inner.scenes.state.is_none()
                || inner.scenes.on_stream != mark.scene_id
                || inner.scenes.switch.intent_id != mark.intent
            {
                return false;
            }
            inner.persist_working_visual(
                layout,
                sources,
                background.as_ref(),
                mark.scene_id.as_deref(),
                &(self.config.clock)(),
                &self.config.logger,
            );
        }
        self.publish();
        let _ = self.flush_settings().await;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleting_a_scene_releases_only_its_key() {
        // `scene-shortcut-walk.test.ts`: renaming never changes an id's
        // binding; deletion releases it.
        let config = json!({"recordToggle": "Control+Alt+R", "scenes": {"a": "F1", "b": "F2"}});
        assert_eq!(
            without_scene_shortcut(Some(&config), "a"),
            json!({"recordToggle": "Control+Alt+R", "scenes": {"b": "F2"}})
        );
        assert_eq!(
            without_scene_shortcut(None, "a"),
            json!({"scenes": {}}),
            "no keys yet is an empty scene map"
        );
    }

    #[test]
    fn a_superseded_reload_is_never_news_and_tries_again_with_backoff() {
        // `layout-transaction-policy.test.ts`.
        let error = |code: &str| RpcError::new("scene.load_from_capture_config", code, "x");
        assert!(is_scene_reload_superseded(&error(
            "scene-reload-superseded"
        )));
        assert!(!is_scene_reload_superseded(&error("scene-commit-failed")));
        let delays: Vec<u64> = [0, 1, 2, 3, 4, 5, 40]
            .into_iter()
            .map(|attempt| scene_reload_retry_delay(attempt).as_millis() as u64)
            .collect();
        assert_eq!(delays, [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    }

    #[test]
    fn the_pending_mark_names_the_preset_or_freeform() {
        // `layout-switch-pending.test.ts`.
        let preset = LayoutTarget::of(&json!({"layoutPreset": "camera-only"}));
        assert_eq!(preset.evidence(), "camera-only");
        let freeform = LayoutTarget::of(
            &json!({"layoutPreset": "screen-camera", "arrangementMode": "freeform"}),
        );
        assert!(freeform.freeform);
        assert_eq!(freeform.evidence(), "freeform");
    }

    #[test]
    fn the_chosen_cameras_look_replaces_the_layouts() {
        let mut studio = StudioSettings::default();
        studio.set(
            "cameraLooks",
            json!({"cam-1": {"brightness": 0.2, "contrast": 1.1, "saturation": 0.9}}),
        );
        let layout = json!({"layoutPreset": "camera-only", "cameraLook": {"brightness": -0.5}});
        let looked = camera_look_on_layout(&layout, Some("cam-1"), &studio);
        assert_eq!(looked["cameraLook"]["brightness"], 0.2);
        let other = camera_look_on_layout(&layout, Some("cam-2"), &studio);
        assert!(other.get("cameraLook").is_none(), "no look for that camera");
        assert!(
            camera_look_on_layout(&layout, None, &studio)
                .get("cameraLook")
                .is_none()
        );
    }

    fn armed_config() -> Value {
        json!({
            "streamEnabled": true,
            "layout": {"layoutPreset": "camera-only"},
            "sources": {"screenId": "screen:1", "cameraId": "cam"},
            "streaming": {
                "enabled": true,
                "enabledTargetIds": ["tiktok"],
                "targets": [{"id": "tiktok", "enabled": true, "outputOrientation": "vertical"}]
            }
        })
    }

    fn scene_with_vertical(vertical: &str) -> Scene {
        Scene {
            id: "s".into(),
            name: "S".into(),
            created_at: String::new(),
            updated_at: String::new(),
            shows: SceneShows::Display {
                screen_id: "screen:1".into(),
                screen_name: None,
                screen_uuid: None,
            },
            horizontal: json!({"layoutPreset": "camera-only"}),
            vertical: json!({"layoutPreset": vertical}),
            background: Value::Null,
            audio: None,
            cloud: None,
        }
    }

    #[test]
    fn the_vertical_leg_needs_the_screen_a_camera_program_does_not_draw() {
        let config = armed_config();
        let layout = json!({"layoutPreset": "camera-only"});
        let sources = config["sources"].clone();
        let split = scene_with_vertical("vertical-camera-top");
        let input = |scene: Option<&Scene>, live: bool, running: bool| {
            transaction_screen_flags(&ScreenFlagsInput {
                live_method: live,
                session_active: live,
                layout: &layout,
                sources: &sources,
                config: &config,
                leg_scene: scene,
                screen_capture_running: running,
            })
        };
        assert_eq!(
            input(Some(&split), true, false),
            ScreenFlags {
                vertical_leg_screen: true,
                retain_screen: false
            }
        );
        // Off air there is no leg: the capture of the same target is kept.
        assert_eq!(
            input(Some(&split), false, true),
            ScreenFlags {
                vertical_leg_screen: false,
                retain_screen: true
            }
        );
        // A 9:16 layout without a screen draws none on the leg.
        let camera = scene_with_vertical("vertical-camera-only");
        assert_eq!(input(Some(&camera), true, false), ScreenFlags::default());
        assert_eq!(
            input(Some(&camera), true, true),
            ScreenFlags {
                vertical_leg_screen: false,
                retain_screen: true
            }
        );
        // Nothing runs: nothing to keep.
        assert_eq!(input(None, false, false), ScreenFlags::default());
    }

    #[test]
    fn a_program_that_draws_a_screen_or_another_target_keeps_nothing() {
        let config = armed_config();
        let screen_layout = json!({"layoutPreset": "screen-camera"});
        let flags = transaction_screen_flags(&ScreenFlagsInput {
            live_method: true,
            session_active: true,
            layout: &screen_layout,
            sources: &config["sources"],
            config: &config,
            leg_scene: Some(&scene_with_vertical("vertical-camera-top")),
            screen_capture_running: true,
        });
        assert_eq!(flags, ScreenFlags::default());
        let camera_layout = json!({"layoutPreset": "camera-only"});
        let other = json!({"screenId": "screen:2"});
        let flags = transaction_screen_flags(&ScreenFlagsInput {
            live_method: false,
            session_active: false,
            layout: &camera_layout,
            sources: &other,
            config: &config,
            leg_scene: None,
            screen_capture_running: true,
        });
        assert!(
            !flags.retain_screen,
            "a kept capture is never another screen"
        );
        // Screen picker Off keeps the backend's retirement path.
        let off = json!({"screenId": "screen:1", "captureOff": true});
        let flags = transaction_screen_flags(&ScreenFlagsInput {
            live_method: false,
            session_active: false,
            layout: &camera_layout,
            sources: &off,
            config: &config,
            leg_scene: None,
            screen_capture_running: true,
        });
        assert_eq!(flags, ScreenFlags::default());
    }
}
