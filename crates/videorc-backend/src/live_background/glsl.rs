//! The GLSL ES 3.00 sources: the source of truth. The Linux renderer compiles
//! them as they are; the Electron previews get them through the generated
//! desktop JSON; Metal and D3D11 run hand ports checked against golden frames
//! rendered from them.

use std::borrow::Cow;

use crate::protocol::LiveBackgroundId;

pub const SILK: &str = include_str!("glsl/silk.frag");
pub const SIDE_RAYS: &str = include_str!("glsl/side_rays.frag");
pub const PLASMA_WAVE: &str = include_str!("glsl/plasma_wave.frag");
pub const LIQUID_CHROME: &str = include_str!("glsl/liquid_chrome.frag");
pub const LINE_WAVES: &str = include_str!("glsl/line_waves.frag");

/// A full-screen triangle; every pass uses it.
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
        }
    }

    /// The pass's key in the generated desktop JSON.
    pub fn key(self) -> &'static str {
        match self {
            Self::SilkField => "field",
            Self::PlasmaCoarse => "coarse",
            Self::PlasmaFine => "fine",
            Self::PlasmaDown => "down",
            Self::PlasmaUp => "up",
            Self::SilkComposite | Self::PlasmaComposite => "composite",
            Self::SideRays | Self::LiquidChrome | Self::LineWaves => "main",
        }
    }

    fn define(self) -> Option<&'static str> {
        match self {
            Self::SilkField => Some("VIDEORC_PASS_FIELD"),
            Self::PlasmaCoarse => Some("VIDEORC_PASS_COARSE"),
            Self::PlasmaFine => Some("VIDEORC_PASS_FINE"),
            Self::PlasmaDown => Some("VIDEORC_PASS_DOWN"),
            Self::PlasmaUp => Some("VIDEORC_PASS_UP"),
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
    }
}

pub fn background_source(id: LiveBackgroundId) -> &'static str {
    match id {
        LiveBackgroundId::Silk => SILK,
        LiveBackgroundId::SideRays => SIDE_RAYS,
        LiveBackgroundId::PlasmaWave => PLASMA_WAVE,
        LiveBackgroundId::LiquidChrome => LIQUID_CHROME,
        LiveBackgroundId::LineWaves => LINE_WAVES,
    }
}

/// The compilable fragment source for a pass: the background's file with the
/// pass's `#define` inserted after the `#version` line.
pub fn fragment_source(pass: LivePass) -> Cow<'static, str> {
    let source = background_source(pass.background());
    let Some(define) = pass.define() else {
        return Cow::Borrowed(source);
    };
    let (version, rest) = source.split_once('\n').unwrap_or((source, ""));
    Cow::Owned(format!("{version}\n#define {define}\n{rest}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_background::ALL_LIVE_BACKGROUNDS;

    #[test]
    fn every_source_is_glsl_es_300_with_the_packed_uniforms_and_credit() {
        for id in ALL_LIVE_BACKGROUNDS {
            let source = background_source(id);
            assert!(source.starts_with("#version 300 es\n"), "{id:?}");
            assert!(source.contains("uniform vec4 u[9];"), "{id:?}");
            assert!(source.contains("React Bits by David Haz"), "{id:?}");
        }
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
    }
}
