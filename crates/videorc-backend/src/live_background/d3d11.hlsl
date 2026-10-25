// Live backgrounds (plans 190 S4 and 194 S4): the ten React Bits backgrounds
// by David Haz (https://reactbits.dev, MIT + Commons Clause), used in Videorc
// with the author's permission, ported to HLSL (Shader Model 5) from the GLSL
// source of truth in `glsl/*.frag` and `glsl/ghost_fibers.vert`. They are
// checked against the same golden grids.
//
// Porting rules (docs/live-backgrounds.md): SV_Position is top-left, so
// `gl(pos)` flips it to GLSL's bottom-left gl_FragCoord; GLSL `mod` is
// `gmod`; `pow(negative, 2)` is `sq`; textures this file renders sample at
// `(uv.x, 1 - uv.y)` for a GLSL uv and are fetched by texel at
// `(x, height - 1 - y)`; samples in divergent flow use `SampleLevel`; a
// `smoothstep` whose edges GLSL passes reversed is `hermite` (HLSL's
// intrinsic is specified for min < max only). The instanced passes (Ghost
// Fibers' dots and dust) keep GLSL's clip-space geometry, so their scene is
// top-down like every other target here; the bloom chain and the composite
// read it in this file's own space.

cbuffer LiveConstants : register(b0)
{
    float4 u[16];
};

Texture2D t0 : register(t0);
Texture2D t1 : register(t1);
SamplerState s0 : register(s0);

struct LiveVsOutput
{
    float4 position : SV_Position;
};

LiveVsOutput LiveFullScreenVs(uint vertexId : SV_VertexID)
{
    // A full-screen triangle, as GLSL's VERTEX but wound clockwise on screen:
    // D3D11's default rasterizer culls counter-clockwise (back) faces, which
    // Metal and GL don't, so GLSL's order would draw nothing here.
    float2 corners[3] = { float2(-1.0, -1.0), float2(-1.0, 3.0), float2(3.0, -1.0) };
    LiveVsOutput output;
    output.position = float4(corners[vertexId], 0.0, 1.0);
    return output;
}

float2 gl(float4 position) { return float2(position.x, u[0].y - position.y); }
float gmod(float x, float y) { return x - y * floor(x / y); }
float2 gmod2(float2 x, float y) { return x - y * floor(x / y); }
float3 gmod3(float3 x, float y) { return x - y * floor(x / y); }
float4 gmod4(float4 x, float y) { return x - y * floor(x / y); }
float sq(float x) { return x * x; }
float2 flipUv(float2 uv) { return float2(uv.x, 1.0 - uv.y); }

// GLSL's smoothstep formula, which works with reversed edges.
float hermite(float edge0, float edge1, float x)
{
    float t = saturate((x - edge0) / (edge1 - edge0));
    return t * t * (3.0 - 2.0 * t);
}

float2 hermite2(float2 edge0, float2 edge1, float2 x)
{
    float2 t = saturate((x - edge0) / (edge1 - edge0));
    return t * t * (3.0 - 2.0 * t);
}

static const float LIVE_PI = 3.141592653589793;

// WARP's `sin` range-reduces large arguments poorly (plan 194 S4). `sin` is
// 2π-periodic, so folding first keeps the hash on the hardware's accurate
// domain. Arguments of a few hundred to a few tens of thousands of radians
// (Beams' lane hash and grain) stay exact in float32; Ghost Fibers' hash11
// arguments reach 1e5–1e7 and are left on the native `sin` so Windows keeps
// the same formula as the GLSL.
float sinPeriod(float x)
{
    return sin(gmod(x, 2.0 * LIVE_PI));
}

