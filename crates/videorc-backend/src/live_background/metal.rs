//! The macOS Metal renderer for live backgrounds (plan 190 S2).
//!
//! One renderer per run, owned beside the primary leg's `MetalSceneCompositor`
//! (`compositor.rs` holds the slot and hands it to that leg each tick). It is
//! created the first tick a live background shows and holds nothing (no
//! library, no pipeline, no texture) until then. Each tick it renders the
//! **live frame**, a BGRA8 texture at `sizes::internal_size`, in its own
//! command buffer on the leg's queue, committed just before the compose
//! command buffer. The compose draws that texture as the background through
//! the picture quad (full canvas, fit Fill, linear sampling), so the half-size
//! and soft-1080 internal sizes scale up smoothly. The poster is never
//! uploaded while the shader draws.
//!
//! The MSL below is a hand port of `glsl/*.frag` and `ghost_fibers.vert` (the
//! source of truth), checked against golden grids rendered from the GLSL in
//! WebGL2 (`tests/fixtures/live-background-golden.json`). Porting rules (plan
//! 190): GLSL's `gl_FragCoord` is bottom-left and Metal's position top-left,
//! so every pass flips y first (`gl_frag`); a scratch texture one pass wrote
//! is read by the next with `1 - v` (or `last.y - y` for a texel fetch);
//! `mod` is not `fmod`; no `pow` of a negative base. Plan 194 adds the
//! instanced pass kind (Ghost Fibers' dots and dust: a vertex function on
//! `instance_id` and `vertex_id`, additive blending, a cleared scene).
//!
//! The budget guard (`guard.rs`) is fed at the start of each tick with the
//! previous tick's live command buffer GPU time (`GPUEndTime - GPUStartTime`,
//! complete long before, since the compose on the same queue already waited)
//! and the tick's missed-deadline flag from the render loop (it takes no
//! reading while a takeover screen is up). Full → Half re-renders at half the
//! internal size; Still shows the poster with reason `gpu-budget`. The guard
//! climbs back one level after a quiet period; the next `render` then draws
//! again and `ensure_targets` re-creates what Still dropped.

#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::Arc;
use std::time::Instant;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_foundation::NSString;
use objc2_metal::{
    MTLBlendFactor, MTLBlendOperation, MTLBlitCommandEncoder, MTLClearColor, MTLCommandBuffer,
    MTLCommandBufferStatus, MTLCommandEncoder, MTLCommandQueue, MTLDevice, MTLLibrary,
    MTLLoadAction, MTLPixelFormat, MTLPrimitiveType, MTLRenderCommandEncoder,
    MTLRenderPassDescriptor, MTLRenderPipelineDescriptor, MTLRenderPipelineState, MTLResource,
    MTLSamplerAddressMode, MTLSamplerDescriptor, MTLSamplerMinMagFilter, MTLSamplerMipFilter,
    MTLSamplerState, MTLStorageMode, MTLStoreAction, MTLTexture, MTLTextureDescriptor,
    MTLTextureUsage,
};

use super::glsl::LivePass;
use super::{
    GuardLevel, LiveBackgroundBoard, LiveBackgroundFrameInput, LiveBackgroundGuard, LiveLook,
    PassBlend, PassKind, Uniforms, beams_field_size, dither_field_size, ferrofluid_grid,
    ferrofluid_look_camera, ghost_fibers_bloom_sizes, internal_size, plasma_sizes, silk_field_size,
    uniforms,
};
use crate::protocol::{
    LiveBackgroundId, LiveBackgroundRendering, LiveBackgroundStatus, LiveBackgroundStillReason,
};

pub type MetalDevice = ProtocolObject<dyn MTLDevice>;
pub type MetalQueue = ProtocolObject<dyn MTLCommandQueue>;
pub type MetalTexture = ProtocolObject<dyn MTLTexture>;
type MetalPipeline = ProtocolObject<dyn MTLRenderPipelineState>;
type MetalLibrary = ProtocolObject<dyn MTLLibrary>;
type MetalCommandBuffer = ProtocolObject<dyn MTLCommandBuffer>;

/// The live frame's format: what the compose samples as a picture.
pub const FRAME_FORMAT: MTLPixelFormat = MTLPixelFormat::BGRA8Unorm;
/// Silk's bloom field: one channel at a quarter size, with a full mip chain.
pub const SILK_FIELD_FORMAT: MTLPixelFormat = MTLPixelFormat::R8Unorm;
/// Plasma Wave's coarse trace keeps its alpha (the edge field the fine pass
/// tests), so it needs four channels.
pub const PLASMA_COARSE_FORMAT: MTLPixelFormat = MTLPixelFormat::RGBA16Float;
/// The HDR light scratch nothing reads the alpha of: Plasma Wave's fine trace
/// and bloom chain, Beams' glint field (mipmapped) and Ghost Fibers' bloom
/// chain. Three packed float channels (renderable, filterable and
/// mip-generatable on every macOS GPU) hold them in half the bytes of
/// `RGBA16Float`. The golden grids pass with it;
/// `light_formats_both_match_the_goldens` prints what `RGBA16Float` would
/// change (the WebGL reference renders in `RGBA16F`).
pub const LIGHT_FORMAT: MTLPixelFormat = MTLPixelFormat::RG11B10Float;
/// Dither's wave field: one byte texel per cell, as the reference's RGBA8.
pub const DITHER_WAVE_FORMAT: MTLPixelFormat = FRAME_FORMAT;
/// Ferrofluid's grid (the field and its bound): a few hundred texels whose
/// thresholds (`a < 0.002`) want the reference's half-float precision.
pub const FERROFLUID_GRID_FORMAT: MTLPixelFormat = MTLPixelFormat::RGBA16Float;
/// Ghost Fibers' scene: tens of thousands of dim quads add into it, which
/// the packed format's 5–6-bit mantissas would round away.
pub const GHOST_FIBERS_SCENE_FORMAT: MTLPixelFormat = MTLPixelFormat::RGBA16Float;

/// The MSL for every pass of the ten backgrounds, compiled at runtime the
/// first time a leg needs a live background (this Mac has no offline Metal
/// toolchain; `metal_compositor.rs` does the same for the scene shader). It
/// is a file of its own because the GPUI app compiles it too: first-run
/// setup's backdrop draws the Liquid Chrome pass from this very text
/// (`apps/videorc/src/screens/first_run/backdrop.rs`).
pub const LIVE_BACKGROUND_MSL: &str = include_str!("live_background.metal");

/// The MSL vertex function of a pass: the full-screen triangle, or an
/// instanced pass's own.
fn pass_vertex_function(pass: LivePass) -> &'static str {
    match pass {
        LivePass::GhostFibersDots => "ghost_fibers_dots_vertex",
        LivePass::GhostFibersDust => "ghost_fibers_dust_vertex",
        _ => "live_vertex",
    }
}

/// The MSL fragment function of a pass.
fn pass_function(pass: LivePass) -> &'static str {
    match pass {
        LivePass::SilkField => "silk_field",
        LivePass::SilkComposite => "silk_composite",
        LivePass::SideRays => "side_rays_main",
        LivePass::PlasmaCoarse => "plasma_coarse",
        LivePass::PlasmaFine => "plasma_fine",
        LivePass::PlasmaDown => "plasma_down",
        LivePass::PlasmaUp => "plasma_up",
        LivePass::PlasmaComposite => "plasma_composite",
        LivePass::LiquidChrome => "liquid_chrome_main",
        LivePass::LineWaves => "line_waves_main",
        LivePass::BeamsField => "beams_field",
        LivePass::BeamsComposite => "beams_composite",
        LivePass::ColorBends => "color_bends_main",
        LivePass::DitherWave => "dither_wave",
        LivePass::DitherComposite => "dither_composite",
        LivePass::FerrofluidField => "ferrofluid_field",
        LivePass::FerrofluidBound => "ferrofluid_bound",
        LivePass::FerrofluidRender => "ferrofluid_render",
        LivePass::GhostFibersDots | LivePass::GhostFibersDust => "ghost_fibers_dot",
        LivePass::GhostFibersBright => "ghost_fibers_bright",
        LivePass::GhostFibersDown => "ghost_fibers_down",
        LivePass::GhostFibersUp => "ghost_fibers_up",
        LivePass::GhostFibersComposite => "ghost_fibers_composite",
    }
}

