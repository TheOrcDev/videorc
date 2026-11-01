#version 300 es
// Beams, from React Bits by David Haz (https://reactbits.dev, MIT + Commons
// Clause), used in Videorc with the author's permission. Adapted for Videorc
// (plan 194): the pointer and the intro are constants (N3), dark mode only,
// drawn opaque over the look's base colour, the grain fixed in place, and
// uniforms are packed into `u` (layout in live_background/mod.rs).
//
// Passes: VIDEORC_PASS_FIELD renders the glint field at three quarters of the
// view (sizes::beams_field_size, then mipmaps); the default pass composites
// it from t0's mip chain.
//
// u[2] = (beam width, wave length, depth, roughness); the first two in CSS px
// u[3] = (cos rotation, sin rotation, twist, fill light)
// u[4] = (variation seed, gain, glow, grain)
// u[5] = tint (linear)
// u[6] = base colour
precision highp float;

uniform vec4 u[16];
uniform sampler2D t0;
out vec4 outColor;

const float PI = 3.141592653589793;

#ifdef VIDEORC_PASS_FIELD
vec4 permute(vec4 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

vec4 taylorInvSqrt(vec4 r) {
  return 1.79284291400159 - 0.85373472095314 * r;
}

vec3 fade(vec3 t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float cnoise(vec3 P) {
  vec3 Pi0 = floor(P);
  vec3 Pi1 = Pi0 + vec3(1.0);
  Pi0 = mod(Pi0, 289.0);
  Pi1 = mod(Pi1, 289.0);
  vec3 Pf0 = fract(P);
  vec3 Pf1 = Pf0 - vec3(1.0);
  vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
  vec4 iy = vec4(Pi0.yy, Pi1.yy);
  vec4 iz0 = Pi0.zzzz;
  vec4 iz1 = Pi1.zzzz;
  vec4 ixy = permute(permute(ix) + iy);
  vec4 ixy0 = permute(ixy + iz0);
  vec4 ixy1 = permute(ixy + iz1);
  vec4 gx0 = ixy0 / 7.0;
  vec4 gy0 = fract(floor(gx0) / 7.0) - 0.5;
  gx0 = fract(gx0);
  vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
  vec4 sz0 = step(gz0, vec4(0.0));
  gx0 -= sz0 * (step(0.0, gx0) - 0.5);
  gy0 -= sz0 * (step(0.0, gy0) - 0.5);
  vec4 gx1 = ixy1 / 7.0;
  vec4 gy1 = fract(floor(gx1) / 7.0) - 0.5;
  gx1 = fract(gx1);
  vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
  vec4 sz1 = step(gz1, vec4(0.0));
  gx1 -= sz1 * (step(0.0, gx1) - 0.5);
  gy1 -= sz1 * (step(0.0, gy1) - 0.5);
  vec3 g000 = vec3(gx0.x, gy0.x, gz0.x);
  vec3 g100 = vec3(gx0.y, gy0.y, gz0.y);
  vec3 g010 = vec3(gx0.z, gy0.z, gz0.z);
  vec3 g110 = vec3(gx0.w, gy0.w, gz0.w);
  vec3 g001 = vec3(gx1.x, gy1.x, gz1.x);
  vec3 g101 = vec3(gx1.y, gy1.y, gz1.y);
  vec3 g011 = vec3(gx1.z, gy1.z, gz1.z);
  vec3 g111 = vec3(gx1.w, gy1.w, gz1.w);
  vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
  g000 *= norm0.x;
  g010 *= norm0.y;
  g100 *= norm0.z;
  g110 *= norm0.w;
  vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
  g001 *= norm1.x;
  g011 *= norm1.y;
  g101 *= norm1.z;
  g111 *= norm1.w;
  float n000 = dot(g000, Pf0);
  float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
  float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
  float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
  float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
  float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
  float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
  float n111 = dot(g111, Pf1);
  vec3 fade_xyz = fade(Pf0);
  vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
  vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
  float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
  return 2.2 * n_xyz;
}

float laneHash(float lane) {
  return fract(sin(lane * 91.3458 + u[4].x * 17.17) * 47453.5453);
}

float lobe(float nh, float nl, float nv, float vh, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  float distribution = a2 / (PI * d * d);
  float gv = nl * sqrt(nv * nv * (1.0 - a2) + a2);
  float gl = nv * sqrt(nl * nl * (1.0 - a2) + a2);
  float visibility = 0.5 / max(gv + gl, 0.0001);
  float fresnel = 0.028 + 0.972 * pow(1.0 - vh, 5.0);
  return distribution * visibility * fresnel * nl;
}

vec2 glint(float lane, vec2 local, float uTime, float camera) {
  float along = local.y / u[2].y - laneHash(lane) * 60.0;
  float step = 0.01;
  float slope = (cnoise(vec3(0.0, along + step, uTime)) - cnoise(vec3(0.0, along - step, uTime))) / (2.0 * step);
  slope *= 0.2 * u[2].z;
  float spin = laneHash(lane + 0.37);
  float tilt = ((spin - 0.5) * 0.5 + sin(uTime * 2.1 + spin * 6.2831) * 0.06) * u[3].z;
  vec3 normal = normalize(vec3(tilt, -slope, 1.0));
  vec3 view = normalize(vec3(-local, camera));
  float nv = max(dot(normal, view), 0.0001);
  // The light rests at React Bits' (0, 3, 10): the intro sweep is over and
  // the pointer never lifts it.
  vec3 light = normalize(vec3(0.0, 3.0, 10.0));
  vec3 halfway = normalize(light + view);
  float roughness = u[2].w;
  float core = lobe(max(dot(normal, halfway), 0.0), max(dot(normal, light), 0.0), nv, max(dot(view, halfway), 0.0), roughness);
  vec3 fill = normalize(vec3(0.0, -3.0 * 1.25, 10.0));
  vec3 fillHalf = normalize(fill + view);
  core += u[3].w * lobe(max(dot(normal, fillHalf), 0.0), max(dot(normal, fill), 0.0), nv, max(dot(view, fillHalf), 0.0), roughness);
  return vec2(core, core);
}

void main() {
  // React Bits sizes the beams in CSS pixels; one is min(view) / 1080 render
  // pixels, so uScale is CSS pixels per field texel.
  vec2 viewCss = u[1].xy / u[0].w;
  vec2 uScale = viewCss / u[0].xy;
  vec2 css = gl_FragCoord.xy * uScale;
  vec2 centered = css - viewCss * 0.5;
  vec2 local = mat2(u[3].x, -u[3].y, u[3].y, u[3].x) * centered;
  float uTime = mod(u[0].z * 0.12, 289.0);
  float camera = viewCss.y * 1.866;

  float across = local.x / u[2].x + 0.5;
  float lane = floor(across);
  float along = across - lane;
  vec2 value = glint(lane, local, uTime, camera);

  float pixel = max(uScale.x, uScale.y);
  float seam = min(along, 1.0 - along) * u[2].x;
  if (seam < pixel * 1.5) {
    float other = along < 0.5 ? lane - 1.0 : lane + 1.0;
    float blend = 0.5 * (1.0 - smoothstep(0.0, pixel * 1.5, seam));
    value = mix(value, glint(other, local, uTime, camera), blend);
  }

  // The pointer rests (React Bits' uPointer.z = 0), so nothing brightens
  // near it.
  float hot = max(value.y - 0.18, 0.0);
  outColor = vec4(value.x, value.y, min(hot, 6.0), 1.0);
}
#else
float random(vec2 st) {
  return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453123);
}

float grainNoise(vec2 st) {
  vec2 i = floor(st);
  vec2 f = fract(st);
  float a = random(i);
  float b = random(i + vec2(1.0, 0.0));
  float c = random(i + vec2(0.0, 1.0));
  float d = random(i + vec2(1.0, 1.0));
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(a, b, w.x) + (c - a) * w.y * (1.0 - w.x) + (d - b) * w.x * w.y;
}

vec3 acesFilmic(vec3 color) {
  const mat3 inputMatrix = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 outputMatrix = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602)
  );
  color = inputMatrix * (color / 0.6);
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  color = outputMatrix * (a / b);
  return clamp(color, 0.0, 1.0);
}

