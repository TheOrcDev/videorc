//! Arrange the picture for agents (plan 209 S11b, D22; Electron's
//! `lib/studio-actions/scene-layout.ts`): `get_scene_layout`, `move_on_scene`,
//! and `set_scene_item`.
//!
//! Uses the scene editor's own geometry and save paths (`overlays.layout.set`,
//! `banners.update`, `snap_camera_corner`, `apply_layout_patch`,
//! `commit_source_transform`, `set_source_visible`).

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use videorc_protocol::overlay_layout::OverlayRect;
use videorc_protocol::{Banner, Scene, SceneSource, SceneSourceKind};

use super::agent::AgentIntentOutcome;
use super::capture_config;
use super::scene_editor::{freeform_entry_overrides, layout_orientation, source_override};
use super::{Studio, StudioBackend};
use crate::editor::inspector::{
    banner_fit_overlay, banner_snap_rect, camera_shape_patch, copy as inspector_copy,
    overlay_default_size, overlay_place_origin, scene_camera_controls, with_overlay_rect,
};
use crate::editor::stage::{
    MIN_SOURCE_FRACTION, StageRect, clamp_overlay_rect, round_rect_for_commit,
};

pub const OVERLAY_ITEMS: [&str; 4] = ["highlight", "captions", "buddy", "chat"];
pub const OVERLAY_RECT_MIN_SIZE: f64 = 0.02;

pub const SCENE_PLACES: [&str; 10] = [
    "top-left",
    "top-center",
    "top-right",
    "middle-left",
    "center",
    "middle-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
    "full-frame",
];

const CAMERA_CORNERS: [&str; 4] = ["top-left", "top-right", "bottom-left", "bottom-right"];

pub mod copy {
    pub const NO_ITEM: &str =
        "There's no such item on the picture. Call get_scene_layout for the items.";
    pub const NO_CAMERA: &str =
        "There's no camera in this scene. Switch to a scene with the camera first.";
    pub const NO_SCREEN: &str =
        "There's no screen in this scene. Switch to a scene with the screen first.";
    pub const BANNER_MISSING: &str = crate::studio::scene_editor::BANNER_ACTION_MISSING;
    pub const MOVE_EMPTY: &str = "Say where: place, size, rect or rects.";
    pub const RECT_OR_PLACE: &str = "Give a place and a size, or an exact rect, not both.";
    pub const FULL_FRAME_BANNERS_ONLY: &str =
        "full-frame is for banners. Choose a place on the 3×3 grid.";
    pub const SOURCE_MOVE_LIVE: &str = "Moving a source waits until the recording or livestream ends, as on the Scene canvas. The camera can go to a corner now.";
    pub const SET_EMPTY: &str =
        "Say what to change: shown, shape, showOnStream or showInRecording.";
    pub const SOURCE_SWITCHES: &str =
        "The camera and the screen show in both the stream and the recording; use shown instead.";
    pub const OVERLAY_SHOWN: &str = "Use showOnStream and showInRecording for this item.";
    pub const BANNER_SHOWN: &str = "Use set_banner to show or hide a banner.";
    pub const SHAPE_CAMERA_ONLY: &str = "Only the camera has a shape.";
    pub const SHAPE_NOT_HERE: &str =
        "The camera's shape works in the Screen + camera scenes and in freeform.";
    pub const WINDOWS_NEXT_SESSION: &str =
        "Saved. On this PC it shows from your next recording or stream.";
    pub const CAPTIONS_SWITCHES: &str = "Captions are on the stream whenever Live captions is on, in every scene. Use set_captions to turn them on or off; the Captions page chooses whether the recording gets them too.";
    pub const FAILED: &str = "Couldn't change the picture. Check the Scene page on your computer.";
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SceneRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SceneRects {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub horizontal: Option<SceneRect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertical: Option<SceneRect>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SceneSize {
    Small,
    Medium,
    Large,
    Fraction(f64),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OverlapEntry {
    pub item: String,
    pub name: String,
}

fn overlay_item_label(item: &str) -> &'static str {
    match item {
        "highlight" => "Highlighted message",
        "captions" => "Captions",
        "buddy" => "Sidekick",
        _ => "Chat",
    }
}

fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn round6(value: f64) -> f64 {
    js_round(value * 1_000_000.0) / 1_000_000.0
}

fn round9(value: f64) -> f64 {
    js_round(value * 1_000_000_000.0) / 1_000_000_000.0
}

fn to_scene_rect(rect: &OverlayRect) -> SceneRect {
    SceneRect {
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
    }
}

fn from_scene_rect(rect: SceneRect) -> OverlayRect {
    OverlayRect::new(rect.x, rect.y, rect.width, rect.height)
}

fn source_rect(source: &SceneSource) -> SceneRect {
    SceneRect {
        x: source.transform.x,
        y: source.transform.y,
        width: source.transform.width,
        height: source.transform.height,
    }
}

fn is_screen_kind(kind: &SceneSourceKind) -> bool {
    matches!(
        kind,
        SceneSourceKind::Screen | SceneSourceKind::Window | SceneSourceKind::TestPattern
    )
}

fn scene_source<'a>(scene: Option<&'a Scene>, role: &str) -> Option<&'a SceneSource> {
    scene?.sources.iter().find(|source| {
        if role == "camera" {
            source.kind == SceneSourceKind::Camera
        } else {
            is_screen_kind(&source.kind)
        }
    })
}

fn banner_fills_canvas(rect: &OverlayRect) -> bool {
    rect.w >= 0.98 && rect.h >= 0.98
}

