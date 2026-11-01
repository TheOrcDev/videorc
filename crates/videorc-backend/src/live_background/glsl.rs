//! The GLSL ES 3.00 sources: the source of truth. The Linux renderer compiles
//! them as they are; the Electron previews get them through the generated
//! desktop JSON; Metal and D3D11 run hand ports checked against golden frames
//! rendered from them.

// Only the Linux renderer and the desktop JSON export (a test) read the
// sources; macOS and Windows use the pass list.
#![cfg_attr(
    not(any(test, target_os = "linux", feature = "live-background-gl-check")),
    allow(dead_code)
)]

use std::borrow::Cow;

use super::looks::{LiveLook, ghost_fibers_instances};
use crate::protocol::LiveBackgroundId;

pub const SILK: &str = include_str!("glsl/silk.frag");
pub const SIDE_RAYS: &str = include_str!("glsl/side_rays.frag");
pub const PLASMA_WAVE: &str = include_str!("glsl/plasma_wave.frag");
pub const LIQUID_CHROME: &str = include_str!("glsl/liquid_chrome.frag");
pub const LINE_WAVES: &str = include_str!("glsl/line_waves.frag");
pub const BEAMS: &str = include_str!("glsl/beams.frag");
pub const COLOR_BENDS: &str = include_str!("glsl/color_bends.frag");
pub const DITHER: &str = include_str!("glsl/dither.frag");
pub const FERROFLUID: &str = include_str!("glsl/ferrofluid.frag");
pub const GHOST_FIBERS: &str = include_str!("glsl/ghost_fibers.frag");
/// The vertex shaders of Ghost Fibers' two instanced passes (plan 194 N2).
pub const GHOST_FIBERS_VERTEX: &str = include_str!("glsl/ghost_fibers.vert");

/// A full-screen triangle; every full-screen pass uses it.
pub const VERTEX: &str = "#version 300 es
const vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() {
  gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
}
";

/// One shader program. Its render order per frame:
/// - Silk: `SilkField` (quarter size, then mipmaps) → `SilkComposite`.
/// - Plasma Wave: `PlasmaCoarse` → `PlasmaFine` → `PlasmaDown` ×5 →
///   `PlasmaUp` ×3 (levels 3, 2, 1) → `PlasmaComposite`.
/// - Beams: `BeamsField` (three quarters, then mipmaps) → `BeamsComposite`.
/// - Dither: `DitherWave` (one texel per cell) → `DitherComposite`.
/// - Ferrofluid: `FerrofluidField` (the grid, N1: the settled target) →
///   `FerrofluidBound` (the 9 × 9 maximum per world unit) →
///   `FerrofluidRender`.
/// - Ghost Fibers: `GhostFibersDots` (instanced, additive, into a cleared
///   scene) → `GhostFibersDust` (instanced, additive, into the same scene)
///   → `GhostFibersBright` (level 0) → `GhostFibersDown` ×4 (levels 1–4) →
///   `GhostFibersUp` ×4 (levels 3, 2, 1, 0; each adds the matching down
///   level, as Plasma's does) → `GhostFibersComposite` (scene and up level 0).
/// - The rest: one pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LivePass {
    SilkField,
    SilkComposite,
    SideRays,
    PlasmaCoarse,
    PlasmaFine,
    PlasmaDown,
    PlasmaUp,
    PlasmaComposite,
    LiquidChrome,
    LineWaves,
    BeamsField,
    BeamsComposite,
    ColorBends,
    DitherWave,
    DitherComposite,
    FerrofluidField,
    FerrofluidBound,
    FerrofluidRender,
    GhostFibersDots,
    GhostFibersDust,
    GhostFibersBright,
    GhostFibersDown,
    GhostFibersUp,
    GhostFibersComposite,
}

/// How a pass's fragments land in its target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassBlend {
    /// The pass overwrites its target. Plan 194's design names it; no
    /// instanced pass replaces yet (full-screen passes always do).
    #[allow(dead_code)]
    Replace,
    /// `ONE, ONE`: the pass adds to what the target holds.
    Additive,
}

/// What a pass draws (plan 194 "The instanced pass kind").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassKind {
    /// The full-screen triangle (`VERTEX`).
    FullScreen,
    /// `instances` quads of `vertices` strip vertices, every position derived
    /// from the instance and vertex ids in the pass's own vertex shader;
    /// nothing is uploaded.
    Instanced {
        vertices: u32,
        instances: u32,
        blend: PassBlend,
    },
}

