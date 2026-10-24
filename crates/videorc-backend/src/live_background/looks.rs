//! The live background catalogue: names, looks (from React Bits' own presets,
//! plan 190 D4) and the uniform packing every renderer shares.

use std::sync::OnceLock;

use crate::protocol::{LiveBackgroundId, LiveBackgroundMotion};

/// `uniform vec4 u[9]` in every shader.
pub const UNIFORM_VEC4_COUNT: usize = 9;
/// `u[2..9]`: the per-look constants.
pub const STATIC_VEC4_COUNT: usize = UNIFORM_VEC4_COUNT - 2;

pub type Uniforms = [[f32; 4]; UNIFORM_VEC4_COUNT];

/// The colour the transparent backgrounds are drawn over: React Bits' dark
/// studio stage, `#050506`. Silk is opaque and ignores it.
pub const BASE_COLOR: [f32; 3] = [5.0 / 255.0, 5.0 / 255.0, 6.0 / 255.0];

pub const ALL_LIVE_BACKGROUNDS: [LiveBackgroundId; 5] = [
    LiveBackgroundId::Silk,
    LiveBackgroundId::SideRays,
    LiveBackgroundId::PlasmaWave,
    LiveBackgroundId::LiquidChrome,
    LiveBackgroundId::LineWaves,
];

#[derive(Debug, Clone, PartialEq)]
pub struct LiveLook {
    pub id: &'static str,
    pub name: &'static str,
    /// React Bits time units per second at Normal motion.
    pub rate: f64,
    /// The phase the poster, the thumbnail and the golden frames are rendered
    /// at, and where the animation starts when the background is applied, so
    /// the first frame is the poster.
    pub poster_phase: f64,
    /// `u[2..9]`.
    pub statics: [[f32; 4]; STATIC_VEC4_COUNT],
}

/// The wire and file id (`silk`, `side-rays`, …).
pub fn css_id(id: LiveBackgroundId) -> &'static str {
    match id {
        LiveBackgroundId::Silk => "silk",
        LiveBackgroundId::SideRays => "side-rays",
        LiveBackgroundId::PlasmaWave => "plasma-wave",
        LiveBackgroundId::LiquidChrome => "liquid-chrome",
        LiveBackgroundId::LineWaves => "line-waves",
    }
}

pub fn display_name(id: LiveBackgroundId) -> &'static str {
    match id {
        LiveBackgroundId::Silk => "Silk",
        LiveBackgroundId::SideRays => "Side Rays",
        LiveBackgroundId::PlasmaWave => "Plasma Wave",
        LiveBackgroundId::LiquidChrome => "Liquid Chrome",
        LiveBackgroundId::LineWaves => "Line Waves",
    }
}

/// Soft backgrounds render at most 1080 on their short side and are drawn
/// up; Line Waves' 1–2 px lines render at full size.
pub fn is_soft(id: LiveBackgroundId) -> bool {
    !matches!(id, LiveBackgroundId::LineWaves)
}

/// Calm runs at half the React Bits speed (plan 190 D5).
pub fn motion_factor(motion: LiveBackgroundMotion) -> f64 {
    match motion {
        LiveBackgroundMotion::Calm => 0.5,
        LiveBackgroundMotion::Normal => 1.0,
    }
}

/// The bundled poster's managed asset id for a look.
pub fn poster_asset_id(id: LiveBackgroundId, look: &str) -> String {
    format!("live-{}-{look}", css_id(id))
}

/// The looks of a background, built on first use.
pub fn looks(id: LiveBackgroundId) -> &'static [LiveLook] {
    static CATALOGUE: OnceLock<[Vec<LiveLook>; 5]> = OnceLock::new();
    let catalogue = CATALOGUE.get_or_init(|| {
        [
            silk_looks(),
            side_rays_looks(),
            plasma_wave_looks(),
            liquid_chrome_looks(),
            line_waves_looks(),
        ]
    });
    let index = ALL_LIVE_BACKGROUNDS
        .iter()
        .position(|candidate| *candidate == id)
        .unwrap_or(0);
    &catalogue[index]
}

/// The named look, or the background's first look (and `false`) when the name
/// is unknown, for example a saved scene from a newer build.
pub fn look_or_first(id: LiveBackgroundId, look: &str) -> (&'static LiveLook, bool) {
    let all = looks(id);
    match all.iter().find(|candidate| candidate.id == look) {
        Some(found) => (found, true),
        None => (&all[0], false),
    }
}