fn horizontal_gravity(rect: &OverlayRect) -> i8 {
    let center = rect.x + rect.w / 2.0;
    if center < 0.48 {
        -1
    } else if center > 0.52 {
        1
    } else {
        0
    }
}

fn anchored(current: &OverlayRect, w: f64, h: f64) -> OverlayRect {
    let x = match horizontal_gravity(current) {
        -1 => current.x,
        0 => current.x + (current.w - w) / 2.0,
        _ => current.x + current.w - w,
    };
    let y = if current.y + current.h / 2.0 >= 0.5 {
        current.y + current.h - h
    } else {
        current.y
    };
    OverlayRect::new(x, y, w, h)
}

fn fit_shape(w: f64, ratio: f64) -> (f64, f64) {
    let shape = if ratio.is_finite() && ratio > 0.0 {
        ratio
    } else {
        1.0
    };
    let min_w = OVERLAY_RECT_MIN_SIZE.max(OVERLAY_RECT_MIN_SIZE / shape);
    let max_w = 1.0_f64.min(1.0 / shape);
    let width = w.clamp(min_w, max_w);
    (width, width * shape)
}

fn on_canvas(rect: &OverlayRect) -> bool {
    rect.w >= OVERLAY_RECT_MIN_SIZE
        && rect.h >= OVERLAY_RECT_MIN_SIZE
        && rect.x >= 0.0
        && rect.y >= 0.0
        && rect.x + rect.w <= 1.0 + 1e-6
        && rect.y + rect.h <= 1.0 + 1e-6
}

fn stage_rect_to_overlay(rect: SceneRect) -> OverlayRect {
    let clamped = clamp_overlay_rect(StageRect::new(rect.x, rect.y, rect.width, rect.height));
    OverlayRect::new(
        round6(clamped.x),
        round6(clamped.y),
        round6(clamped.width),
        round6(clamped.height),
    )
}

fn size_factor(size: SceneSize) -> f64 {
    match size {
        SceneSize::Small => 0.75,
        SceneSize::Medium => 1.0,
        SceneSize::Large => 1.5,
        SceneSize::Fraction(v) => v,
    }
}

pub fn overlay_placement(
    item: &str,
    vertical: bool,
    current: &OverlayRect,
    place: Option<&str>,
    size: Option<SceneSize>,
) -> OverlayRect {
    let (def_w, def_h) = overlay_default_size(item, vertical);
    let (w, h) = match size {
        None => {
            if current.w == round6(def_w) && current.h == round6(def_h) {
                (def_w, def_h)
            } else {
                (current.w, current.h)
            }
        }
        Some(SceneSize::Medium) => (def_w, def_h),
        Some(SceneSize::Fraction(f)) => {
            let ratio = if item == "buddy" {
                def_h / def_w
            } else {
                current.h / current.w.max(1e-6)
            };
            fit_shape(f, ratio)
        }
        Some(word) => {
            let factor = size_factor(word);
            if item == "buddy" {
                fit_shape(def_w * factor, def_h / def_w)
            } else {
                (
                    (def_w * factor).clamp(OVERLAY_RECT_MIN_SIZE, 1.0),
                    (def_h * factor).clamp(OVERLAY_RECT_MIN_SIZE, 1.0),
                )
            }
        }
    };
    if let Some(place) = place {
        let (x, y) = overlay_place_origin(place, vertical, w, h);
        let placed = OverlayRect::new(round6(x.max(0.0)), round6(y.max(0.0)), round6(w), round6(h));
        if on_canvas(&placed) {
            return placed;
        }
        let clamped = clamp_overlay_rect(StageRect::new(placed.x, placed.y, placed.w, placed.h));
        return OverlayRect::new(
            round6(clamped.x),
            round6(clamped.y),
            round6(clamped.width),
            round6(clamped.height),
        );
    }
    let next = anchored(current, w, h);
    let clamped = clamp_overlay_rect(StageRect::new(next.x, next.y, next.w, next.h));
    OverlayRect::new(
        round6(clamped.x),
        round6(clamped.y),
        round6(clamped.width),
        round6(clamped.height),
    )
}

fn banner_default_place(banner: &Banner, vertical: bool) -> OverlayRect {
    let image_aspect = f64::from(banner.width.max(1)) / f64::from(banner.height.max(1));
    if vertical {
        if image_aspect < 1.2 {
            OverlayRect::new(0.15, 0.12, 0.7, 0.25)
        } else {
            OverlayRect::new(0.08, 0.68, 0.84, 0.14)
        }
    } else if image_aspect < 1.4 {
        OverlayRect::new(0.72, 0.06, 0.22, 0.28)
    } else {
        OverlayRect::new(0.04, 0.76, 0.44, 0.18)
    }
}

pub fn banner_placement(
    banner: &Banner,
    vertical: bool,
    canvas_aspect: f64,
    place: Option<&str>,
    size: Option<SceneSize>,
) -> OverlayRect {
    let base_rect = if vertical {
        &banner.vertical
    } else {
        &banner.horizontal
    };
    let sized = match size {
        None => *base_rect,
        Some(size) => {
            let current = banner_fit_overlay(banner, base_rect, canvas_aspect, vertical);
            let default_place = banner_default_place(banner, vertical);
            let defaults = banner_fit_overlay(banner, &default_place, canvas_aspect, vertical);
            let image_aspect = f64::from(banner.width.max(1)) / f64::from(banner.height.max(1));
            let asked = match size {
                SceneSize::Fraction(f) => f,
                word => defaults.w * size_factor(word),
            };
            let w = asked.min(1.0).min(image_aspect / canvas_aspect);
            OverlayRect::new(current.x, current.y, w, (w * canvas_aspect) / image_aspect)
        }
    };
    if let Some(place) = place {
        let mut temp = banner.clone();
        if vertical {
            temp.vertical = sized;
        } else {
            temp.horizontal = sized;
        }
        return banner_snap_rect(&temp, vertical, canvas_aspect, place);
    }
    let current = banner_fit_overlay(banner, base_rect, canvas_aspect, vertical);
    let next = anchored(&current, sized.w, sized.h);
    let clamped = clamp_overlay_rect(StageRect::new(next.x, next.y, next.w, next.h));
    OverlayRect::new(
        round6(clamped.x),
        round6(clamped.y),
        round6(clamped.width),
        round6(clamped.height),
    )
}

