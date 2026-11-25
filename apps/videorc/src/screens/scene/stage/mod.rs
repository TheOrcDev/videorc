//! The Scene page's stage (plan 260 Phase 3, L1 batch B; `scene-stage.tsx`,
//! `stage-gesture.ts`, `overlay-stage.ts`): the canvas's sources, overlay
//! items and banners, the one selection with its frame and handles, and the
//! gestures that move, resize and crop them (P516–P528).
//!
//! Every rule is the core's (`editor::stage`): the ghosts, the magnets, the
//! clamps, the hit test, the commit queue ([`StageEdits`]) and the draft's
//! wire ([`DraftChannel`]). This module owns what the DOM did in Electron:
//! the pointer while a gesture runs, the keys on the focused stage, and
//! when a gesture is cancelled.
//!
//! The live canvas: on macOS the docked preview's native view sits under
//! the stage (`preview/macos.rs`). GPUI paints over it, so the stage draws
//! its own chrome there (the frame, the handles, the guides, the items'
//! outlines) and the drafts carry none (`hidden_chrome`); without the live
//! canvas it draws the schematic too.

mod draw;

use std::cell::Cell;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{
    Bounds, Context, FocusHandle, KeyDownEvent, Modifiers, MouseDownEvent, Pixels, Point,
    Subscription, Task, Window,
};
use serde_json::{Value, json};
use videorc_app_core::editor::inspector::{
    InspectorSelection, overlay_layout_for_display, scene_camera_controls,
    scene_position_lock_reason, source_croppable,
};
use videorc_app_core::editor::stage::{
    CameraCorner, CommitTicket, DraftChannel, DraftSend, DraftWanted, GestureKind, GestureStart,
    Ghost, HandleId, HitTarget, KeyChord, Modifiers as StageModifiers, OVERLAY_ITEMS, PictureInput,
    PixelSize, PresetCameraLayout, SelectionHit, Settled, StageCrop, StageEdits, StageGesture,
    StageHit, StageItemBadge, StageMapping, StageRect, background_stage_margin,
    banner_fills_canvas, banner_fit_rect, banner_stage_id, buddy_pet_box, clamp_overlay_rect,
    draft_params, effective_camera_mask_shape, layer_fit, output_badge, overlay_item_label,
    overlay_orientation_key, overlay_stage_id, preset_camera_corner_rect, round_crop_for_commit,
    round_rect_for_commit, same_stage_rect, scene_camera_on_stage, scene_frame_rect,
    scene_picture_rect, screen_box_is_picture, snap_corner_of, stage_crop_of, stage_handle_offset,
    stage_hit, stage_nudge_for_key, stage_pixel_size, stage_point, stage_snap_targets,
    visible_stage_handles,
};
use videorc_app_core::livestream::plan;
use videorc_app_core::studio::Connection;
use videorc_app_core::studio::scene_editor::commit_outcome;
use videorc_app_core::studio::transport::transport_active;
use videorc_protocol::{Banner, SceneSource, SceneSourceKind};

use super::ScenePage;

pub(super) use videorc_app_core::editor::stage::StagePhase;

/// The handle gutter around the canvas, in points (`p-7`).
const GUTTER: f32 = 28.0;
/// A corner drop shows its box this long at most before the preset's scene
/// does (`CORNER_DROP_HOLD_MS`).
const CORNER_DROP_HOLD: Duration = Duration::from_millis(2000);
/// How close the scene's camera must be to the dropped box (canvas units).
const CORNER_DROP_MATCH: f64 = 0.002;
/// Pointer travel that counts as a move (`moved`, CSS px).
const MOVED_PX: f32 = 0.01;

/// What the footer reads (P534, P538, P539), computed each render.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) struct StageFacts {
    /// `dragEnabled` (`layout-tab.tsx` 1008-1014).
    pub drag_enabled: bool,
    /// `overlays.editable`.
    pub overlays_editable: bool,
    /// The arrows nudge the selected source.
    pub nudge: bool,
    /// Freeform: the Snap toggle; a preset: always.
    pub effective_snap: bool,
    /// ⌥ crops an edge of a source on the canvas.
    pub crop_hint: bool,
    /// The layout is Freeform (the Snap toggle shows).
    pub freeform: bool,
}

/// What an entry on the stage stands for.
#[derive(Debug, Clone, PartialEq)]
enum Target {
    Source(Box<SceneSource>),
    Overlay(&'static str),
    Banner(String),
}

/// One thing on the stage as it shows now (its ghost, its landing draft or
/// its committed place).
#[derive(Debug, Clone)]
struct Entry {
    /// The stage id: a source's id, `overlay:<item>` or `banner:<id>`.
    id: String,
    label: String,
    rect: StageRect,
    target: Target,
    /// The schematic's raw badge word (items only).
    badge: Option<StageItemBadge>,
    /// Drawn dimmed: a hidden source, an item no output shows, a hidden
    /// banner.
    off: bool,
    /// A gesture may take it.
    editable: bool,
    /// A resize keeps its aspect whatever Shift says (a banner).
    aspect_locked: bool,
    /// Unselected, its whole rect takes the pointer (not only its chip).
    grabs_body: bool,
    /// The item itself on the schematic (`StageItemPicture`): a banner's
    /// image, the avatar's still in its pet's square.
    picture: Option<ItemPicture>,
}

/// An item's picture file.
#[derive(Debug, Clone, PartialEq)]
enum PictureFile {
    File(PathBuf),
    /// The stone golem, the avatar with no picture of its own.
    Golem,
}

/// `StageItemPicture`: what is drawn, how it fits, and at what opacity.
#[derive(Debug, Clone, PartialEq)]
struct ItemPicture {
    file: PictureFile,
    /// The avatar: drawn in the square its pet fills (`buddyPetBox`), else
    /// the item's own rect (a banner's rect is its image).
    buddy: bool,
    /// 0 to 1: a banner's own opacity.
    opacity: f32,
}

impl Entry {
    /// Where the picture sits for the rect the stage shows now
    /// (`stageItemPictureRect`).
    fn picture_rect(&self, canvas_aspect: f64) -> Option<StageRect> {
        let picture = self.picture.as_ref()?;
        Some(if picture.buddy {
            buddy_pet_box(self.rect, canvas_aspect)
        } else {
            self.rect
        })
    }
}

/// `isBannerFileName`: a bare basename, never a path.
fn banner_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.starts_with('.')
        && !value.contains(['/', '\\', '\0'])
        && !value.contains("..")
}

