//! The live background catalogue: names, looks (from React Bits' own presets,
//! plan 190 D4 and plan 194) and the uniform packing every renderer shares.

use std::sync::OnceLock;

use crate::protocol::{LiveBackgroundId, LiveBackgroundMotion};

/// `uniform vec4 u[16]` in every shader. Plan 194 widened it from 9: Color
/// Bends packs up to eight colours, Dither up to eight palette entries and
/// Ghost Fibers its orientation and about thirty constants. The plan 190 five
/// read the same indices as before, so their goldens did not move.
pub const UNIFORM_VEC4_COUNT: usize = 16;
/// `u[2..16]`: the per-look constants.
pub const STATIC_VEC4_COUNT: usize = UNIFORM_VEC4_COUNT - 2;

pub type Uniforms = [[f32; 4]; UNIFORM_VEC4_COUNT];

/// The colour the transparent backgrounds are drawn over: React Bits' dark
/// studio stage, `#050506`. Silk and Dither are opaque and ignore it.
pub const BASE_COLOR: [f32; 3] = [5.0 / 255.0, 5.0 / 255.0, 6.0 / 255.0];

/// Catalogue order: the plan 190 five, then the plan 194 five (N4).
pub const ALL_LIVE_BACKGROUNDS: [LiveBackgroundId; 10] = [
    LiveBackgroundId::Silk,
    LiveBackgroundId::SideRays,
    LiveBackgroundId::PlasmaWave,
    LiveBackgroundId::LiquidChrome,
    LiveBackgroundId::LineWaves,
    LiveBackgroundId::Beams,
    LiveBackgroundId::ColorBends,
    LiveBackgroundId::Dither,
    LiveBackgroundId::Ferrofluid,
    LiveBackgroundId::GhostFibers,
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
    /// `u[2..16]`.
    pub statics: [[f32; 4]; STATIC_VEC4_COUNT],
}

/// The wire and file id (`silk`, `side-rays`, …). The desktop JSON export
/// (a test) and the posters' asset ids use it.
#[cfg_attr(not(test), allow(dead_code))]
pub fn css_id(id: LiveBackgroundId) -> &'static str {
    match id {
        LiveBackgroundId::Silk => "silk",
        LiveBackgroundId::SideRays => "side-rays",
        LiveBackgroundId::PlasmaWave => "plasma-wave",
        LiveBackgroundId::LiquidChrome => "liquid-chrome",
        LiveBackgroundId::LineWaves => "line-waves",
        LiveBackgroundId::Beams => "beams",
        LiveBackgroundId::ColorBends => "color-bends",
        LiveBackgroundId::Dither => "dither",
        LiveBackgroundId::Ferrofluid => "ferrofluid",
        LiveBackgroundId::GhostFibers => "ghost-fibers",
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn display_name(id: LiveBackgroundId) -> &'static str {
    match id {
        LiveBackgroundId::Silk => "Silk",
        LiveBackgroundId::SideRays => "Side Rays",
        LiveBackgroundId::PlasmaWave => "Plasma Wave",
        LiveBackgroundId::LiquidChrome => "Liquid Chrome",
        LiveBackgroundId::LineWaves => "Line Waves",
        LiveBackgroundId::Beams => "Beams",
        LiveBackgroundId::ColorBends => "Color Bends",
        LiveBackgroundId::Dither => "Dither",
        LiveBackgroundId::Ferrofluid => "Ferrofluid",
        LiveBackgroundId::GhostFibers => "Ghost Fibers",
    }
}

/// Soft backgrounds render at most 1080 on their short side and are drawn
/// up. Line Waves' 1–2 px lines and Dither's per-pixel cells render at full
/// size.
pub fn is_soft(id: LiveBackgroundId) -> bool {
    !matches!(id, LiveBackgroundId::LineWaves | LiveBackgroundId::Dither)
}

/// Calm runs at half the React Bits speed (plan 190 D5).
pub fn motion_factor(motion: LiveBackgroundMotion) -> f64 {
    match motion {
        LiveBackgroundMotion::Calm => 0.5,
        LiveBackgroundMotion::Normal => 1.0,
    }
}

/// The bundled poster's managed asset id for a look.
#[cfg_attr(not(test), allow(dead_code))]
pub fn poster_asset_id(id: LiveBackgroundId, look: &str) -> String {
    format!("live-{}-{look}", css_id(id))
}

