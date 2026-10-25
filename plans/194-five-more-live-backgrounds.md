# Plan 194: Five more live backgrounds (Beams, Color Bends, Dither, Ferrofluid, Ghost Fibers)

> **Executor instructions**: Follow this plan slice by slice. Run every "Done
> when" check before moving on. If anything in "STOP conditions" happens, stop
> and report; do not improvise. S1 is a hard gate: no Metal, D3D11 or UI
> work starts until its numbers are recorded and inside the budget. After
> S1, the owner rule applies: write and commit every slice, then run the
> gates once in S8. When done, update this plan's row in `plans/README.md`
> and fill in "As built".
>
> **Read first**: `plans/190-live-backgrounds.md` (the design this extends),
> `plans/193-live-background-on-the-stream.md` (the stream leg shares the
> primary's frame) and `docs/live-backgrounds.md` (how a background is
> declared, ported and checked).

## Status

- **Priority**: P1. Owner request, 2026-10-25: "Okay let's now add five more
  live backgrounds" with five Background Studio links:
  - `reactbits.dev/tools/background-studio?bg=beams`
  - `?bg=color-bends`
  - `?bg=dither`
  - `?bg=ferrofluid`
  - `?bg=ghost-fibers`

  "Create a PR."

- **Effort**: XL. Nine slices. The machinery from plan 190 exists. This plan
  adds five shaders on four renderers (Metal, D3D11, GLES, WebGL2), one new
  pass kind (instanced geometry, for Ghost Fibers) and a wider uniform block.
- **Risk**: MEDIUM. Every new background is behind the same four bounds as
  plan 190:
  - one draw replaced;
  - a poster for every failure;
  - the budget guard;
  - zero cost when off.

  The new pass kind and the wider uniform block touch the five shipped
  backgrounds. Their golden grids must stay byte-for-byte within the
  existing bounds.

