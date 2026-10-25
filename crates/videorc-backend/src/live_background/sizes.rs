//! Internal render sizes. Every renderer and the Electron previews use these
//! exact rules (the JS runner mirrors them; `export.rs` pins both).

use super::guard::GuardLevel;
use super::looks::{FerrofluidCamera, is_soft};
use crate::protocol::LiveBackgroundId;

/// The longest short side a soft background renders at; above it, the frame
/// is drawn up with linear filtering (it looks the same, plan 190 "Measured
/// cost").
pub const SOFT_MAX_SHORT_SIDE: f64 = 1080.0;

/// React Bits' Plasma Wave caps its ray-traced (fine) target at 2.4 MP.
pub const PLASMA_MAX_LIGHT_PIXELS: f64 = 2_400_000.0;

// The plan 194 scratch rules below are read by the desktop export (a test)
// and the probe until S3-S5's renderers allocate that scratch.

/// React Bits' Beams renders its field at `quality` (0.75) of the canvas,
/// capped at 1.6 MP.
#[cfg_attr(not(test), allow(dead_code))]
pub const BEAMS_FIELD_SCALE: f64 = 0.75;
#[cfg_attr(not(test), allow(dead_code))]
pub const BEAMS_MAX_FIELD_PIXELS: f64 = 1_600_000.0;

/// React Bits' Ferrofluid simulates one cell per third of a world unit and
/// bounds the surface per world unit.
#[cfg_attr(not(test), allow(dead_code))]
pub const FERROFLUID_CELL: f64 = 1.0 / 3.0;
#[cfg_attr(not(test), allow(dead_code))]
pub const FERROFLUID_BOUND_CELL: f64 = 1.0;

/// React Bits' Ghost Fibers bloom chain: five levels, each half the last.
#[cfg_attr(not(test), allow(dead_code))]
pub const GHOST_FIBERS_BLOOM_LEVELS: usize = 5;

/// The background's full internal size for an output (`view`). Line Waves
/// and Dither render at full size; the soft backgrounds at most 1080 on
/// their short side. The guard's Half level halves either.
pub fn internal_size(id: LiveBackgroundId, output: (u32, u32), level: GuardLevel) -> (u32, u32) {
    let (width, height) = (f64::from(output.0.max(1)), f64::from(output.1.max(1)));
    let mut scale = if is_soft(id) {
        (SOFT_MAX_SHORT_SIDE / width.min(height)).min(1.0)
    } else {
        1.0
    };
    if level == GuardLevel::Half {
        scale *= 0.5;
    }
    let side = |value: f64| ((value * scale).round() as u32).max(16);
    (side(width), side(height))
}

/// Silk's bloom field: a quarter of the view, with a full mip chain.
pub fn silk_field_size(view: (u32, u32)) -> (u32, u32) {
    (quarter(view.0), quarter(view.1))
}

fn quarter(value: u32) -> u32 {
    ((f64::from(value) / 4.0).round() as u32).max(1)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlasmaSizes {
    /// The full ray trace at a third of `fine`.
    pub coarse: (u32, u32),
    /// The edge re-trace, the view capped at 2.4 MP.
    pub fine: (u32, u32),
    /// The bloom chain: `down[0]` is half the view, each next level half the
    /// last. The up chain reuses `down[1..=3]`'s sizes.
    pub down: [(u32, u32); 5],
}

pub fn plasma_sizes(view: (u32, u32)) -> PlasmaSizes {
    let (width, height) = (f64::from(view.0.max(1)), f64::from(view.1.max(1)));
    let mut scale = 1.0;
    if width * height > PLASMA_MAX_LIGHT_PIXELS {
        scale = (PLASMA_MAX_LIGHT_PIXELS / (width * height)).sqrt();
    }
    let fine = (
        ((width * scale).round() as u32).max(1),
        ((height * scale).round() as u32).max(1),
    );
    let coarse = (
        ((f64::from(fine.0) / 3.0).round() as u32).max(1),
        ((f64::from(fine.1) / 3.0).round() as u32).max(1),
    );
    let mut down = [(1, 1); 5];
    down[0] = (
        ((width / 2.0).round() as u32).max(1),
        ((height / 2.0).round() as u32).max(1),
    );
    for level in 1..5 {
        down[level] = (
            (down[level - 1].0 >> 1).max(1),
            (down[level - 1].1 >> 1).max(1),
        );
    }
    PlasmaSizes { coarse, fine, down }
}

/// Beams' glint field: three quarters of the view, capped at 1.6 MP, with a
/// full mip chain (React Bits' `resize()`; its CSS size and device ratio
/// cancel out).
#[cfg_attr(not(test), allow(dead_code))]
pub fn beams_field_size(view: (u32, u32)) -> (u32, u32) {
    let (width, height) = (f64::from(view.0.max(1)), f64::from(view.1.max(1)));
    let mut scale = BEAMS_FIELD_SCALE;
    if width * height * scale * scale > BEAMS_MAX_FIELD_PIXELS {
        scale = (BEAMS_MAX_FIELD_PIXELS / (width * height)).sqrt();
    }
    (
        ((width * scale).round() as u32).max(1),
        ((height * scale).round() as u32).max(1),
    )
}

/// One Dither cell in render pixels: the look's pixel size in CSS pixels
/// (one is `min(view) / 1080`), at least one (React Bits' `allocate()`).
#[cfg_attr(not(test), allow(dead_code))]
pub fn dither_cell(view: (u32, u32), pixel_size: f32) -> u32 {
    let pixel_scale = f64::from(view.0.min(view.1).max(1)) / 1080.0;
    ((f64::from(pixel_size) * pixel_scale).round() as u32).max(1)
}

/// Dither's wave field: one texel per cell, `ceil(view / cell)`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn dither_field_size(view: (u32, u32), pixel_size: f32) -> (u32, u32) {
    let cell = f64::from(dither_cell(view, pixel_size));
    (
        ((f64::from(view.0.max(1)) / cell).ceil() as u32).max(1),
        ((f64::from(view.1.max(1)) / cell).ceil() as u32).max(1),
    )
}