vec3 toSrgb(vec3 color) {
  return mix(color * 12.92, 1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), color));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u[0].xy;
  float radiance = textureLod(t0, uv, 0.0).r;
  float bloom = 0.0;
  bloom += textureLod(t0, uv, 2.0).b * 0.3;
  bloom += textureLod(t0, uv, 3.0).b * 0.3;
  bloom += textureLod(t0, uv, 4.0).b * 0.22;
  bloom += textureLod(t0, uv, 5.0).b * 0.18;

  float hot = textureLod(t0, uv, 0.0).g;
  vec3 tint = u[5].rgb;
  float gain = u[4].y;
  vec3 light = tint * (radiance + bloom * u[4].z) * gain;
  light += mix(tint, vec3(1.0), 0.7) * hot * hot * 0.12 * gain;
  // The intro is finished (React Bits' uPresence = 1).
  vec3 color = toSrgb(acesFilmic(light));
  color -= grainNoise(gl_FragCoord.xy) / 15.0 * u[4].w;
  color = max(color, 0.0);

  // No edge fade and full opacity: React Bits' mask is 1.
  float dither = (random(gl_FragCoord.yx + 31.7) - 0.5) / 255.0;
  color = clamp(color + dither, 0.0, 1.0);
  float alpha = max(color.r, max(color.g, color.b));
  outColor = vec4((color + u[6].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}
#endif
