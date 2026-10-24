//! The generated desktop JSON (plan 190): Rust owns the catalogue, the uniform
//! packing and the size rules; the desktop reads them from two generated files
//! instead of re-deriving them.
//!
//! - `live-backgrounds.catalog.generated.json`: ids, names, looks and poster
//!   asset ids (the Assets page and main's poster registration).
//! - `live-backgrounds.render.generated.json`: rates, poster phases, packed
//!   per-look uniforms, the GLSL per pass and size cases the JS runner must
//!   reproduce (the Electron previews and the S1 cost probe).
//!
//! Regenerate with
//! `VIDEORC_UPDATE_LIVE_BACKGROUND_JSON=1 cargo test -p videorc-backend live_background::export`.

use std::path::PathBuf;

use serde_json::{Value, json};

use super::glsl::{VERTEX, fragment_source, passes};
use super::guard::GuardLevel;
use super::looks::{
    ALL_LIVE_BACKGROUNDS, BASE_COLOR, UNIFORM_VEC4_COUNT, css_id, display_name, is_soft, looks,
    poster_asset_id,
};
use super::sizes::{
    PLASMA_MAX_LIGHT_PIXELS, SOFT_MAX_SHORT_SIDE, internal_size, plasma_sizes, silk_field_size,
};
use crate::protocol::LiveBackgroundId;

fn desktop_shared(file: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/src/shared")
        .join(file)
}

fn catalog() -> Value {
    json!({
        "_generated": "By crates/videorc-backend/src/live_background/export.rs. Do not edit.",
        "backgrounds": ALL_LIVE_BACKGROUNDS.iter().map(|id| json!({
            "id": css_id(*id),
            "name": display_name(*id),
            "looks": looks(*id).iter().map(|look| json!({
                "id": look.id,
                "name": look.name,
                "posterAssetId": poster_asset_id(*id, look.id),
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

fn size_cases() -> Value {
    let outputs = [
        (1920, 1080),
        (1080, 1920),
        (3840, 2160),
        (2560, 1440),
        (1280, 720),
    ];
    let mut cases = Vec::new();
    for id in [LiveBackgroundId::Silk, LiveBackgroundId::LineWaves] {
        for output in outputs {
            for (level, name) in [(GuardLevel::Full, "full"), (GuardLevel::Half, "half")] {
                let view = internal_size(id, output, level);
                cases.push(json!({
                    "id": css_id(id),
                    "output": [output.0, output.1],
                    "level": name,
                    "view": [view.0, view.1],
                }));
            }
        }
    }
    let views = [(1920, 1080), (1080, 1920), (960, 540), (1280, 720)];
    let plasma = views
        .iter()
        .map(|view| {
            let sizes = plasma_sizes(*view);
            json!({
                "view": [view.0, view.1],
                "coarse": [sizes.coarse.0, sizes.coarse.1],
                "fine": [sizes.fine.0, sizes.fine.1],
                "down": sizes.down.iter().map(|size| [size.0, size.1]).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    let silk = views
        .iter()
        .map(|view| {
            let field = silk_field_size(*view);
            json!({ "view": [view.0, view.1], "field": [field.0, field.1] })
        })
        .collect::<Vec<_>>();
    json!({ "internal": cases, "plasma": plasma, "silkField": silk })
}

fn render() -> Value {
    json!({
        "_generated": "By crates/videorc-backend/src/live_background/export.rs. Do not edit.",
        "uniformVec4Count": UNIFORM_VEC4_COUNT,
        "baseColor": BASE_COLOR,
        "softMaxShortSide": SOFT_MAX_SHORT_SIDE,
        "plasmaMaxLightPixels": PLASMA_MAX_LIGHT_PIXELS,
        "vertex": VERTEX,
        "backgrounds": ALL_LIVE_BACKGROUNDS.iter().map(|id| json!({
            "id": css_id(*id),
            "soft": is_soft(*id),
            "shaders": passes(*id).iter().map(|pass| (
                pass.key().to_string(),
                Value::String(fragment_source(*pass).into_owned()),
            )).collect::<serde_json::Map<_, _>>(),
            "looks": looks(*id).iter().map(|look| json!({
                "id": look.id,
                "rate": look.rate,
                "posterPhase": look.poster_phase,
                "statics": look.statics,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "sizeCases": size_cases(),
        "uniformCases": uniform_cases(),
    })
}

/// Packed uniforms the JS runner must reproduce exactly.
fn uniform_cases() -> Value {
    let cases = [
        (
            LiveBackgroundId::Silk,
            "midnight",
            (480, 270),
            (1920, 1080),
            3.25,
            0.4,
        ),
        (
            LiveBackgroundId::LineWaves,
            "aurora",
            (3840, 2160),
            (3840, 2160),
            120.5,
            0.0,
        ),
        (
            LiveBackgroundId::PlasmaWave,
            "glacier",
            (640, 360),
            (1920, 1080),
            6.0,
            0.95,
        ),
    ];
    cases
        .iter()
        .map(|(id, look, target, view, phase, dim)| {
            let (resolved, _) = super::looks::look_or_first(*id, look);
            json!({
                "id": css_id(*id),
                "look": look,
                "target": [target.0, target.1],
                "view": [view.0, view.1],
                "phase": phase,
                "dim": dim,
                "packed": super::looks::uniforms(resolved, *target, *view, *phase, *dim as f32),
            })
        })
        .collect()
}

fn check_or_write(file: &str, value: Value) {
    let path = desktop_shared(file);
    let text = format!("{}\n", serde_json::to_string_pretty(&value).unwrap());
    if std::env::var("VIDEORC_UPDATE_LIVE_BACKGROUND_JSON").as_deref() == Ok("1") {
        std::fs::write(&path, &text).unwrap();
        return;
    }
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        current == text,
        "{} is stale. Regenerate with VIDEORC_UPDATE_LIVE_BACKGROUND_JSON=1 cargo test -p videorc-backend live_background::export",
        path.display()
    );
}

#[test]
fn the_desktop_catalog_json_is_current() {
    check_or_write("live-backgrounds.catalog.generated.json", catalog());
}

#[test]
fn the_desktop_render_json_is_current() {
    check_or_write("live-backgrounds.render.generated.json", render());
}
