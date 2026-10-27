# Live backgrounds

A live background is an animated background behind your screen and camera
(plan 190). Ten ship, from React Bits by David Haz: **Silk**, **Side
Rays**, **Plasma Wave**, **Liquid Chrome** and **Line Waves** (plan 190), and
**Beams**, **Color Bends**, **Dither**, **Ferrofluid** and **Ghost Fibers**
(plan 194). Each has three looks. They are free for everyone, on macOS,
Windows and Linux.

## Using them

- **Pick** one in Assets → Backgrounds, in the **Live** group (two rows of
  five). A click puts
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
| Beams         | Studio, Chrome, Ember         |
| Color Bends   | Default, Ember, Ocean         |
| Dither        | Classic, Amber, Blueprint     |
| Ferrofluid    | Studio, Ember, Frost          |
| Ghost Fibers  | Violet, Fiber Optic, Ember    |

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
| Welcome screen, first-run setup (renderer WebGL2)            | Yes, unless still   | Shared player through `renderer/src/lib/live-background-player.ts`; poster first, 30 fps cap, reduced-motion and no-GPU stills; inverted in light              |
| Your look scene picture, first-run setup (renderer WebGL2)   | Yes, unless still   | The same shared player, chosen live background and first look; same 30 fps cap, poster-first, still and disposal rules                                         |
| Linux recording and stream (CPU compositor)                  | Yes                 | The GLSL through EGL/GLES on its own thread; the compositor takes the newest frame                                                                             |
| 4K60 and the bridge-off override (legacy FFmpeg graph)       | No, the poster      | `legacy-graph`, with a start notice                                                                                                                            |
| Windows and macOS CPU fallbacks                              | No, the poster      | `cpu-fallback`                                                                                                                                                 |
| A software GPU (llvmpipe, SwiftShader)                       | No, the poster      | `software-gpu`                                                                                                                                                 |
| Windows on WARP (no D3D11 session)                           | No, the poster      | `cpu-fallback`                                                                                                                                                 |
| Linux without EGL/GLES or a usable render node               | No, the poster      | `no-gpu`, `quarantined-node`                                                                                                                                   |
| Vertical simulcast leg, ISO legs, Clean cut                  | No, as for pictures | Windows' vertical leg draws the poster; the others draw no background                                                                                          |

### Welcome screen

First-run setup is the fourth place the WebGL player runs, beside the
Windows idle preview and the Linux preview (plan 203). It is the only live
background behind the app's own UI: Liquid Chrome, Polished, at Normal
motion. Under dark the shader dims it 30% (50% under Increase Contrast).
Under light it is the same look turned around (plan 208 D3): white liquid
with black reflections. The setup card uses the dialog tier and
carries all the text.

`apps/desktop/src/renderer/src/lib/live-background-player.ts` lazily loads
the shared player, clock and render data with setup. It shows the poster
first, then fades in the first drawn frame. It caps drawing at 30 fps and
bounds the canvas's long side to 1920 device pixels. Each player owns its
canvas: disposal releases the GL context and removes the canvas, and a new
player creates a new one. Reusing a canvas after losing its context broke
motion under StrictMode; the ownership rule prevents that regression.

Reduced motion, hardware acceleration off, no GPU, software GPU, shader
compilation failure, context loss and the GPU budget guard keep the poster
still. The reason is exposed through `data-first-run-backdrop-reason` and
logged once. The guard checks median drawn-frame intervals over 3 s: above
50 ms it drops to half size, then to a still if the next window stays slow.
Hidden or minimized windows pause; closing setup disposes the player.
`pnpm smoke:first-run` measures motion and the draw cap in the real app and
fails on an unexpected still reason.

#### Light is an invert, not a look

The Liquid Chrome shader is dark only: a black studio with white lamps. A
light look would need new lighting in all four renderers, plus posters and
goldens. Turning the dark look's pixels around gives the owner's "the other
way around" exactly, so light is a CSS filter (plan 208 S5):

- **Where.** An inner wrapper around the poster `<img>` and the canvas host
  (`data-first-run-backdrop-picture`) takes `filter: invert(1)`, so the
  still and the motion always match. The backdrop root's solid is never
  inverted, and dark has no filter.
