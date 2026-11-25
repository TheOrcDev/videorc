//! The Canvas section's words and toolbar, the inspector and the Banners
//! section as data (plan 260 Phase 3, L1 part two; `layout-tab.tsx`,
//! `scene-stage.tsx`'s toolbar, `banner-inspector.tsx`,
//! `camera-background-section.tsx`). Pure: one Studio snapshot plus what the
//! page keeps (the selection, the banners and the overlay layout it read,
//! the aspect locks) in, what the page draws out. The rules are the core's
//! (`editor::{inspector, stage, stage_copy}`, `camera_background_view`); this
//! module only gathers their inputs the way `layout-tab.tsx` does.
//!
//! The stage itself (drawing, gestures, live drafts) is batch B; nothing
//! here pretends to be it. One gap is shared with it: the sources' picture
//! sizes (`sourcePictureSizes`, from the compositor's status) are not in the
//! snapshot yet, so a picture is its frame on the background's stage and a
//! Freeform screen's box is never its picture (plan 216 D2 waits for them).

use std::collections::HashMap;

use serde_json::Value;
use videorc_app_core::StudioSnapshot;
use videorc_app_core::editor::inspector::{
    BannersSectionView, InspectorInput, InspectorKind, InspectorSelection, InspectorView,
    banners_section_view, inspector_view, overlay_layout_for_display,
};
use videorc_app_core::editor::stage::{
    OVERLAY_ITEMS, PictureInput, PixelSize, StageItemBadge, StageRect, background_stage_margin,
    banner_stage_id, layer_fit, output_badge, overlay_item_label, overlay_stage_id,
    scene_camera_on_stage, scene_picture_rect, screen_box_is_picture, stage_crop_of,
};
use videorc_app_core::editor::stage_copy;
use videorc_app_core::livestream::plan;
use videorc_app_core::studio::Connection;
use videorc_app_core::studio::camera_background_view::{
    BackgroundDraft, BackgroundSectionView, background_section_view,
};
use videorc_app_core::studio::capture_config::simulcast_armed;
use videorc_app_core::studio::transport::transport_active;
use videorc_protocol::{Banner, SceneSource, SceneSourceKind};

