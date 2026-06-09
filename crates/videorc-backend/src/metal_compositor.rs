//! Metal/GPU compositor core (plan Phase 3).
//!
//! The shipping compositor composes frames with a CPU YUV420P loop. OBS composes on the
//! GPU. This module is the GPU foundation: it creates a Metal device and composites
//! textured source quads into an offscreen render target on the GPU, proving the path
//! works on this hardware (Apple M4 / Metal 4) before it is wired into the live
//! preview/recording hot path (the remaining integration, which needs on-device visual
//! validation and a zero-copy IOSurface export to the encoder).
//!
//! macOS-only. Everything renders to an offscreen `MTLTexture`; when available that
//! target is IOSurface-backed so the encoder can adopt it later without an extra copy.
//! The current public compose API still reads pixels back, so it remains testable
//! headlessly (no window) wherever a Metal device is available.

#![cfg(target_os = "macos")]
#![allow(dead_code)]

use std::ffi::c_void;
use std::ptr::NonNull;
use std::time::Instant;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_core_foundation::{CFBoolean, CFDictionary, CFRetained, CFType, CGSize};
use objc2_core_video::{
    CVMetalTexture, CVMetalTextureCache, CVMetalTextureGetTexture, CVPixelBuffer,
    CVPixelBufferCreate, CVPixelBufferGetIOSurface, kCVPixelBufferIOSurfacePropertiesKey,
    kCVPixelFormatType_32BGRA,
};
use objc2_foundation::NSString;
use objc2_io_surface::IOSurfaceRef;
use objc2_metal::{
    MTLClearColor, MTLCommandBuffer, MTLCommandEncoder, MTLCommandQueue,
    MTLCreateSystemDefaultDevice, MTLDevice, MTLDrawable, MTLLibrary, MTLLoadAction, MTLOrigin,
    MTLPixelFormat, MTLPrimitiveType, MTLRegion, MTLRenderCommandEncoder, MTLRenderPassDescriptor,
    MTLRenderPipelineDescriptor, MTLRenderPipelineState, MTLResourceOptions, MTLSamplerDescriptor,
    MTLSamplerMinMagFilter, MTLSamplerState, MTLSize, MTLStoreAction, MTLTexture,
    MTLTextureDescriptor, MTLTextureUsage,
};
use objc2_quartz_core::{CAMetalDrawable, CAMetalLayer};

use crate::color::rgb_to_yuv_full_range_bt601 as rgb_to_yuv;

type MetalDevice = ProtocolObject<dyn MTLDevice>;
type MetalTexture = ProtocolObject<dyn MTLTexture>;

const SHADER_SOURCE: &str = r#"
#include <metal_stdlib>
using namespace metal;
struct VOut { float4 pos [[position]]; float2 uv; };
struct FragParams { float4 crop; float mirror; float circle; };
vertex VOut v_main(uint vid [[vertex_id]], const device float4* verts [[buffer(0)]]) {
    VOut out;
    float4 v = verts[vid];
    out.pos = float4(v.x, v.y, 0.0, 1.0);
    out.uv = float2(v.z, v.w);
    return out;
}
fragment float4 f_main(VOut in [[stage_in]],
                       texture2d<float> tex [[texture(0)]],
                       sampler samp [[sampler(0)]],
                       constant FragParams& params [[buffer(0)]]) {
    float2 uv = in.uv;
    // Hard-edge ellipse mask (matches the CPU compositor's inside_ellipse): drop fragments
    // outside the circle so whatever was drawn underneath (e.g. the screen) shows through.
    if (params.circle > 0.5) {
        float2 c = (uv - 0.5) * 2.0;
        if (dot(c, c) > 1.0) {
            discard_fragment();
        }
    }
    // Horizontal mirror.
    float u = (params.mirror > 0.5) ? (1.0 - uv.x) : uv.x;
    // Crop: sample only the visible region [cl, 1-cr] x [ct, 1-cb] of the source.
    float cl = params.crop.x, ct = params.crop.y, cr = params.crop.z, cb = params.crop.w;
    float2 src = float2(cl + u * (1.0 - cl - cr), ct + uv.y * (1.0 - ct - cb));
    return tex.sample(samp, src);
}
"#;

#[repr(C)]
#[derive(Clone, Copy)]
struct FragParams {
    crop: [f32; 4],
    mirror: f32,
    circle: f32,
}