/// Ferrofluid's simulation grid for a view's aspect: React Bits' `layout()`
/// walks the camera's four corner rays (and the top centre) to the ground,
/// pads the footprint by three world units and cells it. The shaders derive
/// the same origin from the aspect; only the sizes must come from here.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FerrofluidGrid {
    /// The world position of the grid's corner.
    pub origin: (f64, f64),
    /// The field: one texel per `FERROFLUID_CELL`.
    pub size: (u32, u32),
    /// The bound: one texel per `FERROFLUID_BOUND_CELL`.
    pub bound: (u32, u32),
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn ferrofluid_grid(camera: &FerrofluidCamera, view: (u32, u32)) -> FerrofluidGrid {
    let aspect = f64::from(view.0.max(1)) / f64::from(view.1.max(1));
    let ground = |x: f64, y: f64| {
        let sx = x * aspect * camera.tan_half;
        let sy = y * camera.tan_half;
        let dx = sx;
        let dy = camera.forward[0] + sy * camera.upward[0];
        let dz = camera.forward[1] + sy * camera.upward[1];
        let length = (dx * dx + dy * dy + dz * dz).sqrt().max(1e-12);
        let (dx, dy, dz) = (dx / length, dy / length, dz / length);
        let t = if dz < -0.004 {
            (-camera.z / dz).min(camera.far)
        } else {
            camera.far
        };
        (dx * t, camera.y + dy * t)
    };
    let corners = [
        ground(-1.0, -1.0),
        ground(1.0, -1.0),
        ground(-1.0, 1.0),
        ground(1.0, 1.0),
        ground(0.0, 1.0),
    ];
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    );
    for (x, y) in corners {
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_y = min_y.min(y);
        max_y = max_y.max(y);
    }
    let (min_x, max_x, min_y, max_y) = (min_x - 3.0, max_x + 3.0, min_y - 3.0, max_y + 3.0);
    let width = ((max_x - min_x) / FERROFLUID_CELL).ceil() as u32 + 2;
    let height = ((max_y - min_y) / FERROFLUID_CELL).ceil() as u32 + 2;
    FerrofluidGrid {
        origin: (min_x, min_y),
        size: (width, height),
        bound: (
            (f64::from(width) * FERROFLUID_CELL / FERROFLUID_BOUND_CELL).ceil() as u32,
            (f64::from(height) * FERROFLUID_CELL / FERROFLUID_BOUND_CELL).ceil() as u32,
        ),
    }
}