/// The controls' fixed words. The core keeps every word that depends on
/// the scene; these are the frames' own (`layout-tab.tsx`,
/// `source-transform-fields.tsx`, `camera-look-controls.tsx`,
/// `camera-background-section.tsx`, `camera-key-edges-fields.tsx`,
/// `banner-inspector.tsx`), byte for byte. Every apostrophe is ASCII.
pub mod copy {
    // Canvas (P512–P514).
    pub const CANVAS_TITLE: &str = "Canvas";
    pub const OVERLAYS_ON: &str = "Overlays on";
    pub const HORIZONTAL: &str = "Horizontal";
    pub const VERTICAL: &str = "Vertical";
    pub const SCENE_SOURCES: &str = "Scene sources";
    // Source and placement (P544–P555).
    pub const VISIBLE_IN_SCENE: &str = "Visible in scene";
    pub const SCREEN_SIZE: &str = "Screen size";
    pub const PLACEMENT: &str = "Placement";
    pub const RESET: &str = "Reset";
    pub const POSITION_AND_SIZE: &str = "Position and size";
    pub const PERCENT: &str = "%";
    pub const ZOOM: &str = "Zoom";
    pub const CROP: &str = "Crop";
    pub const CROP_HELP_LEAD: &str = "Percent of the screen's picture. On the canvas, hold";
    pub const CROP_HELP_TAIL: &str = "and drag an edge to crop there.";
    pub const RESET_CROP: &str = "Reset crop";
    pub const NUDGE_UP: &str = "Nudge source up";
    pub const NUDGE_LEFT: &str = "Nudge source left";
    pub const NUDGE_DOWN: &str = "Nudge source down";
    pub const NUDGE_RIGHT: &str = "Nudge source right";
    // Camera (P556–P573).
    pub const SPLIT: &str = "Split";
    pub const SPLITS: [(&str, &str); 3] =
        [("50-50", "50/50"), ("60-40", "60/40"), ("70-30", "70/30")];
    pub const CAMERA_SIDE: &str = "Camera side";
    pub const SIDES: [(&str, &str); 2] = [("left", "Camera left"), ("right", "Camera right")];
    pub const CORNER: &str = "Corner";
    pub const CORNERS: [(&str, &str); 4] = [
        ("top-left", "Top left"),
        ("top-right", "Top right"),
        ("bottom-left", "Bottom left"),
        ("bottom-right", "Bottom right"),
    ];
    pub const SIZE: &str = "Size";
    pub const SIZES: [(&str, &str); 3] =
        [("small", "Small"), ("medium", "Medium"), ("large", "Large")];
    pub const SHAPE: &str = "Shape";
    pub const SHAPES: [(&str, &str); 3] = [
        ("rectangle", "Rectangle"),
        ("rounded", "Rounded"),
        ("circle", "Circle"),
    ];
    pub const CORNER_RADIUS: &str = "Corner radius";
    pub const ASPECT: &str = "Aspect";
    pub const ASPECTS: [(&str, &str); 3] = [
        ("source", "Original"),
        ("square", "Square"),
        ("portrait", "Portrait"),
    ];
    pub const ASPECT_CROPS: &str = "Crops the sides of the camera. Frame yourself centered.";
    pub const MARGIN: &str = "Margin";
    pub const LENS: &str = "Lens";
    pub const FIT: &str = "Fit";
    pub const FITS: [(&str, &str); 2] = [("fill", "Fill crop"), ("fit", "Fit frame")];
    pub const MIRROR_CAMERA: &str = "Mirror camera";
    pub const PAN_X: &str = "Pan X";
    pub const PAN_Y: &str = "Pan Y";
    pub const CAMERA_LOOK: &str = "Camera look";
    pub const CAMERA_LOOK_DESCRIPTION: &str = "Saved for this camera in every scene.";
    pub const RESET_CAMERA_LOOK: &str = "Reset camera look";
    pub const BRIGHTNESS: &str = "Brightness";
    pub const CONTRAST: &str = "Contrast";
    pub const SATURATION: &str = "Saturation";
    // Camera Background (P574–P585).
    pub const SIMILARITY: &str = "Similarity";
    pub const SMOOTHNESS: &str = "Smoothness";
    pub const SPILL_REMOVAL: &str = "Spill removal";
    pub const HIDE_EDGES: &str = "Hide edges";
    pub const HIDE_EDGES_HELP: &str = "Makes the camera's edges see-through, for anything there that isn't green screen, like a curtain or a light stand. Up to 25% a side, as you see the camera.";
    pub const SHOW_ALL_EDGES: &str = "Show all edges";
    // Overlay items (P592–P595).
    pub const SHOW_ON_STREAM: &str = "Show on stream";
    pub const SHOW_IN_RECORDING: &str = "Show in recording";
    pub const SNAP_OVERLAY: &str = "Snap overlay";
    // Banners (P596–P610).
    pub const BANNERS_TITLE: &str = "Banners";
    pub const BANNERS_DESCRIPTION: &str = "Your images on the picture. Click one to place it.";
    pub const SHOWING: &str = "Showing";
    pub const SHOW: &str = "Show";
    pub const HIDE: &str = "Hide";
    pub const NO_BANNERS: &str = "No banners yet.";
    pub const PLACE_BANNER: &str = "Place banner";
    pub const OPACITY: &str = "Opacity";
    pub const APPEARS_IN: &str = "Appears in";
    pub const STREAM: &str = "Stream";
    pub const RECORDING: &str = "Recording";
    pub const ORDER: &str = "Order";
    pub const BANNER_ORDER: &str = "Banner order";
    pub const BRING_TO_FRONT: &str = "Bring to front";
    pub const SEND_TO_BACK: &str = "Send to back";
    pub const TIMING: &str = "Timing";
    pub const HIDE_AFTER: &str = "Hide after";
    pub const SHOW_EVERY: &str = "Show every";

    /// `${label} percent of canvas`.
    pub fn transform_field_name(label: &str) -> String {
        format!("{label} percent of canvas")
    }

