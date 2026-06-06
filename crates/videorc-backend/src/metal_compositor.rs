//! Metal/GPU compositor core (plan Phase 3).
//!
//! The shipping compositor composes frames with a CPU YUV420P loop. OBS composes on the
//! GPU. This module is the GPU foundation: it creates a Metal device and composites
//! textured source quads into an offscreen render target on the GPU, proving the path
//! works on this hardware (Apple M4 / Metal 4) before it is wired into the live
//! preview/recording hot path (the remaining integration, which needs on-device visual
//! validation and a zero-copy IOSurface export to the encoder).
//!
//! macOS-only. Everything renders to an offscreen `MTLTexture` and reads the pixels back,
//! so it is testable headlessly (no window) wherever a Metal device is available.

#![cfg(target_os = "macos")]
#![allow(dead_code)]

use std::ffi::c_void;
use std::ptr::NonNull;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_core_foundation::{CFRetained, CGSize};
use objc2_core_video::{
    CVMetalTexture, CVMetalTextureCache, CVMetalTextureGetTexture, CVPixelBuffer,
};
use objc2_foundation::NSString;
use objc2_metal::{
    MTLClearColor, MTLCommandBuffer, MTLCommandEncoder, MTLCommandQueue,
    MTLCreateSystemDefaultDevice, MTLDevice, MTLDrawable, MTLLibrary, MTLLoadAction, MTLOrigin,
    MTLPixelFormat, MTLPrimitiveType, MTLRegion, MTLRenderCommandEncoder, MTLRenderPassDescriptor,
    MTLRenderPipelineDescriptor, MTLRenderPipelineState, MTLResourceOptions, MTLSamplerDescriptor,
    MTLSamplerMinMagFilter, MTLSamplerState, MTLSize, MTLStoreAction, MTLTexture,
    MTLTextureDescriptor, MTLTextureUsage,
};
use objc2_quartz_core::{CAMetalDrawable, CAMetalLayer};

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
    pub bgra: &'a [u8],
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
}

struct CachedTargetTexture(Retained<MetalTexture>);

struct CachedSourceTexture {
    texture: Retained<MetalTexture>,
    width: usize,
    height: usize,
}

// SAFETY: The cached render target is owned by one compositor instance and is only used
// sequentially by the compositor loop. Metal resources are valid across threads; this
// wrapper only allows Tokio to move the owning task between worker threads.
unsafe impl Send for CachedTargetTexture {}

// SAFETY: Source textures follow the same ownership model as the target texture: each one
// is owned by a single compositor instance and refreshed sequentially in the render loop.
unsafe impl Send for CachedSourceTexture {}

