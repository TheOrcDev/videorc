#version 300 es
// Color Bends, from React Bits by David Haz (https://reactbits.dev, MIT +
// Commons Clause), used in Videorc with the author's permission. Adapted for
// Videorc (plan 194): the pointer rests at the centre (N3: no parallax, and
// the pull toward it is the constant pull toward the centre React Bits
// shows at rest), the noise is fixed in place, the colours and the iteration
// count are look constants, drawn opaque over the look's base colour, and
// uniforms are packed into `u` (layout in live_background/mod.rs). React
// Bits draws this one through three.js; only the fragment shader is its own.
//
// u[2] = (cos rotation, sin rotation, scale, frequency)
// u[3] = (warp strength, noise, iterations, intensity)
// u[4] = (band width, colour count, mouse influence, 0)
// u[5..13) = the colours (React Bits' MAX_COLORS = 8)
// u[13] = base colour
precision highp float;

uniform vec4 u[16];
out vec4 outColor;

const int MAX_COLORS = 8;

void main() {
  vec2 vUv = gl_FragCoord.xy / u[0].xy;
  float t = u[0].z;
  vec2 p = vUv * 2.0 - 1.0;
  vec2 rp = vec2(p.x * u[2].x - p.y * u[2].y, p.x * u[2].y + p.y * u[2].x);
  vec2 q = vec2(rp.x * (u[0].x / u[0].y), rp.y);
  q /= max(u[2].z, 0.0001);
  q /= 0.5 + 0.2 * dot(q, q);
  q += 0.2 * cos(t) - 7.56;
  // The pointer rests at the centre (React Bits' uPointer = 0).
  vec2 toward = -rp;
  q += toward * u[4].z * 0.2;

  float frequency = u[2].w;
  float iterations = u[3].z;
  for (int j = 0; j < 5; j++) {
    if (float(j) >= iterations - 1.0) break;
    vec2 rr = sin(1.5 * (q.yx * frequency) + 2.0 * cos(q * frequency));
    q += (rr - q) * 0.15;
  }

  float warpStrength = u[3].x;
  float bandWidth = u[4].x;
  float count = u[4].y;
  float kBelow = clamp(warpStrength, 0.0, 1.0);
  float kMix = pow(kBelow, 0.3);
  float gain = 1.0 + max(warpStrength - 1.0, 0.0);
  vec3 col = vec3(0.0);
  float a = 1.0;

  if (count > 0.5) {
    vec2 s = q;
    vec3 sumCol = vec3(0.0);
    float cover = 0.0;
    for (int i = 0; i < MAX_COLORS; ++i) {
      if (float(i) >= count) break;
      s -= 0.01;
      vec2 r = sin(1.5 * (s.yx * frequency) + 2.0 * cos(s * frequency));
      float m0 = length(r + sin(5.0 * r.y * frequency - 3.0 * t + float(i)) / 4.0);
      vec2 disp = (r - s) * kBelow;
      vec2 warped = s + disp * gain;
      float m1 = length(warped + sin(5.0 * warped.y * frequency - 3.0 * t + float(i)) / 4.0);
      float m = mix(m0, m1, kMix);
      float w = 1.0 - exp(-bandWidth / exp(bandWidth * m));
      sumCol += u[5 + i].rgb * w;
      cover = max(cover, w);
    }
    col = clamp(sumCol, 0.0, 1.0);
    a = cover;
  } else {
    vec2 s = q;
    for (int k = 0; k < 3; ++k) {
      s -= 0.01;
      vec2 r = sin(1.5 * (s.yx * frequency) + 2.0 * cos(s * frequency));
      float m0 = length(r + sin(5.0 * r.y * frequency - 3.0 * t + float(k)) / 4.0);
      vec2 disp = (r - s) * kBelow;
      vec2 warped = s + disp * gain;
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
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453123);
    col += (n - 0.5) * noise;
    col = clamp(col, 0.0, 1.0);
  }

  // Premultiplied (React Bits' transparent mode) over the base colour.
  vec3 rgb = col * a;
  outColor = vec4((rgb + u[13].rgb * (1.0 - a)) * (1.0 - u[1].z), 1.0);
}
