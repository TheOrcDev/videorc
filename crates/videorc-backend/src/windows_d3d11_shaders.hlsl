// Videorc-owned D3D11 scene and color-conversion shaders.
//
// The Rust compositor compiles this source once on the generation-owned media
// thread. Keep every entry point in this one file so shader compilation is an
// all-or-nothing capability decision: a session must never render a partially
// supported scene while retaining a d3d11 identity.

cbuffer DrawConstants : register(b0)
{
    // Normalized output destination: left, top, width, height.
    float4 destination;
    // Normalized source sampling rectangle: left, top, width, height.
    float4 sourceCrop;
    // opacity, saturation, dim, vignette
    float4 effects;
    // mirrorX, maskKind (0 none, 1 circle, 2 rounded), radius, destinationAspect
    float4 mask;
    // key R, G, B, enabled
    float4 chromaKeyColor;
    // angle threshold, softness, spill, saturation floor (all normalized)
    float4 chromaKeyControls;
    // source texel X/Y, blur radius in source pixels, source kind
    // source kind: 0 sampled, 1 solid, 2 test pattern
    float4 sourceInfo;
    // solid R, G, B, A
    float4 solidColor;
    // output texel X/Y, deterministic sequence low bits, reserved
    float4 frameInfo;
};

Texture2D<float4> sourceTexture : register(t0);
Texture2D<float4> pointerTexture : register(t1);
SamplerState linearClampSampler : register(s0);

struct VertexOutput
{
    float4 position : SV_POSITION;
    float2 uv : TEXCOORD0;
};

static const float2 QUAD[6] = {
    float2(0.0, 0.0),
    float2(1.0, 0.0),
    float2(0.0, 1.0),
    float2(0.0, 1.0),
    float2(1.0, 0.0),
    float2(1.0, 1.0)
};

VertexOutput SceneVs(uint vertexId : SV_VertexID)
{
    VertexOutput output;
    float2 unit = QUAD[vertexId];
    float2 outputPosition = destination.xy + unit * destination.zw;
    output.position = float4(
        outputPosition.x * 2.0 - 1.0,
        1.0 - outputPosition.y * 2.0,
        0.0,
        1.0
    );
    output.uv = unit;
    return output;
}

VertexOutput FullScreenVs(uint vertexId : SV_VertexID)
{
    VertexOutput output;
    float2 unit = QUAD[vertexId];
    output.position = float4(
        unit.x * 2.0 - 1.0,
        1.0 - unit.y * 2.0,
        0.0,
        1.0
    );
    output.uv = unit;
    return output;
}

float4 sampleSource(float2 uv)
{
    float2 mirrored = float2(mask.x > 0.5 ? 1.0 - uv.x : uv.x, uv.y);
    float2 sourceUv = sourceCrop.xy + mirrored * sourceCrop.zw;
    float blurRadius = sourceInfo.z;
    if (blurRadius <= 0.01)
    {
        return sourceTexture.Sample(linearClampSampler, sourceUv);
    }

    // A fixed nine-tap kernel is intentionally bounded. It gives the existing
    // background blur control a GPU implementation without creating
    // frame-dependent work or a hidden CPU fallback.
    float2 stepSize = sourceInfo.xy * min(blurRadius, 32.0);
    float4 color = sourceTexture.Sample(linearClampSampler, sourceUv) * 0.20;
    color += sourceTexture.Sample(linearClampSampler, sourceUv + float2(stepSize.x, 0.0)) * 0.12;
    color += sourceTexture.Sample(linearClampSampler, sourceUv - float2(stepSize.x, 0.0)) * 0.12;
    color += sourceTexture.Sample(linearClampSampler, sourceUv + float2(0.0, stepSize.y)) * 0.12;
    color += sourceTexture.Sample(linearClampSampler, sourceUv - float2(0.0, stepSize.y)) * 0.12;
    color += sourceTexture.Sample(linearClampSampler, sourceUv + stepSize) * 0.08;
    color += sourceTexture.Sample(linearClampSampler, sourceUv - stepSize) * 0.08;
    color += sourceTexture.Sample(linearClampSampler, sourceUv + float2(stepSize.x, -stepSize.y)) * 0.08;
    color += sourceTexture.Sample(linearClampSampler, sourceUv + float2(-stepSize.x, stepSize.y)) * 0.08;
    return color;
}