impl Entry {
    fn source(&self) -> Option<&SceneSource> {
        match &self.target {
            Target::Source(source) => Some(source),
            _ => None,
        }
    }

    fn item(&self) -> bool {
        !matches!(self.target, Target::Source(_))
    }
}

/// How a source's frame maps to the picture the stage shows (plan 216 B3),
/// and the preset's camera box for a corner drop.
#[derive(Debug, Clone)]
struct Geometry {
    layout: Value,
    stage_margin: f64,
    camera_on_stage: bool,
    /// The output canvas in pixels.
    canvas: PixelSize,
}

impl Geometry {
    /// `pictureOf`: where the compositor draws `source` for `frame`.
    fn picture_of(
        &self,
        source: &SceneSource,
        frame: StageRect,
        crop: Option<StageCrop>,
    ) -> StageRect {
        scene_picture_rect(PictureInput {
            frame,
            kind: &source.kind,
            fit: layer_fit(&source.kind, &self.layout),
            source: None,
            crop: crop.unwrap_or_else(|| stage_crop_of(&source.transform)),
            stage_margin: self.stage_margin,
            camera_on_stage: self.camera_on_stage,
            canvas: self.canvas,
        })
    }

    /// `frameOf`: a picture back to the frame that shows it.
    fn frame_of(&self, source: &SceneSource, picture: StageRect) -> StageRect {
        scene_frame_rect(
            picture,
            &source.kind,
            self.stage_margin,
            self.camera_on_stage,
        )
    }

    /// `cornerDropRect`: the preset's camera box at `corner`.
    fn corner_box(&self, corner: CameraCorner) -> StageRect {
        preset_camera_corner_rect(
            &PresetCameraLayout::of(&self.layout),
            corner,
            self.canvas.width,
            self.canvas.height,
        )
    }
}

/// The stage as one snapshot and the page's state show it.
#[derive(Debug, Clone)]
struct StageView {
    /// Draw order: sources, banners, then overlay items (D5).
    entries: Vec<Entry>,
    selected: Option<String>,
    drag_enabled: bool,
    resize_enabled: bool,
    crop_enabled: bool,
    overlays_editable: bool,
    freeform: bool,
    position_locked: bool,
    /// The camera's mask on the schematic.
    camera_shape: String,
    corner_radius_pct: f64,
    /// A shaped camera's aspect is law (`cameraAspectLocked`).
    camera_aspect_locked: bool,
    geometry: Geometry,
}

impl StageView {
    fn entry(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.id == id)
    }

    fn selected_entry(&self) -> Option<&Entry> {
        self.selected.as_deref().and_then(|id| self.entry(id))
    }

    /// The selection's handles: where they show and take the pointer.
    fn handles(&self, entry: &Entry, canvas: PixelSize) -> Vec<HandleId> {
        let shown = if entry.item() {
            self.overlays_editable
        } else {
            self.resize_enabled && entry.editable
        };
        if !shown {
            return Vec::new();
        }
        visible_stage_handles(
            entry.rect.width * canvas.width,
            entry.rect.height * canvas.height,
        )
        .to_vec()
    }

    fn facts(&self, snap_on: bool) -> StageFacts {
        let nudge = self.drag_enabled
            && self
                .selected_entry()
                .is_some_and(|entry| !entry.item() && entry.editable);
        StageFacts {
            drag_enabled: self.drag_enabled,
            overlays_editable: self.overlays_editable,
            nudge,
            effective_snap: !self.freeform || snap_on,
            crop_hint: self.crop_enabled
                && self.resize_enabled
                && self.entries.iter().any(|entry| {
                    entry.editable && entry.source().is_some_and(|s| source_croppable(&s.kind))
                }),
            freeform: self.freeform,
        }
    }
}

/// A gesture in progress (`ActiveGesture`): one pointer ownership interval.
#[derive(Debug, Clone)]
struct Active {
    motion: StageGesture,
    /// The canvas's place in the window, frozen at the press.
    mapping: StageMapping,
    /// Where the layer was: a scroll or a resize moves it and cancels.
    layer: Bounds<Pixels>,
    initial: StageRect,
    start: Point<Pixels>,
    moved: bool,
    target: Target,
    geometry: Geometry,
    /// A preset scene's move: a drop in a corner re-enters the preset there.
    corner_snap: bool,
    corner: Option<CameraCorner>,
    ghost: Ghost,
}

/// A corner drop shown until the preset's scene puts the camera there.
#[derive(Debug, Clone)]
struct CornerDrop {
    source_id: String,
    /// The preset's box (a frame).
    rect: StageRect,
    at: Instant,
}

pub(super) struct Stage {
    gesture: Option<Active>,
    edits: StageEdits,
    commits: VecDeque<CommitTicket>,
    committing: bool,
    /// Released overlay item and banner rects, shown until their save lands.
    item_drafts: Vec<(String, StageRect)>,
    corner_drop: Option<CornerDrop>,
    _corner_timer: Option<Task<()>>,
    channel: DraftChannel,
    _draft_timer: Option<Task<()>>,
    freeform_hint: bool,
    /// The docked preview's picture is under the stage (drawn last).
    live: bool,
    snap: bool,
    facts: StageFacts,
    /// A precise edit lands (`externalPending`).
    external_pending: bool,
    identity: Option<String>,
    focus: Option<FocusHandle>,
    /// The layer's bounds in the window, as last laid out.
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    _subscriptions: Vec<Subscription>,
}

