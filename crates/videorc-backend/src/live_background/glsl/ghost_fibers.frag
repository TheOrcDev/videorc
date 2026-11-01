#version 300 es
// Ghost Fibers, from React Bits by David Haz (https://reactbits.dev, MIT +
// Commons Clause), used in Videorc with the author's permission. Adapted for
// Videorc (plan 194): the hover, the click pulse and the intro are constants
// (N3), dark mode only, the grain fixed in place, drawn opaque over the
// look's base colour, and uniforms are packed into `u` (layout in
// live_background/mod.rs). The dots and the dust are instanced quads
// (ghost_fibers.vert, N2); the bloom and the composite are full-screen.
//
// Passes: VIDEORC_PASS_DOTS and VIDEORC_PASS_DUST shade the quads (additive,
// into a cleared RGBA16F scene); VIDEORC_PASS_BRIGHT picks the scene's (t0)
// bright half-size level; VIDEORC_PASS_DOWN halves t0 again;
// VIDEORC_PASS_UP blurs t0 up and adds the matching down level t1 (React
// Bits adds in place with additive blending; separate targets give the same
// sum); the default pass composites the scene (t0) and the bloom's level 0
// (t1).
//
// u[2] = (twist, roll speed, waves, half width)
// u[3] = (scale, volume, fibers, dots per fiber)
// u[4] = (flow per phase, dot size, focus, depth of field)
// u[5] = (blur cap, dot length, sparkle, load)
// u[6] = (tips, gradient, fold glow, layers)
// u[7] = (glow, brightness, grain, vignette)
// u[8] = (dust size, dust gain, dust count, 0)
// u[9..12) = the orientation's columns
// u[12] = glow colour, u[13] = line colour, u[14] = secondary colour
// u[15] = base colour
precision highp float;

uniform vec4 u[16];
uniform sampler2D t0;
uniform sampler2D t1;
out vec4 outColor;

#if defined(VIDEORC_PASS_DOTS) || defined(VIDEORC_PASS_DUST)
in vec2 vLocal;
in float vRadius;
in float vSegment;
in vec3 vLight;
in float vTint;

void main() {
  float along = clamp(vLocal.x, 0.0, vSegment);
  float d = length(vec2(vLocal.x - along, vLocal.y));
  float rho = d / max(vRadius, 1e-3);
  if (rho > 1.0) discard;
  float soft = clamp(2.6 / max(vRadius, 1e-3), 0.14, 1.0);
  float disk = 1.0 - smoothstep(1.0 - soft, 1.0, rho);
  float bokeh = disk * (0.94 + 0.08 * smoothstep(0.55, 0.95, rho));
  float core = exp(-rho * rho * 3.2);
  float shape = mix(core, bokeh, smoothstep(0.25, 0.7, vLight.z));
  vec3 color = mix(mix(u[12].rgb, u[14].rgb, vTint), u[13].rgb, vLight.y);
  outColor = vec4(color * shape * vLight.x, shape * vLight.x);
}
#elif defined(VIDEORC_PASS_BRIGHT)
vec3 pick(vec2 uv) {
  vec3 c = texture(t0, uv).rgb;
  float peak = max(max(c.r, c.g), c.b);
  return c * smoothstep(0.35, 1.2, peak);
}

void main() {
  vec2 vUv = gl_FragCoord.xy / u[0].xy;
  vec2 o = 0.5 / vec2(textureSize(t0, 0));
  vec3 c = pick(vUv + vec2(-o.x, -o.y)) + pick(vUv + vec2(o.x, -o.y)) + pick(vUv + vec2(-o.x, o.y)) + pick(vUv + vec2(o.x, o.y));
  outColor = vec4(c * 0.25, 1.0);
}
#elif defined(VIDEORC_PASS_DOWN)
void main() {
  vec2 vUv = gl_FragCoord.xy / u[0].xy;
  vec2 o = 1.0 / vec2(textureSize(t0, 0));
  vec3 c = texture(t0, vUv).rgb * 4.0;
  c += texture(t0, vUv + vec2(-o.x, -o.y)).rgb;
  c += texture(t0, vUv + vec2(o.x, -o.y)).rgb;
  c += texture(t0, vUv + vec2(-o.x, o.y)).rgb;
  c += texture(t0, vUv + vec2(o.x, o.y)).rgb;
  outColor = vec4(c / 8.0, 1.0);
}
#elif defined(VIDEORC_PASS_UP)
void main() {
  vec2 vUv = gl_FragCoord.xy / u[0].xy;
  vec2 o = 0.5 / vec2(textureSize(t0, 0));
  vec3 c = texture(t0, vUv + vec2(-o.x * 2.0, 0.0)).rgb;
  c += texture(t0, vUv + vec2(-o.x, o.y)).rgb * 2.0;
  c += texture(t0, vUv + vec2(0.0, o.y * 2.0)).rgb;
  c += texture(t0, vUv + vec2(o.x, o.y)).rgb * 2.0;
  c += texture(t0, vUv + vec2(o.x * 2.0, 0.0)).rgb;
  c += texture(t0, vUv + vec2(o.x, -o.y)).rgb * 2.0;
  c += texture(t0, vUv + vec2(0.0, -o.y * 2.0)).rgb;
  c += texture(t0, vUv + vec2(-o.x, -o.y)).rgb * 2.0;
  outColor = vec4(c / 12.0 + texture(t1, vUv).rgb, 1.0);
}
#else
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float smoother(float x) {
  x = clamp(x, 0.0, 1.0);
  return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

void main() {
  vec2 vUv = gl_FragCoord.xy / u[0].xy;
  vec4 scene = texture(t0, vUv);
  vec3 bloom = texture(t1, vUv).rgb;
  vec3 light = (scene.rgb + bloom * u[7].x) * u[7].y;
  float uVignette = u[7].w;
  float reach = max(uVignette * 0.3, 1e-4);
  float mask = uVignette > 0.0 ? smoother(vUv.x / reach) * smoother((1.0 - vUv.x) / reach) * smoother(vUv.y / reach) * smoother((1.0 - vUv.y) / reach) : 1.0;
  // The grain is fixed in place (React Bits moves it every frame).
  vec2 cell = floor(vUv * u[0].xy / max(u[0].w, 1.0));
  float grain = hash(cell) + hash(cell * 1.31 + 9.1) - 1.0;
  vec3 color = (1.0 - exp(-light * 1.25)) * mask;
  float peak = max(color.r, max(color.g, color.b));
  color = max(color + grain * u[7].z * (0.25 + 0.75 * sqrt(peak)), 0.0);
  float alpha = max(color.r, max(color.g, color.b));
  outColor = vec4((color + u[15].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}
#endif
