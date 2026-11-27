
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
// The GLSL's `pcg` and `unit` (Beams, Color Bends, Ghost Fibers): PCG over
// whole numbers, then the top 24 bits as a value in [0, 1), the same bits on
// every GPU and API (#987, #1077).
inline uint live_pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
inline float live_unit(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }
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

inline float4 beams_permute(float4 x) {
  uint4 i = uint4(x);
  return float4((i * 34u + 1u) * i % 289u);
}
inline float4 beams_taylor_inv_sqrt(float4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
inline float3 beams_fade(float3 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

// The GLSL's `gradient`: the sevenths of a permutation split as whole
// numbers, the fold decided on them.
inline void beams_gradient(float4 p, thread float4& gx, thread float4& gy, thread float4& gz) {
  float4 q = floor((p + 0.5) / 7.0);
  float4 rx = p - 7.0 * q;
  float4 ry = q - 7.0 * floor((q + 0.5) / 7.0);
  gx = rx / 7.0;
  gy = ry / 7.0 - 0.5;
  gz = float4(0.5) - abs(gx) - abs(gy);
  float4 fold = step(7.0 - 2.0 * rx - abs(2.0 * ry - 7.0), float4(0.0));
  gx -= fold * (step(float4(0.0), gx) - 0.5);
  gy -= fold * (step(float4(0.0), gy) - 0.5);
}

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
  float4 gx0, gy0, gz0;
  beams_gradient(ixy0, gx0, gy0, gz0);
  float4 gx1, gy1, gz1;
  beams_gradient(ixy1, gx1, gy1, gz1);
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

inline float beams_lane_hash(float lane, uint salt, constant float4* u) {
  return live_unit(live_pcg(live_pcg(live_pcg(uint(int(lane) + 65536)) + as_type<uint>(u[4].x)) + salt));
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
  float along = local.y / u[2].y - beams_lane_hash(lane, 0u, u) * 60.0;
  float delta = 0.01;
  float slope = (beams_cnoise(float3(0.0, along + delta, uTime)) - beams_cnoise(float3(0.0, along - delta, uTime))) / (2.0 * delta);
  slope *= 0.2 * u[2].z;
  float spin = beams_lane_hash(lane, 1u, u);
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

inline float beams_random(float2 st, uint salt) {
  return live_unit(live_pcg(live_pcg(live_pcg(uint(st.x)) + uint(st.y)) + salt));
}

inline float beams_grain_noise(float2 st) {
  float2 i = floor(st);
  float2 f = fract(st);
  float a = beams_random(i, 0u);
  float b = beams_random(i + float2(1.0, 0.0), 0u);
  float c = beams_random(i + float2(0.0, 1.0), 0u);
  float d = beams_random(i + float2(1.0, 1.0), 0u);
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
  float jitter = (beams_random(frag, 1u) - 0.5) / 255.0;
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
    float n = live_unit(live_pcg(live_pcg(uint(frag.x)) + uint(frag.y)));
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

inline float ghost_hash11(uint a, uint b, uint c, uint salt) {
  return live_unit(live_pcg(live_pcg(live_pcg(live_pcg(a) + b) + c) + salt));
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
  float3 seed = float3(ghost_hash11(iid, 0u, 0u, 1u), ghost_hash11(iid, 0u, 0u, 2u), ghost_hash11(iid, 0u, 0u, 3u));
  float3 box = float3(9.0, 5.4, 6.0);
  float3 p = (seed - 0.5) * box;
  p.z -= 0.6;
  p += 0.18 * float3(sin(uTime * 0.21 + seed.x * 40.0), sin(uTime * 0.17 + seed.y * 40.0), sin(uTime * 0.13 + seed.z * 40.0));
  p *= mix(1.0, u[3].x * ghost_fit(u), 0.5);
  float depth;
  float3 projected = ghost_project(p, viewport, depth);
  float2 px = projected.xy;
  float size = u[8].x * mix(0.5, 1.4, ghost_hash11(iid, 0u, 0u, 4u));
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
  float4 place = GHOST_PLACEMENTS[ribbon];
  float uGain = GHOST_RIBBON_GAIN[ribbon] * u[5].w;
  float uTint = GHOST_RIBBON_TINT[ribbon];
  float fi = float(fiber);
  float fk = float(bead);
  uint fiberId = uint(fiber);
  uint beadId = uint(bead);
  uint ribbonId = uint(ribbon);

  float seed = ghost_hash11(fiberId, ribbonId, 0u, 1u);
  float s = fract((fk + uFlow + seed * uDots) / uDots) - 0.5;
  float sNext = s + 1.0 / uDots;
  float layer = gl_mod(fi, 3.0) - 1.0;
  float slot = floor(fi / 3.0);
  float perLayer = max(floor(uFibers / 3.0), 1.0);
  float v = ((slot + 0.5) / perLayer) * 2.0 - 1.0 + (ghost_hash11(fiberId, 0u, 0u, 2u) - 0.5) * (1.6 / perLayer) + layer * 0.12 / perLayer;
  float depthOffset = (ghost_hash11(fiberId, 0u, 0u, 3u) - 0.5) * GHOST_DEPTH_SPREAD * (0.35 + 6.0 * s * s);

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
  float tipEnd = mix(0.6, 0.06 + 0.26 * ghost_hash11(fiberId, ribbonId, 0u, 4u), uTips);
  // GLSL's pow((s - tipEnd) / 0.0065, 2.0): a negative base squared.
  float tip = exp(-sq((s - tipEnd) / 0.0065)) * uTips;
  endFade *= smoothstep(tipEnd + 0.003, tipEnd - 0.001, s);
  // The intro is finished (React Bits' appear = 1) and no click pulses.
  float uDotLength = u[5].y;
  float twinklePhase = ghost_hash11(fiberId, beadId, ribbonId, 5u);
  float twinkle = pow(max(sin(uTime * (1.2 + 2.6 * twinklePhase) * 3.0 + twinklePhase * 61.0), 0.0), 36.0) * u[5].z * (1.0 - 0.85 * uDotLength);
  float strength = mix(0.45, 1.0, ghost_hash11(fiberId, 0u, 0u, 6u)) * mix(1.0, 0.72, abs(layer) * u[3].y);
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