fn clamp_source_rect(rect: SceneRect) -> SceneRect {
    let width = rect.width.clamp(MIN_SOURCE_FRACTION, 1.0);
    let height = rect.height.clamp(MIN_SOURCE_FRACTION, 1.0);
    let rounded = round_rect_for_commit(StageRect::new(
        rect.x.clamp(0.0, 1.0 - width),
        rect.y.clamp(0.0, 1.0 - height),
        width,
        height,
    ));
    SceneRect {
        x: rounded.x,
        y: rounded.y,
        width: rounded.width,
        height: rounded.height,
    }
}

pub fn source_placement(
    source: &SceneSource,
    vertical: bool,
    place: Option<&str>,
    size: Option<SceneSize>,
    exact_rect: Option<SceneRect>,
) -> SceneRect {
    if let Some(rect) = exact_rect {
        return clamp_source_rect(rect);
    }
    let current = source_rect(source);
    let (mut width, mut height) = (current.width, current.height);
    if let Some(size) = size {
        match size {
            SceneSize::Fraction(f) => {
                height = f * (current.height / current.width.max(1e-6));
                width = f;
            }
            word => {
                let factor = size_factor(word);
                width = source.default_transform.width * factor;
                height = source.default_transform.height * factor;
            }
        }
    }
    if let Some(place) = place {
        let (x, y) = overlay_place_origin(place, vertical, width, height);
        return clamp_source_rect(SceneRect {
            x,
            y,
            width,
            height,
        });
    }
    let next = anchored(&from_scene_rect(current), width, height);
    clamp_source_rect(to_scene_rect(&next))
}

pub fn preset_corner_rect(layout: &Value, camera: SceneRect, corner: &str) -> Option<SceneRect> {
    if layout.get("cameraTransformMode").and_then(Value::as_str) == Some("custom") {
        return None;
    }
    let from = layout
        .get("cameraCorner")
        .and_then(Value::as_str)
        .unwrap_or("bottom-right");
    let side = |same: bool, at: f64, size: f64| -> f64 {
        if same {
            at
        } else {
            round9(1.0 - size - at).max(0.0)
        }
    };
    Some(SceneRect {
        x: side(
            from.ends_with("-left") == corner.ends_with("-left"),
            camera.x,
            camera.width,
        ),
        y: side(
            from.starts_with("top-") == corner.starts_with("top-"),
            camera.y,
            camera.height,
        ),
        width: camera.width,
        height: camera.height,
    })
}

fn overlay_rect_from_layout(layout: &Value, item: &str, side: &str) -> OverlayRect {
    let rect = &layout[item][side];
    serde_json::from_value(rect.clone()).unwrap_or_else(|_| {
        let (w, h) = overlay_default_size(item, side == "vertical");
        OverlayRect::new(0.04, 0.04, w, h)
    })
}

fn overlay_switches_from_layout(layout: &Value, item: &str) -> (bool, bool) {
    let on_stream = layout[item]["showOnStream"].as_bool().unwrap_or(true);
    let in_recording = layout[item]["showInRecording"].as_bool().unwrap_or(false);
    (on_stream, in_recording)
}

fn intersects(a: &OverlayRect, b: &OverlayRect) -> bool {
    let eps = 1e-6;
    (a.x + a.w).min(b.x + b.w) - a.x.max(b.x) > eps
        && (a.y + a.h).min(b.y + b.h) - a.y.max(b.y) > eps
}

struct ArrangeSnapshot {
    orientation: &'static str,
    vertical_stream: bool,
    layout: Value,
    scene: Option<Scene>,
    overlay_layout: Value,
    banners: Vec<Banner>,
    canvas_aspect_h: f64,
    canvas_aspect_v: f64,
    session_active: bool,
    start_time_overlays: bool,
}

impl ArrangeSnapshot {
    fn canvas_aspect(&self, vertical: bool) -> f64 {
        if vertical {
            self.canvas_aspect_v
        } else {
            self.canvas_aspect_h
        }
    }

    fn with_source_rects(&self, rects: &BTreeMap<String, SceneRect>) -> Self {
        let mut scene = self.scene.clone();
        if let Some(scene) = scene.as_mut() {
            for source in &mut scene.sources {
                if let Some(rect) = rects.get(&source.id) {
                    source.transform.x = rect.x;
                    source.transform.y = rect.y;
                    source.transform.width = rect.width;
                    source.transform.height = rect.height;
                }
            }
        }
        Self {
            orientation: self.orientation,
            vertical_stream: self.vertical_stream,
            layout: self.layout.clone(),
            scene,
            overlay_layout: self.overlay_layout.clone(),
            banners: self.banners.clone(),
            canvas_aspect_h: self.canvas_aspect_h,
            canvas_aspect_v: self.canvas_aspect_v,
            session_active: self.session_active,
            start_time_overlays: self.start_time_overlays,
        }
    }