/// The nine `vec4`s for one pass: `target` is the pass's render target,
/// `view` the background's full internal size, `phase` the clock and `dim`
/// the Dim style as 0–0.8.
pub fn uniforms(
    look: &LiveLook,
    target: (u32, u32),
    view: (u32, u32),
    phase: f64,
    dim: f32,
) -> Uniforms {
    let pixel_scale = view.0.min(view.1).max(1) as f32 / 1080.0;
    let mut out = [[0.0; 4]; UNIFORM_VEC4_COUNT];
    out[0] = [target.0 as f32, target.1 as f32, phase as f32, pixel_scale];
    out[1] = [view.0 as f32, view.1 as f32, dim.clamp(0.0, 0.8), 0.0];
    out[2..].copy_from_slice(&look.statics);
    out
}

fn hex(value: &str) -> [f32; 3] {
    let digits = value.trim_start_matches('#');
    let channel = |at: usize| {
        u8::from_str_radix(&digits[at..at + 2], 16).map_or(1.0, |byte| f32::from(byte) / 255.0)
    };
    [channel(0), channel(2), channel(4)]
}

fn linear(color: [f32; 3]) -> [f32; 3] {
    color.map(|channel| channel.powf(2.2))
}

fn with(rgb: [f32; 3], w: f32) -> [f32; 4] {
    [rgb[0], rgb[1], rgb[2], w]
}

fn base(w: f32) -> [f32; 4] {
    with(BASE_COLOR, w)
}

// ---------------------------------------------------------------- Silk

struct Silk {
    color: &'static str,
    sheen_color: &'static str,
    speed: f64,
    scale: f32,
    rotation: f32,
    sheen: f32,
    depth: f32,
    glow: f32,
    ripple: f32,
    wave: f32,
    variation: f64,
}

const SILK_LOOK: Silk = Silk {
    color: "#5227FF",
    sheen_color: "#ffffff",
    speed: 5.0,
    scale: 1.0,
    rotation: 0.0,
    sheen: 0.5,
    depth: 0.5,
    glow: 0.3,
    ripple: 1.0,
    wave: 1.0,
    variation: 0.0,
};

/// Silk's grain is fixed in place (it hashes the pixel position); Videorc keeps
/// a third of React Bits' 1.5 so a stream spends fewer bits on it.
const SILK_GRAIN: f32 = 0.5;

/// React Bits' `variationShift`: a hash of the variation number, ±3 per axis.
fn silk_variation_shift(variation: f64) -> [f32; 2] {
    if variation == 0.0 {
        return [0.0, 0.0];
    }
    let wave = |k: f64| {
        let v = (variation * 12.9898 + k * 78.233).sin() * 43758.5453;
        v - v.floor() - 0.5
    };
    [(wave(1.0) * 6.0) as f32, (wave(2.0) * 6.0) as f32]
}

fn silk(id: &'static str, name: &'static str, props: Silk) -> LiveLook {
    let shift = silk_variation_shift(props.variation);
    LiveLook {
        id,
        name,
        rate: props.speed * 0.1,
        poster_phase: 3.0,
        statics: [
            [props.scale, props.rotation, props.wave, props.ripple],
            [1.0, shift[0], shift[1], SILK_GRAIN],
            with(hex(props.color), props.depth),
            with(hex(props.sheen_color), props.sheen),
            [props.glow, -0.55, 0.7, 0.0],
            [0.0; 4],
            [0.0; 4],
        ],
    }
}

fn silk_looks() -> Vec<LiveLook> {
    vec![
        silk("satin", "Satin", SILK_LOOK),
        silk(
            "champagne",
            "Champagne",
            Silk {
                color: "#b08d57",
                sheen_color: "#fff3dc",
                sheen: 0.6,
                depth: 0.55,
                glow: 0.35,
                ..SILK_LOOK
            },
        ),
        silk(
            "midnight",
            "Midnight",
            Silk {
                color: "#2a4bd7",
                speed: 3.5,
                sheen: 0.55,
                glow: 0.4,
                variation: 3.0,
                ..SILK_LOOK
            },
        ),
    ]
}

// ---------------------------------------------------------------- Side Rays

#[derive(Clone, Copy)]
enum RayOrigin {
    TopRight,
    TopLeft,
}

