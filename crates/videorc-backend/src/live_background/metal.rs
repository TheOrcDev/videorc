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
//! and the tick's missed-deadline flag from the render loop. Full → Half
//! re-renders at half the internal size; Still shows the poster with reason
//! `gpu-budget`.

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
/// toolchain; `metal_compositor.rs` does the same for the scene shader).
pub const LIVE_BACKGROUND_MSL: &str = r#"
#include <metal_stdlib>
using namespace metal;

// Live backgrounds (plans 190 and 194). Every pass reads the same sixteen
// float4s (live_background/mod.rs, UNIFORM_VEC4_COUNT; the block is sent at
// its full size): u[0] = (target w, h, phase, pixel scale),
// u[1] = (view w, h, dim, 0), u[2..16] = the look's constants. GLSL's
// gl_FragCoord is bottom-left and Metal's position is top-left: gl_frag flips
// y, and a scratch texture written by one pass is read by the next with 1 - v.

struct LiveVOut { float4 pos [[position]]; };

vertex LiveVOut live_vertex(uint vid [[vertex_id]]) {
  const float2 corners[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
  LiveVOut out;
  out.pos = float4(corners[vid], 0.0, 1.0);
  return out;
}

inline float2 gl_frag(float4 pos, float height) { return float2(pos.x, height - pos.y); }
inline float gl_mod(float x, float y) { return x - y * floor(x / y); }
inline float2 gl_mod2(float2 x, float y) { return x - y * floor(x / y); }
inline float3 gl_mod3(float3 x, float y) { return x - y * floor(x / y); }
inline float4 gl_mod4(float4 x, float y) { return x - y * floor(x / y); }
inline float sq(float x) { return x * x; }
// The classic hash12 (Ferrofluid's field and Ghost Fibers' grain).
inline float hash12(float2 p) {
  float3 p3 = fract(float3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
inline float hash21(float2 p) {
  p = fract(p * float2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
inline float value_noise(float2 p) {
  float2 i = floor(p);
  float2 f = p - i;
  float2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash21(i);
  float b = hash21(i + float2(1.0, 0.0));
  float c = hash21(i + float2(0.0, 1.0));
  float d = hash21(i + float2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}
inline float dither(float2 frag) {
  return (fract(52.9829189 * fract(dot(frag, float2(0.06711056, 0.00583715)))) - 0.5) / 255.0;
}

// ---------------------------------------------------------------- Silk
// Ported from React Bits by David Haz (https://reactbits.dev), used with permission (plan 190).
constant float SILK_E = 2.71828182845904523536;

inline float silk_noise(float2 texCoord) {
  float G = SILK_E;
  float2 r = (G * sin(G * texCoord));
  return fract(r.x * r.y * (1.0 + texCoord.x));
}

inline float2 silk_rotate(float2 uv, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  float2x2 rot = float2x2(float2(c, -s), float2(s, c));
  return rot * uv;
}

inline float silk_pattern(float2 vUv, constant float4* u) {
  float scale = u[2].x;
  float2 uv = silk_rotate(vUv * scale, u[2].y);
  float2 tex = uv * scale + u[3].yz;
  float tOffset = u[0].z;
  tex.y += 0.03 * u[2].z * sin(8.0 * tex.x - tOffset);
  return 0.6 + 0.4 * u[3].x * sin(5.0 * (tex.x + tex.y + cos(3.0 * tex.x + 5.0 * tex.y) + 0.02 * tOffset) + u[2].w * sin(20.0 * (tex.x + tex.y - 0.1 * tOffset)));
}

fragment float4 silk_field(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]]) {
  float2 vUv = gl_frag(in.pos, u[0].y) / u[0].xy;
  float n = clamp((silk_pattern(vUv, u) - 0.2) / 0.8, 0.0, 1.0);
  return float4(pow(n, 6.0), 0.0, 0.0, 1.0);
}

inline float3 silk_soft_clip(float3 c) {
  float3 over = max(c - 0.75, float3(0.0));
  return min(c, float3(0.75)) + 0.25 * (1.0 - exp(-over * 4.0));
}

fragment float4 silk_composite(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]],
                               texture2d<float> t0 [[texture(0)]], sampler smp [[sampler(0)]]) {
  float2 frag = gl_frag(in.pos, u[0].y);
  float2 vUv = frag / u[0].xy;
  float pattern = silk_pattern(vUv, u);
  float rnd = silk_noise(frag);
  float n = clamp((pattern - 0.2) / 0.8, 0.0, 1.0);

  float2 stepUv = u[0].w / u[1].xy;
  float gx = silk_pattern(vUv + float2(stepUv.x, 0.0), u) - pattern;
  float gy = silk_pattern(vUv + float2(0.0, stepUv.y), u) - pattern;
  float3 normal = normalize(float3(-gx * 26.0, -gy * 26.0, 1.0));
  float3 toLight = normalize(float3(u[6].yz, 0.85));
  float depth = u[4].w;
  float relief = 1.0 + (dot(normal, toLight) - toLight.z) * 1.8 * depth;
  float3 halfway = normalize(toLight + float3(0.0, 0.0, 1.0));
  float gloss = pow(max(dot(normal, halfway), 0.0), 48.0) * smoothstep(0.25, 0.85, n);
  float crest = pow(n, 5.0);
  float sheen = u[5].w;
  float shine = (gloss * 0.85 + crest * 0.4) * sheen * (1.0 + u[6].w * 0.6);

  float glow = u[6].x;
  float bloom = 0.0;
  if (glow > 0.0) {
    float2 fieldUv = float2(vUv.x, 1.0 - vUv.y);
    bloom += t0.sample(smp, fieldUv, level(1.0)).r * 0.35;
    bloom += t0.sample(smp, fieldUv, level(2.0)).r * 0.3;
    bloom += t0.sample(smp, fieldUv, level(3.0)).r * 0.2;
    bloom += t0.sample(smp, fieldUv, level(4.0)).r * 0.15;
  }

  float3 color = u[4].rgb;
  float grain = rnd / 15.0 * u[3].w;
  float floorValue = mix(0.2, 0.03, depth);
  float curve = depth > 0.0 ? pow(n, 1.0 + 1.4 * depth) : n;
  float shade = depth > 0.0 ? floorValue + (1.0 - floorValue) * curve : pattern;
  float3 tone = mix(color, pow(color, float3(1.45)), (1.0 - n) * depth);
  float3 lit = tone * shade * relief - float3(grain);
  float3 tint = mix(color, u[5].rgb, 0.8);
  float3 extra = tint * (shine + bloom * glow * 0.55);
  float blend = clamp((sheen + glow) * 4.0, 0.0, 1.0);
  float3 result = mix(clamp(lit, 0.0, 1.0), clamp(silk_soft_clip(lit + extra), 0.0, 1.0), blend);
  return float4(result * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Side Rays
// Ported from React Bits by David Haz (https://reactbits.dev), used with permission (plan 190).
inline float rays_shafts(float x, float t, float seed, float aa, constant float4* u) {
  float sway = (0.4 * sin(t * 0.31 + seed) + 0.24 * sin(t * 0.17 + seed * 2.3)) * u[7].w;
  float n = 0.7 * value_noise(float2(x + sway + seed, t * 0.3)) + 0.3 * value_noise(float2(x * 2.4 + sway * 1.5 + seed * 1.7, t * 0.45 + 3.0));
  float width = mix(0.5, 0.1, u[4].z);
  float s = mix(smoothstep(0.5 - width, 0.5 + width, n), 0.5, aa);
  return mix(0.05, 1.0, s);
}

inline float rays_motes(float2 p, float cell, float t, float seed) {
  p += float2(t * 0.021, -t * 0.013) + seed * 7.31;
  float2 grid = p / cell;
  float2 id = floor(grid);
  float2 f = grid - id;
  float h = hash21(id + seed);
  if (h > 0.5) return 0.0;
  float2 center = 0.25 + 0.5 * float2(hash21(id + 1.7 + seed), hash21(id + 3.1 + seed));
  center += 0.1 * float2(sin(t * 0.7 + h * 31.0), cos(t * 0.6 + h * 23.0));
  float size = mix(0.035, 0.09, hash21(id + 5.3 + seed));
  float edge = length(fwidth(grid)) * 0.7;
  float twinkle = 0.55 + 0.45 * sin(t * 1.9 + h * 41.0);
  return (1.0 - smoothstep(size - edge, size + edge, length(f - center))) * twinkle;
}

fragment float4 side_rays_main(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]]) {
  float2 res = u[0].xy;
  float2 frag = gl_frag(in.pos, res.y);
  float aspect = res.x / res.y;
  float2 q = (frag - 0.5 * res) / res.y;
  if (u[6].x > 0.5) q.x = -q.x;
  if (u[6].y > 0.5) q.y = -q.y;
  float2 source = u[6].z > 0.5 ? float2(aspect * 0.5 + 0.42, 0.3) : float2(aspect * 0.5 + 0.1, 0.62);
  float t = u[0].z;
  float swayAmount = u[7].w;
  float heading = (u[6].z > 0.5 ? 3.42 : -2.48) + u[6].w + 0.035 * sin(t * 0.21) * swayAmount;
  float2 v = q - source;
  float r = length(v);
  float angle = gl_mod(atan2(v.y, v.x) - heading + 3.14159265, 6.28318531) - 3.14159265;
  float spread = u[4].x;
  float x = angle * u[4].y;
  float aa = smoothstep(0.12, 0.45, fwidth(x));
  float offset = spread * 0.22;
  float fanA = exp(-sq((angle + offset) / spread) * 1.4);
  float fanB = exp(-sq((angle - offset) / (spread * 1.15)) * 1.4);
  float focus = 1.0 + u[7].z * exp(-sq((angle - u[7].x) / u[7].y));
  float lightA = fanA * rays_shafts(x, t, 0.0, aa, u) * focus;
  float lightB = fanB * rays_shafts(x * 0.83, t * 0.6, 17.0, aa, u) * focus;
  float reach = 1.0 / (1.0 + pow(r / 0.4, u[4].w));
  float blend = u[2].w;
  float3 colorA = u[2].rgb;
  float3 colorB = u[3].rgb;
  float3 glowColor = mix(colorA, colorB, blend);
  float3 light = (colorA * lightA * (1.0 - blend) + colorB * lightB * blend) * 2.0 * reach;
  light += glowColor * u[5].x * exp(-sq(r / 0.4));
  float dust = u[5].z;
  if (dust > 0.0) {
    float sparkle = rays_motes(q, 0.06, t, 0.0) + 0.7 * rays_motes(q, 0.038, t * 0.8, 9.0);
    light += mix(glowColor, float3(1.0), 0.6) * sparkle * (lightA + lightB) * reach * dust * 2.5;
  }
  // The intro reveal is finished (React Bits' uReveal = 1).
  light *= u[3].w * (1.0 - smoothstep(2.15, 2.6, r));
  float gray = dot(light, float3(0.2126, 0.7152, 0.0722));
  light = max(mix(float3(gray), light, u[5].y), float3(0.0));
  float peak = max(light.r, max(light.g, light.b));
  float grain = dither(frag);
  float mapped = 1.0 - exp(-peak);
  float3 tone = light * (mapped / max(peak, 1e-4));
  tone = mix(tone, float3(mapped), smoothstep(0.7, 1.0, mapped) * 0.55);
  float3 shown = clamp(tone * u[5].w, 0.0, 1.0);
  float alpha = max(shown.r, max(shown.g, shown.b));
  float3 color = clamp(shown * alpha + grain, 0.0, 1.0);
  float3 premultiplied = min(color, float3(alpha));
  return float4((premultiplied + u[8].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Plasma Wave
// Ported from React Bits by David Haz (https://reactbits.dev), used with permission (plan 190).
constant float PLASMA_PI = 3.14159265;
constant float PLASMA_TAU = 6.28318531;
constant float PLASMA_HALF_PI = 1.5707963;

inline float4 plasma_trace(float2 pixel, constant float4* u) {
  float2 view = u[1].xy;
  float2 coord = pixel - 0.5 * view;
  float c = cos(u[2].x);
  float sn = sin(u[2].x);
  coord = float2x2(float2(c, -sn), float2(sn, c)) * coord;
  float3 dir = normalize(float3(coord / view.y, u[2].y));
  float3 o = float3(0.0, 0.0, -7.0);
  float t = u[0].z * PLASMA_PI;
  float t1 = t * 0.7;
  float t2 = t * 0.9;
  float tSpeed1 = t * u[2].z;
  float tSpeed2 = t * u[2].w * u[3].x;
  float bend1 = u[3].y;
  float bend2 = u[3].z;
  float thickness = u[3].w;
  float3 heat = u[7].xyz;
  float s = 1.0;
  float d = 0.0;
  float2 k = float2(0.0);
  for (int i = 0; i < 14; ++i) {
    float3 p = o + dir * d;
    p.x -= 15.0;
    float px = p.x;
    float heatOffset = (px - heat.x) / heat.z;
    float swell = heat.y * exp(-heatOffset * heatOffset);
    float wob1 = bend1 + swell * (0.16 + 0.2 * bend1) + sin(t1 + px * 0.8) * 0.1;
    float wob2 = bend2 + swell * (0.16 + 0.2 * bend2) + cos(t2 + px * 1.1) * 0.1;
    float2 a = sin(float2(px, px + PLASMA_HALF_PI) + tSpeed1) * wob1;
    float2 b = cos(float2(px, px + PLASMA_HALF_PI) + tSpeed2) * wob2;
    float cut = px + thickness;
    k.x = max(cut, length(p.yz - a) - thickness);
    k.y = max(cut, length(p.yz - b) - thickness);
    s = min(s, min(k.x, k.y));
    if (s < 0.001 || d > 300.0) break;
    d += s * 0.7;
  }
  float3 raw = max(cos(d * PLASMA_TAU) - s * sqrt(d) - float3(k, 0.0), float3(0.0));
  float field = max(raw.r, max(raw.g, raw.b));
  raw.gb += 0.1;
  raw = raw * 0.4 + raw.brg * 0.6 + raw * raw;
  float lum = dot(raw, float3(0.299, 0.587, 0.114));
  float w1 = max(0.0, 1.0 - k.x * 2.0) + 0.0001;
  float w2 = max(0.0, 1.0 - k.y * 2.0) + 0.0001;
  float3 base = (u[5].rgb * w1 + u[6].rgb * w2) / (w1 + w2);
  float soft = smoothstep(0.03, 0.36, field);
  float hot = smoothstep(0.32, 0.8, field);
  float3 light = base * lum * 2.6 * soft + mix(base, float3(1.0), 0.55) * hot * u[4].x * 2.0;
  return float4(light, field);
}

fragment float4 plasma_coarse(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]]) {
  float2 frag = gl_frag(in.pos, u[0].y);
  return plasma_trace(frag * (u[1].xy / u[0].xy), u);
}

inline float plasma_coarse_alpha(texture2d<float> t0, int2 cell, int2 last) {
  int2 q = clamp(cell, int2(0), last);
  return t0.read(uint2(q.x, last.y - q.y)).a;
}

fragment float4 plasma_fine(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]],
                            texture2d<float> t0 [[texture(0)]], sampler smp [[sampler(0)]]) {
  float2 coarseSize = float2(t0.get_width(), t0.get_height());
  float2 frag = gl_frag(in.pos, u[0].y);
  float2 uv = frag / u[0].xy;
  float2 pos = uv * coarseSize - 0.5;
  int2 cell = int2(floor(pos));
  int2 last = int2(coarseSize) - 1;
  float a = plasma_coarse_alpha(t0, cell, last);
  float b = plasma_coarse_alpha(t0, cell + int2(1, 0), last);
  float c = plasma_coarse_alpha(t0, cell + int2(0, 1), last);
  float d = plasma_coarse_alpha(t0, cell + int2(1, 1), last);
  float high = max(max(a, b), max(c, d));
  float low = min(min(a, b), min(c, d));
  if (high > 0.02 && low < 0.4) return plasma_trace(frag * (u[1].xy / u[0].xy), u);
  return t0.sample(smp, float2(uv.x, 1.0 - uv.y));
}

// The bloom chain and the composite only resample: they stay in Metal's
// orientation (every texture in the chain was written the same way), and the
// symmetric taps make the flip invisible.
fragment float4 plasma_down(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]],
                            texture2d<float> t0 [[texture(0)]], sampler smp [[sampler(0)]]) {
  float2 uv = in.pos.xy / u[0].xy;
  float2 texel = 1.0 / float2(t0.get_width(), t0.get_height());
  float4 sum = t0.sample(smp, uv) * 4.0;
  sum += t0.sample(smp, uv - texel);
  sum += t0.sample(smp, uv + texel);
  sum += t0.sample(smp, uv + float2(texel.x, -texel.y));
  sum += t0.sample(smp, uv - float2(texel.x, -texel.y));
  return sum / 8.0;
}