    fn placed_items(&self, drawn_only: bool) -> Vec<(String, String, &'static str, OverlayRect)> {
        let mut placed = Vec::new();
        let src_orient = layout_orientation(&self.layout);
        for role in ["camera", "screen"] {
            if let Some(source) = scene_source(self.scene.as_ref(), role)
                && (source.visible || !drawn_only)
            {
                let name = if source.name.is_empty() {
                    role.to_string()
                } else {
                    source.name.clone()
                };
                placed.push((
                    role.to_string(),
                    name,
                    src_orient,
                    from_scene_rect(source_rect(source)),
                ));
            }
        }
        for item in OVERLAY_ITEMS {
            let (on_stream, in_recording) =
                overlay_switches_from_layout(&self.overlay_layout, item);
            if drawn_only && !on_stream && !in_recording {
                continue;
            }
            for side in ["horizontal", "vertical"] {
                placed.push((
                    item.to_string(),
                    overlay_item_label(item).to_string(),
                    side,
                    overlay_rect_from_layout(&self.overlay_layout, item, side),
                ));
            }
        }
        for banner in &self.banners {
            if drawn_only && !banner.shown {
                continue;
            }
            for side in ["horizontal", "vertical"] {
                let vertical = side == "vertical";
                let rect = if vertical {
                    &banner.vertical
                } else {
                    &banner.horizontal
                };
                placed.push((
                    format!("banner:{}", banner.id),
                    banner.name.clone(),
                    side,
                    banner_fit_overlay(banner, rect, self.canvas_aspect(vertical), vertical),
                ));
            }
        }
        placed
    }

    fn overlaps(&self, id: &str) -> Vec<OverlapEntry> {
        let mut drawn = HashSet::new();
        drawn.insert(self.orientation);
        if self.vertical_stream {
            drawn.insert("vertical");
        }
        let placed: Vec<_> = self
            .placed_items(true)
            .into_iter()
            .filter(|(_, _, orient, _)| drawn.contains(orient))
            .collect();
        let mine: Vec<_> = self
            .placed_items(false)
            .into_iter()
            .filter(|(item_id, _, orient, _)| item_id == id && drawn.contains(orient))
            .collect();
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for (other_id, name, orient, rect) in &placed {
            if other_id == id || seen.contains(other_id) || banner_fills_canvas(rect) {
                continue;
            }
            if mine.iter().any(|(_, _, own_orient, own_rect)| {
                own_orient == orient && intersects(own_rect, rect)
            }) {
                seen.insert(other_id.clone());
                out.push(OverlapEntry {
                    item: other_id.clone(),
                    name: name.clone(),
                });
            }
        }
        out
    }

    fn layout_view(&self) -> Value {
        let src_orient = layout_orientation(&self.layout);
        let controls = scene_camera_controls(&self.layout);
        let mut items = Vec::new();
        for role in ["camera", "screen"] {
            if let Some(source) = scene_source(self.scene.as_ref(), role) {
                let mut entry = json!({
                    "item": role,
                    "name": if source.name.is_empty() { role } else { source.name.as_str() },
                    "kind": role,
                    "rects": { src_orient: source_rect(source) },
                    "shown": source.visible,
                });
                if role == "camera"
                    && controls.corner
                    && self
                        .layout
                        .get("cameraTransformMode")
                        .and_then(Value::as_str)
                        != Some("custom")
                    && let Some(corner) = self.layout.get("cameraCorner").and_then(Value::as_str)
                {
                    entry["corner"] = json!(corner);
                }
                if role == "camera"
                    && controls.bubble
                    && let Some(shape) = self.layout.get("cameraShape").and_then(Value::as_str)
                {
                    entry["shape"] = json!(shape);
                }
                items.push(entry);
            }
        }
        for item in OVERLAY_ITEMS {
            let h = overlay_rect_from_layout(&self.overlay_layout, item, "horizontal");
            let v = overlay_rect_from_layout(&self.overlay_layout, item, "vertical");
            let (on_stream, in_recording) =
                overlay_switches_from_layout(&self.overlay_layout, item);
            items.push(json!({
                "item": item,
                "name": overlay_item_label(item),
                "kind": "overlay",
                "rects": {
                    "horizontal": to_scene_rect(&h),
                    "vertical": to_scene_rect(&v),
                },
                "showOnStream": on_stream,
                "showInRecording": in_recording,
            }));
        }
        for banner in &self.banners {
            items.push(json!({
                "item": format!("banner:{}", banner.id),
                "name": banner.name,
                "kind": "banner",
                "rects": {
                    "horizontal": to_scene_rect(&banner.horizontal),
                    "vertical": to_scene_rect(&banner.vertical),
                },
                "shown": banner.shown,
                "showOnStream": banner.show_on_stream,
                "showInRecording": banner.show_in_recording,
            }));
        }
        let layout_id = self
            .layout
            .get("layoutPreset")
            .and_then(Value::as_str)
            .unwrap_or("screen-camera");
        let arrangement =
            if self.layout.get("arrangementMode").and_then(Value::as_str) == Some("freeform") {
                "freeform"
            } else {
                "preset"
            };
        json!({
            "orientation": self.orientation,
            "verticalStream": self.vertical_stream,
            "layoutId": layout_id,
            "arrangement": arrangement,
            "items": items,
        })
    }
}

enum ResolvedItem {
    Source {
        id: &'static str,
        source: SceneSource,
        name: String,
    },
    Overlay {
        id: &'static str,
        name: &'static str,
    },
    Banner {
        id: String,
        banner: Banner,
        name: String,
    },
}

