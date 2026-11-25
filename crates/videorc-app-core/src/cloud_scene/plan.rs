//! Plan tiles, picture placement, and transition motion.

use super::types::{
    CloudScene, SCENE_ENTER_SCALE, SCENE_MAX_GUEST_SLOTS, SceneCanvas, SceneCrop, SceneFit,
    SceneGuests, SceneMask, SceneMotionBox, ScenePicturePlacement, ScenePixelRect, SceneRect,
    SceneRole, SceneRoster, SceneSourceSize, SceneTile, SceneTileKind, SceneTileMask,
    SceneTransition, SceneTransitionKind,
};
use crate::studio::js_value;

/// JavaScript `Math.round`.
fn js_round(value: f64) -> f64 {
    js_value::round(value)
}

/// Like Rust `scene_source_rect_pixels`: rounded, at least one pixel a side.
pub fn scene_pixels(rect: SceneRect, canvas: SceneCanvas) -> ScenePixelRect {
    ScenePixelRect {
        x: js_round(rect.x * canvas.width),
        y: js_round(rect.y * canvas.height),
        w: js_round(rect.w * canvas.width).max(1.0),
        h: js_round(rect.h * canvas.height).max(1.0),
    }
}

/// `inner` (fractions of `outer`) placed into `outer` (fractions of the canvas).
pub fn scene_within(outer: SceneRect, inner: SceneRect) -> SceneRect {
    SceneRect {
        x: outer.x + inner.x * outer.w,
        y: outer.y + inner.y * outer.h,
        w: inner.w * outer.w,
        h: inner.h * outer.h,
    }
}

/// `Math.max(2, Math.floor(n) & ~1)`.
fn even_size(n: f64) -> f64 {
    let floor = n.floor() as i32;
    i32::max(2, floor & !1) as f64
}

/// Equal 16:9 cells for `count` guests in `region`, centred.
pub fn scene_guest_cells(region: ScenePixelRect, count: usize, gutter: f64) -> Vec<ScenePixelRect> {
    if count == 0 {
        return Vec::new();
    }
    let mut best_cols = 1_usize;
    let mut best_w = 0.0_f64;
    let mut best_h = 0.0_f64;
    for cols in 1..=count {
        let rows = count.div_ceil(cols) as f64;
        let cols_f = cols as f64;
        let cell_w = (region.w - gutter * (cols_f + 1.0)) / cols_f;
        let cell_h = (region.h - gutter * (rows + 1.0)) / rows;
        if cell_w <= 0.0 || cell_h <= 0.0 {
            continue;
        }
        let w = cell_w.min((cell_h * 16.0) / 9.0);
        if w > best_w + 0.5 {
            best_cols = cols;
            best_w = w;
            best_h = (w * 9.0) / 16.0;
        }
    }
    let w = even_size(best_w);
    let h = even_size(best_h);
    let cols = best_cols;
    let rows = count.div_ceil(cols);
    let block_h = (rows as f64) * h + ((rows.saturating_sub(1)) as f64) * gutter;
    let top = region.y + ((region.h - block_h) / 2.0).floor();
    let mut cells = Vec::with_capacity(count);
    for i in 0..count {
        let row = i / cols;
        let in_row = if row == rows - 1 {
            count - row * cols
        } else {
            cols
        };
        let row_w = (in_row as f64) * w + ((in_row.saturating_sub(1)) as f64) * gutter;
        let left = region.x + ((region.w - row_w) / 2.0).floor();
        cells.push(ScenePixelRect {
            x: left + ((i % cols) as f64) * (w + gutter),
            y: top + (row as f64) * (h + gutter),
            w,
            h,
        });
    }
    cells
}

fn tile_mask(mask: &SceneMask, rect: ScenePixelRect) -> SceneTileMask {
    match mask {
        SceneMask::Rectangle => SceneTileMask::Rectangle,
        SceneMask::Circle => SceneTileMask::Circle,
        SceneMask::Rounded { radius } => SceneTileMask::Rounded {
            radius_px: js_round(rect.w.min(rect.h) * radius),
        },
    }
}

const NO_CROP: SceneCrop = SceneCrop {
    l: 0.0,
    t: 0.0,
    r: 0.0,
    b: 0.0,
};

/// The tiles a scene draws on one canvas, low z first.
pub fn plan_scene_tiles(
    scene: &CloudScene,
    canvas: SceneCanvas,
    roster: &SceneRoster,
) -> Vec<SceneTile> {
    plan_scene_tiles_parts(&scene.items, &scene.guests, canvas, roster)
}

