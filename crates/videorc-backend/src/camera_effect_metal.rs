//! Plan 258 S3: the macOS engine of the camera effect stage.
//!
//! - **Segmentation:** Apple Vision `VNGeneratePersonSegmentationRequest` at
//!   `.balanced` (S0: 21.3 / 25.1 ms p50/p95 at 1080p30 on the Neural
//!   Engine), one stateful request per camera session, fed the camera buffer
//!   as is (S0: a downscale saves nothing). The matte comes back 8-bit
//!   (S0: the same cost as 16-bit half).
//! - **The pass:** one Metal command buffer on its own queue: a quarter-size
//!   copy of the camera, weighted by `1 - matte` so the person never bleeds
//!   into the blur; a separable Gaussian; then a full-size draw that refines
//!   the matte against the camera's luma (a small joint bilateral) and mixes
//!   the camera over the blur or the picture. The output is a BGRA
//!   IOSurface buffer from a `CVPixelBufferPool`, so the compositor keeps
//!   its zero-copy import.
//! - **The cover** (D6) is the same draw with no matte: the whole frame at
//!   Strong blur plus 50 %, or the picture alone.
//!
//! Vision is called through the Objective-C runtime (no new crate): the
//! framework is linked here and the classes are looked up by name, so a
//! macOS without them (before 12) reports the stage unavailable.

#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;

use objc2::msg_send;
use objc2::rc::{Allocated, Retained, autoreleasepool};
use objc2::runtime::{AnyClass, AnyObject, ProtocolObject};
use objc2_core_foundation::{CFDictionary, CFRetained};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetHeight, CVPixelBufferGetIOSurface, CVPixelBufferGetPixelFormatType,
    CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferPool,
    CVPixelBufferUnlockBaseAddress, kCVPixelBufferHeightKey, kCVPixelBufferIOSurfacePropertiesKey,
    kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey, kCVPixelFormatType_32BGRA,
    kCVPixelFormatType_OneComponent8,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSNumber, NSString};
use objc2_metal::{
    MTLCommandBuffer, MTLCommandEncoder, MTLCommandQueue, MTLComputeCommandEncoder,
    MTLComputePipelineState, MTLCreateSystemDefaultDevice, MTLDevice, MTLLibrary, MTLLoadAction,
    MTLOrigin, MTLPixelFormat, MTLPrimitiveType, MTLRegion, MTLRenderCommandEncoder,
    MTLRenderPassDescriptor, MTLRenderPipelineDescriptor, MTLRenderPipelineState, MTLSize,
    MTLStorageMode, MTLStoreAction, MTLTexture, MTLTextureDescriptor, MTLTextureUsage,
};

use crate::frame_store::RetainedPixelBuffer;
use crate::preview_camera::effect_stage::{
    EffectFrame, EffectKind, EffectLook, EffectOutput, EffectPixels, EffectRenderer, EngineParts,
    Matte, NEUTRAL_GROUND_BGRA, PersonSegmenter, blur_radius_px, cover_blur_radius_px,
};

type Device = ProtocolObject<dyn MTLDevice>;
type Texture = ProtocolObject<dyn MTLTexture>;
type Queue = ProtocolObject<dyn MTLCommandQueue>;
type ComputePipeline = ProtocolObject<dyn MTLComputePipelineState>;
type RenderPipeline = ProtocolObject<dyn MTLRenderPipelineState>;

#[link(name = "Vision", kind = "framework")]
unsafe extern "C" {}

/// `VNGeneratePersonSegmentationRequestQualityLevelBalanced` (S0's pick).
const VISION_QUALITY_BALANCED: usize = 1;
/// A picture is kept at most this many pixels on its long side.
const MAX_PICTURE_SIDE: u32 = 2560;
/// The edge of the refined matte (S6 maps Edges to these).
const EDGE_LO: f32 = 0.3;
const EDGE_HI: f32 = 0.7;

const SHADER_SOURCE: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct DownParams { uint weighted; uint pad0; uint pad1; uint pad2; };

// A quarter-size copy of the camera as (rgb * w, w). w is 1 for the cover
// and 1 - person for the effect, so the blur never pulls the person in.
kernel void k_down(texture2d<float, access::sample> src [[texture(0)]],
                   texture2d<float, access::sample> matte [[texture(1)]],
                   texture2d<float, access::write> out [[texture(2)]],
                   constant DownParams& p [[buffer(0)]],
                   uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= out.get_width() || gid.y >= out.get_height()) return;
    constexpr sampler s(filter::linear, address::clamp_to_edge, coord::normalized);
    float2 size = float2(out.get_width(), out.get_height());
    float2 uv = (float2(gid) + 0.5) / size;
    float2 d = 0.25 / size;
    float3 c = src.sample(s, uv + float2(-d.x, -d.y)).rgb
             + src.sample(s, uv + float2( d.x, -d.y)).rgb
             + src.sample(s, uv + float2(-d.x,  d.y)).rgb
             + src.sample(s, uv + float2( d.x,  d.y)).rgb;
    c *= 0.25;
    float w = 1.0;
    if (p.weighted != 0) {
        float m = matte.sample(s, uv).r;
        w = 1.0 - smoothstep(0.15, 0.5, m);
    }
    out.write(float4(c * w, w), gid);
}

struct BlurParams { int radius; float sigma; int dir_x; int dir_y; };

