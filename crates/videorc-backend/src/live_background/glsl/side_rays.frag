#version 300 es
// Side Rays, from React Bits by David Haz (https://reactbits.dev, MIT +
// Commons Clause), used in Videorc with the author's permission. Adapted for
// Videorc (plan 190): mouse follow and the intro reveal are constants, dark
// mode only, drawn opaque over the look's base colour, and uniforms are packed
// into `u` (layout in live_background/mod.rs).
precision highp float;

uniform vec4 u[9];
out vec4 outColor;

float sq(float x) {
  return x * x;
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

float shafts(float x, float t, float seed, float aa) {
  float sway = (0.4 * sin(t * 0.31 + seed) + 0.24 * sin(t * 0.17 + seed * 2.3)) * u[7].w;
  float n = 0.7 * noise(vec2(x + sway + seed, t * 0.3)) + 0.3 * noise(vec2(x * 2.4 + sway * 1.5 + seed * 1.7, t * 0.45 + 3.0));
  float width = mix(0.5, 0.1, u[4].z);
  float s = mix(smoothstep(0.5 - width, 0.5 + width, n), 0.5, aa);
  return mix(0.05, 1.0, s);
}

float motes(vec2 p, float cell, float t, float seed) {
  p += vec2(t * 0.021, -t * 0.013) + seed * 7.31;
  vec2 grid = p / cell;
  vec2 id = floor(grid);
  vec2 f = grid - id;
  float h = hash(id + seed);
  if (h > 0.5) return 0.0;
  vec2 center = 0.25 + 0.5 * vec2(hash(id + 1.7 + seed), hash(id + 3.1 + seed));
  center += 0.1 * vec2(sin(t * 0.7 + h * 31.0), cos(t * 0.6 + h * 23.0));
  float size = mix(0.035, 0.09, hash(id + 5.3 + seed));
  float edge = length(fwidth(grid)) * 0.7;
  float twinkle = 0.55 + 0.45 * sin(t * 1.9 + h * 41.0);
  return (1.0 - smoothstep(size - edge, size + edge, length(f - center))) * twinkle;
}

void main() {
  vec2 res = u[0].xy;
  float aspect = res.x / res.y;
  vec2 q = (gl_FragCoord.xy - 0.5 * res) / res.y;
  if (u[6].x > 0.5) q.x = -q.x;
  if (u[6].y > 0.5) q.y = -q.y;
  vec2 source = u[6].z > 0.5 ? vec2(aspect * 0.5 + 0.42, 0.3) : vec2(aspect * 0.5 + 0.1, 0.62);
  float t = u[0].z;
  float swayAmount = u[7].w;
  float heading = (u[6].z > 0.5 ? 3.42 : -2.48) + u[6].w + 0.035 * sin(t * 0.21) * swayAmount;
  vec2 v = q - source;
  float r = length(v);
  float angle = mod(atan(v.y, v.x) - heading + 3.14159265, 6.28318531) - 3.14159265;
  float spread = u[4].x;
  float x = angle * u[4].y;
  float aa = smoothstep(0.12, 0.45, fwidth(x));
  float offset = spread * 0.22;
  float fanA = exp(-sq((angle + offset) / spread) * 1.4);
  float fanB = exp(-sq((angle - offset) / (spread * 1.15)) * 1.4);
  float focus = 1.0 + u[7].z * exp(-sq((angle - u[7].x) / u[7].y));
  float lightA = fanA * shafts(x, t, 0.0, aa) * focus;
  float lightB = fanB * shafts(x * 0.83, t * 0.6, 17.0, aa) * focus;
  float reach = 1.0 / (1.0 + pow(r / 0.4, u[4].w));
  float blend = u[2].w;
  vec3 colorA = u[2].rgb;
  vec3 colorB = u[3].rgb;
  vec3 glowColor = mix(colorA, colorB, blend);
  vec3 light = (colorA * lightA * (1.0 - blend) + colorB * lightB * blend) * 2.0 * reach;
  light += glowColor * u[5].x * exp(-sq(r / 0.4));
  float dust = u[5].z;
  if (dust > 0.0) {
    float sparkle = motes(q, 0.06, t, 0.0) + 0.7 * motes(q, 0.038, t * 0.8, 9.0);
    light += mix(glowColor, vec3(1.0), 0.6) * sparkle * (lightA + lightB) * reach * dust * 2.5;
  }
  // The intro reveal is finished (React Bits' uReveal = 1).
  light *= u[3].w * (1.0 - smoothstep(2.15, 2.6, r));
  float gray = dot(light, vec3(0.2126, 0.7152, 0.0722));
  light = max(mix(vec3(gray), light, u[5].y), 0.0);
  float peak = max(light.r, max(light.g, light.b));
  float grain = (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) / 255.0;
  float mapped = 1.0 - exp(-peak);
  vec3 tone = light * (mapped / max(peak, 1e-4));
  tone = mix(tone, vec3(mapped), smoothstep(0.7, 1.0, mapped) * 0.55);
  vec3 shown = clamp(tone * u[5].w, 0.0, 1.0);
  float alpha = max(shown.r, max(shown.g, shown.b));
  vec3 color = clamp(shown * alpha + grain, 0.0, 1.0);
  vec3 premultiplied = min(color, vec3(alpha));
  outColor = vec4((premultiplied + u[8].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}
