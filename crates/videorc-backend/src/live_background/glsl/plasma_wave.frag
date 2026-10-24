#version 300 es
// Plasma Wave, from React Bits by David Haz (https://reactbits.dev, MIT +
// Commons Clause), used in Videorc with the author's permission. Adapted for
// Videorc (plan 190): the mouse heat and the intro are constants, dark mode
// only, float targets only (React Bits' range = 1), drawn opaque over the
// look's base colour, and uniforms are packed into `u` (layout in
// live_background/mod.rs).
//
// Passes (define one): VIDEORC_PASS_COARSE traces at a third of the fine size;
// VIDEORC_PASS_FINE re-traces only near edges, else samples the coarse trace
// (t0); VIDEORC_PASS_DOWN and VIDEORC_PASS_UP build the bloom chain (t0 the
// source, t1 the matching down level for UP); the default pass composites the
// fine light (t0) and the bloom (t1).
precision highp float;

uniform vec4 u[9];
uniform sampler2D t0;
uniform sampler2D t1;
out vec4 outColor;

const float PI = 3.14159265;
const float TAU = 6.28318531;
const float HALF_PI = 1.5707963;

#if defined(VIDEORC_PASS_COARSE) || defined(VIDEORC_PASS_FINE)
vec4 traceLight(vec2 pixel) {
  vec2 view = u[1].xy;
  vec2 coord = pixel - 0.5 * view;
  float c = cos(u[2].x);
  float sn = sin(u[2].x);
  coord = mat2(c, -sn, sn, c) * coord;
  vec3 dir = normalize(vec3(coord / view.y, u[2].y));
  vec3 o = vec3(0.0, 0.0, -7.0);
  float t = u[0].z * PI;
  float t1 = t * 0.7;
  float t2 = t * 0.9;
  float tSpeed1 = t * u[2].z;
  float tSpeed2 = t * u[2].w * u[3].x;
  float bend1 = u[3].y;
  float bend2 = u[3].z;
  float thickness = u[3].w;
  vec3 heat = u[7].xyz;
  float s = 1.0;
  float d = 0.0;
  vec2 k = vec2(0.0);
  for (int i = 0; i < 14; ++i) {
    vec3 p = o + dir * d;
    p.x -= 15.0;
    float px = p.x;
    float heatOffset = (px - heat.x) / heat.z;
    float swell = heat.y * exp(-heatOffset * heatOffset);
    float wob1 = bend1 + swell * (0.16 + 0.2 * bend1) + sin(t1 + px * 0.8) * 0.1;
    float wob2 = bend2 + swell * (0.16 + 0.2 * bend2) + cos(t2 + px * 1.1) * 0.1;
    vec2 a = sin(vec2(px, px + HALF_PI) + tSpeed1) * wob1;
    vec2 b = cos(vec2(px, px + HALF_PI) + tSpeed2) * wob2;
    float cut = px + thickness;
    k.x = max(cut, length(p.yz - a) - thickness);
    k.y = max(cut, length(p.yz - b) - thickness);
    s = min(s, min(k.x, k.y));
    if (s < 0.001 || d > 300.0) break;
    d += s * 0.7;
  }
  vec3 raw = max(cos(d * TAU) - s * sqrt(d) - vec3(k, 0.0), 0.0);
  float field = max(raw.r, max(raw.g, raw.b));
  raw.gb += 0.1;
  raw = raw * 0.4 + raw.brg * 0.6 + raw * raw;
  float lum = dot(raw, vec3(0.299, 0.587, 0.114));
  float w1 = max(0.0, 1.0 - k.x * 2.0) + 0.0001;
  float w2 = max(0.0, 1.0 - k.y * 2.0) + 0.0001;
  vec3 base = (u[5].rgb * w1 + u[6].rgb * w2) / (w1 + w2);
  float soft = smoothstep(0.03, 0.36, field);
  float hot = smoothstep(0.32, 0.8, field);
  vec3 light = base * lum * 2.6 * soft + mix(base, vec3(1.0), 0.55) * hot * u[4].x * 2.0;
  return vec4(light, field);
}
#endif

#if defined(VIDEORC_PASS_COARSE)
void main() {
  outColor = traceLight(gl_FragCoord.xy * (u[1].xy / u[0].xy));
}
#elif defined(VIDEORC_PASS_FINE)
void main() {
  vec2 coarseSize = vec2(textureSize(t0, 0));
  vec2 uv = gl_FragCoord.xy / u[0].xy;
  vec2 pos = uv * coarseSize - 0.5;
  ivec2 cell = ivec2(floor(pos));
  ivec2 last = ivec2(coarseSize) - 1;
  float a = texelFetch(t0, clamp(cell, ivec2(0), last), 0).a;
  float b = texelFetch(t0, clamp(cell + ivec2(1, 0), ivec2(0), last), 0).a;
  float c = texelFetch(t0, clamp(cell + ivec2(0, 1), ivec2(0), last), 0).a;
  float d = texelFetch(t0, clamp(cell + ivec2(1, 1), ivec2(0), last), 0).a;
  float high = max(max(a, b), max(c, d));
  float low = min(min(a, b), min(c, d));
  if (high > 0.02 && low < 0.4) outColor = traceLight(gl_FragCoord.xy * (u[1].xy / u[0].xy));
  else outColor = texture(t0, uv);
}
#elif defined(VIDEORC_PASS_DOWN)
void main() {
  vec2 uv = gl_FragCoord.xy / u[0].xy;
  vec2 texel = 1.0 / vec2(textureSize(t0, 0));
  vec4 sum = texture(t0, uv) * 4.0;
  sum += texture(t0, uv - texel);
  sum += texture(t0, uv + texel);
  sum += texture(t0, uv + vec2(texel.x, -texel.y));
  sum += texture(t0, uv - vec2(texel.x, -texel.y));
  outColor = sum / 8.0;
}
#elif defined(VIDEORC_PASS_UP)
void main() {
  vec2 uv = gl_FragCoord.xy / u[0].xy;
  vec2 h = 0.5 / vec2(textureSize(t0, 0));
  vec4 sum = texture(t0, uv + vec2(-h.x * 2.0, 0.0));
  sum += texture(t0, uv + vec2(h.x * 2.0, 0.0));
  sum += texture(t0, uv + vec2(0.0, -h.y * 2.0));
  sum += texture(t0, uv + vec2(0.0, h.y * 2.0));
  sum += texture(t0, uv + vec2(-h.x, h.y)) * 2.0;
  sum += texture(t0, uv + h) * 2.0;
  sum += texture(t0, uv + vec2(h.x, -h.y)) * 2.0;
  sum += texture(t0, uv - h) * 2.0;
  outColor = sum / 12.0 + texture(t1, uv);
}
#else
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u[0].xy;
  float exposure = u[4].y;
  vec3 hdr = texture(t0, uv).rgb * exposure;
  hdr += texture(t1, uv).rgb * exposure * u[4].z * 0.18;
  float grain = (hash(gl_FragCoord.xy + fract(u[0].z * 7.31) * 113.0) - 0.5) * u[4].w;
  vec3 mapped = 1.0 - exp(-hdr);
  float level = max(mapped.r, max(mapped.g, mapped.b));
  mapped = clamp(mapped + grain * level, 0.0, 1.0) * u[5].w;
  float alpha = max(mapped.r, max(mapped.g, mapped.b));
  outColor = vec4((mapped + u[8].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}
#endif
