#version 300 es
// Ferrofluid, from React Bits by David Haz (https://reactbits.dev, MIT +
// Commons Clause), used in Videorc with the author's permission. Adapted for
// Videorc (plan 194): the field is the settled target, not a spring
// simulation (N1: React Bits' uSettle path, no ping-pong); the cursor magnet,
// its mound, the click pulse and the intro are gone (N3); dark mode only,
// drawn opaque over the look's base colour, and uniforms are packed into `u`
// (layout in live_background/mod.rs).
//
// Passes: VIDEORC_PASS_FIELD writes the spike height per grid cell
// (sizes::ferrofluid_grid, a third of a world unit per cell);
// VIDEORC_PASS_BOUND the 9 × 9 maximum per world unit (t0 the field); the
// default pass marches the surface (t0 the field, sampled linearly; t1 the
// bound, fetched by texel).
//
// u[2] = (flow x, flow y, turbulence, magnetism)
// u[3] = (seed x, seed y, spike height, 0)
// u[4] = (camera y, camera z, far, fog start); the camera's x is 0
// u[5] = (forward y, forward z, upward y, upward z)
// u[6] = (top, round, span, exponent)
// u[7] = (lattice warp, exposure, 0, 0)
// u[8] = key light, u[9] = strip light, u[10] = fill light
// u[11] = base colour
precision highp float;

uniform vec4 u[16];
uniform sampler2D t0;
uniform sampler2D t1;
out vec4 outColor;

const float CELL = 1.0 / 3.0;
const float BOUND_CELL = 1.0;
// tan(19°): half of React Bits' 38° field of view.
const float TAN_HALF = 0.34432761;

// Where a camera ray through NDC (x, y) meets the ground (React Bits'
// groundAt).
vec2 groundAt(float x, float y, float aspect) {
  vec3 d = normalize(vec3(x * aspect * TAN_HALF, u[5].x + y * TAN_HALF * u[5].z, u[5].y + y * TAN_HALF * u[5].w));
  float t = d.z < -0.004 ? min(-u[4].y / d.z, u[4].z) : u[4].z;
  return vec2(d.x * t, u[4].x + d.y * t);
}

// The grid's corner for this view (React Bits' layout()): the four corner
// rays and the top centre meet the ground, padded by three units.
// sizes::ferrofluid_grid cells the same footprint, so the grid texture is
// exactly this origin plus its size × CELL.
vec2 gridOrigin() {
  float aspect = u[1].x / u[1].y;
  vec2 a = groundAt(-1.0, -1.0, aspect);
  vec2 b = groundAt(1.0, -1.0, aspect);
  vec2 c = groundAt(-1.0, 1.0, aspect);
  vec2 d = groundAt(1.0, 1.0, aspect);
  vec2 e = groundAt(0.0, 1.0, aspect);
  return min(min(min(a, b), min(c, d)), e) - 3.0;
}

#ifdef VIDEORC_PASS_FIELD
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

float flowField(vec2 p) {
  float uTime = u[0].z;
  vec2 q = p / 5.5 + u[3].xy;
  vec2 drift = u[2].xy * uTime * 0.55;
  vec2 warp = vec2(noise(q * 0.6 + vec2(uTime * 0.07, 3.1)), noise(q * 0.6 - vec2(7.3, uTime * 0.06))) - 0.5;
  vec2 r = q + warp * 1.8 * u[2].z - drift;
  float n = noise(r) * 0.65 + noise(r * 2.03 + 11.7 - drift * 0.5) * 0.35;
  return smoothstep(0.44, 0.86, n);
}

void main() {
  vec2 texel = floor(gl_FragCoord.xy);
  vec2 p = gridOrigin() + (texel + 0.5) * CELL;
  float swell = flowField(p);
  float field = u[2].w * (0.03 + 1.0 * swell * swell);
  // No cursor and no pulse add to the field; the intro front has passed.
  float target = u[3].z * min(pow(max(field - 0.04, 0.0), 1.6), 1.0);
  // N1: the height is the target itself (uSettle); no velocity, no mound.
  outColor = vec4(target, 0.0, 0.0, 1.0);
}
#elif defined(VIDEORC_PASS_BOUND)
void main() {
  vec2 origin = gridOrigin();
  vec2 stateSize = vec2(textureSize(t0, 0));
  vec2 center = origin + (floor(gl_FragCoord.xy) + 0.5) * BOUND_CELL;
  vec2 base = floor((center - origin) / CELL);
  float top = 0.0;
  float peak = 0.0;
  for (int y = -4; y <= 4; y++) {
    for (int x = -4; x <= 4; x++) {
      vec2 texel = clamp(base + vec2(float(x), float(y)), vec2(0.0), stateSize - 1.0);
      vec4 s = texelFetch(t0, ivec2(texel), 0);
      top = max(top, max(s.x, 0.0) * 1.05 + s.z);
      peak = max(peak, s.x);
    }
  }
  outColor = vec4(top, peak, 0.0, 1.0);
}
#else
const float G = 7.2551975;
const vec2 E1 = vec2(0.8660254, 0.5);
const vec2 E2 = vec2(-0.8660254, 0.5);
const vec2 E3 = vec2(0.0, -1.0);
const mat2 TURN = mat2(0.9902681, 0.1391731, -0.1391731, 0.9902681);
const float F0 = 0.06;