fragment float4 plasma_up(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]],
                          texture2d<float> t0 [[texture(0)]], texture2d<float> t1 [[texture(1)]],
                          sampler smp [[sampler(0)]]) {
  float2 uv = in.pos.xy / u[0].xy;
  float2 h = 0.5 / float2(t0.get_width(), t0.get_height());
  float4 sum = t0.sample(smp, uv + float2(-h.x * 2.0, 0.0));
  sum += t0.sample(smp, uv + float2(h.x * 2.0, 0.0));
  sum += t0.sample(smp, uv + float2(0.0, -h.y * 2.0));
  sum += t0.sample(smp, uv + float2(0.0, h.y * 2.0));
  sum += t0.sample(smp, uv + float2(-h.x, h.y)) * 2.0;
  sum += t0.sample(smp, uv + h) * 2.0;
  sum += t0.sample(smp, uv + float2(h.x, -h.y)) * 2.0;
  sum += t0.sample(smp, uv - h) * 2.0;
  return sum / 12.0 + t1.sample(smp, uv);
}

fragment float4 plasma_composite(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]],
                                 texture2d<float> t0 [[texture(0)]], texture2d<float> t1 [[texture(1)]],
                                 sampler smp [[sampler(0)]]) {
  float2 uv = in.pos.xy / u[0].xy;
  float2 frag = gl_frag(in.pos, u[0].y);
  float exposure = u[4].y;
  float3 hdr = t0.sample(smp, uv).rgb * exposure;
  hdr += t1.sample(smp, uv).rgb * exposure * u[4].z * 0.18;
  float grain = (hash21(frag + fract(u[0].z * 7.31) * 113.0) - 0.5) * u[4].w;
  float3 mapped = 1.0 - exp(-hdr);
  float peak = max(mapped.r, max(mapped.g, mapped.b));
  mapped = clamp(mapped + grain * peak, 0.0, 1.0) * u[5].w;
  float alpha = max(mapped.r, max(mapped.g, mapped.b));
  return float4((mapped + u[8].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Liquid Chrome
// Ported from React Bits by David Haz (https://reactbits.dev), used with permission (plan 190).
inline float chrome_lamp(float2 p, float2 center, float2 size, float soft) {
  float2 grown = size + soft;
  float2 q = (p - center) / grown;
  q *= q;
  float d = sqrt(sqrt(dot(q, q)));
  float edge = soft / min(grown.x, grown.y);
  float shape = (1.0 - smoothstep(1.0 - edge, 1.0 + edge, d)) * (1.0 - 0.45 * d * d);
  return shape * size.x * size.y / (grown.x * grown.y);
}

inline float3 chrome_studio(float3 r, float blur, constant float4* u) {
  float2 p = r.xy / max(r.z + 1.0, 0.05);
  p += u[5].xy * smoothstep(0.3, 1.0, length(p));
  float radius = length(p);
  float soft = 0.008 + blur;
  float2 dir = p / max(radius, 1e-3);
  float key = chrome_lamp(p, float2(-0.25, 0.42), float2(0.3, 0.12), soft);
  float side = chrome_lamp(p, float2(0.48, 0.12), float2(0.06, 0.3), soft);
  float ground = chrome_lamp(p, float2(-0.1, -0.55), float2(0.45, 0.06), soft);
  float rise = smoothstep(-1.0, 1.0, dir.y);
  float width = 0.015 + soft * 2.0;
  float rim = exp(-abs(radius - 1.0) / width) * 0.031 / width * (0.8 + smoothstep(-0.5, 0.8, p.y));
  float band = 1.0 - 0.95 * smoothstep(1.04 - soft, 1.12 + soft, radius);
  float wall = smoothstep(1.25, 1.55, radius) * (0.6 + 0.4 * rise);
  float streak = smoothstep(0.2, 0.8, 0.5 + 0.5 * sin(atan2(dir.y, dir.x) * 3.0 + 0.6));
  float3 color = float3(0.004, 0.004, 0.005) + 0.02 * smoothstep(-0.4, 0.6, p.y);
  color += float3(1.0, 0.97, 0.94) * key * 4.0 + float3(0.9, 0.95, 1.0) * side * 3.0 + ground * 1.2;
  color += float3(1.0, 0.98, 0.95) * rim;
  color *= band;
  return color + float3(mix(0.45, 1.8, streak)) * wall;
}

inline float3 chrome_shade(float2 slope, float3 v, float blur, float3 f0, constant float4* u) {
  float steep = length(slope);
  slope *= 3.0 * tanh(steep / 3.0) / max(steep, 1e-6);
  float3 n = normalize(float3(-slope, 1.0));
  float3 r = reflect(v, n);
  float facing = clamp(dot(n, -v), 0.0, 1.0);
  return chrome_studio(r, blur, u) * (f0 + (1.0 - f0) * pow(1.0 - facing, 5.0));
}

inline float3 chrome_aces(float3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

fragment float4 liquid_chrome_main(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]]) {
  float2 res = u[0].xy;
  float unit = min(res.x, res.y);
  float time = u[0].z;
  float2 frag = gl_frag(in.pos, res.y);
  float2 uv = (2.0 * frag - res) / unit;
  float2 p = uv;
  float2 rowX = float2(1.0, 0.0);
  float2 rowY = float2(0.0, 1.0);
  float presence = u[4].w;
  float amplitude = u[2].x * presence;
  float2 frequency = u[2].yz;
  for (float i = 1.0; i < 9.0; i++) {
    if (i > u[2].w) break;
    float a = amplitude / i;
    float soften = exp(0.3 - 0.3 * i);
    float argX = i * frequency.x * p.y + time;
    p.x += a * cos(argX);
    rowX -= a * sin(argX) * i * frequency.x * soften * rowY;
    float argY = i * frequency.y * p.x + time;
    p.y += a * cos(argY);
    rowY -= a * sin(argY) * i * frequency.y * soften * rowX;
  }
  float phase = time - p.x - p.y;
  float2 field = -(rowX + rowY);
  float density = max(length(field), 1e-3);
  float2 across = field / density;
  float k = u[3].x;
  float sn = sin(phase);
  float cs = cos(phase);
  float th = tanh(k * sn);
  float bevel = (1.0 - th * th) / tanh(k);
  float fade = smoothstep(3.0, 9.0, 3.14159 * unit / density);
  float weight = u[3].y * presence * fade;
  float2 slope = k * cs * bevel * weight * across;
  float2 sweep = -k * bevel * (sn + 2.0 * k * cs * cs * th) * weight * density * 2.0 / unit * across;
  float2 stepX = dfdx(slope);
  float2 stepY = dfdy(slope);
  float2 crease = dot(stepX, stepX) > dot(stepY, stepY) ? stepX : stepY;
  if (dot(crease, crease) > dot(sweep, sweep)) sweep = crease;
  float bend = length(sweep);
  float alpha = smoothstep(0.0, 0.1, length(slope));
  float3 f0 = mix(float3(1.0), u[4].rgb, smoothstep(0.05, 0.6, length(slope))) * 0.92;
  float3 v = normalize(float3(uv * 0.08, -1.0));
  float blur = u[3].z * 0.35;
  float3 light;
  if (bend < 0.01) {
    light = chrome_shade(slope, v, blur + bend * 0.5, f0, u);
  } else {
    light = float3(0.0);
    for (float t = -0.375; t < 0.4; t += 0.25) {
      light += chrome_shade(slope + sweep * t, v, blur + bend * 0.15, f0, u);
    }
    light *= 0.25;
  }
  float3 color = pow(chrome_aces(light * u[3].w), float3(1.0 / 2.2));
  float grain = fract(52.9829189 * fract(dot(frag, float2(0.06711056, 0.00583715))));
  color += (grain - 0.5) / 255.0;
  float3 premultiplied = clamp(color, 0.0, 1.0) * alpha;
  return float4((premultiplied + u[6].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Line Waves
// Ported from React Bits by David Haz (https://reactbits.dev), used with permission (plan 190).
inline float2 lines_rotate(float2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return float2(c * p.x - s * p.y, s * p.x + c * p.y);
}

inline float lines_smootherstep(float edge0, float edge1, float x) {
  float t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

inline float lines_bend(float2 p, float t, constant float4* u) {
  float scale = u[3].w;
  float2 q = p * 2.0 / scale;
  float w = 0.6 * sin(q.x * 0.55 + t * 0.4 + 0.6 * sin(q.y * 0.9 - t * 0.28));
  w += 0.21 * sin(q.x * 1.3 - t * 0.33 + q.y * 0.8 + 1.3);
  w += 0.12 * sin(q.y * 2.3 + q.x * 0.9 - t * 0.37 + 0.4);
  return w * u[3].z * scale * 0.46;
}

inline float lines_river(float2 p, float y, float t, constant float4* u) {
  float drift = 0.7 * (0.18 * sin(p.x * 1.6 - t * 0.33 + 0.7) + 0.1 * sin(p.x * 3.1 + t * 0.21));
  float center = 0.5 * (0.2 * sin(t * 0.17) + 0.08 * sin(t * 0.29 + 1.3));
  float width = 0.13 * u[3].y;
  float nearBand = (y - center - drift) / width;
  float farBand = (y + 0.22 * sin(t * 0.13 + 2.0) - drift * 0.6 + 0.3) / (width * 0.55);
  return max(exp(-nearBand * nearBand), exp(-farBand * farBand) * 0.7);
}

inline float3 lines_palette(float x, constant float4* u) {
  x = fract(x) * 3.0;
  if (x < 1.0) return mix(u[5].rgb, u[6].rgb, smoothstep(0.0, 1.0, x));
  if (x < 2.0) return mix(u[6].rgb, u[7].rgb, smoothstep(1.0, 2.0, x));
  return mix(u[7].rgb, u[5].rgb, smoothstep(2.0, 3.0, x));
}

fragment float4 line_waves_main(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]]) {
  float2 res = u[0].xy;
  float aspect = res.x / res.y;
  float2 frag = gl_frag(in.pos, res.y);
  float2 uv = frag / res;
  float2 p = lines_rotate((frag - 0.5 * res) / res.y, u[4].x);
  float t = u[0].z;
  float pixel = u[0].w;
  float lines = u[2].x;
  float highlight = u[3].x;

  float w = lines_bend(p, t, u);
  float y = p.y + w;
  float phi = y * lines;
  float fw = max(fwidth(phi), 1e-5);
  float crowd = smoothstep(0.18, 0.5, fw);

  float fold = smoothstep(1.3, 2.2, fw * res.y / lines);
  float shimmer = mix(1.0, smoothstep(0.15, 0.85, value_noise(float2(y * 1.6 + t * 0.07, p.x * 0.55 - t * 0.22))), 0.5);
  float lit = max(lines_river(p, y, t, u), fold * 0.9) * shimmer;
  float light = mix(1.0, 0.07 + 0.93 * lit, highlight);

  float dist = abs(fract(phi + 0.5) - 0.5) / fw;
  float width = u[2].y * pixel * (1.0 + 1.5 * lit * highlight);
  float cover = clamp(min(dist + width * 0.5, 0.5) - max(dist - width * 0.5, -0.5), 0.0, 1.0);
  cover = mix(cover, min(width * fw, 1.0), crowd);
  float halo = exp(-dist / (2.2 * pixel)) * (1.0 - crowd) * u[2].z;
  float threadShade = mix(1.0, 0.55 + 0.45 * hash21(float2(floor(phi + 0.5), 7.3)), 0.45 * (1.0 - crowd));

  // The intro reveal is finished (React Bits' uReveal = 1).
  float span = 0.5 * sqrt(aspect * aspect + 1.0);
  float sweep = span + 0.6;
  float reveal = 1.0 - smoothstep(sweep - 0.6, sweep, p.x);

  float edge = 1.0;
  float edgeFade = u[4].z;
  if (edgeFade > 0.0) {
    float ex = min(uv.x, 1.0 - uv.x) * aspect;
    float ey = min(uv.y, 1.0 - uv.y);
    edge = lines_smootherstep(0.0, edgeFade * 0.5, ex) * lines_smootherstep(0.0, edgeFade * 0.5, ey);
  }

  float3 tint = lines_palette(y * 0.3 + p.x * 0.2 + t * u[4].y * 0.02, u);
  float grain = dither(frag);

  float strength = (cover + halo) * threadShade * light * u[2].w * reveal * edge;
  float3 color = clamp(tint * strength * u[4].w, 0.0, 1.0);
  float alpha = max(color.r, max(color.g, color.b));
  color = clamp(color + grain, 0.0, 1.0);
  float3 premultiplied = min(color, float3(alpha));
  return float4((premultiplied + u[8].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Beams
// Ported from React Bits by David Haz (https://reactbits.dev), used with permission (plan 194).
constant float BEAMS_PI = 3.141592653589793;

inline float4 beams_permute(float4 x) { return gl_mod4(((x * 34.0) + 1.0) * x, 289.0); }
inline float4 beams_taylor_inv_sqrt(float4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
inline float3 beams_fade(float3 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

inline float beams_cnoise(float3 P) {
  float3 Pi0 = floor(P);
  float3 Pi1 = Pi0 + float3(1.0);
  Pi0 = gl_mod3(Pi0, 289.0);
  Pi1 = gl_mod3(Pi1, 289.0);
  float3 Pf0 = fract(P);
  float3 Pf1 = Pf0 - float3(1.0);
  float4 ix = float4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
  float4 iy = float4(Pi0.yy, Pi1.yy);
  float4 iz0 = Pi0.zzzz;
  float4 iz1 = Pi1.zzzz;
  float4 ixy = beams_permute(beams_permute(ix) + iy);
  float4 ixy0 = beams_permute(ixy + iz0);
  float4 ixy1 = beams_permute(ixy + iz1);
  float4 gx0 = ixy0 / 7.0;
  float4 gy0 = fract(floor(gx0) / 7.0) - 0.5;
  gx0 = fract(gx0);
  float4 gz0 = float4(0.5) - abs(gx0) - abs(gy0);
  float4 sz0 = step(gz0, float4(0.0));
  gx0 -= sz0 * (step(float4(0.0), gx0) - 0.5);
  gy0 -= sz0 * (step(float4(0.0), gy0) - 0.5);
  float4 gx1 = ixy1 / 7.0;
  float4 gy1 = fract(floor(gx1) / 7.0) - 0.5;
  gx1 = fract(gx1);
  float4 gz1 = float4(0.5) - abs(gx1) - abs(gy1);
  float4 sz1 = step(gz1, float4(0.0));
  gx1 -= sz1 * (step(float4(0.0), gx1) - 0.5);
  gy1 -= sz1 * (step(float4(0.0), gy1) - 0.5);
  float3 g000 = float3(gx0.x, gy0.x, gz0.x);
  float3 g100 = float3(gx0.y, gy0.y, gz0.y);
  float3 g010 = float3(gx0.z, gy0.z, gz0.z);
  float3 g110 = float3(gx0.w, gy0.w, gz0.w);
  float3 g001 = float3(gx1.x, gy1.x, gz1.x);
  float3 g101 = float3(gx1.y, gy1.y, gz1.y);
  float3 g011 = float3(gx1.z, gy1.z, gz1.z);
  float3 g111 = float3(gx1.w, gy1.w, gz1.w);
  float4 norm0 = beams_taylor_inv_sqrt(float4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
  g000 *= norm0.x;
  g010 *= norm0.y;
  g100 *= norm0.z;
  g110 *= norm0.w;
  float4 norm1 = beams_taylor_inv_sqrt(float4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
  g001 *= norm1.x;
  g011 *= norm1.y;
  g101 *= norm1.z;
  g111 *= norm1.w;
  float n000 = dot(g000, Pf0);
  float n100 = dot(g100, float3(Pf1.x, Pf0.yz));
  float n010 = dot(g010, float3(Pf0.x, Pf1.y, Pf0.z));
  float n110 = dot(g110, float3(Pf1.xy, Pf0.z));
  float n001 = dot(g001, float3(Pf0.xy, Pf1.z));
  float n101 = dot(g101, float3(Pf1.x, Pf0.y, Pf1.z));
  float n011 = dot(g011, float3(Pf0.x, Pf1.yz));
  float n111 = dot(g111, Pf1);
  float3 fade_xyz = beams_fade(Pf0);
  float4 n_z = mix(float4(n000, n100, n010, n110), float4(n001, n101, n011, n111), fade_xyz.z);
  float2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
  float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
  return 2.2 * n_xyz;
}

inline float beams_lane_hash(float lane, constant float4* u) {
  return fract(sin(lane * 91.3458 + u[4].x * 17.17) * 47453.5453);
}

inline float beams_lobe(float nh, float nl, float nv, float vh, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  float distribution = a2 / (BEAMS_PI * d * d);
  float gv = nl * sqrt(nv * nv * (1.0 - a2) + a2);
  float gl = nv * sqrt(nl * nl * (1.0 - a2) + a2);
  float visibility = 0.5 / max(gv + gl, 0.0001);
  float fresnel = 0.028 + 0.972 * pow(1.0 - vh, 5.0);
  return distribution * visibility * fresnel * nl;
}

inline float2 beams_glint(float lane, float2 local, float uTime, float camera, constant float4* u) {
  float along = local.y / u[2].y - beams_lane_hash(lane, u) * 60.0;
  float delta = 0.01;
  float slope = (beams_cnoise(float3(0.0, along + delta, uTime)) - beams_cnoise(float3(0.0, along - delta, uTime))) / (2.0 * delta);
  slope *= 0.2 * u[2].z;
  float spin = beams_lane_hash(lane + 0.37, u);
  float tilt = ((spin - 0.5) * 0.5 + sin(uTime * 2.1 + spin * 6.2831) * 0.06) * u[3].z;
  float3 normal = normalize(float3(tilt, -slope, 1.0));
  float3 view = normalize(float3(-local, camera));
  float nv = max(dot(normal, view), 0.0001);
  // The light rests at React Bits' (0, 3, 10): the intro sweep is over and
  // the pointer never lifts it.
  float3 light = normalize(float3(0.0, 3.0, 10.0));
  float3 halfway = normalize(light + view);
  float roughness = u[2].w;
  float core = beams_lobe(max(dot(normal, halfway), 0.0), max(dot(normal, light), 0.0), nv, max(dot(view, halfway), 0.0), roughness);
  float3 fill = normalize(float3(0.0, -3.0 * 1.25, 10.0));
  float3 fillHalf = normalize(fill + view);
  core += u[3].w * beams_lobe(max(dot(normal, fillHalf), 0.0), max(dot(normal, fill), 0.0), nv, max(dot(view, fillHalf), 0.0), roughness);
  return float2(core, core);
}

fragment float4 beams_field(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]]) {
  // React Bits sizes the beams in CSS pixels; one is min(view) / 1080 render
  // pixels, so uScale is CSS pixels per field texel.
  float2 viewCss = u[1].xy / u[0].w;
  float2 uScale = viewCss / u[0].xy;
  float2 css = gl_frag(in.pos, u[0].y) * uScale;
  float2 centered = css - viewCss * 0.5;
  float2 local = float2x2(float2(u[3].x, -u[3].y), float2(u[3].y, u[3].x)) * centered;
  float uTime = gl_mod(u[0].z * 0.12, 289.0);
  float camera = viewCss.y * 1.866;

  float across = local.x / u[2].x + 0.5;
  float lane = floor(across);
  float along = across - lane;
  float2 value = beams_glint(lane, local, uTime, camera, u);

  float pixel = max(uScale.x, uScale.y);
  float seam = min(along, 1.0 - along) * u[2].x;
  if (seam < pixel * 1.5) {
    float other = along < 0.5 ? lane - 1.0 : lane + 1.0;
    float blend = 0.5 * (1.0 - smoothstep(0.0, pixel * 1.5, seam));
    value = mix(value, beams_glint(other, local, uTime, camera, u), blend);
  }

  // The pointer rests (React Bits' uPointer.z = 0), so nothing brightens
  // near it.
  float hot = max(value.y - 0.18, 0.0);
  return float4(value.x, value.y, min(hot, 6.0), 1.0);
}

inline float beams_random(float2 st) {
  return fract(sin(dot(st, float2(12.9898, 78.233))) * 43758.5453123);
}

inline float beams_grain_noise(float2 st) {
  float2 i = floor(st);
  float2 f = fract(st);
  float a = beams_random(i);
  float b = beams_random(i + float2(1.0, 0.0));
  float c = beams_random(i + float2(0.0, 1.0));
  float d = beams_random(i + float2(1.0, 1.0));
  float2 w = f * f * (3.0 - 2.0 * f);
  return mix(a, b, w.x) + (c - a) * w.y * (1.0 - w.x) + (d - b) * w.x * w.y;
}

inline float3 beams_aces_filmic(float3 color) {
  float3x3 inputMatrix = float3x3(
    float3(0.59719, 0.07600, 0.02840),
    float3(0.35458, 0.90834, 0.13383),
    float3(0.04823, 0.01566, 0.83777)
  );
  float3x3 outputMatrix = float3x3(
    float3(1.60475, -0.10208, -0.00327),
    float3(-0.53108, 1.10813, -0.07276),
    float3(-0.07367, -0.00605, 1.07602)
  );
  color = inputMatrix * (color / 0.6);
  float3 a = color * (color + 0.0245786) - 0.000090537;
  float3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  color = outputMatrix * (a / b);
  return clamp(color, 0.0, 1.0);
}

inline float3 beams_to_srgb(float3 color) {
  return mix(color * 12.92, 1.055 * pow(color, float3(1.0 / 2.4)) - 0.055, step(float3(0.0031308), color));
}

// The field is sampled in Metal's orientation (the mip levels were written
// the same way); only the grain and the jitter hash GLSL's fragment coordinate.
fragment float4 beams_composite(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]],
                                texture2d<float> t0 [[texture(0)]], sampler smp [[sampler(0)]]) {
  float2 frag = gl_frag(in.pos, u[0].y);
  float2 uv = in.pos.xy / u[0].xy;
  float radiance = t0.sample(smp, uv, level(0.0)).r;
  float bloom = 0.0;
  bloom += t0.sample(smp, uv, level(2.0)).b * 0.3;
  bloom += t0.sample(smp, uv, level(3.0)).b * 0.3;
  bloom += t0.sample(smp, uv, level(4.0)).b * 0.22;
  bloom += t0.sample(smp, uv, level(5.0)).b * 0.18;

  float hot = t0.sample(smp, uv, level(0.0)).g;
  float3 tint = u[5].rgb;
  float gain = u[4].y;
  float3 light = tint * (radiance + bloom * u[4].z) * gain;
  light += mix(tint, float3(1.0), 0.7) * hot * hot * 0.12 * gain;
  // The intro is finished (React Bits' uPresence = 1).
  float3 color = beams_to_srgb(beams_aces_filmic(light));
  color -= beams_grain_noise(frag) / 15.0 * u[4].w;
  color = max(color, float3(0.0));

  // No edge fade and full opacity: React Bits' mask is 1.
  float jitter = (beams_random(frag.yx + 31.7) - 0.5) / 255.0;
  color = clamp(color + jitter, 0.0, 1.0);
  float alpha = max(color.r, max(color.g, color.b));
  return float4((color + u[6].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Color Bends
// Ported from React Bits by David Haz (https://reactbits.dev), used with permission (plan 194).
fragment float4 color_bends_main(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]]) {
  float2 frag = gl_frag(in.pos, u[0].y);
  float2 vUv = frag / u[0].xy;
  float t = u[0].z;
  float2 p = vUv * 2.0 - 1.0;
  float2 rp = float2(p.x * u[2].x - p.y * u[2].y, p.x * u[2].y + p.y * u[2].x);
  float2 q = float2(rp.x * (u[0].x / u[0].y), rp.y);
  q /= max(u[2].z, 0.0001);
  q /= 0.5 + 0.2 * dot(q, q);
  q += 0.2 * cos(t) - 7.56;
  // The pointer rests at the centre (React Bits' uPointer = 0).
  float2 toward = -rp;
  q += toward * u[4].z * 0.2;

  float frequency = u[2].w;
  float iterations = u[3].z;
  for (int j = 0; j < 5; j++) {
    if (float(j) >= iterations - 1.0) break;
    float2 rr = sin(1.5 * (q.yx * frequency) + 2.0 * cos(q * frequency));
    q += (rr - q) * 0.15;
  }

  float warpStrength = u[3].x;
  float bandWidth = u[4].x;
  float count = u[4].y;
  float kBelow = clamp(warpStrength, 0.0, 1.0);
  float kMix = pow(kBelow, 0.3);
  float gain = 1.0 + max(warpStrength - 1.0, 0.0);
  float3 col = float3(0.0);
  float a = 1.0;

  if (count > 0.5) {
    float2 s = q;
    float3 sumCol = float3(0.0);
    float cover = 0.0;
    for (int i = 0; i < 8; ++i) {
      if (float(i) >= count) break;
      s -= 0.01;
      float2 r = sin(1.5 * (s.yx * frequency) + 2.0 * cos(s * frequency));
      float m0 = length(r + sin(5.0 * r.y * frequency - 3.0 * t + float(i)) / 4.0);
      float2 disp = (r - s) * kBelow;
      float2 warped = s + disp * gain;
      float m1 = length(warped + sin(5.0 * warped.y * frequency - 3.0 * t + float(i)) / 4.0);
      float m = mix(m0, m1, kMix);
      float w = 1.0 - exp(-bandWidth / exp(bandWidth * m));
      sumCol += u[5 + i].rgb * w;
      cover = max(cover, w);
    }
    col = clamp(sumCol, 0.0, 1.0);
    a = cover;
  } else {
    float2 s = q;
    for (int k = 0; k < 3; ++k) {
      s -= 0.01;
      float2 r = sin(1.5 * (s.yx * frequency) + 2.0 * cos(s * frequency));
      float m0 = length(r + sin(5.0 * r.y * frequency - 3.0 * t + float(k)) / 4.0);
      float2 disp = (r - s) * kBelow;
      float2 warped = s + disp * gain;
      float m1 = length(warped + sin(5.0 * warped.y * frequency - 3.0 * t + float(k)) / 4.0);
      float m = mix(m0, m1, kMix);
      col[k] = 1.0 - exp(-bandWidth / exp(bandWidth * m));
    }
    a = max(max(col.r, col.g), col.b);
  }

  col *= u[3].w;

  float noise = u[3].y;
  if (noise > 0.0001) {
    // Fixed in place: React Bits adds the time to the hash every frame.
    float n = fract(sin(dot(frag, float2(12.9898, 78.233))) * 43758.5453123);
    col += (n - 0.5) * noise;
    col = clamp(col, 0.0, 1.0);
  }

  // Premultiplied (React Bits' transparent mode) over the base colour.
  float3 rgb = col * a;
  return float4((rgb + u[13].rgb * (1.0 - a)) * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Dither
// Ported from React Bits by David Haz (https://reactbits.dev), used with permission (plan 194).
// One cell in render pixels: the look's pixel size in CSS pixels (one is
// min(view) / 1080 render pixels), at least one. sizes::dither_cell.
inline float dither_cell_size(constant float4* u) {
  return max(1.0, floor(u[3].z * u[0].w + 0.5));
}

inline float4 dither_mod289(float4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
inline float4 dither_permute(float4 x) { return dither_mod289(((x * 34.0) + 1.0) * x); }
inline float4 dither_taylor_inv_sqrt(float4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
inline float2 dither_fade(float2 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

inline float dither_cnoise(float2 P) {
  float4 Pi = floor(P.xyxy) + float4(0.0, 0.0, 1.0, 1.0);
  float4 Pf = fract(P.xyxy) - float4(0.0, 0.0, 1.0, 1.0);
  Pi = dither_mod289(Pi);
  float4 ix = Pi.xzxz;
  float4 iy = Pi.yyww;
  float4 fx = Pf.xzxz;
  float4 fy = Pf.yyww;
  float4 i = dither_permute(dither_permute(ix) + iy);
  float4 gx = fract(i * (1.0 / 41.0)) * 2.0 - 1.0;
  float4 gy = abs(gx) - 0.5;
  float4 tx = floor(gx + 0.5);
  gx = gx - tx;
  float2 g00 = float2(gx.x, gy.x);
  float2 g10 = float2(gx.y, gy.y);
  float2 g01 = float2(gx.z, gy.z);
  float2 g11 = float2(gx.w, gy.w);
  float4 norm = dither_taylor_inv_sqrt(float4(dot(g00, g00), dot(g01, g01), dot(g10, g10), dot(g11, g11)));
  g00 *= norm.x;
  g01 *= norm.y;
  g10 *= norm.z;
  g11 *= norm.w;
  float n00 = dot(g00, float2(fx.x, fy.x));
  float n10 = dot(g10, float2(fx.y, fy.y));
  float n01 = dot(g01, float2(fx.z, fy.z));
  float n11 = dot(g11, float2(fx.w, fy.w));
  float2 fadeXY = dither_fade(Pf.xy);
  float2 nx = mix(float2(n00, n01), float2(n10, n11), fadeXY.x);
  return 2.3 * mix(nx.x, nx.y, fadeXY.y);
}

inline float dither_fbm(float2 p, constant float4* u) {
  float value = 0.0;
  float amp = 1.0;
  for (int i = 0; i < 4; i++) {
    value += amp * abs(dither_cnoise(p));
    p *= u[2].y;
    amp *= u[2].z;
  }
  return value;
}

inline float dither_pattern(float2 p, constant float4* u) {
  float2 p2 = p - u[0].z * u[2].x;
  return dither_fbm(p + dither_fbm(p2, u), u);
}

fragment float4 dither_wave(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]]) {
  float ratio = u[0].w;
  float cell = dither_cell_size(u);
  // React Bits works in CSS pixels here: the canvas over its device ratio.
  float2 uResolution = u[1].xy / ratio;
  float uCell = cell / ratio;
  float2 corner = (gl_frag(in.pos, u[0].y) - 0.5) * uCell;
  float2 uv = corner / uResolution - 0.5;
  uv.x *= uResolution.x / uResolution.y;

  // No trail, no ripples (N3).
  float f = dither_pattern(uv / u[2].w, u);
  f = (f - 0.5) * u[3].x + 0.5 + u[3].y;
  // The intro reveal is finished (React Bits' show = 1).
  float v = clamp(f, 0.0, 1.0);
  return float4(floor(v * 255.0) / 255.0, fract(v * 255.0), 0.0, 1.0);
}

constant float DITHER_BAYER8[64] = {
  0.0 / 64.0, 48.0 / 64.0, 12.0 / 64.0, 60.0 / 64.0, 3.0 / 64.0, 51.0 / 64.0, 15.0 / 64.0, 63.0 / 64.0,
  32.0 / 64.0, 16.0 / 64.0, 44.0 / 64.0, 28.0 / 64.0, 35.0 / 64.0, 19.0 / 64.0, 47.0 / 64.0, 31.0 / 64.0,
  8.0 / 64.0, 56.0 / 64.0, 4.0 / 64.0, 52.0 / 64.0, 11.0 / 64.0, 59.0 / 64.0, 7.0 / 64.0, 55.0 / 64.0,
  40.0 / 64.0, 24.0 / 64.0, 36.0 / 64.0, 20.0 / 64.0, 43.0 / 64.0, 27.0 / 64.0, 39.0 / 64.0, 23.0 / 64.0,
  2.0 / 64.0, 50.0 / 64.0, 14.0 / 64.0, 62.0 / 64.0, 1.0 / 64.0, 49.0 / 64.0, 13.0 / 64.0, 61.0 / 64.0,
  34.0 / 64.0, 18.0 / 64.0, 46.0 / 64.0, 30.0 / 64.0, 33.0 / 64.0, 17.0 / 64.0, 45.0 / 64.0, 29.0 / 64.0,
  10.0 / 64.0, 58.0 / 64.0, 6.0 / 64.0, 54.0 / 64.0, 9.0 / 64.0, 57.0 / 64.0, 5.0 / 64.0, 53.0 / 64.0,
  42.0 / 64.0, 26.0 / 64.0, 38.0 / 64.0, 22.0 / 64.0, 41.0 / 64.0, 25.0 / 64.0, 37.0 / 64.0, 21.0 / 64.0
};

constant float DITHER_BAYER4[16] = {
  0.0 / 16.0, 8.0 / 16.0, 2.0 / 16.0, 10.0 / 16.0,
  12.0 / 16.0, 4.0 / 16.0, 14.0 / 16.0, 6.0 / 16.0,
  3.0 / 16.0, 11.0 / 16.0, 1.0 / 16.0, 9.0 / 16.0,
  15.0 / 16.0, 7.0 / 16.0, 13.0 / 16.0, 5.0 / 16.0
};

constant float DITHER_BAYER2[4] = { 0.0 / 4.0, 2.0 / 4.0, 3.0 / 4.0, 1.0 / 4.0 };

constant float3 DITHER_LUMA = float3(0.2126, 0.7152, 0.0722);

// React Bits' MODES: bayer 0, bayer4 1, bayer2 2, halftone 3, lines 4,
// crosshatch 5, noise 6, none 7.
inline float dither_threshold(float2 cell, constant float4* u) {
  int mode = int(u[3].w + 0.5);
  if (mode == 1) {
    int2 c = int2(gl_mod2(cell, 4.0));
    return DITHER_BAYER4[c.y * 4 + c.x];
  }
  if (mode == 2) {
    int2 c = int2(gl_mod2(cell, 2.0));
    return DITHER_BAYER2[c.y * 2 + c.x];
  }
  if (mode == 3) {
    float2 r = float2(cell.x + cell.y, cell.x - cell.y) * 0.70710678 / 4.0;
    return clamp(length(fract(r) - 0.5) * 1.41421356, 0.0, 0.999);
  }
  if (mode == 4) {
    return abs(fract(cell.y / 4.0) - 0.5) * 2.0 * 0.999;
  }
  if (mode == 5) {
    float a = abs(fract((cell.x + cell.y) / 6.0) - 0.5) * 2.0;
    float b = abs(fract((cell.x - cell.y) / 6.0) - 0.5) * 2.0;
    return min(a, b) * 0.999;
  }
  if (mode == 6) {
    return fract(52.9829189 * fract(dot(cell, float2(0.06711056, 0.00583715))));
  }
  if (mode == 7) {
    return 0.25;
  }
  int2 c = int2(gl_mod2(cell, 8.0));
  return DITHER_BAYER8[c.y * 8 + c.x];
}

inline float3 dither_to_srgb(float3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, float3(1.0 / 2.4)) - 0.055, step(float3(0.0031308), c));
}

fragment float4 dither_composite(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]],
                                 texture2d<float> t0 [[texture(0)]]) {
  float2 cell = floor(gl_frag(in.pos, u[0].y) / dither_cell_size(u));
  int2 last = int2(t0.get_width(), t0.get_height()) - 1;
  int2 c = clamp(int2(cell), int2(0), last);
  float4 sampleValue = t0.read(uint2(c.x, last.y - c.y));
  float f = sampleValue.r + sampleValue.g / 255.0;
  float t = dither_threshold(cell, u) - 0.25;
  float paletteCount = u[4].y;
  float3 color;

  if (paletteCount > 1.5) {
    float n = paletteCount;
    float v = f + t / (n - 1.0);
    v = clamp(v - mix(0.2, 0.0, smoothstep(0.45, 0.8, v)), 0.0, 1.0);
    int index = int(floor(v * (n - 1.0) + 0.5));
    color = dither_to_srgb(u[7 + index].rgb);
  } else {
    float levels = max(u[4].x, 1.01) - 1.0;
    float3 wave = u[5].rgb;
    float3 background = u[6].rgb;
    float base = dot(background, DITHER_LUMA);
    float3 offset = (wave - float3(base)) * f + t / levels;
    float luminance = dot(background + offset, DITHER_LUMA);
    offset -= mix(0.2, 0.0, smoothstep(0.45, 0.8, luminance));
    bool rising = dot(wave, DITHER_LUMA) >= base;
    float lower = rising ? 0.0 : -max(background.r, max(background.g, background.b));
    float upper = rising ? 1.0 - min(background.r, min(background.g, background.b)) : 0.0;
    offset = floor(clamp(offset, lower, upper) * levels + 0.5) / levels;
    color = dither_to_srgb(background + offset);
  }
  return float4(color * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Ferrofluid
// Ported from React Bits by David Haz (https://reactbits.dev), used with permission (plan 194).
constant float FERRO_CELL = 1.0 / 3.0;
constant float FERRO_BOUND_CELL = 1.0;
// tan(19°): half of React Bits' 38° field of view.
constant float FERRO_TAN_HALF = 0.34432761;
constant float FERRO_G = 7.2551975;
constant float2 FERRO_E1 = float2(0.8660254, 0.5);
constant float2 FERRO_E2 = float2(-0.8660254, 0.5);
constant float2 FERRO_E3 = float2(0.0, -1.0);
constant float FERRO_F0 = 0.06;

inline float2x2 ferro_turn() {
  return float2x2(float2(0.9902681, 0.1391731), float2(-0.1391731, 0.9902681));
}

// Where a camera ray through NDC (x, y) meets the ground (React Bits'
// groundAt).
inline float2 ferro_ground_at(float x, float y, float aspect, constant float4* u) {
  float3 d = normalize(float3(x * aspect * FERRO_TAN_HALF, u[5].x + y * FERRO_TAN_HALF * u[5].z, u[5].y + y * FERRO_TAN_HALF * u[5].w));
  float t = d.z < -0.004 ? min(-u[4].y / d.z, u[4].z) : u[4].z;
  return float2(d.x * t, u[4].x + d.y * t);
}

// The grid's corner for this view (React Bits' layout()): the four corner
// rays and the top centre meet the ground, padded by three units.
// sizes::ferrofluid_grid cells the same footprint, so the grid texture is
// exactly this origin plus its size × CELL.
inline float2 ferro_grid_origin(constant float4* u) {
  float aspect = u[1].x / u[1].y;
  float2 a = ferro_ground_at(-1.0, -1.0, aspect, u);
  float2 b = ferro_ground_at(1.0, -1.0, aspect, u);
  float2 c = ferro_ground_at(-1.0, 1.0, aspect, u);
  float2 d = ferro_ground_at(1.0, 1.0, aspect, u);
  float2 e = ferro_ground_at(0.0, 1.0, aspect, u);
  return min(min(min(a, b), min(c, d)), e) - 3.0;
}

inline float ferro_noise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash12(i);
  float b = hash12(i + float2(1.0, 0.0));
  float c = hash12(i + float2(0.0, 1.0));
  float d = hash12(i + float2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

inline float ferro_flow_field(float2 p, constant float4* u) {
  float uTime = u[0].z;
  float2 q = p / 5.5 + u[3].xy;
  float2 drift = u[2].xy * uTime * 0.55;
  float2 warp = float2(ferro_noise(q * 0.6 + float2(uTime * 0.07, 3.1)), ferro_noise(q * 0.6 - float2(7.3, uTime * 0.06))) - 0.5;
  float2 r = q + warp * 1.8 * u[2].z - drift;
  float n = ferro_noise(r) * 0.65 + ferro_noise(r * 2.03 + 11.7 - drift * 0.5) * 0.35;
  return smoothstep(0.44, 0.86, n);
}

fragment float4 ferrofluid_field(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]]) {
  float2 texel = floor(gl_frag(in.pos, u[0].y));
  float2 p = ferro_grid_origin(u) + (texel + 0.5) * FERRO_CELL;
  float swell = ferro_flow_field(p, u);
  float field = u[2].w * (0.03 + 1.0 * swell * swell);
  // No cursor and no pulse add to the field; the intro front has passed.
  float target = u[3].z * min(pow(max(field - 0.04, 0.0), 1.6), 1.0);
  // N1: the height is the target itself (uSettle); no velocity, no mound.
  return float4(target, 0.0, 0.0, 1.0);
}

fragment float4 ferrofluid_bound(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]],
                                 texture2d<float> t0 [[texture(0)]]) {
  float2 origin = ferro_grid_origin(u);
  float2 stateSize = float2(t0.get_width(), t0.get_height());
  float2 center = origin + (floor(gl_frag(in.pos, u[0].y)) + 0.5) * FERRO_BOUND_CELL;
  float2 base = floor((center - origin) / FERRO_CELL);
  int lastRow = int(stateSize.y) - 1;
  float top = 0.0;
  float peak = 0.0;
  for (int y = -4; y <= 4; y++) {
    for (int x = -4; x <= 4; x++) {
      int2 texel = int2(clamp(base + float2(float(x), float(y)), float2(0.0), stateSize - 1.0));
      float4 s = t0.read(uint2(texel.x, lastRow - texel.y));
      top = max(top, max(s.x, 0.0) * 1.05 + s.z);
      peak = max(peak, s.x);
    }
  }
  return float4(top, peak, 0.0, 1.0);
}

inline float2 ferro_lattice(float2 p, constant float4* u) {
  float2 q = ferro_turn() * p;
  // React Bits' render time is twice the simulation's.
  float t = u[0].z * 2.0 * 0.35;
  return q + u[7].x * float2(sin(q.y * 0.9 + t), cos(q.x * 0.8 - t * 0.8));
}

inline float ferro_pixel_angle(constant float4* u) {
  return (2.0 * FERRO_TAN_HALF) / u[0].y;
}

inline float ferro_detail(float t, constant float4* u) {
  float fogStart = u[4].w;
  float far = u[4].z;
  return smoothstep(3.0, 8.0, 1.0 / max(t * ferro_pixel_angle(u), 1e-5)) * (1.0 - smoothstep(fogStart, mix(fogStart, far, 0.7), t));
}

inline float ferro_profile(float v, thread float& rate, constant float4* u) {
  float uRound = u[6].y;
  float uSpan = u[6].z;
  float root = sqrt(max(1.0 - v, 0.0) + uRound * uRound);
  rate = 0.5 / (uSpan * root);
  return clamp(1.0 - (root - uRound) / uSpan, 0.0, 1.0);
}

inline float ferro_spikes(float2 p, float a, float rise, thread float& clearance, constant float4* u) {
  clearance = 10.0;
  if (a < 0.002) return 0.0;
  float2 q = ferro_lattice(p, u);
  float v = (cos(FERRO_G * dot(FERRO_E1, q)) + cos(FERRO_G * dot(FERRO_E2, q)) + cos(FERRO_G * dot(FERRO_E3, q)) + 1.5) / 4.5;
  float uRound = u[6].y;
  float uSpan = u[6].z;
  float uExponent = u[6].w;
  if (a > 0.05) {
    float root = uRound + (1.0 - pow(clamp(rise / a, 0.0, 1.0), 1.0 / uExponent)) * uSpan;
    clearance = sqrt(max(1.0 - v, 0.0) / 8.77) - sqrt(max(root * root - uRound * uRound, 0.0) / 8.77);
  }
  float rate;
  return a * pow(ferro_profile(v, rate, u), uExponent);
}

inline float2 ferro_spikes_slope(float2 p, float a, float2 aSlope, constant float4* u) {
  if (a < 0.002) return float2(0.0);
  float2 q = ferro_lattice(p, u);
  float c1 = FERRO_G * dot(FERRO_E1, q);
  float c2 = FERRO_G * dot(FERRO_E2, q);
  float c3 = FERRO_G * dot(FERRO_E3, q);
  float v = (cos(c1) + cos(c2) + cos(c3) + 1.5) / 4.5;
  float2 du = -(FERRO_G / 4.5) * (sin(c1) * FERRO_E1 + sin(c2) * FERRO_E2 + sin(c3) * FERRO_E3) * ferro_turn();
  float rate;
  float s = max(ferro_profile(v, rate, u), 1e-4);
  float uExponent = u[6].w;
  float shape = pow(s, uExponent);
  return a * uExponent * shape / s * rate * du + aSlope * shape;
}

inline float2 ferro_grid_span(texture2d<float> t0) {
  return float2(t0.get_width(), t0.get_height()) * FERRO_CELL;
}

// The field was written with GLSL's orientation; it has one level, so an
// explicit level 0 is the reference's linear sample and needs no
// derivatives inside the march's branches.
inline float4 ferro_field(texture2d<float> t0, sampler smp, float2 uv) {
  return t0.sample(smp, float2(uv.x, 1.0 - uv.y), level(0.0));
}

inline float ferro_surface(float2 p, float2 origin, float z, float t, thread float& clearance,
                           texture2d<float> t0, sampler smp, constant float4* u) {
  float4 f = ferro_field(t0, smp, (p - origin) / ferro_grid_span(t0));
  // f.z is the cursor's mound: 0 without a pointer.
  return f.z + ferro_spikes(p, f.x * ferro_detail(t, u), z - f.z, clearance, u);
}

// React Bits samples the bound nearest and clamped; a texel read is the
// same and needs no sampler state.
inline float2 ferro_bound(float2 p, float2 origin, texture2d<float> t1) {
  int2 size = int2(t1.get_width(), t1.get_height());
  int2 texel = clamp(int2(floor((p - origin) / FERRO_BOUND_CELL)), int2(0), size - 1);
  return t1.read(uint2(texel.x, size.y - 1 - texel.y)).rg;
}

inline float ferro_panel(float3 r, float3 dir, float3 up, float2 extent, float soft) {
  float3 side = normalize(cross(dir, up));
  float3 top = cross(side, dir);
  float facing = dot(r, dir);
  if (facing <= 0.0) return 0.0;
  float2 q = float2(dot(r, side), dot(r, top)) / facing;
  float2 e = smoothstep(extent + soft, extent - soft, abs(q));
  return e.x * e.y;
}

inline float3 ferro_studio(float3 r, float3 rd, float soft, constant float4* u) {
  float3 z = float3(0.0, 0.0, 1.0);
  float3 col = u[8].rgb * 4.2 * ferro_panel(r, normalize(float3(-0.3, -0.5, 0.81)), z, float2(0.36, 0.22), 0.08 + soft);
  col += u[9].rgb * 1.5 * ferro_panel(r, normalize(float3(-0.9, -0.2, 0.38)), z, float2(0.12, 0.7), 0.07 + soft);
  col += u[9].rgb * 1.5 * ferro_panel(r, normalize(float3(0.9, -0.1, 0.42)), z, float2(0.12, 0.7), 0.07 + soft);
  float lift = asin(clamp(r.z, -1.0, 1.0)) - asin(clamp(-rd.z, -1.0, 1.0));
  col += u[10].rgb * 0.45 * smoothstep(0.08 - soft, 0.7 + soft, lift) * smoothstep(1.6, 1.0, lift);
  return col;
}

// React Bits' finish() in dark, transparent mode: the glow premultiplied by
// the fog, drawn here over the base colour.
inline float4 ferro_finish(float3 light, float alpha, constant float4* u) {
  float3 glow = light * alpha;
  float cover = max(glow.r, max(glow.g, glow.b));
  return float4((glow + u[11].rgb * (1.0 - cover)) * (1.0 - u[1].z), 1.0);
}

fragment float4 ferrofluid_render(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]],
                                  texture2d<float> t0 [[texture(0)]], texture2d<float> t1 [[texture(1)]],
                                  sampler smp [[sampler(0)]]) {
  float2 res = u[0].xy;
  float2 ndc = (gl_frag(in.pos, res.y) - 0.5 * res) / (0.5 * res.y);
  float3 camera = float3(0.0, u[4].x, u[4].y);
  float3 forward = float3(0.0, u[5].x, u[5].y);
  float3 upward = float3(0.0, u[5].z, u[5].w);
  float far = u[4].z;
  float fogStart = u[4].w;
  float3 side = normalize(cross(forward, upward));
  float3 rd = normalize(forward + (ndc.x * side + ndc.y * upward) * FERRO_TAN_HALF);
  if (rd.z > -0.004) {
    return ferro_finish(float3(0.0), 0.0, u);
  }
  float tTop = max((u[6].x - camera.z) / rd.z, 0.0);
  float tEnd = min((-0.05 - camera.z) / rd.z, far);
  if (tTop >= tEnd) {
    return ferro_finish(float3(0.0), 0.0, u);
  }
  float2 origin = ferro_grid_origin(u);
  float sink = max(-rd.z, 0.2);
  float glide = max(length(rd.xy), 0.05);
  float chunk = 0.9 / glide;
  float t = tEnd;
  float tPrev = tEnd;
  bool found = false;
  bool smoothHit = false;
  float ta = tTop;
  float2 b0 = ferro_bound(camera.xy + rd.xy * ta, origin, t1);
  for (int c = 0; c < 64; c++) {
    if (ta >= tEnd) break;
    float tb = min(ta + chunk, tEnd);
    float2 b1 = ferro_bound(camera.xy + rd.xy * tb, origin, t1);
    float b = max(b0.x, b1.x) + 0.03;
    float z1 = camera.z + rd.z * tb;
    if (z1 > b) {
      ta = tb;
      b0 = b1;
      continue;
    }
    float tt = max(ta, (b - camera.z) / rd.z);
    if (max(b0.y, b1.y) < 0.002) {
      // Flat fluid: settle on the ground (the cursor's mound is 0).
      for (int k = 0; k < 3; k++) {
        float3 probe = camera + rd * tt;
        tt += probe.z / sink * 0.95;
      }
      if (tt <= tb + 0.02 || tb >= tEnd) {
        t = tt;
        smoothHit = true;
        break;
      }
      ta = tb;
      b0 = b1;
      continue;
    }
    float tp = tt;
    for (int k = 0; k < 48; k++) {
      float3 pos = camera + rd * tt;
      float clearance;
      float gap = pos.z - ferro_surface(pos.xy, origin, pos.z, tt, clearance, t0, smp, u);
      if (gap < 0.0) {
        found = true;
        break;
      }
      tp = tt;
      float pixel = tt * ferro_pixel_angle(u);
      float limit = pos.z > ferro_bound(pos.xy, origin, t1).x + 0.02 ? 0.6 / glide : max(clearance * 0.9, pixel) / glide;
      tt += max(min(gap * 0.75 / sink, limit), pixel);
      if (tt > tb) break;
    }
    if (found) {
      t = tt;
      tPrev = tp;
      break;
    }
    ta = tb;
    b0 = b1;
  }

  float3 pos;
  float2 slope;
  if (smoothHit || !found) {
    pos = camera + rd * t;
    slope = float2(0.0);
  } else {
    float lo = tPrev;
    float hi = t;
    for (int k = 0; k < 4; k++) {
      float mid = 0.5 * (lo + hi);
      float3 probe = camera + rd * mid;
      float clearance;
      if (probe.z - ferro_surface(probe.xy, origin, probe.z, mid, clearance, t0, smp, u) < 0.0) hi = mid;
      else lo = mid;
    }
    t = hi;
    pos = camera + rd * t;
    float2 span = ferro_grid_span(t0);
    float2 uv = (pos.xy - origin) / span;
    float2 delta = FERRO_CELL / span;
    float fade = ferro_detail(t, u);
    float a = ferro_field(t0, smp, uv).x * fade;
    float2 aSlope = float2(
      ferro_field(t0, smp, uv + float2(delta.x, 0.0)).x - ferro_field(t0, smp, uv - float2(delta.x, 0.0)).x,
      ferro_field(t0, smp, uv + float2(0.0, delta.y)).x - ferro_field(t0, smp, uv - float2(0.0, delta.y)).x
    ) * fade / (2.0 * FERRO_CELL);
    slope = ferro_spikes_slope(pos.xy, a, aSlope, u);
  }

  float3 n = normalize(float3(-slope, 1.0));
  float3 r = reflect(rd, n);
  float soft = length(fwidth(r)) * 0.6;
  float facing = max(dot(n, -rd), 0.0);
  float fresnel = FERRO_F0 + (1.0 - FERRO_F0) * pow(1.0 - facing, 5.0);
  float rim = pow(1.0 - clamp(abs(dot(rd, n)), 0.0, 1.0), 3.0) * smoothstep(0.85, 0.4, n.z);
  float fog = 1.0 - smoothstep(fogStart, far, t);

  float3 shine = 1.0 - exp(-(ferro_studio(r, rd, soft, u) * fresnel + u[10].rgb * rim * 0.35) * u[7].y);
  return ferro_finish(shine, fog, u);
}

// ---------------------------------------------------------------- Ghost Fibers
// Ported from React Bits by David Haz (https://reactbits.dev), used with permission (plan 194).
// The dots and the dust are instanced quads (plan 194 N2): every position
// comes from the instance and vertex ids, nothing is uploaded. GL and Metal
// agree on NDC (+y up) and on where a row lands, so the scene these rasterise
// has the orientation the full-screen passes write, and the bloom chain and
// the composite sample it in Metal's orientation as Plasma's chain does.
struct GhostVOut {
  float4 pos [[position]];
  float2 local;
  float radius;
  float segment;
  float3 light;
  float tint;
};

// React Bits' camera: the eye at z = 7.5 looking down −z through a 0.56 rad
// frustum (near 0.1, far 60), whose x, y and w are all a point needs here.
constant float GHOST_CAMERA = 7.5;
constant float GHOST_FRUSTUM = 3.4776037;
constant float GHOST_FOCAL = 1.73880;
constant float GHOST_RIBBON_LENGTH = 24.0;
constant float GHOST_DEPTH_SPREAD = 0.12;
constant float4 GHOST_PLACEMENTS[3] = { float4(0.0, 0.0, 0.0, 0.0), float4(1.9, -4.6, -0.08, 2.4), float4(-1.05, 2.0, 0.12, 4.1) };
constant float GHOST_RIBBON_GAIN[3] = { 1.0, 0.5, 0.55 };
constant float GHOST_RIBBON_TINT[3] = { 0.0, 0.75, 0.35 };

inline float ghost_hash11(float n) {
  return fract(sin(n * 91.3458) * 47453.5453);
}

// React Bits' `fit`: the canvas aspect over 1.5, clamped to 0.6–1.
inline float ghost_fit(constant float4* u) {
  return clamp(u[1].x / u[1].y / 1.5, 0.6, 1.0);
}

inline float3 ghost_project(float3 world, float2 viewport, thread float& depth) {
  depth = GHOST_CAMERA - world.z;
  float aspect = viewport.x / viewport.y;
  float2 ndc = float2(GHOST_FRUSTUM * world.x / aspect, GHOST_FRUSTUM * world.y) / depth;
  return float3((ndc * 0.5 + 0.5) * viewport, depth);
}

inline float2 ghost_quad_corner(uint vid) {
  return float2(vid == 1 || vid == 3 ? 1.0 : 0.0, vid >= 2 ? 1.0 : 0.0);
}

vertex GhostVOut ghost_fibers_dust_vertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                          constant float4* u [[buffer(0)]]) {
  float2 viewport = u[0].xy;
  float dpr = u[0].w;
  float uTime = u[0].z;
  float id = float(iid);
  float3 seed = float3(ghost_hash11(id * 1.37 + 0.3), ghost_hash11(id * 2.91 + 1.7), ghost_hash11(id * 4.17 + 2.9));
  float3 box = float3(9.0, 5.4, 6.0);
  float3 p = (seed - 0.5) * box;
  p.z -= 0.6;
  p += 0.18 * float3(sin(uTime * 0.21 + seed.x * 40.0), sin(uTime * 0.17 + seed.y * 40.0), sin(uTime * 0.13 + seed.z * 40.0));
  p *= mix(1.0, u[3].x * ghost_fit(u), 0.5);
  float depth;
  float3 projected = ghost_project(p, viewport, depth);
  float2 px = projected.xy;
  float size = u[8].x * mix(0.5, 1.4, ghost_hash11(id * 7.7));
  float baseRadius = max(0.5 * size * dpr * GHOST_CAMERA / max(depth, 0.1), 0.45);
  float coc = min(u[4].w * abs(1.0 - u[4].z / max(depth, 0.1)) * viewport.y * 0.035, 22.0 * dpr * 1.6);
  float radius = baseRadius + coc;
  float spill = max(10.0 * dpr, baseRadius);
  float energy = pow(baseRadius / min(radius, spill), 0.9) * pow(min(1.0, spill / radius), 2.0);
  float twinkle = pow(max(sin(uTime * (0.8 + 1.6 * seed.y) * 2.0 + seed.z * 50.0), 0.0), 8.0);
  // The intro is finished (React Bits' uIntro = 1).
  float intensity = energy * (0.35 + 0.65 * twinkle) * mix(0.4, 1.0, seed.x) * (depth > 0.2 ? 1.0 : 0.0);
  float2 corner = ghost_quad_corner(vid) * 2.0 - 1.0;
  float2 position = px + corner * radius;
  GhostVOut out;
  out.local = corner * radius;
  out.radius = radius;
  out.segment = 0.0;
  out.light = float3(intensity * 0.8 * u[8].y, 0.3 + 0.6 * twinkle * u[5].z, coc / max(radius, 1e-3));
  out.tint = u[6].y < 0.5 ? 0.45 + 0.55 * seed.y : seed.y;
  out.pos = float4(position / viewport * 2.0 - 1.0, 0.0, 1.0);
  return out;
}

inline float3 ghost_center_local(float s, float4 place, constant float4* u) {
  float t = u[0].z;
  float ph = place.w;
  float x = s * GHOST_RIBBON_LENGTH;
  float y = u[2].z * (0.52 * sin(x * 0.43 + t * 0.31 + ph) + 0.26 * sin(x * 0.79 - t * 0.23 + 1.3 + ph * 0.7)) + place.x + x * place.z;
  float z = u[2].z * 0.65 * sin(x * 0.33 + t * 0.19 + 0.7 + ph * 1.3) + place.y;
  return float3(x, y, z);
}

inline float ghost_twist_at(float s, float layer, float4 place, constant float4* u) {
  float x = s * GHOST_RIBBON_LENGTH;
  // The roll advances with the phase at the look's roll speed.
  float roll = u[0].z * u[2].y;
  return u[2].x * 0.483 * x + roll + place.w * 0.6 + layer * u[3].y * 0.42 + 0.5 * sin(x * 0.26 + u[0].z * 0.27 + place.w);
}

inline float3 ghost_ribbon_point(float s, float v, float n, float layer, float4 place, float3x3 orient,
                                 float scale, thread float3& normal, constant float4* u) {
  float3 c0 = ghost_center_local(s, place, u);
  float3 c1 = ghost_center_local(s + 0.004, place, u);
  float3 tangent = normalize(c1 - c0);
  float3 up = float3(0.0, 1.0, 0.0);
  float3 n0 = normalize(up - tangent * dot(up, tangent));
  float3 b0 = cross(tangent, n0);
  float th = ghost_twist_at(s, layer, place, u);
  float3 across = cos(th) * n0 + sin(th) * b0;
  float3 sheet = -sin(th) * n0 + cos(th) * b0;
  float halfWidth = u[2].w * (0.78 + 0.22 * cos(s * 3.14159));
  float3 local = c0 + across * v * halfWidth + sheet * (n + layer * u[3].y * 0.16) * halfWidth;
  normal = orient * sheet;
  return orient * (local * scale);
}

vertex GhostVOut ghost_fibers_dots_vertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                          constant float4* u [[buffer(0)]]) {
  float2 viewport = u[0].xy;
  float dpr = u[0].w;
  float uTime = u[0].z;
  float3x3 orient = float3x3(u[9].xyz, u[10].xyz, u[11].xyz);
  float scale = u[3].x * ghost_fit(u);
  float uFibers = u[3].z;
  float uDots = u[3].w;
  float uFlow = u[0].z * u[4].x;

  // One draw for every ribbon: the instance id names the ribbon, then the
  // fiber, then the bead (React Bits draws each ribbon with its own
  // uRibbon, uPlace, uGain and uTint).
  int perFiber = int(uDots);
  int perRibbon = int(uFibers) * perFiber;
  int ribbon = int(iid) / perRibbon;
  int withinRibbon = int(iid) - ribbon * perRibbon;
  int fiber = withinRibbon / perFiber;
  int bead = withinRibbon - fiber * perFiber;
  float uRibbon = float(ribbon);
  float4 place = GHOST_PLACEMENTS[ribbon];
  float uGain = GHOST_RIBBON_GAIN[ribbon] * u[5].w;
  float uTint = GHOST_RIBBON_TINT[ribbon];
  float fi = float(fiber);
  float fk = float(bead);

  float seed = ghost_hash11(fi * 1.731 + uRibbon * 17.0);
  float s = fract((fk + uFlow + seed * uDots) / uDots) - 0.5;
  float sNext = s + 1.0 / uDots;
  float layer = gl_mod(fi, 3.0) - 1.0;
  float slot = floor(fi / 3.0);
  float perLayer = max(floor(uFibers / 3.0), 1.0);
  float v = ((slot + 0.5) / perLayer) * 2.0 - 1.0 + (ghost_hash11(fi * 3.113 + 4.0) - 0.5) * (1.6 / perLayer) + layer * 0.12 / perLayer;
  float depthOffset = (ghost_hash11(fi * 7.919 + 2.0) - 0.5) * GHOST_DEPTH_SPREAD * (0.35 + 6.0 * s * s);

  float3 normal;
  float3 world = ghost_ribbon_point(s, v, depthOffset, layer, place, orient, scale, normal, u);
  float3 nextNormal;
  float3 nextWorld = ghost_ribbon_point(sNext, v, depthOffset, layer, place, orient, scale, nextNormal, u);

  float depth;
  float3 p0 = ghost_project(world, viewport, depth);
  float nextDepth;
  float3 p1 = ghost_project(nextWorld, viewport, nextDepth);
  // No hover parts the fibers (React Bits' uHover.w = 0).
  float2 px = p0.xy;
  float2 pxNext = p1.xy;

  float uSize = u[4].y;
  float uFocus = u[4].z;
  float uDof = u[4].w;
  float baseRadius = max(0.5 * uSize * dpr * GHOST_CAMERA / max(depth, 0.1), 0.45);
  float coc = min(uDof * abs(1.0 - uFocus / max(depth, 0.1)) * viewport.y * 0.035, u[5].x * dpr);
  float radius = baseRadius + coc;
  float spill = max(10.0 * dpr, baseRadius);
  float energy = pow(baseRadius / min(radius, spill), 1.25) * pow(min(1.0, spill / radius), 2.0);

  float3 toEye = normalize(float3(0.0, 0.0, GHOST_CAMERA) - world);
  float facing = abs(dot(normalize(normal), toEye));
  float focalPx = viewport.y * GHOST_FOCAL / max(depth, 0.1);
  float widthPx = 2.0 * u[2].w * scale * focalPx;
  float stack = (widthPx * facing + 2.0 * baseRadius) / (widthPx + 2.0 * baseRadius);
  float spacingFace = length(nextWorld - world) * focalPx;
  float trail = (length(p1.xy - p0.xy) + 2.0 * baseRadius) / (spacingFace + 2.0 * baseRadius);
  float crowd = sqrt(clamp(stack * trail, 0.002, 1.0));
  float fold = pow(1.0 - facing, 6.0) * u[6].z;
  float endFade = smoothstep(0.5, 0.4, abs(s)) * smoothstep(1.6, 4.2, depth);
  float uTips = u[6].x;
  float tipEnd = mix(0.6, 0.06 + 0.26 * ghost_hash11(fi * 9.137 + place.w * 3.0), uTips);
  // GLSL's pow((s - tipEnd) / 0.0065, 2.0): a negative base squared.
  float tip = exp(-sq((s - tipEnd) / 0.0065)) * uTips;
  endFade *= smoothstep(tipEnd + 0.003, tipEnd - 0.001, s);
  // The intro is finished (React Bits' appear = 1) and no click pulses.
  float uDotLength = u[5].y;
  float twinklePhase = ghost_hash11(fi * 13.7 + fk * 0.917 + uRibbon * 3.0);
  float twinkle = pow(max(sin(uTime * (1.2 + 2.6 * twinklePhase) * 3.0 + twinklePhase * 61.0), 0.0), 36.0) * u[5].z * (1.0 - 0.85 * uDotLength);
  float strength = mix(0.45, 1.0, ghost_hash11(fi * 5.37 + 1.0)) * mix(1.0, 0.72, abs(layer) * u[3].y);
  float intensity = energy * crowd * strength * endFade * 0.8 * uGain * (1.0 + fold * 7.0 + twinkle * 5.0 + tip * 7.0);
  float highlight = clamp(fold * 0.55 + twinkle + tip, 0.0, 1.0);

  float2 segment = (pxNext - px) * uDotLength;
  float segmentLength = length(segment);
  intensity *= mix(1.0, (2.0 * radius) / (segmentLength + 2.0 * radius) * 1.6, uDotLength);
  float2 axis = segmentLength > 1e-3 ? segment / segmentLength : float2(1.0, 0.0);
  float2 perp = float2(-axis.y, axis.x);
  float2 corner = ghost_quad_corner(vid);
  float along = mix(-radius, segmentLength + radius, corner.x);
  float across = mix(-radius, radius, corner.y);
  float2 position = px + axis * along + perp * across;

  GhostVOut out;
  out.local = float2(along, across);
  out.radius = radius;
  out.segment = segmentLength;
  out.light = float3(intensity, highlight, coc / max(radius, 1e-3));
  float depthTint = clamp(uTint + smoothstep(uFocus, uFocus + 5.0, depth) * 0.5, 0.0, 1.0);
  float uGradient = u[6].y;
  out.tint = uGradient < 0.5 ? depthTint : uGradient < 1.5 ? smoothstep(-0.42, 0.42, s) : clamp(v * 0.5 + 0.5, 0.0, 1.0);
  if (intensity < 0.0005) position = float2(-1e4);
  out.pos = float4(position / viewport * 2.0 - 1.0, 0.0, 1.0);
  return out;
}

// The dots' and the dust's fragments (additive, into the cleared scene).
fragment float4 ghost_fibers_dot(GhostVOut in [[stage_in]], constant float4* u [[buffer(0)]]) {
  float along = clamp(in.local.x, 0.0, in.segment);
  float d = length(float2(in.local.x - along, in.local.y));
  float rho = d / max(in.radius, 1e-3);
  if (rho > 1.0) discard_fragment();
  float soft = clamp(2.6 / max(in.radius, 1e-3), 0.14, 1.0);
  float disk = 1.0 - smoothstep(1.0 - soft, 1.0, rho);
  float bokeh = disk * (0.94 + 0.08 * smoothstep(0.55, 0.95, rho));
  float core = exp(-rho * rho * 3.2);
  float shape = mix(core, bokeh, smoothstep(0.25, 0.7, in.light.z));
  float3 color = mix(mix(u[12].rgb, u[14].rgb, in.tint), u[13].rgb, in.light.y);
  return float4(color * shape * in.light.x, shape * in.light.x);
}

inline float3 ghost_pick(texture2d<float> t0, sampler smp, float2 uv) {
  float3 c = t0.sample(smp, uv).rgb;
  float peak = max(max(c.r, c.g), c.b);
  return c * smoothstep(0.35, 1.2, peak);
}

fragment float4 ghost_fibers_bright(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]],
                                    texture2d<float> t0 [[texture(0)]], sampler smp [[sampler(0)]]) {
  float2 uv = in.pos.xy / u[0].xy;
  float2 o = 0.5 / float2(t0.get_width(), t0.get_height());
  float3 c = ghost_pick(t0, smp, uv + float2(-o.x, -o.y)) + ghost_pick(t0, smp, uv + float2(o.x, -o.y)) + ghost_pick(t0, smp, uv + float2(-o.x, o.y)) + ghost_pick(t0, smp, uv + float2(o.x, o.y));
  return float4(c * 0.25, 1.0);
}

