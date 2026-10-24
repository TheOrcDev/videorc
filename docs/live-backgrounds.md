# Live backgrounds

A live background is an animated background behind your screen and camera
(plan 190). Five ship, from React Bits by David Haz: **Silk**, **Side
Rays**, **Plasma Wave**, **Liquid Chrome** and **Line Waves**. Each has three
looks. They are free for everyone, on macOS, Windows and Linux.

## Using them

- **Pick** one in Assets → Backgrounds, in the **Live** group. A click puts
  it on the scene, and a click on the active tile takes it off. Picking a
  picture takes a live background off, and the other way round: a scene has
  one background.
- **Adjust style** on a live tile has four controls:
  - **Look**: three per background.
  - **Motion**: Calm (the default) or Normal. Calm is half the React Bits
    speed: classier behind content and cheaper for a stream's encoder.
  - **Visibility**: how much of the frame the background shows around the
    screen, as for pictures.
  - **Dim**: darkens the background.
- **Saved scenes** remember the live background, its look and its motion.
- The animation starts on the frame the tile shows, so the first frame is
  the picture you clicked.

| Background    | Looks                         |
| ------------- | ----------------------------- |
| Silk          | Satin, Champagne, Midnight    |
| Side Rays     | Sunbeam, Moonlight, Spotlight |
| Plasma Wave   | Plasma, Ember, Glacier        |
| Liquid Chrome | Polished, Gold, Mercury       |
| Line Waves    | Silk, Gold, Aurora            |

## Where it moves, and where it shows a still

A live background is a **bundled picture with a shader attached**. The
scene's background names the look's poster (`live-<id>-<look>`, a WebP in
the bundled backgrounds folder) and a `live` spec names the shader. Every
path that can't animate draws the poster through the picture code that
already exists, and says why in `CompositorStatus.liveBackground.reason`.

| Path                                                         | Moves?              | How                                                                                                                                                            |
| ------------------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS preview, recording, stream (Metal)                     | Yes                 | MSL ports render a live frame; the compositor draws it like a picture. A record-and-stream session's stream leg draws the recording's frame from the same tick |
| Windows recording and stream (D3D11 media session)           | Yes                 | HLSL ports, the same way                                                                                                                                       |
| Windows idle preview, Linux preview (Electron proof surface) | Yes                 | The GLSL in a WebGL2 canvas (`apps/desktop/src/shared/live-background-webgl.js`)                                                                               |
| Linux recording and stream (CPU compositor)                  | Yes                 | The GLSL through EGL/GLES on its own thread; the compositor takes the newest frame                                                                             |
| 4K60 and the bridge-off override (legacy FFmpeg graph)       | No, the poster      | `legacy-graph`, with a start notice                                                                                                                            |
| Windows and macOS CPU fallbacks                              | No, the poster      | `cpu-fallback`                                                                                                                                                 |
| A software GPU (llvmpipe, SwiftShader)                       | No, the poster      | `software-gpu`                                                                                                                                                 |
| Windows on WARP (no D3D11 session)                           | No, the poster      | `cpu-fallback`                                                                                                                                                 |
| Linux without EGL/GLES or a usable render node               | No, the poster      | `no-gpu`, `quarantined-node`                                                                                                                                   |
| Vertical simulcast leg, ISO legs, Clean cut                  | No, as for pictures | Windows' vertical leg draws the poster; the others draw no background                                                                                          |

## Cost, and none when off

With no live background chosen, nothing runs and nothing is allocated:

- no shader compiles and no GPU driver loads;
- no scratch texture, readback buffer or WebGL canvas exists;
- each frame does one `Option` check.

The posters are registered with the backend at start like the bundled
pictures (a path check each, no decode). `pnpm smoke:live-background-off-ab`
compares startup, frame time and memory with `origin/main`.

With one on, measured on an Apple M4 (plan 190 "Measured cost"):