    /// `Crop ${label.toLowerCase()} percent of the picture`.
    pub fn crop_field_name(label: &str) -> String {
        format!("Crop {} percent of the picture", label.to_lowercase())
    }

    /// `Hide ${label.toLowerCase()} edge, percent of the camera`.
    pub fn hide_edge_name(label: &str) -> String {
        format!("Hide {} edge, percent of the camera", label.to_lowercase())
    }

    /// A banner row's Show or Hide (`${'Hide'|'Show'} ${name}`).
    pub fn show_hide_name(shown: bool, name: &str) -> String {
        format!("{} {name}", if shown { HIDE } else { SHOW })
    }
}

/// What a toolbar chip stands for: it picks the chip's icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChipKind {
    Camera,
    Source,
    Overlay,
    Banner,
}

/// One chip of the "Scene sources" toolbar (P514, P515).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chip {
    /// The stage id: a source's id, `overlay:<item>` or `banner:<id>`.
    pub stage_id: String,
    pub label: String,
    pub badge: Option<StageItemBadge>,
    pub kind: ChipKind,
}

impl Chip {
    /// The chip's accessible name: the badge as its raw lower-case word
    /// ("Select Chat, off"), as Electron says it.
    pub fn name(&self) -> String {
        let word = self.badge.map(StageItemBadge::word).unwrap_or_default();
        stage_copy::select_name(&self.label, &word)
    }
}

/// The selected source's geometry, for the inspector's commits.
#[derive(Debug, Clone, PartialEq)]
pub struct EditTarget {
    pub source: SceneSource,
    /// The picture the stage shows (plan 216 B5): the fields' box.
    pub picture: StageRect,
    pub box_is_picture: bool,
    pub stage_margin: f64,
    pub camera_on_stage: bool,
    pub canvas: PixelSize,
}

/// What the page keeps between snapshots.
#[derive(Debug, Clone, Default)]
pub struct EditorState {
    /// The stage's one selection, as last chosen (or defaulted).
    pub selection: Option<InspectorSelection>,
    /// `banners.list`, in Images order.
    pub banners: Vec<Banner>,
    pub banners_loaded: bool,
    /// `overlays.layout.get` (the saved layout; display goes through
    /// `overlay_layout_for_display`).
    pub overlay_layout: Option<Value>,
    /// The per-source aspect preference (`aspectPreferences`, default on).
    pub aspect_locks: HashMap<String, bool>,
    /// "Overlays on" Vertical (P513); back to Horizontal when the leg goes.
    pub overlays_vertical: bool,
    /// One precise edit at a time (`preciseEditPending`).
    pub precise_pending: bool,
    /// A Background slider mid-drag, for the camera it was dragged on.
    pub background_draft: BackgroundDraft,
}

/// The canvas toolbar, the inspector and the Banners section.
#[derive(Debug, Clone, PartialEq)]
pub struct EditorModel {
    /// P512: `Changes save to “…” as you make them.` or the drag line.
    pub canvas_description: String,
    /// P513: `Some(vertical)` while a vertical stream leg is armed.
    pub overlays_on: Option<bool>,
    pub chips: Vec<Chip>,
    /// The toolbar waits while a precise edit lands (`phase !== 'idle'`).
    pub chips_enabled: bool,
    pub selected_stage_id: Option<String>,
    pub selection: InspectorSelection,
    pub inspector: InspectorView,
    /// The camera's Background section (camera selected only).
    pub background: Option<BackgroundSectionView>,
    /// The background that section shows (a draft mid-drag, else stored).
    pub camera_background: Value,
    pub camera_id: Option<String>,
    pub banners: BannersSectionView,
    pub edit: Option<EditTarget>,
    /// The overlay and banner rects a snap writes: the vertical stream's in
    /// the vertical view or on a portrait canvas.
    pub vertical_overlays: bool,
    /// The stage canvas's width / height (`stageAspect`).
    pub canvas_aspect: f64,
}