- **Tone.** The shader's Dim darkens before the invert, so after it, Dim
  would lift the blacks and wash the chrome out. Light takes no shader Dim.
  Its tone is a CSS `brightness()` after the invert: none by default (the
  crisp invert), and 0.85 under `prefers-contrast: more` so the porcelain
  card separates. `welcomeBackdropDim` returns the split (`tone`, `shader`,
  `brightness`), and `welcomeBackdropPictureFilter` turns it into the
  filter.
- **DOM contract.** The root carries
  `data-first-run-backdrop-tone="normal|inverse"`, and it follows the theme
  at once while Welcome is open. `smoke:first-run` asserts it per theme,
  with a follow-system flip while open and a cold open in light that never
  shows the dark tone.
- **Cost.** The invert is a compositor filter over a 30 fps canvas. Over
  30 s light held 30 fps with the same p50, p95 and p99 frame interval as
  dark, and the GPU process used 7.0% CPU against 5.2% (indicative; the
  numbers are in `docs/acceptance/2026-10-27-liquid-chrome-colours.md`).
  The budget guard still drops to the poster if it gets slow.
- **The card.** In light the dialog tier has a deeper drop
  (`--glass-float-dialog-drop`), so the porcelain card separates from white
  crests without an overlay.

### Your look scene picture

Your look is the fifth place the shared WebGL player runs (plan 207),
inside the setup card's read-only scene picture. It plays the chosen live
background in its first look, behind the committed scene's boxes and
camera mask; the boxes name devices rather than opening camera or screen
capture. None allocates no player. The backdrop keeps Liquid Chrome.

The picture uses `live-background-player.ts` with an optional background
id and motion; its drawing, 30 fps cap, poster-first start, reduced-motion
and GPU still rules are the Welcome screen's. Changing the background or
leaving the step releases its context. Its DOM state is
`data-first-run-look-picture="moving|still|starting|none"`. A still reason
is logged as `[first-run] Your look's {id} shows its poster: {reason}`.

While Your look shows, two players run. `pnpm smoke:first-run` counts each
player's final default-framebuffer draws separately over at least 30 s,
checks each against 31 fps (30 plus sampling tolerance), and records the
GPU process CPU delta over the same interval. It requires the backdrop to
stay moving on the acceptance Mac. A no-GPU picture records an explicit
skip with the backdrop's still reason; an unexplained or budget-triggered
still fails. See [plan 207 acceptance](acceptance/2026-10-27-first-run-steps.md)
for the Mac numbers and the Windows measurement still owed.

### Chrome grounds (plan 208)

The opaque window grounds are a still of Liquid Chrome's Polished look at
its catalogue poster phase (1.2), rendered by the existing WebGL2 poster
runner at 1280 × 720 with Dim 0. The Rust `chrome-grounds` example applies
`image::imageops::blur` with Gaussian σ 24 to sRGB bytes. For light, it
inverts each channel (`255 - v`) **before** blurring.

Every window's `ChromeGround` (`components/chrome-ground.tsx`, plan 208 S2)
paints them under its coats, and the phone remote's LAN router serves the
same files at `/chrome-ground-{dark,light}.webp` (`include_bytes!`, never a
copy; S6). `chrome-ground-contrast.test.ts` reads the stats file, so a
regenerated ground re-proves the windows' text contrast.

