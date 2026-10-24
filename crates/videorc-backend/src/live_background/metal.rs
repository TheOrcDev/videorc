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
//! The MSL below is a hand port of `glsl/*.frag` (the source of truth), checked
//! against golden grids rendered from the GLSL in WebGL2
//! (`tests/fixtures/live-background-golden.json`). Porting rules (plan 190):
//! GLSL's `gl_FragCoord` is bottom-left and Metal's position top-left, so every
//! pass flips y first (`gl_frag`); a scratch texture one pass wrote is read by
//! the next with `1 - v` (or `last.y - y` for a texel fetch); `mod` is not
//! `fmod`; no `pow` of a negative base.
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

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_foundation::NSString;
use objc2_metal::{
    MTLBlitCommandEncoder, MTLCommandBuffer, MTLCommandBufferStatus, MTLCommandEncoder,
    MTLCommandQueue, MTLDevice, MTLLibrary, MTLLoadAction, MTLPixelFormat, MTLPrimitiveType,
    MTLRenderCommandEncoder, MTLRenderPassDescriptor, MTLRenderPipelineDescriptor,
    MTLRenderPipelineState, MTLResource, MTLSamplerAddressMode, MTLSamplerDescriptor,
    MTLSamplerMinMagFilter, MTLSamplerMipFilter, MTLSamplerState, MTLStorageMode, MTLStoreAction,
    MTLTexture, MTLTextureDescriptor, MTLTextureUsage,
};

use super::glsl::LivePass;
use super::{
    GuardLevel, LiveBackgroundBoard, LiveBackgroundFrameInput, LiveBackgroundGuard, LiveLook,
    Uniforms, internal_size, plasma_sizes, silk_field_size, uniforms,
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
/// Plasma Wave's fine trace and bloom chain: nothing reads their alpha, so
/// three packed float channels (renderable and filterable on every macOS GPU)
/// hold the HDR light in half the bytes of `RGBA16Float`. The golden grids
/// pass with it; `plasma_light_formats_both_match_the_goldens` prints what
/// `RGBA16Float` would change (the WebGL reference renders in `RGBA16F`).
pub const PLASMA_LIGHT_FORMAT: MTLPixelFormat = MTLPixelFormat::RG11B10Float;

/// The MSL for every pass of the five backgrounds, compiled at runtime the
/// first time a leg needs a live background (this Mac has no offline Metal
/// toolchain; `metal_compositor.rs` does the same for the scene shader).
pub const LIVE_BACKGROUND_MSL: &str = r#"
#include <metal_stdlib>
using namespace metal;

// Live backgrounds (plan 190). Every pass reads the same nine float4s
// (live_background/mod.rs): u[0] = (target w, h, phase, pixel scale),
// u[1] = (view w, h, dim, 0), u[2..9] = the look's constants. GLSL's
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
inline float sq(float x) { return x * x; }
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
"#;

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
    }
}

/// The format of a pass's render target; the Plasma light passes follow the
/// renderer's (test-selectable) light format.
fn pass_format(pass: LivePass, plasma_light: MTLPixelFormat) -> MTLPixelFormat {
    match pass {
        LivePass::SilkField => SILK_FIELD_FORMAT,
        LivePass::PlasmaCoarse => PLASMA_COARSE_FORMAT,
        LivePass::PlasmaFine | LivePass::PlasmaDown | LivePass::PlasmaUp => plasma_light,
        LivePass::SilkComposite
        | LivePass::SideRays
        | LivePass::PlasmaComposite
        | LivePass::LiquidChrome
        | LivePass::LineWaves => FRAME_FORMAT,
    }
}

/// This tick's live frame, ready for the compose to draw as the background.
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
}

/// The textures a background holds at one internal size: its live frame and
/// its scratch. Rebuilt when the background or the size changes.
struct Targets {
    id: LiveBackgroundId,
    view: (u32, u32),
    frame: Retained<MetalTexture>,
    scratch: Scratch,
    bytes: u64,
}