kernel void k_blur(texture2d<float, access::read> in [[texture(0)]],
                   texture2d<float, access::write> out [[texture(1)]],
                   constant BlurParams& p [[buffer(0)]],
                   uint2 gid [[thread_position_in_grid]]) {
    int2 size = int2(in.get_width(), in.get_height());
    if (int(gid.x) >= size.x || int(gid.y) >= size.y) return;
    int2 dir = int2(p.dir_x, p.dir_y);
    float4 acc = float4(0.0);
    float wsum = 0.0;
    float k = 1.0 / (2.0 * p.sigma * p.sigma);
    for (int i = -p.radius; i <= p.radius; ++i) {
        int2 q = clamp(int2(gid) + dir * i, int2(0), size - 1);
        float g = exp(-float(i * i) * k);
        acc += in.read(uint2(q)) * g;
        wsum += g;
    }
    out.write(acc / wsum, gid);
}

struct VOut { float4 pos [[position]]; float2 uv; };

vertex VOut v_full(uint vid [[vertex_id]]) {
    float2 p = float2(float((vid << 1) & 2), float(vid & 2));
    VOut o;
    o.pos = float4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
    o.uv = p;
    return o;
}

struct ComposeParams {
    float4 image_xform;  // image uv = uv * xy + zw (cover fit, mirror)
    float4 neutral;      // the neutral ground, rgb
    float2 matte_texel;
    uint mode;           // 0 blur, 1 picture, 2 neutral ground
    uint cover;          // 1: what is behind the person only (D6)
    float edge_lo;
    float edge_hi;
    float pad0;
    float pad1;
};

fragment float4 f_compose(VOut in [[stage_in]],
                          texture2d<float> src [[texture(0)]],
                          texture2d<float> blurred [[texture(1)]],
                          texture2d<float> matte [[texture(2)]],
                          texture2d<float> image [[texture(3)]],
                          constant ComposeParams& p [[buffer(0)]]) {
    constexpr sampler s(filter::linear, address::clamp_to_edge, coord::normalized);
    float2 uv = in.uv;
    float3 bg;
    if (p.mode == 0) {
        float4 b = blurred.sample(s, uv);
        bg = b.a > 0.001 ? b.rgb / b.a : p.neutral.rgb;
    } else if (p.mode == 1) {
        bg = image.sample(s, uv * p.image_xform.xy + p.image_xform.zw).rgb;
    } else {
        bg = p.neutral.rgb;
    }
    if (p.cover != 0) {
        return float4(bg, 1.0);
    }
    float3 c = src.sample(s, uv).rgb;
    const float3 luma = float3(0.299, 0.587, 0.114);
    float lc = dot(c, luma);
    float acc = 0.0;
    float wsum = 0.0;
    for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
            float2 o = float2(float(dx), float(dy)) * p.matte_texel;
            float m = matte.sample(s, uv + o).r;
            float l = dot(src.sample(s, uv + o).rgb, luma);
            float spatial = (dx == 0 && dy == 0) ? 1.0 : 0.6;
            float w = spatial * exp(-(l - lc) * (l - lc) * 50.0);
            acc += m * w;
            wsum += w;
        }
    }
    float m = smoothstep(p.edge_lo, p.edge_hi, acc / max(wsum, 1e-4));
    return float4(mix(bg, c, m), 1.0);
}
"#;

#[repr(C)]
#[derive(Clone, Copy)]
struct DownParams {
    weighted: u32,
    pad: [u32; 3],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct BlurParams {
    radius: i32,
    sigma: f32,
    dir_x: i32,
    dir_y: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct ComposeParams {
    image_xform: [f32; 4],
    neutral: [f32; 4],
    matte_texel: [f32; 2],
    mode: u32,
    cover: u32,
    edge_lo: f32,
    edge_hi: f32,
    pad: [f32; 2],
}

/// The engine the stage's worker builds: Vision and the Metal pass.
pub(crate) fn engine_parts() -> EngineParts {
    let renderer =
        MetalEffectRenderer::new().map(|renderer| Box::new(renderer) as Box<dyn EffectRenderer>);
    let segmenter = match &renderer {
        Ok(_) => VisionSegmenter::new().map(|segmenter| Box::new(segmenter) as _),
        Err(error) => Err(error.clone()),
    };
    EngineParts {
        segmenter,
        renderer: renderer.ok(),
    }
}

/// Tight BGRA bytes of a BGRA pixel buffer (the CPU cover and readers that
/// need bytes).
pub(crate) fn read_bgra(pixel_buffer: &CVPixelBuffer) -> Option<Vec<u8>> {
    if CVPixelBufferGetPixelFormatType(pixel_buffer) != kCVPixelFormatType_32BGRA {
        return None;
    }
    read_plane(pixel_buffer, 4)
}

fn read_plane(pixel_buffer: &CVPixelBuffer, bytes_per_pixel: usize) -> Option<Vec<u8>> {
    let width = CVPixelBufferGetWidth(pixel_buffer);
    let height = CVPixelBufferGetHeight(pixel_buffer);
    if width == 0 || height == 0 {
        return None;
    }
    if unsafe { CVPixelBufferLockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly) } != 0
    {
        return None;
    }
    let base = CVPixelBufferGetBaseAddress(pixel_buffer);
    let stride = CVPixelBufferGetBytesPerRow(pixel_buffer);
    let row = width * bytes_per_pixel;
    let out = (!base.is_null() && stride >= row).then(|| {
        let mut out = vec![0u8; row * height];
        for y in 0..height {
            let source =
                unsafe { std::slice::from_raw_parts(base.cast::<u8>().add(y * stride), row) };
            out[y * row..(y + 1) * row].copy_from_slice(source);
        }
        out
    });
    unsafe {
        CVPixelBufferUnlockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly);
    }
    out
}