Regenerate from the repository root (requires Rust, desktop Electron and
libwebp's `cwebp` on PATH):

```sh
PATH=/opt/homebrew/bin:$PATH env -u ELECTRON_RUN_AS_NODE pnpm probe:live-background-cost -- --mode grounds
```

The helper encodes with `cwebp -q 90` (lossy), enforcing 40,000 bytes per
asset. The existing `image` lossless WebP encoder exceeded that budget;
using the installed encoder adds no dependency to the app. Outputs live in
`assets/backgrounds/chrome-ground-{dark,light}.webp` and
`chrome-ground.stats.json`. Never hand-edit them; rerun the generator.
Stats measure decoded shipping pixels: Rec.709 weighted luma of
gamma-encoded sRGB (`(0.2126 R + 0.7152 G + 0.0722 B) / 255`), without
linearization. This grey is not WCAG relative luminance; contrast tests
must linearize the composited sRGB values separately. JSON uses stable
field order and records generator version, inputs and encoding.

Verify the committed pixels and stats with:

```sh
cargo test -p videorc-backend --example chrome-grounds chrome_ground_stats_match_committed_webps
```

## Cost, and none when off

With no live background chosen, nothing runs and nothing is allocated:

- no shader compiles and no GPU driver loads;
- no scratch texture, readback buffer or WebGL canvas exists;
- each frame does one `Option` check.

The posters are registered with the backend at start like the bundled
pictures (a path check each, no decode). `pnpm smoke:live-background-off-ab`
compares startup, frame time and memory with `origin/main`.

With one on, measured on an Apple M4 (plan 190 "Measured cost", plan 194
"As built"):

- **GPU time per 1080p frame** (p95): 0.3–0.9 ms for most looks; Ferrofluid
  1.2–1.4 ms (it renders at three quarters, see below) and Ghost Fibers
  1.1–1.5 ms. A still picture takes 0.05–0.08 ms.
- **Memory**: scratch beside the live frame (8 MB at 1080p):
  - 0–2 MB for Silk, Side Rays, Liquid Chrome, Line Waves, Color Bends,
    Dither (at 1080p) and Ferrofluid;
  - about 7 MB for Beams, 13 MB for Plasma Wave and 22 MB for Ghost Fibers.

### The budget guard

Each 2 s the guard compares the background's own render time with the frame
interval and checks the compositor's missed deadlines:

- Over 20 % of the frame, or missed deadlines while it costs over 10 %: it
  drops to half its internal size.
- Over again: it shows the poster (reason `gpu-budget`, plus one Info health
  event).
- It never climbs back for the same background (a new look or motion
  included). A different background starts again at full size, since the ten
  cost very different amounts (`live_background/guard.rs`).

## For developers

The backend owns everything in `crates/videorc-backend/src/live_background/`:

- `looks.rs`: the catalogue, the looks and the uniform packing. Every pass
  of every renderer gets `uniform vec4 u[16]` (`UNIFORM_VEC4_COUNT`, widened
  from 9 in plan 194; Ghost Fibers uses all 16):
  - `u[0]` = render target, phase, one React Bits "CSS pixel";
  - `u[1]` = the background's internal size and Dim;
  - `u[2..16]` = per-look constants.
- `sizes.rs`: internal sizes and scratch:
  - soft backgrounds render at most 1080 on the short side, Ferrofluid at
    most 810 (its march is the costliest; owner call, plan 194);
  - Line Waves and Dither render at full size;
  - plus Silk's field, Plasma Wave's chain, Beams' mipmapped field,
    Dither's cell field, Ferrofluid's grid and Ghost Fibers' bloom chain.
- `clock.rs`: the phase clock. Re-based on every change, so a look or motion
  change never jumps; a new background starts at its poster phase.
- `guard.rs`: the budget guard.
- `glsl/*.frag` (and `ghost_fibers.vert`): the GLSL ES 3.00 sources, the
  source of truth. Metal and D3D11 run hand ports that must match golden
  grids rendered from these
  (`crates/videorc-backend/tests/fixtures/live-background-golden.json`).
- `glsl.rs`: each background's passes. A pass is `FullScreen` (one triangle)
  or `Instanced { vertices, instances, blend }`: Ghost Fibers draws its dots
  and dust as instanced quads, additively blended into a cleared scene, then
  blooms it. Every renderer (Metal, D3D11, GLES, WebGL2) runs both kinds.
- **Ferrofluid has no simulation.** React Bits springs its surface toward a
  target each frame; Videorc evaluates the settled target directly (a pure
  function of the phase), so every leg and every frame agree and nothing is
  carried between frames.
- `export.rs`: writes `apps/desktop/src/shared/live-backgrounds.*.generated.json`
  for the desktop. Regenerate with
  `VIDEORC_UPDATE_LIVE_BACKGROUND_JSON=1 cargo test -p videorc-backend live_background::export`.

### Porting rules (GLSL → MSL and HLSL)

- GLSL `gl_FragCoord` is bottom-left; Metal and D3D11 are top-left.
- GLSL `mod` is not `fmod`.
- `pow(negative, 2.0)` is undefined in GLSL and NaN in HLSL (and in WebGL on
  ANGLE's D3D11): write `x * x`, in the GLSL source too.
- HLSL `Sample` inside a loop with a data-dependent exit is an fxc error:
  use `SampleLevel(…, 0)` (Ferrofluid's march).
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

The ten shaders are ported from React Bits by David Haz
(https://reactbits.dev), MIT + Commons Clause. They are used in Videorc with
the author's permission (2026-10-24). Videorc never offers them for export
or as a separate pack. See `THIRD_PARTY_NOTICES.md`.