fn resolve_item(snapshot: &ArrangeSnapshot, raw: Option<&str>) -> Result<ResolvedItem, String> {
    let name = raw.unwrap_or("").trim();
    if name == "camera" || name == "screen" {
        let Some(source) = scene_source(snapshot.scene.as_ref(), name) else {
            return Err(if name == "camera" {
                copy::NO_CAMERA
            } else {
                copy::NO_SCREEN
            }
            .to_string());
        };
        let label = if source.name.is_empty() {
            if name == "camera" { "Camera" } else { "Screen" }.to_string()
        } else {
            source.name.clone()
        };
        return Ok(ResolvedItem::Source {
            id: if name == "camera" { "camera" } else { "screen" },
            source: source.clone(),
            name: label,
        });
    }
    if let Some(&item) = OVERLAY_ITEMS.iter().find(|&&candidate| candidate == name) {
        return Ok(ResolvedItem::Overlay {
            id: item,
            name: overlay_item_label(item),
        });
    }
    if let Some(banner_id) = name.strip_prefix("banner:") {
        let Some(banner) = snapshot.banners.iter().find(|b| b.id == banner_id) else {
            return Err(copy::BANNER_MISSING.to_string());
        };
        return Ok(ResolvedItem::Banner {
            id: format!("banner:{}", banner.id),
            banner: banner.clone(),
            name: banner.name.clone(),
        });
    }
    Err(copy::NO_ITEM.to_string())
}

fn parse_size(value: Option<&Value>) -> Option<SceneSize> {
    match value? {
        Value::String(s) => match s.as_str() {
            "small" => Some(SceneSize::Small),
            "medium" => Some(SceneSize::Medium),
            "large" => Some(SceneSize::Large),
            _ => None,
        },
        Value::Number(n) => n
            .as_f64()
            .filter(|v| v.is_finite())
            .map(|v| SceneSize::Fraction(v.clamp(OVERLAY_RECT_MIN_SIZE, 1.0))),
        _ => None,
    }
}

fn parse_rect(value: Option<&Value>) -> Option<SceneRect> {
    let obj = value?.as_object()?;
    let x = obj.get("x")?.as_f64().filter(|v| v.is_finite())?;
    let y = obj.get("y")?.as_f64().filter(|v| v.is_finite())?;
    let width = obj.get("width")?.as_f64().filter(|v| v.is_finite())?;
    let height = obj.get("height")?.as_f64().filter(|v| v.is_finite())?;
    Some(SceneRect {
        x,
        y,
        width,
        height,
    })
}

fn place_label(place: &str) -> String {
    if place == "full-frame" {
        "the full frame".to_string()
    } else {
        format!("the {}", place.replace('-', " "))
    }
}

fn cover_sentence(overlaps: &[OverlapEntry]) -> String {
    if overlaps.is_empty() {
        String::new()
    } else {
        let names = overlaps
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        format!(" Now covers: {names}.")
    }
}

impl<B: StudioBackend> Studio<B> {
    async fn read_arrange_snapshot(&self) -> Result<ArrangeSnapshot, String> {
        if !self.is_connected() {
            return Err(inspector_copy::OFFLINE_LOCK_REASON.to_string());
        }
        let snapshot = self.snapshot();
        let layout = snapshot.settings.capture_doc["layout"].clone();
        let preset = layout
            .get("layoutPreset")
            .and_then(Value::as_str)
            .unwrap_or("screen-camera");
        let orientation = if capture_config::layout_preset_is_vertical(preset) {
            "vertical"
        } else {
            "horizontal"
        };
        let video = &snapshot.settings.capture.video;
        let canvas_aspect_h = if orientation == "horizontal" && video.height > 0 {
            f64::from(video.width) / f64::from(video.height)
        } else {
            16.0 / 9.0
        };
        let canvas_aspect_v = if orientation == "vertical" && video.height > 0 {
            f64::from(video.width) / f64::from(video.height)
        } else {
            9.0 / 16.0
        };
        let vertical_stream = snapshot
            .settings
            .capture_doc
            .get("streaming")
            .and_then(|s| s.get("targets"))
            .and_then(Value::as_array)
            .is_some_and(|targets| {
                targets.iter().any(|t| {
                    t.get("enabled").and_then(Value::as_bool) == Some(true)
                        && t.get("orientation").and_then(Value::as_str) == Some("vertical")
                })
            });
        let overlay_layout = self
            .overlay_layout()
            .await
            .unwrap_or_else(|_| default_overlay_layout_json());
        let banners_val = self.banners().await.unwrap_or_else(|_| json!([]));
        let banners: Vec<Banner> = serde_json::from_value(banners_val).unwrap_or_default();
        Ok(ArrangeSnapshot {
            orientation,
            vertical_stream,
            layout,
            scene: snapshot.sources.scene.clone(),
            overlay_layout,
            banners,
            canvas_aspect_h,
            canvas_aspect_v,
            session_active: self.session_owns_transport(),
            start_time_overlays: cfg!(target_os = "windows"),
        })
    }

    pub(super) async fn agent_get_scene_layout(&self) -> AgentIntentOutcome {
        let arrange = match self.read_arrange_snapshot().await {
            Ok(arrange) => arrange,
            Err(message) => return AgentIntentOutcome::refused(message),
        };
        let view = arrange.layout_view();
        let names = view["items"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("name").and_then(Value::as_str))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        AgentIntentOutcome::ok(
            format!(
                "{} items on the picture: {}.",
                names.len(),
                names.join(", ")
            ),
            view,
        )
    }