/// A pool of IOSurface-backed pixel buffers of one size and format. CoreVideo
/// hands a buffer back only once every holder (the store, a compositor) has
/// let it go, so a published frame is never drawn over.
struct BufferPool {
    width: usize,
    height: usize,
    pool: CFRetained<CVPixelBufferPool>,
}

// SAFETY: CVPixelBufferPool is thread-safe; the pool is only used by the
// renderer or segmenter that owns it, one thread at a time.
unsafe impl Send for BufferPool {}

impl BufferPool {
    fn new(width: usize, height: usize, format: u32) -> Option<Self> {
        let key = |key: &'static objc2_core_foundation::CFString| -> &NSString {
            unsafe { &*(key as *const _ as *const NSString) }
        };
        let iosurface = NSDictionary::<NSString, AnyObject>::new();
        let format = NSNumber::new_u32(format);
        let width_value = NSNumber::new_usize(width);
        let height_value = NSNumber::new_usize(height);
        let attributes = NSDictionary::<NSString, AnyObject>::from_slices(
            &[
                key(unsafe { kCVPixelBufferPixelFormatTypeKey }),
                key(unsafe { kCVPixelBufferWidthKey }),
                key(unsafe { kCVPixelBufferHeightKey }),
                key(unsafe { kCVPixelBufferIOSurfacePropertiesKey }),
            ],
            &[
                format.as_ref(),
                width_value.as_ref(),
                height_value.as_ref(),
                iosurface.as_ref(),
            ],
        );
        // SAFETY: NSDictionary is toll-free bridged to CFDictionary.
        let attributes: &CFDictionary =
            unsafe { &*(Retained::as_ptr(&attributes) as *const CFDictionary) };
        let mut pool: *mut CVPixelBufferPool = std::ptr::null_mut();
        let status = unsafe {
            CVPixelBufferPool::create(None, None, Some(attributes), NonNull::new(&mut pool)?)
        };
        if status != 0 {
            return None;
        }
        let pool = NonNull::new(pool).map(|pool| unsafe { CFRetained::from_raw(pool) })?;
        Some(Self {
            width,
            height,
            pool,
        })
    }

    fn take(&self) -> Option<CFRetained<CVPixelBuffer>> {
        let mut buffer: *mut CVPixelBuffer = std::ptr::null_mut();
        let status = unsafe {
            CVPixelBufferPool::create_pixel_buffer(None, &self.pool, NonNull::new(&mut buffer)?)
        };
        if status != 0 {
            return None;
        }
        NonNull::new(buffer).map(|buffer| unsafe { CFRetained::from_raw(buffer) })
    }
}

/// Copy tight BGRA bytes into a pooled pixel buffer (the fixture camera and
/// Y'CbCr cameras reach the stage as bytes).
fn upload_to_pool(
    pool: &mut Option<BufferPool>,
    bytes: &[u8],
    width: usize,
    height: usize,
) -> Option<CFRetained<CVPixelBuffer>> {
    if bytes.len() != width * height * 4 {
        return None;
    }
    if pool
        .as_ref()
        .is_none_or(|pool| pool.width != width || pool.height != height)
    {
        *pool = BufferPool::new(width, height, kCVPixelFormatType_32BGRA);
    }
    let buffer = pool.as_ref()?.take()?;
    if unsafe { CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) } != 0 {
        return None;
    }
    let base = CVPixelBufferGetBaseAddress(&buffer);
    let stride = CVPixelBufferGetBytesPerRow(&buffer);
    let row = width * 4;
    let ok = !base.is_null() && stride >= row;
    if ok {
        for y in 0..height {
            let target =
                unsafe { std::slice::from_raw_parts_mut(base.cast::<u8>().add(y * stride), row) };
            target.copy_from_slice(&bytes[y * row..(y + 1) * row]);
        }
    }
    unsafe {
        CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags(0));
    }
    ok.then_some(buffer)
}

/// Vision person segmentation, one stateful request per camera session.
pub(crate) struct VisionSegmenter {
    request: Retained<AnyObject>,
    upload: Option<BufferPool>,
}

// SAFETY: the request is only used by the stage's worker thread that owns it.
unsafe impl Send for VisionSegmenter {}

impl VisionSegmenter {
    pub(crate) fn new() -> Result<Self, String> {
        let unavailable = || "Background effects need macOS 12 or later.".to_string();
        let class =
            AnyClass::get(c"VNGeneratePersonSegmentationRequest").ok_or_else(unavailable)?;
        AnyClass::get(c"VNImageRequestHandler").ok_or_else(unavailable)?;
        let request: Retained<AnyObject> = unsafe { msg_send![class, new] };
        unsafe {
            let _: () = msg_send![&*request, setQualityLevel: VISION_QUALITY_BALANCED];
            let _: () =
                msg_send![&*request, setOutputPixelFormat: kCVPixelFormatType_OneComponent8];
        }
        Ok(Self {
            request,
            upload: None,
        })
    }

