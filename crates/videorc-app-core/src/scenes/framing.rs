//! What a scene switch carries beside the layout (`lib/capture.ts`,
//! `lib/layout-framing-memory.ts`): each built-in layout's own camera
//! framing, each orientation's last scene, and the off-air coupling of a
//! vertical scene to a portrait canvas.

use serde_json::{Map, Value, json};

use crate::studio::capture_config::{
    coerce_video_to_orientation, layout_preset_is_vertical, video_preset,
};
use crate::studio::js_value::{finite_number, get, number_value, string};

/// `defaultCaptureConfig.video`'s preset.
const DEFAULT_VIDEO_PRESET: &str = "tutorial-1080p30";

/// `framing(raw)`: the camera's zoom and offsets, clamped.
fn framing(raw: Option<&Value>) -> Value {
    let candidate = raw.filter(|value| value.is_object());
    let clamp = |name: &str, fallback: f64, min: f64, max: f64| {
        number_value(
            finite_number(get(candidate, name)).map_or(fallback, |value| value.clamp(min, max)),
        )
    };
    json!({
        "cameraZoom": clamp("cameraZoom", 100.0, 100.0, 200.0),
        "cameraOffsetX": clamp("cameraOffsetX", 0.0, -100.0, 100.0),
        "cameraOffsetY": clamp("cameraOffsetY", 0.0, -100.0, 100.0),
    })
}

/// `rememberLayoutFraming`: the layout's framing becomes its preset's.
pub fn remember_layout_framing(memory: &Value, layout: &Value) -> Value {
    let mut layouts = get(Some(memory), "layouts")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(preset) = string(layout.get("layoutPreset")) {
        layouts.insert(preset.to_string(), framing(Some(layout)));
    }
    json!({"version": 1, "layouts": layouts})
}

/// `recalledLayoutFraming`: switching to another preset brings back its own
/// framing; staying puts back nothing.
pub fn recalled_layout_framing(memory: &Value, current: &str, target: &str) -> Map<String, Value> {
    if current == target {
        return Map::new();
    }
    get(get(Some(memory), "layouts"), target)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// `layoutPresetMemoryPatch`: the preset becomes its orientation's last
/// scene.
pub fn layout_preset_memory_patch(preset: &str) -> (&'static str, Value) {
    if layout_preset_is_vertical(preset) {
        ("lastVerticalPreset", json!(preset))
    } else {
        ("lastHorizontalPreset", json!(preset))
    }
}

/// `ORIENTATION_DEFAULT_PRESET` (plan 231 D4): the layout an orientation
/// starts on when nothing else names one. The 16:9 / 9:16 toggle names the
/// orientation with it, and the scene on stream goes on in its own layout
/// for that orientation.
pub fn orientation_default_preset(vertical: bool) -> &'static str {
    if vertical {
        "vertical-camera-top"
    } else {
        "screen-camera"
    }
}

fn dimension(video: &Value, key: &str) -> f64 {
    finite_number(video.get(key)).unwrap_or(f64::NAN)
}

/// `verticalTwinVideo`: the named portrait preset for a 1920×1080 30 fps
/// canvas, else the canvas turned portrait.
pub fn vertical_twin_video(video: &Value) -> Value {
    let named = video_preset("vertical-1080x1920").unwrap_or(Value::Null);
    if dimension(video, "width") == dimension(&named, "height")
        && dimension(video, "height") == dimension(&named, "width")
        && dimension(video, "fps") == dimension(&named, "fps")
    {
        return named;
    }
    coerce_video_to_orientation(video, true)
}

/// `verticalOrientationVideoPatch`: entering a vertical scene off air flips
/// the canvas to its portrait twin and remembers the landscape one; leaving
/// restores it. Nothing within an orientation, for a canvas the streamer
/// already made portrait (entering) or landscape (leaving). Answers the
/// video and `verticalRestoreVideo`.
pub fn vertical_orientation_video_patch(
    from_preset: &str,
    to_preset: &str,
    video: &Value,
    vertical_restore_video: &Value,
) -> Option<(Value, Value)> {
    let from_vertical = layout_preset_is_vertical(from_preset);
    let to_vertical = layout_preset_is_vertical(to_preset);
    if from_vertical == to_vertical {
        return None;
    }
    let portrait = dimension(video, "height") > dimension(video, "width");
    if to_vertical {
        if portrait {
            return None;
        }
        return Some((vertical_twin_video(video), video.clone()));
    }
    if !portrait {
        return Some((video.clone(), Value::Null));
    }
    let restored = if vertical_restore_video.is_null() {
        video_preset(DEFAULT_VIDEO_PRESET).unwrap_or(Value::Null)
    } else {
        vertical_restore_video.clone()
    };
    Some((restored, Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_layout_keeps_its_own_framing() {
        let memory = json!({"version": 1, "layouts": {"screen-camera": {"cameraZoom": 100, "cameraOffsetX": 0, "cameraOffsetY": 0}}});
        let remembered = remember_layout_framing(
            &memory,
            &json!({"layoutPreset": "camera-only", "cameraZoom": 300, "cameraOffsetX": 4}),
        );
        assert_eq!(
            remembered["layouts"]["camera-only"],
            json!({"cameraZoom": 200, "cameraOffsetX": 4, "cameraOffsetY": 0})
        );
        assert!(recalled_layout_framing(&remembered, "camera-only", "camera-only").is_empty());
        assert_eq!(
            recalled_layout_framing(&remembered, "screen-camera", "camera-only")["cameraZoom"],
            200
        );
    }

    #[test]
    fn a_vertical_scene_flips_the_canvas_off_air_and_back() {
        let landscape = video_preset("tutorial-1080p30").unwrap();
        let (portrait, restore) = vertical_orientation_video_patch(
            "screen-camera",
            "vertical-split",
            &landscape,
            &Value::Null,
        )
        .unwrap();
        assert_eq!(portrait["preset"], "vertical-1080x1920");
        assert_eq!(restore, landscape);
        let (back, cleared) =
            vertical_orientation_video_patch("vertical-split", "camera-only", &portrait, &restore)
                .unwrap();
        assert_eq!(back, landscape);
        assert_eq!(cleared, Value::Null);
        assert_eq!(
            vertical_orientation_video_patch(
                "screen-only",
                "camera-only",
                &landscape,
                &Value::Null
            ),
            None
        );
        assert_eq!(orientation_default_preset(true), "vertical-camera-top");
        assert_eq!(orientation_default_preset(false), "screen-camera");
        assert_eq!(
            layout_preset_memory_patch("vertical-split").0,
            "lastVerticalPreset"
        );
    }
}