    pub(super) async fn agent_move_on_scene(self: &Arc<Self>, args: &Value) -> AgentIntentOutcome {
        let arrange = match self.read_arrange_snapshot().await {
            Ok(arrange) => arrange,
            Err(message) => return AgentIntentOutcome::refused(message),
        };
        let target = match resolve_item(&arrange, args.get("item").and_then(Value::as_str)) {
            Ok(target) => target,
            Err(message) => return AgentIntentOutcome::refused(message),
        };
        let place = args
            .get("place")
            .and_then(Value::as_str)
            .filter(|candidate| SCENE_PLACES.contains(candidate));
        let size = parse_size(args.get("size"));
        let rect = parse_rect(args.get("rect"));
        let mut exact_h = None;
        let mut exact_v = None;
        if let Some(rects_obj) = args.get("rects").and_then(Value::as_object) {
            exact_h = parse_rect(rects_obj.get("horizontal"));
            exact_v = parse_rect(rects_obj.get("vertical"));
        }
        let mut exact_sides = Vec::new();
        if exact_h.is_some() {
            exact_sides.push("horizontal");
        }
        if exact_v.is_some() {
            exact_sides.push("vertical");
        }
        if place.is_none() && size.is_none() && rect.is_none() && exact_sides.is_empty() {
            return AgentIntentOutcome::refused(copy::MOVE_EMPTY);
        }
        if (rect.is_some() || !exact_sides.is_empty()) && (place.is_some() || size.is_some()) {
            return AgentIntentOutcome::refused(copy::RECT_OR_PLACE);
        }
        if place == Some("full-frame") && !matches!(target, ResolvedItem::Banner { .. }) {
            return AgentIntentOutcome::refused(copy::FULL_FRAME_BANNERS_ONLY);
        }

        let choice = args.get("orientation").and_then(Value::as_str);
        let sides: Vec<&'static str> = if !exact_sides.is_empty() {
            exact_sides
        } else if choice == Some("horizontal") {
            vec!["horizontal"]
        } else if choice == Some("vertical") {
            vec!["vertical"]
        } else if choice == Some("both") || rect.is_none() {
            vec!["horizontal", "vertical"]
        } else {
            vec!["horizontal"]
        };

        let is_source = matches!(target, ResolvedItem::Source { .. });
        let note = (arrange.session_active && arrange.start_time_overlays && !is_source)
            .then_some(copy::WINDOWS_NEXT_SESSION);