fragment float4 ghost_fibers_down(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]],
                                  texture2d<float> t0 [[texture(0)]], sampler smp [[sampler(0)]]) {
  float2 uv = in.pos.xy / u[0].xy;
  float2 o = 1.0 / float2(t0.get_width(), t0.get_height());
  float3 c = t0.sample(smp, uv).rgb * 4.0;
  c += t0.sample(smp, uv + float2(-o.x, -o.y)).rgb;
  c += t0.sample(smp, uv + float2(o.x, -o.y)).rgb;
  c += t0.sample(smp, uv + float2(-o.x, o.y)).rgb;
  c += t0.sample(smp, uv + float2(o.x, o.y)).rgb;
  return float4(c / 8.0, 1.0);
}

fragment float4 ghost_fibers_up(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]],
                                texture2d<float> t0 [[texture(0)]], texture2d<float> t1 [[texture(1)]],
                                sampler smp [[sampler(0)]]) {
  float2 uv = in.pos.xy / u[0].xy;
  float2 o = 0.5 / float2(t0.get_width(), t0.get_height());
  float3 c = t0.sample(smp, uv + float2(-o.x * 2.0, 0.0)).rgb;
  c += t0.sample(smp, uv + float2(-o.x, o.y)).rgb * 2.0;
  c += t0.sample(smp, uv + float2(0.0, o.y * 2.0)).rgb;
  c += t0.sample(smp, uv + float2(o.x, o.y)).rgb * 2.0;
  c += t0.sample(smp, uv + float2(o.x * 2.0, 0.0)).rgb;
  c += t0.sample(smp, uv + float2(o.x, -o.y)).rgb * 2.0;
  c += t0.sample(smp, uv + float2(0.0, -o.y * 2.0)).rgb;
  c += t0.sample(smp, uv + float2(-o.x, -o.y)).rgb * 2.0;
  return float4(c / 12.0 + t1.sample(smp, uv).rgb, 1.0);
}