- **Depends on**: nothing open. Plan 193 (#794, `a465a042`) is merged, so the
  stream leg draws whatever the primary renders.
- **Planned at**: commit `4891fc53` (origin/main, 0.10.0), 2026-10-25.
- **Route**: Orchestrator, fit 10 (four renderers, the wire, assets, UI).
  Model lanes:
  - `fable-5`: S1 to S5 (sources, cost gate, ports, the new pass kind);
  - `opus-4.8`: S7 (Assets UI, with the design skill and the shadcn skill);
  - `gpt-5.5`: S6 and S8 (catalog, posters, docs, gates).

## Owner decisions

Carried over from plan 190 (answered there, and the same creator and
library):

- **Free**: D2.
- **Licence**: D3. React Bits by David Haz, the owner's friend, with
  permission. Credit stays in `THIRD_PARTY_NOTICES.md`, the docs, every
  shader header and the Live group line.
- **Looks**: D4, three curated looks each (below).
- **Motion**: D5, Calm (default) and Normal.
- **Platforms**: D6, all three.
- **4K60 and the legacy graph**: D7, the poster with a notice.
- **Vertical**: D9, as for the first five.

New in this plan. These are recommendations, taken as answered unless the
owner says otherwise:

| #   | Question                       | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | Ferrofluid's spring simulation | **Drop it; evaluate the target height directly.** React Bits' `uSettle` path does exactly this. Without the pointer, the spring only adds lag toward a target that is already a pure function of position and time. A live background must be a pure function of its phase: the recording and stream share one frame (plan 193), and posters and goldens are rendered at fixed phases. Plan 190 dropped Liquid Chrome's simulation for the same reason. |
| N2  | Ghost Fibers' geometry         | **Port it as it is: instanced quads with additive blending, then its bloom chain.** A new pass kind, `Instanced { vertices: 4, instances }`, on Metal, D3D11, GLES and WebGL2. Rewriting the fibers as a full-screen distance field would not look the same and would cost far more per pixel.                                                                                                                                                          |
| N3  | Pointer, click, intro, hover   | **Dropped, as in plan 190.** Their uniforms become constants.                                                                                                                                                                                                                                                                                                                                                                                           |
| N4  | Where the five go in the UI    | **The same Live group, after the first five**, in this order: Beams, Color Bends, Dither, Ferrofluid, Ghost Fibers. The group grows from five tiles to ten.                                                                                                                                                                                                                                                                                             |

## The five (React Bits `e12c221`, read 2026-10-25)

Sources: `src/ts-default/Backgrounds/<Name>/<Name>.tsx`. Presets:
`src/demo/Backgrounds/presets/<Name>.js`, and for Color Bends,
`src/tools/background-studio/backgrounds/index.js` and
`src/constants/backgroundThemeProps.js`.

| Background       | React Bits passes                                                                                                                           | Videorc passes (plan)                                                                                                                                      | Videorc ids                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **Beams**        | `FIELD` into an RGBA16F target with mipmaps, then `COMPOSITE` (raw WebGL2)                                                                  | `BeamsField` (scratch, mipmapped) → `BeamsComposite`: Silk's shape                                                                                         | `beams`, `Beams`              |
| **Color Bends**  | One full-screen shader (three.js only draws the quad); a colour array (`MAX_COLORS`) and an `int` iteration count                           | `ColorBends`: one pass. Colours and iterations are look constants                                                                                          | `color-bends`, `ColorBends`   |
| **Dither**       | `WAVE_FRAGMENT` into a cols × rows RGBA8 field (one texel per dither cell), then `DITHER_FRAGMENT`; a mouse trail and ripples               | `DitherWave` (scratch, `ceil(view / cell)`) → `DitherComposite`. Trail and ripples dropped (N3)                                                            | `dither`, `Dither`            |
| **Ferrofluid**   | `SIM_FRAGMENT` (spring, ping-pong RGBA16F) → `BOUND_FRAGMENT` (9×9 max) → `RENDER_FRAGMENT`                                                 | `FerrofluidField` (the settled target, no ping-pong: N1) → `FerrofluidBound` → `FerrofluidRender`                                                          | `ferrofluid`, `Ferrofluid`    |
| **Ghost Fibers** | Instanced dot quads and dust (`gl_InstanceID`, `gl_VertexID`, additive blend) into RGBA16F, then `BRIGHT` → `DOWN`×n → `UP`×n → `COMPOSITE` | `GhostFibersDots` and `GhostFibersDust` (Instanced, additive: N2) → `GhostFibersBright` → `GhostFibersDown`×n → `GhostFibersUp`×n → `GhostFibersComposite` | `ghost-fibers`, `GhostFibers` |

### Looks (D4 rule: the first is React Bits' default; dark and luxury first)

| Background   | Looks                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Beams        | **Studio**, **Chrome**, **Ember** (presets `studio`, `chrome`, `ember`)                                                                     |
| Color Bends  | **Default** (Background Studio's default palette) plus two palettes from `backgroundThemeProps.js`, picked by eye in S1 and named by colour |
| Dither       | **Classic**, **Amber**, **Blueprint**                                                                                                       |
| Ferrofluid   | **Studio**, **Ember**, **Frost**                                                                                                            |
| Ghost Fibers | **Violet**, **Fiber Optic**, **Ember**                                                                                                      |

## Design

Everything in plan 190's Design holds:

- the live frame, then the picture path;
- the phase clock;
- the guard;
- status;
- zero cost when off;
- the porting rules.

Only the deltas follow.

### Wider uniform block

Today every pass gets `uniform vec4 u[9]` (`looks.rs:9`, `UNIFORM_VEC4_COUNT`).
Ghost Fibers needs a view-projection matrix (4 vec4), an orientation
(3 vec4) and about 30 floats. Color Bends needs up to eight colours.

- Raise `UNIFORM_VEC4_COUNT` to the smallest count that fits all ten,
  expected 24. It is one constant in Rust, generated into the desktop JSON,
  and the `u[N]` declaration in every GLSL, MSL and HLSL source.
- The five shipped backgrounds read the same indices as before. Their golden
  grids must not move (S2 checks it).
- Cost: 24 × 16 bytes per pass of constant data, against 9 × 16 today.

### The instanced pass kind (N2)

`LivePass` gains a kind:

```rust
pub enum PassKind {
    FullScreen,
    Instanced { vertices: u32, instances: u32, blend: PassBlend },
}
pub enum PassBlend { Replace, Additive }
```

- **Instances** come from the look and the internal size (Ghost Fibers:
  fibers × dots, and the dust count), computed in Rust and passed to every
  renderer. Nothing is uploaded: the vertex shader derives every position from
  `gl_InstanceID` and `gl_VertexID`, as React Bits does.
- **Metal**: a render pipeline with a vertex function (`instance_id`,
  `vertex_id`), additive blending on the colour attachment, and
  `drawPrimitives(.triangleStrip, 0, 4, instanceCount)`.
- **D3D11**: an input-layout-free vertex shader (`SV_InstanceID`,
  `SV_VertexID`), an additive `ID3D11BlendState`, and `DrawInstanced(4, n, 0, 0)`.
- **GLES (Linux)** and **WebGL2 (previews)**: `drawArraysInstanced`, as in
  React Bits.
- The budget guard counts the instanced passes' time like any other.
  Half size halves the target and scales the instance count to keep density
  per pixel.

### Ferrofluid without the spring (N1)

- `FerrofluidField` writes `vec4(target, 0, mound, 1)` per grid cell: the
  `uSettle` branch.
- `FerrofluidBound` and `FerrofluidRender` are unchanged apart from N3.
- The grid stays at React Bits' cell size, in "CSS pixels" (one is
  `output_height / 1080`).

### Scratch per background

- **Beams**: one mipmapped RG11B10Float (or RGBA16Float) field.
- **Dither**: one small RGBA8 field (cols × rows).
- **Ferrofluid**: two grid targets.
- **Ghost Fibers**: one scene target and its bloom chain.

The guard's sizes (`sizes.rs`) add each background: the soft ones (Beams,
Color Bends, Ferrofluid, Ghost Fibers) at most 1080 on the short side.
**Dither keeps its cells at full size**: its pattern is per pixel. Every
target is created on first use and dropped when the background changes.