        match target {
            ResolvedItem::Overlay { id, name } => {
                let what = match place {
                    Some(place) => format!("Moved {name} to {}.", place_label(place)),
                    None => format!("Placed {name}."),
                };
                let mut previous = SceneRects::default();
                let mut rects = SceneRects::default();
                let mut layout = arrange.overlay_layout.clone();
                for side in &sides {
                    let vertical = *side == "vertical";
                    let current = overlay_rect_from_layout(&layout, id, side);
                    let exact_rect = if vertical { exact_v } else { exact_h }.or(rect);
                    let next = match exact_rect {
                        Some(r) => stage_rect_to_overlay(r),
                        None => overlay_placement(
                            id,
                            vertical,
                            &current,
                            place.filter(|p| *p != "full-frame"),
                            size,
                        ),
                    };
                    if vertical {
                        previous.vertical = Some(to_scene_rect(&current));
                        rects.vertical = Some(to_scene_rect(&next));
                    } else {
                        previous.horizontal = Some(to_scene_rect(&current));
                        rects.horizontal = Some(to_scene_rect(&next));
                    }
                    layout = with_overlay_rect(&layout, id, vertical, next);
                }
                if self.set_overlay_layout(layout.clone()).await.is_none() {
                    return AgentIntentOutcome::refused(copy::FAILED);
                }
                let mut after = arrange;
                after.overlay_layout = layout;
                let overlaps = after.overlaps(id);
                let sentence = note.unwrap_or(&what);
                AgentIntentOutcome::ok(
                    format!("{sentence}{}", cover_sentence(&overlaps)),
                    json!({
                        "item": id,
                        "name": name,
                        "rects": rects,
                        "previous": previous,
                        "overlaps": overlaps,
                    }),
                )
            }
            ResolvedItem::Banner { id, banner, name } => {
                let what = match place {
                    Some(place) => format!("Moved {name} to {}.", place_label(place)),
                    None => format!("Placed {name}."),
                };
                let mut previous = SceneRects::default();
                let mut rects = SceneRects::default();
                let mut patch = Map::new();
                let mut updated_banner = banner.clone();
                for side in &sides {
                    let vertical = *side == "vertical";
                    let exact_rect = if vertical { exact_v } else { exact_h }.or(rect);
                    let next = match exact_rect {
                        Some(r) => stage_rect_to_overlay(r),
                        None => banner_placement(
                            &banner,
                            vertical,
                            arrange.canvas_aspect(vertical),
                            place,
                            size,
                        ),
                    };
                    if vertical {
                        previous.vertical = Some(to_scene_rect(&banner.vertical));
                        rects.vertical = Some(to_scene_rect(&next));
                        updated_banner.vertical = next;
                    } else {
                        previous.horizontal = Some(to_scene_rect(&banner.horizontal));
                        rects.horizontal = Some(to_scene_rect(&next));
                        updated_banner.horizontal = next;
                    }
                    patch.insert(
                        (*side).to_string(),
                        json!({ "x": next.x, "y": next.y, "w": next.w, "h": next.h }),
                    );
                }
                if !self.patch_banner(&banner.id, patch).await {
                    return AgentIntentOutcome::refused(copy::FAILED);
                }
                let mut after = arrange;
                for entry in &mut after.banners {
                    if entry.id == banner.id {
                        *entry = updated_banner.clone();
                    }
                }
                let overlaps = after.overlaps(&id);
                let sentence = note.unwrap_or(&what);
                AgentIntentOutcome::ok(
                    format!("{sentence}{}", cover_sentence(&overlaps)),
                    json!({
                        "item": id,
                        "name": name,
                        "rects": rects,
                        "previous": previous,
                        "overlaps": overlaps,
                    }),
                )
            }
            ResolvedItem::Source { id, source, name } => {
                let what = match place {
                    Some(place) => format!("Moved {name} to {}.", place_label(place)),
                    None => format!("Placed {name}."),
                };
                let src_orient = layout_orientation(&arrange.layout);
                let vertical = src_orient == "vertical";
                let previous = if vertical {
                    SceneRects {
                        horizontal: None,
                        vertical: Some(source_rect(&source)),
                    }
                } else {
                    SceneRects {
                        horizontal: Some(source_rect(&source)),
                        vertical: None,
                    }
                };
                let controls = scene_camera_controls(&arrange.layout);
                if id == "camera"
                    && controls.corner
                    && let Some(corner) = place.filter(|p| CAMERA_CORNERS.contains(p))
                    && size.is_none()
                    && rect.is_none()
                    && exact_h.is_none()
                    && exact_v.is_none()
                {
                    if !self.snap_camera_corner(corner).await {
                        return AgentIntentOutcome::refused(copy::FAILED);
                    }
                    let cornered =
                        preset_corner_rect(&arrange.layout, source_rect(&source), corner);
                    let after = match cornered {
                        Some(r) => {
                            let mut map = BTreeMap::new();
                            map.insert(source.id.clone(), r);
                            arrange.with_source_rects(&map)
                        }
                        None => self.read_arrange_snapshot().await.unwrap_or(arrange),
                    };
                    let cam_rect = scene_source(after.scene.as_ref(), "camera").map(source_rect);
                    let rects = match (vertical, cam_rect) {
                        (true, Some(r)) => SceneRects {
                            horizontal: None,
                            vertical: Some(r),
                        },
                        (false, Some(r)) => SceneRects {
                            horizontal: Some(r),
                            vertical: None,
                        },
                        (_, None) => SceneRects::default(),
                    };
                    let overlaps = after.overlaps("camera");
                    return AgentIntentOutcome::ok(
                        format!(
                            "Moved {name} to {}.{}",
                            place_label(corner),
                            cover_sentence(&overlaps)
                        ),
                        json!({
                            "item": "camera",
                            "name": name,
                            "rects": rects,
                            "previous": previous,
                            "overlaps": overlaps,
                            "arrangement": "preset",
                            "corner": corner,
                        }),
                    );
                }

                if arrange.session_active {
                    return AgentIntentOutcome::refused(copy::SOURCE_MOVE_LIVE);
                }
                let mut current = arrange;
                if !controls.freeform {
                    let Some(scene) = current.scene.as_ref() else {
                        return AgentIntentOutcome::refused(copy::FAILED);
                    };
                    let memory = self.remembered_freeform();
                    let overrides = freeform_entry_overrides(
                        &memory,
                        src_orient,
                        &scene.sources,
                        source_override,
                    );
                    let mut entry_patch = Map::new();
                    entry_patch.insert("arrangementMode".into(), json!("freeform"));
                    entry_patch.insert(
                        "sourceTransformOverrides".into(),
                        Value::Object(overrides.clone()),
                    );
                    if !self.apply_layout_patch(entry_patch).await {
                        return AgentIntentOutcome::refused(copy::FAILED);
                    }
                    let mut map = BTreeMap::new();
                    for (sid, val) in &overrides {
                        if let Some(r) = parse_rect(Some(val)) {
                            map.insert(sid.clone(), r);
                        }
                    }
                    current = current.with_source_rects(&map);
                }
                let Some(live_source) = current
                    .scene
                    .as_ref()
                    .and_then(|scene| scene.sources.iter().find(|s| s.id == source.id))
                    .cloned()
                else {
                    return AgentIntentOutcome::refused(copy::FAILED);
                };
                let exact_rect = if vertical { exact_v } else { exact_h }
                    .or(rect)
                    .or(exact_h)
                    .or(exact_v);
                let next = source_placement(
                    &live_source,
                    vertical,
                    place.filter(|p| *p != "full-frame"),
                    size,
                    exact_rect,
                );
                let commit_patch = json!({
                    "x": next.x,
                    "y": next.y,
                    "width": next.width,
                    "height": next.height,
                });
                if self
                    .commit_source_transform(&live_source.id, commit_patch)
                    .await
                    .is_none()
                {
                    return AgentIntentOutcome::refused(copy::FAILED);
                }
                let mut map = BTreeMap::new();
                map.insert(live_source.id.clone(), next);
                let overlaps = current.with_source_rects(&map).overlaps(id);
                let rects = if vertical {
                    SceneRects {
                        horizontal: None,
                        vertical: Some(next),
                    }
                } else {
                    SceneRects {
                        horizontal: Some(next),
                        vertical: None,
                    }
                };
                AgentIntentOutcome::ok(
                    format!("{what}{}", cover_sentence(&overlaps)),
                    json!({
                        "item": id,
                        "name": name,
                        "rects": rects,
                        "previous": previous,
                        "overlaps": overlaps,
                        "arrangement": "freeform",
                    }),
                )
            }
        }
    }

    pub(super) async fn agent_set_scene_item(self: &Arc<Self>, args: &Value) -> AgentIntentOutcome {
        let arrange = match self.read_arrange_snapshot().await {
            Ok(arrange) => arrange,
            Err(message) => return AgentIntentOutcome::refused(message),
        };
        let target = match resolve_item(&arrange, args.get("item").and_then(Value::as_str)) {
            Ok(target) => target,
            Err(message) => return AgentIntentOutcome::refused(message),
        };
        let shown = args.get("shown").and_then(Value::as_bool);
        let shape = args
            .get("shape")
            .and_then(Value::as_str)
            .filter(|s| matches!(*s, "rectangle" | "rounded" | "circle"));
        let show_on_stream = args.get("showOnStream").and_then(Value::as_bool);
        let show_in_recording = args.get("showInRecording").and_then(Value::as_bool);
        let has_switches = show_on_stream.is_some() || show_in_recording.is_some();

        if shown.is_none() && shape.is_none() && !has_switches {
            return AgentIntentOutcome::refused(copy::SET_EMPTY);
        }
        if shape.is_some() && !matches!(target, ResolvedItem::Source { id: "camera", .. }) {
            return AgentIntentOutcome::refused(copy::SHAPE_CAMERA_ONLY);
        }

        match target {
            ResolvedItem::Source { id, source, name } => {
                if has_switches {
                    return AgentIntentOutcome::refused(copy::SOURCE_SWITCHES);
                }
                let mut said = Vec::new();
                let mut result = json!({ "item": id, "name": name });
                if let Some(shape) = shape {
                    if !scene_camera_controls(&arrange.layout).bubble {
                        return AgentIntentOutcome::refused(copy::SHAPE_NOT_HERE);
                    }
                    if !self.apply_layout_patch(camera_shape_patch(shape)).await {
                        return AgentIntentOutcome::refused(copy::FAILED);
                    }
                    result["shape"] = json!(shape);
                    let word = if shape == "rounded" {
                        "rounded square"
                    } else {
                        shape
                    };
                    said.push(format!("The camera is a {word}."));
                }
                if let Some(shown) = shown {
                    if arrange.session_active {
                        said.push(inspector_copy::VISIBILITY_LOCK_REASON.to_string());
                        return AgentIntentOutcome::refused(said.join(" "));
                    }
                    if !self.set_source_visible(&source.id, shown).await {
                        said.push(copy::FAILED.to_string());
                        return AgentIntentOutcome::refused(said.join(" "));
                    }
                    result["shown"] = json!(shown);
                    said.push(if shown {
                        format!("{name} is shown.")
                    } else {
                        format!("{name} is hidden.")
                    });
                }
                AgentIntentOutcome::ok(said.join(" "), result)
            }
            ResolvedItem::Overlay { id: "captions", .. } if shown.is_some() || has_switches => {
                AgentIntentOutcome::refused(copy::CAPTIONS_SWITCHES)
            }
            ResolvedItem::Overlay { .. } if shown.is_some() => {
                AgentIntentOutcome::refused(copy::OVERLAY_SHOWN)
            }
            ResolvedItem::Banner { .. } if shown.is_some() => {
                AgentIntentOutcome::refused(copy::BANNER_SHOWN)
            }
            ResolvedItem::Overlay { id, name } => {
                let mut next = arrange.overlay_layout.clone();
                if let Some(on) = show_on_stream {
                    next[id]["showOnStream"] = json!(on);
                }
                if let Some(on) = show_in_recording {
                    next[id]["showInRecording"] = json!(on);
                }
                if self.set_overlay_layout(next).await.is_none() {
                    return AgentIntentOutcome::refused(copy::FAILED);
                }
                finish_switches_outcome(
                    id,
                    name,
                    show_on_stream,
                    show_in_recording,
                    arrange.session_active && arrange.start_time_overlays,
                )
            }
            ResolvedItem::Banner { id, banner, name } => {
                let mut patch = Map::new();
                if let Some(on) = show_on_stream {
                    patch.insert("showOnStream".into(), json!(on));
                }
                if let Some(on) = show_in_recording {
                    patch.insert("showInRecording".into(), json!(on));
                }
                if !self.patch_banner(&banner.id, patch).await {
                    return AgentIntentOutcome::refused(copy::FAILED);
                }
                finish_switches_outcome(
                    &id,
                    &name,
                    show_on_stream,
                    show_in_recording,
                    arrange.session_active && arrange.start_time_overlays,
                )
            }
        }
    }
}