- **GPU time per 1080p frame**: 0.3–0.9 ms for most looks, up to 1.7 ms
  on a loaded machine. A still picture takes 0.05–0.08 ms.
- **Memory**: 0–1 MB of scratch for four of the five, about 13 MB for
  Plasma Wave, plus the live frame (8 MB at 1080p).

### The budget guard

Each 2 s the guard compares the background's own render time with the frame
interval and checks the compositor's missed deadlines:

- Over 20 % of the frame, or missed deadlines while it costs over 10 %: it
  drops to half its internal size.
- Over again: it shows the poster (reason `gpu-budget`, plus one Info health
  event).
- It never climbs back for the same background (a new look or motion
  included). A different background starts again at full size, since the five
  cost very different amounts (`live_background/guard.rs`).

## For developers

The backend owns everything in `crates/videorc-backend/src/live_background/`:

- `looks.rs`: the catalogue, the looks and the uniform packing. Every pass
  of every renderer gets `uniform vec4 u[9]`:
  - `u[0]` = render target, phase, one React Bits "CSS pixel";
  - `u[1]` = the background's internal size and Dim;
  - `u[2..9]` = per-look constants.
- `sizes.rs`: internal sizes (soft backgrounds at most 1080 on the short
  side; Line Waves at full size), Silk's field and Plasma Wave's chain.
- `clock.rs`: the phase clock. Re-based on every change, so a look or motion
  change never jumps; a new background starts at its poster phase.
- `guard.rs`: the budget guard.
- `glsl/*.frag`: the GLSL ES 3.00 sources, the source of truth. Metal and
  D3D11 run hand ports that must match golden grids rendered from these
  (`crates/videorc-backend/tests/fixtures/live-background-golden.json`).
- `export.rs`: writes `apps/desktop/src/shared/live-backgrounds.*.generated.json`
  for the desktop. Regenerate with
  `VIDEORC_UPDATE_LIVE_BACKGROUND_JSON=1 cargo test -p videorc-backend live_background::export`.

### Porting rules (GLSL → MSL and HLSL)

- GLSL `gl_FragCoord` is bottom-left; Metal and D3D11 are top-left.
- GLSL `mod` is not `fmod`.
- `pow(negative, 2.0)` is NaN outside WebGL: write `x * x`.
- Rename MSL and HLSL keywords (`thread`, `sampler`, `line`, …).
- HLSL: write vector arguments out (`float3(1, 1, 1)`, `gray.xxx`) where GLSL
  mixes a scalar and a vector, and keep `fwidth`/`ddx` out of branches that
  differ per pixel (compute, then select).
- Draw opaque over the look's base colour (`#050506`).
- No `_sRGB` views: React Bits writes sRGB values straight into the canvas.

### Adding a look

1. Add it to its background in `looks.rs`, from the React Bits preset file.
2. Regenerate the desktop JSON and add the name to
   `apps/desktop/src/shared/live-background-catalog.ts` (a test pins them).
3. `pnpm probe:live-background-cost -- --mode golden` and `-- --mode posters`.
4. `cargo test -p videorc-backend live_background` on macOS (and the D3D11
   golden test on Windows).

### macOS (Metal)

`live_background/metal.rs` runs the MSL ports on the primary leg's device
and queue:

- **One render per tick.** The primary leg (the recording, or the stream in
  a stream-only session, which Studio's preview shows) renders the live frame
  in its own command buffer just before its compose.
- **The stream leg reuses it (plan 193).** A record-and-stream session
  streams from an auxiliary compositor leg, even at one profile. That leg
  draws the frame the primary rendered in the same tick (`frame_at`), so the
  two outputs share one phase, one guard level and one cost. Before plan 193
  it drew the poster. The vertical simulcast leg and the ISO legs keep no
  background.
- **Why sharing is safe.** Each compose waits until the GPU finishes, and both
  legs run in turn on the loop thread. So the frame is complete before the
  stream leg reads it, and the stream leg is done before the next tick
  overwrites it.
- **Size.** It renders at the larger of the two legs, so the stream never
  draws Line Waves up from a smaller recording.
- **Another device.** If the stream leg's Metal device isn't the one that
  made the frame, the stream leg draws the poster and logs why once.

### Windows (D3D11)

`live_background/d3d11.rs` runs `d3d11.hlsl`, the hand port, on the D3D11
media thread:

- **Where.** The session pump sends the primary leg's live background as a
  `LiveBackground` composition source. The media thread renders the live
  frame just before the scene compose, which draws it as the background
  layer like a picture.
- **One size.** The pump declares the layer before the media thread knows
  how the guard stands, so the live frame is always the Full internal size:
  - the guard's Half level renders smaller and is drawn up into it;
  - a still draws the poster into it, or the base colour while the poster
    isn't prepared.
- **Lazily compiled.** Each entry point compiles with `D3DCompile` the first
  time a background needs it.
- **Timing.** The guard reads D3D11 timestamp queries without waiting.
- **Status.** The preview compositor is suspended during a D3D11 session, so
  the session's pump follows the scene and publishes the status itself.
- **WARP.** The D3D11 session never runs on a software adapter.

No HLSL compiler runs on macOS; `cargo xwin check --target
x86_64-pc-windows-msvc -p videorc-backend --tests` type-checks the Rust.
Windows CI compiles every entry point and runs the golden grids on WARP.

### Linux (GLES)

`live_background/gl.rs` runs the GLSL as it is, OpenGL ES 3.0 through EGL:

- **Loading.** `libEGL.so.1` and `libGLESv2` are loaded with dlopen (the
  `khronos-egl` crate's `dynamic` feature, plus `glow`) the first time a
  live background composes pixels. No system library is linked.
- **One render node.** It opens the pin (`VIDEORC_LINUX_VAAPI_DEVICE`),
  else the first render node that neither the VAAPI quarantine nor its own
  (`linux-live-background/quarantined.json`, beside the database) names. It
  never tries another. A sentinel is armed before the first context and
  draw; a hang quarantines the node for live backgrounds on the next start.
- **No software GL.** If `GL_RENDERER` is llvmpipe, softpipe or swrast, it
  shows the poster (`software-gpu`).
- **One thread.** `videorc-live-background-gl` renders the newest request
  and packs the frame flipped and swizzled to BGRA in one more pass. It
  reads that back through a pixel buffer and publishes it latest-wins. The
  CPU compositor never waits: it draws the newest frame like a picture, and
  the poster until the first frame lands.
- **Lifecycle.** The thread starts with the first composed frame (the idle
  Linux preview composes none; the proof surface draws it in WebGL2) and
  stops when composition stops or the live background leaves.
- **Plasma Wave** needs `EXT_color_buffer_float` or
  `EXT_color_buffer_half_float`. Without them only Plasma Wave shows its
  poster.

macOS can't compile the Linux target (PipeWire needs Linux headers), so
`cargo check -p videorc-backend --tests --features live-background-gl-check`
type-checks the GL module on any OS. CI's Linux job is the real compile gate.
A GLES golden-grid test runs on Linux when EGL is present; it skips without
EGL and accepts Mesa's llvmpipe only with
`VIDEORC_LIVE_BACKGROUND_GL_ALLOW_SOFTWARE=1`.

### Measuring a machine

`pnpm probe:live-background-cost` runs the GLSL in the app's Electron
(WebGL2 on Metal, D3D11 or GL), and times every background at 1080p,
1080 × 1920, 4K and half size. It writes `output/live-background-cost-*.json`.

## Credit and licence

The five shaders are ported from React Bits by David Haz
(https://reactbits.dev), MIT + Commons Clause. They are used in Videorc with
the author's permission (2026-10-24). Videorc never offers them for export
or as a separate pack. See `THIRD_PARTY_NOTICES.md`.