vec2 lattice(vec2 p) {
  vec2 q = TURN * p;
  // React Bits' render time is twice the simulation's.
  float t = u[0].z * 2.0 * 0.35;
  return q + u[7].x * vec2(sin(q.y * 0.9 + t), cos(q.x * 0.8 - t * 0.8));
}

float pixelAngle() {
  return (2.0 * TAN_HALF) / u[0].y;
}

float detail(float t) {
  float fogStart = u[4].w;
  float far = u[4].z;
  return smoothstep(3.0, 8.0, 1.0 / max(t * pixelAngle(), 1e-5)) * (1.0 - smoothstep(fogStart, mix(fogStart, far, 0.7), t));
}

float profile(float v, out float rate) {
  float uRound = u[6].y;
  float uSpan = u[6].z;
  float root = sqrt(max(1.0 - v, 0.0) + uRound * uRound);
  rate = 0.5 / (uSpan * root);
  return clamp(1.0 - (root - uRound) / uSpan, 0.0, 1.0);
}

float spikes(vec2 p, float a, float rise, out float clearance) {
  clearance = 10.0;
  if (a < 0.002) return 0.0;
  vec2 q = lattice(p);
  float v = (cos(G * dot(E1, q)) + cos(G * dot(E2, q)) + cos(G * dot(E3, q)) + 1.5) / 4.5;
  float uRound = u[6].y;
  float uSpan = u[6].z;
  float uExponent = u[6].w;
  if (a > 0.05) {
    float root = uRound + (1.0 - pow(clamp(rise / a, 0.0, 1.0), 1.0 / uExponent)) * uSpan;
    clearance = sqrt(max(1.0 - v, 0.0) / 8.77) - sqrt(max(root * root - uRound * uRound, 0.0) / 8.77);
  }
  float rate;
  return a * pow(profile(v, rate), uExponent);
}

vec2 spikesSlope(vec2 p, float a, vec2 aSlope) {
  if (a < 0.002) return vec2(0.0);
  vec2 q = lattice(p);
  float c1 = G * dot(E1, q);
  float c2 = G * dot(E2, q);
  float c3 = G * dot(E3, q);
  float v = (cos(c1) + cos(c2) + cos(c3) + 1.5) / 4.5;
  vec2 du = -(G / 4.5) * (sin(c1) * E1 + sin(c2) * E2 + sin(c3) * E3) * TURN;
  float rate;
  float s = max(profile(v, rate), 1e-4);
  float uExponent = u[6].w;
  float shape = pow(s, uExponent);
  return a * uExponent * shape / s * rate * du + aSlope * shape;
}

vec2 gridSpan() {
  return vec2(textureSize(t0, 0)) * CELL;
}

float surface(vec2 p, vec2 origin, float z, float t, out float clearance) {
  vec4 f = texture(t0, (p - origin) / gridSpan());
  // f.z is the cursor's mound: 0 without a pointer.
  return f.z + spikes(p, f.x * detail(t), z - f.z, clearance);
}

// React Bits samples the bound nearest and clamped; a texel fetch is the
// same and needs no sampler state.
vec2 bound(vec2 p, vec2 origin) {
  ivec2 size = textureSize(t1, 0);
  ivec2 texel = clamp(ivec2(floor((p - origin) / BOUND_CELL)), ivec2(0), size - 1);
  return texelFetch(t1, texel, 0).rg;
}

float panel(vec3 r, vec3 dir, vec3 up, vec2 extent, float soft) {
  vec3 side = normalize(cross(dir, up));
  vec3 top = cross(side, dir);
  float facing = dot(r, dir);
  if (facing <= 0.0) return 0.0;
  vec2 q = vec2(dot(r, side), dot(r, top)) / facing;
  vec2 e = smoothstep(extent + soft, extent - soft, abs(q));
  return e.x * e.y;
}

vec3 studio(vec3 r, vec3 rd, float soft) {
  vec3 z = vec3(0.0, 0.0, 1.0);
  vec3 col = u[8].rgb * 4.2 * panel(r, normalize(vec3(-0.3, -0.5, 0.81)), z, vec2(0.36, 0.22), 0.08 + soft);
  col += u[9].rgb * 1.5 * panel(r, normalize(vec3(-0.9, -0.2, 0.38)), z, vec2(0.12, 0.7), 0.07 + soft);
  col += u[9].rgb * 1.5 * panel(r, normalize(vec3(0.9, -0.1, 0.42)), z, vec2(0.12, 0.7), 0.07 + soft);
  float lift = asin(clamp(r.z, -1.0, 1.0)) - asin(clamp(-rd.z, -1.0, 1.0));
  col += u[10].rgb * 0.45 * smoothstep(0.08 - soft, 0.7 + soft, lift) * smoothstep(1.6, 1.0, lift);
  return col;
}