fn finish_switches_outcome(
    item: &str,
    name: &str,
    show_on_stream: Option<bool>,
    show_in_recording: Option<bool>,
    windows_next_session: bool,
) -> AgentIntentOutcome {
    let mut result = json!({ "item": item, "name": name });
    let mut said = Vec::new();
    if let Some(on) = show_on_stream {
        result["showOnStream"] = json!(on);
        said.push(if on {
            format!("{name} shows on stream.")
        } else {
            format!("{name} stays off the stream.")
        });
    }
    if let Some(on) = show_in_recording {
        result["showInRecording"] = json!(on);
        said.push(if on {
            format!("{name} shows in the recording.")
        } else {
            format!("{name} stays out of the recording.")
        });
    }
    let message = if windows_next_session {
        copy::WINDOWS_NEXT_SESSION.to_string()
    } else {
        said.join(" ")
    };
    AgentIntentOutcome::ok(message, result)
}

fn default_overlay_layout_json() -> Value {
    let entry = |item: &str, on_stream: bool, in_rec: bool| {
        let (hw, hh) = overlay_default_size(item, false);
        let (hx, hy) = overlay_place_origin("bottom-left", false, hw, hh);
        let (vw, vh) = overlay_default_size(item, true);
        let (vx, vy) = overlay_place_origin("bottom-center", true, vw, vh);
        json!({
            "horizontal": { "x": hx, "y": hy, "w": hw, "h": hh },
            "vertical": { "x": vx, "y": vy, "w": vw, "h": vh },
            "showOnStream": on_stream,
            "showInRecording": in_rec,
        })
    };
    json!({
        "highlight": entry("highlight", true, true),
        "captions": entry("captions", false, false),
        "buddy": entry("buddy", true, true),
        "chat": entry("chat", false, false),
    })
}