struct SideRays {
    ray_color1: &'static str,
    ray_color2: &'static str,
    blend: f32,
    origin: RayOrigin,
    speed: f64,
    intensity: f32,
    spread: f32,
    density: f32,
    sharpness: f32,
    tilt_degrees: f32,
    falloff: f32,
    glow: f32,
    saturation: f32,
    dust: f32,
}

const SIDE_RAYS_LOOK: SideRays = SideRays {
    ray_color1: "#FFC46B",
    ray_color2: "#96c8ff",
    blend: 0.6,
    origin: RayOrigin::TopRight,
    speed: 2.5,
    intensity: 2.0,
    spread: 2.0,
    density: 5.0,
    sharpness: 0.5,
    tilt_degrees: 0.0,
    falloff: 1.6,
    glow: 1.0,
    saturation: 1.0,
    dust: 0.0,
};

fn side_rays(id: &'static str, name: &'static str, props: SideRays) -> LiveLook {
    // React Bits' ORIGINS: (flipX, flipY, side).
    let frame = match props.origin {
        RayOrigin::TopRight => [0.0, 0.0, 0.0],
        RayOrigin::TopLeft => [1.0, 0.0, 0.0],
    };
    LiveLook {
        id,
        name,
        rate: props.speed,
        poster_phase: 15.0,
        statics: [
            with(hex(props.ray_color1), props.blend),
            with(hex(props.ray_color2), props.intensity),
            [props.spread, props.density, props.sharpness, props.falloff],
            [props.glow, props.saturation, props.dust, 1.0],
            [
                frame[0],
                frame[1],
                frame[2],
                props.tilt_degrees.to_radians(),
            ],
            // Focus (angle, width, strength) rests at strength 0 without a
            // pointer; sway is on.
            [0.0, (props.spread * 0.25).max(0.06), 0.0, 1.0],
            base(0.0),
        ],
    }
}

fn side_rays_looks() -> Vec<LiveLook> {
    vec![
        side_rays("sunbeam", "Sunbeam", SIDE_RAYS_LOOK),
        side_rays(
            "moonlight",
            "Moonlight",
            SideRays {
                ray_color1: "#dbe4ff",
                ray_color2: "#7aa2ff",
                blend: 0.7,
                intensity: 1.6,
                speed: 1.5,
                ..SIDE_RAYS_LOOK
            },
        ),
        side_rays(
            "spotlight",
            "Spotlight",
            SideRays {
                ray_color1: "#ffffff",
                ray_color2: "#e0e7ff",
                origin: RayOrigin::TopLeft,
                spread: 1.2,
                density: 3.0,
                sharpness: 0.75,
                glow: 1.4,
                ..SIDE_RAYS_LOOK
            },
        ),
    ]
}

// ---------------------------------------------------------------- Plasma Wave

struct PlasmaWave {
    color1: &'static str,
    color2: &'static str,
    speed: f64,
    speed1: f32,
    speed2: f32,
    dir2: f32,
    bend1: f32,
    bend2: f32,
    thickness: f32,
    glow: f32,
    focal_length: f32,
    rotation_degrees: f32,
    brightness: f32,
    core: f32,
}

const PLASMA_WAVE_LOOK: PlasmaWave = PlasmaWave {
    color1: "#A855F7",
    color2: "#06B6D4",
    speed: 1.0,
    speed1: 0.05,
    speed2: 0.05,
    dir2: 1.0,
    bend1: 1.0,
    bend2: 0.5,
    thickness: 0.3,
    glow: 1.0,
    focal_length: 1.25,
    rotation_degrees: 0.0,
    brightness: 1.0,
    core: 0.6,
};

fn plasma_wave(id: &'static str, name: &'static str, props: PlasmaWave) -> LiveLook {
    LiveLook {
        id,
        name,
        rate: props.speed,
        poster_phase: 6.0,
        statics: [
            [
                props.rotation_degrees.to_radians(),
                props.focal_length,
                props.speed1,
                props.speed2,
            ],
            [props.dir2, props.bend1, props.bend2, props.thickness],
            // Exposure is React Bits' 2.4 × brightness ÷ range (range = 1 on
            // float targets). Grain changes every frame, so Videorc sets it
            // to 0 (a stream would spend bits on it).
            [props.core, 2.4 * props.brightness, props.glow, 0.0],
            with(linear(hex(props.color1)), 1.0),
            with(linear(hex(props.color2)), 0.0),
            // Heat (x, amount, width) rests at amount 0 without a pointer.
            [0.0, 0.0, 1.4, 0.0],
            base(0.0),
        ],
    }
}