    fn perform(&self, pixel_buffer: &CVPixelBuffer) -> Result<Matte, String> {
        autoreleasepool(|_| {
            let class = AnyClass::get(c"VNImageRequestHandler")
                .ok_or_else(|| "Vision has no image request handler.".to_string())?;
            let options = NSDictionary::<NSString, AnyObject>::new();
            let handler: Retained<AnyObject> = unsafe {
                let allocated: Allocated<AnyObject> = msg_send![class, alloc];
                msg_send![allocated, initWithCVPixelBuffer: pixel_buffer, options: &*options]
            };
            let requests = NSArray::from_retained_slice(&[self.request.clone()]);
            let performed: Result<(), Retained<NSError>> =
                unsafe { msg_send![&*handler, performRequests: &*requests, error: _] };
            performed.map_err(|error| {
                format!(
                    "Person segmentation failed: {}",
                    error.localizedDescription()
                )
            })?;
            let results: Option<Retained<NSArray<AnyObject>>> =
                unsafe { msg_send![&*self.request, results] };
            let observation = results
                .and_then(|results| results.firstObject())
                .ok_or_else(|| "Person segmentation returned no matte.".to_string())?;
            let matte: *mut CVPixelBuffer = unsafe { msg_send![&*observation, pixelBuffer] };
            let matte = unsafe { matte.as_ref() }
                .ok_or_else(|| "Person segmentation returned no matte buffer.".to_string())?;
            if CVPixelBufferGetPixelFormatType(matte) != kCVPixelFormatType_OneComponent8 {
                return Err("Person segmentation returned an unexpected matte format.".to_string());
            }
            let width = CVPixelBufferGetWidth(matte) as u32;
            let height = CVPixelBufferGetHeight(matte) as u32;
            let values = read_plane(matte, 1)
                .ok_or_else(|| "Person segmentation's matte could not be read.".to_string())?;
            Ok(Matte {
                width,
                height,
                values,
            })
        })
    }
}

impl PersonSegmenter for VisionSegmenter {
    fn segment(&mut self, frame: &EffectFrame) -> Result<Matte, String> {
        match &frame.pixels {
            EffectPixels::PixelBuffer(buffer) => self.perform(buffer.pixel_buffer()),
            EffectPixels::Bytes(bytes) => {
                let buffer = upload_to_pool(
                    &mut self.upload,
                    bytes,
                    frame.width as usize,
                    frame.height as usize,
                )
                .ok_or_else(|| "The camera frame could not reach Vision.".to_string())?;
                self.perform(&buffer)
            }
        }
    }
}

struct Picture {
    texture: Retained<Texture>,
    width: f32,
    height: f32,
}

/// The Metal pass. One per camera session, on its own command queue.
pub(crate) struct MetalEffectRenderer {
    device: Retained<Device>,
    queue: Retained<Queue>,
    down: Retained<ComputePipeline>,
    blur: Retained<ComputePipeline>,
    compose: Retained<RenderPipeline>,
    output_pool: Option<BufferPool>,
    staging: Option<Retained<Texture>>,
    quarter: Option<[Retained<Texture>; 2]>,
    matte: Option<Retained<Texture>>,
    blank: Retained<Texture>,
    pictures: HashMap<PathBuf, Option<Picture>>,
}

// SAFETY: Metal devices, queues, pipelines and textures may be used from any
// thread; the stage keeps the renderer behind a mutex, one pass at a time.
unsafe impl Send for MetalEffectRenderer {}

impl MetalEffectRenderer {
    pub(crate) fn new() -> Result<Self, String> {
        let unavailable =
            |what: &str| format!("Background effects need Metal on this Mac ({what}).");
        let device = MTLCreateSystemDefaultDevice().ok_or_else(|| unavailable("no device"))?;
        let queue = device
            .newCommandQueue()
            .ok_or_else(|| unavailable("no command queue"))?;
        let library = device
            .newLibraryWithSource_options_error(&NSString::from_str(SHADER_SOURCE), None)
            .map_err(|error| unavailable(&error.localizedDescription().to_string()))?;
        let function = |name: &str| {
            library
                .newFunctionWithName(&NSString::from_str(name))
                .ok_or_else(|| unavailable(name))
        };
        let (k_down, k_blur) = (function("k_down")?, function("k_blur")?);
        let (v_full, f_compose) = (function("v_full")?, function("f_compose")?);
        let down = device
            .newComputePipelineStateWithFunction_error(&k_down)
            .map_err(|_| unavailable("k_down"))?;
        let blur = device
            .newComputePipelineStateWithFunction_error(&k_blur)
            .map_err(|_| unavailable("k_blur"))?;
        let descriptor = MTLRenderPipelineDescriptor::new();
        descriptor.setVertexFunction(Some(&v_full));
        descriptor.setFragmentFunction(Some(&f_compose));
        unsafe { descriptor.colorAttachments().objectAtIndexedSubscript(0) }
            .setPixelFormat(MTLPixelFormat::BGRA8Unorm);
        let compose = device
            .newRenderPipelineStateWithDescriptor_error(&descriptor)
            .map_err(|_| unavailable("f_compose"))?;
        let blank = make_texture(
            &device,
            1,
            1,
            MTLPixelFormat::RGBA8Unorm,
            MTLTextureUsage::ShaderRead,
            MTLStorageMode::Shared,
        )
        .ok_or_else(|| unavailable("textures"))?;
        upload(&blank, &[0, 0, 0, 0], 1, 1, 4);
        Ok(Self {
            device,
            queue,
            down,
            blur,
            compose,
            output_pool: None,
            staging: None,
            quarter: None,
            matte: None,
            blank,
            pictures: HashMap::new(),
        })
    }

