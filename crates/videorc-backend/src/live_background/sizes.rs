//! Internal render sizes. Every renderer and the Electron previews use these
//! exact rules (the JS runner mirrors them; `export.rs` pins both).

use super::guard::GuardLevel;
use super::looks::is_soft;
use crate::protocol::LiveBackgroundId;

/// The longest short side a soft background renders at; above it, the frame
/// is drawn up with linear filtering (it looks the same, plan 190 "Measured
/// cost").
pub const SOFT_MAX_SHORT_SIDE: f64 = 1080.0;

/// React Bits' Plasma Wave caps its ray-traced (fine) target at 2.4 MP.
pub const PLASMA_MAX_LIGHT_PIXELS: f64 = 2_400_000.0;

/// The background's full internal size for an output (`view`). Line Waves
/// renders at full size; the four soft backgrounds at most 1080 on their
/// short side. The guard's Half level halves either.
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

#[cfg(test)]
mod tests {
    use super::*;

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