## Budget (unchanged from plan 190)

The 1080p p95 budget on the owner's M4 is 1.5 ms per frame for a soft
background, and 3.0 ms at 4K. On other machines the guard holds it.

S1 measures every look before any port. A background over budget at 1080p
on the M4 must first get cheaper inside its own design. In order:

1. half size;
2. fewer instances or iterations for that look;
3. a coarser bloom chain.

If it still doesn't fit, it is a STOP: report the numbers to the owner.

## Slices

### S1: GLSL sources, cost and goldens (`fable-5`), a hard gate

- Vendor the five as GLSL ES 3.00 under
  `crates/videorc-backend/src/live_background/glsl/` with plan 190's
  conventions:
  - a credit header;
  - pointer, intro and click uniforms become constants (N3);
  - `u[N]` uniforms;
  - Videorc's base colour and grain rules;
  - Ferrofluid per N1;
  - Ghost Fibers' vertex and fragment shaders per N2.
- Extend `scripts/live-backgrounds/cost-probe.mjs` and `probe-main.cjs` to run
  instanced passes (WebGL2 `drawArraysInstanced`, additive blend).
- Measure every look at 1920 × 1080, 1080 × 1920 and 3840 × 2160 (internal
  size per `sizes.rs`): median and p95 over 240 frames. Golden grids for
  every look at two phases go into
  `crates/videorc-backend/tests/fixtures/live-background-golden.json`.
- Compare each look by eye against the React Bits original at the same
  settings: a side-by-side PNG per background goes in the PR.
- Record the numbers here under "As built → S1".

**Done when**: every look on the M4 is inside the budget at the size the
design picks for it, and every by-eye pair matches. Otherwise STOP.

### S2: Rust catalogue, wire and the wider block (`fable-5`)

- `protocol.rs` gains the five `LiveBackgroundId` variants; the TS mirror in
  `apps/desktop/src/shared/live-background-ids.ts` and the strict contract in
  `backend-rpc-contract.ts` gain them too, with protocol fixtures.
- In `looks.rs`: the five catalogues, looks, speeds and uniform packing.
  `UNIFORM_VEC4_COUNT` widens.
- In `glsl.rs`: the passes and the `PassKind`. `sizes.rs`: the sizes.
- Regenerate the desktop JSON
  (`VIDEORC_UPDATE_LIVE_BACKGROUND_JSON=1 cargo test -p videorc-backend live_background::export`).

**Done when**: `cargo test -p videorc-backend live_background` passes, and the
five shipped backgrounds' goldens are unchanged.

### S3: Metal (`fable-5`)

- In `live_background/metal.rs`: the five MSL ports, the instanced pipeline,
  per-background scratch, and the wider block.
- Tests (the plan 190 set, per background):
  - goldens within mean 2/255 and max 10/255;
  - the ring moves;
  - forced still;
  - no allocation when off.

  Plus one plan 193 test with Ghost Fibers on a split record-and-stream.

**Done when**: those tests pass and a dev app shows each of the ten moving.

### S4: D3D11 (`fable-5`, CI only)