    /// The camera frame as a texture: its own IOSurface when it has one,
    /// else uploaded.
    fn source_texture(&mut self, frame: &EffectFrame) -> Result<Retained<Texture>, String> {
        let (width, height) = (frame.width as usize, frame.height as usize);
        match &frame.pixels {
            EffectPixels::PixelBuffer(buffer) => {
                let pixel_buffer = buffer.pixel_buffer();
                if let Some(surface) = CVPixelBufferGetIOSurface(Some(pixel_buffer)) {
                    let descriptor = texture_descriptor(
                        MTLPixelFormat::BGRA8Unorm,
                        surface.width(),
                        surface.height(),
                        MTLTextureUsage::ShaderRead,
                        MTLStorageMode::Shared,
                    );
                    if let Some(texture) = self.device.newTextureWithDescriptor_iosurface_plane(
                        &descriptor,
                        &surface,
                        0,
                    ) {
                        return Ok(texture);
                    }
                }
                let bytes = read_bgra(pixel_buffer)
                    .ok_or_else(|| "The camera frame could not be read.".to_string())?;
                self.upload_staging(&bytes, width, height)
            }
            EffectPixels::Bytes(bytes) => self.upload_staging(bytes, width, height),
        }
    }

    fn upload_staging(
        &mut self,
        bytes: &[u8],
        width: usize,
        height: usize,
    ) -> Result<Retained<Texture>, String> {
        if bytes.len() != width * height * 4 {
            return Err("The camera frame has the wrong size.".to_string());
        }
        if self
            .staging
            .as_ref()
            .is_none_or(|texture| texture.width() != width || texture.height() != height)
        {
            self.staging = make_texture(
                &self.device,
                width,
                height,
                MTLPixelFormat::BGRA8Unorm,
                MTLTextureUsage::ShaderRead,
                MTLStorageMode::Shared,
            );
        }
        let texture = self
            .staging
            .clone()
            .ok_or_else(|| "No camera texture.".to_string())?;
        upload(&texture, bytes, width, height, 4);
        Ok(texture)
    }

    fn quarter_textures(&mut self, width: usize, height: usize) -> Option<[Retained<Texture>; 2]> {
        let (qw, qh) = (width.div_ceil(4).max(1), height.div_ceil(4).max(1));
        if self
            .quarter
            .as_ref()
            .is_none_or(|textures| textures[0].width() != qw || textures[0].height() != qh)
        {
            let make = || {
                make_texture(
                    &self.device,
                    qw,
                    qh,
                    MTLPixelFormat::RGBA16Float,
                    MTLTextureUsage::ShaderRead | MTLTextureUsage::ShaderWrite,
                    MTLStorageMode::Private,
                )
            };
            self.quarter = Some([make()?, make()?]);
        }
        self.quarter.clone()
    }

    fn matte_texture(&mut self, matte: &Matte) -> Option<Retained<Texture>> {
        let (width, height) = (matte.width as usize, matte.height as usize);
        if self
            .matte
            .as_ref()
            .is_none_or(|texture| texture.width() != width || texture.height() != height)
        {
            self.matte = make_texture(
                &self.device,
                width,
                height,
                MTLPixelFormat::R8Unorm,
                MTLTextureUsage::ShaderRead,
                MTLStorageMode::Shared,
            );
        }
        let texture = self.matte.clone()?;
        upload(&texture, &matte.values, width, height, 1);
        Some(texture)
    }

    /// The picture at `path`, decoded once (at most [`MAX_PICTURE_SIDE`]).
    fn picture(&mut self, path: &Path) -> Option<(Retained<Texture>, f32, f32)> {
        if !self.pictures.contains_key(path) {
            let loaded = load_picture(&self.device, path)
                .map_err(|error| tracing::warn!("Camera background picture: {error}"))
                .ok();
            self.pictures.insert(path.to_path_buf(), loaded);
        }
        self.pictures
            .get(path)?
            .as_ref()
            .map(|picture| (picture.texture.clone(), picture.width, picture.height))
    }