/// The looks of a background, built on first use.
pub fn looks(id: LiveBackgroundId) -> &'static [LiveLook] {
    static CATALOGUE: OnceLock<[Vec<LiveLook>; 10]> = OnceLock::new();
    let catalogue = CATALOGUE.get_or_init(|| {
        [
            silk_looks(),
            side_rays_looks(),
            plasma_wave_looks(),
            liquid_chrome_looks(),
            line_waves_looks(),
            beams_looks(),
            color_bends_looks(),
            dither_looks(),
            ferrofluid_looks(),
            ghost_fibers_looks(),
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

/// The sixteen `vec4`s for one pass: `target` is the pass's render target,
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

/// React Bits' `pow(c, 2.2)` linearisation (Plasma Wave, Liquid Chrome, Beams).
fn linear(color: [f32; 3]) -> [f32; 3] {
    color.map(|channel| channel.powf(2.2))
}

/// The exact sRGB transfer, as Dither's `toLinear` (its shader applies the
/// inverse).
fn srgb_linear(color: [f32; 3]) -> [f32; 3] {
    color.map(|channel| {
        if channel <= 0.04045 {
            channel / 12.92
        } else {
            ((channel + 0.055) / 1.055).powf(2.4)
        }
    })
}

fn with(rgb: [f32; 3], w: f32) -> [f32; 4] {
    [rgb[0], rgb[1], rgb[2], w]
}

fn base(w: f32) -> [f32; 4] {
    with(BASE_COLOR, w)
}

/// The statics a look lists, zero-padded to `STATIC_VEC4_COUNT` rows: the
/// plan 190 five use seven, so their indices never moved when the block
/// widened.
fn pad<const ROWS: usize>(rows: [[f32; 4]; ROWS]) -> [[f32; 4]; STATIC_VEC4_COUNT] {
    const { assert!(ROWS <= STATIC_VEC4_COUNT) };
    let mut out = [[0.0; 4]; STATIC_VEC4_COUNT];
    out[..ROWS].copy_from_slice(&rows);
    out
}

/// A look's static grain. React Bits' grain is fixed in place (it hashes the
/// pixel), so Videorc keeps a third of it, as Silk does, and a stream spends
/// fewer bits on it. A grain that changed every frame would be set to 0.
const STATIC_GRAIN: f32 = 1.0 / 3.0;

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
        statics: pad([
            [props.scale, props.rotation, props.wave, props.ripple],
            [1.0, shift[0], shift[1], SILK_GRAIN],
            with(hex(props.color), props.depth),
            with(hex(props.sheen_color), props.sheen),
            [props.glow, -0.55, 0.7, 0.0],
            [0.0; 4],
            [0.0; 4],
        ]),
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
        statics: pad([
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
        ]),
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
        statics: pad([
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
        ]),
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
        statics: pad([
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
        ]),
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
        statics: pad([
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
        ]),
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

// ---------------------------------------------------------------- Beams (plan 194)

struct Beams {
    color: &'static str,
    beam_width: f32,
    rotation_degrees: f32,
    speed: f64,
    wave_length: f32,
    depth: f32,
    sharpness: f32,
    twist: f32,
    fill_light: f32,
    glow: f32,
    brightness: f32,
    variation: f32,
    grain: f32,
}

const BEAMS_LOOK: Beams = Beams {
    color: "#ffffff",
    beam_width: 140.0,
    rotation_degrees: 30.0,
    speed: 1.0,
    wave_length: 233.0,
    depth: 1.0,
    sharpness: 0.6,
    twist: 0.0,
    fill_light: 0.3,
    glow: 0.6,
    brightness: 1.6,
    variation: 0.0,
    grain: 0.35,
};

fn beams(id: &'static str, name: &'static str, props: Beams) -> LiveLook {
    let angle = props.rotation_degrees.to_radians();
    LiveLook {
        id,
        name,
        rate: props.speed,
        poster_phase: 24.0,
        statics: pad([
            // Beam width and wave length in CSS pixels, depth, GGX roughness.
            [
                props.beam_width.max(8.0),
                props.wave_length.max(20.0),
                props.depth.max(0.0),
                0.55 - props.sharpness.clamp(0.0, 1.0) * 0.5,
            ],
            [
                angle.cos(),
                angle.sin(),
                props.twist.clamp(0.0, 2.0),
                props.fill_light.clamp(0.0, 1.5),
            ],
            // Variation seed, gain, glow and the grain (React Bits passes
            // grain × 1.75; the grain is fixed in place, so a third stays).
            [
                props.variation,
                props.brightness.max(0.0),
                props.glow.max(0.0),
                props.grain.max(0.0) * 1.75 * STATIC_GRAIN,
            ],
            with(linear(hex(props.color)), 0.0),
            base(0.0),
        ]),
    }
}

fn beams_looks() -> Vec<LiveLook> {
    vec![
        beams("studio", "Studio", BEAMS_LOOK),
        beams(
            "chrome",
            "Chrome",
            Beams {
                sharpness: 0.8,
                depth: 1.2,
                fill_light: 0.9,
                glow: 0.4,
                rotation_degrees: 35.0,
                ..BEAMS_LOOK
            },
        ),
        beams(
            "ember",
            "Ember",
            Beams {
                color: "#ff8a4c",
                rotation_degrees: 20.0,
                glow: 0.85,
                fill_light: 0.2,
                ..BEAMS_LOOK
            },
        ),
    ]
}

// ---------------------------------------------------------------- Color Bends (plan 194)

/// React Bits' `MAX_COLORS`: `u[5..13]`.
pub const COLOR_BENDS_MAX_COLORS: usize = 8;

struct ColorBends {
    colors: &'static [&'static str],
    rotation_degrees: f32,
    speed: f64,
    scale: f32,
    frequency: f32,
    warp_strength: f32,
    /// The pull toward the pointer, which rests at the centre (N3): React
    /// Bits shows this pull at rest, so it stays.
    mouse_influence: f32,
    noise: f32,
    iterations: f32,
    intensity: f32,
    band_width: f32,
}

/// Background Studio's defaults (`src/tools/background-studio/backgrounds`).
const COLOR_BENDS_LOOK: ColorBends = ColorBends {
    colors: &["#5227FF", "#FF9FFC", "#7cff67"],
    rotation_degrees: 90.0,
    speed: 0.2,
    scale: 1.0,
    frequency: 1.0,
    warp_strength: 1.0,
    mouse_influence: 1.0,
    noise: 0.15,
    iterations: 1.0,
    intensity: 1.5,
    band_width: 6.0,
};

fn color_bends(id: &'static str, name: &'static str, props: ColorBends) -> LiveLook {
    let angle = props.rotation_degrees.to_radians();
    let count = props.colors.len().min(COLOR_BENDS_MAX_COLORS);
    let mut statics = [[0.0; 4]; STATIC_VEC4_COUNT];
    statics[0] = [angle.cos(), angle.sin(), props.scale, props.frequency];
    // React Bits' noise changes every frame; Videorc's is fixed in place at a
    // third, so the bands keep their texture without costing a stream bits.
    statics[1] = [
        props.warp_strength,
        props.noise * STATIC_GRAIN,
        props.iterations,
        props.intensity,
    ];
    statics[2] = [props.band_width, count as f32, props.mouse_influence, 0.0];
    for (slot, color) in props.colors.iter().take(count).enumerate() {
        statics[3 + slot] = with(hex(color), 0.0);
    }
    statics[3 + COLOR_BENDS_MAX_COLORS] = base(0.0);
    LiveLook {
        id,
        name,
        rate: props.speed,
        poster_phase: 3.0,
        statics,
    }
}

fn color_bends_looks() -> Vec<LiveLook> {
    vec![
        color_bends("default", "Default", COLOR_BENDS_LOOK),
        color_bends(
            "ember",
            "Ember",
            ColorBends {
                colors: &["#ff6a1a", "#ff2d6f", "#ffd59a"],
                ..COLOR_BENDS_LOOK
            },
        ),
        color_bends(
            "ocean",
            "Ocean",
            ColorBends {
                colors: &["#2a4bd7", "#06b6d4", "#93c5fd"],
                ..COLOR_BENDS_LOOK
            },
        ),
    ]
}

// ---------------------------------------------------------------- Dither (plan 194)

/// React Bits' `MAX_PALETTE`: `u[7..15]`.
pub const DITHER_MAX_PALETTE: usize = 8;

/// React Bits' `MODES`.
#[derive(Clone, Copy)]
enum DitherMode {
    Bayer = 0,
    Lines = 4,
    Crosshatch = 5,
}

struct Dither {
    wave_color: &'static str,
    background_color: &'static str,
    mode: DitherMode,
    palette: &'static [&'static str],
    color_num: f32,
    pixel_size: f32,
    scale: f32,
    wave_speed: f32,
    wave_frequency: f32,
    wave_amplitude: f32,
    contrast: f32,
    brightness: f32,
}

const DITHER_LOOK: Dither = Dither {
    wave_color: "#bcbcbc",
    background_color: "#120f17",
    mode: DitherMode::Bayer,
    palette: &[],
    color_num: 4.0,
    pixel_size: 2.0,
    scale: 1.0,
    wave_speed: 0.05,
    wave_frequency: 3.0,
    wave_amplitude: 0.3,
    contrast: 1.0,
    brightness: 0.0,
};

fn dither(id: &'static str, name: &'static str, props: Dither) -> LiveLook {
    let count = props.palette.len().min(DITHER_MAX_PALETTE);
    let mut statics = [[0.0; 4]; STATIC_VEC4_COUNT];
    statics[0] = [
        props.wave_speed,
        props.wave_frequency,
        props.wave_amplitude,
        props.scale.max(0.05),
    ];
    // Pixel size in CSS pixels (one cell is `round(pixel_size × pixel_scale)`
    // render pixels) and the dither mode.
    statics[1] = [
        props.contrast,
        props.brightness,
        props.pixel_size.max(1.0),
        props.mode as i32 as f32,
    ];
    statics[2] = [props.color_num.max(2.0), count as f32, 0.0, 0.0];
    // Dither linearises its colours exactly and its shader applies the
    // inverse, as React Bits does.
    statics[3] = with(srgb_linear(hex(props.wave_color)), 0.0);
    statics[4] = with(srgb_linear(hex(props.background_color)), 0.0);
    for (slot, color) in props.palette.iter().take(count).enumerate() {
        statics[5 + slot] = with(srgb_linear(hex(color)), 0.0);
    }
    LiveLook {
        id,
        name,
        // React Bits advances Dither's time by the wall clock; the wave speed
        // is a look constant inside the shader.
        rate: 1.0,
        poster_phase: 12.0,
        statics,
    }
}

fn dither_looks() -> Vec<LiveLook> {
    vec![
        dither("classic", "Classic", DITHER_LOOK),
        dither(
            "amber",
            "Amber",
            Dither {
                mode: DitherMode::Lines,
                palette: &["#0b0603", "#5c2e05", "#d97706", "#ffd08a"],
                scale: 1.2,
                ..DITHER_LOOK
            },
        ),
        dither(
            "blueprint",
            "Blueprint",
            Dither {
                mode: DitherMode::Crosshatch,
                palette: &["#0d2a57", "#24508f", "#8fb5ea", "#e8f1ff"],
                ..DITHER_LOOK
            },
        ),
    ]
}

// ---------------------------------------------------------------- Ferrofluid (plan 194)

#[derive(Clone, Copy)]
enum FerrofluidFlow {
    Down,
}

struct Ferrofluid {
    colors: [&'static str; 3],
    speed: f64,
    scale: f64,
    spike_height: f64,
    sharpness: f64,
    turbulence: f32,
    tilt_degrees: f64,
    magnetism: f32,
    variation: f32,
    flow: FerrofluidFlow,
    brightness: f32,
}

/// React Bits' camera: a 38° field of view.
const FERROFLUID_FOV_DEGREES: f64 = 38.0;

const FERROFLUID_LOOK: Ferrofluid = Ferrofluid {
    colors: ["#ffffff", "#ffffff", "#ffffff"],
    speed: 0.5,
    scale: 1.6,
    spike_height: 1.0,
    sharpness: 2.5,
    turbulence: 1.0,
    tilt_degrees: 48.0,
    magnetism: 1.0,
    variation: 0.0,
    flow: FerrofluidFlow::Down,
    brightness: 1.0,
};

/// The camera React Bits lays out from a look's scale and tilt (its
/// `layout()`), in world units. Every renderer and the size rules share it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FerrofluidCamera {
    pub tan_half: f64,
    /// The camera sits at (0, y, z) looking along `forward` with `upward`.
    pub y: f64,
    pub z: f64,
    pub forward: [f64; 2],
    pub upward: [f64; 2],
    pub far: f64,
    pub fog_start: f64,
}

pub fn ferrofluid_camera(scale: f64, tilt_degrees: f64) -> FerrofluidCamera {
    let tan_half = (FERROFLUID_FOV_DEGREES / 2.0).to_radians().tan();
    let world_height = 22.0 / scale.clamp(0.2, 6.0);
    let pitch = (90.0 - tilt_degrees.clamp(10.0, 70.0)).to_radians();
    let distance = world_height / (2.0 * tan_half);
    FerrofluidCamera {
        tan_half,
        y: -distance * pitch.cos(),
        z: distance * pitch.sin(),
        forward: [pitch.cos(), -pitch.sin()],
        upward: [pitch.sin(), pitch.cos()],
        far: distance * 2.5,
        fog_start: distance * 0.95,
    }
}

/// The ferrofluid look's camera, from its packed statics (the export and,
/// from S3, the renderers' grid sizing).
#[cfg_attr(not(test), allow(dead_code))]
pub fn ferrofluid_look_camera(look: &LiveLook) -> FerrofluidCamera {
    FerrofluidCamera {
        tan_half: (FERROFLUID_FOV_DEGREES / 2.0).to_radians().tan(),
        y: f64::from(look.statics[2][0]),
        z: f64::from(look.statics[2][1]),
        forward: [f64::from(look.statics[3][0]), f64::from(look.statics[3][1])],
        upward: [f64::from(look.statics[3][2]), f64::from(look.statics[3][3])],
        far: f64::from(look.statics[2][2]),
        fog_start: f64::from(look.statics[2][3]),
    }
}

fn ferrofluid(id: &'static str, name: &'static str, props: Ferrofluid) -> LiveLook {
    let camera = ferrofluid_camera(props.scale, props.tilt_degrees);
    let full_height = 1.2 * props.spike_height.max(0.0);
    // React Bits' `shapeOf(sharpness)`.
    let edge = ((props.sharpness.clamp(0.6, 6.0) - 1.0) / 4.0).clamp(0.0, 1.0);
    let round = 1.0 - edge * 0.7;
    let exponent = 1.05 + edge * 1.2;
    let span = (1.0 + round * round).sqrt() - round;
    let flow = match props.flow {
        FerrofluidFlow::Down => [0.0, -1.0],
    };
    let turbulence = props.turbulence.max(0.0);
    LiveLook {
        id,
        name,
        rate: props.speed.max(0.0),
        poster_phase: 5.0,
        statics: pad([
            [flow[0], flow[1], turbulence, props.magnetism.max(0.0)],
            // The variation seed and the full spike height (1.2 × spikeHeight).
            [
                props.variation * 17.31,
                props.variation * 9.73,
                full_height as f32,
                0.0,
            ],
            [
                camera.y as f32,
                camera.z as f32,
                camera.far as f32,
                camera.fog_start as f32,
            ],
            [
                camera.forward[0] as f32,
                camera.forward[1] as f32,
                camera.upward[0] as f32,
                camera.upward[1] as f32,
            ],
            // The march's ceiling, then the spike profile.
            [
                (full_height * 1.6 + 0.6 * 3.0 + 0.1) as f32,
                round as f32,
                span as f32,
                exponent as f32,
            ],
            // Lattice warp and exposure.
            [0.06 * turbulence, 3.0 * props.brightness.max(0.0), 0.0, 0.0],
            with(hex(props.colors[0]), 0.0),
            with(hex(props.colors[1]), 0.0),
            with(hex(props.colors[2]), 0.0),
            base(0.0),
        ]),
    }
}

fn ferrofluid_looks() -> Vec<LiveLook> {
    vec![
        ferrofluid("studio", "Studio", FERROFLUID_LOOK),
        ferrofluid(
            "ember",
            "Ember",
            Ferrofluid {
                colors: ["#ffd2a1", "#ff8a4c", "#ff6a3d"],
                brightness: 1.1,
                ..FERROFLUID_LOOK
            },
        ),
        ferrofluid(
            "frost",
            "Frost",
            Ferrofluid {
                colors: ["#dff1ff", "#6cb6ff", "#8fb0ff"],
                ..FERROFLUID_LOOK
            },
        ),
    ]
}

// ---------------------------------------------------------------- Ghost Fibers (plan 194)

#[derive(Clone, Copy)]
enum GhostFibersGradient {
    Depth = 0,
    Along = 1,
}

/// React Bits' `FIBER_STYLES`: the dot length along the fiber.
#[derive(Clone, Copy)]
enum GhostFibersStyle {
    Dots,
    Dashes,
    Lines,
}

struct GhostFibers {
    glow_color: &'static str,
    line_color: &'static str,
    secondary_color: &'static str,
    gradient: GhostFibersGradient,
    speed: f64,
    scale: f32,
    rotation_degrees: f64,
    roll_speed: f32,
    layers: f32,
    waves: f32,
    twist: f32,
    threads: f32,
    volume: f32,
    spread: f32,
    density: f32,
    thickness: f32,
    flow: f64,
    style: GhostFibersStyle,
    tips: f32,
    fold_glow: f32,
    perspective: f64,
    depth_of_field: f32,
    focus_depth: f32,
    particles: f32,
    sparkle: f32,
    glow: f32,
    brightness: f32,
    vignette: f32,
    grain: f32,
}

/// React Bits' `CAMERA`: the eye sits at z = 7.5.
pub const GHOST_FIBERS_CAMERA: f32 = 7.5;

const GHOST_FIBERS_LOOK: GhostFibers = GhostFibers {
    glow_color: "#8b5cf6",
    line_color: "#dfd1fc",
    secondary_color: "#6f4ac5",
    gradient: GhostFibersGradient::Depth,
    speed: 0.5,
    scale: 1.0,
    rotation_degrees: 18.0,
    roll_speed: 0.15,
    layers: 3.0,
    waves: 1.0,
    twist: 1.2,
    threads: 72.0,
    volume: 0.7,
    spread: 1.0,
    density: 1.0,
    thickness: 1.0,
    flow: 0.4,
    style: GhostFibersStyle::Dots,
    tips: 0.0,
    fold_glow: 1.0,
    perspective: 0.65,
    depth_of_field: 0.85,
    focus_depth: 0.0,
    particles: 0.5,
    sparkle: 0.5,
    glow: 0.8,
    brightness: 1.0,
    vignette: 0.3,
    grain: 0.06,
};

/// React Bits' `orientation(yaw, pitch, roll)`: a column-major 3 × 3.
fn ghost_fibers_orientation(yaw: f64, pitch: f64, roll: f64) -> [f64; 9] {
    let (cy, sy) = (yaw.cos(), yaw.sin());
    let (cp, sp) = (pitch.cos(), pitch.sin());
    let (cr, sr) = (roll.cos(), roll.sin());
    let ry = [cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy];
    let rx = [1.0, 0.0, 0.0, 0.0, cp, sp, 0.0, -sp, cp];
    let rz = [cr, sr, 0.0, -sr, cr, 0.0, 0.0, 0.0, 1.0];
    let mul = |a: [f64; 9], b: [f64; 9]| {
        let mut out = [0.0; 9];
        for col in 0..3 {
            for row in 0..3 {
                out[col * 3 + row] =
                    a[row] * b[col * 3] + a[3 + row] * b[col * 3 + 1] + a[6 + row] * b[col * 3 + 2];
            }
        }
        out
    };
    mul(rz, mul(rx, ry))
}

/// Where the instanced passes read their counts from a ghost fibers look's
/// statics (`u[3].zw` and `u[6].w`, `u[8].z`).
const GHOST_FIBERS_THREADS: (usize, usize) = (1, 2);
const GHOST_FIBERS_DOTS: (usize, usize) = (1, 3);
const GHOST_FIBERS_LAYERS: (usize, usize) = (4, 3);
const GHOST_FIBERS_DUST: (usize, usize) = (6, 2);

/// The instance counts of Ghost Fibers' two instanced passes (plan 194 N2):
/// one quad per dot of every fiber of every ribbon, and one per dust mote.
/// They come from the look only; the guard's half size shrinks the target,
/// not the fibers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GhostFibersInstances {
    pub dots: u32,
    pub dust: u32,
}