/// The selection the inspector reads: the chosen one while its target is
/// there, else the camera, else the first source (`layout-tab.tsx`
/// 530-547); `None` for an empty scene.
pub fn effective_selection(
    chosen: Option<&InspectorSelection>,
    scene_sources: &[SceneSource],
    overlay_layout: Option<&Value>,
    banners: &[Banner],
    banners_loaded: bool,
) -> InspectorSelection {
    let kept = match chosen {
        Some(InspectorSelection::Source(id)) => scene_sources.iter().any(|source| &source.id == id),
        Some(InspectorSelection::Overlay(item)) => {
            overlay_layout.is_none_or(|layout| layout.get(*item).is_some())
        }
        Some(InspectorSelection::Banner(id)) => {
            !banners_loaded || banners.iter().any(|banner| &banner.id == id)
        }
        Some(InspectorSelection::None) | None => false,
    };
    if let Some(chosen) = chosen.filter(|_| kept) {
        return chosen.clone();
    }
    scene_sources
        .iter()
        .find(|source| source.kind == SceneSourceKind::Camera)
        .or_else(|| scene_sources.first())
        .map_or(InspectorSelection::None, |source| {
            InspectorSelection::Source(source.id.clone())
        })
}

/// `banners.list`'s answer: the list, or `{banners: [...]}`.
pub fn parse_banners(value: Value) -> Option<Vec<Banner>> {
    if let Ok(list) = serde_json::from_value::<Vec<Banner>>(value.clone()) {
        return Some(list);
    }
    value
        .get("banners")
        .cloned()
        .and_then(|list| serde_json::from_value(list).ok())
}

fn switches(entry: &Value) -> (bool, bool) {
    (
        entry.get("showOnStream").and_then(Value::as_bool) == Some(true),
        entry.get("showInRecording").and_then(Value::as_bool) == Some(true),
    )
}

/// `overlayStageItems`' badge: Off when both outputs are off, else the one
/// output that alone shows it.
fn item_badge(on_stream: bool, in_recording: bool) -> Option<StageItemBadge> {
    if !on_stream && !in_recording {
        Some(StageItemBadge::Off)
    } else {
        output_badge(on_stream, in_recording)
    }
}

/// The toolbar's chips: the sources in scene order (not in the vertical
/// view), the overlay items in `OVERLAY_ITEMS` order, then the banners on
/// the stage (shown ones and the selected one, Images order).
fn chips(
    scene_sources: &[SceneSource],
    vertical_view: bool,
    overlay_layout: Option<&Value>,
    captions: Option<&Value>,
    banners: &[Banner],
    selected_banner: Option<&str>,
) -> Vec<Chip> {
    let mut out = Vec::new();
    if !vertical_view {
        out.extend(scene_sources.iter().map(|source| Chip {
            stage_id: source.id.clone(),
            label: source.name.clone(),
            badge: None,
            kind: if source.kind == SceneSourceKind::Camera {
                ChipKind::Camera
            } else {
                ChipKind::Source
            },
        }));
    }
    if let Some(layout) = overlay_layout {
        let shown = overlay_layout_for_display(layout, captions);
        for item in OVERLAY_ITEMS {
            let (on_stream, in_recording) = switches(&shown[item]);
            out.push(Chip {
                stage_id: overlay_stage_id(item),
                label: overlay_item_label(item).to_string(),
                badge: item_badge(on_stream, in_recording),
                kind: ChipKind::Overlay,
            });
        }
    }
    out.extend(
        banners
            .iter()
            .filter(|banner| banner.shown || selected_banner == Some(banner.id.as_str()))
            .map(|banner| Chip {
                stage_id: banner_stage_id(&banner.id),
                label: banner.name.clone(),
                badge: if banner.shown {
                    item_badge(banner.show_on_stream, banner.show_in_recording)
                } else {
                    Some(StageItemBadge::Hidden)
                },
                kind: ChipKind::Banner,
            }),
    );
    out
}

