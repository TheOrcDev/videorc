#version 300 es
// Silk, from React Bits by David Haz (https://reactbits.dev, MIT + Commons
// Clause), used in Videorc with the author's permission. Adapted for Videorc
// (plan 190): pointer, click and intro inputs are constants, dark mode only,
// and uniforms are packed into `u` (layout in live_background/mod.rs).
//
// Passes: VIDEORC_PASS_FIELD renders the bloom field at a quarter size; the
// default pass composites the silk with the field's mip chain bound to t0.
precision highp float;

uniform vec4 u[9];
uniform sampler2D t0;
out vec4 outColor;

const float e = 2.71828182845904523536;

float noise(vec2 texCoord) {
  float G = e;
  vec2 r = (G * sin(G * texCoord));
  return fract(r.x * r.y * (1.0 + texCoord.x));
}

vec2 rotateUvs(vec2 uv, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  mat2 rot = mat2(c, -s, s, c);
  return rot * uv;
}

float silk(vec2 vUv) {
  float scale = u[2].x;
  vec2 uv = rotateUvs(vUv * scale, u[2].y);
  vec2 tex = uv * scale + u[3].yz;
  float tOffset = u[0].z;
  tex.y += 0.03 * u[2].z * sin(8.0 * tex.x - tOffset);
  return 0.6 + 0.4 * u[3].x * sin(5.0 * (tex.x + tex.y + cos(3.0 * tex.x + 5.0 * tex.y) + 0.02 * tOffset) + u[2].w * sin(20.0 * (tex.x + tex.y - 0.1 * tOffset)));
}

#ifdef VIDEORC_PASS_FIELD
void main() {
  vec2 vUv = gl_FragCoord.xy / u[0].xy;
  float n = clamp((silk(vUv) - 0.2) / 0.8, 0.0, 1.0);
  outColor = vec4(pow(n, 6.0), 0.0, 0.0, 1.0);
}
#else
vec3 softClip(vec3 c) {
  vec3 over = max(c - 0.75, 0.0);
  return min(c, 0.75) + 0.25 * (1.0 - exp(-over * 4.0));
}

void main() {
  vec2 vUv = gl_FragCoord.xy / u[0].xy;
  float pattern = silk(vUv);
  float rnd = noise(gl_FragCoord.xy);
  float n = clamp((pattern - 0.2) / 0.8, 0.0, 1.0);

  // React Bits steps one CSS pixel; one CSS pixel is min(view) / 1080 here.
  vec2 stepUv = u[0].w / u[1].xy;
  float gx = silk(vUv + vec2(stepUv.x, 0.0)) - pattern;
  float gy = silk(vUv + vec2(0.0, stepUv.y)) - pattern;
  vec3 normal = normalize(vec3(-gx * 26.0, -gy * 26.0, 1.0));
  vec3 toLight = normalize(vec3(u[6].yz, 0.85));
  float depth = u[4].w;
  float relief = 1.0 + (dot(normal, toLight) - toLight.z) * 1.8 * depth;
  vec3 halfway = normalize(toLight + vec3(0.0, 0.0, 1.0));
  float gloss = pow(max(dot(normal, halfway), 0.0), 48.0) * smoothstep(0.25, 0.85, n);
  float crest = pow(n, 5.0);
  float sheen = u[5].w;
  float shine = (gloss * 0.85 + crest * 0.4) * sheen * (1.0 + u[6].w * 0.6);

  float glow = u[6].x;
  float bloom = 0.0;
  if (glow > 0.0) {
    bloom += textureLod(t0, vUv, 1.0).r * 0.35;
    bloom += textureLod(t0, vUv, 2.0).r * 0.3;
    bloom += textureLod(t0, vUv, 3.0).r * 0.2;
    bloom += textureLod(t0, vUv, 4.0).r * 0.15;
  }

  vec3 color = u[4].rgb;
  float grain = rnd / 15.0 * u[3].w;
  float floorValue = mix(0.2, 0.03, depth);
  float curve = depth > 0.0 ? pow(n, 1.0 + 1.4 * depth) : n;
  float shade = depth > 0.0 ? floorValue + (1.0 - floorValue) * curve : pattern;
  vec3 tone = mix(color, pow(color, vec3(1.45)), (1.0 - n) * depth);
  vec3 lit = tone * shade * relief - vec3(grain);
  vec3 tint = mix(color, u[5].rgb, 0.8);
  vec3 extra = tint * (shine + bloom * glow * 0.55);
  float blend = clamp((sheen + glow) * 4.0, 0.0, 1.0);
  vec3 result = mix(clamp(lit, 0.0, 1.0), clamp(softClip(lit + extra), 0.0, 1.0), blend);
  outColor = vec4(result * (1.0 - u[1].z), 1.0);
}
#endif