/// The format of a pass's render target; the HDR light passes follow the
/// renderer's (test-selectable) light format.
fn pass_format(pass: LivePass, light: MTLPixelFormat) -> MTLPixelFormat {
    match pass {
        LivePass::SilkField => SILK_FIELD_FORMAT,
        LivePass::PlasmaCoarse => PLASMA_COARSE_FORMAT,
        LivePass::PlasmaFine
        | LivePass::PlasmaDown
        | LivePass::PlasmaUp
        | LivePass::BeamsField
        | LivePass::GhostFibersBright
        | LivePass::GhostFibersDown
        | LivePass::GhostFibersUp => light,
        LivePass::DitherWave => DITHER_WAVE_FORMAT,
        LivePass::FerrofluidField | LivePass::FerrofluidBound => FERROFLUID_GRID_FORMAT,
        LivePass::GhostFibersDots | LivePass::GhostFibersDust => GHOST_FIBERS_SCENE_FORMAT,
        LivePass::SilkComposite
        | LivePass::SideRays
        | LivePass::PlasmaComposite
        | LivePass::LiquidChrome
        | LivePass::LineWaves
        | LivePass::BeamsComposite
        | LivePass::ColorBends
        | LivePass::DitherComposite
        | LivePass::FerrofluidRender
        | LivePass::GhostFibersComposite => FRAME_FORMAT,
    }
}

/// Dither's pixel size in CSS pixels (`u[3].z`): its wave field has one texel
/// per cell.
fn dither_pixel_size(look: &LiveLook) -> f32 {
    look.statics[1][2]
}

/// This tick's live frame, ready for the compose to draw as the background.
/// A clone is one retain of the same texture (plan 193: the stream leg draws
/// the frame the recording leg rendered).
#[derive(Clone)]
pub struct LiveFrame {
    pub texture: Retained<MetalTexture>,
    pub width: u32,
    pub height: u32,
    pub rendering: LiveBackgroundRendering,
}

/// One draw: the catalogue entry, the clock, the style and the output.
#[derive(Clone, Copy)]
pub struct LiveDraw<'a> {
    pub id: LiveBackgroundId,
    pub look: &'a LiveLook,
    pub phase: f64,
    pub dim: f32,
    pub output: (u32, u32),
    pub level: GuardLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrawError {
    /// The library or a pipeline did not build: the poster, for good.
    ShaderCompileFailed,
    /// A texture or command buffer could not be made: the poster this tick.
    Resources,
}

/// A background's scratch textures. A clone is one retain per texture, so
/// `draw` can hold the set while it borrows the renderer mutably.
#[derive(Clone)]
enum Scratch {
    None,
    Silk {
        field: Retained<MetalTexture>,
    },
    Plasma {
        coarse: Retained<MetalTexture>,
        fine: Retained<MetalTexture>,
        down: Vec<Retained<MetalTexture>>,
        /// Levels 3, 2 and 1 of the up chain, in that order.
        up: Vec<Retained<MetalTexture>>,
    },
    Beams {
        /// The glint field, mipmapped.
        field: Retained<MetalTexture>,
    },
    Dither {
        /// One texel per cell.
        wave: Retained<MetalTexture>,
    },
    Ferrofluid {
        field: Retained<MetalTexture>,
        bound: Retained<MetalTexture>,
    },
    GhostFibers {
        scene: Retained<MetalTexture>,
        /// The bright level 0, then the down levels 1–4.
        chain: Vec<Retained<MetalTexture>>,
        /// Levels 3, 2, 1 and 0 of the up chain, in that order.
        up: Vec<Retained<MetalTexture>>,
    },
}

/// The textures a background holds at one internal size: its live frame and
/// its scratch. Rebuilt when the background, the look (Dither's cell and
/// Ferrofluid's grid follow it) or the size changes.
struct Targets {
    id: LiveBackgroundId,
    look: &'static str,
    view: (u32, u32),
    frame: Retained<MetalTexture>,
    scratch: Scratch,
    bytes: u64,
}

/// The previous tick's live command buffer, kept only to read its GPU time.
struct PendingCommandBuffer(Retained<MetalCommandBuffer>);

pub struct LiveBackgroundMetalRenderer {
    device: Retained<MetalDevice>,
    queue: Retained<MetalQueue>,
    board: Arc<LiveBackgroundBoard>,
    /// Linear, mip-linear, clamp to edge: what the WebGL reference samples
    /// its scratch with.
    sampler: Retained<ProtocolObject<dyn MTLSamplerState>>,
    library: Option<Retained<MetalLibrary>>,
    compile_failed: bool,
    pipelines: HashMap<LivePass, Retained<MetalPipeline>>,
    targets: Option<Targets>,
    /// Plan 193: the frame `render` drew this tick, stamped with the tick's
    /// instant, for a leg that draws it too (`frame_at`). Cleared at the top
    /// of every `render` and whenever the targets go, so a tick that drew
    /// nothing shares nothing.
    last_frame: Option<(Instant, LiveFrame)>,
    guard: LiveBackgroundGuard,
    pending: Option<PendingCommandBuffer>,
    reported_status: Option<LiveBackgroundStatus>,
    reported_resources: (u32, u64),
    resources_warned: bool,
    /// `LIGHT_FORMAT`, unless a test compares the alternative.
    light_format: MTLPixelFormat,
    #[cfg(test)]
    injected_gpu_ms: Option<f64>,
}

// SAFETY: like the compositor's cached textures, the renderer belongs to one
// compositor run, which the render loop task owns and uses from one thread at
// a time (never concurrently); the Metal objects it holds are only ever
// touched through it.
unsafe impl Send for LiveBackgroundMetalRenderer {}

impl LiveBackgroundMetalRenderer {
    /// A renderer for one leg, holding nothing yet. `None` only when the
    /// device can't build the sampler, which no Metal device refuses.
    pub fn new(
        device: Retained<MetalDevice>,
        queue: Retained<MetalQueue>,
        board: Arc<LiveBackgroundBoard>,
    ) -> Option<Self> {
        let descriptor = MTLSamplerDescriptor::new();
        descriptor.setMinFilter(MTLSamplerMinMagFilter::Linear);
        descriptor.setMagFilter(MTLSamplerMinMagFilter::Linear);
        descriptor.setMipFilter(MTLSamplerMipFilter::Linear);
        descriptor.setSAddressMode(MTLSamplerAddressMode::ClampToEdge);
        descriptor.setTAddressMode(MTLSamplerAddressMode::ClampToEdge);
        let sampler = device.newSamplerStateWithDescriptor(&descriptor)?;
        Some(Self {
            device,
            queue,
            board,
            sampler,
            library: None,
            compile_failed: false,
            pipelines: HashMap::new(),
            targets: None,
            last_frame: None,
            guard: LiveBackgroundGuard::new(),
            pending: None,
            reported_status: None,
            reported_resources: (0, 0),
            resources_warned: false,
            light_format: LIGHT_FORMAT,
            #[cfg(test)]
            injected_gpu_ms: None,
        })
    }