impl Stage {
    pub(super) fn new() -> Self {
        Self {
            gesture: None,
            edits: StageEdits::default(),
            commits: VecDeque::new(),
            committing: false,
            item_drafts: Vec::new(),
            corner_drop: None,
            _corner_timer: None,
            channel: DraftChannel::default(),
            _draft_timer: None,
            freeform_hint: false,
            live: false,
            snap: false,
            facts: StageFacts::default(),
            external_pending: false,
            identity: None,
            focus: None,
            bounds: Rc::new(Cell::new(None)),
            _subscriptions: Vec::new(),
        }
    }

    /// `dragging` while a gesture runs; `pending` while a release, a corner
    /// drop, an item's save or a precise edit lands; else `idle`.
    pub(super) fn phase(&self) -> StagePhase {
        if self.gesture.is_some() {
            StagePhase::Dragging
        } else if self.edits.draft.is_some()
            || self.corner_drop.is_some()
            || !self.item_drafts.is_empty()
            || self.external_pending
        {
            StagePhase::Pending
        } else {
            StagePhase::Idle
        }
    }

    pub(super) fn facts(&self) -> StageFacts {
        self.facts
    }

    /// P538: a refused grab on an unlocked source in a preset scene.
    pub(super) fn freeform_hint(&self) -> bool {
        self.freeform_hint
    }

    /// P539: the Snap toggle, off until turned on (per page, not saved).
    pub(super) fn snap_on(&self) -> bool {
        self.snap
    }

    pub(super) fn set_snap(&mut self, on: bool) {
        self.snap = on;
    }

    /// The canvas box in the window: the layer less its gutter.
    fn canvas_box(&self) -> Option<(Bounds<Pixels>, Bounds<Pixels>)> {
        let layer = self.bounds.get()?;
        let gutter = gpui::px(GUTTER);
        let width = layer.size.width - gutter * 2.0;
        let height = layer.size.height - gutter * 2.0;
        if width <= gpui::px(0.) || height <= gpui::px(0.) {
            return None;
        }
        let canvas = Bounds {
            origin: gpui::point(layer.origin.x + gutter, layer.origin.y + gutter),
            size: gpui::size(width, height),
        };
        Some((layer, canvas))
    }