float4 testPattern(float2 uv)
{
    static const float3 bars[8] = {
        float3(0.75, 0.75, 0.75),
        float3(0.75, 0.75, 0.00),
        float3(0.00, 0.75, 0.75),
        float3(0.00, 0.75, 0.00),
        float3(0.75, 0.00, 0.75),
        float3(0.75, 0.00, 0.00),
        float3(0.00, 0.00, 0.75),
        float3(0.02, 0.02, 0.02)
    };
    uint bar = min((uint)floor(saturate(uv.x) * 8.0), 7u);
    float pulse = 0.92 + 0.08 * frac(frameInfo.z / 60.0);
    float grid = (frac(uv.x * 16.0) < 0.02 || frac(uv.y * 9.0) < 0.02) ? 0.72 : 1.0;
    return float4(bars[bar] * pulse * grid, 1.0);
}

float maskAlpha(float2 uv)
{
    if (mask.y < 0.5)
    {
        return 1.0;
    }

    float2 centered = uv - float2(0.5, 0.5);
    if (mask.y < 1.5)
    {
        centered.x *= max(mask.w, 0.0001);
        return 1.0 - smoothstep(0.495, 0.505, length(centered));
    }

    float2 halfSize = float2(0.5, 0.5);
    float radius = min(saturate(mask.z), 0.5);
    float2 distanceToEdge = abs(centered) - (halfSize - radius);
    float signedDistance =
        length(max(distanceToEdge, 0.0)) +
        min(max(distanceToEdge.x, distanceToEdge.y), 0.0) -
        radius;
    float feather = max(frameInfo.x, frameInfo.y) * 1.5;
    return 1.0 - smoothstep(-feather, feather, signedDistance);
}

float chromaKeyAlpha(float3 rgb)
{
    if (chromaKeyColor.w < 0.5)
    {
        return 1.0;
    }

    // Full-range BT.601 is the repository's shared chroma-key feature space.
    float2 chroma = float2(
        dot(rgb, float3(-43.0, -85.0, 128.0)) / 255.0,
        dot(rgb, float3(128.0, -107.0, -21.0)) / 255.0
    );
    float2 keyChroma = float2(
        dot(chromaKeyColor.rgb, float3(-43.0, -85.0, 128.0)) / 255.0,
        dot(chromaKeyColor.rgb, float3(128.0, -107.0, -21.0)) / 255.0
    );
    float saturation = length(chroma);
    float keySaturation = max(length(keyChroma), 0.0001);
    if (saturation < chromaKeyControls.w)
    {
        return 1.0;
    }

    float cosine = clamp(dot(chroma, keyChroma) / (saturation * keySaturation), -1.0, 1.0);
    float angle = acos(cosine) / 3.14159265;
    float threshold = chromaKeyControls.x;
    float softness = max(chromaKeyControls.y, 0.0001);
    return smoothstep(threshold, threshold + softness, angle);
}

float4 ScenePs(VertexOutput input) : SV_TARGET
{
    float4 color;
    if (sourceInfo.w > 1.5)
    {
        color = testPattern(input.uv);
    }
    else if (sourceInfo.w > 0.5)
    {
        color = solidColor;
    }
    else
    {
        color = sampleSource(input.uv);
    }

    float luma = dot(color.rgb, float3(0.2126, 0.7152, 0.0722));
    color.rgb = lerp(float3(luma, luma, luma), color.rgb, max(effects.y, 0.0));
    color.rgb *= saturate(1.0 - effects.z);
    float2 vignetteVector = input.uv - float2(0.5, 0.5);
    float vignette = saturate(1.0 - dot(vignetteVector, vignetteVector) * effects.w * 2.8);
    color.rgb *= vignette;

    float keyAlpha = chromaKeyAlpha(color.rgb);
    if (chromaKeyColor.w > 0.5 && keyAlpha < 1.0)
    {
        float spill = (1.0 - keyAlpha) * saturate(chromaKeyControls.z);
        color.g = lerp(color.g, max(color.r, color.b), spill);
    }
    color.a *= saturate(effects.x) * maskAlpha(input.uv) * keyAlpha;
    return color;
}

