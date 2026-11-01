#version 300 es
// Dither, from React Bits by David Haz (https://reactbits.dev, MIT + Commons
// Clause), used in Videorc with the author's permission. Adapted for Videorc
// (plan 194): the pointer trail, the click ripples and the intro reveal are
// gone (N3), the colours are look constants, and uniforms are packed into
// `u` (layout in live_background/mod.rs). It is opaque: the look's
// background colour is the base.
//
// Passes: VIDEORC_PASS_WAVE renders the wave field, one texel per dither cell
// (sizes::dither_field_size); the default pass dithers it (t0, fetched by
// texel) at full size, since its pattern is per pixel.
//
// u[2] = (wave speed, wave frequency, wave amplitude, scale)
// u[3] = (contrast, brightness, pixel size in CSS px, dither mode)
// u[4] = (colour levels, palette count, 0, 0)
// u[5] = wave colour (linear), u[6] = background colour (linear)
// u[7..15) = the palette (linear; React Bits' MAX_PALETTE = 8)
precision highp float;
precision highp int;

uniform vec4 u[16];
uniform sampler2D t0;
out vec4 outColor;

// One cell in render pixels: the look's pixel size in CSS pixels (one is
// min(view) / 1080 render pixels), at least one. sizes::dither_cell.
float cellSize() {
  return max(1.0, floor(u[3].z * u[0].w + 0.5));
}