- `live_background/d3d11.rs` and `d3d11.hlsl`: the five HLSL ports, the
  instanced pass, the scratch, the wider block.
- WARP golden tests as in plan 190 S4.
- Type-check with `cargo xwin`; CI is the first compile.

**Done when**: `cargo xwin clippy` adds no error over `origin/main`'s set
(main already fails it; compare the sets, never the counts), and the tests
are written.

### S5: GLES and the WebGL2 previews (`fable-5`)

- `live_background/gl.rs`: the instanced pass and the new scratch. The GLSL
  runs as it is. It compiles on macOS with `--features live-background-gl-check`.
- `apps/desktop/src/shared/live-background-webgl.js`: the instanced pass,
  with its unit tests.

**Done when**: the GL check build passes, and
`pnpm --filter @videorc/desktop test` passes the WebGL tests.

### S6: posters, thumbnails and the catalogue (`gpt-5.5`)

- `pnpm probe:live-background-cost -- --mode posters`: 15 posters
  (1672 × 941, ≤ 250 KB) and 15 thumbnails (384 × 216, ≤ 20 KB) under
  `renderer/src/assets/backgrounds/` and `live-thumbs/`. Add them to the
  bundled manifest.
- `apps/desktop/src/shared/live-background-catalog.ts`,
  `renderer/src/lib/live-backgrounds.ts`: names, looks and copy.
- The eager id → poster table stays under the renderer budget
  (`pnpm check:renderer-assets`).

**Done when**: the desktop unit tests and `check:renderer-assets` pass.

### S7: Assets UI (`opus-4.8`)

- Load `.claude/skills/videorc-design/SKILL.md` and the shadcn skill first.
- The Live group shows ten tiles in two rows of five, the new five after
  the first five, with the same tile, chip, click-to-apply and
  Adjust-style popover.
- Check light and dark (owner rule 2026-10-11).

**Done when**: the group's tests pass, and screenshots in both themes are in
the PR.

### S8: smokes, docs and gates (`gpt-5.5`)

- `smoke:live-background` gains the five: one record-only case each, and
  a record-and-stream case for Ghost Fibers (instanced) and Dither (per-pixel
  cells drawn into a smaller stream).
- `docs/live-backgrounds.md`: the ten, the instanced pass kind, N1.
  `THIRD_PARTY_NOTICES.md`.
- Gates:
  - `cargo fmt --check --all` and the repo clippy gate.
  - The targeted `cargo test`, plus `cargo build --release` (cfg edits).
  - `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:scripts`,
    the desktop tests and `check:renderer-assets`.
  - `smoke:live-background`, also with `VIDEORC_LIVE_BACKGROUND_FORCE_STILL=1`.
  - `smoke:live-background-off-ab --base <origin/main>`.

  Run them on a quiet host where possible. Never run them while the owner is
  live.

## STOP conditions

- A look is over budget at 1080p on the M4 after the three steps in "Budget".
- A by-eye pair does not match React Bits, and the cause is in the platform,
  not in a port bug.
- The wider uniform block moves a shipped background's golden.
- An instanced pass cannot run on one of the four renderers without a new
  system library or a new linked framework.

## As built

### S2: catalogue, wire and the wider block (2026-10-25)

Commit `fe5eb1fc`.

- **Ids**: `beams`, `color-bends`, `dither`, `ferrofluid` and `ghost-fibers`, in
  Rust, TS and the catalogue. The strict contract takes its id enum from the
  shared list, so a new background can't be rejected there by omission (the
  plan 190 S11 trap). A protocol test round-trips all ten.
- **`UNIFORM_VEC4_COUNT` is 16**, the smallest block that fits all ten:
  - Ghost Fibers uses all 16 (its orientation is three columns plus
    about 30 floats);
  - Color Bends and Dither use 14 (eight colour or palette slots).

  The plan 190 five keep their indices; their new rows are zero.
  `u[16]` is in every GLSL, HLSL and GLES source.

- **Looks** (the D4 rule):

  | Background   | Looks                                |
  | ------------ | ------------------------------------ |
  | Beams        | Studio, Chrome, Ember                |
  | Color Bends  | Default, Ember, Ocean                |
  | Dither       | Classic, Amber, Blueprint            |
  | Ferrofluid   | Studio, Ember, Frost                 |
  | Ghost Fibers | Violet, Fiber Optic (`fiber`), Ember |
  - Color Bends' first look is Background Studio's default palette.
    `backgroundThemeProps.js` has no Color Bends palettes, only one light-mode
    colour (`#6d28d9`), so Ember (`#ff6a1a`, `#ff2d6f`, `#ffd59a`) and Ocean
    (`#2a4bd7`, `#06b6d4`, `#93c5fd`) are picked by eye from the other plans'
    accents. That is an owner call to confirm.