pub fn ghost_fibers_instances(look: &LiveLook) -> GhostFibersInstances {
    let at = |(row, column): (usize, usize)| look.statics[row][column].round().max(0.0) as u32;
    GhostFibersInstances {
        dots: at(GHOST_FIBERS_LAYERS) * at(GHOST_FIBERS_THREADS) * at(GHOST_FIBERS_DOTS),
        dust: at(GHOST_FIBERS_DUST),
    }
}

fn ghost_fibers(id: &'static str, name: &'static str, props: GhostFibers) -> LiveLook {
    let scale = props.scale.clamp(0.3, 3.0);
    let layers = props.layers.round().clamp(1.0, 3.0);
    let threads = props.threads.round().clamp(6.0, 180.0);
    let density = props.density.clamp(0.2, 3.0);
    let thickness = props.thickness.clamp(0.2, 4.0);
    let speed = props.speed.max(0.0);
    // React Bits' `render()`: dots per fiber, the blur cap and the load gain.
    let dots = (260.0 * density).round();
    let blur_cap = 22.0
        * (56000.0 / (threads * dots * layers))
            .sqrt()
            .clamp(0.45, 1.0);
    let area = (0.8 * thickness).max(0.45).powi(2) / 0.64;
    let load = ((threads / 72.0) * density * area).powf(-0.75);
    let dust = (420.0 * props.particles.clamp(0.0, 2.0)).round();
    // Its flow advances by dt × flow × 12 on the wall clock while the phase
    // advances by dt × speed, so flow = phase × (flow × 12 / speed).
    let flow_per_phase = if speed > 0.0 {
        (props.flow * 12.0 / speed) as f32
    } else {
        0.0
    };
    let dot_length = match props.style {
        GhostFibersStyle::Dots => 0.0,
        GhostFibersStyle::Dashes => 0.45,
        GhostFibersStyle::Lines => 1.0,
    };
    // The pointer rests (its look is 0), so the orientation is a constant.
    let orient = ghost_fibers_orientation(
        props.perspective.clamp(0.0, 1.0) * 0.85,
        0.12,
        props.rotation_degrees.to_radians(),
    )
    .map(|value| value as f32);
    let statics = pad([
        [
            props.twist.max(0.0),
            props.roll_speed,
            props.waves.max(0.0),
            0.62 * props.spread.clamp(0.2, 3.0),
        ],
        [scale, props.volume.clamp(0.0, 2.0), threads, dots],
        [
            flow_per_phase,
            1.6 * thickness,
            GHOST_FIBERS_CAMERA + props.focus_depth.clamp(-1.0, 1.0) * 3.0,
            props.depth_of_field.clamp(0.0, 2.0),
        ],
        [blur_cap, dot_length, props.sparkle.clamp(0.0, 2.0), load],
        [
            props.tips.clamp(0.0, 1.0),
            props.gradient as i32 as f32,
            props.fold_glow.clamp(0.0, 3.0),
            layers,
        ],
        // The composite: glow, brightness, the (fixed, reduced) grain, vignette.
        [
            props.glow.max(0.0),
            props.brightness.max(0.0),
            props.grain.max(0.0) * STATIC_GRAIN,
            props.vignette.clamp(0.0, 1.0),
        ],
        // The dust pass: its dot size, gain and count.
        [2.2 * thickness, 1.0 / thickness, dust, 0.0],
        [orient[0], orient[1], orient[2], 0.0],
        [orient[3], orient[4], orient[5], 0.0],
        [orient[6], orient[7], orient[8], 0.0],
        with(hex(props.glow_color), 0.0),
        with(hex(props.line_color), 0.0),
        with(hex(props.secondary_color), 0.0),
        base(0.0),
    ]);
    LiveLook {
        id,
        name,
        rate: speed,
        poster_phase: 9.0,
        statics,
    }
}