    fn draw(
        &mut self,
        frame: &EffectFrame,
        matte: Option<&Matte>,
        look: &EffectLook,
    ) -> Result<EffectOutput, String> {
        let (width, height) = (frame.width as usize, frame.height as usize);
        if width == 0 || height == 0 {
            return Err("The camera frame is empty.".to_string());
        }
        let cover = matte.is_none();
        let source = self.source_texture(frame)?;
        let matte_texture = match matte {
            Some(matte) => Some(
                self.matte_texture(matte)
                    .ok_or_else(|| "No matte texture.".to_string())?,
            ),
            None => None,
        };
        let mut picture = None;
        let (mode, radius) = match &look.kind {
            EffectKind::Blur { pct } => (
                0u32,
                if cover {
                    cover_blur_radius_px(frame.height)
                } else {
                    blur_radius_px(*pct, frame.height)
                },
            ),
            EffectKind::Image { path, .. } => {
                picture = path.as_deref().and_then(|path| self.picture(path));
                (if picture.is_some() { 1 } else { 2 }, 0.0)
            }
            EffectKind::Pending => (2, 0.0),
        };
        if self
            .output_pool
            .as_ref()
            .is_none_or(|pool| pool.width != width || pool.height != height)
        {
            self.output_pool = BufferPool::new(width, height, kCVPixelFormatType_32BGRA);
        }
        let output = self
            .output_pool
            .as_ref()
            .and_then(BufferPool::take)
            .ok_or_else(|| "No output buffer for the background effect.".to_string())?;
        let surface = CVPixelBufferGetIOSurface(Some(&output))
            .ok_or_else(|| "The output buffer has no IOSurface.".to_string())?;
        let target = self
            .device
            .newTextureWithDescriptor_iosurface_plane(
                &texture_descriptor(
                    MTLPixelFormat::BGRA8Unorm,
                    width,
                    height,
                    MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead,
                    MTLStorageMode::Shared,
                ),
                &surface,
                0,
            )
            .ok_or_else(|| "The output texture could not be made.".to_string())?;

        let command_buffer = self
            .queue
            .commandBuffer()
            .ok_or_else(|| "No command buffer.".to_string())?;
        let mut blurred = None;
        if mode == 0 {
            let quarter = self
                .quarter_textures(width, height)
                .ok_or_else(|| "No blur textures.".to_string())?;
            let encoder = command_buffer
                .computeCommandEncoder()
                .ok_or_else(|| "No compute encoder.".to_string())?;
            let down = DownParams {
                weighted: u32::from(!cover),
                pad: [0; 3],
            };
            encoder.setComputePipelineState(&self.down);
            unsafe {
                encoder.setTexture_atIndex(Some(&source), 0);
                encoder
                    .setTexture_atIndex(Some(matte_texture.as_deref().unwrap_or(&self.blank)), 1);
                encoder.setTexture_atIndex(Some(&quarter[0]), 2);
                set_compute_bytes(&*encoder, &down);
            }
            dispatch(&*encoder, quarter[0].width(), quarter[0].height());
            let quarter_radius = radius / 4.0;
            let sigma = (quarter_radius / 2.0).max(0.5);
            let taps = (sigma * 3.0).ceil() as i32;
            encoder.setComputePipelineState(&self.blur);
            for (input, output, dir) in [(0usize, 1usize, (1, 0)), (1, 0, (0, 1))] {
                let params = BlurParams {
                    radius: taps,
                    sigma,
                    dir_x: dir.0,
                    dir_y: dir.1,
                };
                unsafe {
                    encoder.setTexture_atIndex(Some(&quarter[input]), 0);
                    encoder.setTexture_atIndex(Some(&quarter[output]), 1);
                    set_compute_bytes(&*encoder, &params);
                }
                dispatch(&*encoder, quarter[0].width(), quarter[0].height());
            }
            encoder.endEncoding();
            blurred = Some(quarter[0].clone());
        }

        let (image_texture, image_xform) = match &picture {
            Some((texture, picture_width, picture_height)) => {
                let mirror = matches!(look.kind, EffectKind::Image { mirror: true, .. });
                (
                    Some(texture.clone()),
                    cover_fit_xform(
                        width as f32,
                        height as f32,
                        *picture_width,
                        *picture_height,
                        mirror,
                    ),
                )
            }
            None => (None, [1.0, 1.0, 0.0, 0.0]),
        };
        let neutral = [
            f32::from(NEUTRAL_GROUND_BGRA[2]) / 255.0,
            f32::from(NEUTRAL_GROUND_BGRA[1]) / 255.0,
            f32::from(NEUTRAL_GROUND_BGRA[0]) / 255.0,
            1.0,
        ];
        let params = ComposeParams {
            image_xform,
            neutral,
            matte_texel: matte.map_or([0.0, 0.0], |matte| {
                [
                    1.0 / matte.width.max(1) as f32,
                    1.0 / matte.height.max(1) as f32,
                ]
            }),
            mode,
            cover: u32::from(cover),
            edge_lo: EDGE_LO,
            edge_hi: EDGE_HI,
            pad: [0.0; 2],
        };
        let pass = MTLRenderPassDescriptor::new();
        let attachment = unsafe { pass.colorAttachments().objectAtIndexedSubscript(0) };
        attachment.setTexture(Some(&target));
        attachment.setLoadAction(MTLLoadAction::DontCare);
        attachment.setStoreAction(MTLStoreAction::Store);
        let encoder = command_buffer
            .renderCommandEncoderWithDescriptor(&pass)
            .ok_or_else(|| "No render encoder.".to_string())?;
        encoder.setRenderPipelineState(&self.compose);
        unsafe {
            encoder.setFragmentTexture_atIndex(Some(&source), 0);
            encoder.setFragmentTexture_atIndex(Some(blurred.as_deref().unwrap_or(&self.blank)), 1);
            encoder.setFragmentTexture_atIndex(
                Some(matte_texture.as_deref().unwrap_or(&self.blank)),
                2,
            );
            encoder.setFragmentTexture_atIndex(
                Some(image_texture.as_deref().unwrap_or(&self.blank)),
                3,
            );
            encoder.setFragmentBytes_length_atIndex(
                NonNull::from(&params).cast::<c_void>(),
                std::mem::size_of::<ComposeParams>(),
                0,
            );
            encoder.drawPrimitives_vertexStart_vertexCount(MTLPrimitiveType::Triangle, 0, 3);
        }
        encoder.endEncoding();
        command_buffer.commit();
        command_buffer.waitUntilCompleted();
        if command_buffer.error().is_some() {
            return Err("The background effect's GPU pass failed.".to_string());
        }
        let gpu_ms = (command_buffer.GPUEndTime() - command_buffer.GPUStartTime()) * 1000.0;
        drop(target);
        Ok(EffectOutput {
            width: frame.width,
            height: frame.height,
            bytes: Vec::new(),
            pixel_buffer: Some(RetainedPixelBuffer::new(output)),
            gpu_ms: (gpu_ms.is_finite() && gpu_ms >= 0.0).then_some(gpu_ms),
        })
    }
}