/// Plan from items + guests (fixture scenes omit `id`).
pub fn plan_scene_tiles_parts(
    items: &[super::types::SceneItem],
    guests_layout: &SceneGuests,
    canvas: SceneCanvas,
    roster: &SceneRoster,
) -> Vec<SceneTile> {
    let guests: Vec<&str> = roster
        .guests
        .iter()
        .take(SCENE_MAX_GUEST_SLOTS)
        .map(String::as_str)
        .collect();
    let area = if guests.is_empty() {
        SceneRect {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        }
    } else {
        guests_layout.host
    };
    let mut tiles = Vec::new();
    for item in items {
        if item.role == SceneRole::HostCamera && !roster.host_on_stage {
            continue;
        }
        if item.role == SceneRole::Screen && roster.screen.is_none() {
            continue;
        }
        let rect = scene_pixels(scene_within(area, item.rect), canvas);
        let (identity, kind, role) = match item.role {
            SceneRole::Screen => (
                roster.screen.clone().unwrap_or_default(),
                SceneTileKind::Screen,
                "screen".to_string(),
            ),
            SceneRole::HostCamera => (
                roster.host.clone(),
                SceneTileKind::Person,
                "host-camera".to_string(),
            ),
        };
        tiles.push(SceneTile {
            identity,
            kind,
            role,
            rect,
            crop: item.crop,
            fit: item.fit,
            mirror: item.mirror,
            mask: tile_mask(&item.mask, rect),
            z: item.z,
        });
    }
    let short = canvas.width.min(canvas.height);
    let gutter = (4.0_f64).max({
        let rounded = js_round((short * 24.0) / 1080.0) as i64;
        (rounded & !1) as f64
    });
    let radius = js_round((short * 20.0) / 1080.0);
    let explicit = guests.len().min(guests_layout.slots.len());
    let cells = scene_guest_cells(
        scene_pixels(guests_layout.region, canvas),
        guests.len() - explicit,
        gutter,
    );
    for (index, identity) in guests.iter().enumerate() {
        let rect = if index < explicit {
            scene_pixels(guests_layout.slots[index], canvas)
        } else {
            match cells.get(index - explicit).copied() {
                Some(rect) => rect,
                None => continue,
            }
        };
        tiles.push(SceneTile {
            identity: (*identity).to_string(),
            kind: SceneTileKind::Person,
            role: format!("guest:{index}"),
            rect,
            crop: NO_CROP,
            fit: SceneFit::Cover,
            mirror: false,
            mask: SceneTileMask::Rounded { radius_px: radius },
            z: 32 + index as i64,
        });
    }
    tiles.sort_by_key(|tile| tile.z);
    tiles
}

/// Where a picture of `source` pixels lands in its frame after crop and fit.
pub fn scene_picture(
    frame: ScenePixelRect,
    source: SceneSourceSize,
    crop: SceneCrop,
    fit: SceneFit,
) -> ScenePicturePlacement {
    let keep_w = (1.0 - crop.l - crop.r).max(0.05);
    let keep_h = (1.0 - crop.t - crop.b).max(0.05);
    let picture_w = (source.w * keep_w).max(1.0);
    let picture_h = (source.h * keep_h).max(1.0);
    let scale = match fit {
        SceneFit::Cover => (frame.w / picture_w).max(frame.h / picture_h),
        SceneFit::Contain => (frame.w / picture_w).min(frame.h / picture_h),
    };
    let w = picture_w * scale;
    let h = picture_h * scale;
    let picture = ScenePixelRect {
        x: frame.x + (frame.w - w) / 2.0,
        y: frame.y + (frame.h - h) / 2.0,
        w,
        h,
    };
    let full_w = w / keep_w;
    let full_h = h / keep_h;
    let full = ScenePixelRect {
        x: js_round(picture.x - crop.l * full_w),
        y: js_round(picture.y - crop.t * full_h),
        w: js_round(full_w),
        h: js_round(full_h),
    };
    let x0 = frame.x.max(picture.x);
    let y0 = frame.y.max(picture.y);
    let x1 = (frame.x + frame.w).min(picture.x + w);
    let y1 = (frame.y + frame.h).min(picture.y + h);
    let clip = ScenePixelRect {
        x: js_round(x0),
        y: js_round(y0),
        w: js_round(x1 - x0).max(1.0),
        h: js_round(y1 - y0).max(1.0),
    };
    ScenePicturePlacement { clip, full }
}

/// Rust `ease_in_out_cubic`: soft start, soft landing, no overshoot.
pub fn scene_ease(t: f64) -> f64 {
    let p = t.clamp(0.0, 1.0);
    if p < 0.5 {
        4.0 * p * p * p
    } else {
        1.0 - ((-2.0 * p + 2.0).powi(3)) / 2.0
    }
}

/// Transition progress 0..1 at wall time `now`; a cut is always 1.
pub fn scene_progress(transition: &SceneTransition, now: i64) -> f64 {
    if transition.kind == SceneTransitionKind::Cut || transition.duration_ms <= 0 {
        return 1.0;
    }
    ((now - transition.apply_at) as f64 / transition.duration_ms as f64).clamp(0.0, 1.0)
}

/// Rust `synthetic_enter_from`: a box with no predecessor grows from 92%.
pub fn scene_enter_from(to: ScenePixelRect) -> ScenePixelRect {
    let w = to.w * SCENE_ENTER_SCALE;
    let h = to.h * SCENE_ENTER_SCALE;
    ScenePixelRect {
        x: to.x + (to.w - w) / 2.0,
        y: to.y + (to.h - h) / 2.0,
        w,
        h,
    }
}

/// Rust `scene_with_transition` for one box: eased position, size and crop.
pub fn scene_motion(
    from: Option<SceneMotionBox>,
    to: SceneMotionBox,
    linear_progress: f64,
) -> SceneMotionBox {
    let p = scene_ease(linear_progress);
    if p >= 1.0 {
        return to;
    }
    let start = from.unwrap_or(SceneMotionBox {
        rect: scene_enter_from(to.rect),
        crop: to.crop,
    });
    let lerp = |a: f64, b: f64| a + (b - a) * p;
    SceneMotionBox {
        rect: ScenePixelRect {
            x: lerp(start.rect.x, to.rect.x),
            y: lerp(start.rect.y, to.rect.y),
            w: lerp(start.rect.w, to.rect.w),
            h: lerp(start.rect.h, to.rect.h),
        },
        crop: SceneCrop {
            l: lerp(start.crop.l, to.crop.l),
            t: lerp(start.crop.t, to.crop.t),
            r: lerp(start.crop.r, to.crop.r),
            b: lerp(start.crop.b, to.crop.b),
        },
    }
}