// Desktop Duplication's separate pointer path. The clean desktop is always
// sampled from t0; t1 contains either BGRA pointer pixels or an expanded
// monochrome AND/XOR mask. `destination` is an integer-pixel cursor rectangle,
// `sourceInfo.xy` is the unrotated pointer size, `.z` is quarter-turn rotation,
// and `.w` selects color-alpha (1), monochrome (2), or masked-color XOR (3).
float4 PointerPs(VertexOutput input) : SV_TARGET
{
    int2 desktopSize = max(int2(frameInfo.xy), int2(1, 1));
    int2 desktopPixel = clamp(int2(input.position.xy), int2(0, 0), desktopSize - 1);
    float4 desktop = sourceTexture.Load(int3(desktopPixel, 0));

    int2 cursorOrigin = int2(destination.xy);
    int2 cursorSize = int2(destination.zw);
    int2 local = desktopPixel - cursorOrigin;
    if (any(local < 0) || any(local >= cursorSize))
    {
        return desktop;
    }

    int2 pointerSize = max(int2(sourceInfo.xy), int2(1, 1));
    int rotation = (int)round(sourceInfo.z);
    int2 sourcePixel = local;
    if (rotation == 1)
    {
        sourcePixel = int2(local.y, pointerSize.y - 1 - local.x);
    }
    else if (rotation == 2)
    {
        sourcePixel = pointerSize - 1 - local;
    }
    else if (rotation == 3)
    {
        sourcePixel = int2(pointerSize.x - 1 - local.y, local.x);
    }
    if (any(sourcePixel < 0) || any(sourcePixel >= pointerSize))
    {
        return desktop;
    }

    float4 pointer = pointerTexture.Load(int3(sourcePixel, 0));
    int mode = (int)round(sourceInfo.w);
    if (mode == 1)
    {
        return float4(lerp(desktop.rgb, pointer.rgb, saturate(pointer.a)), desktop.a);
    }
    if (mode == 2)
    {
        float3 masked = pointer.r > 0.5 ? desktop.rgb : float3(0.0, 0.0, 0.0);
        if (pointer.g > 0.5)
        {
            masked = 1.0 - masked;
        }
        return float4(masked, desktop.a);
    }

    uint3 desktopBytes = (uint3)round(saturate(desktop.rgb) * 255.0);
    uint3 pointerBytes = (uint3)round(saturate(pointer.rgb) * 255.0);
    uint3 resultBytes = pointer.a > 0.5 ? (desktopBytes ^ pointerBytes) : pointerBytes;
    return float4((float3)resultBytes / 255.0, desktop.a);
}

// Exact integer-shaped BT.709/video-range conversion. floor(... + 32768)
// mirrors the Rust signed right-shift fixtures for every 8-bit primary.
float3 bt709VideoRange(float3 rgb)
{
    float3 bytes = floor(saturate(rgb) * 255.0 + 0.5);
    float y = 16.0 + floor((
        11968.0 * bytes.r +
        40258.0 * bytes.g +
        4064.0 * bytes.b +
        32768.0
    ) / 65536.0);
    float u = 128.0 + floor((
        -6596.0 * bytes.r -
        22189.0 * bytes.g +
        28785.0 * bytes.b +
        32768.0
    ) / 65536.0);
    float v = 128.0 + floor((
        28785.0 * bytes.r -
        26147.0 * bytes.g -
        2638.0 * bytes.b +
        32768.0
    ) / 65536.0);
    return saturate(float3(y, u, v) / 255.0);
}

float Nv12LumaPs(VertexOutput input) : SV_TARGET
{
    return bt709VideoRange(sourceTexture.Sample(linearClampSampler, input.uv).rgb).x;
}

float2 Nv12ChromaPs(VertexOutput input) : SV_TARGET
{
    // The chroma target is half-resolution. Average the corresponding 2x2
    // luma footprint before conversion, matching NV12 4:2:0 semantics.
    float2 halfTexel = sourceInfo.xy * 0.5;
    float3 rgb = float3(0.0, 0.0, 0.0);
    rgb += sourceTexture.Sample(linearClampSampler, input.uv + float2(-halfTexel.x, -halfTexel.y)).rgb;
    rgb += sourceTexture.Sample(linearClampSampler, input.uv + float2( halfTexel.x, -halfTexel.y)).rgb;
    rgb += sourceTexture.Sample(linearClampSampler, input.uv + float2(-halfTexel.x,  halfTexel.y)).rgb;
    rgb += sourceTexture.Sample(linearClampSampler, input.uv + float2( halfTexel.x,  halfTexel.y)).rgb;
    return bt709VideoRange(rgb * 0.25).yz;
}