fn plasma_wave_looks() -> Vec<LiveLook> {
    vec![
        plasma_wave("plasma", "Plasma", PLASMA_WAVE_LOOK),
        plasma_wave(
            "ember",
            "Ember",
            PlasmaWave {
                color1: "#ff8a3d",
                color2: "#ff2d6f",
                ..PLASMA_WAVE_LOOK
            },
        ),
        plasma_wave(
            "glacier",
            "Glacier",
            PlasmaWave {
                color1: "#93c5fd",
                color2: "#e0f2fe",
                glow: 0.9,
                ..PLASMA_WAVE_LOOK
            },
        ),
    ]
}

// ---------------------------------------------------------------- Liquid Chrome

struct LiquidChrome {
    color: &'static str,
    speed: f64,
    amplitude: f32,
    frequency_x: f32,
    frequency_y: f32,
    detail: f32,
    thickness: f32,
    depth: f32,
    roughness: f32,
    exposure: f32,
}

const LIQUID_CHROME_LOOK: LiquidChrome = LiquidChrome {
    color: "#ffffff",
    speed: 0.2,
    amplitude: 0.3,
    frequency_x: 3.0,
    frequency_y: 3.0,
    detail: 4.0,
    thickness: 1.0,
    depth: 1.0,
    roughness: 0.3,
    exposure: 1.0,
};

fn liquid_chrome(id: &'static str, name: &'static str, props: LiquidChrome) -> LiveLook {
    LiveLook {
        id,
        name,
        rate: props.speed,
        poster_phase: 1.2,
        statics: [
            [
                props.amplitude,
                props.frequency_x.max(0.1),
                props.frequency_y.max(0.1),
                props.detail,
            ],
            [
                5.0 / (3.0 * props.thickness),
                props.depth,
                props.roughness,
                props.exposure,
            ],
            // Tint (linearised as React Bits does) and presence.
            with(linear(hex(props.color)), 1.0),
            // The view tilt rests at 0 without a pointer.
            [0.0; 4],
            base(0.0),
            [0.0; 4],
            [0.0; 4],
        ],
    }
}

fn liquid_chrome_looks() -> Vec<LiveLook> {
    vec![
        liquid_chrome(
            "polished",
            "Polished",
            LiquidChrome {
                roughness: 0.17,
                ..LIQUID_CHROME_LOOK
            },
        ),
        liquid_chrome(
            "gold",
            "Gold",
            LiquidChrome {
                color: "#f2c46d",
                ..LIQUID_CHROME_LOOK
            },
        ),
        liquid_chrome(
            "mercury",
            "Mercury",
            LiquidChrome {
                speed: 0.14,
                amplitude: 0.22,
                frequency_x: 2.5,
                frequency_y: 2.5,
                detail: 3.0,
                thickness: 1.15,
                roughness: 0.2,
                ..LIQUID_CHROME_LOOK
            },
        ),
    ]
}

// ---------------------------------------------------------------- Line Waves

struct LineWaves {
    color1: &'static str,
    color2: &'static str,
    color3: &'static str,
    color_cycle_speed: f32,
    speed: f64,
    line_count: f32,
    line_width: f32,
    glow: f32,
    brightness: f32,
    highlight: f32,
    highlight_width: f32,
    warp_intensity: f32,
    warp_scale: f32,
    rotation_degrees: f32,
}

const LINE_WAVES_LOOK: LineWaves = LineWaves {
    color1: "#ffffff",
    color2: "#ffffff",
    color3: "#ffffff",
    color_cycle_speed: 1.0,
    speed: 0.3,
    line_count: 72.0,
    line_width: 1.3,
    glow: 0.6,
    brightness: 1.0,
    highlight: 1.0,
    highlight_width: 1.0,
    warp_intensity: 1.0,
    warp_scale: 1.0,
    rotation_degrees: -33.0,
};

