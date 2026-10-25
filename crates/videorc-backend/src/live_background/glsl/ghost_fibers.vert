#version 300 es
// Ghost Fibers, from React Bits by David Haz (https://reactbits.dev, MIT +
// Commons Clause), used in Videorc with the author's permission. The vertex
// shaders of its two instanced passes (plan 194 N2): every position comes
// from gl_InstanceID and gl_VertexID, nothing is uploaded. Adapted for
// Videorc: the hover, the click pulse and the intro are constants (N3), the
// three ribbons are one draw (the ribbon comes from the instance id), the
// projection is derived from the view's aspect, and uniforms are packed into
// `u` (layout in live_background/mod.rs and ghost_fibers.frag).
//
// Passes: VIDEORC_PASS_DOTS draws one quad per dot of every fiber;
// VIDEORC_PASS_DUST one per dust mote. Both are triangle strips of four
// vertices, blended additively into a cleared scene.
precision highp float;

uniform vec4 u[16];

out vec2 vLocal;
out float vRadius;
out float vSegment;
out vec3 vLight;
out float vTint;

// React Bits' camera: the eye at z = 7.5 looking down −z through a 0.56 rad
// frustum (near 0.1, far 60), whose x, y and w are all a point needs here.
const float CAMERA = 7.5;
const float FRUSTUM = 3.4776037;
const float FOCAL = 1.73880;
const float RIBBON_LENGTH = 24.0;
const float DEPTH_SPREAD = 0.12;
const vec4 PLACEMENTS[3] = vec4[3](vec4(0.0, 0.0, 0.0, 0.0), vec4(1.9, -4.6, -0.08, 2.4), vec4(-1.05, 2.0, 0.12, 4.1));
const float RIBBON_GAIN[3] = float[3](1.0, 0.5, 0.55);
const float RIBBON_TINT[3] = float[3](0.0, 0.75, 0.35);

float hash11(float n) {
  return fract(sin(n * 91.3458) * 47453.5453);
}

// React Bits' `fit`: the canvas aspect over 1.5, clamped to 0.6–1.
float fit() {
  return clamp(u[1].x / u[1].y / 1.5, 0.6, 1.0);
}

vec3 project(vec3 world, vec2 viewport, out float depth) {
  depth = CAMERA - world.z;
  float aspect = viewport.x / viewport.y;
  vec2 ndc = vec2(FRUSTUM * world.x / aspect, FRUSTUM * world.y) / depth;
  return vec3((ndc * 0.5 + 0.5) * viewport, depth);
}

vec2 quadCorner() {
  return vec2(gl_VertexID == 1 || gl_VertexID == 3 ? 1.0 : 0.0, gl_VertexID >= 2 ? 1.0 : 0.0);
}

#ifdef VIDEORC_PASS_DUST
void main() {
  vec2 viewport = u[0].xy;
  float dpr = u[0].w;
  float uTime = u[0].z;
  float id = float(gl_InstanceID);
  vec3 seed = vec3(hash11(id * 1.37 + 0.3), hash11(id * 2.91 + 1.7), hash11(id * 4.17 + 2.9));
  vec3 box = vec3(9.0, 5.4, 6.0);
  vec3 p = (seed - 0.5) * box;
  p.z -= 0.6;
  p += 0.18 * vec3(sin(uTime * 0.21 + seed.x * 40.0), sin(uTime * 0.17 + seed.y * 40.0), sin(uTime * 0.13 + seed.z * 40.0));
  p *= mix(1.0, u[3].x * fit(), 0.5);
  float depth;
  vec3 projected = project(p, viewport, depth);
  vec2 px = projected.xy;
  float size = u[8].x * mix(0.5, 1.4, hash11(id * 7.7));
  float baseRadius = max(0.5 * size * dpr * CAMERA / max(depth, 0.1), 0.45);
  float coc = min(u[4].w * abs(1.0 - u[4].z / max(depth, 0.1)) * viewport.y * 0.035, 22.0 * dpr * 1.6);
  float radius = baseRadius + coc;
  float spill = max(10.0 * dpr, baseRadius);
  float energy = pow(baseRadius / min(radius, spill), 0.9) * pow(min(1.0, spill / radius), 2.0);
  float twinkle = pow(max(sin(uTime * (0.8 + 1.6 * seed.y) * 2.0 + seed.z * 50.0), 0.0), 8.0);
  // The intro is finished (React Bits' uIntro = 1).
  float intensity = energy * (0.35 + 0.65 * twinkle) * mix(0.4, 1.0, seed.x) * (depth > 0.2 ? 1.0 : 0.0);
  vec2 corner = quadCorner() * 2.0 - 1.0;
  vec2 position = px + corner * radius;
  vLocal = corner * radius;
  vRadius = radius;
  vSegment = 0.0;
  vLight = vec3(intensity * 0.8 * u[8].y, 0.3 + 0.6 * twinkle * u[5].z, coc / max(radius, 1e-3));
  vTint = u[6].y < 0.5 ? 0.45 + 0.55 * seed.y : seed.y;
  gl_Position = vec4(position / viewport * 2.0 - 1.0, 0.0, 1.0);
}
#else
vec3 centerLocal(float s, vec4 place) {
  float t = u[0].z;
  float ph = place.w;
  float x = s * RIBBON_LENGTH;
  float y = u[2].z * (0.52 * sin(x * 0.43 + t * 0.31 + ph) + 0.26 * sin(x * 0.79 - t * 0.23 + 1.3 + ph * 0.7)) + place.x + x * place.z;
  float z = u[2].z * 0.65 * sin(x * 0.33 + t * 0.19 + 0.7 + ph * 1.3) + place.y;
  return vec3(x, y, z);
}