float hash2(float2 p)
{
    p = frac(p * float2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return frac(p.x * p.y);
}

float valueNoise(float2 p)
{
    float2 i = floor(p);
    float2 f = p - i;
    float2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = hash2(i);
    float b = hash2(i + float2(1.0, 0.0));
    float c = hash2(i + float2(0.0, 1.0));
    float d = hash2(i + float2(1.0, 1.0));
    return lerp(lerp(a, b, w.x), lerp(c, d, w.x), w.y);
}

float ditherGrain(float2 fragCoord)
{
    return (frac(52.9829189 * frac(dot(fragCoord, float2(0.06711056, 0.00583715)))) - 0.5) / 255.0;
}

// The present pass: the guard's half-size frame drawn up (u[2] = 0, 0, 1, 1),
// or the poster drawn to cover the frame (u[2] = its centred uv rect).
float4 LivePresentPs(LiveVsOutput input) : SV_Target
{
    return t0.SampleLevel(s0, u[2].xy + input.position.xy / u[0].xy * u[2].zw, 0);
}

// ---------------------------------------------------------------- Silk

float silkNoise(float2 texCoord)
{
    float G = 2.71828182845904523536;
    float2 r = G * sin(G * texCoord);
    return frac(r.x * r.y * (1.0 + texCoord.x));
}

float silkPattern(float2 vUv)
{
    float scale = u[2].x;
    float angle = u[2].y;
    float c = cos(angle);
    float s = sin(angle);
    float2 scaled = vUv * scale;
    // GLSL mat2(c, -s, s, c) * v.
    float2 uv = float2(c * scaled.x + s * scaled.y, -s * scaled.x + c * scaled.y);
    float2 tex = uv * scale + u[3].yz;
    float t = u[0].z;
    tex.y += 0.03 * u[2].z * sin(8.0 * tex.x - t);
    return 0.6 + 0.4 * u[3].x * sin(5.0 * (tex.x + tex.y + cos(3.0 * tex.x + 5.0 * tex.y) + 0.02 * t) + u[2].w * sin(20.0 * (tex.x + tex.y - 0.1 * t)));
}

float4 SilkFieldPs(LiveVsOutput input) : SV_Target
{
    float2 vUv = gl(input.position) / u[0].xy;
    float n = saturate((silkPattern(vUv) - 0.2) / 0.8);
    return float4(pow(n, 6.0), 0.0, 0.0, 1.0);
}

float3 softClip(float3 c)
{
    float3 over = max(c - 0.75, 0.0);
    return min(c, 0.75) + 0.25 * (1.0 - exp(-over * 4.0));
}

float4 SilkCompositePs(LiveVsOutput input) : SV_Target
{
    float2 fragCoord = gl(input.position);
    float2 vUv = fragCoord / u[0].xy;
    float pattern = silkPattern(vUv);
    float rnd = silkNoise(fragCoord);
    float n = saturate((pattern - 0.2) / 0.8);
    float2 stepUv = u[0].w / u[1].xy;
    float gx = silkPattern(vUv + float2(stepUv.x, 0.0)) - pattern;
    float gy = silkPattern(vUv + float2(0.0, stepUv.y)) - pattern;
    float3 normal = normalize(float3(-gx * 26.0, -gy * 26.0, 1.0));
    float3 toLight = normalize(float3(u[6].yz, 0.85));
    float depth = u[4].w;
    float relief = 1.0 + (dot(normal, toLight) - toLight.z) * 1.8 * depth;
    float3 halfway = normalize(toLight + float3(0.0, 0.0, 1.0));
    float gloss = pow(max(dot(normal, halfway), 0.0), 48.0) * smoothstep(0.25, 0.85, n);
    float crest = pow(n, 5.0);
    float sheen = u[5].w;
    float shine = (gloss * 0.85 + crest * 0.4) * sheen * (1.0 + u[6].w * 0.6);
    float glow = u[6].x;
    float bloom = 0.0;
    float2 bloomUv = flipUv(vUv);
    bloom += t0.SampleLevel(s0, bloomUv, 1.0).r * 0.35;
    bloom += t0.SampleLevel(s0, bloomUv, 2.0).r * 0.3;
    bloom += t0.SampleLevel(s0, bloomUv, 3.0).r * 0.2;
    bloom += t0.SampleLevel(s0, bloomUv, 4.0).r * 0.15;
    bloom *= glow > 0.0 ? 1.0 : 0.0;
    float3 color = u[4].rgb;
    float grain = rnd / 15.0 * u[3].w;
    float floorValue = lerp(0.2, 0.03, depth);
    float curve = depth > 0.0 ? pow(n, 1.0 + 1.4 * depth) : n;
    float shade = depth > 0.0 ? floorValue + (1.0 - floorValue) * curve : pattern;
    float3 tone = lerp(color, pow(color, float3(1.45, 1.45, 1.45)), (1.0 - n) * depth);
    float3 lit = tone * shade * relief - grain;
    float3 tint = lerp(color, u[5].rgb, 0.8);
    float3 extra = tint * (shine + bloom * glow * 0.55);
    float blendAmount = saturate((sheen + glow) * 4.0);
    float3 result = lerp(saturate(lit), saturate(softClip(lit + extra)), blendAmount);
    return float4(result * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Side Rays

float shafts(float x, float t, float seed, float aa)
{
    float sway = (0.4 * sin(t * 0.31 + seed) + 0.24 * sin(t * 0.17 + seed * 2.3)) * u[7].w;
    float n = 0.7 * valueNoise(float2(x + sway + seed, t * 0.3)) + 0.3 * valueNoise(float2(x * 2.4 + sway * 1.5 + seed * 1.7, t * 0.45 + 3.0));
    float width = lerp(0.5, 0.1, u[4].z);
    float s = lerp(smoothstep(0.5 - width, 0.5 + width, n), 0.5, aa);
    return lerp(0.05, 1.0, s);
}

float motes(float2 p, float cell, float t, float seed)
{
    p += float2(t * 0.021, -t * 0.013) + seed * 7.31;
    float2 grid = p / cell;
    float2 id = floor(grid);
    float2 f = grid - id;
    float h = hash2(id + seed);
    float2 center = 0.25 + 0.5 * float2(hash2(id + 1.7 + seed), hash2(id + 3.1 + seed));
    center += 0.1 * float2(sin(t * 0.7 + h * 31.0), cos(t * 0.6 + h * 23.0));
    float size = lerp(0.035, 0.09, hash2(id + 5.3 + seed));
    float edge = length(fwidth(grid)) * 0.7;
    float twinkle = 0.55 + 0.45 * sin(t * 1.9 + h * 41.0);
    float mote = (1.0 - smoothstep(size - edge, size + edge, length(f - center))) * twinkle;
    return h > 0.5 ? 0.0 : mote;
}

float4 SideRaysPs(LiveVsOutput input) : SV_Target
{
    float2 res = u[0].xy;
    float2 fragCoord = gl(input.position);
    float aspect = res.x / res.y;
    float2 q = (fragCoord - 0.5 * res) / res.y;
    if (u[6].x > 0.5) q.x = -q.x;
    if (u[6].y > 0.5) q.y = -q.y;
    float2 rayOrigin = u[6].z > 0.5 ? float2(aspect * 0.5 + 0.42, 0.3) : float2(aspect * 0.5 + 0.1, 0.62);
    float t = u[0].z;
    float heading = (u[6].z > 0.5 ? 3.42 : -2.48) + u[6].w + 0.035 * sin(t * 0.21) * u[7].w;
    float2 v = q - rayOrigin;
    float r = length(v);
    float angle = gmod(atan2(v.y, v.x) - heading + 3.14159265, 6.28318531) - 3.14159265;
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
    float blendAmount = u[2].w;
    float3 colorA = u[2].rgb;
    float3 colorB = u[3].rgb;
    float3 glowColor = lerp(colorA, colorB, blendAmount);
    float3 light = (colorA * lightA * (1.0 - blendAmount) + colorB * lightB * blendAmount) * 2.0 * reach;
    light += glowColor * u[5].x * exp(-sq(r / 0.4));
    float dust = u[5].z;
    float sparkle = motes(q, 0.06, t, 0.0) + 0.7 * motes(q, 0.038, t * 0.8, 9.0);
    // Dust is 0 or more, so no motes is no light (the GLSL skips the work).
    light += lerp(glowColor, float3(1.0, 1.0, 1.0), 0.6) * sparkle * (lightA + lightB) * reach * dust * 2.5;
    light *= u[3].w * (1.0 - smoothstep(2.15, 2.6, r));
    float gray = dot(light, float3(0.2126, 0.7152, 0.0722));
    light = max(lerp(gray.xxx, light, u[5].y), 0.0);
    float peak = max(light.r, max(light.g, light.b));
    float grain = ditherGrain(fragCoord);
    float mapped = 1.0 - exp(-peak);
    float3 tone = light * (mapped / max(peak, 1e-4));
    tone = lerp(tone, mapped.xxx, smoothstep(0.7, 1.0, mapped) * 0.55);
    float3 shown = saturate(tone * u[5].w);
    float alpha = max(shown.r, max(shown.g, shown.b));
    float3 color = saturate(shown * alpha + grain);
    float3 premultiplied = min(color, alpha);
    return float4((premultiplied + u[8].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Line Waves

float2 rotate2(float2 p, float a)
{
    float c = cos(a);
    float s = sin(a);
    return float2(c * p.x - s * p.y, s * p.x + c * p.y);
}

float smootherstep2(float edge0, float edge1, float x)
{
    float t = saturate((x - edge0) / (edge1 - edge0));
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float lineBend(float2 p, float t)
{
    float scale = u[3].w;
    float2 q = p * 2.0 / scale;
    float w = 0.6 * sin(q.x * 0.55 + t * 0.4 + 0.6 * sin(q.y * 0.9 - t * 0.28));
    w += 0.21 * sin(q.x * 1.3 - t * 0.33 + q.y * 0.8 + 1.3);
    w += 0.12 * sin(q.y * 2.3 + q.x * 0.9 - t * 0.37 + 0.4);
    return w * u[3].z * scale * 0.46;
}

float river(float2 p, float y, float t)
{
    float drift = 0.7 * (0.18 * sin(p.x * 1.6 - t * 0.33 + 0.7) + 0.1 * sin(p.x * 3.1 + t * 0.21));
    float center = 0.5 * (0.2 * sin(t * 0.17) + 0.08 * sin(t * 0.29 + 1.3));
    float width = 0.13 * u[3].y;
    float nearBand = (y - center - drift) / width;
    float farBand = (y + 0.22 * sin(t * 0.13 + 2.0) - drift * 0.6 + 0.3) / (width * 0.55);
    return max(exp(-nearBand * nearBand), exp(-farBand * farBand) * 0.7);
}

float3 palette3(float x)
{
    x = frac(x) * 3.0;
    if (x < 1.0) return lerp(u[5].rgb, u[6].rgb, smoothstep(0.0, 1.0, x));
    if (x < 2.0) return lerp(u[6].rgb, u[7].rgb, smoothstep(1.0, 2.0, x));
    return lerp(u[7].rgb, u[5].rgb, smoothstep(2.0, 3.0, x));
}

float4 LineWavesPs(LiveVsOutput input) : SV_Target
{
    float2 res = u[0].xy;
    float2 fragCoord = gl(input.position);
    float aspect = res.x / res.y;
    float2 uv = fragCoord / res;
    float2 p = rotate2((fragCoord - 0.5 * res) / res.y, u[4].x);
    float t = u[0].z;
    float pixel = u[0].w;
    float lines = u[2].x;
    float highlight = u[3].x;
    float w = lineBend(p, t);
    float y = p.y + w;
    float phi = y * lines;
    float fw = max(fwidth(phi), 1e-5);
    float crowd = smoothstep(0.18, 0.5, fw);
    float fold = smoothstep(1.3, 2.2, fw * res.y / lines);
    float shimmer = lerp(1.0, smoothstep(0.15, 0.85, valueNoise(float2(y * 1.6 + t * 0.07, p.x * 0.55 - t * 0.22))), 0.5);
    float lit = max(river(p, y, t), fold * 0.9) * shimmer;
    float light = lerp(1.0, 0.07 + 0.93 * lit, highlight);
    float dist = abs(frac(phi + 0.5) - 0.5) / fw;
    float width = u[2].y * pixel * (1.0 + 1.5 * lit * highlight);
    float cover = saturate(min(dist + width * 0.5, 0.5) - max(dist - width * 0.5, -0.5));
    cover = lerp(cover, min(width * fw, 1.0), crowd);
    float halo = exp(-dist / (2.2 * pixel)) * (1.0 - crowd) * u[2].z;
    float threadShade = lerp(1.0, 0.55 + 0.45 * hash2(float2(floor(phi + 0.5), 7.3)), 0.45 * (1.0 - crowd));
    float span = 0.5 * sqrt(aspect * aspect + 1.0);
    float sweep = span + 0.6;
    float reveal = 1.0 - smoothstep(sweep - 0.6, sweep, p.x);
    float edge = 1.0;
    float edgeFade = u[4].z;
    if (edgeFade > 0.0)
    {
        float ex = min(uv.x, 1.0 - uv.x) * aspect;
        float ey = min(uv.y, 1.0 - uv.y);
        edge = smootherstep2(0.0, edgeFade * 0.5, ex) * smootherstep2(0.0, edgeFade * 0.5, ey);
    }
    float3 tint = palette3(y * 0.3 + p.x * 0.2 + t * u[4].y * 0.02);
    float grain = ditherGrain(fragCoord);
    float strength = (cover + halo) * threadShade * light * u[2].w * reveal * edge;
    float3 color = saturate(tint * strength * u[4].w);
    float alpha = max(color.r, max(color.g, color.b));
    color = saturate(color + grain);
    float3 premultiplied = min(color, alpha);
    return float4((premultiplied + u[8].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Liquid Chrome

float lamp(float2 p, float2 center, float2 size, float soft)
{
    float2 grown = size + soft;
    float2 q = (p - center) / grown;
    q *= q;
    float d = sqrt(sqrt(dot(q, q)));
    float edge = soft / min(grown.x, grown.y);
    float shape = (1.0 - smoothstep(1.0 - edge, 1.0 + edge, d)) * (1.0 - 0.45 * d * d);
    return shape * size.x * size.y / (grown.x * grown.y);
}

float3 studio(float3 r, float blur)
{
    float2 p = r.xy / max(r.z + 1.0, 0.05);
    p += u[5].xy * smoothstep(0.3, 1.0, length(p));
    float radius = length(p);
    float soft = 0.008 + blur;
    float2 dir = p / max(radius, 1e-3);
    float keyLight = lamp(p, float2(-0.25, 0.42), float2(0.3, 0.12), soft);
    float sideLight = lamp(p, float2(0.48, 0.12), float2(0.06, 0.3), soft);
    float ground = lamp(p, float2(-0.1, -0.55), float2(0.45, 0.06), soft);
    float rise = smoothstep(-1.0, 1.0, dir.y);
    float width = 0.015 + soft * 2.0;
    float rim = exp(-abs(radius - 1.0) / width) * 0.031 / width * (0.8 + smoothstep(-0.5, 0.8, p.y));
    float band = 1.0 - 0.95 * smoothstep(1.04 - soft, 1.12 + soft, radius);
    float wall = smoothstep(1.25, 1.55, radius) * (0.6 + 0.4 * rise);
    float streak = smoothstep(0.2, 0.8, 0.5 + 0.5 * sin(atan2(dir.y, dir.x) * 3.0 + 0.6));
    float3 color = float3(0.004, 0.004, 0.005) + 0.02 * smoothstep(-0.4, 0.6, p.y);
    color += float3(1.0, 0.97, 0.94) * keyLight * 4.0 + float3(0.9, 0.95, 1.0) * sideLight * 3.0 + ground * 1.2;
    color += float3(1.0, 0.98, 0.95) * rim;
    color *= band;
    return color + lerp(0.45, 1.8, streak) * wall;
}

float3 shadeChrome(float2 slope, float3 v, float blur, float3 f0)
{
    float steep = length(slope);
    slope *= 3.0 * tanh(steep / 3.0) / max(steep, 1e-6);
    float3 n = normalize(float3(-slope, 1.0));
    float3 r = reflect(v, n);
    float facing = saturate(dot(n, -v));
    return studio(r, blur) * (f0 + (1.0 - f0) * pow(1.0 - facing, 5.0));
}

float3 aces(float3 x)
{
    return saturate((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
}

float4 LiquidChromePs(LiveVsOutput input) : SV_Target
{
    float2 res = u[0].xy;
    float unit = min(res.x, res.y);
    float time = u[0].z;
    float2 frag = gl(input.position);
    float2 uv = (2.0 * frag - res) / unit;
    float2 p = uv;
    float2 rowX = float2(1.0, 0.0);
    float2 rowY = float2(0.0, 1.0);
    float presence = u[4].w;
    float amplitude = u[2].x * presence;
    float2 frequency = u[2].yz;
    [loop]
    for (float i = 1.0; i < 9.0; i += 1.0)
    {
        if (i > u[2].w) break;
        float a = amplitude / i;
        float soften = exp(0.3 - 0.3 * i);
        float argX = i * frequency.x * p.y + time;
        p.x += a * cos(argX);
        rowX -= a * sin(argX) * i * frequency.x * soften * rowY;
        float argY = i * frequency.y * p.x + time;
        p.y += a * cos(argY);
        rowY -= a * sin(argY) * i * frequency.y * soften * rowX;
    }
    float phase = time - p.x - p.y;
    float2 field = -(rowX + rowY);
    float density = max(length(field), 1e-3);
    float2 across = field / density;
    float k = u[3].x;
    float sn = sin(phase);
    float cs = cos(phase);
    float th = tanh(k * sn);
    float bevel = (1.0 - th * th) / tanh(k);
    float fade = smoothstep(3.0, 9.0, 3.14159 * unit / density);
    float weight = u[3].y * presence * fade;
    float2 slope = k * cs * bevel * weight * across;
    float2 sweep = -k * bevel * (sn + 2.0 * k * cs * cs * th) * weight * density * 2.0 / unit * across;
    float2 stepX = ddx(slope);
    float2 stepY = ddy(slope);
    float2 crease = dot(stepX, stepX) > dot(stepY, stepY) ? stepX : stepY;
    if (dot(crease, crease) > dot(sweep, sweep)) sweep = crease;
    float bend = length(sweep);
    float alpha = smoothstep(0.0, 0.1, length(slope));
    float3 f0 = lerp(float3(1.0, 1.0, 1.0), u[4].rgb, smoothstep(0.05, 0.6, length(slope))) * 0.92;
    float3 v = normalize(float3(uv * 0.08, -1.0));
    float blur = u[3].z * 0.35;
    float3 light;
    if (bend < 0.01)
    {
        light = shadeChrome(slope, v, blur + bend * 0.5, f0);
    }
    else
    {
        light = 0.0;
        [unroll]
        for (int tap = 0; tap < 4; tap++)
        {
            float t = -0.375 + 0.25 * tap;
            light += shadeChrome(slope + sweep * t, v, blur + bend * 0.15, f0);
        }
        light *= 0.25;
    }
    float3 color = pow(aces(light * u[3].w), 1.0 / 2.2);
    float grain = frac(52.9829189 * frac(dot(frag, float2(0.06711056, 0.00583715))));
    color += (grain - 0.5) / 255.0;
    float3 premultiplied = saturate(color) * alpha;
    return float4((premultiplied + u[6].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Plasma Wave

float4 traceLight(float2 pixel)
{
    float2 view = u[1].xy;
    float2 coord = pixel - 0.5 * view;
    float c = cos(u[2].x);
    float sn = sin(u[2].x);
    coord = float2(c * coord.x + sn * coord.y, -sn * coord.x + c * coord.y);
    float3 dir = normalize(float3(coord / view.y, u[2].y));
    float3 o = float3(0.0, 0.0, -7.0);
    float t = u[0].z * 3.14159265;
    float t1 = t * 0.7;
    float t2 = t * 0.9;
    float tSpeed1 = t * u[2].z;
    float tSpeed2 = t * u[2].w * u[3].x;
    float bend1 = u[3].y;
    float bend2 = u[3].z;
    float thickness = u[3].w;
    float3 heat = u[7].xyz;
    float s = 1.0;
    float d = 0.0;
    float2 k = 0.0;
    [loop]
    for (int i = 0; i < 14; ++i)
    {
        float3 p = o + dir * d;
        p.x -= 15.0;
        float px = p.x;
        float swell = heat.y * exp(-sq((px - heat.x) / heat.z));
        float wob1 = bend1 + swell * (0.16 + 0.2 * bend1) + sin(t1 + px * 0.8) * 0.1;
        float wob2 = bend2 + swell * (0.16 + 0.2 * bend2) + cos(t2 + px * 1.1) * 0.1;
        float2 a = sin(float2(px, px + 1.5707963) + tSpeed1) * wob1;
        float2 b = cos(float2(px, px + 1.5707963) + tSpeed2) * wob2;
        float cut = px + thickness;
        k.x = max(cut, length(p.yz - a) - thickness);
        k.y = max(cut, length(p.yz - b) - thickness);
        s = min(s, min(k.x, k.y));
        if (s < 0.001 || d > 300.0) break;
        d += s * 0.7;
    }
    float3 raw = max(cos(d * 6.28318531) - s * sqrt(d) - float3(k, 0.0), 0.0);
    float field = max(raw.r, max(raw.g, raw.b));
    raw.gb += 0.1;
    raw = raw * 0.4 + raw.brg * 0.6 + raw * raw;
    float lum = dot(raw, float3(0.299, 0.587, 0.114));
    float w1 = max(0.0, 1.0 - k.x * 2.0) + 0.0001;
    float w2 = max(0.0, 1.0 - k.y * 2.0) + 0.0001;
    float3 tubeColor = (u[5].rgb * w1 + u[6].rgb * w2) / (w1 + w2);
    float soft = smoothstep(0.03, 0.36, field);
    float hot = smoothstep(0.32, 0.8, field);
    float3 light = tubeColor * lum * 2.6 * soft + lerp(tubeColor, float3(1.0, 1.0, 1.0), 0.55) * hot * u[4].x * 2.0;
    return float4(light, field);
}

float4 PlasmaCoarsePs(LiveVsOutput input) : SV_Target
{
    return traceLight(gl(input.position) * (u[1].xy / u[0].xy));
}

float coarseAlpha(int2 cell, int2 last)
{
    int2 q = clamp(cell, int2(0, 0), last);
    // GLSL texel rows run bottom-up; this file's textures run top-down.
    return t0.Load(int3(q.x, last.y - q.y, 0)).a;
}

float4 PlasmaFinePs(LiveVsOutput input) : SV_Target
{
    uint coarseWidth;
    uint coarseHeight;
    t0.GetDimensions(coarseWidth, coarseHeight);
    float2 coarseSize = float2(coarseWidth, coarseHeight);
    float2 fragCoord = gl(input.position);
    float2 uv = fragCoord / u[0].xy;
    float2 pos = uv * coarseSize - 0.5;
    int2 cell = int2(floor(pos));
    int2 last = int2(coarseSize) - 1;
    float a = coarseAlpha(cell, last);
    float b = coarseAlpha(cell + int2(1, 0), last);
    float c = coarseAlpha(cell + int2(0, 1), last);
    float d = coarseAlpha(cell + int2(1, 1), last);
    float high = max(max(a, b), max(c, d));
    float low = min(min(a, b), min(c, d));
    if (high > 0.02 && low < 0.4) return traceLight(fragCoord * (u[1].xy / u[0].xy));
    return t0.SampleLevel(s0, flipUv(uv), 0);
}

float4 PlasmaDownPs(LiveVsOutput input) : SV_Target
{
    // Symmetric taps: sample in this file's own top-down space.
    float2 uv = input.position.xy / u[0].xy;
    uint width;
    uint height;
    t0.GetDimensions(width, height);
    float2 texel = 1.0 / float2(width, height);
    float4 sum = t0.SampleLevel(s0, uv, 0) * 4.0;
    sum += t0.SampleLevel(s0, uv - texel, 0);
    sum += t0.SampleLevel(s0, uv + texel, 0);
    sum += t0.SampleLevel(s0, uv + float2(texel.x, -texel.y), 0);
    sum += t0.SampleLevel(s0, uv - float2(texel.x, -texel.y), 0);
    return sum / 8.0;
}

float4 PlasmaUpPs(LiveVsOutput input) : SV_Target
{
    float2 uv = input.position.xy / u[0].xy;
    uint width;
    uint height;
    t0.GetDimensions(width, height);
    float2 h = 0.5 / float2(width, height);
    float4 sum = t0.SampleLevel(s0, uv + float2(-h.x * 2.0, 0.0), 0);
    sum += t0.SampleLevel(s0, uv + float2(h.x * 2.0, 0.0), 0);
    sum += t0.SampleLevel(s0, uv + float2(0.0, -h.y * 2.0), 0);
    sum += t0.SampleLevel(s0, uv + float2(0.0, h.y * 2.0), 0);
    sum += t0.SampleLevel(s0, uv + float2(-h.x, h.y), 0) * 2.0;
    sum += t0.SampleLevel(s0, uv + h, 0) * 2.0;
    sum += t0.SampleLevel(s0, uv + float2(h.x, -h.y), 0) * 2.0;
    sum += t0.SampleLevel(s0, uv - h, 0) * 2.0;
    return sum / 12.0 + t1.SampleLevel(s0, uv, 0);
}

float4 PlasmaCompositePs(LiveVsOutput input) : SV_Target
{
    float2 uv = input.position.xy / u[0].xy;
    float2 fragCoord = gl(input.position);
    float exposure = u[4].y;
    float3 hdr = t0.SampleLevel(s0, uv, 0).rgb * exposure;
    hdr += t1.SampleLevel(s0, uv, 0).rgb * exposure * u[4].z * 0.18;
    float grain = (hash2(fragCoord + frac(u[0].z * 7.31) * 113.0) - 0.5) * u[4].w;
    float3 mapped = 1.0 - exp(-hdr);
    float level = max(mapped.r, max(mapped.g, mapped.b));
    mapped = saturate(mapped + grain * level) * u[5].w;
    float alpha = max(mapped.r, max(mapped.g, mapped.b));
    return float4((mapped + u[8].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Beams (plan 194)

float4 beamsPermute(float4 x) { return gmod4(((x * 34.0) + 1.0) * x, 289.0); }
float4 beamsTaylorInvSqrt(float4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float3 beamsFade(float3 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

float beamsNoise(float3 P)
{
    float3 Pi0 = floor(P);
    float3 Pi1 = Pi0 + 1.0;
    Pi0 = gmod3(Pi0, 289.0);
    Pi1 = gmod3(Pi1, 289.0);
    float3 Pf0 = frac(P);
    float3 Pf1 = Pf0 - 1.0;
    float4 ix = float4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
    float4 iy = float4(Pi0.yy, Pi1.yy);
    float4 iz0 = Pi0.zzzz;
    float4 iz1 = Pi1.zzzz;
    float4 ixy = beamsPermute(beamsPermute(ix) + iy);
    float4 ixy0 = beamsPermute(ixy + iz0);
    float4 ixy1 = beamsPermute(ixy + iz1);
    float4 gx0 = ixy0 / 7.0;
    float4 gy0 = frac(floor(gx0) / 7.0) - 0.5;
    gx0 = frac(gx0);
    float4 gz0 = 0.5 - abs(gx0) - abs(gy0);
    float4 sz0 = step(gz0, float4(0.0, 0.0, 0.0, 0.0));
    gx0 -= sz0 * (step(float4(0.0, 0.0, 0.0, 0.0), gx0) - 0.5);
    gy0 -= sz0 * (step(float4(0.0, 0.0, 0.0, 0.0), gy0) - 0.5);
    float4 gx1 = ixy1 / 7.0;
    float4 gy1 = frac(floor(gx1) / 7.0) - 0.5;
    gx1 = frac(gx1);
    float4 gz1 = 0.5 - abs(gx1) - abs(gy1);
    float4 sz1 = step(gz1, float4(0.0, 0.0, 0.0, 0.0));
    gx1 -= sz1 * (step(float4(0.0, 0.0, 0.0, 0.0), gx1) - 0.5);
    gy1 -= sz1 * (step(float4(0.0, 0.0, 0.0, 0.0), gy1) - 0.5);
    float3 g000 = float3(gx0.x, gy0.x, gz0.x);
    float3 g100 = float3(gx0.y, gy0.y, gz0.y);
    float3 g010 = float3(gx0.z, gy0.z, gz0.z);
    float3 g110 = float3(gx0.w, gy0.w, gz0.w);
    float3 g001 = float3(gx1.x, gy1.x, gz1.x);
    float3 g101 = float3(gx1.y, gy1.y, gz1.y);
    float3 g011 = float3(gx1.z, gy1.z, gz1.z);
    float3 g111 = float3(gx1.w, gy1.w, gz1.w);
    float4 norm0 = beamsTaylorInvSqrt(float4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
    g000 *= norm0.x;
    g010 *= norm0.y;
    g100 *= norm0.z;
    g110 *= norm0.w;
    float4 norm1 = beamsTaylorInvSqrt(float4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
    g001 *= norm1.x;
    g011 *= norm1.y;
    g101 *= norm1.z;
    g111 *= norm1.w;
    float n000 = dot(g000, Pf0);
    float n100 = dot(g100, float3(Pf1.x, Pf0.yz));
    float n010 = dot(g010, float3(Pf0.x, Pf1.y, Pf0.z));
    float n110 = dot(g110, float3(Pf1.xy, Pf0.z));
    float n001 = dot(g001, float3(Pf0.xy, Pf1.z));
    float n101 = dot(g101, float3(Pf1.x, Pf0.y, Pf1.z));
    float n011 = dot(g011, float3(Pf0.x, Pf1.yz));
    float n111 = dot(g111, Pf1);
    float3 fade_xyz = beamsFade(Pf0);
    float4 n_z = lerp(float4(n000, n100, n010, n110), float4(n001, n101, n011, n111), fade_xyz.z);
    float2 n_yz = lerp(n_z.xy, n_z.zw, fade_xyz.y);
    float n_xyz = lerp(n_yz.x, n_yz.y, fade_xyz.x);
    return 2.2 * n_xyz;
}

float beamsLaneHash(float lane)
{
    return frac(sinPeriod(lane * 91.3458 + u[4].x * 17.17) * 47453.5453);
}

float beamsLobe(float nh, float nl, float nv, float vh, float roughness)
{
    float a = roughness * roughness;
    float a2 = a * a;
    float d = nh * nh * (a2 - 1.0) + 1.0;
    float distribution = a2 / (LIVE_PI * d * d);
    float gv = nl * sqrt(nv * nv * (1.0 - a2) + a2);
    float gL = nv * sqrt(nl * nl * (1.0 - a2) + a2);
    float visibility = 0.5 / max(gv + gL, 0.0001);
    float fresnel = 0.028 + 0.972 * pow(1.0 - vh, 5.0);
    return distribution * visibility * fresnel * nl;
}

float2 beamsGlint(float lane, float2 local, float uTime, float camera)
{
    float along = local.y / u[2].y - beamsLaneHash(lane) * 60.0;
    float h = 0.01;
    float slope = (beamsNoise(float3(0.0, along + h, uTime)) - beamsNoise(float3(0.0, along - h, uTime))) / (2.0 * h);
    slope *= 0.2 * u[2].z;
    float spin = beamsLaneHash(lane + 0.37);
    float tilt = ((spin - 0.5) * 0.5 + sin(uTime * 2.1 + spin * 6.2831) * 0.06) * u[3].z;
    float3 normal = normalize(float3(tilt, -slope, 1.0));
    float3 view = normalize(float3(-local, camera));
    float nv = max(dot(normal, view), 0.0001);
    // The light rests at React Bits' (0, 3, 10): the intro sweep is over and
    // the pointer never lifts it.
    float3 light = normalize(float3(0.0, 3.0, 10.0));
    float3 halfway = normalize(light + view);
    float roughness = u[2].w;
    float core = beamsLobe(max(dot(normal, halfway), 0.0), max(dot(normal, light), 0.0), nv, max(dot(view, halfway), 0.0), roughness);
    float3 fill = normalize(float3(0.0, -3.0 * 1.25, 10.0));
    float3 fillHalf = normalize(fill + view);
    core += u[3].w * beamsLobe(max(dot(normal, fillHalf), 0.0), max(dot(normal, fill), 0.0), nv, max(dot(view, fillHalf), 0.0), roughness);
    return float2(core, core);
}

float4 BeamsFieldPs(LiveVsOutput input) : SV_Target
{
    // React Bits sizes the beams in CSS pixels; one is min(view) / 1080 render
    // pixels, so uScale is CSS pixels per field texel.
    float2 viewCss = u[1].xy / u[0].w;
    float2 uScale = viewCss / u[0].xy;
    float2 css = gl(input.position) * uScale;
    float2 centered = css - viewCss * 0.5;
    // GLSL mat2(c, -s, s, c) * v.
    float2 local = float2(u[3].x * centered.x + u[3].y * centered.y, -u[3].y * centered.x + u[3].x * centered.y);
    float uTime = gmod(u[0].z * 0.12, 289.0);
    float camera = viewCss.y * 1.866;
    float across = local.x / u[2].x + 0.5;
    float lane = floor(across);
    float along = across - lane;
    float2 value = beamsGlint(lane, local, uTime, camera);
    float pixel = max(uScale.x, uScale.y);
    float seam = min(along, 1.0 - along) * u[2].x;
    if (seam < pixel * 1.5)
    {
        float other = along < 0.5 ? lane - 1.0 : lane + 1.0;
        float blendAmount = 0.5 * (1.0 - smoothstep(0.0, pixel * 1.5, seam));
        value = lerp(value, beamsGlint(other, local, uTime, camera), blendAmount);
    }
    // The pointer rests (React Bits' uPointer.z = 0), so nothing brightens
    // near it.
    float hot = max(value.y - 0.18, 0.0);
    return float4(value.x, value.y, min(hot, 6.0), 1.0);
}

float beamsRandom(float2 st)
{
    return frac(sinPeriod(dot(st, float2(12.9898, 78.233))) * 43758.5453123);
}

float beamsGrain(float2 st)
{
    float2 i = floor(st);
    float2 f = frac(st);
    float a = beamsRandom(i);
    float b = beamsRandom(i + float2(1.0, 0.0));
    float c = beamsRandom(i + float2(0.0, 1.0));
    float d = beamsRandom(i + float2(1.0, 1.0));
    float2 w = f * f * (3.0 - 2.0 * f);
    return lerp(a, b, w.x) + (c - a) * w.y * (1.0 - w.x) + (d - b) * w.x * w.y;
}

float3 beamsAces(float3 color)
{
    // GLSL's mat3 constructors take columns: written out as such.
    color = color / 0.6;
    color = float3(0.59719, 0.07600, 0.02840) * color.x + float3(0.35458, 0.90834, 0.13383) * color.y + float3(0.04823, 0.01566, 0.83777) * color.z;
    float3 a = color * (color + 0.0245786) - 0.000090537;
    float3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
    float3 q = a / b;
    color = float3(1.60475, -0.10208, -0.00327) * q.x + float3(-0.53108, 1.10813, -0.07276) * q.y + float3(-0.07367, -0.00605, 1.07602) * q.z;
    return saturate(color);
}

float3 beamsToSrgb(float3 color)
{
    return lerp(color * 12.92, 1.055 * pow(color, 1.0 / 2.4) - 0.055, step(float3(0.0031308, 0.0031308, 0.0031308), color));
}

float4 BeamsCompositePs(LiveVsOutput input) : SV_Target
{
    float2 fragCoord = gl(input.position);
    // The field renders top-down here, so its uv is this file's own.
    float2 uv = input.position.xy / u[0].xy;
    float radiance = t0.SampleLevel(s0, uv, 0.0).r;
    float bloom = 0.0;
    bloom += t0.SampleLevel(s0, uv, 2.0).b * 0.3;
    bloom += t0.SampleLevel(s0, uv, 3.0).b * 0.3;
    bloom += t0.SampleLevel(s0, uv, 4.0).b * 0.22;
    bloom += t0.SampleLevel(s0, uv, 5.0).b * 0.18;
    float hot = t0.SampleLevel(s0, uv, 0.0).g;
    float3 tint = u[5].rgb;
    float gain = u[4].y;
    float3 light = tint * (radiance + bloom * u[4].z) * gain;
    light += lerp(tint, float3(1.0, 1.0, 1.0), 0.7) * hot * hot * 0.12 * gain;
    // The intro is finished (React Bits' uPresence = 1).
    float3 color = beamsToSrgb(beamsAces(light));
    color -= beamsGrain(fragCoord) / 15.0 * u[4].w;
    color = max(color, 0.0);
    // No edge fade and full opacity: React Bits' mask is 1.
    float dither = (beamsRandom(fragCoord.yx + 31.7) - 0.5) / 255.0;
    color = saturate(color + dither);
    float alpha = max(color.r, max(color.g, color.b));
    return float4((color + u[6].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Color Bends (plan 194)

float4 ColorBendsPs(LiveVsOutput input) : SV_Target
{
    float2 fragCoord = gl(input.position);
    float2 vUv = fragCoord / u[0].xy;
    float t = u[0].z;
    float2 p = vUv * 2.0 - 1.0;
    float2 rp = float2(p.x * u[2].x - p.y * u[2].y, p.x * u[2].y + p.y * u[2].x);
    float2 q = float2(rp.x * (u[0].x / u[0].y), rp.y);
    q /= max(u[2].z, 0.0001);
    q /= 0.5 + 0.2 * dot(q, q);
    q += 0.2 * cos(t) - 7.56;
    // The pointer rests at the centre (React Bits' uPointer = 0).
    float2 toward = -rp;
    q += toward * u[4].z * 0.2;

    float frequency = u[2].w;
    float iterations = u[3].z;
    [loop]
    for (int j = 0; j < 5; j++)
    {
        if (float(j) >= iterations - 1.0) break;
        float2 rr = sin(1.5 * (q.yx * frequency) + 2.0 * cos(q * frequency));
        q += (rr - q) * 0.15;
    }

    float warpStrength = u[3].x;
    float bandWidth = u[4].x;
    float count = u[4].y;
    float kBelow = saturate(warpStrength);
    float kMix = pow(kBelow, 0.3);
    float gain = 1.0 + max(warpStrength - 1.0, 0.0);
    float3 col = float3(0.0, 0.0, 0.0);
    float a = 1.0;

    if (count > 0.5)
    {
        float2 s = q;
        float3 sumCol = float3(0.0, 0.0, 0.0);
        float cover = 0.0;
        [loop]
        for (int i = 0; i < 8; ++i)
        {
            if (float(i) >= count) break;
            s -= 0.01;
            float2 r = sin(1.5 * (s.yx * frequency) + 2.0 * cos(s * frequency));
            float m0 = length(r + sin(5.0 * r.y * frequency - 3.0 * t + float(i)) / 4.0);
            float2 disp = (r - s) * kBelow;
            float2 warped = s + disp * gain;
            float m1 = length(warped + sin(5.0 * warped.y * frequency - 3.0 * t + float(i)) / 4.0);
            float m = lerp(m0, m1, kMix);
            float w = 1.0 - exp(-bandWidth / exp(bandWidth * m));
            sumCol += u[5 + i].rgb * w;
            cover = max(cover, w);
        }
        col = saturate(sumCol);
        a = cover;
    }
    else
    {
        float2 s = q;
        [unroll]
        for (int k = 0; k < 3; ++k)
        {
            s -= 0.01;
            float2 r = sin(1.5 * (s.yx * frequency) + 2.0 * cos(s * frequency));
            float m0 = length(r + sin(5.0 * r.y * frequency - 3.0 * t + float(k)) / 4.0);
            float2 disp = (r - s) * kBelow;
            float2 warped = s + disp * gain;
            float m1 = length(warped + sin(5.0 * warped.y * frequency - 3.0 * t + float(k)) / 4.0);
            float m = lerp(m0, m1, kMix);
            col[k] = 1.0 - exp(-bandWidth / exp(bandWidth * m));
        }
        a = max(max(col.r, col.g), col.b);
    }

    col *= u[3].w;

    float noiseAmount = u[3].y;
    if (noiseAmount > 0.0001)
    {
        // Fixed in place: React Bits adds the time to the hash every frame.
        float n = frac(sin(dot(fragCoord, float2(12.9898, 78.233))) * 43758.5453123);
        col += (n - 0.5) * noiseAmount;
        col = saturate(col);
    }

    // Premultiplied (React Bits' transparent mode) over the base colour.
    float3 rgb = col * a;
    return float4((rgb + u[13].rgb * (1.0 - a)) * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Dither (plan 194)

// One cell in render pixels: the look's pixel size in CSS pixels (one is
// min(view) / 1080 render pixels), at least one. sizes::dither_cell.
float ditherCellSize() { return max(1.0, floor(u[3].z * u[0].w + 0.5)); }

float4 ditherMod289(float4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
float4 ditherPermute(float4 x) { return ditherMod289(((x * 34.0) + 1.0) * x); }
float4 ditherTaylorInvSqrt(float4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float2 ditherFade(float2 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

float ditherNoise(float2 P)
{
    float4 Pi = floor(P.xyxy) + float4(0.0, 0.0, 1.0, 1.0);
    float4 Pf = frac(P.xyxy) - float4(0.0, 0.0, 1.0, 1.0);
    Pi = ditherMod289(Pi);
    float4 ix = Pi.xzxz;
    float4 iy = Pi.yyww;
    float4 fx = Pf.xzxz;
    float4 fy = Pf.yyww;
    float4 i = ditherPermute(ditherPermute(ix) + iy);
    float4 gx = frac(i * (1.0 / 41.0)) * 2.0 - 1.0;
    float4 gy = abs(gx) - 0.5;
    float4 tx = floor(gx + 0.5);
    gx = gx - tx;
    float2 g00 = float2(gx.x, gy.x);
    float2 g10 = float2(gx.y, gy.y);
    float2 g01 = float2(gx.z, gy.z);
    float2 g11 = float2(gx.w, gy.w);
    float4 norm = ditherTaylorInvSqrt(float4(dot(g00, g00), dot(g01, g01), dot(g10, g10), dot(g11, g11)));
    g00 *= norm.x;
    g01 *= norm.y;
    g10 *= norm.z;
    g11 *= norm.w;
    float n00 = dot(g00, float2(fx.x, fy.x));
    float n10 = dot(g10, float2(fx.y, fy.y));
    float n01 = dot(g01, float2(fx.z, fy.z));
    float n11 = dot(g11, float2(fx.w, fy.w));
    float2 fadeXY = ditherFade(Pf.xy);
    float2 nx = lerp(float2(n00, n01), float2(n10, n11), fadeXY.x);
    return 2.3 * lerp(nx.x, nx.y, fadeXY.y);
}

float ditherFbm(float2 p)
{
    float value = 0.0;
    float amp = 1.0;
    [unroll]
    for (int i = 0; i < 4; i++)
    {
        value += amp * abs(ditherNoise(p));
        p *= u[2].y;
        amp *= u[2].z;
    }
    return value;
}

float ditherPattern(float2 p)
{
    float2 p2 = p - u[0].z * u[2].x;
    return ditherFbm(p + ditherFbm(p2));
}

float4 DitherWavePs(LiveVsOutput input) : SV_Target
{
    float ratio = u[0].w;
    float cell = ditherCellSize();
    // React Bits works in CSS pixels here: the canvas over its device ratio.
    float2 uResolution = u[1].xy / ratio;
    float uCell = cell / ratio;
    float2 corner = (gl(input.position) - 0.5) * uCell;
    float2 uv = corner / uResolution - 0.5;
    uv.x *= uResolution.x / uResolution.y;
    // No trail, no ripples (N3).
    float f = ditherPattern(uv / u[2].w);
    f = (f - 0.5) * u[3].x + 0.5 + u[3].y;
    // The intro reveal is finished (React Bits' show = 1).
    float v = saturate(f);
    return float4(floor(v * 255.0) / 255.0, frac(v * 255.0), 0.0, 1.0);
}

static const float DITHER_BAYER8[64] = {
    0.0 / 64.0, 48.0 / 64.0, 12.0 / 64.0, 60.0 / 64.0, 3.0 / 64.0, 51.0 / 64.0, 15.0 / 64.0, 63.0 / 64.0,
    32.0 / 64.0, 16.0 / 64.0, 44.0 / 64.0, 28.0 / 64.0, 35.0 / 64.0, 19.0 / 64.0, 47.0 / 64.0, 31.0 / 64.0,
    8.0 / 64.0, 56.0 / 64.0, 4.0 / 64.0, 52.0 / 64.0, 11.0 / 64.0, 59.0 / 64.0, 7.0 / 64.0, 55.0 / 64.0,
    40.0 / 64.0, 24.0 / 64.0, 36.0 / 64.0, 20.0 / 64.0, 43.0 / 64.0, 27.0 / 64.0, 39.0 / 64.0, 23.0 / 64.0,
    2.0 / 64.0, 50.0 / 64.0, 14.0 / 64.0, 62.0 / 64.0, 1.0 / 64.0, 49.0 / 64.0, 13.0 / 64.0, 61.0 / 64.0,
    34.0 / 64.0, 18.0 / 64.0, 46.0 / 64.0, 30.0 / 64.0, 33.0 / 64.0, 17.0 / 64.0, 45.0 / 64.0, 29.0 / 64.0,
    10.0 / 64.0, 58.0 / 64.0, 6.0 / 64.0, 54.0 / 64.0, 9.0 / 64.0, 57.0 / 64.0, 5.0 / 64.0, 53.0 / 64.0,
    42.0 / 64.0, 26.0 / 64.0, 38.0 / 64.0, 22.0 / 64.0, 41.0 / 64.0, 25.0 / 64.0, 37.0 / 64.0, 21.0 / 64.0
};

static const float DITHER_BAYER4[16] = {
    0.0 / 16.0, 8.0 / 16.0, 2.0 / 16.0, 10.0 / 16.0,
    12.0 / 16.0, 4.0 / 16.0, 14.0 / 16.0, 6.0 / 16.0,
    3.0 / 16.0, 11.0 / 16.0, 1.0 / 16.0, 9.0 / 16.0,
    15.0 / 16.0, 7.0 / 16.0, 13.0 / 16.0, 5.0 / 16.0
};

static const float DITHER_BAYER2[4] = { 0.0 / 4.0, 2.0 / 4.0, 3.0 / 4.0, 1.0 / 4.0 };

static const float3 DITHER_LUMA = float3(0.2126, 0.7152, 0.0722);

// React Bits' MODES: bayer 0, bayer4 1, bayer2 2, halftone 3, lines 4,
// crosshatch 5, noise 6, none 7.
float ditherThreshold(float2 cell)
{
    int mode = int(u[3].w + 0.5);
    if (mode == 1)
    {
        int2 c = int2(gmod2(cell, 4.0));
        return DITHER_BAYER4[c.y * 4 + c.x];
    }
    if (mode == 2)
    {
        int2 c = int2(gmod2(cell, 2.0));
        return DITHER_BAYER2[c.y * 2 + c.x];
    }
    if (mode == 3)
    {
        float2 r = float2(cell.x + cell.y, cell.x - cell.y) * 0.70710678 / 4.0;
        return clamp(length(frac(r) - 0.5) * 1.41421356, 0.0, 0.999);
    }
    if (mode == 4)
    {
        return abs(frac(cell.y / 4.0) - 0.5) * 2.0 * 0.999;
    }
    if (mode == 5)
    {
        float a = abs(frac((cell.x + cell.y) / 6.0) - 0.5) * 2.0;
        float b = abs(frac((cell.x - cell.y) / 6.0) - 0.5) * 2.0;
        return min(a, b) * 0.999;
    }
    if (mode == 6)
    {
        return frac(52.9829189 * frac(dot(cell, float2(0.06711056, 0.00583715))));
    }
    if (mode == 7)
    {
        return 0.25;
    }
    int2 c8 = int2(gmod2(cell, 8.0));
    return DITHER_BAYER8[c8.y * 8 + c8.x];
}

float3 ditherToSrgb(float3 c)
{
    c = saturate(c);
    return lerp(c * 12.92, 1.055 * pow(c, 1.0 / 2.4) - 0.055, step(float3(0.0031308, 0.0031308, 0.0031308), c));
}

float4 DitherCompositePs(LiveVsOutput input) : SV_Target
{
    float2 cell = floor(gl(input.position) / ditherCellSize());
    uint fieldWidth;
    uint fieldHeight;
    t0.GetDimensions(fieldWidth, fieldHeight);
    int2 last = int2(fieldWidth, fieldHeight) - 1;
    int2 c = clamp(int2(cell), int2(0, 0), last);
    // GLSL texel rows run bottom-up; this file's textures run top-down.
    float4 sampleValue = t0.Load(int3(c.x, last.y - c.y, 0));
    float f = sampleValue.r + sampleValue.g / 255.0;
    float t = ditherThreshold(cell) - 0.25;
    float paletteCount = u[4].y;
    float3 color;

    if (paletteCount > 1.5)
    {
        float n = paletteCount;
        float v = f + t / (n - 1.0);
        v = saturate(v - lerp(0.2, 0.0, smoothstep(0.45, 0.8, v)));
        int index = int(floor(v * (n - 1.0) + 0.5));
        color = ditherToSrgb(u[7 + index].rgb);
    }
    else
    {
        float levels = max(u[4].x, 1.01) - 1.0;
        float3 wave = u[5].rgb;
        float3 background = u[6].rgb;
        float base = dot(background, DITHER_LUMA);
        float3 offset = (wave - base) * f + t / levels;
        float luminance = dot(background + offset, DITHER_LUMA);
        offset -= lerp(0.2, 0.0, smoothstep(0.45, 0.8, luminance));
        bool rising = dot(wave, DITHER_LUMA) >= base;
        float lower = rising ? 0.0 : -max(background.r, max(background.g, background.b));
        float upper = rising ? 1.0 - min(background.r, min(background.g, background.b)) : 0.0;
        offset = floor(clamp(offset, lower, upper) * levels + 0.5) / levels;
        color = ditherToSrgb(background + offset);
    }
    return float4(color * (1.0 - u[1].z), 1.0);
}

// ---------------------------------------------------------------- Ferrofluid (plan 194)

static const float FERRO_CELL = 1.0 / 3.0;
static const float FERRO_BOUND_CELL = 1.0;
// tan(19°): half of React Bits' 38° field of view.
static const float FERRO_TAN_HALF = 0.34432761;

// Where a camera ray through NDC (x, y) meets the ground (React Bits'
// groundAt).
float2 ferroGroundAt(float x, float y, float aspect)
{
    float3 d = normalize(float3(x * aspect * FERRO_TAN_HALF, u[5].x + y * FERRO_TAN_HALF * u[5].z, u[5].y + y * FERRO_TAN_HALF * u[5].w));
    float t = d.z < -0.004 ? min(-u[4].y / d.z, u[4].z) : u[4].z;
    return float2(d.x * t, u[4].x + d.y * t);
}

// The grid's corner for this view (React Bits' layout()): the four corner
// rays and the top centre meet the ground, padded by three units.
// sizes::ferrofluid_grid cells the same footprint, so the grid texture is
// exactly this origin plus its size × CELL.
float2 ferroGridOrigin()
{
    float aspect = u[1].x / u[1].y;
    float2 a = ferroGroundAt(-1.0, -1.0, aspect);
    float2 b = ferroGroundAt(1.0, -1.0, aspect);
    float2 c = ferroGroundAt(-1.0, 1.0, aspect);
    float2 d = ferroGroundAt(1.0, 1.0, aspect);
    float2 e = ferroGroundAt(0.0, 1.0, aspect);
    return min(min(min(a, b), min(c, d)), e) - 3.0;
}

float ferroHash(float2 p)
{
    float3 p3 = frac(float3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return frac((p3.x + p3.y) * p3.z);
}

float ferroNoise(float2 p)
{
    float2 i = floor(p);
    float2 f = frac(p);
    float2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = ferroHash(i);
    float b = ferroHash(i + float2(1.0, 0.0));
    float c = ferroHash(i + float2(0.0, 1.0));
    float d = ferroHash(i + float2(1.0, 1.0));
    return lerp(lerp(a, b, w.x), lerp(c, d, w.x), w.y);
}

float ferroFlowField(float2 p)
{
    float uTime = u[0].z;
    float2 q = p / 5.5 + u[3].xy;
    float2 drift = u[2].xy * uTime * 0.55;
    float2 warp = float2(ferroNoise(q * 0.6 + float2(uTime * 0.07, 3.1)), ferroNoise(q * 0.6 - float2(7.3, uTime * 0.06))) - 0.5;
    float2 r = q + warp * 1.8 * u[2].z - drift;
    float n = ferroNoise(r) * 0.65 + ferroNoise(r * 2.03 + 11.7 - drift * 0.5) * 0.35;
    return smoothstep(0.44, 0.86, n);
}

float4 FerrofluidFieldPs(LiveVsOutput input) : SV_Target
{
    float2 texel = floor(gl(input.position));
    float2 p = ferroGridOrigin() + (texel + 0.5) * FERRO_CELL;
    float swell = ferroFlowField(p);
    float field = u[2].w * (0.03 + 1.0 * swell * swell);
    // No cursor and no pulse add to the field; the intro front has passed.
    float height = u[3].z * min(pow(max(field - 0.04, 0.0), 1.6), 1.0);
    // N1: the height is the target itself (uSettle); no velocity, no mound.
    return float4(height, 0.0, 0.0, 1.0);
}

float4 FerrofluidBoundPs(LiveVsOutput input) : SV_Target
{
    float2 origin = ferroGridOrigin();
    uint stateWidth;
    uint stateHeight;
    t0.GetDimensions(stateWidth, stateHeight);
    float2 stateSize = float2(stateWidth, stateHeight);
    float2 center = origin + (floor(gl(input.position)) + 0.5) * FERRO_BOUND_CELL;
    float2 base = floor((center - origin) / FERRO_CELL);
    float top = 0.0;
    float peak = 0.0;
    [loop]
    for (int y = -4; y <= 4; y++)
    {
        [loop]
        for (int x = -4; x <= 4; x++)
        {
            float2 texel = clamp(base + float2(float(x), float(y)), float2(0.0, 0.0), stateSize - 1.0);
            int2 at = int2(texel);
            // GLSL texel rows run bottom-up; this file's textures run top-down.
            float4 s = t0.Load(int3(at.x, int(stateHeight) - 1 - at.y, 0));
            top = max(top, max(s.x, 0.0) * 1.05 + s.z);
            peak = max(peak, s.x);
        }
    }
    return float4(top, peak, 0.0, 1.0);
}

static const float FERRO_G = 7.2551975;
static const float2 FERRO_E1 = float2(0.8660254, 0.5);
static const float2 FERRO_E2 = float2(-0.8660254, 0.5);
static const float2 FERRO_E3 = float2(0.0, -1.0);
static const float FERRO_F0 = 0.06;

// GLSL's TURN = mat2(0.9902681, 0.1391731, -0.1391731, 0.9902681): `TURN * p`
// and the row-vector `v * TURN`.
float2 ferroTurn(float2 p) { return float2(0.9902681 * p.x - 0.1391731 * p.y, 0.1391731 * p.x + 0.9902681 * p.y); }
float2 ferroTurnRow(float2 v) { return float2(0.9902681 * v.x + 0.1391731 * v.y, -0.1391731 * v.x + 0.9902681 * v.y); }

float2 ferroLattice(float2 p)
{
    float2 q = ferroTurn(p);
    // React Bits' render time is twice the simulation's.
    float t = u[0].z * 2.0 * 0.35;
    return q + u[7].x * float2(sin(q.y * 0.9 + t), cos(q.x * 0.8 - t * 0.8));
}

float ferroPixelAngle() { return (2.0 * FERRO_TAN_HALF) / u[0].y; }

float ferroDetail(float t)
{
    float fogStart = u[4].w;
    float farPlane = u[4].z;
    return smoothstep(3.0, 8.0, 1.0 / max(t * ferroPixelAngle(), 1e-5)) * (1.0 - smoothstep(fogStart, lerp(fogStart, farPlane, 0.7), t));
}

float ferroProfile(float v, out float rate)
{
    float uRound = u[6].y;
    float uSpan = u[6].z;
    float root = sqrt(max(1.0 - v, 0.0) + uRound * uRound);
    rate = 0.5 / (uSpan * root);
    return saturate(1.0 - (root - uRound) / uSpan);
}

float ferroSpikes(float2 p, float a, float rise, out float clearance)
{
    clearance = 10.0;
    if (a < 0.002) return 0.0;
    float2 q = ferroLattice(p);
    float v = (cos(FERRO_G * dot(FERRO_E1, q)) + cos(FERRO_G * dot(FERRO_E2, q)) + cos(FERRO_G * dot(FERRO_E3, q)) + 1.5) / 4.5;
    float uRound = u[6].y;
    float uSpan = u[6].z;
    float uExponent = u[6].w;
    if (a > 0.05)
    {
        float root = uRound + (1.0 - pow(saturate(rise / a), 1.0 / uExponent)) * uSpan;
        clearance = sqrt(max(1.0 - v, 0.0) / 8.77) - sqrt(max(root * root - uRound * uRound, 0.0) / 8.77);
    }
    float rate;
    return a * pow(ferroProfile(v, rate), uExponent);
}

float2 ferroSpikesSlope(float2 p, float a, float2 aSlope)
{
    if (a < 0.002) return float2(0.0, 0.0);
    float2 q = ferroLattice(p);
    float c1 = FERRO_G * dot(FERRO_E1, q);
    float c2 = FERRO_G * dot(FERRO_E2, q);
    float c3 = FERRO_G * dot(FERRO_E3, q);
    float v = (cos(c1) + cos(c2) + cos(c3) + 1.5) / 4.5;
    float2 du = -(FERRO_G / 4.5) * ferroTurnRow(sin(c1) * FERRO_E1 + sin(c2) * FERRO_E2 + sin(c3) * FERRO_E3);
    float rate;
    float s = max(ferroProfile(v, rate), 1e-4);
    float uExponent = u[6].w;
    float shape = pow(s, uExponent);
    return a * uExponent * shape / s * rate * du + aSlope * shape;
}

float2 ferroGridSpan()
{
    uint width;
    uint height;
    t0.GetDimensions(width, height);
    return float2(width, height) * FERRO_CELL;
}

float ferroSurface(float2 p, float2 origin, float z, float t, out float clearance)
{
    float4 f = t0.SampleLevel(s0, flipUv((p - origin) / ferroGridSpan()), 0);
    // f.z is the cursor's mound: 0 without a pointer.
    return f.z + ferroSpikes(p, f.x * ferroDetail(t), z - f.z, clearance);
}

// React Bits samples the bound nearest and clamped; a texel fetch is the
// same and needs no sampler state.
float2 ferroBound(float2 p, float2 origin)
{
    uint width;
    uint height;
    t1.GetDimensions(width, height);
    int2 last = int2(width, height) - 1;
    int2 texel = clamp(int2(floor((p - origin) / FERRO_BOUND_CELL)), int2(0, 0), last);
    return t1.Load(int3(texel.x, last.y - texel.y, 0)).rg;
}

float ferroPanel(float3 r, float3 dir, float3 up, float2 extent, float soft)
{
    float3 side = normalize(cross(dir, up));
    float3 top = cross(side, dir);
    float facing = dot(r, dir);
    if (facing <= 0.0) return 0.0;
    float2 q = float2(dot(r, side), dot(r, top)) / facing;
    float2 e = hermite2(extent + soft, extent - soft, abs(q));
    return e.x * e.y;
}

float3 ferroStudio(float3 r, float3 rd, float soft)
{
    float3 z = float3(0.0, 0.0, 1.0);
    float3 col = u[8].rgb * 4.2 * ferroPanel(r, normalize(float3(-0.3, -0.5, 0.81)), z, float2(0.36, 0.22), 0.08 + soft);
    col += u[9].rgb * 1.5 * ferroPanel(r, normalize(float3(-0.9, -0.2, 0.38)), z, float2(0.12, 0.7), 0.07 + soft);
    col += u[9].rgb * 1.5 * ferroPanel(r, normalize(float3(0.9, -0.1, 0.42)), z, float2(0.12, 0.7), 0.07 + soft);
    float lift = asin(clamp(r.z, -1.0, 1.0)) - asin(clamp(-rd.z, -1.0, 1.0));
    col += u[10].rgb * 0.45 * smoothstep(0.08 - soft, 0.7 + soft, lift) * hermite(1.6, 1.0, lift);
    return col;
}

// React Bits' finish() in dark, transparent mode: the glow premultiplied by
// the fog, drawn here over the base colour.
float4 ferroFinish(float3 light, float alpha)
{
    float3 glow = light * alpha;
    float cover = max(glow.r, max(glow.g, glow.b));
    return float4((glow + u[11].rgb * (1.0 - cover)) * (1.0 - u[1].z), 1.0);
}

float4 FerrofluidRenderPs(LiveVsOutput input) : SV_Target
{
    float2 res = u[0].xy;
    float2 ndc = (gl(input.position) - 0.5 * res) / (0.5 * res.y);
    float3 camera = float3(0.0, u[4].x, u[4].y);
    float3 forward = float3(0.0, u[5].x, u[5].y);
    float3 upward = float3(0.0, u[5].z, u[5].w);
    float farPlane = u[4].z;
    float fogStart = u[4].w;
    float3 side = normalize(cross(forward, upward));
    float3 rd = normalize(forward + (ndc.x * side + ndc.y * upward) * FERRO_TAN_HALF);
    float tTop = max((u[6].x - camera.z) / rd.z, 0.0);
    float tEnd = min((-0.05 - camera.z) / rd.z, farPlane);
    // The GLSL returns early for the sky and for a ray that ends above the
    // ceiling; here the march just doesn't run for them (ta starts at or past
    // tEnd), so the derivative below stays in uniform flow, and the sky is
    // selected at the end.
    bool sky = rd.z > -0.004 || tTop >= tEnd;
    float2 origin = ferroGridOrigin();
    float sink = max(-rd.z, 0.2);
    float glide = max(length(rd.xy), 0.05);
    float chunk = 0.9 / glide;
    float t = tEnd;
    float tPrev = tEnd;
    bool found = false;
    bool smoothHit = false;
    float ta = tTop;
    float2 b0 = ferroBound(camera.xy + rd.xy * ta, origin);
    [loop]
    for (int c = 0; c < 64; c++)
    {
        if (ta >= tEnd) break;
        float tb = min(ta + chunk, tEnd);
        float2 b1 = ferroBound(camera.xy + rd.xy * tb, origin);
        float b = max(b0.x, b1.x) + 0.03;
        float z1 = camera.z + rd.z * tb;
        if (z1 > b)
        {
            ta = tb;
            b0 = b1;
            continue;
        }
        float tt = max(ta, (b - camera.z) / rd.z);
        if (max(b0.y, b1.y) < 0.002)
        {
            // Flat fluid: settle on the ground (the cursor's mound is 0).
            [unroll]
            for (int k = 0; k < 3; k++)
            {
                float3 probe = camera + rd * tt;
                tt += probe.z / sink * 0.95;
            }
            if (tt <= tb + 0.02 || tb >= tEnd)
            {
                t = tt;
                smoothHit = true;
                break;
            }
            ta = tb;
            b0 = b1;
            continue;
        }
        float tp = tt;
        [loop]
        for (int m = 0; m < 48; m++)
        {
            float3 marchPos = camera + rd * tt;
            float clearance;
            float gap = marchPos.z - ferroSurface(marchPos.xy, origin, marchPos.z, tt, clearance);
            if (gap < 0.0)
            {
                found = true;
                break;
            }
            tp = tt;
            float pixel = tt * ferroPixelAngle();
            float limit = marchPos.z > ferroBound(marchPos.xy, origin).x + 0.02 ? 0.6 / glide : max(clearance * 0.9, pixel) / glide;
            tt += max(min(gap * 0.75 / sink, limit), pixel);
            if (tt > tb) break;
        }
        if (found)
        {
            t = tt;
            tPrev = tp;
            break;
        }
        ta = tb;
        b0 = b1;
    }

    float3 pos;
    float2 slope;
    if (smoothHit || !found)
    {
        pos = camera + rd * t;
        slope = float2(0.0, 0.0);
    }
    else
    {
        float lo = tPrev;
        float hi = t;
        [unroll]
        for (int k = 0; k < 4; k++)
        {
            float mid = 0.5 * (lo + hi);
            float3 probe = camera + rd * mid;
            float clearance;
            if (probe.z - ferroSurface(probe.xy, origin, probe.z, mid, clearance) < 0.0) hi = mid;
            else lo = mid;
        }
        t = hi;
        pos = camera + rd * t;
        float2 span = ferroGridSpan();
        float2 uv = (pos.xy - origin) / span;
        float2 stepUv = FERRO_CELL / span;
        float fade = ferroDetail(t);
        float a = t0.SampleLevel(s0, flipUv(uv), 0).x * fade;
        float2 aSlope = float2(
            t0.SampleLevel(s0, flipUv(uv + float2(stepUv.x, 0.0)), 0).x - t0.SampleLevel(s0, flipUv(uv - float2(stepUv.x, 0.0)), 0).x,
            t0.SampleLevel(s0, flipUv(uv + float2(0.0, stepUv.y)), 0).x - t0.SampleLevel(s0, flipUv(uv - float2(0.0, stepUv.y)), 0).x
        ) * fade / (2.0 * FERRO_CELL);
        slope = ferroSpikesSlope(pos.xy, a, aSlope);
    }

    float3 n = normalize(float3(-slope, 1.0));
    float3 r = reflect(rd, n);
    float soft = length(fwidth(r)) * 0.6;
    float facing = max(dot(n, -rd), 0.0);
    float fresnel = FERRO_F0 + (1.0 - FERRO_F0) * pow(1.0 - facing, 5.0);
    float rim = pow(1.0 - saturate(abs(dot(rd, n))), 3.0) * hermite(0.85, 0.4, n.z);
    float fogFade = 1.0 - smoothstep(fogStart, farPlane, t);

    float3 shine = 1.0 - exp(-(ferroStudio(r, rd, soft) * fresnel + u[10].rgb * rim * 0.35) * u[7].y);
    return sky ? ferroFinish(float3(0.0, 0.0, 0.0), 0.0) : ferroFinish(shine, fogFade);
}

// ---------------------------------------------------------------- Ghost Fibers (plan 194)

struct GhostVsOutput
{
    float4 position : SV_Position;
    float2 local : TEXCOORD0;
    float radius : TEXCOORD1;
    float segment : TEXCOORD2;
    float3 light : TEXCOORD3;
    float tint : TEXCOORD4;
};

// React Bits' camera: the eye at z = 7.5 looking down −z through a 0.56 rad
// frustum (near 0.1, far 60), whose x, y and w are all a point needs here.
static const float GHOST_CAMERA = 7.5;
static const float GHOST_FRUSTUM = 3.4776037;
static const float GHOST_FOCAL = 1.73880;
static const float GHOST_RIBBON_LENGTH = 24.0;
static const float GHOST_DEPTH_SPREAD = 0.12;
static const float4 GHOST_PLACEMENTS[3] = { float4(0.0, 0.0, 0.0, 0.0), float4(1.9, -4.6, -0.08, 2.4), float4(-1.05, 2.0, 0.12, 4.1) };
static const float GHOST_RIBBON_GAIN[3] = { 1.0, 0.5, 0.55 };
static const float GHOST_RIBBON_TINT[3] = { 0.0, 0.75, 0.35 };

float ghostHash11(float n)
{
    return frac(sin(n * 91.3458) * 47453.5453);
}

// React Bits' `fit`: the canvas aspect over 1.5, clamped to 0.6–1.
float ghostFit()
{
    return clamp(u[1].x / u[1].y / 1.5, 0.6, 1.0);
}

float3 ghostProject(float3 world, float2 viewport, out float depth)
{
    depth = GHOST_CAMERA - world.z;
    float aspect = viewport.x / viewport.y;
    float2 ndc = float2(GHOST_FRUSTUM * world.x / aspect, GHOST_FRUSTUM * world.y) / depth;
    return float3((ndc * 0.5 + 0.5) * viewport, depth);
}

float2 ghostQuadCorner(uint vertexId)
{
    return float2(vertexId == 1 || vertexId == 3 ? 1.0 : 0.0, vertexId >= 2 ? 1.0 : 0.0);
}

// GLSL's mat3(u[9].xyz, u[10].xyz, u[11].xyz) * v: the columns are u[9..12).
float3 ghostOrient(float3 v)
{
    return u[9].xyz * v.x + u[10].xyz * v.y + u[11].xyz * v.z;
}

GhostVsOutput GhostFibersDustVs(uint vertexId : SV_VertexID, uint instanceId : SV_InstanceID)
{
    float2 viewport = u[0].xy;
    float dpr = u[0].w;
    float uTime = u[0].z;
    float id = float(instanceId);
    float3 seed = float3(ghostHash11(id * 1.37 + 0.3), ghostHash11(id * 2.91 + 1.7), ghostHash11(id * 4.17 + 2.9));
    float3 box = float3(9.0, 5.4, 6.0);
    float3 p = (seed - 0.5) * box;
    p.z -= 0.6;
    p += 0.18 * float3(sin(uTime * 0.21 + seed.x * 40.0), sin(uTime * 0.17 + seed.y * 40.0), sin(uTime * 0.13 + seed.z * 40.0));
    p *= lerp(1.0, u[3].x * ghostFit(), 0.5);
    float depth;
    float3 projected = ghostProject(p, viewport, depth);
    float2 px = projected.xy;
    float size = u[8].x * lerp(0.5, 1.4, ghostHash11(id * 7.7));
    float baseRadius = max(0.5 * size * dpr * GHOST_CAMERA / max(depth, 0.1), 0.45);
    float coc = min(u[4].w * abs(1.0 - u[4].z / max(depth, 0.1)) * viewport.y * 0.035, 22.0 * dpr * 1.6);
    float radius = baseRadius + coc;
    float spill = max(10.0 * dpr, baseRadius);
    float energy = pow(baseRadius / min(radius, spill), 0.9) * sq(min(1.0, spill / radius));
    float twinkle = pow(max(sin(uTime * (0.8 + 1.6 * seed.y) * 2.0 + seed.z * 50.0), 0.0), 8.0);
    // The intro is finished (React Bits' uIntro = 1).
    float intensity = energy * (0.35 + 0.65 * twinkle) * lerp(0.4, 1.0, seed.x) * (depth > 0.2 ? 1.0 : 0.0);
    float2 corner = ghostQuadCorner(vertexId) * 2.0 - 1.0;
    float2 position = px + corner * radius;
    GhostVsOutput output;
    output.local = corner * radius;
    output.radius = radius;
    output.segment = 0.0;
    output.light = float3(intensity * 0.8 * u[8].y, 0.3 + 0.6 * twinkle * u[5].z, coc / max(radius, 1e-3));
    output.tint = u[6].y < 0.5 ? 0.45 + 0.55 * seed.y : seed.y;
    output.position = float4(position / viewport * 2.0 - 1.0, 0.0, 1.0);
    return output;
}

float3 ghostCenterLocal(float s, float4 place)
{
    float t = u[0].z;
    float ph = place.w;
    float x = s * GHOST_RIBBON_LENGTH;
    float y = u[2].z * (0.52 * sin(x * 0.43 + t * 0.31 + ph) + 0.26 * sin(x * 0.79 - t * 0.23 + 1.3 + ph * 0.7)) + place.x + x * place.z;
    float z = u[2].z * 0.65 * sin(x * 0.33 + t * 0.19 + 0.7 + ph * 1.3) + place.y;
    return float3(x, y, z);
}

float ghostTwistAt(float s, float layer, float4 place)
{
    float x = s * GHOST_RIBBON_LENGTH;
    // The roll advances with the phase at the look's roll speed.
    float roll = u[0].z * u[2].y;
    return u[2].x * 0.483 * x + roll + place.w * 0.6 + layer * u[3].y * 0.42 + 0.5 * sin(x * 0.26 + u[0].z * 0.27 + place.w);
}

float3 ghostRibbonPoint(float s, float v, float n, float layer, float4 place, float scale, out float3 normal)
{
    float3 c0 = ghostCenterLocal(s, place);
    float3 c1 = ghostCenterLocal(s + 0.004, place);
    float3 tangent = normalize(c1 - c0);
    float3 up = float3(0.0, 1.0, 0.0);
    float3 n0 = normalize(up - tangent * dot(up, tangent));
    float3 b0 = cross(tangent, n0);
    float th = ghostTwistAt(s, layer, place);
    float3 across = cos(th) * n0 + sin(th) * b0;
    float3 sheet = -sin(th) * n0 + cos(th) * b0;
    float halfWidth = u[2].w * (0.78 + 0.22 * cos(s * 3.14159));
    float3 local = c0 + across * v * halfWidth + sheet * (n + layer * u[3].y * 0.16) * halfWidth;
    normal = ghostOrient(sheet);
    return ghostOrient(local * scale);
}

GhostVsOutput GhostFibersDotsVs(uint vertexId : SV_VertexID, uint instanceId : SV_InstanceID)
{
    float2 viewport = u[0].xy;
    float dpr = u[0].w;
    float uTime = u[0].z;
    float scale = u[3].x * ghostFit();
    float uFibers = u[3].z;
    float uDots = u[3].w;
    float uFlow = u[0].z * u[4].x;

    // One draw for every ribbon: the instance id names the ribbon, then the
    // fiber, then the bead (React Bits draws each ribbon with its own
    // uRibbon, uPlace, uGain and uTint).
    int perFiber = int(uDots);
    int perRibbon = int(uFibers) * perFiber;
    int ribbon = int(instanceId) / perRibbon;
    int withinRibbon = int(instanceId) - ribbon * perRibbon;
    int fiber = withinRibbon / perFiber;
    int bead = withinRibbon - fiber * perFiber;
    float uRibbon = float(ribbon);
    float4 place = GHOST_PLACEMENTS[ribbon];
    float uGain = GHOST_RIBBON_GAIN[ribbon] * u[5].w;
    float uTint = GHOST_RIBBON_TINT[ribbon];
    float fi = float(fiber);
    float fk = float(bead);

    float seed = ghostHash11(fi * 1.731 + uRibbon * 17.0);
    float s = frac((fk + uFlow + seed * uDots) / uDots) - 0.5;
    float sNext = s + 1.0 / uDots;
    float layer = gmod(fi, 3.0) - 1.0;
    float slot = floor(fi / 3.0);
    float perLayer = max(floor(uFibers / 3.0), 1.0);
    float v = ((slot + 0.5) / perLayer) * 2.0 - 1.0 + (ghostHash11(fi * 3.113 + 4.0) - 0.5) * (1.6 / perLayer) + layer * 0.12 / perLayer;
    float depthOffset = (ghostHash11(fi * 7.919 + 2.0) - 0.5) * GHOST_DEPTH_SPREAD * (0.35 + 6.0 * s * s);

    float3 normal;
    float3 world = ghostRibbonPoint(s, v, depthOffset, layer, place, scale, normal);
    float3 nextNormal;
    float3 nextWorld = ghostRibbonPoint(sNext, v, depthOffset, layer, place, scale, nextNormal);

    float depth;
    float3 p0 = ghostProject(world, viewport, depth);
    float nextDepth;
    float3 p1 = ghostProject(nextWorld, viewport, nextDepth);
    // No hover parts the fibers (React Bits' uHover.w = 0).
    float2 px = p0.xy;
    float2 pxNext = p1.xy;

    float uSize = u[4].y;
    float uFocus = u[4].z;
    float uDof = u[4].w;
    float baseRadius = max(0.5 * uSize * dpr * GHOST_CAMERA / max(depth, 0.1), 0.45);
    float coc = min(uDof * abs(1.0 - uFocus / max(depth, 0.1)) * viewport.y * 0.035, u[5].x * dpr);
    float radius = baseRadius + coc;
    float spill = max(10.0 * dpr, baseRadius);
    float energy = pow(baseRadius / min(radius, spill), 1.25) * sq(min(1.0, spill / radius));

    float3 toEye = normalize(float3(0.0, 0.0, GHOST_CAMERA) - world);
    float facing = abs(dot(normalize(normal), toEye));
    float focalPx = viewport.y * GHOST_FOCAL / max(depth, 0.1);
    float widthPx = 2.0 * u[2].w * scale * focalPx;
    float stack = (widthPx * facing + 2.0 * baseRadius) / (widthPx + 2.0 * baseRadius);
    float spacingFace = length(nextWorld - world) * focalPx;
    float trail = (length(p1.xy - p0.xy) + 2.0 * baseRadius) / (spacingFace + 2.0 * baseRadius);
    float crowd = sqrt(clamp(stack * trail, 0.002, 1.0));
    float fold = pow(1.0 - facing, 6.0) * u[6].z;
    float endFade = hermite(0.5, 0.4, abs(s)) * smoothstep(1.6, 4.2, depth);
    float uTips = u[6].x;
    float tipEnd = lerp(0.6, 0.06 + 0.26 * ghostHash11(fi * 9.137 + place.w * 3.0), uTips);
    float tip = exp(-sq((s - tipEnd) / 0.0065)) * uTips;
    endFade *= hermite(tipEnd + 0.003, tipEnd - 0.001, s);
    // The intro is finished (React Bits' appear = 1) and no click pulses.
    float uDotLength = u[5].y;
    float twinklePhase = ghostHash11(fi * 13.7 + fk * 0.917 + uRibbon * 3.0);
    float twinkle = pow(max(sin(uTime * (1.2 + 2.6 * twinklePhase) * 3.0 + twinklePhase * 61.0), 0.0), 36.0) * u[5].z * (1.0 - 0.85 * uDotLength);
    float strength = lerp(0.45, 1.0, ghostHash11(fi * 5.37 + 1.0)) * lerp(1.0, 0.72, abs(layer) * u[3].y);
    float intensity = energy * crowd * strength * endFade * 0.8 * uGain * (1.0 + fold * 7.0 + twinkle * 5.0 + tip * 7.0);
    float highlight = saturate(fold * 0.55 + twinkle + tip);

    float2 segment = (pxNext - px) * uDotLength;
    float segmentLength = length(segment);
    intensity *= lerp(1.0, (2.0 * radius) / (segmentLength + 2.0 * radius) * 1.6, uDotLength);
    float2 axis = segmentLength > 1e-3 ? segment / segmentLength : float2(1.0, 0.0);
    float2 perp = float2(-axis.y, axis.x);
    float2 corner = ghostQuadCorner(vertexId);
    float along = lerp(-radius, segmentLength + radius, corner.x);
    float across = lerp(-radius, radius, corner.y);
    float2 position = px + axis * along + perp * across;

    GhostVsOutput output;
    output.local = float2(along, across);
    output.radius = radius;
    output.segment = segmentLength;
    output.light = float3(intensity, highlight, coc / max(radius, 1e-3));
    float depthTint = saturate(uTint + smoothstep(uFocus, uFocus + 5.0, depth) * 0.5);
    float uGradient = u[6].y;
    output.tint = uGradient < 0.5 ? depthTint : uGradient < 1.5 ? smoothstep(-0.42, 0.42, s) : saturate(v * 0.5 + 0.5);
    if (intensity < 0.0005) position = float2(-1e4, -1e4);
    output.position = float4(position / viewport * 2.0 - 1.0, 0.0, 1.0);
    return output;
}

// The dots and the dust shade the same way (ghost_fibers.frag's DOTS/DUST
// pass), blended additively into the cleared scene.
float4 ghostDot(GhostVsOutput input)
{
    float along = clamp(input.local.x, 0.0, input.segment);
    float d = length(float2(input.local.x - along, input.local.y));
    float rho = d / max(input.radius, 1e-3);
    if (rho > 1.0) discard;
    float soft = clamp(2.6 / max(input.radius, 1e-3), 0.14, 1.0);
    float disk = 1.0 - smoothstep(1.0 - soft, 1.0, rho);
    float bokeh = disk * (0.94 + 0.08 * smoothstep(0.55, 0.95, rho));
    float core = exp(-rho * rho * 3.2);
    float shape = lerp(core, bokeh, smoothstep(0.25, 0.7, input.light.z));
    float3 color = lerp(lerp(u[12].rgb, u[14].rgb, input.tint), u[13].rgb, input.light.y);
    return float4(color * shape * input.light.x, shape * input.light.x);
}

float4 GhostFibersDotsPs(GhostVsOutput input) : SV_Target { return ghostDot(input); }
float4 GhostFibersDustPs(GhostVsOutput input) : SV_Target { return ghostDot(input); }

float3 ghostPick(float2 uv)
{
    float3 c = t0.SampleLevel(s0, uv, 0).rgb;
    float peak = max(max(c.r, c.g), c.b);
    return c * smoothstep(0.35, 1.2, peak);
}

// The scene and the bloom chain stay in this file's own top-down space: their
// taps are symmetric, and the composite reads them the same way.
float4 GhostFibersBrightPs(LiveVsOutput input) : SV_Target
{
    float2 uv = input.position.xy / u[0].xy;
    uint width;
    uint height;
    t0.GetDimensions(width, height);
    float2 o = 0.5 / float2(width, height);
    float3 c = ghostPick(uv + float2(-o.x, -o.y)) + ghostPick(uv + float2(o.x, -o.y)) + ghostPick(uv + float2(-o.x, o.y)) + ghostPick(uv + float2(o.x, o.y));
    return float4(c * 0.25, 1.0);
}

float4 GhostFibersDownPs(LiveVsOutput input) : SV_Target
{
    float2 uv = input.position.xy / u[0].xy;
    uint width;
    uint height;
    t0.GetDimensions(width, height);
    float2 o = 1.0 / float2(width, height);
    float3 c = t0.SampleLevel(s0, uv, 0).rgb * 4.0;
    c += t0.SampleLevel(s0, uv + float2(-o.x, -o.y), 0).rgb;
    c += t0.SampleLevel(s0, uv + float2(o.x, -o.y), 0).rgb;
    c += t0.SampleLevel(s0, uv + float2(-o.x, o.y), 0).rgb;
    c += t0.SampleLevel(s0, uv + float2(o.x, o.y), 0).rgb;
    return float4(c / 8.0, 1.0);
}

float4 GhostFibersUpPs(LiveVsOutput input) : SV_Target
{
    float2 uv = input.position.xy / u[0].xy;
    uint width;
    uint height;
    t0.GetDimensions(width, height);
    float2 o = 0.5 / float2(width, height);
    float3 c = t0.SampleLevel(s0, uv + float2(-o.x * 2.0, 0.0), 0).rgb;
    c += t0.SampleLevel(s0, uv + float2(-o.x, o.y), 0).rgb * 2.0;
    c += t0.SampleLevel(s0, uv + float2(0.0, o.y * 2.0), 0).rgb;
    c += t0.SampleLevel(s0, uv + float2(o.x, o.y), 0).rgb * 2.0;
    c += t0.SampleLevel(s0, uv + float2(o.x * 2.0, 0.0), 0).rgb;
    c += t0.SampleLevel(s0, uv + float2(o.x, -o.y), 0).rgb * 2.0;
    c += t0.SampleLevel(s0, uv + float2(0.0, -o.y * 2.0), 0).rgb;
    c += t0.SampleLevel(s0, uv + float2(-o.x, -o.y), 0).rgb * 2.0;
    return float4(c / 12.0 + t1.SampleLevel(s0, uv, 0).rgb, 1.0);
}

float ghostHash(float2 p)
{
    float3 q = frac(float3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return frac((q.x + q.y) * q.z);
}

float ghostSmoother(float x)
{
    x = saturate(x);
    return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

float4 GhostFibersCompositePs(LiveVsOutput input) : SV_Target
{
    float2 uv = input.position.xy / u[0].xy;
    float2 fragCoord = gl(input.position);
    float2 vUv = fragCoord / u[0].xy;
    float4 scene = t0.SampleLevel(s0, uv, 0);
    float3 bloom = t1.SampleLevel(s0, uv, 0).rgb;
    float3 light = (scene.rgb + bloom * u[7].x) * u[7].y;
    float uVignette = u[7].w;
    float reach = max(uVignette * 0.3, 1e-4);
    float mask = uVignette > 0.0 ? ghostSmoother(vUv.x / reach) * ghostSmoother((1.0 - vUv.x) / reach) * ghostSmoother(vUv.y / reach) * ghostSmoother((1.0 - vUv.y) / reach) : 1.0;
    // The grain is fixed in place (React Bits moves it every frame).
    float2 cell = floor(fragCoord / max(u[0].w, 1.0));
    float grain = ghostHash(cell) + ghostHash(cell * 1.31 + 9.1) - 1.0;
    float3 color = (1.0 - exp(-light * 1.25)) * mask;
    float peak = max(color.r, max(color.g, color.b));
    color = max(color + grain * u[7].z * (0.25 + 0.75 * sqrt(peak)), 0.0);
    float alpha = max(color.r, max(color.g, color.b));
    return float4((color + u[15].rgb * (1.0 - alpha)) * (1.0 - u[1].z), 1.0);
}