    /// A renderer on its own device and queue (tests, the posters example).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn standalone(board: Arc<LiveBackgroundBoard>) -> Option<Self> {
        let device = objc2_metal::MTLCreateSystemDefaultDevice()?;
        let queue = device.newCommandQueue()?;
        Self::new(device, queue, board)
    }

    /// Render this tick's live frame for `input` at the leg's `output` size,
    /// or `None` when the poster must draw instead (the status on the board
    /// says why: `preflight`, a shader that failed to compile, or the guard).
    pub fn render(
        &mut self,
        input: &LiveBackgroundFrameInput,
        output: (u32, u32),
        preflight: Option<LiveBackgroundStillReason>,
    ) -> Option<LiveFrame> {
        let tick = input.tick;
        // Plan 193: nothing to share until this tick's draw succeeds.
        self.last_frame = None;
        let gpu_ms = self.take_last_gpu_ms();
        self.guard.follow(input.spec.id);
        self.guard.observe(&tick, gpu_ms, output);
        let p95 = self.guard.last_p95_ms();
        if let Some(reason) = preflight {
            // Forced (or any other preflight) still: hold nothing at all.
            self.drop_resources();
            self.report_status(input.status(LiveBackgroundRendering::Still, Some(reason), p95));
            return None;
        }
        let level = self.guard.level();
        if level == GuardLevel::Still {
            self.drop_targets();
            self.report_status(input.status(
                LiveBackgroundRendering::Still,
                Some(LiveBackgroundStillReason::GpuBudget),
                p95,
            ));
            return None;
        }
        let draw = LiveDraw {
            id: input.spec.id,
            look: input.look,
            phase: input.phase_at(tick.at),
            dim: input.dim,
            output,
            level,
        };
        match self.draw(&draw) {
            Ok(frame) => {
                self.report_status(input.status(frame.rendering, None, p95));
                self.last_frame = Some((tick.at, frame.clone()));
                Some(frame)
            }
            Err(DrawError::ShaderCompileFailed) => {
                self.drop_targets();
                self.report_status(input.status(
                    LiveBackgroundRendering::Still,
                    Some(LiveBackgroundStillReason::ShaderCompileFailed),
                    p95,
                ));
                None
            }
            Err(DrawError::Resources) => {
                // A texture or command buffer the device would not give this
                // tick: the poster now, the shader again next tick.
                if !self.resources_warned {
                    self.resources_warned = true;
                    tracing::warn!(
                        "live background {:?}: Metal refused a texture or command buffer; showing the poster this tick",
                        input.spec.id
                    );
                }
                None
            }
        }
    }

    /// Render one frame at an exact phase and level (the renderer's core; the
    /// guard and status live in `render`). The returned texture is this
    /// renderer's live frame: the next `draw` overwrites it.
    pub fn draw(&mut self, draw: &LiveDraw<'_>) -> Result<LiveFrame, DrawError> {
        let look = draw.look;
        let view = internal_size(draw.id, draw.output, draw.level);
        // Pipelines first: a background whose shader won't build allocates
        // nothing.
        for pass in super::glsl::passes(draw.id) {
            self.pipeline(*pass, pass.kind(look))?;
        }
        self.ensure_targets(draw.id, look, view)?;
        let command_buffer = self.queue.commandBuffer().ok_or(DrawError::Resources)?;
        command_buffer.setLabel(Some(&NSString::from_str("videorc-live-background")));
        // Retained clones of the targets, so the passes below can borrow the
        // renderer mutably (a clone is one retain).
        let (frame, scratch) = {
            let targets = self.targets.as_ref().ok_or(DrawError::Resources)?;
            (targets.frame.clone(), targets.scratch.clone())
        };
        let (phase, dim) = (draw.phase, draw.dim);
        match scratch {
            Scratch::None => {
                let pass = match draw.id {
                    LiveBackgroundId::SideRays => LivePass::SideRays,
                    LiveBackgroundId::LiquidChrome => LivePass::LiquidChrome,
                    LiveBackgroundId::ColorBends => LivePass::ColorBends,
                    _ => LivePass::LineWaves,
                };
                self.encode(
                    &command_buffer,
                    pass,
                    &frame,
                    &uniforms(look, view, view, phase, dim),
                    &[],
                )?;
            }
            Scratch::Silk { field } => {
                let field_size = silk_field_size(view);
                self.encode(
                    &command_buffer,
                    LivePass::SilkField,
                    &field,
                    &uniforms(look, field_size, view, phase, dim),
                    &[],
                )?;
                let blit = command_buffer
                    .blitCommandEncoder()
                    .ok_or(DrawError::Resources)?;
                blit.generateMipmapsForTexture(&field);
                blit.endEncoding();
                self.encode(
                    &command_buffer,
                    LivePass::SilkComposite,
                    &frame,
                    &uniforms(look, view, view, phase, dim),
                    &[&field],
                )?;
            }
            Scratch::Plasma {
                coarse,
                fine,
                down,
                up,
            } => {
                let sizes = plasma_sizes(view);
                self.encode(
                    &command_buffer,
                    LivePass::PlasmaCoarse,
                    &coarse,
                    &uniforms(look, sizes.coarse, view, phase, dim),
                    &[],
                )?;
                self.encode(
                    &command_buffer,
                    LivePass::PlasmaFine,
                    &fine,
                    &uniforms(look, sizes.fine, view, phase, dim),
                    &[&coarse],
                )?;
                let mut source = &fine;
                for (level, target) in down.iter().enumerate() {
                    self.encode(
                        &command_buffer,
                        LivePass::PlasmaDown,
                        target,
                        &uniforms(look, sizes.down[level], view, phase, dim),
                        &[source],
                    )?;
                    source = target;
                }
                // up[0] is level 3 (from down[4]), up[1] level 2, up[2] level 1.
                for (index, target) in up.iter().enumerate() {
                    let level = 3 - index;
                    let from = if index == 0 { &down[4] } else { &up[index - 1] };
                    self.encode(
                        &command_buffer,
                        LivePass::PlasmaUp,
                        target,
                        &uniforms(look, sizes.down[level], view, phase, dim),
                        &[from, &down[level]],
                    )?;
                }
                self.encode(
                    &command_buffer,
                    LivePass::PlasmaComposite,
                    &frame,
                    &uniforms(look, view, view, phase, dim),
                    &[&fine, &up[2]],
                )?;
            }
            Scratch::Beams { field } => {
                let field_size = beams_field_size(view);
                self.encode(
                    &command_buffer,
                    LivePass::BeamsField,
                    &field,
                    &uniforms(look, field_size, view, phase, dim),
                    &[],
                )?;
                let blit = command_buffer
                    .blitCommandEncoder()
                    .ok_or(DrawError::Resources)?;
                blit.generateMipmapsForTexture(&field);
                blit.endEncoding();
                self.encode(
                    &command_buffer,
                    LivePass::BeamsComposite,
                    &frame,
                    &uniforms(look, view, view, phase, dim),
                    &[&field],
                )?;
            }
            Scratch::Dither { wave } => {
                let cells = dither_field_size(view, dither_pixel_size(look));
                self.encode(
                    &command_buffer,
                    LivePass::DitherWave,
                    &wave,
                    &uniforms(look, cells, view, phase, dim),
                    &[],
                )?;
                self.encode(
                    &command_buffer,
                    LivePass::DitherComposite,
                    &frame,
                    &uniforms(look, view, view, phase, dim),
                    &[&wave],
                )?;
            }
            Scratch::Ferrofluid { field, bound } => {
                let grid = ferrofluid_grid(&ferrofluid_look_camera(look), view);
                self.encode(
                    &command_buffer,
                    LivePass::FerrofluidField,
                    &field,
                    &uniforms(look, grid.size, view, phase, dim),
                    &[],
                )?;
                self.encode(
                    &command_buffer,
                    LivePass::FerrofluidBound,
                    &bound,
                    &uniforms(look, grid.bound, view, phase, dim),
                    &[&field],
                )?;
                self.encode(
                    &command_buffer,
                    LivePass::FerrofluidRender,
                    &frame,
                    &uniforms(look, view, view, phase, dim),
                    &[&field, &bound],
                )?;
            }
            Scratch::GhostFibers { scene, chain, up } => {
                let sizes = ghost_fibers_bloom_sizes(view);
                let full = uniforms(look, view, view, phase, dim);
                // The dots clear the scene and the dust adds to it: the
                // instance counts are the look's.
                for pass in [LivePass::GhostFibersDots, LivePass::GhostFibersDust] {
                    self.encode_instanced(&command_buffer, pass, pass.kind(look), &scene, &full)?;
                }
                self.encode(
                    &command_buffer,
                    LivePass::GhostFibersBright,
                    &chain[0],
                    &uniforms(look, sizes[0], view, phase, dim),
                    &[&scene],
                )?;
                for level in 1..chain.len() {
                    self.encode(
                        &command_buffer,
                        LivePass::GhostFibersDown,
                        &chain[level],
                        &uniforms(look, sizes[level], view, phase, dim),
                        &[&chain[level - 1]],
                    )?;
                }
                // up[0] is level 3 (from chain[4]), up[1] level 2, up[2]
                // level 1, up[3] level 0; each adds the matching chain level.
                for (index, target) in up.iter().enumerate() {
                    let level = 3 - index;
                    let from = if index == 0 {
                        &chain[4]
                    } else {
                        &up[index - 1]
                    };
                    self.encode(
                        &command_buffer,
                        LivePass::GhostFibersUp,
                        target,
                        &uniforms(look, sizes[level], view, phase, dim),
                        &[from, &chain[level]],
                    )?;
                }
                self.encode(
                    &command_buffer,
                    LivePass::GhostFibersComposite,
                    &frame,
                    &full,
                    &[&scene, &up[3]],
                )?;
            }
        }
        command_buffer.commit();
        self.pending = Some(PendingCommandBuffer(command_buffer));
        Ok(LiveFrame {
            texture: frame,
            width: view.0,
            height: view.1,
            rendering: if draw.level == GuardLevel::Half {
                LiveBackgroundRendering::Half
            } else {
                LiveBackgroundRendering::Shader
            },
        })
    }

    /// Plan 193: the frame `render` drew at `at`, for a leg that draws it too
    /// (the stream leg of a record-and-stream session draws the recording
    /// leg's). `None` at any other instant, and after a tick that drew
    /// nothing: a shared frame is never a stale one.
    pub fn frame_at(&self, at: Instant) -> Option<LiveFrame> {
        self.last_frame
            .as_ref()
            .filter(|(drawn_at, _)| *drawn_at == at)
            .map(|(_, frame)| frame.clone())
    }

    /// The live background went away: free every texture and pipeline and
    /// report 0/0. The guard keeps its level and its wait for that
    /// background.
    pub fn release(&mut self) {
        if self.holds_resources() {
            self.drop_resources();
        }
        self.last_frame = None;
        self.pending = None;
        self.reported_status = None;
    }

    /// Programs built and scratch bytes held right now.
    pub fn resources(&self) -> (u32, u64) {
        (
            self.pipelines.len() as u32,
            self.targets.as_ref().map_or(0, |targets| targets.bytes),
        )
    }

    /// Forget the last status so the next frame reports again (the CPU
    /// fallback overwrote the board for a tick).
    pub fn forget_reported_status(&mut self) {
        self.reported_status = None;
    }

    pub fn holds_resources(&self) -> bool {
        self.library.is_some() || !self.pipelines.is_empty() || self.targets.is_some()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn guard_level(&self) -> GuardLevel {
        self.guard.level()
    }

    fn drop_resources(&mut self) {
        self.pipelines.clear();
        self.library = None;
        self.drop_targets();
    }

    fn drop_targets(&mut self) {
        self.targets = None;
        self.last_frame = None;
        self.report_resources();
    }

    fn report_resources(&mut self) {
        let resources = self.resources();
        if resources != self.reported_resources {
            self.board.set_resources(resources.0, resources.1);
            self.reported_resources = resources;
        }
    }

    fn report_status(&mut self, status: LiveBackgroundStatus) {
        if self.reported_status.as_ref() != Some(&status) {
            self.board.report(status.clone());
            self.reported_status = Some(status);
        }
    }

    /// The previous tick's live command buffer GPU time in ms, when it has
    /// completed (it always has: the compose on the same queue waited).
    fn take_last_gpu_ms(&mut self) -> Option<f64> {
        let injected: Option<f64> = {
            #[cfg(test)]
            {
                self.injected_gpu_ms
            }
            #[cfg(not(test))]
            {
                None
            }
        };
        if injected.is_some() {
            self.pending = None;
            return injected;
        }
        let pending = self.pending.take()?;
        if pending.0.status() != MTLCommandBufferStatus::Completed {
            return None;
        }
        let seconds = pending.0.GPUEndTime() - pending.0.GPUStartTime();
        (seconds > 0.0).then_some(seconds * 1000.0)
    }

    /// The pass's pipeline, built on first use: its vertex and fragment
    /// functions, its target format and, for an additive instanced pass,
    /// `ONE, ONE` blending on both colour and alpha (WebGL's `blendFunc`).
    fn pipeline(
        &mut self,
        pass: LivePass,
        kind: PassKind,
    ) -> Result<Retained<MetalPipeline>, DrawError> {
        if let Some(pipeline) = self.pipelines.get(&pass) {
            return Ok(pipeline.clone());
        }
        if self.compile_failed {
            return Err(DrawError::ShaderCompileFailed);
        }
        let library = match self.library.clone() {
            Some(library) => library,
            None => {
                let source = NSString::from_str(LIVE_BACKGROUND_MSL);
                match self
                    .device
                    .newLibraryWithSource_options_error(&source, None)
                {
                    Ok(library) => {
                        self.library = Some(library.clone());
                        library
                    }
                    Err(error) => {
                        self.compile_failed = true;
                        tracing::error!(
                            "live background MSL failed to compile; every live background shows its poster: {}",
                            error.localizedDescription()
                        );
                        return Err(DrawError::ShaderCompileFailed);
                    }
                }
            }
        };
        let function = pass_function(pass);
        let format = pass_format(pass, self.light_format);
        let Some(vertex) =
            library.newFunctionWithName(&NSString::from_str(pass_vertex_function(pass)))
        else {
            return self.fail_compile(pass, "the vertex function is missing");
        };
        let Some(fragment) = library.newFunctionWithName(&NSString::from_str(function)) else {
            return self.fail_compile(pass, "the fragment function is missing");
        };
        let descriptor = MTLRenderPipelineDescriptor::new();
        descriptor.setVertexFunction(Some(&vertex));
        descriptor.setFragmentFunction(Some(&fragment));
        let attachment = unsafe { descriptor.colorAttachments().objectAtIndexedSubscript(0) };
        attachment.setPixelFormat(format);
        if let PassKind::Instanced {
            blend: PassBlend::Additive,
            ..
        } = kind
        {
            attachment.setBlendingEnabled(true);
            attachment.setRgbBlendOperation(MTLBlendOperation::Add);
            attachment.setAlphaBlendOperation(MTLBlendOperation::Add);
            attachment.setSourceRGBBlendFactor(MTLBlendFactor::One);
            attachment.setSourceAlphaBlendFactor(MTLBlendFactor::One);
            attachment.setDestinationRGBBlendFactor(MTLBlendFactor::One);
            attachment.setDestinationAlphaBlendFactor(MTLBlendFactor::One);
        }
        match self
            .device
            .newRenderPipelineStateWithDescriptor_error(&descriptor)
        {
            Ok(pipeline) => {
                self.pipelines.insert(pass, pipeline.clone());
                self.report_resources();
                Ok(pipeline)
            }
            Err(error) => {
                let description = error.localizedDescription().to_string();
                self.fail_compile(pass, &description)
            }
        }
    }

    fn fail_compile(
        &mut self,
        pass: LivePass,
        detail: &str,
    ) -> Result<Retained<MetalPipeline>, DrawError> {
        self.compile_failed = true;
        tracing::error!(
            "live background pipeline {pass:?} failed to build; its background shows its poster: {detail}"
        );
        Err(DrawError::ShaderCompileFailed)
    }

    fn ensure_targets(
        &mut self,
        id: LiveBackgroundId,
        look: &LiveLook,
        view: (u32, u32),
    ) -> Result<(), DrawError> {
        if self.targets.as_ref().is_some_and(|targets| {
            targets.id == id && targets.look == look.id && targets.view == view
        }) {
            return Ok(());
        }
        self.targets = None;
        let frame = self.texture(FRAME_FORMAT, view, false)?;
        let mut bytes = frame.allocatedSize() as u64;
        let light = self.light_format;
        let scratch = match id {
            LiveBackgroundId::Silk => {
                let field = self.texture(SILK_FIELD_FORMAT, silk_field_size(view), true)?;
                bytes += field.allocatedSize() as u64;
                Scratch::Silk { field }
            }
            LiveBackgroundId::PlasmaWave => {
                let sizes = plasma_sizes(view);
                let coarse = self.texture(PLASMA_COARSE_FORMAT, sizes.coarse, false)?;
                let fine = self.texture(light, sizes.fine, false)?;
                let mut down = Vec::with_capacity(5);
                for size in sizes.down {
                    down.push(self.texture(light, size, false)?);
                }
                let mut up = Vec::with_capacity(3);
                for level in [3, 2, 1] {
                    up.push(self.texture(light, sizes.down[level], false)?);
                }
                bytes += coarse.allocatedSize() as u64 + fine.allocatedSize() as u64;
                bytes += down
                    .iter()
                    .chain(up.iter())
                    .map(|texture| texture.allocatedSize() as u64)
                    .sum::<u64>();
                Scratch::Plasma {
                    coarse,
                    fine,
                    down,
                    up,
                }
            }
            LiveBackgroundId::Beams => {
                let field = self.texture(light, beams_field_size(view), true)?;
                bytes += field.allocatedSize() as u64;
                Scratch::Beams { field }
            }
            LiveBackgroundId::Dither => {
                let cells = dither_field_size(view, dither_pixel_size(look));
                let wave = self.texture(DITHER_WAVE_FORMAT, cells, false)?;
                bytes += wave.allocatedSize() as u64;
                Scratch::Dither { wave }
            }
            LiveBackgroundId::Ferrofluid => {
                let grid = ferrofluid_grid(&ferrofluid_look_camera(look), view);
                let field = self.texture(FERROFLUID_GRID_FORMAT, grid.size, false)?;
                let bound = self.texture(FERROFLUID_GRID_FORMAT, grid.bound, false)?;
                bytes += field.allocatedSize() as u64 + bound.allocatedSize() as u64;
                Scratch::Ferrofluid { field, bound }
            }
            LiveBackgroundId::GhostFibers => {
                let sizes = ghost_fibers_bloom_sizes(view);
                let scene = self.texture(GHOST_FIBERS_SCENE_FORMAT, view, false)?;
                let mut chain = Vec::with_capacity(sizes.len());
                for size in sizes {
                    chain.push(self.texture(light, size, false)?);
                }
                let mut up = Vec::with_capacity(sizes.len() - 1);
                for level in (0..sizes.len() - 1).rev() {
                    up.push(self.texture(light, sizes[level], false)?);
                }
                bytes += scene.allocatedSize() as u64;
                bytes += chain
                    .iter()
                    .chain(up.iter())
                    .map(|texture| texture.allocatedSize() as u64)
                    .sum::<u64>();
                Scratch::GhostFibers { scene, chain, up }
            }
            LiveBackgroundId::SideRays
            | LiveBackgroundId::LiquidChrome
            | LiveBackgroundId::LineWaves
            | LiveBackgroundId::ColorBends => Scratch::None,
        };
        self.targets = Some(Targets {
            id,
            look: look.id,
            view,
            frame,
            scratch,
            bytes,
        });
        self.report_resources();
        Ok(())
    }

    /// A private render target the passes also sample.
    fn texture(
        &self,
        format: MTLPixelFormat,
        size: (u32, u32),
        mipmapped: bool,
    ) -> Result<Retained<MetalTexture>, DrawError> {
        let descriptor = unsafe {
            MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                format,
                size.0.max(1) as usize,
                size.1.max(1) as usize,
                mipmapped,
            )
        };
        descriptor.setUsage(MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead);
        descriptor.setStorageMode(MTLStorageMode::Private);
        self.device
            .newTextureWithDescriptor(&descriptor)
            .ok_or(DrawError::Resources)
    }

    /// One full-screen pass into `target`, which it covers.
    fn encode(
        &mut self,
        command_buffer: &MetalCommandBuffer,
        pass: LivePass,
        target: &MetalTexture,
        uniforms: &Uniforms,
        textures: &[&MetalTexture],
    ) -> Result<(), DrawError> {
        let pipeline = self.pipeline(pass, PassKind::FullScreen)?;
        let encoder = self.encoder(command_buffer, target, MTLLoadAction::DontCare)?;
        encoder.setRenderPipelineState(&pipeline);
        let uniforms_ptr =
            NonNull::new(uniforms.as_ptr() as *mut c_void).ok_or(DrawError::Resources)?;
        unsafe {
            encoder.setFragmentBytes_length_atIndex(
                uniforms_ptr,
                std::mem::size_of::<Uniforms>(),
                0,
            );
            for (index, texture) in textures.iter().enumerate() {
                encoder.setFragmentTexture_atIndex(Some(*texture), index);
            }
            encoder.setFragmentSamplerState_atIndex(Some(&self.sampler), 0);
            encoder.drawPrimitives_vertexStart_vertexCount(MTLPrimitiveType::Triangle, 0, 3);
        }
        encoder.endEncoding();
        Ok(())
    }

    /// One instanced pass (plan 194 N2): `instances` strips of `vertices`
    /// into `target`, which the first pass of a scene clears to transparent
    /// black and the next ones add to. The vertex function derives every
    /// position from the ids and the same uniforms the fragments read.
    fn encode_instanced(
        &mut self,
        command_buffer: &MetalCommandBuffer,
        pass: LivePass,
        kind: PassKind,
        target: &MetalTexture,
        uniforms: &Uniforms,
    ) -> Result<(), DrawError> {
        let PassKind::Instanced {
            vertices,
            instances,
            ..
        } = kind
        else {
            return Err(DrawError::Resources);
        };
        let clears = pass.clears_target();
        if instances == 0 && !clears {
            // A look without dust draws nothing here; the scene stays.
            return Ok(());
        }
        let pipeline = self.pipeline(pass, kind)?;
        let load = if clears {
            MTLLoadAction::Clear
        } else {
            MTLLoadAction::Load
        };
        let encoder = self.encoder(command_buffer, target, load)?;
        if instances > 0 {
            encoder.setRenderPipelineState(&pipeline);
            let uniforms_ptr =
                NonNull::new(uniforms.as_ptr() as *mut c_void).ok_or(DrawError::Resources)?;
            unsafe {
                encoder.setVertexBytes_length_atIndex(
                    uniforms_ptr,
                    std::mem::size_of::<Uniforms>(),
                    0,
                );
                encoder.setFragmentBytes_length_atIndex(
                    uniforms_ptr,
                    std::mem::size_of::<Uniforms>(),
                    0,
                );
                encoder.drawPrimitives_vertexStart_vertexCount_instanceCount(
                    MTLPrimitiveType::TriangleStrip,
                    0,
                    vertices as usize,
                    instances as usize,
                );
            }
        }
        encoder.endEncoding();
        Ok(())
    }

    /// A render encoder on `target`: `Clear` to transparent black, `Load`
    /// what it holds, or `DontCare` for a pass that covers it.
    fn encoder(
        &self,
        command_buffer: &MetalCommandBuffer,
        target: &MetalTexture,
        load: MTLLoadAction,
    ) -> Result<Retained<ProtocolObject<dyn MTLRenderCommandEncoder>>, DrawError> {
        let descriptor = MTLRenderPassDescriptor::new();
        let attachment = unsafe { descriptor.colorAttachments().objectAtIndexedSubscript(0) };
        attachment.setTexture(Some(target));
        attachment.setLoadAction(load);
        if load == MTLLoadAction::Clear {
            attachment.setClearColor(MTLClearColor {
                red: 0.0,
                green: 0.0,
                blue: 0.0,
                alpha: 0.0,
            });
        }
        attachment.setStoreAction(MTLStoreAction::Store);
        command_buffer
            .renderCommandEncoderWithDescriptor(&descriptor)
            .ok_or(DrawError::Resources)
    }

    /// Wait for the last `draw` and return its GPU time in ms (tests and the
    /// posters example; the compositor never waits on the live buffer).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn wait_last_draw(&self) -> Option<f64> {
        let pending = self.pending.as_ref()?;
        pending.0.waitUntilCompleted();
        let seconds = pending.0.GPUEndTime() - pending.0.GPUStartTime();
        (seconds > 0.0).then_some(seconds * 1000.0)
    }

    /// Read the live frame back as BGRA rows (tests and the posters example):
    /// a blit into a shared buffer after the last draw completed.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn read_frame_bgra(&self, frame: &LiveFrame) -> Option<Vec<u8>> {
        use objc2_metal::{MTLBuffer, MTLOrigin, MTLResourceOptions, MTLSize};
        self.wait_last_draw();
        let (width, height) = (frame.width as usize, frame.height as usize);
        let bytes_per_row = width * 4;
        let length = bytes_per_row * height;
        let buffer = self
            .device
            .newBufferWithLength_options(length, MTLResourceOptions::StorageModeShared)?;
        let command_buffer = self.queue.commandBuffer()?;
        let blit = command_buffer.blitCommandEncoder()?;
        unsafe {
            blit.copyFromTexture_sourceSlice_sourceLevel_sourceOrigin_sourceSize_toBuffer_destinationOffset_destinationBytesPerRow_destinationBytesPerImage(
                &frame.texture,
                0,
                0,
                MTLOrigin { x: 0, y: 0, z: 0 },
                MTLSize {
                    width,
                    height,
                    depth: 1,
                },
                &buffer,
                0,
                bytes_per_row,
                length,
            );
        }
        blit.endEncoding();
        command_buffer.commit();
        command_buffer.waitUntilCompleted();
        let contents = buffer.contents();
        let slice = unsafe { std::slice::from_raw_parts(contents.as_ptr() as *const u8, length) };
        Some(slice.to_vec())
    }

    /// Tests feed the guard a fixed GPU time instead of the command buffer's.
    #[cfg(test)]
    pub(crate) fn inject_gpu_ms(&mut self, ms: Option<f64>) {
        self.injected_gpu_ms = ms;
    }

    /// Tests compare the HDR light format; a change rebuilds the pipelines
    /// and scratch.
    #[cfg(test)]
    pub(crate) fn set_light_format(&mut self, format: MTLPixelFormat) {
        if self.light_format != format {
            self.light_format = format;
            self.drop_resources();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use base64::Engine as _;

    use super::*;
    use crate::live_background::glsl::passes;
    use crate::live_background::runtime::{LiveBackgroundTick, sync};
    use crate::live_background::{ALL_LIVE_BACKGROUNDS, BASE_COLOR, css_id, look_or_first, looks};
    use crate::protocol::{EffectiveSceneBackground, LiveBackgroundMotion, LiveBackgroundSpec};

    const GOLDEN: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/live-background-golden.json"
    );

    fn renderer() -> Option<(LiveBackgroundMetalRenderer, Arc<LiveBackgroundBoard>)> {
        let board = Arc::new(LiveBackgroundBoard::default());
        let renderer = LiveBackgroundMetalRenderer::standalone(Arc::clone(&board));
        if renderer.is_none() {
            eprintln!("skipping: no Metal device available in this environment");
        }
        renderer.map(|renderer| (renderer, board))
    }

    fn id_from_css(css: &str) -> LiveBackgroundId {
        ALL_LIVE_BACKGROUNDS
            .into_iter()
            .find(|id| css_id(*id) == css)
            .unwrap_or_else(|| panic!("unknown live background {css}"))
    }

    /// Box-filter a BGRA frame to a `grid` of RGB cells, as the probe does.
    fn box_grid(bgra: &[u8], size: (usize, usize), grid: (usize, usize)) -> Vec<u8> {
        let (width, height) = size;
        let (grid_width, grid_height) = grid;
        let cell_width = width as f64 / grid_width as f64;
        let cell_height = height as f64 / grid_height as f64;
        let mut out = Vec::with_capacity(grid_width * grid_height * 3);
        for gy in 0..grid_height {
            for gx in 0..grid_width {
                let mut sum = [0u64; 3];
                let mut count = 0u64;
                let y0 = (gy as f64 * cell_height).floor() as usize;
                let y1 = ((gy + 1) as f64 * cell_height).floor() as usize;
                let x0 = (gx as f64 * cell_width).floor() as usize;
                let x1 = ((gx + 1) as f64 * cell_width).floor() as usize;
                for y in y0..y1 {
                    for x in x0..x1 {
                        let at = (y * width + x) * 4;
                        sum[0] += u64::from(bgra[at + 2]);
                        sum[1] += u64::from(bgra[at + 1]);
                        sum[2] += u64::from(bgra[at]);
                        count += 1;
                    }
                }
                for channel in sum {
                    out.push((channel as f64 / count as f64).round() as u8);
                }
            }
        }
        out
    }

    struct GoldenFrame {
        css: &'static str,
        id: LiveBackgroundId,
        look: &'static LiveLook,
        phase: f64,
        expected: Vec<u8>,
    }

    struct Golden {
        size: (usize, usize),
        grid: (usize, usize),
        frames: Vec<GoldenFrame>,
    }

    /// The fixture: the 60 grids rendered from the GLSL in WebGL2 (three
    /// looks at two phases for each of the ten backgrounds).
    fn load_golden() -> Golden {
        let fixture: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(GOLDEN).expect("golden fixture"))
                .expect("golden json");
        let size = (
            fixture["size"][0].as_u64().unwrap() as usize,
            fixture["size"][1].as_u64().unwrap() as usize,
        );
        let grid = (
            fixture["grid"][0].as_u64().unwrap() as usize,
            fixture["grid"][1].as_u64().unwrap() as usize,
        );
        let frames = fixture["frames"]
            .as_array()
            .expect("frames")
            .iter()
            .map(|frame| {
                let id = id_from_css(frame["id"].as_str().unwrap());
                let look_id = frame["look"].as_str().unwrap();
                let (look, known) = look_or_first(id, look_id);
                assert!(known, "{id:?}/{look_id}");
                let expected = base64::engine::general_purpose::STANDARD
                    .decode(frame["rgb"].as_str().unwrap())
                    .expect("rgb base64");
                assert_eq!(expected.len(), grid.0 * grid.1 * 3);
                GoldenFrame {
                    css: css_id(id),
                    id,
                    look,
                    phase: frame["phase"].as_f64().unwrap(),
                    expected,
                }
            })
            .collect::<Vec<_>>();
        assert_eq!(frames.len(), 60);
        Golden { size, grid, frames }
    }

    /// Render one golden frame and return (mean absolute error, max cell
    /// error) against the fixture, in 0–255 units.
    fn golden_error(
        renderer: &mut LiveBackgroundMetalRenderer,
        golden: &Golden,
        frame: &GoldenFrame,
    ) -> (f64, u8) {
        let live = renderer
            .draw(&LiveDraw {
                id: frame.id,
                look: frame.look,
                phase: frame.phase,
                dim: 0.0,
                output: (golden.size.0 as u32, golden.size.1 as u32),
                level: GuardLevel::Full,
            })
            .expect("the pass renders");
        assert_eq!((live.width as usize, live.height as usize), golden.size);
        let bgra = renderer.read_frame_bgra(&live).expect("readback");
        let actual = box_grid(&bgra, golden.size, golden.grid);
        let mut total = 0u64;
        let mut max = 0u8;
        for (a, e) in actual.iter().zip(frame.expected.iter()) {
            let diff = a.abs_diff(*e);
            total += u64::from(diff);
            max = max.max(diff);
        }
        (total as f64 / frame.expected.len() as f64, max)
    }

    /// Hosted macOS CI runners draw on "Apple Paravirtual device", not an
    /// Apple GPU; the log says which this run was.
    fn log_device(renderer: &LiveBackgroundMetalRenderer) {
        eprintln!("golden device: {}", renderer.device.name());
    }

    /// The (mean, max cell) bound every golden frame stays inside, in 0–255
    /// units: mean 2.0 and cell 10, on an Apple GPU and on hosted CI's
    /// paravirtual device alike.
    ///
    /// The paravirtual GPU once had wider bounds for Beams (24 / 240) and
    /// Ghost Fibers (2 / 96): both hashed with `sin` of large arguments
    /// (Ghost Fibers' reach about 1e7 rad), whose range reduction is not
    /// ANGLE's; CI on 2026-10-25 measured Beams at means 10.3–21.7 with a
    /// worst cell of 229 while an Apple GPU matched inside the strict bound.
    /// Both now hash in integers and Beams splits its Perlin gradient in
    /// whole numbers (#987, #1077), so every device draws the goldens' lanes
    /// and strands; a miss is a port bug.
    const GOLDEN_BOUND: (f64, u8) = (2.0, 10);

    /// Plan 190 S2: every golden grid (the GLSL in WebGL2, 640 × 360 box
    /// filtered to 64 × 36) matches the MSL within `GOLDEN_BOUND`.
    #[test]
    fn golden_grids_match_the_glsl_reference() {
        let Some((mut renderer, _board)) = renderer() else {
            return;
        };
        log_device(&renderer);
        let golden = load_golden();
        let mut worst: Vec<(&str, f64, u8)> = Vec::new();
        let mut failures = Vec::new();
        for frame in &golden.frames {
            let (mean, max) = golden_error(&mut renderer, &golden, frame);
            let name = format!("{}/{}@{}", frame.css, frame.look.id, frame.phase);
            eprintln!("golden {name}: mean {mean:.3}, max cell {max}");
            let (mean_limit, max_cell) = GOLDEN_BOUND;
            if mean > mean_limit || max > max_cell {
                failures.push(format!("{name}: mean {mean:.3}, max {max}"));
            }
            match worst.iter_mut().find(|(seen, _, _)| *seen == frame.css) {
                Some(entry) => {
                    entry.1 = entry.1.max(mean);
                    entry.2 = entry.2.max(max);
                }
                None => worst.push((frame.css, mean, max)),
            }
        }
        for (css, mean, max) in &worst {
            eprintln!("golden worst {css}: mean {mean:.3}, max cell {max}");
        }
        assert!(failures.is_empty(), "golden grids off: {failures:?}");
    }

    /// The choice of the HDR light format, measured per background that
    /// uses it (Plasma Wave's trace and chain, Beams' field, Ghost Fibers'
    /// bloom): the WebGL reference renders in `RGBA16F`; Videorc's
    /// `RG11B10Float` halves the bytes. Both must match the goldens; the
    /// numbers go in "As built".
    #[test]
    fn light_formats_both_match_the_goldens() {
        let Some((mut renderer, _board)) = renderer() else {
            return;
        };
        log_device(&renderer);
        let golden = load_golden();
        for id in [
            LiveBackgroundId::PlasmaWave,
            LiveBackgroundId::Beams,
            LiveBackgroundId::GhostFibers,
        ] {
            for (name, format) in [
                ("RG11B10Float", MTLPixelFormat::RG11B10Float),
                ("RGBA16Float", MTLPixelFormat::RGBA16Float),
            ] {
                renderer.set_light_format(format);
                let (mut worst_mean, mut worst_max) = (0.0_f64, 0_u8);
                for frame in golden.frames.iter().filter(|frame| frame.id == id) {
                    let (mean, max) = golden_error(&mut renderer, &golden, frame);
                    worst_mean = worst_mean.max(mean);
                    worst_max = worst_max.max(max);
                }
                let (_, bytes) = renderer.resources();
                eprintln!(
                    "{} light {name}: worst mean {worst_mean:.3}, worst max cell {worst_max}, {bytes} scratch bytes at 640x360",
                    css_id(id)
                );
                let (mean_limit, max_cell) = GOLDEN_BOUND;
                assert!(
                    worst_mean <= mean_limit && worst_max <= max_cell,
                    "{id:?} {name}"
                );
            }
        }
        renderer.set_light_format(LIGHT_FORMAT);
    }

    fn spec(id: LiveBackgroundId, look: &str) -> LiveBackgroundSpec {
        LiveBackgroundSpec {
            id,
            look: look.to_string(),
            motion: LiveBackgroundMotion::Calm,
        }
    }

    fn background(spec: &LiveBackgroundSpec) -> EffectiveSceneBackground {
        EffectiveSceneBackground {
            asset_id: format!("live-{}-{}", css_id(spec.id), spec.look),
            managed_asset_path: String::new(),
            fit: crate::protocol::BackgroundFit::Fill,
            scale: 100.0,
            offset_x: 0.0,
            offset_y: 0.0,
            blur_px: 0.0,
            dim_percent: 0.0,
            saturation_percent: 100.0,
            vignette_percent: 0.0,
            visibility_percent: 20.0,
            live: Some(spec.clone()),
        }
    }

    fn frame_input(
        spec: &LiveBackgroundSpec,
        board: &Arc<LiveBackgroundBoard>,
        tick: LiveBackgroundTick,
    ) -> LiveBackgroundFrameInput {
        let mut slot = None;
        sync(&mut slot, Some(spec), tick.at);
        slot.unwrap().frame_input(&background(spec), board, tick)
    }

    /// The guard steps Full → Half → Still on slow timings, the frame says
    /// Half in between, and Still shows the poster with `gpu-budget`. After
    /// a quiet minute the renderer draws again at Half.
    #[test]
    fn the_guard_steps_to_half_then_still_on_slow_timings() {
        let Some((mut renderer, board)) = renderer() else {
            return;
        };
        let spec = spec(LiveBackgroundId::Silk, "satin");
        let start = Instant::now();
        let interval = Duration::from_nanos(16_666_667);
        let mut input = frame_input(
            &spec,
            &board,
            LiveBackgroundTick::new(start, interval, false),
        );
        // 10 ms per frame is 60 % of a 60 fps frame: over the 20 % budget.
        // Two windows over steps to Half (4 s), two more to Still (8 s).
        renderer.inject_gpu_ms(Some(10.0));
        let mut renderings = Vec::new();
        for frame in 0..520_u32 {
            input.tick = LiveBackgroundTick::new(start + interval * frame, interval, false);
            let rendering = renderer
                .render(&input, (640, 360), None)
                .map(|frame| frame.rendering);
            renderings.push(rendering);
        }
        let first_half = renderings
            .iter()
            .position(|r| *r == Some(LiveBackgroundRendering::Half))
            .expect("steps to half");
        let first_still = renderings
            .iter()
            .position(|r| r.is_none())
            .expect("steps to still");
        assert!(
            renderings[..first_half]
                .iter()
                .all(|r| *r == Some(LiveBackgroundRendering::Shader))
        );
        assert!(first_half < first_still, "{first_half} {first_still}");
        assert!(renderings[first_still..].iter().all(Option::is_none));
        let (status, programs, scratch) = board.snapshot();
        let status = status.expect("status reported");
        assert_eq!(status.rendering, LiveBackgroundRendering::Still);
        assert_eq!(status.reason, Some(LiveBackgroundStillReason::GpuBudget));
        assert_eq!(status.p95_ms, Some(10.0));
        assert_eq!(scratch, 0, "a still holds no scratch");
        assert!(programs > 0, "the pipelines stay cached for the run");
        assert_eq!(renderer.guard_level(), GuardLevel::Still);
        // A quiet minute later (a tick a second, on time) the guard climbs
        // one level and the renderer draws again: the targets it dropped at
        // Still are back and status says Half, with no reason.
        renderer.inject_gpu_ms(Some(0.5));
        let quiet_from = start + Duration::from_secs(9);
        let mut resumed = None;
        for second in 0..70_u32 {
            input.tick = LiveBackgroundTick::new(
                quiet_from + Duration::from_secs(1) * second,
                interval,
                false,
            );
            resumed = renderer
                .render(&input, (640, 360), None)
                .map(|frame| frame.rendering);
        }
        assert_eq!(resumed, Some(LiveBackgroundRendering::Half));
        assert_eq!(renderer.guard_level(), GuardLevel::Half);
        let (status, _, scratch) = board.snapshot();
        let status = status.expect("status reported");
        assert_eq!(status.rendering, LiveBackgroundRendering::Half);
        assert_eq!(status.reason, None);
        assert!(scratch > 0, "the scratch released at Still is back");
        renderer.release();
        assert_eq!(renderer.resources(), (0, 0));
        assert_eq!(board.snapshot().1, 0);
    }

    /// A preflight still (forced) draws nothing and holds nothing.
    #[test]
    fn a_forced_still_builds_no_pipeline() {
        let Some((mut renderer, board)) = renderer() else {
            return;
        };
        let spec = spec(LiveBackgroundId::LineWaves, "gold");
        let now = Instant::now();
        let input = frame_input(&spec, &board, LiveBackgroundTick::unmeasured(now));
        assert!(
            renderer
                .render(&input, (640, 360), Some(LiveBackgroundStillReason::Forced))
                .is_none()
        );
        assert!(!renderer.holds_resources());
        let (status, programs, scratch) = board.snapshot();
        assert_eq!(
            status.map(|status| status.reason),
            Some(Some(LiveBackgroundStillReason::Forced))
        );
        assert_eq!((programs, scratch), (0, 0));
    }

    /// Switching backgrounds drops the old scratch; releasing drops all.
    #[test]
    fn scratch_follows_the_background_and_release_frees_everything() {
        let Some((mut renderer, board)) = renderer() else {
            return;
        };
        let now = Instant::now();
        let plasma = frame_input(
            &spec(LiveBackgroundId::PlasmaWave, "plasma"),
            &board,
            LiveBackgroundTick::unmeasured(now),
        );
        let frame = renderer
            .render(&plasma, (1920, 1080), None)
            .expect("plasma renders");
        assert_eq!((frame.width, frame.height), (1920, 1080));
        assert_eq!(frame.rendering, LiveBackgroundRendering::Shader);
        let (programs, plasma_bytes) = renderer.resources();
        assert_eq!(programs, 5);
        // The live frame (8 MB) plus the coarse, fine and bloom targets.
        assert!(plasma_bytes > 8 * 1024 * 1024, "{plasma_bytes}");
        assert!(plasma_bytes < 32 * 1024 * 1024, "{plasma_bytes}");
        eprintln!("plasma wave scratch at 1080p: {plasma_bytes} bytes");
        assert_eq!(board.snapshot().2, plasma_bytes);
        let rays = frame_input(
            &spec(LiveBackgroundId::SideRays, "sunbeam"),
            &board,
            LiveBackgroundTick::unmeasured(now),
        );
        renderer
            .render(&rays, (1920, 1080), None)
            .expect("rays render");
        let (programs, rays_bytes) = renderer.resources();
        assert_eq!(programs, 6, "the plasma pipelines stay cached");
        assert_eq!(rays_bytes, frame_bytes(&renderer), "only the live frame");
        // 4K: the soft background renders at 1080p internally.
        let frame = renderer.render(&rays, (3840, 2160), None).unwrap();
        assert_eq!((frame.width, frame.height), (1920, 1080));
        renderer.release();
        assert_eq!(renderer.resources(), (0, 0));
        assert!(!renderer.holds_resources());
        assert_eq!(board.snapshot().1, 0);
        assert_eq!(board.snapshot().2, 0);
    }

    fn frame_bytes(renderer: &LiveBackgroundMetalRenderer) -> u64 {
        renderer
            .targets
            .as_ref()
            .map_or(0, |targets| targets.frame.allocatedSize() as u64)
    }

    /// Two draws a second apart differ; two draws at the same phase do not.
    #[test]
    fn the_frame_moves_with_the_phase_and_is_deterministic() {
        let Some((mut renderer, board)) = renderer() else {
            return;
        };
        let spec = spec(LiveBackgroundId::LiquidChrome, "gold");
        let start = Instant::now();
        let input = frame_input(&spec, &board, LiveBackgroundTick::unmeasured(start));
        let read = |renderer: &mut LiveBackgroundMetalRenderer, at: Instant| {
            let mut input = input.clone();
            input.tick = LiveBackgroundTick::unmeasured(at);
            let frame = renderer.render(&input, (320, 180), None).unwrap();
            renderer.read_frame_bgra(&frame).unwrap()
        };
        let first = read(&mut renderer, start);
        let again = read(&mut renderer, start);
        let later = read(&mut renderer, start + Duration::from_secs(1));
        assert_eq!(first, again);
        let changed = first
            .iter()
            .zip(later.iter())
            .filter(|(a, b)| a.abs_diff(**b) > 2)
            .count();
        assert!(
            changed > first.len() / 20,
            "{changed} of {} bytes",
            first.len()
        );
    }

    /// The plan 194 five.
    const NEW_FIVE: [(LiveBackgroundId, &str); 5] = [
        (LiveBackgroundId::Beams, "studio"),
        (LiveBackgroundId::ColorBends, "default"),
        (LiveBackgroundId::Dither, "classic"),
        (LiveBackgroundId::Ferrofluid, "studio"),
        (LiveBackgroundId::GhostFibers, "violet"),
    ];

    /// Plan 194 S3, the plan 190 set for the five: two draws two seconds
    /// apart differ (Calm halves the rate), and two at the same phase are
    /// byte-identical, instanced dots included.
    #[test]
    fn the_new_five_move_with_the_phase_and_are_deterministic() {
        let Some((mut renderer, board)) = renderer() else {
            return;
        };
        for (id, look) in NEW_FIVE {
            let spec = spec(id, look);
            let start = Instant::now();
            let input = frame_input(&spec, &board, LiveBackgroundTick::unmeasured(start));
            let read = |renderer: &mut LiveBackgroundMetalRenderer, at: Instant| {
                let mut input = input.clone();
                input.tick = LiveBackgroundTick::unmeasured(at);
                let frame = renderer.render(&input, (320, 180), None).unwrap();
                assert_eq!(frame.rendering, LiveBackgroundRendering::Shader, "{id:?}");
                renderer.read_frame_bgra(&frame).unwrap()
            };
            let first = read(&mut renderer, start);
            let again = read(&mut renderer, start);
            let later = read(&mut renderer, start + Duration::from_secs(2));
            assert_eq!(first, again, "{id:?} is not deterministic");
            let changed = first
                .iter()
                .zip(later.iter())
                .filter(|(a, b)| a.abs_diff(**b) > 2)
                .count();
            eprintln!(
                "{}: {changed} of {} bytes moved in two seconds",
                css_id(id),
                first.len()
            );
            assert!(
                changed > first.len() / 20,
                "{id:?}: {changed} of {} bytes",
                first.len()
            );
        }
        renderer.release();
    }

    /// A forced still draws nothing and holds nothing for any of the five.
    #[test]
    fn a_forced_still_builds_no_pipeline_for_the_new_five() {
        let Some((mut renderer, board)) = renderer() else {
            return;
        };
        for (id, look) in NEW_FIVE {
            let now = Instant::now();
            let input = frame_input(&spec(id, look), &board, LiveBackgroundTick::unmeasured(now));
            assert!(
                renderer
                    .render(&input, (640, 360), Some(LiveBackgroundStillReason::Forced))
                    .is_none()
            );
            assert!(!renderer.holds_resources(), "{id:?}");
            let (status, programs, scratch) = board.snapshot();
            assert_eq!(
                status.map(|status| status.reason),
                Some(Some(LiveBackgroundStillReason::Forced))
            );
            assert_eq!((programs, scratch), (0, 0), "{id:?}");
        }
    }

    /// Each of the five builds exactly its passes' pipelines and holds its
    /// own scratch beside the live frame (Color Bends none); Dither renders
    /// 4K at full size, Ferrofluid at 1440 × 810 and the other soft three at
    /// 1080p; the guard's Half level
    /// halves the instanced one too; and a release frees everything.
    #[test]
    fn the_new_scratch_follows_the_background_and_release_frees_everything() {
        let Some((mut renderer, board)) = renderer() else {
            return;
        };
        let now = Instant::now();
        let mut programs_so_far = 0;
        for (id, look) in NEW_FIVE {
            let input = frame_input(&spec(id, look), &board, LiveBackgroundTick::unmeasured(now));
            let frame = renderer
                .render(&input, (1920, 1080), None)
                .expect("renders");
            // Ferrofluid renders at most 810 on its short side.
            let expected = internal_size(id, (1920, 1080), GuardLevel::Full);
            assert_eq!((frame.width, frame.height), expected, "{id:?}");
            assert_eq!(frame.rendering, LiveBackgroundRendering::Shader, "{id:?}");
            programs_so_far += passes(id).len() as u32;
            let (programs, bytes) = renderer.resources();
            assert_eq!(
                programs, programs_so_far,
                "{id:?}: the pipelines stay cached"
            );
            let frame_bytes = frame_bytes(&renderer);
            eprintln!("{} scratch at 1080p: {bytes} bytes", css_id(id));
            match id {
                LiveBackgroundId::ColorBends => {
                    assert_eq!(bytes, frame_bytes, "only the live frame")
                }
                // The scene (16 MB of RGBA16F) and its two bloom chains.
                LiveBackgroundId::GhostFibers => {
                    assert!(bytes > frame_bytes + 16 * 1024 * 1024, "{bytes}");
                    assert!(bytes < frame_bytes + 40 * 1024 * 1024, "{bytes}");
                }
                _ => assert!(bytes > frame_bytes, "{id:?}: {bytes}"),
            }
            assert_eq!(board.snapshot().2, bytes);
            let frame = renderer.render(&input, (3840, 2160), None).unwrap();
            let expected = match id {
                LiveBackgroundId::Dither => (3840, 2160),
                LiveBackgroundId::Ferrofluid => (1440, 810),
                _ => (1920, 1080),
            };
            assert_eq!((frame.width, frame.height), expected, "{id:?} at 4K");
        }
        let violet = &looks(LiveBackgroundId::GhostFibers)[0];
        let half = renderer
            .draw(&LiveDraw {
                id: LiveBackgroundId::GhostFibers,
                look: violet,
                phase: violet.poster_phase,
                dim: 0.0,
                output: (1920, 1080),
                level: GuardLevel::Half,
            })
            .expect("renders at half");
        assert_eq!((half.width, half.height), (960, 540));
        assert_eq!(half.rendering, LiveBackgroundRendering::Half);
        renderer.release();
        assert_eq!(renderer.resources(), (0, 0));
        assert!(!renderer.holds_resources());
        assert_eq!(board.snapshot().1, 0);
        assert_eq!(board.snapshot().2, 0);
    }

    /// Plan 193 with an instanced background: on a record-and-stream split
    /// the recording leg renders Ghost Fibers at its canvas and the stream
    /// leg draws that very texture at the same tick (`frame_at`), nothing at
    /// another instant, and the next tick's frame replaces it. The frame it
    /// shares has the dots in it, not a cleared scene.
    #[test]
    fn ghost_fibers_shares_its_frame_with_the_stream_leg_of_a_split() {
        let Some((mut renderer, board)) = renderer() else {
            return;
        };
        let spec = spec(LiveBackgroundId::GhostFibers, "violet");
        let start = Instant::now();
        let interval = Duration::from_nanos(16_666_667);
        let mut input = frame_input(
            &spec,
            &board,
            LiveBackgroundTick::new(start, interval, false),
        );
        let recording = renderer
            .render(&input, (1920, 1080), None)
            .expect("the recording leg renders");
        let shared = renderer.frame_at(start).expect("this tick's frame");
        assert!(std::ptr::eq(&*shared.texture, &*recording.texture));
        assert_eq!((shared.width, shared.height), (1920, 1080));
        assert_eq!(shared.rendering, LiveBackgroundRendering::Shader);
        assert!(renderer.frame_at(start + Duration::from_nanos(1)).is_none());
        assert!(renderer.frame_at(start - interval).is_none());
        let bgra = renderer.read_frame_bgra(&shared).expect("readback");
        let base = (BASE_COLOR[2] * 255.0).round() as u8;
        let lit = bgra
            .chunks_exact(4)
            .filter(|pixel| pixel[0] > base + 8 || pixel[1] > base + 8 || pixel[2] > base + 8)
            .count();
        eprintln!("ghost fibers: {lit} of {} pixels lit", bgra.len() / 4);
        assert!(lit > bgra.len() / 4 / 50, "the dots drew: {lit} lit pixels");
        let next = start + interval;
        input.tick = LiveBackgroundTick::new(next, interval, false);
        let later = renderer
            .render(&input, (1920, 1080), None)
            .expect("the next tick renders");
        assert!(renderer.frame_at(start).is_none(), "no stale frame");
        let shared = renderer.frame_at(next).expect("the next tick's frame");
        assert!(std::ptr::eq(&*shared.texture, &*later.texture));
        drop((recording, later, shared));
        renderer.release();
        assert!(renderer.frame_at(next).is_none());
    }

    /// The live frame's GPU time for every look of every background at
    /// 1080p, 1080 × 1920, 4K and the guard's Half level at 1080p (median
    /// and p95 of 60 frames from `GPUEndTime - GPUStartTime`), for the
    /// plan's "As built", with the host's load average before and after.
    /// Informational: this machine is shared, so the numbers are not
    /// asserted.
    #[test]
    fn live_frame_gpu_times() {
        let Some((mut renderer, _board)) = renderer() else {
            return;
        };
        let load = || {
            std::process::Command::new("uptime")
                .output()
                .ok()
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|line| line.trim().to_string())
                .unwrap_or_default()
        };
        eprintln!("host before: {}", load());
        for id in ALL_LIVE_BACKGROUNDS {
            for look in looks(id) {
                for (output, level) in [
                    ((1920_u32, 1080_u32), GuardLevel::Full),
                    ((1080, 1920), GuardLevel::Full),
                    ((3840, 2160), GuardLevel::Full),
                    ((1920, 1080), GuardLevel::Half),
                ] {
                    let mut times = Vec::new();
                    let mut rendered = (0, 0);
                    for frame in 0..70_u32 {
                        let phase = look.poster_phase + f64::from(frame) / 60.0 * look.rate;
                        let live = renderer
                            .draw(&LiveDraw {
                                id,
                                look,
                                phase,
                                dim: 0.0,
                                output,
                                level,
                            })
                            .expect("renders");
                        let ms = renderer.wait_last_draw().expect("timed");
                        if frame >= 10 {
                            times.push(ms);
                        }
                        rendered = (live.width, live.height);
                    }
                    times.sort_by(f64::total_cmp);
                    let median = times[times.len() / 2];
                    let p95 = times[(times.len() as f64 * 0.95) as usize - 1];
                    let (_, bytes) = renderer.resources();
                    eprintln!(
                        "live frame {}/{} at {}x{} {level:?} (renders {}x{}): median {median:.2} ms, p95 {p95:.2} ms, {bytes} scratch bytes",
                        css_id(id),
                        look.id,
                        output.0,
                        output.1,
                        rendered.0,
                        rendered.1
                    );
                }
            }
        }
        eprintln!("host after: {}", load());
    }
}