inline float ghost_smoother(float x) {
  x = clamp(x, 0.0, 1.0);
  return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

fragment float4 ghost_fibers_composite(LiveVOut in [[stage_in]], constant float4* u [[buffer(0)]],
                                       texture2d<float> t0 [[texture(0)]], texture2d<float> t1 [[texture(1)]],
                                       sampler smp [[sampler(0)]]) {
  // The scene and the bloom in Metal's orientation; the vignette is
  // symmetric, and only the grain hashes GLSL's fragment coordinate.
  float2 uv = in.pos.xy / u[0].xy;
  float2 vUv = gl_frag(in.pos, u[0].y) / u[0].xy;
  float4 scene = t0.sample(smp, uv);
  float3 bloom = t1.sample(smp, uv).rgb;
  float3 light = (scene.rgb + bloom * u[7].x) * u[7].y;
  float uVignette = u[7].w;
  float reach = max(uVignette * 0.3, 1e-4);
  float mask = uVignette > 0.0 ? ghost_smoother(vUv.x / reach) * ghost_smoother((1.0 - vUv.x) / reach) * ghost_smoother(vUv.y / reach) * ghost_smoother((1.0 - vUv.y) / reach) : 1.0;
  // The grain is fixed in place (React Bits moves it every frame).
  float2 cell = floor(vUv * u[0].xy / max(u[0].w, 1.0));
  float grain = hash12(cell) + hash12(cell * 1.31 + 9.1) - 1.0;
  float3 color = (1.0 - exp(-light * 1.25)) * mask;
  float peak = max(color.r, max(color.g, color.b));
  color = max(color + grain * u[7].z * (0.25 + 0.75 * sqrt(peak)), float3(0.0));
  float alpha = max(color.r, max(color.g, color.b));
  return float4((color + u[15].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}
"#;

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
        self.guard
            .record(tick.at, gpu_ms, tick.missed_deadline, tick.frame_interval);
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
    /// report 0/0. The guard keeps its level for that background.
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

    /// Plan 190 S2: every golden grid (the GLSL in WebGL2, 640 × 360 box
    /// filtered to 64 × 36) matches the MSL within a mean absolute error of
    /// 2.0 and a maximum cell error of 10 (0–255 units).
    #[test]
    fn golden_grids_match_the_glsl_reference() {
        let Some((mut renderer, _board)) = renderer() else {
            return;
        };
        let golden = load_golden();
        let mut worst: Vec<(&str, f64, u8)> = Vec::new();
        let mut failures = Vec::new();
        for frame in &golden.frames {
            let (mean, max) = golden_error(&mut renderer, &golden, frame);
            let name = format!("{}/{}@{}", frame.css, frame.look.id, frame.phase);
            eprintln!("golden {name}: mean {mean:.3}, max cell {max}");
            if mean > 2.0 || max > 10 {
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
                assert!(worst_mean <= 2.0 && worst_max <= 10, "{id:?} {name}");
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
    /// Half in between, and Still shows the poster with `gpu-budget`.
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
        renderer.inject_gpu_ms(Some(10.0));
        let mut renderings = Vec::new();
        for frame in 0..260_u32 {
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
        // Half rendered at half the internal size.
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
    /// 4K at full size and the soft four at 1080p; the guard's Half level
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
            assert_eq!((frame.width, frame.height), (1920, 1080), "{id:?}");
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
            let expected = if id == LiveBackgroundId::Dither {
                (3840, 2160)
            } else {
                (1920, 1080)
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