impl LivePass {
    pub fn background(self) -> LiveBackgroundId {
        match self {
            Self::SilkField | Self::SilkComposite => LiveBackgroundId::Silk,
            Self::SideRays => LiveBackgroundId::SideRays,
            Self::PlasmaCoarse
            | Self::PlasmaFine
            | Self::PlasmaDown
            | Self::PlasmaUp
            | Self::PlasmaComposite => LiveBackgroundId::PlasmaWave,
            Self::LiquidChrome => LiveBackgroundId::LiquidChrome,
            Self::LineWaves => LiveBackgroundId::LineWaves,
            Self::BeamsField | Self::BeamsComposite => LiveBackgroundId::Beams,
            Self::ColorBends => LiveBackgroundId::ColorBends,
            Self::DitherWave | Self::DitherComposite => LiveBackgroundId::Dither,
            Self::FerrofluidField | Self::FerrofluidBound | Self::FerrofluidRender => {
                LiveBackgroundId::Ferrofluid
            }
            Self::GhostFibersDots
            | Self::GhostFibersDust
            | Self::GhostFibersBright
            | Self::GhostFibersDown
            | Self::GhostFibersUp
            | Self::GhostFibersComposite => LiveBackgroundId::GhostFibers,
        }
    }

    /// The pass's key in the generated desktop JSON.
    pub fn key(self) -> &'static str {
        match self {
            Self::SilkField | Self::BeamsField | Self::FerrofluidField => "field",
            Self::PlasmaCoarse => "coarse",
            Self::PlasmaFine => "fine",
            Self::PlasmaDown | Self::GhostFibersDown => "down",
            Self::PlasmaUp | Self::GhostFibersUp => "up",
            Self::SilkComposite
            | Self::PlasmaComposite
            | Self::BeamsComposite
            | Self::DitherComposite
            | Self::GhostFibersComposite => "composite",
            Self::SideRays | Self::LiquidChrome | Self::LineWaves | Self::ColorBends => "main",
            Self::DitherWave => "wave",
            Self::FerrofluidBound => "bound",
            Self::FerrofluidRender => "render",
            Self::GhostFibersDots => "dots",
            Self::GhostFibersDust => "dust",
            Self::GhostFibersBright => "bright",
        }
    }

    /// What the pass draws. Only Ghost Fibers' dots and dust are instanced:
    /// their counts come from the look (`ghost_fibers_instances`).
    pub fn kind(self, look: &LiveLook) -> PassKind {
        match self {
            Self::GhostFibersDots => PassKind::Instanced {
                vertices: 4,
                instances: ghost_fibers_instances(look).dots,
                blend: PassBlend::Additive,
            },
            Self::GhostFibersDust => PassKind::Instanced {
                vertices: 4,
                instances: ghost_fibers_instances(look).dust,
                blend: PassBlend::Additive,
            },
            _ => PassKind::FullScreen,
        }
    }

    /// Whether the pass's target must be cleared to transparent black before
    /// it draws: the first additive pass into a scene target. Every other
    /// pass covers its target.
    pub fn clears_target(self) -> bool {
        matches!(self, Self::GhostFibersDots)
    }

    fn define(self) -> Option<&'static str> {
        match self {
            Self::SilkField | Self::BeamsField | Self::FerrofluidField => {
                Some("VIDEORC_PASS_FIELD")
            }
            Self::PlasmaCoarse => Some("VIDEORC_PASS_COARSE"),
            Self::PlasmaFine => Some("VIDEORC_PASS_FINE"),
            Self::PlasmaDown | Self::GhostFibersDown => Some("VIDEORC_PASS_DOWN"),
            Self::PlasmaUp | Self::GhostFibersUp => Some("VIDEORC_PASS_UP"),
            Self::DitherWave => Some("VIDEORC_PASS_WAVE"),
            Self::FerrofluidBound => Some("VIDEORC_PASS_BOUND"),
            Self::GhostFibersDots => Some("VIDEORC_PASS_DOTS"),
            Self::GhostFibersDust => Some("VIDEORC_PASS_DUST"),
            Self::GhostFibersBright => Some("VIDEORC_PASS_BRIGHT"),
            _ => None,
        }
    }
}

/// The distinct programs a background needs.
pub fn passes(id: LiveBackgroundId) -> &'static [LivePass] {
    match id {
        LiveBackgroundId::Silk => &[LivePass::SilkField, LivePass::SilkComposite],
        LiveBackgroundId::SideRays => &[LivePass::SideRays],
        LiveBackgroundId::PlasmaWave => &[
            LivePass::PlasmaCoarse,
            LivePass::PlasmaFine,
            LivePass::PlasmaDown,
            LivePass::PlasmaUp,
            LivePass::PlasmaComposite,
        ],
        LiveBackgroundId::LiquidChrome => &[LivePass::LiquidChrome],
        LiveBackgroundId::LineWaves => &[LivePass::LineWaves],
        LiveBackgroundId::Beams => &[LivePass::BeamsField, LivePass::BeamsComposite],
        LiveBackgroundId::ColorBends => &[LivePass::ColorBends],
        LiveBackgroundId::Dither => &[LivePass::DitherWave, LivePass::DitherComposite],
        LiveBackgroundId::Ferrofluid => &[
            LivePass::FerrofluidField,
            LivePass::FerrofluidBound,
            LivePass::FerrofluidRender,
        ],
        LiveBackgroundId::GhostFibers => &[
            LivePass::GhostFibersDots,
            LivePass::GhostFibersDust,
            LivePass::GhostFibersBright,
            LivePass::GhostFibersDown,
            LivePass::GhostFibersUp,
            LivePass::GhostFibersComposite,
        ],
    }
}