- **`PassKind`**: `FullScreen` or `Instanced { vertices, instances, blend }`,
  with `PassBlend`. Only Ghost Fibers' dots and dust are instanced. The
  counts come from the look:
  - Violet: 3 × 72 × 260 = 56,160 dots and 210 dust;
  - Fiber Optic: 2 × 96 × 260 = 49,920 dots and 210 dust;
  - Ember: 56,160 dots and 378 dust.

  The guard's half size shrinks the target, not the fibers.

- **Sizes**:
  - Beams' field: ¾ of the view, at most 1.6 MP.
  - Dither: full size; its cell is `round(2 × min(view) / 1080)` px.
  - Ferrofluid's grid: React Bits' camera footprint, ⅓ unit per cell
    (139 × 93 at 16:9).
  - Ghost Fibers' bloom: five levels from half size.
- **Interim paths** for the renderers S3–S5 port:
  - Metal, D3D11, GLES and the WebGL runner give each new id its poster with
    `shader-compile-failed` before any shader is tried, so nothing is
    poisoned for the five that work (a Metal test proves it).
  - Their golden tests skip the unported.
  - Assets offers only backgrounds with a thumbnail for every look, so the five
    join the Live group with their posters (S6), never as blank tiles.
- **Deviation**: the GLSL sources landed in this commit, not S1's, because
  `glsl.rs` includes them and the export ships them.

### S1: GLSL, the probe, goldens and the cost gate (2026-10-25)

**Sources** (`glsl/`):

- Beams, Color Bends, Dither, Ferrofluid (N1: the settled target, three
  passes, no ping-pong), and Ghost Fibers (`ghost_fibers.vert` for the
  instanced dots and dust, `ghost_fibers.frag` for the shading, the bloom
  chain and the composite).
- N3: pointer, hover, click and intro are constants.
- Grain: React Bits' fixed-in-place grain is kept at a third (Silk's rule).
  Color Bends' per-frame noise is fixed in place at a third. Ghost Fibers'
  per-frame grain is fixed in place.
- Color Bends keeps React Bits' pull toward the resting pointer (the centre):
  it is part of the look at rest.

**The probe** (`scripts/live-backgrounds/`):

- `probe-passes.js` draws the five (new scratch targets and
  `drawArraysInstanced` with additive blending) until S5 moves this into the
  shared runner. It checks its size rules against the generated cases on
  start.
- `--mode golden` merges into the fixture and fails if a shipped entry
  renders differently.
- New: `--mode frames`, `--ids`, `--level` and `--render`.
- `cost` reports the load average.

**Goldens**: 60 grids (30 new). The 30 shipped ones re-rendered byte-identical
with `u[16]`, so the wider block moved no shipped golden: the probe checks it,
and the Metal golden test still passes all 30.

**By eye**: React Bits' own GLSL from each `.tsx`, with the uniforms its
component sets for the preset, the pointer at rest and the intro finished,
beside the vendored GLSL at the same phase. Every look matches:

- Beams: lane for lane, glint for glint.
- Color Bends: same bands; the grain is lighter.
- Dither: pixel-identical patterns.
- Ferrofluid: spike for spike.
- Ghost Fibers: same ribbons, dots, tips and bloom.

The pairs must be rendered at Videorc's scale: a frame's short side is 1080
React Bits CSS pixels, so at 640 × 360 React Bits renders a 1920 × 1080 CSS
canvas at a device ratio of ⅓. At a device ratio of 1 the beams, Dither's cells
and Ghost Fibers' dots differ by exactly that scale.

**Measuring.** Plan 190's timer query (`EXT_disjoint_timer_query_webgl2`) is
not a usable gate on ANGLE over Metal:

- It reads 4–6× the Metal command-buffer times plan 190 S2 measured for the
  same shaders (Silk 1.45 / 2.51 ms against 0.34 / 0.41).
- It carries about 1 ms even for a 960 × 540 frame, plus a cost per canvas
  pixel.

The probe now also times the live frame the way the guard and the Metal test
do:

- the live frame alone, at its internal size, with no upscale;
- the render pass ends after every frame, so the tile GPU can't
  hidden-surface-remove whole frames;
