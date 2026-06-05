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
use objc2_core_foundation::CGSize;
use objc2_foundation::NSString;
use objc2_metal::{
    MTLBlitCommandEncoder, MTLClearColor, MTLCommandBuffer, MTLCommandEncoder, MTLCommandQueue,
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
vertex VOut v_main(uint vid [[vertex_id]], const device float4* verts [[buffer(0)]]) {
    VOut out;
    float4 v = verts[vid];
    out.pos = float4(v.x, v.y, 0.0, 1.0);
    out.uv = float2(v.z, v.w);
    return out;
}
fragment float4 f_main(VOut in [[stage_in]],
                       texture2d<float> tex [[texture(0)]],
                       sampler samp [[sampler(0)]]) {
    return tex.sample(samp, in.uv);
}
"#;

/// One source layer to composite: BGRA8 pixels at `width`×`height`, drawn into the
/// destination rectangle `dest` = (x, y, w, h) in normalized [0,1] coordinates with the
/// origin at the top-left (the convention the scene model uses).
pub struct GpuSource<'a> {
    pub bgra: &'a [u8],
    pub width: usize,
    pub height: usize,
    pub dest: [f32; 4],
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
    let device = MTLCreateSystemDefaultDevice()?;
    let queue = device.newCommandQueue()?;
    let pipeline = build_pipeline(&device)?;
    let sampler = build_sampler(&device)?;
    let target = make_texture(
        &device,
        out_width,
        out_height,
        MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead,
    )?;

    let command_buffer = queue.commandBuffer()?;
    let encoder = {
        let pass = clear_pass(&target, background);
        command_buffer.renderCommandEncoderWithDescriptor(&pass)?
    };
    encoder.setRenderPipelineState(&pipeline);
    unsafe { encoder.setFragmentSamplerState_atIndex(Some(&sampler), 0) };

    for source in sources {
        let texture = upload_texture(&device, source)?;
        let vertices = quad_vertices(source.dest);
        let buffer = unsafe {
            device.newBufferWithBytes_length_options(
                NonNull::new(vertices.as_ptr() as *mut c_void)?,
                std::mem::size_of_val(&vertices),
                MTLResourceOptions::StorageModeShared,
            )?
        };
        unsafe {
            encoder.setVertexBuffer_offset_atIndex(Some(&buffer), 0, 0);
            encoder.setFragmentTexture_atIndex(Some(&texture), 0);
            encoder.drawPrimitives_vertexStart_vertexCount(MTLPrimitiveType::Triangle, 0, 6);
        }
    }

    encoder.endEncoding();
    command_buffer.commit();
    command_buffer.waitUntilCompleted();

    Some(read_texture_bgra(&target, out_width, out_height))
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
}

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
        })
    }

    /// Composite `sources` over `background` into an offscreen BGRA8 target and read back.
    pub fn compose_bgra(
        &self,
        out_width: usize,
        out_height: usize,
        background: [f64; 4],
        sources: &[GpuSource<'_>],
    ) -> Option<Vec<u8>> {
        let target = make_texture(
            &self.device,
            out_width,
            out_height,
            MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead,
        )?;
        let command_buffer = self.queue.commandBuffer()?;
        let encoder = {
            let pass = clear_pass(&target, background);
            command_buffer.renderCommandEncoderWithDescriptor(&pass)?
        };
        encoder.setRenderPipelineState(&self.pipeline);
        unsafe { encoder.setFragmentSamplerState_atIndex(Some(&self.sampler), 0) };
        for source in sources {
            let texture = upload_texture(&self.device, source)?;
            let vertices = quad_vertices(source.dest);
            let buffer = unsafe {
                self.device.newBufferWithBytes_length_options(
                    NonNull::new(vertices.as_ptr() as *mut c_void)?,
                    std::mem::size_of_val(&vertices),
                    MTLResourceOptions::StorageModeShared,
                )?
            };
            unsafe {
                encoder.setVertexBuffer_offset_atIndex(Some(&buffer), 0, 0);
                encoder.setFragmentTexture_atIndex(Some(&texture), 0);
                encoder.drawPrimitives_vertexStart_vertexCount(MTLPrimitiveType::Triangle, 0, 6);
            }
        }
        encoder.endEncoding();
        command_buffer.commit();
        command_buffer.waitUntilCompleted();
        Some(read_texture_bgra(&target, out_width, out_height))
    }

    /// Composite over a TV-black (Y=16) background and convert to planar YUV420P, matching
    /// the CPU compositor's output format/coefficients so the encoder pipeline is unchanged.
    pub fn compose_yuv420p(
        &self,
        out_width: usize,
        out_height: usize,
        sources: &[GpuSource<'_>],
    ) -> Option<Vec<u8>> {
        let background = [16.0 / 255.0, 16.0 / 255.0, 16.0 / 255.0, 1.0];
        let bgra = self.compose_bgra(out_width, out_height, background, sources)?;
        Some(bgra_to_yuv420p(&bgra, out_width, out_height))
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
    // The drawable is a blit destination here, so it cannot be framebuffer-only.
    layer.setFramebufferOnly(false);
    layer.setDrawableSize(CGSize { width, height });
    layer
}

/// Present a composited texture to the layer's next drawable via a blit copy. Returns
/// `false` when no drawable is available (e.g. the layer is not attached to a screen, as
/// in a headless test) so callers degrade gracefully; the on-screen result is validated
/// in a window. This is the GPU-side present that replaces the PNG image-poll path.
pub fn present_texture_to_layer(
    queue: &ProtocolObject<dyn MTLCommandQueue>,
    layer: &CAMetalLayer,
    texture: &MetalTexture,
) -> bool {
    let Some(drawable) = layer.nextDrawable() else {
        return false;
    };
    let drawable_texture = drawable.texture();
    let Some(command_buffer) = queue.commandBuffer() else {
        return false;
    };
    let Some(blit) = command_buffer.blitCommandEncoder() else {
        return false;
    };
    let copy_width = texture.width().min(drawable_texture.width());
    let copy_height = texture.height().min(drawable_texture.height());
    unsafe {
        blit.copyFromTexture_sourceSlice_sourceLevel_sourceOrigin_sourceSize_toTexture_destinationSlice_destinationLevel_destinationOrigin(
            texture,
            0,
            0,
            MTLOrigin { x: 0, y: 0, z: 0 },
            MTLSize {
                width: copy_width,
                height: copy_height,
                depth: 1,
            },
            &drawable_texture,
            0,
            0,
            MTLOrigin { x: 0, y: 0, z: 0 },
        );
    }
    blit.endEncoding();
    let mtl_drawable: &ProtocolObject<dyn MTLDrawable> = ProtocolObject::from_ref(&*drawable);
    command_buffer.presentDrawable(mtl_drawable);
    command_buffer.commit();
    command_buffer.waitUntilCompleted();
    true
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

fn build_pipeline(device: &MetalDevice) -> Option<Retained<ProtocolObject<dyn MTLRenderPipelineState>>> {
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

    device.newRenderPipelineStateWithDescriptor_error(&descriptor).ok()
}

fn build_sampler(device: &MetalDevice) -> Option<Retained<ProtocolObject<dyn MTLSamplerState>>> {
    let descriptor = MTLSamplerDescriptor::new();
    descriptor.setMinFilter(MTLSamplerMinMagFilter::Nearest);
    descriptor.setMagFilter(MTLSamplerMinMagFilter::Nearest);
    device.newSamplerStateWithDescriptor(&descriptor)
}

fn upload_texture(device: &MetalDevice, source: &GpuSource<'_>) -> Option<Retained<MetalTexture>> {
    let texture = make_texture(device, source.width, source.height, MTLTextureUsage::ShaderRead)?;
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
    Some(texture)
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
        let Some(compositor) = MetalSceneCompositor::new() else {
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
        }];
        let yuv = compositor.compose_yuv420p(4, 4, &sources).unwrap();
        assert_eq!(yuv.len(), 16 + 2 * 4);
        assert!(yuv[..16].iter().all(|&y| y == 76), "Y plane red");
        assert!(yuv[16..20].iter().all(|&u| u == 85), "U plane red");
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
        // the full present path (layer config, nextDrawable, blit) without panicking.
        let _presented = present_texture_to_layer(&queue, &layer, &texture);
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
        }];
        let pixels = composite_sources(out, out, [0.0, 0.0, 1.0, 1.0], &sources).unwrap();
        assert_eq!(pixels.len(), out * out * 4);

        // Left half stays background blue; right half is the green source.
        assert_eq!(pixel(&pixels, out, 1, 4), [255, 0, 0, 255], "left should be blue");
        assert_eq!(pixel(&pixels, out, 6, 4), [0, 255, 0, 255], "right should be green");
    }
}