pub fn background_source(id: LiveBackgroundId) -> &'static str {
    match id {
        LiveBackgroundId::Silk => SILK,
        LiveBackgroundId::SideRays => SIDE_RAYS,
        LiveBackgroundId::PlasmaWave => PLASMA_WAVE,
        LiveBackgroundId::LiquidChrome => LIQUID_CHROME,
        LiveBackgroundId::LineWaves => LINE_WAVES,
        LiveBackgroundId::Beams => BEAMS,
        LiveBackgroundId::ColorBends => COLOR_BENDS,
        LiveBackgroundId::Dither => DITHER,
        LiveBackgroundId::Ferrofluid => FERROFLUID,
        LiveBackgroundId::GhostFibers => GHOST_FIBERS,
    }
}

/// `source` with `define` inserted after its `#version` line.
fn with_define(source: &'static str, define: Option<&str>) -> Cow<'static, str> {
    let Some(define) = define else {
        return Cow::Borrowed(source);
    };
    let (version, rest) = source.split_once('\n').unwrap_or((source, ""));
    Cow::Owned(format!("{version}\n#define {define}\n{rest}"))
}

/// The compilable fragment source for a pass: the background's file with the
/// pass's `#define` inserted after the `#version` line.
pub fn fragment_source(pass: LivePass) -> Cow<'static, str> {
    with_define(background_source(pass.background()), pass.define())
}

/// The compilable vertex source for a pass: the full-screen triangle, or an
/// instanced pass's own vertex shader with the pass's `#define`.
pub fn vertex_source(pass: LivePass) -> Cow<'static, str> {
    match pass {
        LivePass::GhostFibersDots | LivePass::GhostFibersDust => {
            with_define(GHOST_FIBERS_VERTEX, pass.define())
        }
        _ => Cow::Borrowed(VERTEX),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_background::{ALL_LIVE_BACKGROUNDS, UNIFORM_VEC4_COUNT, looks};

    #[test]
    fn every_source_is_glsl_es_300_with_the_packed_uniforms_and_credit() {
        let declaration = format!("uniform vec4 u[{UNIFORM_VEC4_COUNT}];");
        for id in ALL_LIVE_BACKGROUNDS {
            let source = background_source(id);
            assert!(source.starts_with("#version 300 es\n"), "{id:?}");
            assert!(source.contains(&declaration), "{id:?}");
            assert!(source.contains("React Bits by David Haz"), "{id:?}");
        }
        assert!(GHOST_FIBERS_VERTEX.starts_with("#version 300 es\n"));
        assert!(GHOST_FIBERS_VERTEX.contains(&declaration));
        assert!(GHOST_FIBERS_VERTEX.contains("React Bits by David Haz"));
    }

    #[test]
    fn pass_defines_go_right_after_the_version_line() {
        let field = fragment_source(LivePass::SilkField);
        assert!(field.starts_with("#version 300 es\n#define VIDEORC_PASS_FIELD\n"));
        assert!(matches!(
            fragment_source(LivePass::SideRays),
            Cow::Borrowed(_)
        ));
        for pass in passes(LiveBackgroundId::PlasmaWave) {
            assert_eq!(pass.background(), LiveBackgroundId::PlasmaWave);
        }
        let dust = vertex_source(LivePass::GhostFibersDust);
        assert!(dust.starts_with("#version 300 es\n#define VIDEORC_PASS_DUST\n"));
        assert!(matches!(
            vertex_source(LivePass::GhostFibersBright),
            Cow::Borrowed(VERTEX)
        ));
    }

    #[test]
    fn every_pass_names_its_background_and_a_unique_key_per_background() {
        for id in ALL_LIVE_BACKGROUNDS {
            let mut keys = Vec::new();
            for pass in passes(id) {
                assert_eq!(pass.background(), id);
                assert!(!keys.contains(&pass.key()), "{id:?} {pass:?}");
                keys.push(pass.key());
            }
        }
    }

    #[test]
    fn only_ghost_fibers_dots_and_dust_are_instanced() {
        let violet = &looks(LiveBackgroundId::GhostFibers)[0];
        assert_eq!(
            LivePass::GhostFibersDots.kind(violet),
            PassKind::Instanced {
                vertices: 4,
                instances: 3 * 72 * 260,
                blend: PassBlend::Additive
            }
        );
        assert_eq!(
            LivePass::GhostFibersDust.kind(violet),
            PassKind::Instanced {
                vertices: 4,
                instances: 210,
                blend: PassBlend::Additive
            }
        );
        assert!(LivePass::GhostFibersDots.clears_target());
        assert!(!LivePass::GhostFibersDust.clears_target());
        for id in ALL_LIVE_BACKGROUNDS {
            for pass in passes(id) {
                if !matches!(pass, LivePass::GhostFibersDots | LivePass::GhostFibersDust) {
                    assert_eq!(pass.kind(&looks(id)[0]), PassKind::FullScreen);
                    assert!(!pass.clears_target());
                }
            }
        }
    }
}