- 30 batches of 8 frames, each closed by a 1-pixel `readPixels`;
- median and p95 over the batch means.

Calibration against plan 190 S2's Metal numbers (1080p, median / p95, ms):

| Background      | Probe live frame (load 5) | Metal (plan 190 S2, load 33) |
| --------------- | ------------------------- | ---------------------------- |
| Silk            | 0.49 / 0.56               | 0.34 / 0.41                  |
| Side Rays       | 0.45 / 0.59               | 0.36 / 0.38                  |
| Plasma Wave     | 1.26 / 1.35               | 0.56 / 1.06                  |
| Liquid Chrome   | 1.10 / 1.19               | 0.85 / 0.92                  |
| Line Waves      | 0.39 / 0.46               | 0.30 / 0.32                  |
| Line Waves (4K) | 1.34 / 1.44               | 1.24 / 1.35                  |

So it never reads low:

- about +0.1–0.25 ms for one or two passes;
- about +0.06 ms more per extra pass (Plasma's 11 read about 2× at the
  median). That excess is GPU-side; committing each frame did not reduce it.

The p95 gate on this instrument is therefore strict, and Metal (S3) will read
lower.

**Cost**: `GL_RENDERER` "ANGLE (Apple, ANGLE Metal Renderer: Apple M4)", 240
frames per case. Load average 4.3–5.0 (a Unity editor held about 160 % CPU and
part of the GPU throughout). "Live" is the gate's number; "timer" is plan 190's
query, for reference only. 4K renders the soft four at 1920 × 1080 (the
compose draws them up) and Dither at full size.