float twistAt(float s, float layer, vec4 place) {
  float x = s * RIBBON_LENGTH;
  // The roll advances with the phase at the look's roll speed.
  float roll = u[0].z * u[2].y;
  return u[2].x * 0.483 * x + roll + place.w * 0.6 + layer * u[3].y * 0.42 + 0.5 * sin(x * 0.26 + u[0].z * 0.27 + place.w);
}

vec3 ribbonPoint(float s, float v, float n, float layer, vec4 place, mat3 orient, float scale, out vec3 normal) {
  vec3 c0 = centerLocal(s, place);
  vec3 c1 = centerLocal(s + 0.004, place);
  vec3 tangent = normalize(c1 - c0);
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 n0 = normalize(up - tangent * dot(up, tangent));
  vec3 b0 = cross(tangent, n0);
  float th = twistAt(s, layer, place);
  vec3 across = cos(th) * n0 + sin(th) * b0;
  vec3 sheet = -sin(th) * n0 + cos(th) * b0;
  float halfWidth = u[2].w * (0.78 + 0.22 * cos(s * 3.14159));
  vec3 local = c0 + across * v * halfWidth + sheet * (n + layer * u[3].y * 0.16) * halfWidth;
  normal = orient * sheet;
  return orient * (local * scale);
}

void main() {
  vec2 viewport = u[0].xy;
  float dpr = u[0].w;
  float uTime = u[0].z;
  mat3 orient = mat3(u[9].xyz, u[10].xyz, u[11].xyz);
  float scale = u[3].x * fit();
  float uFibers = u[3].z;
  float uDots = u[3].w;
  float uFlow = u[0].z * u[4].x;

  // One draw for every ribbon: the instance id names the ribbon, then the
  // fiber, then the bead (React Bits draws each ribbon with its own
  // uRibbon, uPlace, uGain and uTint).
  int perFiber = int(uDots);
  int perRibbon = int(uFibers) * perFiber;
  int ribbon = gl_InstanceID / perRibbon;
  int withinRibbon = gl_InstanceID - ribbon * perRibbon;
  int fiber = withinRibbon / perFiber;
  int bead = withinRibbon - fiber * perFiber;
  float uRibbon = float(ribbon);
  vec4 place = PLACEMENTS[ribbon];
  float uGain = RIBBON_GAIN[ribbon] * u[5].w;
  float uTint = RIBBON_TINT[ribbon];
  float fi = float(fiber);
  float fk = float(bead);

  float seed = hash11(fi * 1.731 + uRibbon * 17.0);
  float s = fract((fk + uFlow + seed * uDots) / uDots) - 0.5;
  float sNext = s + 1.0 / uDots;
  float layer = mod(fi, 3.0) - 1.0;
  float slot = floor(fi / 3.0);
  float perLayer = max(floor(uFibers / 3.0), 1.0);
  float v = ((slot + 0.5) / perLayer) * 2.0 - 1.0 + (hash11(fi * 3.113 + 4.0) - 0.5) * (1.6 / perLayer) + layer * 0.12 / perLayer;
  float depthOffset = (hash11(fi * 7.919 + 2.0) - 0.5) * DEPTH_SPREAD * (0.35 + 6.0 * s * s);

  vec3 normal;
  vec3 world = ribbonPoint(s, v, depthOffset, layer, place, orient, scale, normal);
  vec3 nextNormal;
  vec3 nextWorld = ribbonPoint(sNext, v, depthOffset, layer, place, orient, scale, nextNormal);

  float depth;
  vec3 p0 = project(world, viewport, depth);
  float nextDepth;
  vec3 p1 = project(nextWorld, viewport, nextDepth);
  // No hover parts the fibers (React Bits' uHover.w = 0).
  vec2 px = p0.xy;
  vec2 pxNext = p1.xy;

  float uSize = u[4].y;
  float uFocus = u[4].z;
  float uDof = u[4].w;
  float baseRadius = max(0.5 * uSize * dpr * CAMERA / max(depth, 0.1), 0.45);
  float coc = min(uDof * abs(1.0 - uFocus / max(depth, 0.1)) * viewport.y * 0.035, u[5].x * dpr);
  float radius = baseRadius + coc;
  float spill = max(10.0 * dpr, baseRadius);
  float energy = pow(baseRadius / min(radius, spill), 1.25) * pow(min(1.0, spill / radius), 2.0);

  vec3 toEye = normalize(vec3(0.0, 0.0, CAMERA) - world);
  float facing = abs(dot(normalize(normal), toEye));
  float focalPx = viewport.y * FOCAL / max(depth, 0.1);
  float widthPx = 2.0 * u[2].w * scale * focalPx;
  float stack = (widthPx * facing + 2.0 * baseRadius) / (widthPx + 2.0 * baseRadius);
  float spacingFace = length(nextWorld - world) * focalPx;
  float trail = (length(p1.xy - p0.xy) + 2.0 * baseRadius) / (spacingFace + 2.0 * baseRadius);
  float crowd = sqrt(clamp(stack * trail, 0.002, 1.0));
  float fold = pow(1.0 - facing, 6.0) * u[6].z;
  float endFade = smoothstep(0.5, 0.4, abs(s)) * smoothstep(1.6, 4.2, depth);
  float uTips = u[6].x;
  float tipEnd = mix(0.6, 0.06 + 0.26 * hash11(fi * 9.137 + place.w * 3.0), uTips);
  // Squared by hand: GLSL leaves pow() of a negative base undefined (HLSL gives NaN).
  float tipOffset = (s - tipEnd) / 0.0065;
  float tip = exp(-tipOffset * tipOffset) * uTips;
  endFade *= smoothstep(tipEnd + 0.003, tipEnd - 0.001, s);
  // The intro is finished (React Bits' appear = 1) and no click pulses.
  float uDotLength = u[5].y;
  float twinklePhase = hash11(fi * 13.7 + fk * 0.917 + uRibbon * 3.0);
  float twinkle = pow(max(sin(uTime * (1.2 + 2.6 * twinklePhase) * 3.0 + twinklePhase * 61.0), 0.0), 36.0) * u[5].z * (1.0 - 0.85 * uDotLength);
  float strength = mix(0.45, 1.0, hash11(fi * 5.37 + 1.0)) * mix(1.0, 0.72, abs(layer) * u[3].y);
  float intensity = energy * crowd * strength * endFade * 0.8 * uGain * (1.0 + fold * 7.0 + twinkle * 5.0 + tip * 7.0);
  float highlight = clamp(fold * 0.55 + twinkle + tip, 0.0, 1.0);

  vec2 segment = (pxNext - px) * uDotLength;
  float segmentLength = length(segment);
  intensity *= mix(1.0, (2.0 * radius) / (segmentLength + 2.0 * radius) * 1.6, uDotLength);
  vec2 axis = segmentLength > 1e-3 ? segment / segmentLength : vec2(1.0, 0.0);
  vec2 perp = vec2(-axis.y, axis.x);
  vec2 corner = quadCorner();
  float along = mix(-radius, segmentLength + radius, corner.x);
  float across = mix(-radius, radius, corner.y);
  vec2 position = px + axis * along + perp * across;

  vLocal = vec2(along, across);
  vRadius = radius;
  vSegment = segmentLength;
  vLight = vec3(intensity, highlight, coc / max(radius, 1e-3));
  float depthTint = clamp(uTint + smoothstep(uFocus, uFocus + 5.0, depth) * 0.5, 0.0, 1.0);
  float uGradient = u[6].y;
  vTint = uGradient < 0.5 ? depthTint : uGradient < 1.5 ? smoothstep(-0.42, 0.42, s) : clamp(v * 0.5 + 0.5, 0.0, 1.0);
  if (intensity < 0.0005) position = vec2(-1e4);
  gl_Position = vec4(position / viewport * 2.0 - 1.0, 0.0, 1.0);
}
#endif