#ifdef VIDEORC_PASS_WAVE
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec2 fade(vec2 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

float cnoise(vec2 P) {
  vec4 Pi = floor(P.xyxy) + vec4(0.0, 0.0, 1.0, 1.0);
  vec4 Pf = fract(P.xyxy) - vec4(0.0, 0.0, 1.0, 1.0);
  Pi = mod289(Pi);
  vec4 ix = Pi.xzxz;
  vec4 iy = Pi.yyww;
  vec4 fx = Pf.xzxz;
  vec4 fy = Pf.yyww;
  vec4 i = permute(permute(ix) + iy);
  vec4 gx = fract(i * (1.0 / 41.0)) * 2.0 - 1.0;
  vec4 gy = abs(gx) - 0.5;
  vec4 tx = floor(gx + 0.5);
  gx = gx - tx;
  vec2 g00 = vec2(gx.x, gy.x);
  vec2 g10 = vec2(gx.y, gy.y);
  vec2 g01 = vec2(gx.z, gy.z);
  vec2 g11 = vec2(gx.w, gy.w);
  vec4 norm = taylorInvSqrt(vec4(dot(g00, g00), dot(g01, g01), dot(g10, g10), dot(g11, g11)));
  g00 *= norm.x;
  g01 *= norm.y;
  g10 *= norm.z;
  g11 *= norm.w;
  float n00 = dot(g00, vec2(fx.x, fy.x));
  float n10 = dot(g10, vec2(fx.y, fy.y));
  float n01 = dot(g01, vec2(fx.z, fy.z));
  float n11 = dot(g11, vec2(fx.w, fy.w));
  vec2 fadeXY = fade(Pf.xy);
  vec2 nx = mix(vec2(n00, n01), vec2(n10, n11), fadeXY.x);
  return 2.3 * mix(nx.x, nx.y, fadeXY.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amp = 1.0;
  for (int i = 0; i < 4; i++) {
    value += amp * abs(cnoise(p));
    p *= u[2].y;
    amp *= u[2].z;
  }
  return value;
}

float pattern(vec2 p) {
  vec2 p2 = p - u[0].z * u[2].x;
  return fbm(p + fbm(p2));
}

void main() {
  float ratio = u[0].w;
  float cell = cellSize();
  // React Bits works in CSS pixels here: the canvas over its device ratio.
  vec2 uResolution = u[1].xy / ratio;
  float uCell = cell / ratio;
  vec2 corner = (gl_FragCoord.xy - 0.5) * uCell;
  vec2 uv = corner / uResolution - 0.5;
  uv.x *= uResolution.x / uResolution.y;

  // No trail, no ripples (N3).
  float f = pattern(uv / u[2].w);
  f = (f - 0.5) * u[3].x + 0.5 + u[3].y;
  // The intro reveal is finished (React Bits' show = 1).
  float v = clamp(f, 0.0, 1.0);
  outColor = vec4(floor(v * 255.0) / 255.0, fract(v * 255.0), 0.0, 1.0);
}
#else
const float bayer8[64] = float[64](
  0.0 / 64.0, 48.0 / 64.0, 12.0 / 64.0, 60.0 / 64.0, 3.0 / 64.0, 51.0 / 64.0, 15.0 / 64.0, 63.0 / 64.0,
  32.0 / 64.0, 16.0 / 64.0, 44.0 / 64.0, 28.0 / 64.0, 35.0 / 64.0, 19.0 / 64.0, 47.0 / 64.0, 31.0 / 64.0,
  8.0 / 64.0, 56.0 / 64.0, 4.0 / 64.0, 52.0 / 64.0, 11.0 / 64.0, 59.0 / 64.0, 7.0 / 64.0, 55.0 / 64.0,
  40.0 / 64.0, 24.0 / 64.0, 36.0 / 64.0, 20.0 / 64.0, 43.0 / 64.0, 27.0 / 64.0, 39.0 / 64.0, 23.0 / 64.0,
  2.0 / 64.0, 50.0 / 64.0, 14.0 / 64.0, 62.0 / 64.0, 1.0 / 64.0, 49.0 / 64.0, 13.0 / 64.0, 61.0 / 64.0,
  34.0 / 64.0, 18.0 / 64.0, 46.0 / 64.0, 30.0 / 64.0, 33.0 / 64.0, 17.0 / 64.0, 45.0 / 64.0, 29.0 / 64.0,
  10.0 / 64.0, 58.0 / 64.0, 6.0 / 64.0, 54.0 / 64.0, 9.0 / 64.0, 57.0 / 64.0, 5.0 / 64.0, 53.0 / 64.0,
  42.0 / 64.0, 26.0 / 64.0, 38.0 / 64.0, 22.0 / 64.0, 41.0 / 64.0, 25.0 / 64.0, 37.0 / 64.0, 21.0 / 64.0
);

const float bayer4[16] = float[16](
  0.0 / 16.0, 8.0 / 16.0, 2.0 / 16.0, 10.0 / 16.0,
  12.0 / 16.0, 4.0 / 16.0, 14.0 / 16.0, 6.0 / 16.0,
  3.0 / 16.0, 11.0 / 16.0, 1.0 / 16.0, 9.0 / 16.0,
  15.0 / 16.0, 7.0 / 16.0, 13.0 / 16.0, 5.0 / 16.0
);

const float bayer2[4] = float[4](0.0 / 4.0, 2.0 / 4.0, 3.0 / 4.0, 1.0 / 4.0);

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// React Bits' MODES: bayer 0, bayer4 1, bayer2 2, halftone 3, lines 4,
// crosshatch 5, noise 6, none 7.
float threshold(vec2 cell) {
  int mode = int(u[3].w + 0.5);
  if (mode == 1) {
    ivec2 c = ivec2(mod(cell, 4.0));
    return bayer4[c.y * 4 + c.x];
  }
  if (mode == 2) {
    ivec2 c = ivec2(mod(cell, 2.0));
    return bayer2[c.y * 2 + c.x];
  }
  if (mode == 3) {
    vec2 r = vec2(cell.x + cell.y, cell.x - cell.y) * 0.70710678 / 4.0;
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
    return fract(52.9829189 * fract(dot(cell, vec2(0.06711056, 0.00583715))));
  }
  if (mode == 7) {
    return 0.25;
  }
  ivec2 c = ivec2(mod(cell, 8.0));
  return bayer8[c.y * 8 + c.x];
}

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 cell = floor(gl_FragCoord.xy / cellSize());
  ivec2 fieldSize = textureSize(t0, 0);
  vec4 sampleValue = texelFetch(t0, clamp(ivec2(cell), ivec2(0), fieldSize - 1), 0);
  float f = sampleValue.r + sampleValue.g / 255.0;
  float t = threshold(cell) - 0.25;
  float paletteCount = u[4].y;
  vec3 color;

  if (paletteCount > 1.5) {
    float n = paletteCount;
    float v = f + t / (n - 1.0);
    v = clamp(v - mix(0.2, 0.0, smoothstep(0.45, 0.8, v)), 0.0, 1.0);
    int index = int(floor(v * (n - 1.0) + 0.5));
    color = toSrgb(u[7 + index].rgb);
  } else {
    float levels = max(u[4].x, 1.01) - 1.0;
    vec3 wave = u[5].rgb;
    vec3 background = u[6].rgb;
    float base = dot(background, LUMA);
    vec3 offset = (wave - vec3(base)) * f + t / levels;
    float luminance = dot(background + offset, LUMA);
    offset -= mix(0.2, 0.0, smoothstep(0.45, 0.8, luminance));
    bool rising = dot(wave, LUMA) >= base;
    float lower = rising ? 0.0 : -max(background.r, max(background.g, background.b));
    float upper = rising ? 1.0 - min(background.r, min(background.g, background.b)) : 0.0;
    offset = floor(clamp(offset, lower, upper) * levels + 0.5) / levels;
    color = toSrgb(background + offset);
  }
  outColor = vec4(color * (1.0 - u[1].z), 1.0);
}
#endif