| Background   | Look      | Output      | Renders     | Live median / p95 (ms) | Timer median / p95 (ms) | Scratch MB |
| ------------ | --------- | ----------- | ----------- | ---------------------- | ----------------------- | ---------- |
| beams        | studio    | 1920 × 1080 | 1920 × 1080 | 0.89 / 0.99            | 3.16 / 5.75             | 11.9       |
| beams        | studio    | 1080 × 1920 | 1080 × 1920 | 0.85 / 1.04            | 3.21 / 5.70             | 11.9       |
| beams        | studio    | 3840 × 2160 | 1920 × 1080 | 0.85 / 0.91            | 5.97 / 11.81            | 11.9       |
| beams        | studio    | half        | 960 × 540   | 0.27 / 0.33            | 1.29 / 2.30             | 3.0        |
| beams        | chrome    | 1920 × 1080 | 1920 × 1080 | 0.82 / 0.98            | 2.97 / 5.45             | 11.9       |
| beams        | chrome    | 1080 × 1920 | 1080 × 1920 | 0.81 / 0.89            | 3.19 / 5.41             | 11.9       |
| beams        | chrome    | 3840 × 2160 | 1920 × 1080 | 0.83 / 0.89            | 5.69 / 11.24            | 11.9       |
| beams        | chrome    | half        | 960 × 540   | 0.27 / 0.31            | 1.28 / 2.27             | 3.0        |
| beams        | ember     | 1920 × 1080 | 1920 × 1080 | 0.82 / 0.89            | 3.24 / 5.50             | 11.9       |
| beams        | ember     | 1080 × 1920 | 1080 × 1920 | 0.82 / 0.90            | 3.19 / 5.58             | 11.9       |
| beams        | ember     | 3840 × 2160 | 1920 × 1080 | 0.84 / 0.90            | 5.57 / 11.09            | 11.9       |
| beams        | ember     | half        | 960 × 540   | 0.28 / 0.35            | 1.23 / 2.26             | 3.0        |
| color-bends  | default   | 1920 × 1080 | 1920 × 1080 | 0.50 / 0.55            | 1.89 / 3.08             | 0.0        |
| color-bends  | default   | 1080 × 1920 | 1080 × 1920 | 0.49 / 0.55            | 1.76 / 3.05             | 0.0        |
| color-bends  | default   | 3840 × 2160 | 1920 × 1080 | 0.49 / 0.55            | 4.97 / 9.45             | 0.0        |
| color-bends  | default   | half        | 960 × 540   | 0.18 / 0.19            | 1.08 / 2.07             | 0.0        |
| color-bends  | ember     | 1920 × 1080 | 1920 × 1080 | 0.48 / 0.51            | 1.81 / 3.05             | 0.0        |
| color-bends  | ember     | 1080 × 1920 | 1080 × 1920 | 0.48 / 0.54            | 1.75 / 3.04             | 0.0        |
| color-bends  | ember     | 3840 × 2160 | 1920 × 1080 | 0.49 / 0.54            | 5.37 / 9.53             | 0.0        |
| color-bends  | ember     | half        | 960 × 540   | 0.18 / 0.25            | 1.20 / 2.11             | 0.0        |
| color-bends  | ocean     | 1920 × 1080 | 1920 × 1080 | 0.49 / 0.55            | 1.84 / 3.05             | 0.0        |
| color-bends  | ocean     | 1080 × 1920 | 1080 × 1920 | 0.49 / 0.54            | 1.87 / 3.04             | 0.0        |
| color-bends  | ocean     | 3840 × 2160 | 1920 × 1080 | 0.49 / 0.54            | 5.34 / 9.61             | 0.0        |
| color-bends  | ocean     | half        | 960 × 540   | 0.18 / 0.19            | 1.12 / 2.07             | 0.0        |
| dither       | classic   | 1920 × 1080 | 1920 × 1080 | 0.55 / 0.60            | 1.91 / 3.30             | 2.0        |
| dither       | classic   | 1080 × 1920 | 1080 × 1920 | 0.54 / 0.59            | 1.90 / 3.28             | 2.0        |
| dither       | classic   | 3840 × 2160 | 3840 × 2160 | 1.11 / 1.19            | 4.29 / 7.61             | 2.0        |
| dither       | classic   | half        | 960 × 540   | 0.38 / 0.44            | 1.76 / 3.42             | 2.0        |
| dither       | amber     | 1920 × 1080 | 1920 × 1080 | 0.54 / 0.60            | 2.00 / 3.35             | 2.0        |
| dither       | amber     | 1080 × 1920 | 1080 × 1920 | 0.54 / 0.60            | 1.89 / 3.26             | 2.0        |
| dither       | amber     | 3840 × 2160 | 3840 × 2160 | 1.09 / 1.18            | 4.30 / 7.54             | 2.0        |
| dither       | amber     | half        | 960 × 540   | 0.38 / 0.43            | 1.77 / 3.42             | 2.0        |
| dither       | blueprint | 1920 × 1080 | 1920 × 1080 | 0.54 / 0.60            | 1.72 / 3.23             | 2.0        |
| dither       | blueprint | 1080 × 1920 | 1080 × 1920 | 0.54 / 0.60            | 1.90 / 3.30             | 2.0        |
| dither       | blueprint | 3840 × 2160 | 3840 × 2160 | 1.09 / 1.16            | 4.24 / 7.60             | 2.0        |
| dither       | blueprint | half        | 960 × 540   | 0.38 / 0.44            | 1.85 / 3.55             | 2.0        |
| ferrofluid   | studio    | 1920 × 1080 | 1920 × 1080 | 1.60 / **1.94**        | 6.43 / 12.54            | 0.1        |
| ferrofluid   | studio    | 1080 × 1920 | 1080 × 1920 | 1.66 / **2.06**        | 6.49 / 12.63            | 0.0        |
| ferrofluid   | studio    | 3840 × 2160 | 1920 × 1080 | 1.56 / 1.95            | 8.87 / 17.47            | 0.1        |
| ferrofluid   | studio    | half        | 960 × 540   | 0.54 / 0.64            | 2.18 / 4.13             | 0.1        |
| ferrofluid   | ember     | 1920 × 1080 | 1920 × 1080 | 1.63 / **1.99**        | 6.58 / 12.69            | 0.1        |
| ferrofluid   | ember     | 1080 × 1920 | 1080 × 1920 | 1.68 / **2.07**        | 6.74 / 13.22            | 0.0        |
| ferrofluid   | ember     | 3840 × 2160 | 1920 × 1080 | 1.65 / 2.09            | 8.98 / 18.17            | 0.1        |
| ferrofluid   | ember     | half        | 960 × 540   | 0.51 / 0.60            | 2.21 / 4.27             | 0.1        |
| ferrofluid   | frost     | 1920 × 1080 | 1920 × 1080 | 1.66 / **2.01**        | 6.74 / 12.98            | 0.1        |
| ferrofluid   | frost     | 1080 × 1920 | 1080 × 1920 | 1.70 / **2.13**        | 6.67 / 13.24            | 0.0        |
| ferrofluid   | frost     | 3840 × 2160 | 1920 × 1080 | 1.65 / 2.04            | 8.72 / 18.54            | 0.1        |
| ferrofluid   | frost     | half        | 960 × 540   | 0.53 / 0.63            | 2.12 / 4.22             | 0.1        |
| ghost-fibers | violet    | 1920 × 1080 | 1920 × 1080 | 1.71 / **1.78**        | 4.32 / 6.82             | 26.3       |
| ghost-fibers | violet    | 1080 × 1920 | 1080 × 1920 | 1.53 / **1.66**        | 3.76 / 6.06             | 26.3       |
| ghost-fibers | violet    | 3840 × 2160 | 1920 × 1080 | 1.65 / 1.86            | 6.38 / 8.87             | 26.3       |
| ghost-fibers | violet    | half        | 960 × 540   | 0.68 / 0.77            | 1.50 / 2.30             | 6.6        |
| ghost-fibers | fiber     | 1920 × 1080 | 1920 × 1080 | 1.85 / **1.93**        | 4.59 / 7.26             | 26.3       |
| ghost-fibers | fiber     | 1080 × 1920 | 1080 × 1920 | 1.66 / **1.75**        | 4.13 / 6.64             | 26.3       |
| ghost-fibers | fiber     | 3840 × 2160 | 1920 × 1080 | 1.88 / 1.95            | 6.46 / 9.54             | 26.3       |
| ghost-fibers | fiber     | half        | 960 × 540   | 0.69 / 0.75            | 1.47 / 2.34             | 6.6        |
| ghost-fibers | ember     | 1920 × 1080 | 1920 × 1080 | 1.85 / **1.94**        | 4.84 / 7.67             | 26.3       |
| ghost-fibers | ember     | 1080 × 1920 | 1080 × 1920 | 1.61 / **1.71**        | 4.10 / 6.55             | 26.3       |
| ghost-fibers | ember     | 3840 × 2160 | 1920 × 1080 | 1.86 / 1.94            | 6.91 / 9.34             | 26.3       |
| ghost-fibers | ember     | half        | 960 × 540   | 0.75 / 0.84            | 1.72 / 2.59             | 6.6        |

