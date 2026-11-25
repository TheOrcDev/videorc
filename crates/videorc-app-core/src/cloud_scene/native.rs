//! Native resolved scene → cloud roles (`cloud-scene-native.ts`).

use serde_json::Value;
use videorc_protocol::{Scene, SceneSource, SceneSourceKind};

use super::parse::{default_scene_guests, parse_cloud_scene_extension, scene_content_key_parts};
use super::types::{
    CloudScene, SceneCrop, SceneFit, SceneItem, SceneMask, SceneOrientation, SceneRect, SceneRole,
};
use crate::editor::stage::{
    PictureFit, StageRect, background_stage_margin, effective_camera_mask_shape, layer_fit,
    scene_camera_on_stage, scene_stage_rect,
};

/// Why a native source was not translated into a cloud role.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudSceneSkipReason {
    TestPattern,
    Hidden,
}

/// A source the room cannot show, named, never silently dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudSceneSkip {
    pub source_id: String,
    pub reason: CloudSceneSkipReason,
}

/// Translation of a native engine scene into cloud roles.
#[derive(Debug, Clone, PartialEq)]
pub struct CloudSceneTranslation {
    pub scene: CloudScene,
    pub skipped: Vec<CloudSceneSkip>,
    pub needs: CloudSceneNeeds,
}

/// Which room tracks the translated scene requires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloudSceneNeeds {
    pub camera: bool,
    pub screen: bool,
}

fn mask_of(source: &SceneSource, layout: &Value) -> SceneMask {
    if source.kind != SceneSourceKind::Camera {
        return SceneMask::Rectangle;
    }
    match effective_camera_mask_shape(layout).as_str() {
        "circle" => SceneMask::Circle,
        "rounded" => {
            let pct = layout
                .get("cameraCornerRadiusPct")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .clamp(0.0, 50.0);
            SceneMask::Rounded {
                radius: pct / 100.0,
            }
        }
        _ => SceneMask::Rectangle,
    }
}

fn scene_fit(fit: PictureFit) -> SceneFit {
    match fit {
        PictureFit::Contain => SceneFit::Contain,
        PictureFit::Cover => SceneFit::Cover,
    }
}

/// A scene the native engine resolved as cloud roles.
///
/// Geometry is the native engine's own: frames and crops are copied, the
/// background stage margin is applied with [`scene_stage_rect`], and fit,
/// mask and mirror use the same rules every native render path depicts.
pub fn cloud_scene_from_native(
    scene: &Scene,
    layout: &Value,
    background: Option<&Value>,
    orientation: SceneOrientation,
    extension: Option<&Value>,
) -> CloudSceneTranslation {
    let margin = background_stage_margin(background);
    let kinds: Vec<SceneSourceKind> = scene.sources.iter().map(|s| s.kind.clone()).collect();
    let camera_on_stage = scene_camera_on_stage(&kinds, layout);
    let mut items = Vec::new();
    let mut skipped = Vec::new();
    for (z, source) in scene.sources.iter().enumerate() {
        if !source.visible {
            skipped.push(CloudSceneSkip {
                source_id: source.id.clone(),
                reason: CloudSceneSkipReason::Hidden,
            });
            continue;
        }
        if source.kind == SceneSourceKind::TestPattern {
            skipped.push(CloudSceneSkip {
                source_id: source.id.clone(),
                reason: CloudSceneSkipReason::TestPattern,
            });
            continue;
        }
        let t = &source.transform;
        let staged = scene_stage_rect(
            StageRect::new(t.x, t.y, t.width, t.height),
            &source.kind,
            margin,
            camera_on_stage,
        );
        let camera = source.kind == SceneSourceKind::Camera;
        items.push(SceneItem {
            role: if camera {
                SceneRole::HostCamera
            } else {
                SceneRole::Screen
            },
            rect: SceneRect {
                x: staged.x,
                y: staged.y,
                w: staged.width,
                h: staged.height,
            },
            crop: SceneCrop {
                l: t.crop_left,
                t: t.crop_top,
                r: t.crop_right,
                b: t.crop_bottom,
            },
            fit: scene_fit(layer_fit(&source.kind, layout)),
            mirror: camera && layout.get("cameraMirror") == Some(&Value::Bool(true)),
            mask: mask_of(source, layout),
            z: z as i64,
        });
    }
    let guests = parse_cloud_scene_extension(extension.unwrap_or(&Value::Null))
        .map(|ext| ext.guests)
        .unwrap_or_else(|| default_scene_guests(orientation));
    let id = scene_content_key_parts(&items, &guests, None);
    let needs = CloudSceneNeeds {
        camera: items.iter().any(|item| item.role == SceneRole::HostCamera),
        screen: items.iter().any(|item| item.role == SceneRole::Screen),
    };
    CloudSceneTranslation {
        scene: CloudScene {
            id,
            items,
            guests,
            background: None,
        },
        skipped,
        needs,
    }
}