fn ghost_fibers_looks() -> Vec<LiveLook> {
    vec![
        ghost_fibers("violet", "Violet", GHOST_FIBERS_LOOK),
        ghost_fibers(
            "fiber",
            "Fiber Optic",
            GhostFibers {
                glow_color: "#3b6bff",
                line_color: "#dff4ff",
                secondary_color: "#22d3ee",
                gradient: GhostFibersGradient::Along,
                style: GhostFibersStyle::Lines,
                tips: 1.0,
                layers: 2.0,
                twist: 0.5,
                waves: 0.8,
                volume: 0.5,
                threads: 96.0,
                flow: 0.25,
                fold_glow: 0.3,
                sparkle: 0.3,
                depth_of_field: 1.1,
                ..GHOST_FIBERS_LOOK
            },
        ),
        ghost_fibers(
            "ember",
            "Ember",
            GhostFibers {
                glow_color: "#ff6a1a",
                line_color: "#ffd9a8",
                secondary_color: "#e11d48",
                style: GhostFibersStyle::Dashes,
                flow: 0.9,
                speed: 0.7,
                sparkle: 1.0,
                particles: 0.9,
                twist: 0.9,
                rotation_degrees: 8.0,
                ..GHOST_FIBERS_LOOK
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

    /// Plan 194 widened the block; the plan 190 five keep their indices and
    /// the new rows are zero, so their goldens cannot move.
    #[test]
    fn the_wider_block_pads_the_plan_190_looks_with_zeros() {
        assert_eq!(UNIFORM_VEC4_COUNT, 16);
        for id in &ALL_LIVE_BACKGROUNDS[..5] {
            for look in looks(*id) {
                assert!(look.statics[7..].iter().all(|row| *row == [0.0; 4]));
            }
        }
        let satin = &looks(LiveBackgroundId::Silk)[0];
        assert_eq!(satin.statics[4][0], 0.3, "Silk's glow stays at u[6].x");
        let packed = uniforms(satin, (480, 270), (1920, 1080), 3.0, 0.0);
        assert_eq!(packed.len(), 16);
        assert_eq!(packed[6][0], 0.3);
    }

    #[test]
    fn ghost_fibers_instances_follow_react_bits_counts() {
        // Violet: 3 ribbons × 72 threads × round(260 × 1) dots, round(420 × 0.5) dust.
        let violet = &looks(LiveBackgroundId::GhostFibers)[0];
        assert_eq!(
            ghost_fibers_instances(violet),
            GhostFibersInstances {
                dots: 3 * 72 * 260,
                dust: 210
            }
        );
        // Fiber Optic: 2 ribbons × 96 threads.
        let fiber = &looks(LiveBackgroundId::GhostFibers)[1];
        assert_eq!(ghost_fibers_instances(fiber).dots, 2 * 96 * 260);
        // Ember: 0.9 particles.
        let ember = &looks(LiveBackgroundId::GhostFibers)[2];
        assert_eq!(ghost_fibers_instances(ember).dust, 378);
        // The blur cap for violet: 22 × clamp(sqrt(56000 / 56160), 0.45, 1).
        let expected = 22.0 * (56000.0_f32 / 56160.0).sqrt();
        assert!((violet.statics[3][0] - expected).abs() < 1e-4);
        // Flow per phase unit: 0.4 × 12 / 0.5.
        assert!((violet.statics[2][0] - 9.6).abs() < 1e-5);
        assert!((violet.rate - 0.5).abs() < 1e-9);
    }

    #[test]
    fn ghost_fibers_orientation_matches_react_bits() {
        // orientation(0, 0, 0) is the identity; a pure roll rotates x into y.
        let identity = ghost_fibers_orientation(0.0, 0.0, 0.0);
        assert_eq!(identity, [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        let roll = ghost_fibers_orientation(0.0, 0.0, std::f64::consts::FRAC_PI_2);
        assert!((roll[0]).abs() < 1e-12 && (roll[1] - 1.0).abs() < 1e-12);
        // The packed orientation is React Bits' (perspective × 0.85, 0.12, rotation).
        let violet = &looks(LiveBackgroundId::GhostFibers)[0];
        let expected = ghost_fibers_orientation(0.65 * 0.85, 0.12, 18.0_f64.to_radians());
        for column in 0..3 {
            for row in 0..3 {
                let packed = f64::from(violet.statics[7 + column][row]);
                assert!((packed - expected[column * 3 + row]).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn ferrofluid_camera_matches_react_bits_layout() {
        let camera = ferrofluid_camera(1.6, 48.0);
        let tan_half = 19.0_f64.to_radians().tan();
        let distance = (22.0 / 1.6) / (2.0 * tan_half);
        assert!((camera.tan_half - tan_half).abs() < 1e-12);
        assert!((camera.far - distance * 2.5).abs() < 1e-9);
        assert!((camera.fog_start - distance * 0.95).abs() < 1e-9);
        let pitch = 42.0_f64.to_radians();
        assert!((camera.z - distance * pitch.sin()).abs() < 1e-9);
        assert!((camera.y + distance * pitch.cos()).abs() < 1e-9);
        let studio = &looks(LiveBackgroundId::Ferrofluid)[0];
        let from_look = ferrofluid_look_camera(studio);
        assert!((from_look.z - camera.z).abs() < 1e-3);
        assert!((from_look.forward[1] - camera.forward[1]).abs() < 1e-6);
        // The spike profile of sharpness 2.5: edge 0.375.
        assert!((studio.statics[4][1] - (1.0 - 0.375 * 0.7)).abs() < 1e-6);
        assert!((studio.statics[4][3] - (1.05 + 0.375 * 1.2)).abs() < 1e-6);
    }

    #[test]
    fn colour_arrays_carry_their_count_and_dither_linearises_exactly() {
        let default = &looks(LiveBackgroundId::ColorBends)[0];
        assert_eq!(default.statics[2][1], 3.0);
        assert!((default.statics[3][0] - 0x52 as f32 / 255.0).abs() < 1e-6);
        assert_eq!(default.statics[6], [0.0; 4], "unused colour slots are zero");
        assert_eq!(default.statics[11][0], BASE_COLOR[0]);
        let amber = &looks(LiveBackgroundId::Dither)[1];
        assert_eq!(amber.statics[2][1], 4.0);
        assert_eq!(amber.statics[1][3], 4.0, "lines mode");
        // #ffd08a's red is 1.0 in linear light; #0b0603's green (6/255) is
        // below the sRGB knee and its red (11/255) above it.
        assert_eq!(amber.statics[8][0], 1.0);
        assert!((amber.statics[5][1] - (6.0 / 255.0) / 12.92).abs() < 1e-6);
        let red = ((11.0_f32 / 255.0 + 0.055) / 1.055).powf(2.4);
        assert!((amber.statics[5][0] - red).abs() < 1e-6);
        let classic = &looks(LiveBackgroundId::Dither)[0];
        assert_eq!(classic.statics[2][1], 0.0);
        assert_eq!(classic.rate, 1.0);
    }

    #[test]
    fn beams_grain_and_tint_follow_the_porting_rules() {
        let studio = &looks(LiveBackgroundId::Beams)[0];
        // The grain is fixed in place: a third of React Bits' grain × 1.75.
        assert!((studio.statics[2][3] - 0.35 * 1.75 / 3.0).abs() < 1e-6);
        // Roughness 0.55 − sharpness × 0.5.
        assert!((studio.statics[0][3] - 0.25).abs() < 1e-6);
        let ember = &looks(LiveBackgroundId::Beams)[2];
        assert!((ember.statics[3][0] - (0xff as f32 / 255.0).powf(2.2)).abs() < 1e-6);
        assert!((ember.statics[3][1] - (0x8a as f32 / 255.0).powf(2.2)).abs() < 1e-6);
    }
}