fn line_waves(id: &'static str, name: &'static str, props: LineWaves) -> LiveLook {
    LiveLook {
        id,
        name,
        // React Bits advances Line Waves' time at speed × 2.5.
        rate: props.speed * 2.5,
        poster_phase: 4.5,
        statics: [
            [
                props.line_count,
                props.line_width,
                props.glow,
                props.brightness,
            ],
            [
                props.highlight,
                props.highlight_width,
                props.warp_intensity,
                props.warp_scale,
            ],
            // Rotation, colour cycle speed, edge fade (off), opacity.
            [
                props.rotation_degrees.to_radians(),
                props.color_cycle_speed,
                0.0,
                1.0,
            ],
            with(hex(props.color1), 0.0),
            with(hex(props.color2), 0.0),
            with(hex(props.color3), 0.0),
            base(0.0),
        ],
    }
}

fn line_waves_looks() -> Vec<LiveLook> {
    vec![
        line_waves("silk", "Silk", LINE_WAVES_LOOK),
        line_waves(
            "gold",
            "Gold",
            LineWaves {
                color1: "#ffd9a0",
                color2: "#ffb45e",
                color3: "#fff0d6",
                ..LINE_WAVES_LOOK
            },
        ),
        line_waves(
            "aurora",
            "Aurora",
            LineWaves {
                color1: "#8ff0d0",
                color2: "#7aa8ff",
                color3: "#5fd3e6",
                ..LINE_WAVES_LOOK
            },
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_background_has_three_looks_with_unique_ids() {
        for id in ALL_LIVE_BACKGROUNDS {
            let all = looks(id);
            assert_eq!(all.len(), 3, "{id:?}");
            let mut ids: Vec<_> = all.iter().map(|look| look.id).collect();
            ids.dedup();
            assert_eq!(ids.len(), 3, "{id:?}");
            assert!(all.iter().all(|look| look.rate > 0.0));
        }
    }

    #[test]
    fn the_owner_linked_satin_is_silks_first_look() {
        let satin = &looks(LiveBackgroundId::Silk)[0];
        assert_eq!(satin.id, "satin");
        // #5227FF, speed 5 → React Bits flow of 0.5 per second.
        assert!((satin.statics[2][0] - 0x52 as f32 / 255.0).abs() < 1e-6);
        assert!((satin.rate - 0.5).abs() < 1e-9);
    }

    #[test]
    fn unknown_looks_fall_back_to_the_first_one() {
        let (look, known) = look_or_first(LiveBackgroundId::PlasmaWave, "neon");
        assert_eq!(look.id, "plasma");
        assert!(!known);
        let (look, known) = look_or_first(LiveBackgroundId::PlasmaWave, "ember");
        assert_eq!(look.id, "ember");
        assert!(known);
    }

    #[test]
    fn uniforms_carry_the_target_view_phase_scale_and_dim() {
        let look = &looks(LiveBackgroundId::LineWaves)[0];
        let packed = uniforms(look, (960, 540), (3840, 2160), 12.5, 0.95);
        assert_eq!(packed[0], [960.0, 540.0, 12.5, 2.0]);
        // Dim is clamped to the style's 80 % ceiling.
        assert_eq!(packed[1], [3840.0, 2160.0, 0.8, 0.0]);
        assert_eq!(packed[2..], look.statics[..]);
        let vertical = uniforms(look, (1080, 1920), (1080, 1920), 0.0, 0.0);
        assert_eq!(vertical[0][3], 1.0);
    }

    #[test]
    fn silk_variation_matches_react_bits() {
        // React Bits: variationShift(3) = [wave(1) * 6, wave(2) * 6].
        let shift = silk_variation_shift(3.0);
        let wave = |k: f64| {
            let v = (3.0f64 * 12.9898 + k * 78.233).sin() * 43758.5453;
            v - v.floor() - 0.5
        };
        assert!((f64::from(shift[0]) - wave(1.0) * 6.0).abs() < 1e-5);
        assert!((f64::from(shift[1]) - wave(2.0) * 6.0).abs() < 1e-5);
        assert_eq!(silk_variation_shift(0.0), [0.0, 0.0]);
    }

    #[test]
    fn poster_ids_name_the_background_and_look() {
        assert_eq!(
            poster_asset_id(LiveBackgroundId::LiquidChrome, "gold"),
            "live-liquid-chrome-gold"
        );
    }

    #[test]
    fn plasma_colours_are_linearised_like_react_bits() {
        let plasma = &looks(LiveBackgroundId::PlasmaWave)[0];
        let expected = (f32::from(0xA8u8) / 255.0).powf(2.2);
        assert!((plasma.statics[3][0] - expected).abs() < 1e-6);
    }
}
