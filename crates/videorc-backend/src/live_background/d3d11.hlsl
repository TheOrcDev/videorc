// Live backgrounds (plan 190 S4): the five React Bits backgrounds by David Haz
// (https://reactbits.dev, MIT + Commons Clause), used in Videorc with the
// author's permission, ported to HLSL (Shader Model 5) from the GLSL source of
// truth in `glsl/*.frag`. They are checked against the same golden grids.
//
// Porting rules (docs/live-backgrounds.md): SV_Position is top-left, so
// `gl(pos)` flips it to GLSL's bottom-left gl_FragCoord; GLSL `mod` is
// `gmod`; `pow(negative, 2)` is `sq`; textures this file renders sample at
// `(uv.x, 1 - uv.y)` for a GLSL uv; samples in divergent flow use
// `SampleLevel`.

cbuffer LiveConstants : register(b0)
{
    float4 u[9];
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
float sq(float x) { return x * x; }
float2 flipUv(float2 uv) { return float2(uv.x, 1.0 - uv.y); }

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