    /// The canvas's painted size in points.
    fn canvas_pixels(&self) -> Option<PixelSize> {
        self.canvas_box().map(|(_, canvas)| PixelSize {
            width: f64::from(canvas.size.width),
            height: f64::from(canvas.size.height),
        })
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// An `overlays.layout` rect (`{x, y, w, h}`) on the stage.
fn overlay_rect(value: &Value) -> StageRect {
    let number = |key: &str| value.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    StageRect::new(number("x"), number("y"), number("w"), number("h"))
}

/// `overlayItemOff`, then the one output that alone shows it.
fn item_badge(on_stream: bool, in_recording: bool) -> (Option<StageItemBadge>, bool) {
    if !on_stream && !in_recording {
        (Some(StageItemBadge::Off), true)
    } else {
        (output_badge(on_stream, in_recording), false)
    }
}

impl ScenePage {
    /// The stage from the latest snapshot and the page's state; it also
    /// settles what the scene shows (a landed commit, a corner drop) and
    /// drops a gesture whose scene changed under it.
    fn stage_view(&mut self, cx: &mut Context<Self>) -> StageView {
        let snapshot = self.studio.snapshot();
        let capture = &snapshot.settings.capture_doc;
        let layout = capture["layout"].clone();
        let recording = plan::recording_video(capture);
        let canvas = PixelSize {
            width: f64::from(recording.width.max(1)),
            height: f64::from(recording.height.max(1)),
        };
        let vertical_view = self.editor.overlays_on == Some(true);
        let scene = snapshot.sources.scene.as_ref();
        let sources: Vec<SceneSource> = if vertical_view {
            Vec::new()
        } else {
            scene.map(|scene| scene.sources.clone()).unwrap_or_default()
        };
        let background = scene
            .and_then(|scene| scene.background.as_ref())
            .and_then(|background| serde_json::to_value(background).ok());
        let kinds: Vec<SceneSourceKind> = sources.iter().map(|s| s.kind.clone()).collect();
        let geometry = Geometry {
            stage_margin: background_stage_margin(background.as_ref()),
            camera_on_stage: scene_camera_on_stage(&kinds, &layout),
            canvas,
            layout: layout.clone(),
        };
        let connected = matches!(snapshot.connection, Connection::Connected { .. });
        let session_active = transport_active(&snapshot.session);
        let position_locked = scene_position_lock_reason(
            session_active,
            snapshot.session.status.accepts_live_scene_edits,
        )
        .is_some();
        let controls = scene_camera_controls(&layout);
        let freeform = controls.freeform;
        let precise_pending = self.editor_state.precise_pending;
        let switch_pending =
            snapshot.scenes.pending_layout.is_some() || snapshot.scenes.pending_scene_id.is_some();
        let drag_enabled = !vertical_view
            && (controls.inset || freeform)
            && !position_locked
            && !precise_pending
            && !switch_pending;
        let resize_enabled = drag_enabled;
        let crop_enabled = freeform && !position_locked;
        let overlays_editable = connected && !precise_pending && !switch_pending;
        let camera_shape = effective_camera_mask_shape(&layout);
        let camera_aspect_locked =
            camera_shape == "circle" || text(&layout, "cameraAspect") != "source";
        let corner_radius_pct = layout
            .get("cameraCornerRadiusPct")
            .and_then(Value::as_f64)
            .unwrap_or(12.0);
        let orientation = overlay_orientation_key(self.editor.vertical_overlays);

        // A landed commit's draft goes once the scene shows it; a corner
        // drop once the camera is at its box, or after its hold.
        if let Some(scene) = scene {
            self.stage.edits.observe(Some(commit_outcome(true, scene)));
            if let Some(drop) = &self.stage.corner_drop {
                let landed = scene.sources.iter().any(|source| {
                    source.id == drop.source_id && {
                        let at = StageRect::of(&source.transform);
                        (at.x - drop.rect.x).abs() <= CORNER_DROP_MATCH
                            && (at.y - drop.rect.y).abs() <= CORNER_DROP_MATCH
                            && (at.width - drop.rect.width).abs() <= CORNER_DROP_MATCH
                            && (at.height - drop.rect.height).abs() <= CORNER_DROP_MATCH
                    }
                });
                if landed || drop.at.elapsed() >= CORNER_DROP_HOLD {
                    self.stage.corner_drop = None;
                    self.stage._corner_timer = None;
                }
            }
        }

        // `editable(source)`: unlocked, and Freeform or a box that isn't
        // the whole canvas.
        let editable = |source: &SceneSource| {
            !source.locked
                && (freeform || source.transform.width < 1.0 || source.transform.height < 1.0)
        };
        let ghost = self
            .stage
            .gesture
            .as_ref()
            .map(|active| (active.motion.source_id.clone(), active.ghost.rect));
        let ghost_of = |id: &str| {
            ghost
                .as_ref()
                .filter(|(ghost_id, _)| ghost_id == id)
                .map(|(_, rect)| *rect)
        };
        let mut entries = Vec::new();
        for source in &sources {
            let rect = ghost_of(&source.id).unwrap_or_else(|| {
                match (&self.stage.edits.draft, &self.stage.corner_drop) {
                    (Some(draft), _) if draft.source_id == source.id => {
                        geometry.picture_of(source, draft.rect, draft.crop)
                    }
                    (_, Some(drop)) if drop.source_id == source.id => {
                        geometry.picture_of(source, drop.rect, None)
                    }
                    _ => geometry.picture_of(source, StageRect::of(&source.transform), None),
                }
            });
            entries.push(Entry {
                id: source.id.clone(),
                label: source.name.clone(),
                rect,
                target: Target::Source(Box::new(source.clone())),
                badge: None,
                off: !source.visible,
                editable: editable(source),
                aspect_locked: false,
                grabs_body: true,
                picture: None,
            });
        }
        let item_rect = |id: &str, place: StageRect| {
            ghost_of(id).unwrap_or_else(|| {
                self.stage
                    .item_drafts
                    .iter()
                    .find(|(draft_id, _)| draft_id == id)
                    .map_or(place, |(_, rect)| *rect)
            })
        };
        // Banners first (under the overlay items): the shown ones and the
        // selected one, Images order; the rect is the image's own inside
        // its place.
        let selected_banner = match &self.editor.selection {
            InspectorSelection::Banner(id) => Some(id.clone()),
            _ => None,
        };
        let vertical = orientation == "vertical";
        for banner in self
            .editor_state
            .banners
            .iter()
            .filter(|banner| banner.shown || selected_banner.as_deref() == Some(&banner.id))
        {
            let place = banner_place(banner, vertical);
            let fit = banner_fit_rect(
                (f64::from(banner.width), f64::from(banner.height)),
                place,
                self.editor.canvas_aspect,
                vertical,
            );
            let id = banner_stage_id(&banner.id);
            let (badge, off) = if banner.shown {
                item_badge(banner.show_on_stream, banner.show_in_recording)
            } else {
                (Some(StageItemBadge::Hidden), true)
            };
            entries.push(Entry {
                rect: item_rect(&id, fit),
                id,
                label: banner.name.clone(),
                target: Target::Banner(banner.id.clone()),
                badge,
                off,
                editable: overlays_editable,
                aspect_locked: true,
                grabs_body: !banner_fills_canvas(fit),
                // The full image, not the thumbnail: a strip may span the
                // canvas (`<userData>/Banners/<imageFile>`).
                picture: banner_file_name(&banner.image_file).then(|| ItemPicture {
                    file: PictureFile::File(
                        self.user_data_dir.join("Banners").join(&banner.image_file),
                    ),
                    buddy: false,
                    opacity: banner.opacity.clamp(0.0, 1.0) as f32,
                }),
            });
        }
        if let Some(saved) = &self.editor_state.overlay_layout {
            let shown = overlay_layout_for_display(saved, capture.get("captions"));
            for item in OVERLAY_ITEMS {
                let entry = &shown[item];
                let flag = |key: &str| entry.get(key).and_then(Value::as_bool) == Some(true);
                let (badge, off) = item_badge(flag("showOnStream"), flag("showInRecording"));
                let id = overlay_stage_id(item);
                entries.push(Entry {
                    rect: item_rect(&id, overlay_rect(&entry[orientation])),
                    id,
                    label: overlay_item_label(item).to_string(),
                    target: Target::Overlay(item),
                    badge,
                    off,
                    editable: overlays_editable,
                    aspect_locked: false,
                    grabs_body: false,
                    // The highlight card and the caption bar have no picture
                    // until a comment or a caption exists: their zone is the
                    // truth.
                    picture: (item == "buddy").then(|| ItemPicture {
                        file: self
                            .avatar_picture
                            .clone()
                            .map_or(PictureFile::Golem, PictureFile::File),
                        buddy: true,
                        opacity: 1.0,
                    }),
                });
            }
        }

        // `SceneStage`'s invalidation (SS:519-534): a new scene, other
        // sources, or other editing rules drop the gesture, the landing
        // commit and the Make freeform hint.
        let identity = format!(
            "{}|{}|{drag_enabled}|{resize_enabled}|{freeform}|{:.6}|{camera_shape}|{camera_aspect_locked}",
            scene.map(|scene| scene.id.as_str()).unwrap_or_default(),
            sources
                .iter()
                .map(|source| format!(
                    "{}:{:?}:{}:{}:{}",
                    source.id,
                    source.kind,
                    source.device_id.as_deref().unwrap_or_default(),
                    source.locked,
                    source.visible
                ))
                .collect::<Vec<_>>()
                .join(","),
            canvas.width / canvas.height,
        );
        if self
            .stage
            .identity
            .as_ref()
            .is_some_and(|previous| *previous != identity)
        {
            self.stage.edits.invalidate();
            self.stage.commits.clear();
            self.stage.freeform_hint = false;
            if self.stage.gesture.is_some() {
                self.drop_gesture(cx);
            }
        }
        self.stage.identity = Some(identity);
        self.stage.external_pending = precise_pending;
        // Drafts are refused while a session runs: only the outline moves.
        let drafts_enabled = !session_active;
        if self.stage.channel.enabled != drafts_enabled {
            self.stage.channel.enabled = drafts_enabled;
            self.pump_drafts(cx);
        }

        StageView {
            entries,
            selected: self.editor.selected_stage_id.clone(),
            drag_enabled,
            resize_enabled,
            crop_enabled,
            overlays_editable,
            freeform,
            position_locked,
            camera_shape,
            corner_radius_pct,
            camera_aspect_locked,
            geometry,
        }
    }

    /// Cancels a running gesture (a toolbar chip, the page leaving, Esc, a
    /// blur, a resize, a scroll): the ghost and the live draft go, nothing
    /// is committed.
    pub(super) fn cancel_stage_gesture(&mut self, cx: &mut Context<Self>) {
        if self.stage.gesture.is_some() {
            self.drop_gesture(cx);
            cx.notify();
        }
    }

    fn drop_gesture(&mut self, cx: &mut Context<Self>) {
        self.stage.gesture = None;
        self.stage.channel.want(DraftWanted::None);
        self.pump_drafts(cx);
    }

    /// The stage's focus, and the window events that cancel a gesture,
    /// made once the stage first draws.
    fn ensure_stage_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) -> FocusHandle {
        if let Some(focus) = &self.stage.focus {
            return focus.clone();
        }
        let focus = cx.focus_handle();
        self.stage.focus = Some(focus.clone());
        let blur = cx.observe_window_activation(window, |page, window, cx| {
            if !window.is_window_active() {
                page.cancel_stage_gesture(cx);
            }
        });
        let resize = cx.observe_window_bounds(window, |page, _, cx| {
            page.cancel_stage_gesture(cx);
        });
        self.stage._subscriptions.push(blur);
        self.stage._subscriptions.push(resize);
        focus
    }

    /// The stage layer (P516–P528): placed by the canvas section over the
    /// canvas box with [`GUTTER`] of gutter on every side. `live`: the
    /// docked preview's native view is under the box, so only the chrome
    /// is drawn (no schematic fills).
    pub(super) fn stage_layer(
        &mut self,
        live: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        self.draw_stage(live, window, cx)
    }

    // --- the pointer ---

    /// A press on the stage (`onPointerDown` of a source, an item or a
    /// handle): select, then grab when it may.
    fn stage_press(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(focus) = self.stage.focus.clone() {
            window.focus(&focus, cx);
        }
        if self.stage.gesture.is_some() || self.editor_state.precise_pending {
            return;
        }
        let Some((layer, canvas_box)) = self.stage.canvas_box() else {
            return;
        };
        let view = self.stage_view(cx);
        let canvas = PixelSize {
            width: f64::from(canvas_box.size.width),
            height: f64::from(canvas_box.size.height),
        };
        let local = (
            f64::from(event.position.x - canvas_box.origin.x),
            f64::from(event.position.y - canvas_box.origin.y),
        );
        let selection = view.selected_entry().map(|entry| SelectionHit {
            rect: entry.rect,
            handles: view.handles(entry, canvas),
            offset: stage_handle_offset(
                entry.rect.width * canvas.width,
                entry.rect.height * canvas.height,
            ),
        });
        let targets: Vec<HitTarget> = view
            .entries
            .iter()
            .map(|entry| HitTarget {
                id: entry.id.clone(),
                rect: entry.rect,
                item: entry.item(),
                body: entry.grabs_body,
                // The avatar's picture takes the pointer where it is drawn
                // (on the schematic, while an output shows it).
                picture: (matches!(entry.target, Target::Overlay(_))
                    && !entry.off
                    && !self.stage.live)
                    .then(|| entry.picture_rect(self.editor.canvas_aspect))
                    .flatten(),
            })
            .collect();
        let hit = stage_hit(
            local,
            canvas,
            selection.as_ref(),
            view.selected.as_deref(),
            &targets,
        );
        let (entry, kind) = match hit {
            Some(StageHit::Handle(handle)) => match view.selected_entry() {
                Some(entry) => (entry.clone(), GestureKind::Handle(handle)),
                None => return,
            },
            Some(StageHit::Target(id)) => match view.entry(&id) {
                Some(entry) => (entry.clone(), GestureKind::Move),
                None => return,
            },
            None => return,
        };
        let mapping = StageMapping::of_rect(
            f64::from(canvas_box.origin.x),
            f64::from(canvas_box.origin.y),
            canvas.width,
            canvas.height,
        );
        match &entry.target {
            Target::Source(source) => {
                if self
                    .stage
                    .edits
                    .draft
                    .as_ref()
                    .is_some_and(|draft| draft.source_id != source.id)
                {
                    return;
                }
                if source.transform.width <= 0.0 || source.transform.height <= 0.0 {
                    return;
                }
                self.select_on_stage(InspectorSelection::Source(source.id.clone()), cx);
                let allowed = match kind {
                    GestureKind::Move => view.drag_enabled,
                    GestureKind::Handle(_) => view.resize_enabled,
                };
                if !allowed || !entry.editable {
                    // `onRequestFreeform`: a preset scene, editable now.
                    if !source.locked && !view.freeform && !view.position_locked {
                        self.stage.freeform_hint = true;
                        cx.notify();
                    }
                    return;
                }
            }
            Target::Overlay(item) => {
                self.select_on_stage(InspectorSelection::Overlay(*item), cx);
                if !view.overlays_editable {
                    return;
                }
            }
            Target::Banner(id) => {
                self.select_on_stage(InspectorSelection::Banner(id.clone()), cx);
                if !view.overlays_editable {
                    return;
                }
            }
        }
        self.begin_gesture(&view, &entry, kind, mapping, layer, event, cx);
    }

    /// The one selection: a source also opens the scene editor.
    fn select_on_stage(&mut self, selection: InspectorSelection, cx: &mut Context<Self>) {
        if let InspectorSelection::Source(_) = selection {
            self.studio.set_scene_edit_mode(true);
        }
        self.editor_state.selection = Some(selection);
        self.refresh_editor(cx);
    }

    #[allow(clippy::too_many_arguments)]
    fn begin_gesture(
        &mut self,
        view: &StageView,
        entry: &Entry,
        kind: GestureKind,
        mapping: StageMapping,
        layer: Bounds<Pixels>,
        event: &MouseDownEvent,
        cx: &mut Context<Self>,
    ) {
        let Some(point) = stage_point(
            mapping,
            f64::from(event.position.x),
            f64::from(event.position.y),
        ) else {
            return;
        };
        let snap = !view.freeform || self.stage.snap;
        let (targets, locked, forced, crop) = match &entry.target {
            Target::Source(source) => {
                let others: Vec<StageRect> = view
                    .entries
                    .iter()
                    .filter(|other| !other.item() && other.id != entry.id)
                    .map(|other| other.rect)
                    .collect();
                let locked = self
                    .editor_state
                    .aspect_locks
                    .get(&source.id)
                    .copied()
                    .unwrap_or(true);
                let box_is_picture = view.freeform
                    && screen_box_is_picture(
                        &source.kind,
                        layer_fit(&source.kind, &view.geometry.layout),
                        None,
                    );
                let forced = (source.kind == SceneSourceKind::Camera && view.camera_aspect_locked)
                    || box_is_picture;
                // ⌥ down on an edge of a screen crops it, from the crop the
                // stage shows now.
                let crop = (matches!(kind, GestureKind::Handle(_))
                    && event.modifiers.alt
                    && view.crop_enabled
                    && source_croppable(&source.kind))
                .then(|| {
                    self.stage
                        .edits
                        .draft
                        .as_ref()
                        .filter(|draft| draft.source_id == source.id)
                        .and_then(|draft| draft.crop)
                        .unwrap_or_else(|| stage_crop_of(&source.transform))
                });
                (stage_snap_targets(&others), locked, forced, crop)
            }
            target => {
                // An overlay item snaps to the sources and every other item;
                // a banner to the sources and the other banners
                // (`stageItemSnapPeers`).
                let banner = matches!(target, Target::Banner(_));
                let others: Vec<StageRect> = view
                    .entries
                    .iter()
                    .filter(|other| other.id != entry.id)
                    .filter(|other| match other.target {
                        Target::Source(_) => true,
                        Target::Banner(_) => true,
                        Target::Overlay(_) => !banner,
                    })
                    .map(|other| other.rect)
                    .collect();
                (
                    stage_snap_targets(&others),
                    entry.aspect_locked,
                    entry.aspect_locked,
                    None,
                )
            }
        };
        let mut motion = StageGesture::new(GestureStart {
            source_id: entry.id.clone(),
            kind,
            start: entry.rect,
            point,
            pixels: stage_pixel_size(mapping),
            targets,
            snap,
            locked,
            forced,
            crop,
        });
        let modifiers = stage_modifiers(event.modifiers);
        // The first sample takes the keys without moving the grab.
        motion.sample(point, modifiers);
        let active = Active {
            motion,
            mapping,
            layer,
            initial: entry.rect,
            start: event.position,
            moved: false,
            target: entry.target.clone(),
            geometry: view.geometry.clone(),
            corner_snap: !entry.item() && kind == GestureKind::Move && !view.freeform,
            corner: None,
            ghost: Ghost {
                rect: entry.rect,
                guides: Vec::new(),
            },
        };
        let params = draft_of(&active);
        self.stage.gesture = Some(active);
        self.stage.channel.want(DraftWanted::Gesture(params));
        self.pump_drafts(cx);
        cx.notify();
    }

    /// One pointer sample while a gesture runs (`flushSample`).
    fn stage_drag(
        &mut self,
        position: Point<Pixels>,
        modifiers: Modifiers,
        pressed: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(active) = self.stage.gesture.as_ref() else {
            return;
        };
        // The button went up where the window didn't hear it, or the page
        // scrolled or resized under the gesture (`lostpointercapture`,
        // `scroll`, `resize`).
        if !pressed || self.stage.bounds.get() != Some(active.layer) {
            self.cancel_stage_gesture(cx);
            return;
        }
        if self.sample_gesture(position, modifiers).is_none() {
            self.cancel_stage_gesture(cx);
            return;
        }
        if let Some(active) = &self.stage.gesture {
            let params = draft_of(active);
            self.stage.channel.want(DraftWanted::Gesture(params));
            self.pump_drafts(cx);
        }
        cx.notify();
    }

    /// Samples the gesture at `position`; `None` when the point can't map.
    fn sample_gesture(&mut self, position: Point<Pixels>, modifiers: Modifiers) -> Option<()> {
        let active = self.stage.gesture.as_mut()?;
        let point = stage_point(active.mapping, f64::from(position.x), f64::from(position.y))?;
        let travel = position - active.start;
        if f32::from(travel.x).hypot(f32::from(travel.y)) >= MOVED_PX {
            active.moved = true;
        }
        let mut ghost = active.motion.sample(point, stage_modifiers(modifiers));
        // A preset scene's camera moved into a canvas corner re-enters the
        // preset there on release: the ghost is that box.
        active.corner = if active.corner_snap {
            snap_corner_of(active.motion.rect)
        } else {
            None
        };
        if let (Some(corner), Target::Source(source)) = (active.corner, &active.target) {
            let frame = active.geometry.corner_box(corner);
            ghost = Ghost {
                rect: active.geometry.picture_of(source, frame, None),
                guides: Vec::new(),
            };
        }
        active.ghost = ghost;
        Some(())
    }

    /// The release (`endGesture`): one commit, or nothing for a gesture
    /// that didn't change the box.
    fn stage_release(
        &mut self,
        position: Point<Pixels>,
        modifiers: Modifiers,
        cx: &mut Context<Self>,
    ) {
        if self.stage.gesture.is_none() {
            return;
        }
        if self.sample_gesture(position, modifiers).is_none() {
            self.cancel_stage_gesture(cx);
            return;
        }
        let Some(active) = self.stage.gesture.take() else {
            return;
        };
        let final_rect = active.ghost.rect;
        let changed = active.moved && !same_stage_rect(final_rect, active.initial);
        let orientation = overlay_orientation_key(self.editor.vertical_overlays);
        match &active.target {
            Target::Overlay(_) | Target::Banner(_) => {
                if changed {
                    // The released frame stays on the live picture until the
                    // save lands; the stage shows the clamped rect it saves.
                    let rect = clamp_overlay_rect(final_rect);
                    self.stage.channel.want(DraftWanted::Released(draft_params(
                        &active.motion.source_id,
                        rect,
                        None,
                    )));
                    self.stage
                        .item_drafts
                        .retain(|(id, _)| *id != active.motion.source_id);
                    self.stage
                        .item_drafts
                        .push((active.motion.source_id.clone(), rect));
                    self.commit_item(
                        &active.target,
                        &active.motion.source_id,
                        rect,
                        orientation,
                        cx,
                    );
                } else {
                    self.stage.channel.want(DraftWanted::None);
                }
            }
            Target::Source(source) => {
                let corner = if changed { active.corner } else { None };
                let crop = active.motion.crop;
                // What is committed is the FRAME: the released picture back
                // through the stage margin, or the preset's box.
                let frame = match corner {
                    Some(corner) => active.geometry.corner_box(corner),
                    None => active.geometry.frame_of(source, final_rect),
                };
                if changed {
                    self.stage.channel.want(DraftWanted::Released(draft_params(
                        &source.id,
                        round_rect_for_commit(frame),
                        crop.map(round_crop_for_commit),
                    )));
                } else {
                    self.stage.channel.want(DraftWanted::None);
                }
                if changed {
                    match corner {
                        Some(corner) => self.drop_in_corner(&source.id, frame, corner, cx),
                        None => {
                            let ticket = self.stage.edits.submit(&source.id, frame, crop);
                            self.stage.commits.push_back(ticket);
                            self.next_commit(cx);
                        }
                    }
                }
            }
        }
        self.pump_drafts(cx);
        cx.notify();
    }

    /// P523: the drop shows the preset's box until the preset's scene puts
    /// the camera there (or 2 s), then the preset takes the corner.
    fn drop_in_corner(
        &mut self,
        source_id: &str,
        frame: StageRect,
        corner: CameraCorner,
        cx: &mut Context<Self>,
    ) {
        self.stage.corner_drop = Some(CornerDrop {
            source_id: source_id.to_string(),
            rect: frame,
            at: Instant::now(),
        });
        self.stage._corner_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CORNER_DROP_HOLD).await;
            let _ = this.update(cx, |page, cx| {
                page.stage.corner_drop = None;
                cx.notify();
            });
        }));
        let studio = self.studio.clone();
        let corner = corner.as_str();
        self.run(async move {
            studio.snap_camera_corner(corner).await;
        });
    }

    /// Sends the next released source gesture (`StageEdits`: one at a time,
    /// each kept on screen until the scene shows it).
    fn next_commit(&mut self, cx: &mut Context<Self>) {
        if self.stage.committing {
            return;
        }
        while let Some(ticket) = self.stage.commits.pop_front() {
            if !self.stage.edits.current(&ticket) {
                continue;
            }
            self.stage.committing = true;
            let studio = self.studio.clone();
            let source_id = ticket.source_id.clone();
            let patch = ticket.patch();
            let answer = self
                .runtime
                .spawn(async move { studio.commit_source_transform(&source_id, patch).await });
            cx.spawn(async move |this, cx| {
                let outcome = answer.await.ok().flatten();
                let _ = this.update(cx, |page, cx| {
                    page.stage.committing = false;
                    if page.stage.edits.settle(&ticket, outcome) == Settled::Failed {
                        page.cancel_stage_gesture(cx);
                    }
                    page.next_commit(cx);
                    cx.notify();
                });
            })
            .detach();
            return;
        }
    }

    /// An overlay item's or a banner's release: ONE `overlays.layout.set`
    /// (the whole layout with this item's rect) or `banners.update`.
    fn commit_item(
        &mut self,
        target: &Target,
        stage_id: &str,
        rect: StageRect,
        orientation: &'static str,
        cx: &mut Context<Self>,
    ) {
        let studio = self.studio.clone();
        let stage_id = stage_id.to_string();
        let wire = json!({ "x": rect.x, "y": rect.y, "w": rect.width, "h": rect.height });
        match target {
            Target::Overlay(item) => {
                let Some(mut layout) = self.editor_state.overlay_layout.clone() else {
                    self.stage.item_drafts.retain(|(id, _)| *id != stage_id);
                    return;
                };
                if let Some(entry) = layout.get_mut(*item).and_then(Value::as_object_mut) {
                    entry.insert(orientation.to_string(), wire);
                }
                let answer = self
                    .runtime
                    .spawn(async move { studio.set_overlay_layout(layout).await });
                cx.spawn(async move |this, cx| {
                    let saved = answer.await.ok().flatten();
                    let _ = this.update(cx, |page, cx| {
                        page.stage.item_drafts.retain(|(id, _)| *id != stage_id);
                        if let Some(saved) = saved {
                            page.editor_state.overlay_layout = Some(saved);
                        }
                        page.refresh_editor(cx);
                        cx.notify();
                    });
                })
                .detach();
            }
            Target::Banner(id) => {
                let id = id.clone();
                let answer = self
                    .runtime
                    .spawn(async move { studio.update_banner(&id, orientation, rect).await });
                cx.spawn(async move |this, cx| {
                    let updated = answer
                        .await
                        .ok()
                        .flatten()
                        .and_then(|value| serde_json::from_value::<Banner>(value).ok());
                    let _ = this.update(cx, |page, cx| {
                        page.stage
                            .item_drafts
                            .retain(|(draft, _)| *draft != stage_id);
                        if let Some(banner) = updated
                            && let Some(slot) = page
                                .editor_state
                                .banners
                                .iter_mut()
                                .find(|slot| slot.id == banner.id)
                        {
                            *slot = banner;
                        }
                        page.refresh_editor(cx);
                        cx.notify();
                    });
                })
                .detach();
            }
            Target::Source(_) => {}
        }
    }

    // --- the live draft's wire ---

    /// Sends what the draft channel wants next, one request at a time, and
    /// keeps its heartbeat (`createEditorDraftChannel`).
    fn pump_drafts(&mut self, cx: &mut Context<Self>) {
        let now = Instant::now();
        let Some(send) = self.stage.channel.next(now) else {
            self.stage._draft_timer = None;
            if !self.stage.channel.in_flight()
                && let Some(due) = self.stage.channel.next_due()
            {
                let wait = due.saturating_duration_since(now);
                self.stage._draft_timer = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(wait).await;
                    let _ = this.update(cx, |page, cx| page.pump_drafts(cx));
                }));
            }
            return;
        };
        let studio = self.studio.clone();
        let wire = send.clone();
        let answer = self.runtime.spawn(async move {
            match wire {
                DraftSend::Set(params) => studio.set_editor_draft(params).await,
                DraftSend::Clear => studio.clear_editor_draft().await.map_err(|_| false),
            }
        });
        cx.spawn(async move |this, cx| {
            let result = answer.await.unwrap_or(Err(false));
            let _ = this.update(cx, |page, cx| {
                page.stage.channel.finished(&send, result, Instant::now());
                page.pump_drafts(cx);
            });
        })
        .detach();
    }

    // --- the keys ---

    /// Keys on the focused stage: Esc cancels a gesture (and arrows are
    /// swallowed while one runs); an arrow nudges the selected source
    /// (P525), Shift for the large step (P526).
    fn stage_key(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;
        let key = match keystroke.key.as_str() {
            "up" => "ArrowUp",
            "down" => "ArrowDown",
            "left" => "ArrowLeft",
            "right" => "ArrowRight",
            "escape" => "Escape",
            _ => return,
        };
        if self.stage.gesture.is_some() {
            cx.stop_propagation();
            if key == "Escape" {
                self.cancel_stage_gesture(cx);
            }
            return;
        }
        let modifiers = keystroke.modifiers;
        let Some(nudge) = stage_nudge_for_key(
            key,
            KeyChord {
                shift: modifiers.shift,
                alt: modifiers.alt,
                meta: modifiers.platform,
                ctrl: modifiers.control,
            },
        ) else {
            return;
        };
        cx.stop_propagation();
        if self.stage.phase() != StagePhase::Idle {
            return;
        }
        let view = self.stage_view(cx);
        let Some(source) = view
            .selected_entry()
            .filter(|entry| entry.editable && view.drag_enabled)
            .and_then(Entry::source)
        else {
            return;
        };
        let studio = self.studio.clone();
        let id = source.id.clone();
        self.precise(cx, async move {
            studio
                .nudge_source(&id, nudge.direction_x, nudge.direction_y, nudge.large)
                .await;
        });
    }
}

/// A banner's place for one orientation.
fn banner_place(banner: &Banner, vertical: bool) -> StageRect {
    let place = if vertical {
        &banner.vertical
    } else {
        &banner.horizontal
    };
    StageRect::new(place.x, place.y, place.w, place.h)
}

fn stage_modifiers(modifiers: Modifiers) -> StageModifiers {
    StageModifiers {
        shift: modifiers.shift,
        alt: modifiers.alt,
    }
}

/// One gesture frame's draft (`draftOf`): a source's frame and crop, an
/// item's rect; the chrome is GPUI's own.
fn draft_of(active: &Active) -> Value {
    match &active.target {
        Target::Source(source) => draft_params(
            &source.id,
            active.geometry.frame_of(source, active.ghost.rect),
            active.motion.crop,
        ),
        _ => draft_params(&active.motion.source_id, active.ghost.rect, None),
    }
}