impl EffectRenderer for MetalEffectRenderer {
    fn processed(
        &mut self,
        frame: &EffectFrame,
        matte: &Matte,
        look: &EffectLook,
    ) -> Result<EffectOutput, String> {
        self.draw(frame, Some(matte), look)
    }

    fn cover(&mut self, frame: &EffectFrame, look: &EffectLook) -> Result<EffectOutput, String> {
        self.draw(frame, None, look)
    }
}

/// Fill the camera frame with the picture (cover fit, centred); `mirror`
/// pre-mirrors it so the camera's own mirror leaves it the right way round.
fn cover_fit_xform(
    frame_width: f32,
    frame_height: f32,
    picture_width: f32,
    picture_height: f32,
    mirror: bool,
) -> [f32; 4] {
    let scale = (frame_width / picture_width.max(1.0)).max(frame_height / picture_height.max(1.0));
    let sx = frame_width / (picture_width * scale);
    let sy = frame_height / (picture_height * scale);
    let (ox, oy) = ((1.0 - sx) / 2.0, (1.0 - sy) / 2.0);
    if mirror {
        [-sx, sy, 1.0 - ox, oy]
    } else {
        [sx, sy, ox, oy]
    }
}

fn load_picture(device: &Device, path: &Path) -> Result<Picture, String> {
    crate::resource_authority::validate_managed_background_path(path)
        .map_err(|error| error.to_string())?;
    let image = image::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let image = if image.width().max(image.height()) > MAX_PICTURE_SIDE {
        image.resize(
            MAX_PICTURE_SIDE,
            MAX_PICTURE_SIDE,
            image::imageops::FilterType::Triangle,
        )
    } else {
        image
    };
    let rgba = image.to_rgba8();
    let (width, height) = (rgba.width() as usize, rgba.height() as usize);
    let texture = make_texture(
        device,
        width,
        height,
        MTLPixelFormat::RGBA8Unorm,
        MTLTextureUsage::ShaderRead,
        MTLStorageMode::Shared,
    )
    .ok_or_else(|| "No picture texture.".to_string())?;
    upload(&texture, rgba.as_raw(), width, height, 4);
    Ok(Picture {
        texture,
        width: width as f32,
        height: height as f32,
    })
}

fn texture_descriptor(
    format: MTLPixelFormat,
    width: usize,
    height: usize,
    usage: MTLTextureUsage,
    storage: MTLStorageMode,
) -> Retained<MTLTextureDescriptor> {
    let descriptor = unsafe {
        MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
            format, width, height, false,
        )
    };
    descriptor.setUsage(usage);
    descriptor.setStorageMode(storage);
    descriptor
}

fn make_texture(
    device: &Device,
    width: usize,
    height: usize,
    format: MTLPixelFormat,
    usage: MTLTextureUsage,
    storage: MTLStorageMode,
) -> Option<Retained<Texture>> {
    device.newTextureWithDescriptor(&texture_descriptor(format, width, height, usage, storage))
}

fn upload(texture: &Texture, bytes: &[u8], width: usize, height: usize, bytes_per_pixel: usize) {
    if bytes.len() < width * height * bytes_per_pixel {
        return;
    }
    let Some(pointer) = NonNull::new(bytes.as_ptr() as *mut c_void) else {
        return;
    };
    let region = MTLRegion {
        origin: MTLOrigin { x: 0, y: 0, z: 0 },
        size: MTLSize {
            width,
            height,
            depth: 1,
        },
    };
    unsafe {
        texture.replaceRegion_mipmapLevel_withBytes_bytesPerRow(
            region,
            0,
            pointer,
            width * bytes_per_pixel,
        );
    }
}

unsafe fn set_compute_bytes<T>(encoder: &ProtocolObject<dyn MTLComputeCommandEncoder>, value: &T) {
    unsafe {
        encoder.setBytes_length_atIndex(
            NonNull::from(value).cast::<c_void>(),
            std::mem::size_of::<T>(),
            0,
        );
    }
}