/// The passes of one draw, with retained clones of the textures they touch.
enum DrawPlan {
    Silk {
        field: Retained<MetalTexture>,
    },
    Plasma {
        coarse: Retained<MetalTexture>,
        fine: Retained<MetalTexture>,
        down: Vec<Retained<MetalTexture>>,
        up: Vec<Retained<MetalTexture>>,
    },
    Single(LivePass),
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
    guard: LiveBackgroundGuard,
    pending: Option<PendingCommandBuffer>,
    reported_status: Option<LiveBackgroundStatus>,
    reported_resources: (u32, u64),
    resources_warned: bool,
    /// `PLASMA_LIGHT_FORMAT`, unless a test compares the alternative.
    plasma_light_format: MTLPixelFormat,
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
            guard: LiveBackgroundGuard::new(),
            pending: None,
            reported_status: None,
            reported_resources: (0, 0),
            resources_warned: false,
            plasma_light_format: PLASMA_LIGHT_FORMAT,
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
        let gpu_ms = self.take_last_gpu_ms();
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
        let view = internal_size(draw.id, draw.output, draw.level);
        // Pipelines first: a background whose shader won't build allocates
        // nothing.
        for pass in super::glsl::passes(draw.id) {
            self.pipeline(*pass)?;
        }
        self.ensure_targets(draw.id, view)?;
        let command_buffer = self.queue.commandBuffer().ok_or(DrawError::Resources)?;
        command_buffer.setLabel(Some(&NSString::from_str("videorc-live-background")));
        // Retained clones of the targets, so the passes below can borrow the
        // renderer mutably (a clone is one retain).
        let (frame, plan) = {
            let targets = self.targets.as_ref().ok_or(DrawError::Resources)?;
            let plan = match &targets.scratch {
                Scratch::Silk { field } => DrawPlan::Silk {
                    field: field.clone(),
                },
                Scratch::Plasma {
                    coarse,
                    fine,
                    down,
                    up,
                } => DrawPlan::Plasma {
                    coarse: coarse.clone(),
                    fine: fine.clone(),
                    down: down.clone(),
                    up: up.clone(),
                },
                Scratch::None => DrawPlan::Single(match draw.id {
                    LiveBackgroundId::SideRays => LivePass::SideRays,
                    LiveBackgroundId::LiquidChrome => LivePass::LiquidChrome,
                    _ => LivePass::LineWaves,
                }),
            };
            (targets.frame.clone(), plan)
        };
        let look = draw.look;
        let (phase, dim) = (draw.phase, draw.dim);
        match plan {
            DrawPlan::Silk { field } => {
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
            DrawPlan::Plasma {
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
            DrawPlan::Single(pass) => {
                self.encode(
                    &command_buffer,
                    pass,
                    &frame,
                    &uniforms(look, view, view, phase, dim),
                    &[],
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

    /// The live background went away: free every texture and pipeline and
    /// report 0/0. The guard keeps its level for the rest of the run.
    pub fn release(&mut self) {
        if self.holds_resources() {
            self.drop_resources();
        }
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

    fn pipeline(&mut self, pass: LivePass) -> Result<Retained<MetalPipeline>, DrawError> {
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
        let format = pass_format(pass, self.plasma_light_format);
        let Some(vertex) = library.newFunctionWithName(&NSString::from_str("live_vertex")) else {
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

    fn ensure_targets(&mut self, id: LiveBackgroundId, view: (u32, u32)) -> Result<(), DrawError> {
        if self
            .targets
            .as_ref()
            .is_some_and(|targets| targets.id == id && targets.view == view)
        {
            return Ok(());
        }
        self.targets = None;
        let frame = self.texture(FRAME_FORMAT, view, false)?;
        let mut bytes = frame.allocatedSize() as u64;
        let scratch = match id {
            LiveBackgroundId::Silk => {
                let field = self.texture(SILK_FIELD_FORMAT, silk_field_size(view), true)?;
                bytes += field.allocatedSize() as u64;
                Scratch::Silk { field }
            }
            LiveBackgroundId::PlasmaWave => {
                let sizes = plasma_sizes(view);
                let light = self.plasma_light_format;
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
            LiveBackgroundId::SideRays
            | LiveBackgroundId::LiquidChrome
            | LiveBackgroundId::LineWaves => Scratch::None,
        };
        self.targets = Some(Targets {
            id,
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

    /// One full-screen pass into `target`.
    fn encode(
        &mut self,
        command_buffer: &MetalCommandBuffer,
        pass: LivePass,
        target: &MetalTexture,
        uniforms: &Uniforms,
        textures: &[&MetalTexture],
    ) -> Result<(), DrawError> {
        let pipeline = self.pipeline(pass)?;
        let descriptor = MTLRenderPassDescriptor::new();
        let attachment = unsafe { descriptor.colorAttachments().objectAtIndexedSubscript(0) };
        attachment.setTexture(Some(target));
        attachment.setLoadAction(MTLLoadAction::DontCare);
        attachment.setStoreAction(MTLStoreAction::Store);
        let encoder = command_buffer
            .renderCommandEncoderWithDescriptor(&descriptor)
            .ok_or(DrawError::Resources)?;
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

    /// Tests compare Plasma Wave's light format; a change rebuilds its
    /// pipelines and scratch.
    #[cfg(test)]
    pub(crate) fn set_plasma_light_format(&mut self, format: MTLPixelFormat) {
        if self.plasma_light_format != format {
            self.plasma_light_format = format;
            self.drop_resources();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use base64::Engine as _;

    use super::*;
    use crate::live_background::runtime::{LiveBackgroundTick, sync};
    use crate::live_background::{ALL_LIVE_BACKGROUNDS, css_id, look_or_first, looks};
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

    /// The fixture: 30 grids rendered from the GLSL in WebGL2.
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
        assert_eq!(frames.len(), 30);
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

    /// The choice of Plasma Wave's light format, measured: the WebGL
    /// reference renders in `RGBA16F`; Videorc's `RG11B10Float` halves the
    /// bytes. Both must match the goldens; the numbers go in "As built".
    #[test]
    fn plasma_light_formats_both_match_the_goldens() {
        let Some((mut renderer, _board)) = renderer() else {
            return;
        };
        let golden = load_golden();
        for (name, format) in [
            ("RG11B10Float", MTLPixelFormat::RG11B10Float),
            ("RGBA16Float", MTLPixelFormat::RGBA16Float),
        ] {
            renderer.set_plasma_light_format(format);
            let (mut worst_mean, mut worst_max) = (0.0_f64, 0_u8);
            for frame in golden
                .frames
                .iter()
                .filter(|frame| frame.id == LiveBackgroundId::PlasmaWave)
            {
                let (mean, max) = golden_error(&mut renderer, &golden, frame);
                worst_mean = worst_mean.max(mean);
                worst_max = worst_max.max(max);
            }
            let (_, bytes) = renderer.resources();
            eprintln!(
                "plasma light {name}: worst mean {worst_mean:.3}, worst max cell {worst_max}, {bytes} scratch bytes at 640x360"
            );
            assert!(worst_mean <= 2.0 && worst_max <= 10, "{name}");
        }
        renderer.set_plasma_light_format(PLASMA_LIGHT_FORMAT);
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

    /// The live frame's GPU time per background at 1080p and 4K (median of
    /// 60 frames), for the plan's "As built". Informational: this machine is
    /// shared, so the numbers are not asserted.
    #[test]
    fn live_frame_gpu_times() {
        let Some((mut renderer, _board)) = renderer() else {
            return;
        };
        for id in ALL_LIVE_BACKGROUNDS {
            let look = &looks(id)[0];
            for output in [(1920_u32, 1080_u32), (3840, 2160)] {
                let mut times = Vec::new();
                for frame in 0..70_u32 {
                    let phase = look.poster_phase + f64::from(frame) / 60.0 * look.rate;
                    let live = renderer
                        .draw(&LiveDraw {
                            id,
                            look,
                            phase,
                            dim: 0.0,
                            output,
                            level: GuardLevel::Full,
                        })
                        .expect("renders");
                    let ms = renderer.wait_last_draw().expect("timed");
                    if frame >= 10 {
                        times.push(ms);
                    }
                    let _ = live;
                }
                times.sort_by(f64::total_cmp);
                let median = times[times.len() / 2];
                let p95 = times[(times.len() as f64 * 0.95) as usize - 1];
                let (_, bytes) = renderer.resources();
                eprintln!(
                    "live frame {:?} at {}x{}: median {median:.2} ms, p95 {p95:.2} ms, {bytes} scratch bytes",
                    id, output.0, output.1
                );
            }
        }
    }
}