/// One source layer to composite: BGRA8 pixels at `width`×`height`, drawn into the
/// destination rectangle `dest` = (x, y, w, h) in normalized [0,1] coordinates with the
/// origin at the top-left (the convention the scene model uses).
pub struct GpuSource<'a> {
    pub kind: GpuSourceKind,
    pub bgra: &'a [u8],
    /// Zero-copy capture-source surface. When present (and `VIDEORC_ZEROCOPY_SOURCES` is on) the
    /// compositor imports it as a Metal texture instead of uploading `bgra` via `replaceRegion`.
    /// The caller keeps the backing surface retained for the duration of the compose.
    pub iosurface: Option<&'a IOSurfaceRef>,
    /// Zero-copy capture-source pixel buffer. Camera frames prefer this path because
    /// AVFoundation owns the CoreVideo buffer even when no global IOSurface id is available.
    pub pixel_buffer: Option<&'a CVPixelBuffer>,
    pub width: usize,
    pub height: usize,
    /// Destination rect (x, y, w, h) in normalized [0,1] coords, top-left origin.
    pub dest: [f32; 4],
    /// Crop fractions trimmed off each edge of the source (left, top, right, bottom).
    pub crop: [f32; 4],
    /// Mirror the source horizontally (camera selfie view).
    pub mirror: bool,
    /// Hard-edge circular/elliptical mask over the destination rect.
    pub circle: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuSourceKind {
    Camera,
    Screen,
    Window,
    Image,
    TestPattern,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MetalSourceImportStats {
    pub iosurface_frames: u64,
    pub cvpixelbuffer_frames: u64,
    pub byte_upload_frames: u64,
    pub import_failures: u64,
    pub camera_iosurface_frames: u64,
    pub camera_cvpixelbuffer_frames: u64,
    pub camera_byte_upload_frames: u64,
    pub camera_import_failures: u64,
    pub screen_iosurface_frames: u64,
    pub screen_cvpixelbuffer_frames: u64,
    pub screen_byte_upload_frames: u64,
    pub screen_import_failures: u64,
    pub import_time_ms: f64,
}

impl MetalSourceImportStats {
    pub fn merge(&mut self, other: Self) {
        self.iosurface_frames = self.iosurface_frames.saturating_add(other.iosurface_frames);
        self.cvpixelbuffer_frames = self
            .cvpixelbuffer_frames
            .saturating_add(other.cvpixelbuffer_frames);
        self.byte_upload_frames = self
            .byte_upload_frames
            .saturating_add(other.byte_upload_frames);
        self.import_failures = self.import_failures.saturating_add(other.import_failures);
        self.camera_iosurface_frames = self
            .camera_iosurface_frames
            .saturating_add(other.camera_iosurface_frames);
        self.camera_cvpixelbuffer_frames = self
            .camera_cvpixelbuffer_frames
            .saturating_add(other.camera_cvpixelbuffer_frames);
        self.camera_byte_upload_frames = self
            .camera_byte_upload_frames
            .saturating_add(other.camera_byte_upload_frames);
        self.camera_import_failures = self
            .camera_import_failures
            .saturating_add(other.camera_import_failures);
        self.screen_iosurface_frames = self
            .screen_iosurface_frames
            .saturating_add(other.screen_iosurface_frames);
        self.screen_cvpixelbuffer_frames = self
            .screen_cvpixelbuffer_frames
            .saturating_add(other.screen_cvpixelbuffer_frames);
        self.screen_byte_upload_frames = self
            .screen_byte_upload_frames
            .saturating_add(other.screen_byte_upload_frames);
        self.screen_import_failures = self
            .screen_import_failures
            .saturating_add(other.screen_import_failures);
        self.import_time_ms += other.import_time_ms;
    }

    fn record(&mut self, kind: GpuSourceKind, outcome: SourceImportOutcome, elapsed_ms: f64) {
        self.import_time_ms += elapsed_ms;
        match outcome {
            SourceImportOutcome::IosurfaceImported => {
                self.iosurface_frames = self.iosurface_frames.saturating_add(1);
                match kind {
                    GpuSourceKind::Camera => {
                        self.camera_iosurface_frames =
                            self.camera_iosurface_frames.saturating_add(1);
                    }
                    GpuSourceKind::Screen | GpuSourceKind::Window => {
                        self.screen_iosurface_frames =
                            self.screen_iosurface_frames.saturating_add(1);
                    }
                    GpuSourceKind::Image | GpuSourceKind::TestPattern => {}
                }
            }
            SourceImportOutcome::CvpixelbufferImported => {
                self.cvpixelbuffer_frames = self.cvpixelbuffer_frames.saturating_add(1);
                match kind {
                    GpuSourceKind::Camera => {
                        self.camera_cvpixelbuffer_frames =
                            self.camera_cvpixelbuffer_frames.saturating_add(1);
                    }
                    GpuSourceKind::Screen | GpuSourceKind::Window => {
                        self.screen_cvpixelbuffer_frames =
                            self.screen_cvpixelbuffer_frames.saturating_add(1);
                    }
                    GpuSourceKind::Image | GpuSourceKind::TestPattern => {}
                }
            }
            SourceImportOutcome::ByteUploaded => {
                self.byte_upload_frames = self.byte_upload_frames.saturating_add(1);
                match kind {
                    GpuSourceKind::Camera => {
                        self.camera_byte_upload_frames =
                            self.camera_byte_upload_frames.saturating_add(1);
                    }
                    GpuSourceKind::Screen | GpuSourceKind::Window => {
                        self.screen_byte_upload_frames =
                            self.screen_byte_upload_frames.saturating_add(1);
                    }
                    GpuSourceKind::Image | GpuSourceKind::TestPattern => {}
                }
            }
            SourceImportOutcome::IosurfaceImportFailedToByteUpload => {
                self.import_failures = self.import_failures.saturating_add(1);
                self.byte_upload_frames = self.byte_upload_frames.saturating_add(1);
                match kind {
                    GpuSourceKind::Camera => {
                        self.camera_import_failures = self.camera_import_failures.saturating_add(1);
                        self.camera_byte_upload_frames =
                            self.camera_byte_upload_frames.saturating_add(1);
                    }
                    GpuSourceKind::Screen | GpuSourceKind::Window => {
                        self.screen_import_failures = self.screen_import_failures.saturating_add(1);
                        self.screen_byte_upload_frames =
                            self.screen_byte_upload_frames.saturating_add(1);
                    }
                    GpuSourceKind::Image | GpuSourceKind::TestPattern => {}
                }
            }
            SourceImportOutcome::CvpixelbufferImportFailedToByteUpload => {
                self.import_failures = self.import_failures.saturating_add(1);
                self.byte_upload_frames = self.byte_upload_frames.saturating_add(1);
                match kind {
                    GpuSourceKind::Camera => {
                        self.camera_import_failures = self.camera_import_failures.saturating_add(1);
                        self.camera_byte_upload_frames =
                            self.camera_byte_upload_frames.saturating_add(1);
                    }
                    GpuSourceKind::Screen | GpuSourceKind::Window => {
                        self.screen_import_failures = self.screen_import_failures.saturating_add(1);
                        self.screen_byte_upload_frames =
                            self.screen_byte_upload_frames.saturating_add(1);
                    }
                    GpuSourceKind::Image | GpuSourceKind::TestPattern => {}
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceImportOutcome {
    IosurfaceImported,
    CvpixelbufferImported,
    ByteUploaded,
    IosurfaceImportFailedToByteUpload,
    CvpixelbufferImportFailedToByteUpload,
}

/// True when a Metal device is available on this machine.
pub fn metal_available() -> bool {
    MTLCreateSystemDefaultDevice().is_some()
}

/// Render a solid clear colour into an offscreen BGRA8 texture and read the pixels back.
/// `rgba` components are 0.0..=1.0. Returns `None` when no Metal device is available.
pub fn metal_clear_probe(width: usize, height: usize, rgba: [f64; 4]) -> Option<Vec<u8>> {
    let device = MTLCreateSystemDefaultDevice()?;
    let queue = device.newCommandQueue()?;
    let texture = make_texture(
        &device,
        width,
        height,
        MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead,
    )?;

    let command_buffer = queue.commandBuffer()?;
    let encoder = {
        let pass = clear_pass(&texture, rgba);
        command_buffer.renderCommandEncoderWithDescriptor(&pass)?
    };
    encoder.endEncoding();
    command_buffer.commit();
    command_buffer.waitUntilCompleted();

    Some(read_texture_bgra(&texture, width, height))
}

/// Composite `sources` over a cleared `background` into a `out_width`×`out_height` BGRA8
/// render target on the GPU, and read the result back. Returns `None` when no Metal
/// device is available. This is the GPU analogue of the CPU compositor's per-source blit.
pub fn composite_sources(
    out_width: usize,
    out_height: usize,
    background: [f64; 4],
    sources: &[GpuSource<'_>],
) -> Option<Vec<u8>> {
    let mut compositor = MetalSceneCompositor::new()?;
    compositor.compose_bgra(out_width, out_height, background, sources)
}

/// A persisted GPU compositor: device, command queue, render pipeline, and sampler built
/// once and reused per frame (compiling shaders per frame would stutter). This is the
/// hot-path-ready form of `composite_sources`, used by the flag-gated Metal path in the
/// compositor loop.
pub struct MetalSceneCompositor {
    device: Retained<MetalDevice>,
    queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
    pipeline: Retained<ProtocolObject<dyn MTLRenderPipelineState>>,
    sampler: Retained<ProtocolObject<dyn MTLSamplerState>>,
    target: Option<CachedTargetTexture>,
    target_width: usize,
    target_height: usize,
    source_textures: Vec<Option<CachedSourceTexture>>,
    source_texture_cache: Option<MetalSourceTextureCache>,
}

struct CachedTargetTexture {
    texture: Retained<MetalTexture>,
    pixel_buffer: Option<CFRetained<CVPixelBuffer>>,
}

struct CachedSourceTexture {
    texture: Retained<MetalTexture>,
    width: usize,
    height: usize,
}

struct MetalSourceTextureCache(CFRetained<CVMetalTextureCache>);

impl MetalSourceTextureCache {
    fn new(cache: CFRetained<CVMetalTextureCache>) -> Self {
        Self(cache)
    }

    fn cache(&self) -> &CVMetalTextureCache {
        self.0.as_ref()
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct MetalComposeTimings {
    pub ensure_target_ms: f64,
    pub source_texture_ms: f64,
    pub source_import_stats: MetalSourceImportStats,
    pub command_encode_ms: f64,
    pub command_wait_ms: f64,
    pub total_ms: f64,
}

pub struct MetalBgraComposeOutput {
    pub bgra: Vec<u8>,
    pub timings: MetalComposeTimings,
}

pub struct MetalYuvComposeOutput {
    pub yuv: Vec<u8>,
    pub timings: MetalComposeTimings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetalPreviewPresentFailure {
    IosurfaceImportFailed,
    DrawableUnavailable,
    CommandBufferUnavailable,
    EncodeFailed,
}

impl MetalPreviewPresentFailure {
    pub fn reason(self) -> &'static str {
        match self {
            Self::IosurfaceImportFailed => "iosurface-import-failed",
            Self::DrawableUnavailable => "drawable-unavailable",
            Self::CommandBufferUnavailable => "command-buffer-unavailable",
            Self::EncodeFailed => "encode-failed",
        }
    }
}

#[derive(Debug)]
pub struct MetalImportedIosurfaceTexture {
    iosurface_id: u32,
    width: usize,
    height: usize,
    texture: Retained<MetalTexture>,
}

impl MetalImportedIosurfaceTexture {
    pub fn matches(&self, iosurface_id: u32, width: usize, height: usize) -> bool {
        self.iosurface_id == iosurface_id && self.width == width && self.height == height
    }

    pub fn iosurface_id(&self) -> u32 {
        self.iosurface_id
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    fn texture(&self) -> &MetalTexture {
        &self.texture
    }
}

/// Retained CoreVideo handle for the compositor's latest IOSurface-backed render target.
///
/// VideoToolbox can adopt this buffer in the encoder-export slice, avoiding the current
/// BGRA readback + CPU YUV420P conversion when the platform provides a shared target.
pub struct MetalCompositorTargetPixelBuffer {
    pixel_buffer: CFRetained<CVPixelBuffer>,
    width: usize,
    height: usize,
}

impl MetalCompositorTargetPixelBuffer {
    pub fn pixel_buffer(&self) -> &CVPixelBuffer {
        &self.pixel_buffer
    }

    pub fn into_pixel_buffer(self) -> CFRetained<CVPixelBuffer> {
        self.pixel_buffer
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn has_iosurface(&self) -> bool {
        CVPixelBufferGetIOSurface(Some(self.pixel_buffer.as_ref())).is_some()
    }

    pub fn iosurface_id(&self) -> Option<u32> {
        let iosurface = CVPixelBufferGetIOSurface(Some(self.pixel_buffer.as_ref()))?;
        Some(iosurface.id())
    }
}

// SAFETY: The wrapper owns a retained CoreVideo pixel buffer whose IOSurface-backed storage
// is designed to be passed between producer, preview, and encoder threads. Access remains
// immutable here; consumers that lock or encode the buffer are responsible for their own API
// synchronization.
unsafe impl Send for MetalCompositorTargetPixelBuffer {}

// SAFETY: Shared references expose only immutable metadata and the retained CVPixelBuffer
// handle. CoreVideo/IOSurface lifetime is retained independently of the compositor.
unsafe impl Sync for MetalCompositorTargetPixelBuffer {}

// SAFETY: The cached render target is owned by one compositor instance and is only used
// sequentially by the compositor loop. Metal resources are valid across threads; this
// wrapper only allows Tokio to move the owning task between worker threads.
unsafe impl Send for CachedTargetTexture {}

// SAFETY: Source textures follow the same ownership model as the target texture: each one
// is owned by a single compositor instance and refreshed sequentially in the render loop.
unsafe impl Send for CachedSourceTexture {}

// SAFETY: CVMetalTextureCache is retained by one compositor and only used from the render loop.
// The wrapper exposes immutable references for per-frame texture import.
unsafe impl Send for MetalSourceTextureCache {}
unsafe impl Sync for MetalSourceTextureCache {}

impl MetalSceneCompositor {
    /// Build the compositor, or `None` when no Metal device / shader compile is available.
    pub fn new() -> Option<Self> {
        let device = MTLCreateSystemDefaultDevice()?;
        let queue = device.newCommandQueue()?;
        let pipeline = build_pipeline(&device)?;
        let sampler = build_sampler(&device)?;
        let source_texture_cache = make_texture_cache(&device).map(MetalSourceTextureCache::new);
        Some(Self {
            device,
            queue,
            pipeline,
            sampler,
            target: None,
            target_width: 0,
            target_height: 0,
            source_textures: Vec::new(),
            source_texture_cache,
        })
    }

    /// Composite `sources` over `background` into an offscreen BGRA8 target and read back.
    pub fn compose_bgra(
        &mut self,
        out_width: usize,
        out_height: usize,
        background: [f64; 4],
        sources: &[GpuSource<'_>],
    ) -> Option<Vec<u8>> {
        self.compose_bgra_with_timings(out_width, out_height, background, sources)
            .map(|output| output.bgra)
    }

    pub fn compose_bgra_with_timings(
        &mut self,
        out_width: usize,
        out_height: usize,
        background: [f64; 4],
        sources: &[GpuSource<'_>],
    ) -> Option<MetalBgraComposeOutput> {
        let timings =
            self.compose_target_with_timings(out_width, out_height, background, sources)?;
        let target = self.target.as_ref()?;
        Some(MetalBgraComposeOutput {
            bgra: read_texture_bgra(&target.texture, out_width, out_height),
            timings,
        })
    }

    /// Composite `sources` into the retained offscreen BGRA8 target without reading it
    /// back to CPU memory. Callers can export the resulting IOSurface-backed target to
    /// VideoToolbox through `latest_target_pixel_buffer`.
    pub fn compose_target(
        &mut self,
        out_width: usize,
        out_height: usize,
        background: [f64; 4],
        sources: &[GpuSource<'_>],
    ) -> Option<()> {
        self.compose_target_with_timings(out_width, out_height, background, sources)?;
        Some(())
    }

    pub fn compose_target_with_timings(
        &mut self,
        out_width: usize,
        out_height: usize,
        background: [f64; 4],
        sources: &[GpuSource<'_>],
    ) -> Option<MetalComposeTimings> {
        let total_started_at = Instant::now();
        let ensure_started_at = Instant::now();
        self.ensure_target_texture(out_width, out_height)?;
        let ensure_target_ms = ensure_started_at.elapsed().as_secs_f64() * 1000.0;
        let command_buffer = self.queue.commandBuffer()?;
        let encoder = {
            let target = self.target.as_ref()?;
            let pass = clear_pass(&target.texture, background);
            command_buffer.renderCommandEncoderWithDescriptor(&pass)?
        };
        encoder.setRenderPipelineState(&self.pipeline);
        unsafe { encoder.setFragmentSamplerState_atIndex(Some(&self.sampler), 0) };
        self.source_textures.truncate(sources.len());
        let mut source_texture_ms = 0.0;
        let mut source_import_stats = MetalSourceImportStats::default();
        let mut command_encode_ms = 0.0;
        let mut encode_segment_started_at = Instant::now();
        for (source_index, source) in sources.iter().enumerate() {
            let vertices = quad_vertices(source.dest);
            let buffer = unsafe {
                self.device.newBufferWithBytes_length_options(
                    NonNull::new(vertices.as_ptr() as *mut c_void)?,
                    std::mem::size_of_val(&vertices),
                    MTLResourceOptions::StorageModeShared,
                )?
            };
            let params = FragParams {
                crop: source.crop,
                mirror: f32::from(u8::from(source.mirror)),
                circle: f32::from(u8::from(source.circle)),
            };
            command_encode_ms += encode_segment_started_at.elapsed().as_secs_f64() * 1000.0;
            let source_texture_started_at = Instant::now();
            let import_outcome = self.ensure_source_texture(source_index, source)?;
            let source_texture_elapsed_ms =
                source_texture_started_at.elapsed().as_secs_f64() * 1000.0;
            source_texture_ms += source_texture_elapsed_ms;
            source_import_stats.record(source.kind, import_outcome, source_texture_elapsed_ms);
            let texture = &self.source_textures[source_index].as_ref()?.texture;
            let draw_started_at = Instant::now();
            unsafe {
                encoder.setVertexBuffer_offset_atIndex(Some(&buffer), 0, 0);
                encoder.setFragmentTexture_atIndex(Some(texture), 0);
                encoder.setFragmentBytes_length_atIndex(
                    NonNull::new(std::ptr::addr_of!(params) as *mut c_void)?,
                    std::mem::size_of::<FragParams>(),
                    0,
                );
                encoder.drawPrimitives_vertexStart_vertexCount(MTLPrimitiveType::Triangle, 0, 6);
            }
            command_encode_ms += draw_started_at.elapsed().as_secs_f64() * 1000.0;
            encode_segment_started_at = Instant::now();
        }
        command_encode_ms += encode_segment_started_at.elapsed().as_secs_f64() * 1000.0;
        encoder.endEncoding();
        let command_wait_started_at = Instant::now();
        command_buffer.commit();
        command_buffer.waitUntilCompleted();
        let command_wait_ms = command_wait_started_at.elapsed().as_secs_f64() * 1000.0;
        Some(MetalComposeTimings {
            ensure_target_ms,
            source_texture_ms,
            source_import_stats,
            command_encode_ms,
            command_wait_ms,
            total_ms: total_started_at.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// Composite over a TV-black (Y=16) background and convert to planar YUV420P, matching
    /// the CPU compositor's output format/coefficients so the encoder pipeline is unchanged.
    pub fn compose_yuv420p(
        &mut self,
        out_width: usize,
        out_height: usize,
        sources: &[GpuSource<'_>],
    ) -> Option<Vec<u8>> {
        self.compose_yuv420p_with_timings(out_width, out_height, sources)
            .map(|output| output.yuv)
    }

    pub fn compose_yuv420p_with_timings(
        &mut self,
        out_width: usize,
        out_height: usize,
        sources: &[GpuSource<'_>],
    ) -> Option<MetalYuvComposeOutput> {
        let background = [16.0 / 255.0, 16.0 / 255.0, 16.0 / 255.0, 1.0];
        let output = self.compose_bgra_with_timings(out_width, out_height, background, sources)?;
        Some(MetalYuvComposeOutput {
            yuv: bgra_to_yuv420p(&output.bgra, out_width, out_height),
            timings: output.timings,
        })
    }

    /// Present the latest composited target texture to a preview layer without exposing
    /// the Metal texture type outside this module. Returns `false` when no frame has been
    /// composed yet or when the layer has no drawable.
    pub fn present_latest_to_layer(
        &self,
        presenter: &MetalPreviewPresenter,
        layer: &CAMetalLayer,
    ) -> bool {
        let Some(target) = self.target.as_ref() else {
            return false;
        };
        presenter.present_texture_to_layer(layer, &target.texture)
    }

    /// Build a presenter that shares this compositor's Metal device. The native preview
    /// host uses this to present the cached target texture without exposing raw Metal
    /// device types across module boundaries.
    pub fn make_preview_presenter(&self) -> Option<MetalPreviewPresenter> {
        MetalPreviewPresenter::new(self.device.clone())
    }

    /// Export the retained IOSurface-backed target from the latest composed frame.
    ///
    /// This returns `None` before the first compose call or on platforms where the
    /// compositor had to fall back to a plain `MTLTexture`. The existing readback path
    /// remains available in both cases.
    pub fn latest_target_pixel_buffer(&self) -> Option<MetalCompositorTargetPixelBuffer> {
        let target = self.target.as_ref()?;
        Some(MetalCompositorTargetPixelBuffer {
            pixel_buffer: target.pixel_buffer.as_ref()?.clone(),
            width: self.target_width,
            height: self.target_height,
        })
    }

    fn ensure_target_texture(&mut self, width: usize, height: usize) -> Option<()> {
        if self.target.is_some() && self.target_width == width && self.target_height == height {
            return Some(());
        }
        self.target = Some(make_target_texture(&self.device, width, height)?);
        self.target_width = width;
        self.target_height = height;
        Some(())
    }

    fn ensure_source_texture(
        &mut self,
        index: usize,
        source: &GpuSource<'_>,
    ) -> Option<SourceImportOutcome> {
        if self.source_textures.len() <= index {
            self.source_textures.resize_with(index + 1, || None);
        }
        // Zero-copy fast paths: import retained capture-source storage directly as a Metal
        // texture, skipping the per-frame BGRA upload. A fresh texture view is created each frame
        // because source storage changes; on any failure we fall through to the byte-upload path.
        let mut pixel_buffer_import_failed = false;
        if source_zerocopy_enabled()
            && let Some(pixel_buffer) = source.pixel_buffer
        {
            if let Some(cache) = self.source_texture_cache.as_ref()
                && let Some(texture) = import_pixel_buffer_texture(
                    cache.cache(),
                    pixel_buffer,
                    source.width,
                    source.height,
                )
            {
                self.source_textures[index] = Some(CachedSourceTexture {
                    texture,
                    width: source.width,
                    height: source.height,
                });
                return Some(SourceImportOutcome::CvpixelbufferImported);
            }
            pixel_buffer_import_failed = true;
        }

        let mut iosurface_import_failed = false;
        if source_zerocopy_enabled()
            && let Some(surface) = source.iosurface
        {
            if let Some(texture) =
                import_source_iosurface_texture(&self.device, surface, source.width, source.height)
            {
                self.source_textures[index] = Some(CachedSourceTexture {
                    texture,
                    width: source.width,
                    height: source.height,
                });
                return Some(SourceImportOutcome::IosurfaceImported);
            }
            iosurface_import_failed = true;
        }

        let needs_texture = match self.source_textures[index].as_ref() {
            Some(cached) => cached.width != source.width || cached.height != source.height,
            None => true,
        };
        if needs_texture {
            self.source_textures[index] = Some(CachedSourceTexture {
                texture: make_texture(
                    &self.device,
                    source.width,
                    source.height,
                    MTLTextureUsage::ShaderRead,
                )?,
                width: source.width,
                height: source.height,
            });
        }

        let cached = self.source_textures[index].as_ref()?;
        upload_bgra_to_texture(&cached.texture, source)?;
        Some(if iosurface_import_failed {
            SourceImportOutcome::IosurfaceImportFailedToByteUpload
        } else if pixel_buffer_import_failed {
            SourceImportOutcome::CvpixelbufferImportFailedToByteUpload
        } else {
            SourceImportOutcome::ByteUploaded
        })
    }

    #[cfg(test)]
    fn cached_target_size(&self) -> Option<(usize, usize)> {
        self.target
            .as_ref()
            .map(|_| (self.target_width, self.target_height))
    }

    #[cfg(test)]
    fn cached_target_is_iosurface_backed(&self) -> bool {
        self.target
            .as_ref()
            .and_then(|target| target.pixel_buffer.as_ref())
            .is_some()
    }

    #[cfg(test)]
    fn cached_source_texture_sizes(&self) -> Vec<Option<(usize, usize)>> {
        self.source_textures
            .iter()
            .map(|cached| {
                cached
                    .as_ref()
                    .map(|texture| (texture.width, texture.height))
            })
            .collect()
    }
}

/// Convert a BGRA8 buffer to planar YUV420P (Y plane, then U, then V), 2×2-averaged chroma.
pub fn bgra_to_yuv420p(bgra: &[u8], width: usize, height: usize) -> Vec<u8> {
    let y_size = width * height;
    let chroma_w = width / 2;
    let chroma_h = height / 2;
    let chroma_size = chroma_w * chroma_h;
    let mut out = vec![0u8; y_size + 2 * chroma_size];
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) * 4;
            let (yy, _, _) = rgb_to_yuv(bgra[i + 2], bgra[i + 1], bgra[i]);
            out[y * width + x] = yy;
        }
    }
    for cy in 0..chroma_h {
        for cx in 0..chroma_w {
            let (mut rs, mut gs, mut bs) = (0u32, 0u32, 0u32);
            for dy in 0..2 {
                for dx in 0..2 {
                    let px = (cx * 2 + dx).min(width - 1);
                    let py = (cy * 2 + dy).min(height - 1);
                    let i = (py * width + px) * 4;
                    bs += u32::from(bgra[i]);
                    gs += u32::from(bgra[i + 1]);
                    rs += u32::from(bgra[i + 2]);
                }
            }
            let (_, u, v) = rgb_to_yuv((rs / 4) as u8, (gs / 4) as u8, (bs / 4) as u8);
            out[y_size + cy * chroma_w + cx] = u;
            out[y_size + chroma_size + cy * chroma_w + cx] = v;
        }
    }
    out
}

/// Create a `CAMetalLayer` configured to present BGRA8 frames at `width`×`height` device
/// pixels (Phase 2 preview surface). To display, the Electron/native integration attaches
/// it to an on-screen `NSView` positioned over the React preview rect; this owns the
/// GPU-side configuration and present.
pub fn make_preview_layer(device: &MetalDevice, width: f64, height: f64) -> Retained<CAMetalLayer> {
    let layer = CAMetalLayer::new();
    layer.setDevice(Some(device));
    layer.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
    // Keep the layer opaque: the present pipeline does not guarantee alpha=1 in the
    // drawable, and a non-opaque layer with alpha-0 pixels composites as fully
    // invisible. The empty-black-box problem is solved by visibility gating instead
    // (the overlay window only appears after the first successful present).
    layer.setOpaque(true);
    // The drawable is a render target for the scaled preview present path.
    layer.setFramebufferOnly(false);
    layer.setMaximumDrawableCount(3);
    layer.setPresentsWithTransaction(false);
    layer.setAllowsNextDrawableTimeout(true);
    // Keep display sync ON: presents pace to the display refresh so motion stays smooth.
    // Disabling it (dd78b25) won latency metrics but caused visible preview judder.
    layer.setDisplaySyncEnabled(true);
    layer.setDrawableSize(CGSize { width, height });
    layer
}

/// Cached renderer for presenting the compositor target into a `CAMetalLayer`.
///
/// The recording compositor intentionally uses nearest sampling to preserve exact crop
/// edges. Preview presentation is a separate surface concern: it uses linear sampling so
/// the full-resolution compositor texture can be downsampled to the window's drawable
/// size without the hard pixel stair-steps of a blit copy.
#[derive(Debug)]
pub struct MetalPreviewPresenter {
    device: Retained<MetalDevice>,
    queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
    pipeline: Retained<ProtocolObject<dyn MTLRenderPipelineState>>,
    sampler: Retained<ProtocolObject<dyn MTLSamplerState>>,
}

impl MetalPreviewPresenter {
    pub fn new(device: Retained<MetalDevice>) -> Option<Self> {
        let queue = device.newCommandQueue()?;
        let pipeline = build_pipeline(&device)?;
        let sampler = build_preview_sampler(&device)?;
        Some(Self {
            device,
            queue,
            pipeline,
            sampler,
        })
    }

    pub fn new_default() -> Option<Self> {
        Self::new(MTLCreateSystemDefaultDevice()?)
    }

    pub fn device(&self) -> &MetalDevice {
        &self.device
    }

    /// Present a composited texture to the layer's next drawable via a scaled render pass.
    /// Returns `false` when no drawable is available (e.g. a headless test layer).
    pub fn present_texture_to_layer(&self, layer: &CAMetalLayer, texture: &MetalTexture) -> bool {
        self.try_present_texture_to_layer(layer, texture).is_ok()
    }

    pub fn try_present_texture_to_layer(
        &self,
        layer: &CAMetalLayer,
        texture: &MetalTexture,
    ) -> Result<(), MetalPreviewPresentFailure> {
        let Some(drawable) = layer.nextDrawable() else {
            return Err(MetalPreviewPresentFailure::DrawableUnavailable);
        };
        let drawable_texture = drawable.texture();
        let Some(command_buffer) = self.queue.commandBuffer() else {
            return Err(MetalPreviewPresentFailure::CommandBufferUnavailable);
        };
        if encode_texture_present(
            &self.device,
            &command_buffer,
            &self.pipeline,
            &self.sampler,
            texture,
            &drawable_texture,
            [0.0, 0.0, 0.0, 1.0],
        )
        .is_none()
        {
            return Err(MetalPreviewPresentFailure::EncodeFailed);
        }
        let mtl_drawable: &ProtocolObject<dyn MTLDrawable> = ProtocolObject::from_ref(&*drawable);
        command_buffer.presentDrawable(mtl_drawable);
        command_buffer.commit();
        Ok(())
    }

    /// Import an IOSurface-backed compositor target by id, then present it through the
    /// same render-scaled preview path as the in-process compositor target.
    pub fn present_iosurface_to_layer(
        &self,
        layer: &CAMetalLayer,
        iosurface_id: u32,
        width: usize,
        height: usize,
    ) -> bool {
        self.try_present_iosurface_to_layer(layer, iosurface_id, width, height)
            .is_ok()
    }

    pub fn try_present_iosurface_to_layer(
        &self,
        layer: &CAMetalLayer,
        iosurface_id: u32,
        width: usize,
        height: usize,
    ) -> Result<(), MetalPreviewPresentFailure> {
        let Some(imported) = self.import_iosurface_texture_handle(iosurface_id, width, height)
        else {
            return Err(MetalPreviewPresentFailure::IosurfaceImportFailed);
        };
        self.try_present_imported_iosurface_to_layer(layer, &imported)
    }

    pub fn import_iosurface_texture_handle(
        &self,
        iosurface_id: u32,
        width: usize,
        height: usize,
    ) -> Option<MetalImportedIosurfaceTexture> {
        let texture = import_iosurface_texture(&self.device, iosurface_id, width, height)?;
        Some(MetalImportedIosurfaceTexture {
            iosurface_id,
            width,
            height,
            texture,
        })
    }

    pub fn try_present_imported_iosurface_to_layer(
        &self,
        layer: &CAMetalLayer,
        imported: &MetalImportedIosurfaceTexture,
    ) -> Result<(), MetalPreviewPresentFailure> {
        self.try_present_texture_to_layer(layer, imported.texture())
    }

    #[cfg(test)]
    fn render_texture_to_texture(
        &self,
        source: &MetalTexture,
        target: &MetalTexture,
    ) -> Option<()> {
        let command_buffer = self.queue.commandBuffer()?;
        encode_texture_present(
            &self.device,
            &command_buffer,
            &self.pipeline,
            &self.sampler,
            source,
            target,
            [0.0, 0.0, 0.0, 1.0],
        )?;
        command_buffer.commit();
        command_buffer.waitUntilCompleted();
        Some(())
    }
}

/// Present a composited texture to the layer's next drawable. Returns
/// `false` when no drawable is available (e.g. the layer is not attached to a screen, as
/// in a headless test) so callers degrade gracefully; the on-screen result is validated
/// in a window. This is the GPU-side present that replaces the PNG image-poll path.
pub fn present_texture_to_layer(
    queue: &ProtocolObject<dyn MTLCommandQueue>,
    layer: &CAMetalLayer,
    texture: &MetalTexture,
) -> bool {
    let device = queue.device();
    let Some(pipeline) = build_pipeline(&device) else {
        return false;
    };
    let Some(sampler) = build_preview_sampler(&device) else {
        return false;
    };
    let Some(drawable) = layer.nextDrawable() else {
        return false;
    };
    let drawable_texture = drawable.texture();
    let Some(command_buffer) = queue.commandBuffer() else {
        return false;
    };
    if encode_texture_present(
        &device,
        &command_buffer,
        &pipeline,
        &sampler,
        texture,
        &drawable_texture,
        [0.0, 0.0, 0.0, 1.0],
    )
    .is_none()
    {
        return false;
    }
    let mtl_drawable: &ProtocolObject<dyn MTLDrawable> = ProtocolObject::from_ref(&*drawable);
    command_buffer.presentDrawable(mtl_drawable);
    command_buffer.commit();
    true
}

/// Build a `CVMetalTextureCache` for zero-copy import of capture `CVPixelBuffer`s.
pub fn make_texture_cache(device: &MetalDevice) -> Option<CFRetained<CVMetalTextureCache>> {
    let mut cache: *mut CVMetalTextureCache = std::ptr::null_mut();
    let ret =
        unsafe { CVMetalTextureCache::create(None, None, device, None, NonNull::new(&mut cache)?) };
    if ret != 0 {
        return None;
    }
    NonNull::new(cache).map(|ptr| unsafe { CFRetained::from_raw(ptr) })
}

/// Import an IOSurface-backed BGRA `CVPixelBuffer` as an `MTLTexture` with no CPU copy —
/// the zero-copy source path the live capture rewrite will use in place of copying camera/
/// screen frames into `Vec<u8>`. Returns `None` if the buffer is not Metal-compatible.
pub fn import_pixel_buffer_texture(
    cache: &CVMetalTextureCache,
    pixel_buffer: &CVPixelBuffer,
    width: usize,
    height: usize,
) -> Option<Retained<MetalTexture>> {
    let mut cv_texture: *mut CVMetalTexture = std::ptr::null_mut();
    let ret = unsafe {
        CVMetalTextureCache::create_texture_from_image(
            None,
            cache,
            pixel_buffer,
            None,
            MTLPixelFormat::BGRA8Unorm,
            width,
            height,
            0,
            NonNull::new(&mut cv_texture)?,
        )
    };
    if ret != 0 {
        return None;
    }
    let cv_texture = unsafe { CFRetained::from_raw(NonNull::new(cv_texture)?) };
    CVMetalTextureGetTexture(&cv_texture)
}

/// Import a compositor IOSurface handoff as a Metal texture on this process/device.
///
/// This is the native-preview bridge primitive for a helper process or Electron native
/// host: the backend can publish an IOSurface id with a compositor frame, and the host
/// can import that shared storage without a PNG/JPEG readback path.
/// Whether live capture sources should be imported zero-copy via their IOSurface.
/// Defaults on for OBS-parity capture; `VIDEORC_ZEROCOPY_SOURCES=0` keeps the byte-upload
/// escape hatch for diagnosis.
pub fn source_zerocopy_enabled() -> bool {
    use std::sync::OnceLock;
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        source_zerocopy_enabled_from_env(std::env::var("VIDEORC_ZEROCOPY_SOURCES").ok().as_deref())
    })
}

fn source_zerocopy_enabled_from_env(value: Option<&str>) -> bool {
    !matches!(
        value.map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "0" | "false" | "off" | "no")
    )
}

/// Import an already-retained capture-source IOSurface as a BGRA Metal texture with no CPU copy.
/// Same primitive as `import_iosurface_texture`, but takes the in-process surface reference
/// directly instead of a global IOSurface id lookup (capture surfaces are not global).
fn import_source_iosurface_texture(
    device: &MetalDevice,
    surface: &IOSurfaceRef,
    width: usize,
    height: usize,
) -> Option<Retained<MetalTexture>> {
    let descriptor = unsafe {
        MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
            MTLPixelFormat::BGRA8Unorm,
            width,
            height,
            false,
        )
    };
    descriptor.setUsage(MTLTextureUsage::ShaderRead);
    device.newTextureWithDescriptor_iosurface_plane(&descriptor, surface, 0)
}

pub fn import_iosurface_texture(
    device: &MetalDevice,
    iosurface_id: u32,
    width: usize,
    height: usize,
) -> Option<Retained<MetalTexture>> {
    let surface = IOSurfaceRef::lookup(iosurface_id)?;
    let descriptor = unsafe {
        MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
            MTLPixelFormat::BGRA8Unorm,
            width,
            height,
            false,
        )
    };
    descriptor.setUsage(MTLTextureUsage::ShaderRead);
    device.newTextureWithDescriptor_iosurface_plane(&descriptor, surface.as_ref(), 0)
}

// --- helpers ---

fn make_texture(
    device: &MetalDevice,
    width: usize,
    height: usize,
    usage: MTLTextureUsage,
) -> Option<Retained<MetalTexture>> {
    let descriptor = unsafe {
        MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
            MTLPixelFormat::BGRA8Unorm,
            width,
            height,
            false,
        )
    };
    descriptor.setUsage(usage);
    device.newTextureWithDescriptor(&descriptor)
}

fn make_target_texture(
    device: &MetalDevice,
    width: usize,
    height: usize,
) -> Option<CachedTargetTexture> {
    make_iosurface_target_texture(device, width, height).or_else(|| {
        make_texture(
            device,
            width,
            height,
            MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead,
        )
        .map(|texture| CachedTargetTexture {
            texture,
            pixel_buffer: None,
        })
    })
}

fn make_iosurface_target_texture(
    device: &MetalDevice,
    width: usize,
    height: usize,
) -> Option<CachedTargetTexture> {
    let pixel_buffer = make_iosurface_bgra_pixel_buffer(width, height)?;
    let surface = CVPixelBufferGetIOSurface(Some(pixel_buffer.as_ref()))?;
    let descriptor = unsafe {
        MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
            MTLPixelFormat::BGRA8Unorm,
            width,
            height,
            false,
        )
    };
    descriptor.setUsage(MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead);
    let texture =
        device.newTextureWithDescriptor_iosurface_plane(&descriptor, surface.as_ref(), 0)?;
    Some(CachedTargetTexture {
        texture,
        pixel_buffer: Some(pixel_buffer),
    })
}

fn make_iosurface_bgra_pixel_buffer(
    width: usize,
    height: usize,
) -> Option<CFRetained<CVPixelBuffer>> {
    #[allow(deprecated)]
    let iosurface_is_global_key = unsafe { objc2_io_surface::kIOSurfaceIsGlobal };
    // The helper-process preview host can only import by IOSurface id when the surface is
    // globally lookupable. A future Mach-port/native-addon handoff can remove this.
    let iosurface_properties = CFDictionary::<CFType, CFType>::from_slices(
        &[iosurface_is_global_key.as_ref()],
        &[CFBoolean::new(true).as_ref()],
    );
    let pixel_buffer_attributes = CFDictionary::<CFType, CFType>::from_slices(
        &[unsafe { kCVPixelBufferIOSurfacePropertiesKey }.as_ref()],
        &[iosurface_properties.as_ref()],
    );
    let mut pb: *mut CVPixelBuffer = std::ptr::null_mut();
    let ret = unsafe {
        CVPixelBufferCreate(
            None,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            Some(pixel_buffer_attributes.as_ref()),
            NonNull::new(&mut pb)?,
        )
    };
    if ret != 0 {
        return None;
    }
    NonNull::new(pb).map(|ptr| unsafe { CFRetained::from_raw(ptr) })
}

fn clear_pass(texture: &MetalTexture, rgba: [f64; 4]) -> Retained<MTLRenderPassDescriptor> {
    let pass = MTLRenderPassDescriptor::new();
    let attachment = unsafe { pass.colorAttachments().objectAtIndexedSubscript(0) };
    attachment.setTexture(Some(texture));
    attachment.setLoadAction(MTLLoadAction::Clear);
    attachment.setClearColor(MTLClearColor {
        red: rgba[0],
        green: rgba[1],
        blue: rgba[2],
        alpha: rgba[3],
    });
    attachment.setStoreAction(MTLStoreAction::Store);
    pass
}

fn build_pipeline(
    device: &MetalDevice,
) -> Option<Retained<ProtocolObject<dyn MTLRenderPipelineState>>> {
    let source = NSString::from_str(SHADER_SOURCE);
    let library = device
        .newLibraryWithSource_options_error(&source, None)
        .ok()?;
    let vertex = library.newFunctionWithName(&NSString::from_str("v_main"))?;
    let fragment = library.newFunctionWithName(&NSString::from_str("f_main"))?;

    let descriptor = MTLRenderPipelineDescriptor::new();
    descriptor.setVertexFunction(Some(&vertex));
    descriptor.setFragmentFunction(Some(&fragment));
    let attachment = unsafe { descriptor.colorAttachments().objectAtIndexedSubscript(0) };
    attachment.setPixelFormat(MTLPixelFormat::BGRA8Unorm);

    device
        .newRenderPipelineStateWithDescriptor_error(&descriptor)
        .ok()
}

fn build_sampler(device: &MetalDevice) -> Option<Retained<ProtocolObject<dyn MTLSamplerState>>> {
    let descriptor = MTLSamplerDescriptor::new();
    descriptor.setMinFilter(MTLSamplerMinMagFilter::Nearest);
    descriptor.setMagFilter(MTLSamplerMinMagFilter::Nearest);
    device.newSamplerStateWithDescriptor(&descriptor)
}

fn build_preview_sampler(
    device: &MetalDevice,
) -> Option<Retained<ProtocolObject<dyn MTLSamplerState>>> {
    let descriptor = MTLSamplerDescriptor::new();
    descriptor.setMinFilter(MTLSamplerMinMagFilter::Linear);
    descriptor.setMagFilter(MTLSamplerMinMagFilter::Linear);
    device.newSamplerStateWithDescriptor(&descriptor)
}

fn encode_texture_present(
    device: &MetalDevice,
    command_buffer: &ProtocolObject<dyn MTLCommandBuffer>,
    pipeline: &ProtocolObject<dyn MTLRenderPipelineState>,
    sampler: &ProtocolObject<dyn MTLSamplerState>,
    source: &MetalTexture,
    target: &MetalTexture,
    background: [f64; 4],
) -> Option<()> {
    let encoder = {
        let pass = clear_pass(target, background);
        command_buffer.renderCommandEncoderWithDescriptor(&pass)?
    };
    encoder.setRenderPipelineState(pipeline);
    unsafe { encoder.setFragmentSamplerState_atIndex(Some(sampler), 0) };
    let vertices = quad_vertices([0.0, 0.0, 1.0, 1.0]);
    let buffer = unsafe {
        device.newBufferWithBytes_length_options(
            NonNull::new(vertices.as_ptr() as *mut c_void)?,
            std::mem::size_of_val(&vertices),
            MTLResourceOptions::StorageModeShared,
        )?
    };
    let params = FragParams {
        crop: [0.0; 4],
        mirror: 0.0,
        circle: 0.0,
    };
    unsafe {
        encoder.setVertexBuffer_offset_atIndex(Some(&buffer), 0, 0);
        encoder.setFragmentTexture_atIndex(Some(source), 0);
        encoder.setFragmentBytes_length_atIndex(
            NonNull::new(std::ptr::addr_of!(params) as *mut c_void)?,
            std::mem::size_of::<FragParams>(),
            0,
        );
        encoder.drawPrimitives_vertexStart_vertexCount(MTLPrimitiveType::Triangle, 0, 6);
    }
    encoder.endEncoding();
    Some(())
}

fn upload_bgra_to_texture(texture: &MetalTexture, source: &GpuSource<'_>) -> Option<()> {
    if source.bgra.len() < source.width.saturating_mul(source.height).saturating_mul(4) {
        return None;
    }
    let region = MTLRegion {
        origin: MTLOrigin { x: 0, y: 0, z: 0 },
        size: MTLSize {
            width: source.width,
            height: source.height,
            depth: 1,
        },
    };
    unsafe {
        texture.replaceRegion_mipmapLevel_withBytes_bytesPerRow(
            region,
            0,
            NonNull::new(source.bgra.as_ptr() as *mut c_void)?,
            source.width * 4,
        );
    }
    Some(())
}

/// Two triangles (6 vertices) covering `dest` = (x, y, w, h) in top-left-origin [0,1]
/// space, each vertex packed as float4(ndc_x, ndc_y, u, v).
fn quad_vertices(dest: [f32; 4]) -> [f32; 24] {
    let [x, y, w, h] = dest;
    let x0 = 2.0 * x - 1.0;
    let x1 = 2.0 * (x + w) - 1.0;
    let y0 = 1.0 - 2.0 * y;
    let y1 = 1.0 - 2.0 * (y + h);
    [
        x0, y0, 0.0, 0.0, // top-left
        x0, y1, 0.0, 1.0, // bottom-left
        x1, y0, 1.0, 0.0, // top-right
        x1, y0, 1.0, 0.0, // top-right
        x0, y1, 0.0, 1.0, // bottom-left
        x1, y1, 1.0, 1.0, // bottom-right
    ]
}

fn read_texture_bgra(texture: &MetalTexture, width: usize, height: usize) -> Vec<u8> {
    let bytes_per_row = width * 4;
    let mut out = vec![0u8; bytes_per_row * height];
    let region = MTLRegion {
        origin: MTLOrigin { x: 0, y: 0, z: 0 },
        size: MTLSize {
            width,
            height,
            depth: 1,
        },
    };
    if let Some(ptr) = NonNull::new(out.as_mut_ptr() as *mut c_void) {
        unsafe {
            texture.getBytes_bytesPerRow_fromRegion_mipmapLevel(ptr, bytes_per_row, region, 0);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_core_video::{CVPixelBufferGetHeight, CVPixelBufferGetWidth};

    fn pixel(buf: &[u8], width: usize, x: usize, y: usize) -> [u8; 4] {
        let i = (y * width + x) * 4;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    #[test]
    fn metal_clear_renders_the_requested_colour_or_skips_without_a_gpu() {
        // Clear to opaque red → BGRA [0, 0, 255, 255].
        let Some(pixels) = metal_clear_probe(4, 4, [1.0, 0.0, 0.0, 1.0]) else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        assert_eq!(pixels.len(), 4 * 4 * 4);
        for chunk in pixels.chunks_exact(4) {
            assert_eq!(chunk, [0, 0, 255, 255]);
        }
    }

    #[test]
    fn bgra_to_yuv420p_matches_full_range_bt601() {
        // 4×4 solid red. BGRA red = [0, 0, 255, 255]. Full-range BT.601: Y=76, U=85, V=255.
        let red = [0u8, 0, 255, 255].repeat(16);
        let yuv = bgra_to_yuv420p(&red, 4, 4);
        assert_eq!(yuv.len(), 16 + 2 * 4); // Y(16) + U(4) + V(4)
        assert!(yuv[..16].iter().all(|&y| y == 76), "Y plane");
        assert!(yuv[16..20].iter().all(|&u| u == 85), "U plane");
        assert!(yuv[20..24].iter().all(|&v| v == 255), "V plane");
    }

    #[test]
    fn source_zerocopy_defaults_on_with_falsey_escape_hatch() {
        assert!(source_zerocopy_enabled_from_env(None));
        assert!(source_zerocopy_enabled_from_env(Some("1")));
        assert!(source_zerocopy_enabled_from_env(Some("true")));
        assert!(source_zerocopy_enabled_from_env(Some("yes")));
        assert!(source_zerocopy_enabled_from_env(Some("on")));

        assert!(!source_zerocopy_enabled_from_env(Some("0")));
        assert!(!source_zerocopy_enabled_from_env(Some("false")));
        assert!(!source_zerocopy_enabled_from_env(Some("off")));
        assert!(!source_zerocopy_enabled_from_env(Some("no")));
    }

    #[test]
    fn metal_scene_compositor_is_send() {
        // The async compositor loop holds this across await points.
        fn assert_send<T: Send>() {}
        assert_send::<MetalSceneCompositor>();
    }

    #[test]
    fn metal_scene_compositor_composes_a_full_frame_source_or_skips() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        // A 2×2 solid-red source filling a 4×4 frame → all red → YUV (76,85,255).
        let red = [0u8, 0, 255, 255].repeat(4);
        let sources = [GpuSource {
            kind: GpuSourceKind::TestPattern,
            bgra: &red,
            iosurface: None,
            pixel_buffer: None,
            width: 2,
            height: 2,
            dest: [0.0, 0.0, 1.0, 1.0],
            crop: [0.0; 4],
            mirror: false,
            circle: false,
        }];
        let yuv = compositor.compose_yuv420p(4, 4, &sources).unwrap();
        assert_eq!(yuv.len(), 16 + 2 * 4);
        assert!(yuv[..16].iter().all(|&y| y == 76), "Y plane red");
        assert!(yuv[16..20].iter().all(|&u| u == 85), "U plane red");
    }

    #[test]
    fn metal_scene_compositor_reuses_same_size_target_or_skips() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let src = vec![255u8; 8 * 8 * 4];
        let sources = [full_frame(&src, 8, 8, false, false, [0.0; 4])];

        compositor.compose_yuv420p(16, 16, &sources).unwrap();
        assert_eq!(compositor.cached_target_size(), Some((16, 16)));
        compositor.compose_yuv420p(16, 16, &sources).unwrap();
        assert_eq!(compositor.cached_target_size(), Some((16, 16)));
        compositor.compose_yuv420p(32, 16, &sources).unwrap();
        assert_eq!(compositor.cached_target_size(), Some((32, 16)));
    }

    #[test]
    fn metal_scene_compositor_uses_iosurface_backed_target_when_available_or_falls_back() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let red = [0u8, 0, 255, 255];
        let sources = [full_frame(&red, 1, 1, false, false, [0.0; 4])];

        let pixels = compositor
            .compose_bgra(4, 4, [0.0, 0.0, 0.0, 1.0], &sources)
            .expect("compose into cached target");

        assert_eq!(pixel(&pixels, 4, 0, 0), [0, 0, 255, 255]);
        assert_eq!(pixel(&pixels, 4, 3, 3), [0, 0, 255, 255]);
        if let Some(target) = compositor.target.as_ref() {
            if compositor.cached_target_is_iosurface_backed() {
                assert!(
                    target.texture.iosurface().is_some(),
                    "cached target should expose its IOSurface"
                );
            } else {
                eprintln!("skipping: IOSurface-backed render target unavailable on this device");
            }
        }
    }

    #[test]
    fn metal_scene_compositor_exports_retained_target_pixel_buffer_or_skips() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let red = [0u8, 0, 255, 255];
        let sources = [full_frame(&red, 1, 1, false, false, [0.0; 4])];

        assert!(compositor.latest_target_pixel_buffer().is_none());
        compositor
            .compose_bgra(8, 4, [0.0, 0.0, 0.0, 1.0], &sources)
            .expect("compose into cached target");
        let Some(target) = compositor.latest_target_pixel_buffer() else {
            eprintln!("skipping: IOSurface-backed render target unavailable on this device");
            return;
        };

        assert_eq!(target.width(), 8);
        assert_eq!(target.height(), 4);
        assert!(target.has_iosurface(), "target should retain its IOSurface");
        let pixel_buffer = target.into_pixel_buffer();
        assert_eq!(CVPixelBufferGetWidth(&pixel_buffer), 8);
        assert_eq!(CVPixelBufferGetHeight(&pixel_buffer), 4);
        assert!(CVPixelBufferGetIOSurface(Some(&pixel_buffer)).is_some());
    }

    #[test]
    fn metal_scene_compositor_reuses_same_size_source_textures_or_skips() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let small = vec![255u8; 8 * 8 * 4];
        let wide = vec![128u8; 16 * 8 * 4];
        let sources = [full_frame(&small, 8, 8, false, false, [0.0; 4])];

        compositor.compose_yuv420p(16, 16, &sources).unwrap();
        assert_eq!(compositor.cached_source_texture_sizes(), vec![Some((8, 8))]);
        compositor.compose_yuv420p(16, 16, &sources).unwrap();
        assert_eq!(compositor.cached_source_texture_sizes(), vec![Some((8, 8))]);

        let resized_sources = [full_frame(&wide, 16, 8, false, false, [0.0; 4])];
        compositor
            .compose_yuv420p(16, 16, &resized_sources)
            .unwrap();
        assert_eq!(
            compositor.cached_source_texture_sizes(),
            vec![Some((16, 8))]
        );
    }

    fn full_frame(
        bgra: &[u8],
        w: usize,
        h: usize,
        mirror: bool,
        circle: bool,
        crop: [f32; 4],
    ) -> GpuSource<'_> {
        GpuSource {
            kind: GpuSourceKind::TestPattern,
            bgra,
            iosurface: None,
            pixel_buffer: None,
            width: w,
            height: h,
            dest: [0.0, 0.0, 1.0, 1.0],
            crop,
            mirror,
            circle,
        }
    }

    #[test]
    fn gpu_circle_mask_discards_corners_or_skips() {
        if !metal_available() {
            return;
        }
        let out = 8usize;
        let green = [0u8, 255, 0, 255].repeat(2 * 2);
        let sources = [full_frame(&green, 2, 2, false, true, [0.0; 4])];
        // Black background; the circle mask drops the corners so the background shows.
        let px = composite_sources(out, out, [0.0, 0.0, 0.0, 1.0], &sources).unwrap();
        assert_eq!(pixel(&px, out, 4, 4), [0, 255, 0, 255], "center is green");
        assert_eq!(
            pixel(&px, out, 0, 0),
            [0, 0, 0, 255],
            "corner masked to background"
        );
    }

    #[test]
    fn gpu_mirror_flips_the_source_horizontally_or_skips() {
        if !metal_available() {
            return;
        }
        // 2×2 source: column 0 red, column 1 blue (BGRA).
        let src = [
            0u8, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255,
        ];
        let sources = [full_frame(&src, 2, 2, true, false, [0.0; 4])];
        let px = composite_sources(4, 4, [0.0, 0.0, 0.0, 1.0], &sources).unwrap();
        assert_eq!(
            pixel(&px, 4, 0, 0),
            [255, 0, 0, 255],
            "mirrored left is blue"
        );
        assert_eq!(
            pixel(&px, 4, 3, 0),
            [0, 0, 255, 255],
            "mirrored right is red"
        );
    }

    #[test]
    fn gpu_crop_samples_only_the_visible_region_or_skips() {
        if !metal_available() {
            return;
        }
        // 4×2 source: left half (cols 0,1) red, right half (cols 2,3) blue.
        let mut src = Vec::new();
        for _row in 0..2 {
            for col in 0..4 {
                src.extend(if col < 2 {
                    [0, 0, 255, 255]
                } else {
                    [255, 0, 0, 255]
                });
            }
        }
        // Crop off the right 50% → only the red half is sampled, stretched to the frame.
        let sources = [full_frame(&src, 4, 2, false, false, [0.0, 0.0, 0.5, 0.0])];
        let px = composite_sources(4, 4, [0.0, 0.0, 0.0, 1.0], &sources).unwrap();
        assert_eq!(pixel(&px, 4, 0, 0), [0, 0, 255, 255], "left red");
        assert_eq!(
            pixel(&px, 4, 3, 0),
            [0, 0, 255, 255],
            "right still red after crop"
        );
    }

    #[test]
    fn gpu_composites_1080p_screen_plus_camera_or_skips() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            return;
        };
        // A 1080p screen fill + a 320×180 camera in the corner — the common scene at the
        // real output resolution, proving the GPU path handles full size (not just tiles).
        let screen = vec![200u8; 1920 * 1080 * 4];
        let camera = vec![100u8; 320 * 180 * 4];
        let sources = [
            GpuSource {
                kind: GpuSourceKind::Screen,
                bgra: &screen,
                iosurface: None,
                pixel_buffer: None,
                width: 1920,
                height: 1080,
                dest: [0.0, 0.0, 1.0, 1.0],
                crop: [0.0; 4],
                mirror: false,
                circle: false,
            },
            GpuSource {
                kind: GpuSourceKind::Camera,
                bgra: &camera,
                iosurface: None,
                pixel_buffer: None,
                width: 320,
                height: 180,
                dest: [0.7, 0.7, 0.28, 0.28],
                crop: [0.0; 4],
                mirror: true,
                circle: false,
            },
        ];
        let yuv = compositor.compose_yuv420p(1920, 1080, &sources).unwrap();
        assert_eq!(yuv.len(), 1920 * 1080 + 2 * (960 * 540));
    }

    #[test]
    fn compose_timings_count_source_byte_uploads_by_kind_or_skips() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            return;
        };
        let screen = vec![200u8; 2 * 2 * 4];
        let camera = vec![100u8; 2 * 2 * 4];
        let sources = [
            GpuSource {
                kind: GpuSourceKind::Screen,
                bgra: &screen,
                iosurface: None,
                pixel_buffer: None,
                width: 2,
                height: 2,
                dest: [0.0, 0.0, 1.0, 1.0],
                crop: [0.0; 4],
                mirror: false,
                circle: false,
            },
            GpuSource {
                kind: GpuSourceKind::Camera,
                bgra: &camera,
                iosurface: None,
                pixel_buffer: None,
                width: 2,
                height: 2,
                dest: [0.0, 0.0, 0.5, 0.5],
                crop: [0.0; 4],
                mirror: true,
                circle: false,
            },
        ];

        let output = compositor
            .compose_bgra_with_timings(4, 4, [0.0, 0.0, 0.0, 1.0], &sources)
            .expect("compose source import stats");

        assert_eq!(output.timings.source_import_stats.byte_upload_frames, 2);
        assert_eq!(
            output.timings.source_import_stats.screen_byte_upload_frames,
            1
        );
        assert_eq!(
            output.timings.source_import_stats.camera_byte_upload_frames,
            1
        );
        assert_eq!(output.timings.source_import_stats.iosurface_frames, 0);
        assert_eq!(output.timings.source_import_stats.import_failures, 0);
    }

    #[test]
    fn zero_copy_import_path_runs_against_the_texture_cache_or_skips() {
        let Some(device) = MTLCreateSystemDefaultDevice() else {
            return;
        };
        // The CVMetalTextureCache is created on the real device — the entry point of the
        // zero-copy source import.
        let Some(cache) = make_texture_cache(&device) else {
            return;
        };
        let (w, h) = (16usize, 16usize);
        let Some(pb) = make_iosurface_bgra_pixel_buffer(w, h) else {
            return;
        };
        // Runs the real CVMetalTextureCacheCreateTextureFromImage path against an
        // IOSurface-backed buffer, matching the live capture import path.
        match import_pixel_buffer_texture(&cache, &pb, w, h) {
            Some(texture) => {
                assert_eq!(texture.width(), w);
                assert_eq!(texture.height(), h);
            }
            None => {
                eprintln!("skipping: IOSurface-backed pixel buffer did not import on this device")
            }
        }
    }

    #[test]
    fn compose_timings_count_camera_cvpixelbuffer_import_or_skips() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            return;
        };
        let Some(cache) = compositor.source_texture_cache.as_ref() else {
            return;
        };
        let (w, h) = (16usize, 16usize);
        let Some(pixel_buffer) = make_iosurface_bgra_pixel_buffer(w, h) else {
            return;
        };
        if import_pixel_buffer_texture(cache.cache(), &pixel_buffer, w, h).is_none() {
            return;
        }
        let fallback_bgra = vec![0u8; w * h * 4];
        let sources = [GpuSource {
            kind: GpuSourceKind::Camera,
            bgra: &fallback_bgra,
            iosurface: None,
            pixel_buffer: Some(&pixel_buffer),
            width: w,
            height: h,
            dest: [0.0, 0.0, 1.0, 1.0],
            crop: [0.0; 4],
            mirror: false,
            circle: false,
        }];

        let output = compositor
            .compose_bgra_with_timings(w, h, [0.0, 0.0, 0.0, 1.0], &sources)
            .expect("compose CVPixelBuffer source import");

        assert_eq!(output.timings.source_import_stats.cvpixelbuffer_frames, 1);
        assert_eq!(
            output
                .timings
                .source_import_stats
                .camera_cvpixelbuffer_frames,
            1
        );
        assert_eq!(output.timings.source_import_stats.byte_upload_frames, 0);
        assert_eq!(output.timings.source_import_stats.import_failures, 0);
    }

    #[test]
    fn compose_timings_count_screen_cvpixelbuffer_import_or_skips() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            return;
        };
        let Some(cache) = compositor.source_texture_cache.as_ref() else {
            return;
        };
        let (w, h) = (16usize, 16usize);
        let Some(pixel_buffer) = make_iosurface_bgra_pixel_buffer(w, h) else {
            return;
        };
        if import_pixel_buffer_texture(cache.cache(), &pixel_buffer, w, h).is_none() {
            return;
        }
        let sources = [GpuSource {
            kind: GpuSourceKind::Screen,
            bgra: &[],
            iosurface: None,
            pixel_buffer: Some(&pixel_buffer),
            width: w,
            height: h,
            dest: [0.0, 0.0, 1.0, 1.0],
            crop: [0.0; 4],
            mirror: false,
            circle: false,
        }];

        let output = compositor
            .compose_bgra_with_timings(w, h, [0.0, 0.0, 0.0, 1.0], &sources)
            .expect("compose screen CVPixelBuffer source import");

        assert_eq!(output.timings.source_import_stats.cvpixelbuffer_frames, 1);
        assert_eq!(
            output
                .timings
                .source_import_stats
                .screen_cvpixelbuffer_frames,
            1
        );
        assert_eq!(output.timings.source_import_stats.byte_upload_frames, 0);
        assert_eq!(output.timings.source_import_stats.import_failures, 0);
    }

    #[test]
    fn preview_layer_present_path_runs_without_panicking_or_skips_without_a_gpu() {
        let Some(device) = MTLCreateSystemDefaultDevice() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let Some(queue) = device.newCommandQueue() else {
            return;
        };
        let layer = make_preview_layer(&device, 16.0, 16.0);
        let texture = make_texture(
            &device,
            16,
            16,
            MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead,
        )
        .unwrap();
        // Headless: no drawable is attached, so this returns false — but it must exercise
        // the present entry point (layer config, nextDrawable) without panicking.
        let _presented = present_texture_to_layer(&queue, &layer, &texture);
    }

    #[test]
    fn preview_layer_keeps_display_sync_enabled_or_skips_without_a_gpu() {
        let Some(device) = MTLCreateSystemDefaultDevice() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let layer = make_preview_layer(&device, 16.0, 16.0);
        // Regression guard: display sync MUST stay on so preview presents pace to the
        // display refresh. Disabling it (dd78b25) caused visible preview judder.
        assert!(
            layer.displaySyncEnabled(),
            "preview layer must keep display sync enabled for smooth, vsynced presentation"
        );
    }

    #[test]
    fn preview_presenter_renders_texture_into_target_or_skips_without_a_gpu() {
        let Some(device) = MTLCreateSystemDefaultDevice() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let Some(presenter) = MetalPreviewPresenter::new(device) else {
            return;
        };
        let source = make_texture(presenter.device(), 1, 1, MTLTextureUsage::ShaderRead).unwrap();
        let target = make_texture(
            presenter.device(),
            4,
            4,
            MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead,
        )
        .unwrap();
        let green = [0u8, 255, 0, 255];
        let source_frame = full_frame(&green, 1, 1, false, false, [0.0; 4]);
        upload_bgra_to_texture(&source, &source_frame).unwrap();

        presenter
            .render_texture_to_texture(&source, &target)
            .expect("preview render pass");

        let pixels = read_texture_bgra(&target, 4, 4);
        assert_eq!(pixel(&pixels, 4, 0, 0), [0, 255, 0, 255]);
        assert_eq!(pixel(&pixels, 4, 3, 3), [0, 255, 0, 255]);
    }

    #[test]
    fn preview_presenter_imports_iosurface_handoff_or_skips_without_a_gpu() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let Some(presenter) = compositor.make_preview_presenter() else {
            return;
        };
        let red = [0u8, 0, 255, 255];
        let source = full_frame(&red, 1, 1, false, false, [0.0; 4]);
        compositor
            .compose_bgra(8, 4, [0.0, 0.0, 0.0, 1.0], &[source])
            .expect("compose IOSurface-backed target");
        let Some(target) = compositor.latest_target_pixel_buffer() else {
            eprintln!("skipping: IOSurface-backed render target unavailable on this device");
            return;
        };
        let Some(iosurface_id) = target.iosurface_id() else {
            eprintln!("skipping: target has no IOSurface id");
            return;
        };

        let imported = import_iosurface_texture(
            presenter.device(),
            iosurface_id,
            target.width(),
            target.height(),
        )
        .expect("import compositor IOSurface handoff");

        assert_eq!(imported.width(), 8);
        assert_eq!(imported.height(), 4);
        assert_eq!(
            imported.iosurface().as_deref().map(IOSurfaceRef::id),
            Some(iosurface_id)
        );

        let layer = make_preview_layer(presenter.device(), 8.0, 4.0);
        // Headless layers usually have no drawable. This still exercises the complete
        // import-then-present path without requiring an on-screen AppKit host.
        let present_result = presenter.try_present_iosurface_to_layer(
            &layer,
            iosurface_id,
            target.width(),
            target.height(),
        );
        if let Err(failure) = present_result {
            assert_ne!(failure, MetalPreviewPresentFailure::IosurfaceImportFailed);
        }
    }

    #[test]
    fn compositor_presents_latest_target_to_layer_or_skips_without_a_gpu() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let Some(presenter) = compositor.make_preview_presenter() else {
            return;
        };
        let layer = make_preview_layer(presenter.device(), 4.0, 4.0);
        let red = [0u8, 0, 255, 255];
        let source = full_frame(&red, 1, 1, false, false, [0.0; 4]);

        assert!(!compositor.present_latest_to_layer(&presenter, &layer));
        let _pixels = compositor
            .compose_bgra(4, 4, [0.0, 0.0, 0.0, 1.0], &[source])
            .expect("compose target");

        // Headless layers normally have no drawable, so the return value can be false; the
        // important contract is that the compositor can hand the cached target to the
        // presenter without exposing the raw texture outside this module.
        let _presented = compositor.present_latest_to_layer(&presenter, &layer);
    }

    #[test]
    fn gpu_composites_a_source_quad_over_the_background_or_skips_without_a_gpu() {
        if !metal_available() {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        }
        // 8×8 blue background; a 2×2 solid-green source drawn into the right half
        // (dest x=0.5,y=0, w=0.5,h=1.0 → covers columns 4..8).
        let out = 8usize;
        let green = vec![0u8, 255, 0, 255].repeat(2 * 2); // BGRA green, 2×2
        let sources = [GpuSource {
            kind: GpuSourceKind::TestPattern,
            bgra: &green,
            iosurface: None,
            pixel_buffer: None,
            width: 2,
            height: 2,
            dest: [0.5, 0.0, 0.5, 1.0],
            crop: [0.0; 4],
            mirror: false,
            circle: false,
        }];
        let pixels = composite_sources(out, out, [0.0, 0.0, 1.0, 1.0], &sources).unwrap();
        assert_eq!(pixels.len(), out * out * 4);

        // Left half stays background blue; right half is the green source.
        assert_eq!(
            pixel(&pixels, out, 1, 4),
            [255, 0, 0, 255],
            "left should be blue"
        );
        assert_eq!(
            pixel(&pixels, out, 6, 4),
            [0, 255, 0, 255],
            "right should be green"
        );
    }
}