"Half" is 1920 × 1080 at the guard's Half level. Scratch is the probe's
(RGBA16F; Metal will use smaller formats where it can).

**Gate verdict**:

- **Beams, Color Bends, Dither: inside**, at every size, in every look.
- **Ferrofluid: over at 1080p** (p95 1.94–2.13 ms); inside at 4K (1.95–2.09
  ms against 3.0). The ladder:
  1. Half size fits (0.60–0.64 ms), but at 1:1 the spikes are softer and their
     rims step. Close, not identical.
  2. Fewer iterations: not tried. The march's limits are React Bits' own;
     cutting them risks holes at grazing angles.
  3. A coarser bloom: none (Ferrofluid has no bloom).
- **Ghost Fibers: over at 1080p** (p95 1.66–1.94 ms); inside at 4K. The
  ladder, on Violet:
  1. Half size fits (0.75–0.84 ms) but changes the look. Its dot radii, DoF
     circles and floor are in render pixels, so the fold blows out and the
     ribbon brightens.
  2. Fewer instances: dots cost about 0.6 ms (no dots: 1.10 / 1.16 ms; no
     dust: 1.68 / 1.75). Density 0.6 gives 1.40 / 1.56, still over.
  3. A coarser bloom (the chain from quarter size): 1.56 / 1.68 alone.
     **With density 0.6: 1.27 / 1.38 (inside)**, but that is a different look
     (sparser, larger bokeh dots and a dimmer fold, closer to React Bits'
     "bokeh" preset than to Violet).

Per the STOP rule, Ferrofluid and Ghost Fibers wait for the owner. Their
per-pass ANGLE excess suggests the native Metal cost is lower (by the
calibration, roughly 1.2–1.6 ms p95 for Ferrofluid and 1.0–1.5 ms for Ghost
Fibers), but that is an estimate until S3 measures them. Options:

- **A.** Port them in S3 as they are, and gate on the Metal numbers. The guard
  drops them to half size on a machine where they cost more.
- **B.** Half size by design for Ferrofluid (slightly softer).
- **C.** The cheaper Ghost Fibers variant as its looks.
- **D.** Defer the two and ship three.

By-eye PNGs (not committed): `beams-`, `color-bends-`, `dither-`,
`ferrofluid-` and `ghost-fibers-side-by-side.png`, the half-size crops and
`ghost-fibers-cheaper-variant.png`, in the session scratchpad
(`plan194-s1/`).
