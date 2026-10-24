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

(Filled in by the executor.)