// React Bits' finish() in dark, transparent mode: the glow premultiplied by
// the fog, drawn here over the base colour.
vec4 finish(vec3 light, float alpha) {
  vec3 glow = light * alpha;
  float cover = max(glow.r, max(glow.g, glow.b));
  return vec4((glow + u[11].rgb * (1.0 - cover)) * (1.0 - u[1].z), 1.0);
}

void main() {
  vec2 res = u[0].xy;
  vec2 ndc = (gl_FragCoord.xy - 0.5 * res) / (0.5 * res.y);
  vec3 camera = vec3(0.0, u[4].x, u[4].y);
  vec3 forward = vec3(0.0, u[5].x, u[5].y);
  vec3 upward = vec3(0.0, u[5].z, u[5].w);
  float far = u[4].z;
  float fogStart = u[4].w;
  vec3 side = normalize(cross(forward, upward));
  vec3 rd = normalize(forward + (ndc.x * side + ndc.y * upward) * TAN_HALF);
  if (rd.z > -0.004) {
    outColor = finish(vec3(0.0), 0.0);
    return;
  }
  float tTop = max((u[6].x - camera.z) / rd.z, 0.0);
  float tEnd = min((-0.05 - camera.z) / rd.z, far);
  if (tTop >= tEnd) {
    outColor = finish(vec3(0.0), 0.0);
    return;
  }
  vec2 origin = gridOrigin();
  float sink = max(-rd.z, 0.2);
  float glide = max(length(rd.xy), 0.05);
  float chunk = 0.9 / glide;
  float t = tEnd;
  float tPrev = tEnd;
  bool found = false;
  bool smoothHit = false;
  float ta = tTop;
  vec2 b0 = bound(camera.xy + rd.xy * ta, origin);
  for (int c = 0; c < 64; c++) {
    if (ta >= tEnd) break;
    float tb = min(ta + chunk, tEnd);
    vec2 b1 = bound(camera.xy + rd.xy * tb, origin);
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
        vec3 probe = camera + rd * tt;
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
      vec3 pos = camera + rd * tt;
      float clearance;
      float gap = pos.z - surface(pos.xy, origin, pos.z, tt, clearance);
      if (gap < 0.0) {
        found = true;
        break;
      }
      tp = tt;
      float pixel = tt * pixelAngle();
      float limit = pos.z > bound(pos.xy, origin).x + 0.02 ? 0.6 / glide : max(clearance * 0.9, pixel) / glide;
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

  vec3 pos;
  vec2 slope;
  if (smoothHit || !found) {
    pos = camera + rd * t;
    slope = vec2(0.0);
  } else {
    float lo = tPrev;
    float hi = t;
    for (int k = 0; k < 4; k++) {
      float mid = 0.5 * (lo + hi);
      vec3 probe = camera + rd * mid;
      float clearance;
      if (probe.z - surface(probe.xy, origin, probe.z, mid, clearance) < 0.0) hi = mid;
      else lo = mid;
    }
    t = hi;
    pos = camera + rd * t;
    vec2 span = gridSpan();
    vec2 uv = (pos.xy - origin) / span;
    vec2 step = CELL / span;
    float fade = detail(t);
    float a = texture(t0, uv).x * fade;
    vec2 aSlope = vec2(
      texture(t0, uv + vec2(step.x, 0.0)).x - texture(t0, uv - vec2(step.x, 0.0)).x,
      texture(t0, uv + vec2(0.0, step.y)).x - texture(t0, uv - vec2(0.0, step.y)).x
    ) * fade / (2.0 * CELL);
    slope = spikesSlope(pos.xy, a, aSlope);
  }

  vec3 n = normalize(vec3(-slope, 1.0));
  vec3 r = reflect(rd, n);
  float soft = length(fwidth(r)) * 0.6;
  float facing = max(dot(n, -rd), 0.0);
  float fresnel = F0 + (1.0 - F0) * pow(1.0 - facing, 5.0);
  float rim = pow(1.0 - clamp(abs(dot(rd, n)), 0.0, 1.0), 3.0) * smoothstep(0.85, 0.4, n.z);
  float distance = 1.0 - smoothstep(fogStart, far, t);

  vec3 shine = 1.0 - exp(-(studio(r, rd, soft) * fresnel + u[10].rgb * rim * 0.35) * u[7].y);
  outColor = finish(shine, distance);
}
#endif