impl EditorModel {
    pub fn of(
        snapshot: &StudioSnapshot,
        state: &EditorState,
        room_open: bool,
        platform: Option<&'static str>,
    ) -> Self {
        let capture = &snapshot.settings.capture_doc;
        let layout = &capture["layout"];
        let capture_sources = &capture["sources"];
        let captions = capture.get("captions");
        let recording = plan::recording_video(capture);
        let video = (f64::from(recording.width), f64::from(recording.height));
        // `simulcastLegVideo`: the armed vertical leg's portrait canvas.
        let leg = simulcast_armed(capture).then(|| {
            let leg = plan::simulcast_video_of(capture, &recording);
            (
                f64::from(leg.width.min(leg.height)),
                f64::from(leg.width.max(leg.height)),
            )
        });
        let vertical_view = leg.is_some() && state.overlays_vertical;
        let scene = snapshot.sources.scene.as_ref();
        let scene_sources: &[SceneSource] =
            scene.map(|scene| scene.sources.as_slice()).unwrap_or(&[]);
        let background = scene
            .and_then(|scene| scene.background.as_ref())
            .and_then(|background| serde_json::to_value(background).ok());
        let connected = matches!(snapshot.connection, Connection::Connected { .. });
        let session_active = transport_active(&snapshot.session);
        let selection = effective_selection(
            state.selection.as_ref(),
            scene_sources,
            state.overlay_layout.as_ref(),
            &state.banners,
            state.banners_loaded,
        );

        // The selected source's picture (`pictureBoxOf`) and its frame's
        // mapping, for the fields and their commits.
        let stage_margin = background_stage_margin(background.as_ref());
        let kinds: Vec<SceneSourceKind> = scene_sources
            .iter()
            .map(|source| source.kind.clone())
            .collect();
        let camera_on_stage = scene_camera_on_stage(&kinds, layout);
        let canvas = PixelSize {
            width: video.0,
            height: video.1,
        };
        let freeform = layout.get("arrangementMode").and_then(Value::as_str) == Some("freeform");
        let edit = match &selection {
            InspectorSelection::Source(id) => scene_sources
                .iter()
                .find(|source| &source.id == id)
                .map(|source| {
                    let fit = layer_fit(&source.kind, layout);
                    EditTarget {
                        picture: scene_picture_rect(PictureInput {
                            frame: StageRect::of(&source.transform),
                            kind: &source.kind,
                            fit,
                            source: None,
                            crop: stage_crop_of(&source.transform),
                            stage_margin,
                            camera_on_stage,
                            canvas,
                        }),
                        box_is_picture: freeform && screen_box_is_picture(&source.kind, fit, None),
                        source: source.clone(),
                        stage_margin,
                        camera_on_stage,
                        canvas,
                    }
                }),
            _ => None,
        };
        let aspect_locked = edit
            .as_ref()
            .and_then(|edit| state.aspect_locks.get(&edit.source.id).copied())
            .unwrap_or(true);

        let inspector = inspector_view(&InspectorInput {
            layout,
            sources: capture_sources,
            video,
            vertical_stream: leg,
            vertical_view,
            scene_sources,
            has_background: scene.is_some_and(|scene| scene.background.is_some()),
            selection: selection.clone(),
            picture: edit.as_ref().map(|edit| edit.picture),
            box_is_picture: edit.as_ref().is_some_and(|edit| edit.box_is_picture),
            aspect_locked,
            scene_edit_mode: snapshot.scene_edit_mode,
            session_active,
            accepts_live_scene_edits: snapshot.session.status.accepts_live_scene_edits,
            // The stage's gestures are batch B: nothing drags yet.
            stage_dragging: false,
            connected,
            visibility_percent: scene
                .and_then(|scene| scene.background.as_ref())
                .map(|background| background.visibility_percent),
            overlay_layout: state.overlay_layout.as_ref(),
            captions,
            banners: &state.banners,
        });

        // The camera's Background (plan 258 S5): the shown background is
        // the draft mid-drag, else the one stored for this camera. The
        // Images library's background pictures are not read by the app
        // yet, so no picture tiles show (P577).
        let camera_id = capture_sources
            .get("cameraId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        let camera_background = state.background_draft.shown(
            snapshot.settings.studio.get("cameraBackgrounds"),
            camera_id.as_deref(),
        );
        let background_view = (inspector.kind == InspectorKind::Camera).then(|| {
            background_section_view(
                &camera_background,
                &[],
                camera_id.is_some(),
                room_open,
                platform,
            )
        });

        let selected_banner = match &selection {
            InspectorSelection::Banner(id) => Some(id.as_str()),
            _ => None,
        };
        // The overlay or banner section above already says it's offline.
        let inspector_offline = inspector
            .banner
            .as_ref()
            .is_some_and(|banner| banner.blocked.is_some())
            || inspector
                .overlay
                .as_ref()
                .is_some_and(|overlay| overlay.blocked.is_some());
        let banners = banners_section_view(
            &state.banners,
            state.banners_loaded,
            connected,
            selected_banner,
            inspector_offline,
        );
        let chips = chips(
            scene_sources,
            vertical_view,
            state.overlay_layout.as_ref(),
            captions,
            &state.banners,
            selected_banner,
        );
        let selected_stage_id = match &selection {
            InspectorSelection::Source(id) if !vertical_view => Some(id.clone()),
            InspectorSelection::Overlay(item) => Some(overlay_stage_id(item)),
            InspectorSelection::Banner(id) => Some(banner_stage_id(id)),
            _ => None,
        };
        let canvas_aspect = match leg {
            Some((width, height)) if vertical_view => width / height.max(1.0),
            _ => video.0 / video.1.max(1.0),
        };

        Self {
            canvas_description: snapshot.scenes.on_stream().map_or_else(
                || stage_copy::DRAG_INTO_PLACE.to_string(),
                |scene| stage_copy::saves_to(&scene.name),
            ),
            overlays_on: leg.map(|_| state.overlays_vertical),
            chips,
            chips_enabled: !state.precise_pending,
            selected_stage_id,
            selection,
            inspector,
            background: background_view,
            camera_background,
            camera_id,
            banners,
            edit,
            vertical_overlays: vertical_view || video.1 > video.0,
            canvas_aspect,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn source(id: &str, kind: &str) -> SceneSource {
        let transform = json!({"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0});
        serde_json::from_value(json!({
            "id": id,
            "name": id,
            "kind": kind,
            "transform": transform,
            "defaultTransform": transform,
        }))
        .expect("a scene source")
    }

    #[test]
    fn nothing_chosen_picks_the_camera_else_the_first_source() {
        let sources = [source("screen", "screen"), source("cam", "camera")];
        assert_eq!(
            effective_selection(None, &sources, None, &[], false),
            InspectorSelection::Source("cam".into())
        );
        let screens = [source("screen", "screen")];
        assert_eq!(
            effective_selection(None, &screens, None, &[], false),
            InspectorSelection::Source("screen".into())
        );
        assert_eq!(
            effective_selection(None, &[], None, &[], false),
            InspectorSelection::None
        );
    }

    #[test]
    fn a_gone_target_falls_back_and_a_present_one_stays() {
        let sources = [source("screen", "screen"), source("cam", "camera")];
        let screen = InspectorSelection::Source("screen".into());
        assert_eq!(
            effective_selection(Some(&screen), &sources, None, &[], false),
            screen
        );
        let gone = InspectorSelection::Source("old".into());
        assert_eq!(
            effective_selection(Some(&gone), &sources, None, &[], false),
            InspectorSelection::Source("cam".into())
        );
        // A banner waits for the list before it is dropped.
        let banner = InspectorSelection::Banner("b".into());
        assert_eq!(
            effective_selection(Some(&banner), &sources, None, &[], false),
            banner
        );
        assert_eq!(
            effective_selection(Some(&banner), &sources, None, &[], true),
            InspectorSelection::Source("cam".into())
        );
    }

    #[test]
    fn chip_names_say_the_raw_badge() {
        let chip = Chip {
            stage_id: "overlay:chat".into(),
            label: "Chat".into(),
            badge: Some(StageItemBadge::Off),
            kind: ChipKind::Overlay,
        };
        assert_eq!(chip.name(), "Select Chat, off");
        assert_eq!(copy::transform_field_name("W"), "W percent of canvas");
        assert_eq!(
            copy::crop_field_name("Left"),
            "Crop left percent of the picture"
        );
        assert_eq!(
            copy::hide_edge_name("Top"),
            "Hide top edge, percent of the camera"
        );
    }
}
