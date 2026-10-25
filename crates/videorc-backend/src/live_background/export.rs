//! The generated desktop JSON (plan 190): Rust owns the catalogue, the uniform
//! packing and the size rules; the desktop reads them from two generated files
//! instead of re-deriving them.
//!
//! - `live-backgrounds.catalog.generated.json`: ids, names, looks and poster
//!   asset ids (the Assets page and main's poster registration).
//! - `live-backgrounds.render.generated.json`: rates, poster phases, packed
//!   per-look uniforms, the GLSL per pass (with each pass's kind and, for an
//!   instanced pass, its vertex shader and per-look instance counts) and
//!   size cases the JS runner must reproduce (the Electron previews and the
//!   S1 cost probe).
//!
//! Regenerate with
//! `VIDEORC_UPDATE_LIVE_BACKGROUND_JSON=1 cargo test -p videorc-backend live_background::export`.

use std::path::PathBuf;

use serde_json::{Value, json};

use super::glsl::{PassBlend, PassKind, VERTEX, fragment_source, passes, vertex_source};
use super::guard::GuardLevel;
use super::looks::{
    ALL_LIVE_BACKGROUNDS, BASE_COLOR, UNIFORM_VEC4_COUNT, css_id, display_name,
    ferrofluid_look_camera, ghost_fibers_instances, is_soft, looks, poster_asset_id,
};
use super::sizes::{
    BEAMS_FIELD_SCALE, BEAMS_MAX_FIELD_PIXELS, FERROFLUID_BOUND_CELL, FERROFLUID_CELL,
    FERROFLUID_MAX_SHORT_SIDE, PLASMA_MAX_LIGHT_PIXELS, SOFT_MAX_SHORT_SIDE, beams_field_size,
    dither_cell, dither_field_size, ferrofluid_grid, ghost_fibers_bloom_sizes, internal_size,
    plasma_sizes, silk_field_size,
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
    for id in [
        LiveBackgroundId::Silk,
        LiveBackgroundId::LineWaves,
        LiveBackgroundId::Dither,
        LiveBackgroundId::Ferrofluid,
    ] {
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
    // Plan 194: Beams' field (3840 × 2160 never reaches it, but 2560 × 1440
    // proves the cap), Dither's cells per look, Ferrofluid's grid per look
    // and aspect, Ghost Fibers' bloom chain.
    let beams = [(1920, 1080), (1080, 1920), (2560, 1440), (960, 540)]
        .iter()
        .map(|view| {
            let field = beams_field_size(*view);
            json!({ "view": [view.0, view.1], "field": [field.0, field.1] })
        })
        .collect::<Vec<_>>();
    let dither = [
        (1920, 1080),
        (1080, 1920),
        (3840, 2160),
        (2560, 1440),
        (1280, 720),
    ]
    .iter()
    .flat_map(|view| {
        looks(LiveBackgroundId::Dither).iter().map(|look| {
            let pixel_size = look.statics[1][2];
            let field = dither_field_size(*view, pixel_size);
            json!({
                "view": [view.0, view.1],
                "look": look.id,
                "cell": dither_cell(*view, pixel_size),
                "field": [field.0, field.1],
            })
        })
    })
    .collect::<Vec<_>>();
    let ferrofluid = views
        .iter()
        .flat_map(|view| {
            looks(LiveBackgroundId::Ferrofluid).iter().map(|look| {
                let grid = ferrofluid_grid(&ferrofluid_look_camera(look), *view);
                json!({
                    "view": [view.0, view.1],
                    "look": look.id,
                    "origin": [grid.origin.0, grid.origin.1],
                    "size": [grid.size.0, grid.size.1],
                    "bound": [grid.bound.0, grid.bound.1],
                })
            })
        })
        .collect::<Vec<_>>();
    let ghost_fibers = views
        .iter()
        .map(|view| {
            let bloom = ghost_fibers_bloom_sizes(*view);
            json!({
                "view": [view.0, view.1],
                "bloom": bloom.iter().map(|size| [size.0, size.1]).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "internal": cases,
        "plasma": plasma,
        "silkField": silk,
        "beamsField": beams,
        "dither": dither,
        "ferrofluid": ferrofluid,
        "ghostFibersBloom": ghost_fibers,
    })
}

fn pass_entry(pass: super::glsl::LivePass, look: &super::looks::LiveLook) -> Value {
    let mut entry = json!({
        "key": pass.key(),
        "clears": pass.clears_target(),
    });
    match pass.kind(look) {
        PassKind::FullScreen => {
            entry["kind"] = json!("full-screen");
        }
        PassKind::Instanced {
            vertices, blend, ..
        } => {
            entry["kind"] = json!("instanced");
            entry["vertices"] = json!(vertices);
            entry["blend"] = json!(match blend {
                PassBlend::Replace => "replace",
                PassBlend::Additive => "additive",
            });
            entry["vertexShader"] = Value::String(vertex_source(pass).into_owned());
        }
    }
    entry
}

fn render() -> Value {
    json!({
        "_generated": "By crates/videorc-backend/src/live_background/export.rs. Do not edit.",
        "uniformVec4Count": UNIFORM_VEC4_COUNT,
        "baseColor": BASE_COLOR,
        "softMaxShortSide": SOFT_MAX_SHORT_SIDE,
        "ferrofluidMaxShortSide": FERROFLUID_MAX_SHORT_SIDE,
        "plasmaMaxLightPixels": PLASMA_MAX_LIGHT_PIXELS,
        "beamsFieldScale": BEAMS_FIELD_SCALE,
        "beamsMaxFieldPixels": BEAMS_MAX_FIELD_PIXELS,
        "ferrofluidCell": FERROFLUID_CELL,
        "ferrofluidBoundCell": FERROFLUID_BOUND_CELL,
        "vertex": VERTEX,
        "backgrounds": ALL_LIVE_BACKGROUNDS.iter().map(|id| json!({
            "id": css_id(*id),
            "soft": is_soft(*id),
            "shaders": passes(*id).iter().map(|pass| (
                pass.key().to_string(),
                Value::String(fragment_source(*pass).into_owned()),
            )).collect::<serde_json::Map<_, _>>(),
            // The passes in render order with their kind; an instanced
            // pass's vertex shader rides here (the first look stands in for
            // the kind, which never differs between looks).
            "passes": passes(*id).iter().map(|pass| pass_entry(*pass, &looks(*id)[0])).collect::<Vec<_>>(),
            "looks": looks(*id).iter().map(|look| {
                let mut entry = json!({
                    "id": look.id,
                    "rate": look.rate,
                    "posterPhase": look.poster_phase,
                    "statics": look.statics,
                });
                if *id == LiveBackgroundId::GhostFibers {
                    let instances = ghost_fibers_instances(look);
                    entry["instances"] = json!({ "dots": instances.dots, "dust": instances.dust });
                }
                entry
            }).collect::<Vec<_>>(),
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
        (
            LiveBackgroundId::GhostFibers,
            "fiber",
            (1920, 1080),
            (1920, 1080),
            9.0,
            0.0,
        ),
        (
            LiveBackgroundId::Ferrofluid,
            "ember",
            (139, 92),
            (1920, 1080),
            5.0,
            0.2,
        ),
        (
            LiveBackgroundId::ColorBends,
            "ocean",
            (1080, 1920),
            (1080, 1920),
            3.0,
            0.0,
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
