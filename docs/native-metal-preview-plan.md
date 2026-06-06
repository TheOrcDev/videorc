# Native Metal Preview + GPU Compositor — Integration Plan (Phases 2 & 3)

This is the remaining native integration for the OBS Quality Root Fix. The GPU
compositor **core** is implemented and tested on-device (`metal_compositor.rs`:
device → render pipeline → textured-quad composite → readback, verified on Apple M4).
What's left is wiring it into the live paths and replacing the PNG-polling preview —
work that produces on-screen pixels and therefore needs **on-device visual validation**
(a human comparing against OBS), which no headless test can stand in for.

The honest gates from the earlier phases hold this work accountable: until the native
path lands, the preview-path badge reads **Fallback** and the transport-honesty gate
fails a "native" claim — by design.

## Current state (landed)

- `metal_compositor::composite_sources()` / `MetalSceneCompositor` — GPU composite of
  `GpuSource` layers (BGRA → texture → transformed quad → offscreen BGRA target), readback-
  tested. `MetalSceneCompositor` persists the device/queue/pipeline/sampler and is `Send`.
- `bgra_to_yuv420p()` — full-range BT.601 conversion byte-compatible with the CPU
  compositor, so GPU frames drop straight into the existing encoder pipeline.
- **The GPU compositor is wired into the live compositor loop** behind
  `VIDEORC_METAL_COMPOSITOR` (default off): it composites Screen/Window/Camera scenes with
  transform crop, cover/contain fitting, camera mirror, circle masks, and cached screen
  images, and falls back to the exact CPU compositor for test patterns or uncached image
  sources, so enabling it never changes a frame it cannot reproduce.
- `make_preview_layer()` / `present_texture_to_layer()` — the GPU-side preview present
  (CAMetalLayer + blit + present), compile-and-run tested headlessly.
- Scene/transform math in `scene.rs` (tested) maps 1:1 to each `GpuSource.dest` rect.
- Honest diagnostics expose `previewTransport`, `previewImagePollCounts`,
  `previewSurfaceBacking`, `recordingProtected`, `encodeBackend`, `compositorBackend`,
  `compositorFallbackReason`, `compositorCpuFallbackFrames`, and the at-risk
  classification. The real-source OBS gate now fails while the shared compositor is on
  CPU fallback or the preview surface backing is still the Electron proof BrowserWindow.

## What remains (on-device only)

1. **Electron native view (Phase 2).** Embed the `CAMetalLayer` (driven by
   `present_texture_to_layer`) in a native `NSView` over the React preview rect, and stop
   the PNG polling on that path. This lives in Electron's AppKit main-thread runtime — it
   cannot be built or visually validated from the backend process or headlessly.
2. **GPU shader feature-completeness (Phase 3).** Finish any remaining scene-source edge
   cases so the GPU path covers every scene the CPU path does.
3. **Zero-copy + load validation.** `CVMetalTextureCache` import of camera/screen
   `CVPixelBuffer`s and an IOSurface export to `h264_videotoolbox`, validated against the
   p95 frame-time budget under real 1080p/1440p load, and the human OBS side-by-side.

## Phase 3 — replace the CPU compositor hot path

1. **Persist GPU objects per session.** Build `MTLDevice`, `MTLCommandQueue`, the render
   pipeline, and the sampler once at session start (today the test rebuilds per call).
   Cache source `MTLTexture`s per source id; `replaceRegion` on each new frame instead of
   reallocating.
2. **Import source frames as textures, ideally zero-copy.** Camera frames arrive as
   `CVPixelBuffer`; screen frames as IOSurface-backed `CVPixelBuffer` (ScreenCaptureKit).
   Use `CVMetalTextureCache` to wrap them as `MTLTexture` without a CPU copy, replacing
   the current BGRA `replaceRegion` upload for live sources.
3. **Render the scene** into a persistent target texture at the output cadence, driven by
   the existing compositor loop (`compositor.rs`), behind a `VIDEORC_METAL_COMPOSITOR`
   flag so the CPU path stays as fallback.
4. **Export to the encoder with the lowest copy available.** Allocate the target as an
   IOSurface-backed texture and feed that IOSurface/`CVPixelBuffer` to
   `h264_videotoolbox` (the bridge already uses VideoToolbox — Phase 4), avoiding the
   YUV420P CPU readback the FIFO bridge does today.
5. **Done gate:** 1080p30 and 1440p30 real screen+camera composition under the
   compositor frame-time budget (p95 < 16ms @ 60fps preview / < 30ms @ 30fps output);
   final recording shows no repeated frames from a late compositor.

## Phase 2 — native Metal preview layer (replace PNG polling)

1. **Present the compositor target to a `CAMetalLayer`.** Add a presentation primitive
   (`objc2-quartz-core` `CAMetalLayer` + a blit/draw from the target texture into
   `nextDrawable().texture`, then `presentDrawable`). This is the one piece that cannot be
   readback-tested — it only proves out on a real layer in a window.
2. **Embed the layer in the Electron window.** Replace the current child `BrowserWindow`
   that HTML-polls `/preview/camera|screen/live.png` with a native `NSView` hosting the
   `CAMetalLayer`, positioned over the React preview rect (the renderer already reports
   the preview bounds via `preview-surface:update-bounds`). Options, simplest first:
   - a small N-API native addon that creates the `NSView`/`CAMetalLayer` and accepts the
     compositor's `IOSurface` id per frame; or
   - a Rust-side borderless child `NSWindow` overlay owned by the backend, positioned from
     the reported bounds (no Electron addon, mirrors today's overlay approach but native).
3. **Stop the PNG polling on the native path.** Once the layer shows real pixels, remove
   `startFramePolling`/`backendPreviewFrameUrl` for native mode and set
   `previewTransport = native-surface` and `previewSurfaceBacking = cametal-layer` only
   when the layer is actually presenting. The transport-honesty counters then read
   **0 image polls**, flipping the badge to **OBS-native** and passing the gate.
4. **Keep React for controls only** — handles, badges, overlays draw above the native
   layer.
5. **Done gate (human, on-device):** with native preview enabled, a 60s real
   screen+camera session performs **zero** primary `/preview/*` image polls
   (`previewImagePollCounts` flat); screen text is OBS-sharp; hand motion is current in an
   OBS side-by-side (`docs/obs-acceptance-checklist.md`).

## Validation boundary

Everything above compiles and the compositor core is unit-tested, but the two done-gates
are **visual** and **load-dependent**: they require running the app on the Mac, granting
capture permissions, and a human comparing preview sharpness/latency and recording
smoothness against OBS. That step is intentionally left to the operator — it is the same
"user-created videos are the evidence" bar the root-fix plan sets, and it is what the
automated honest gates were built to make trustworthy rather than replace.