impl MetalSceneCompositor {
    /// Build the compositor, or `None` when no Metal device / shader compile is available.
    pub fn new() -> Option<Self> {
        let device = MTLCreateSystemDefaultDevice()?;
        let queue = device.newCommandQueue()?;
        let pipeline = build_pipeline(&device)?;
        let sampler = build_sampler(&device)?;
        Some(Self {
            device,
            queue,
            pipeline,
            sampler,
            target: None,
            target_width: 0,
            target_height: 0,
            source_textures: Vec::new(),
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
        self.ensure_target_texture(out_width, out_height)?;
        let command_buffer = self.queue.commandBuffer()?;
        let encoder = {
            let target = self.target.as_ref()?;
            let pass = clear_pass(&target.0, background);
            command_buffer.renderCommandEncoderWithDescriptor(&pass)?
        };
        encoder.setRenderPipelineState(&self.pipeline);
        unsafe { encoder.setFragmentSamplerState_atIndex(Some(&self.sampler), 0) };
        self.source_textures.truncate(sources.len());
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
            let texture = self.ensure_source_texture(source_index, source)?;
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
        }
        encoder.endEncoding();
        command_buffer.commit();
        command_buffer.waitUntilCompleted();
        let target = self.target.as_ref()?;
        Some(read_texture_bgra(&target.0, out_width, out_height))
    }

    /// Composite over a TV-black (Y=16) background and convert to planar YUV420P, matching
    /// the CPU compositor's output format/coefficients so the encoder pipeline is unchanged.
    pub fn compose_yuv420p(
        &mut self,
        out_width: usize,
        out_height: usize,
        sources: &[GpuSource<'_>],
    ) -> Option<Vec<u8>> {
        let background = [16.0 / 255.0, 16.0 / 255.0, 16.0 / 255.0, 1.0];
        let bgra = self.compose_bgra(out_width, out_height, background, sources)?;
        Some(bgra_to_yuv420p(&bgra, out_width, out_height))
    }

    fn ensure_target_texture(&mut self, width: usize, height: usize) -> Option<()> {
        if self.target.is_some() && self.target_width == width && self.target_height == height {
            return Some(());
        }
        self.target = Some(CachedTargetTexture(make_texture(
            &self.device,
            width,
            height,
            MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead,
        )?));
        self.target_width = width;
        self.target_height = height;
        Some(())
    }

    fn ensure_source_texture(
        &mut self,
        index: usize,
        source: &GpuSource<'_>,
    ) -> Option<&MetalTexture> {
        if self.source_textures.len() <= index {
            self.source_textures.resize_with(index + 1, || None);
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
        Some(&cached.texture)
    }

    #[cfg(test)]
    fn cached_target_size(&self) -> Option<(usize, usize)> {
        self.target
            .as_ref()
            .map(|_| (self.target_width, self.target_height))
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

/// Full-range BT.601 RGB→YUV, identical to the CPU compositor's `rgb_to_yuv`, so the GPU
/// path produces byte-compatible YUV420P.
fn rgb_to_yuv(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    let r = i32::from(r);
    let g = i32::from(g);
    let b = i32::from(b);
    let y = ((77 * r + 150 * g + 29 * b) >> 8).clamp(0, 255) as u8;
    let u = (128 + ((-43 * r - 85 * g + 128 * b) >> 8)).clamp(0, 255) as u8;
    let v = (128 + ((128 * r - 107 * g - 21 * b) >> 8)).clamp(0, 255) as u8;
    (y, u, v)
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
    // The drawable is a render target for the scaled preview present path.
    layer.setFramebufferOnly(false);
    layer.setDrawableSize(CGSize { width, height });
    layer
}

/// Cached renderer for presenting the compositor target into a `CAMetalLayer`.
///
/// The recording compositor intentionally uses nearest sampling to preserve exact crop
/// edges. Preview presentation is a separate surface concern: it uses linear sampling so
/// the full-resolution compositor texture can be downsampled to the window's drawable
/// size without the hard pixel stair-steps of a blit copy.
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

    pub fn device(&self) -> &MetalDevice {
        &self.device
    }

    /// Present a composited texture to the layer's next drawable via a scaled render pass.
    /// Returns `false` when no drawable is available (e.g. a headless test layer).
    pub fn present_texture_to_layer(&self, layer: &CAMetalLayer, texture: &MetalTexture) -> bool {
        let Some(drawable) = layer.nextDrawable() else {
            return false;
        };
        let drawable_texture = drawable.texture();
        let Some(command_buffer) = self.queue.commandBuffer() else {
            return false;
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
            return false;
        }
        let mtl_drawable: &ProtocolObject<dyn MTLDrawable> = ProtocolObject::from_ref(&*drawable);
        command_buffer.presentDrawable(mtl_drawable);
        command_buffer.commit();
        command_buffer.waitUntilCompleted();
        true
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
    command_buffer.waitUntilCompleted();
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
            bgra: &red,
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
            bgra,
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
                bgra: &screen,
                width: 1920,
                height: 1080,
                dest: [0.0, 0.0, 1.0, 1.0],
                crop: [0.0; 4],
                mirror: false,
                circle: false,
            },
            GpuSource {
                bgra: &camera,
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
    fn zero_copy_import_path_runs_against_the_texture_cache_or_skips() {
        use objc2_core_video::{CVPixelBufferCreate, kCVPixelFormatType_32BGRA};
        let Some(device) = MTLCreateSystemDefaultDevice() else {
            return;
        };
        // The CVMetalTextureCache is created on the real device — the entry point of the
        // zero-copy source import.
        let Some(cache) = make_texture_cache(&device) else {
            return;
        };
        let (w, h) = (16usize, 16usize);
        let mut pb: *mut CVPixelBuffer = std::ptr::null_mut();
        let ret = unsafe {
            CVPixelBufferCreate(
                None,
                w,
                h,
                kCVPixelFormatType_32BGRA,
                None,
                NonNull::new(&mut pb).unwrap(),
            )
        };
        if ret != 0 || pb.is_null() {
            return;
        }
        let pb = unsafe { CFRetained::from_raw(NonNull::new(pb).unwrap()) };
        // Runs the real CVMetalTextureCacheCreateTextureFromImage path. A buffer built
        // without IOSurface backing yields None (the import is for live, IOSurface-backed
        // capture buffers); either way the import path executes without crashing.
        match import_pixel_buffer_texture(&cache, &pb, w, h) {
            Some(texture) => {
                assert_eq!(texture.width(), w);
                assert_eq!(texture.height(), h);
            }
            None => {
                eprintln!("note: synthetic buffer lacks IOSurface backing; import returned None")
            }
        }
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
            bgra: &green,
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