fn dispatch(encoder: &ProtocolObject<dyn MTLComputeCommandEncoder>, width: usize, height: usize) {
    encoder.dispatchThreadgroups_threadsPerThreadgroup(
        MTLSize {
            width: width.div_ceil(8),
            height: height.div_ceil(8),
            depth: 1,
        },
        MTLSize {
            width: 8,
            height: 8,
            depth: 1,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::CameraBackgroundMode;

    fn checker_frame(width: u32, height: u32, cell: u32) -> EffectFrame {
        let mut bytes = vec![0u8; (width * height * 4) as usize];
        for y in 0..height {
            for x in 0..width {
                let on = (x / cell + y / cell) % 2 == 0;
                let i = ((y * width + x) * 4) as usize;
                bytes[i..i + 4].copy_from_slice(if on {
                    &[255, 0, 255, 255]
                } else {
                    &[255, 255, 0, 255]
                });
            }
        }
        EffectFrame {
            width,
            height,
            pixels: EffectPixels::Bytes(bytes),
        }
    }

    fn blur_look() -> EffectLook {
        EffectLook {
            mode: CameraBackgroundMode::Blur,
            kind: EffectKind::Blur { pct: 70 },
        }
    }

    fn output_bytes(output: &EffectOutput) -> Vec<u8> {
        read_bgra(output.pixel_buffer.as_ref().unwrap().pixel_buffer()).unwrap()
    }

    /// Local energy of the checker: how far neighbours differ.
    fn checker_energy(
        bytes: &[u8],
        width: usize,
        x0: usize,
        x1: usize,
        y0: usize,
        y1: usize,
    ) -> f64 {
        let mut total = 0.0;
        let mut count = 0.0;
        for y in y0..y1 {
            for x in x0..x1 - 1 {
                let a = (y * width + x) * 4;
                let b = a + 4;
                total += (f64::from(bytes[a + 1]) - f64::from(bytes[b + 1])).abs();
                count += 1.0;
            }
        }
        total / count
    }

    #[test]
    fn the_metal_cover_and_blur_leave_no_room_pattern() {
        let Ok(mut renderer) = MetalEffectRenderer::new() else {
            eprintln!("no Metal device: skipped");
            return;
        };
        let (w, h) = (640u32, 360u32);
        let frame = checker_frame(w, h, 6);
        let raw = match &frame.pixels {
            EffectPixels::Bytes(bytes) => bytes.clone(),
            EffectPixels::PixelBuffer(_) => unreachable!(),
        };
        let raw_energy = checker_energy(&raw, w as usize, 0, w as usize, 0, h as usize);
        assert!(raw_energy > 40.0, "{raw_energy}");

        let cover = renderer.cover(&frame, &blur_look()).unwrap();
        assert!(cover.gpu_ms.is_some());
        let bytes = output_bytes(&cover);
        let energy = checker_energy(&bytes, w as usize, 0, w as usize, 0, h as usize);
        assert!(energy < 1.5, "the cover keeps the room readable: {energy}");

        // A matte with the person in the middle third: the room outside is
        // blurred away, the person's pixels are the camera's.
        let mut values = vec![0u8; 48 * 36];
        for y in 0..36 {
            for x in 16..32 {
                values[y * 48 + x] = 255;
            }
        }
        let matte = Matte {
            width: 48,
            height: 36,
            values,
        };
        let processed = renderer.processed(&frame, &matte, &blur_look()).unwrap();
        let bytes = output_bytes(&processed);
        let room = checker_energy(&bytes, w as usize, 0, (w / 4) as usize, 0, h as usize);
        assert!(
            room < 2.0,
            "the room is still readable beside the person: {room}"
        );
        let person = checker_energy(
            &bytes,
            w as usize,
            (w * 4 / 9) as usize,
            (w * 5 / 9) as usize,
            0,
            h as usize,
        );
        assert!(
            person > raw_energy * 0.8,
            "the person is not the camera: {person}"
        );
    }

    #[test]
    fn a_picture_fills_the_frame_and_the_cover_shows_it_alone() {
        let Ok(mut renderer) = MetalEffectRenderer::new() else {
            eprintln!("no Metal device: skipped");
            return;
        };
        let dir = crate::test_temp_dir::TestTempDir::new("camera-effect-picture");
        let path = dir.join("red.png");
        image::RgbaImage::from_pixel(64, 48, image::Rgba([220, 20, 30, 255]))
            .save(&path)
            .unwrap();
        let look = EffectLook {
            mode: CameraBackgroundMode::Image,
            kind: EffectKind::Image {
                asset_id: "test".to_string(),
                path: Some(path),
                mirror: false,
            },
        };
        let frame = checker_frame(320, 180, 4);
        let bytes = output_bytes(&renderer.cover(&frame, &look).unwrap());
        for pixel in bytes.chunks_exact(4).step_by(97) {
            assert!(
                pixel[2] > 200 && pixel[1] < 40 && pixel[0] < 50,
                "{pixel:?}"
            );
        }
        // A picture that does not load: the neutral ground, never the room.
        let missing = EffectLook {
            mode: CameraBackgroundMode::Image,
            kind: EffectKind::Image {
                asset_id: "missing".to_string(),
                path: Some(PathBuf::from("/nonexistent/picture.png")),
                mirror: false,
            },
        };
        let bytes = output_bytes(&renderer.cover(&frame, &missing).unwrap());
        for pixel in bytes.chunks_exact(4).step_by(89) {
            for c in 0..3 {
                assert!(
                    (i32::from(pixel[c]) - i32::from(NEUTRAL_GROUND_BGRA[c])).abs() <= 2,
                    "{pixel:?}"
                );
            }
        }
    }

    #[test]
    fn cover_fit_fills_and_mirrors() {
        // A square picture on a 16:9 frame: full width, cropped top and bottom.
        let [sx, sy, ox, oy] = cover_fit_xform(1600.0, 900.0, 1000.0, 1000.0, false);
        assert!((sx - 1.0).abs() < 1e-6);
        assert!((sy - 0.5625).abs() < 1e-6);
        assert!(ox.abs() < 1e-6);
        assert!((oy - 0.21875).abs() < 1e-6);
        let [mx, _, mox, _] = cover_fit_xform(1600.0, 900.0, 1000.0, 1000.0, true);
        // uv 0 maps to the picture's right edge, uv 1 to its left.
        assert!((mox - 1.0).abs() < 1e-6);
        assert!((mox + mx).abs() < 1e-6);
    }

    #[test]
    fn vision_segments_a_frame_when_this_mac_has_it() {
        let Ok(mut segmenter) = VisionSegmenter::new() else {
            eprintln!("no Vision person segmentation: skipped");
            return;
        };
        let frame = checker_frame(640, 480, 8);
        let matte = segmenter.segment(&frame).expect("Vision answers");
        assert!(matte.width > 0 && matte.height > 0);
        assert_eq!(matte.values.len(), (matte.width * matte.height) as usize);
    }
}