/// Ghost Fibers' bloom chain: level `i` is the view over 2^(i + 1).
#[cfg_attr(not(test), allow(dead_code))]
pub fn ghost_fibers_bloom_sizes(view: (u32, u32)) -> [(u32, u32); GHOST_FIBERS_BLOOM_LEVELS] {
    let mut levels = [(1, 1); GHOST_FIBERS_BLOOM_LEVELS];
    for (index, level) in levels.iter_mut().enumerate() {
        let divisor = f64::from(1u32 << (index + 1));
        *level = (
            ((f64::from(view.0.max(1)) / divisor).round() as u32).max(1),
            ((f64::from(view.1.max(1)) / divisor).round() as u32).max(1),
        );
    }
    levels
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_background::looks::ferrofluid_camera;

    #[test]
    fn dither_renders_its_cells_at_full_size() {
        let dither = LiveBackgroundId::Dither;
        assert_eq!(
            internal_size(dither, (3840, 2160), GuardLevel::Full),
            (3840, 2160)
        );
        assert_eq!(dither_cell((1920, 1080), 2.0), 2);
        assert_eq!(dither_cell((3840, 2160), 2.0), 4);
        assert_eq!(dither_cell((1280, 720), 2.0), 1);
        assert_eq!(dither_field_size((1920, 1080), 2.0), (960, 540));
        assert_eq!(dither_field_size((1081, 1081), 2.0), (541, 541));
    }

    #[test]
    fn beams_field_is_three_quarters_capped_at_1_6_megapixels() {
        assert_eq!(beams_field_size((1920, 1080)), (1440, 810));
        assert_eq!(beams_field_size((1080, 1920)), (810, 1440));
        let capped = beams_field_size((2560, 1440));
        assert!(f64::from(capped.0 * capped.1) <= BEAMS_MAX_FIELD_PIXELS + 3000.0);
        assert!((f64::from(capped.0) / f64::from(capped.1) - 2560.0 / 1440.0).abs() < 0.01);
    }

    #[test]
    fn ferrofluid_grid_follows_react_bits_layout() {
        let camera = ferrofluid_camera(1.6, 48.0);
        let wide = ferrofluid_grid(&camera, (1920, 1080));
        // The ground footprint of a 16:9 view at scale 1.6 and tilt 48,
        // padded by three units: about 45.6 × 30.1 units, a third of a unit
        // per cell, plus two.
        assert_eq!(wide.size, (139, 93));
        assert_eq!(wide.bound, (47, 31));
        assert!((wide.origin.0 + 22.8).abs() < 0.2, "{:?}", wide.origin);
        assert!((wide.origin.1 + 10.4).abs() < 0.2, "{:?}", wide.origin);
        let tall = ferrofluid_grid(&camera, (1080, 1920));
        assert!(tall.size.0 < wide.size.0);
        assert_eq!(tall.size.1, wide.size.1);
        // The grid depends on the aspect only, not the pixel size.
        assert_eq!(ferrofluid_grid(&camera, (960, 540)), wide);
    }

    #[test]
    fn ghost_fibers_bloom_halves_five_times() {
        assert_eq!(
            ghost_fibers_bloom_sizes((1920, 1080)),
            [(960, 540), (480, 270), (240, 135), (120, 68), (60, 34)]
        );
        assert_eq!(ghost_fibers_bloom_sizes((1, 1)), [(1, 1); 5]);
    }

    #[test]
    fn soft_backgrounds_render_at_most_1080_on_the_short_side() {
        let silk = LiveBackgroundId::Silk;
        assert_eq!(
            internal_size(silk, (1920, 1080), GuardLevel::Full),
            (1920, 1080)
        );
        assert_eq!(
            internal_size(silk, (3840, 2160), GuardLevel::Full),
            (1920, 1080)
        );
        assert_eq!(
            internal_size(silk, (2560, 1440), GuardLevel::Full),
            (1920, 1080)
        );
        assert_eq!(
            internal_size(silk, (1080, 1920), GuardLevel::Full),
            (1080, 1920)
        );
        assert_eq!(
            internal_size(silk, (1280, 720), GuardLevel::Full),
            (1280, 720)
        );
        assert_eq!(
            internal_size(silk, (3840, 2160), GuardLevel::Half),
            (960, 540)
        );
    }

    #[test]
    fn line_waves_renders_at_full_size_until_the_guard_halves_it() {
        let lines = LiveBackgroundId::LineWaves;
        assert_eq!(
            internal_size(lines, (3840, 2160), GuardLevel::Full),
            (3840, 2160)
        );
        assert_eq!(
            internal_size(lines, (1920, 1080), GuardLevel::Half),
            (960, 540)
        );
    }

    #[test]
    fn plasma_matches_react_bits_sizing() {
        let sizes = plasma_sizes((1920, 1080));
        assert_eq!(sizes.fine, (1920, 1080));
        assert_eq!(sizes.coarse, (640, 360));
        assert_eq!(
            sizes.down,
            [(960, 540), (480, 270), (240, 135), (120, 67), (60, 33)]
        );
        // 4K never reaches Plasma at full size (soft rule), but the cap holds.
        let capped = plasma_sizes((3840, 2160));
        assert!(f64::from(capped.fine.0 * capped.fine.1) <= PLASMA_MAX_LIGHT_PIXELS + 4000.0);
    }

    #[test]
    fn silk_field_is_a_quarter() {
        assert_eq!(silk_field_size((1920, 1080)), (480, 270));
        assert_eq!(silk_field_size((1, 1)), (1, 1));
    }
}
