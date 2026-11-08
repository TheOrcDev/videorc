#version 300 es
// Line Waves, from React Bits by David Haz (https://reactbits.dev, MIT +
// Commons Clause), used in Videorc with the author's permission. Adapted for
// Videorc (plan 190): the mouse lens, click ripples and intro reveal are
// constants, dark mode only, drawn opaque over the look's base colour, and
// uniforms are packed into `u` (layout in live_background/mod.rs).
precision highp float;

uniform vec4 u[16];
out vec4 outColor;

vec2 rotate(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
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
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), w.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), w.x), w.y);
}

float smootherstep(float edge0, float edge1, float x) {
  float t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float bend(vec2 p, float t) {
  float scale = u[3].w;
  vec2 q = p * 2.0 / scale;
  float w = 0.6 * sin(q.x * 0.55 + t * 0.4 + 0.6 * sin(q.y * 0.9 - t * 0.28));
  w += 0.21 * sin(q.x * 1.3 - t * 0.33 + q.y * 0.8 + 1.3);
  w += 0.12 * sin(q.y * 2.3 + q.x * 0.9 - t * 0.37 + 0.4);
  return w * u[3].z * scale * 0.46;
}

float river(vec2 p, float y, float t) {
  float drift = 0.7 * (0.18 * sin(p.x * 1.6 - t * 0.33 + 0.7) + 0.1 * sin(p.x * 3.1 + t * 0.21));
  float center = 0.5 * (0.2 * sin(t * 0.17) + 0.08 * sin(t * 0.29 + 1.3));
  float width = 0.13 * u[3].y;
  float near = (y - center - drift) / width;
  float far = (y + 0.22 * sin(t * 0.13 + 2.0) - drift * 0.6 + 0.3) / (width * 0.55);
  return max(exp(-near * near), exp(-far * far) * 0.7);
}

vec3 palette(float x) {
  x = fract(x) * 3.0;
  if (x < 1.0) return mix(u[5].rgb, u[6].rgb, smoothstep(0.0, 1.0, x));
  if (x < 2.0) return mix(u[6].rgb, u[7].rgb, smoothstep(1.0, 2.0, x));
  return mix(u[7].rgb, u[5].rgb, smoothstep(2.0, 3.0, x));
}

void main() {
  vec2 res = u[0].xy;
  float aspect = res.x / res.y;
  vec2 uv = gl_FragCoord.xy / res;
  vec2 p = rotate((gl_FragCoord.xy - 0.5 * res) / res.y, u[4].x);
  float t = u[0].z;
  float pixel = u[0].w;
  float lines = u[2].x;
  float highlight = u[3].x;

  float w = bend(p, t);
  float y = p.y + w;
  float phi = y * lines;
  float fw = max(fwidth(phi), 1e-5);
  float crowd = smoothstep(0.18, 0.5, fw);

  float fold = smoothstep(1.3, 2.2, fw * res.y / lines);
  float shimmer = mix(1.0, smoothstep(0.15, 0.85, noise(vec2(y * 1.6 + t * 0.07, p.x * 0.55 - t * 0.22))), 0.5);
  float lit = max(river(p, y, t), fold * 0.9) * shimmer;
  float light = mix(1.0, 0.07 + 0.93 * lit, highlight);

  float dist = abs(fract(phi + 0.5) - 0.5) / fw;
  float width = u[2].y * pixel * (1.0 + 1.5 * lit * highlight);
  float cover = clamp(min(dist + width * 0.5, 0.5) - max(dist - width * 0.5, -0.5), 0.0, 1.0);
  cover = mix(cover, min(width * fw, 1.0), crowd);
  float halo = exp(-dist / (2.2 * pixel)) * (1.0 - crowd) * u[2].z;
  float threadShade = mix(1.0, 0.55 + 0.45 * hash(vec2(floor(phi + 0.5), 7.3)), 0.45 * (1.0 - crowd));

  // The intro reveal is finished (React Bits' uReveal = 1).
  float span = 0.5 * sqrt(aspect * aspect + 1.0);
  float sweep = span + 0.6;
  float reveal = 1.0 - smoothstep(sweep - 0.6, sweep, p.x);

  float edge = 1.0;
  float edgeFade = u[4].z;
  if (edgeFade > 0.0) {
    float ex = min(uv.x, 1.0 - uv.x) * aspect;
    float ey = min(uv.y, 1.0 - uv.y);
    edge = smootherstep(0.0, edgeFade * 0.5, ex) * smootherstep(0.0, edgeFade * 0.5, ey);
  }

  // React Bits' colour cycle advances at speed * cycleSpeed * 0.05 per second,
  // and its time at speed * 2.5: so cycle = time * cycleSpeed * 0.02.
  vec3 tint = palette(y * 0.3 + p.x * 0.2 + t * u[4].y * 0.02);
  float grain = (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) / 255.0;

  float strength = (cover + halo) * threadShade * light * u[2].w * reveal * edge;
  vec3 color = clamp(tint * strength * u[4].w, 0.0, 1.0);
  float alpha = max(color.r, max(color.g, color.b));
  color = clamp(color + grain, 0.0, 1.0);
  vec3 premultiplied = min(color, vec3(alpha));
  outColor = vec4((premultiplied + u[8].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}
