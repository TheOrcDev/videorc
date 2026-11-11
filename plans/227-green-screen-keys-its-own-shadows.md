# Plan 227: The green screen keys out its own shadows

The owner's recording (2026-11-11, session `26cd75bd`): Key out background is
on with the defaults (`#00FF00`, Similarity 40, Smoothness 8, Spill removal
10), and the camera is on Fill at 100 % zoom in the canvas's bottom right. In
the camera's bottom-left and bottom-right corners, dark patches stay on the
picture. They read as the curtain behind the green screen.

## Status and scope

- **Status: IMPLEMENTED 2026-11-11** on branch
  `plan-227-green-screen-shadows` (base `origin/main` `f17babf30`, worktree
  `~/projects/videorc-wt-227`). The owner took D1–D4 as recommended
  (2026-11-11). S0–S5 are built; local verification is in the PR. Owed: the
  owner's own 30 s take with the green screen (S5).
- **Changes from the plan while building:**
  - Hide edges are whole percents (`u32`, 0–25), like the key's other
    settings, not `f64`. The field is omitted from the wire while every side
    is 0, the way `cameraLook` is omitted when neutral, so every layout and
    fixture saved before it stays byte-identical. It is optional in
    TypeScript.
  - "Reset camera settings" already resets the chroma key, so it resets Hide
    edges too (the plan said it would leave them alone).
  - The D3D11 shader's despill had also drifted: it only despilled pixels
    the key made partly see-through, scaled by how much. It now despills like
    the reference and the Metal shader.
  - `chromakey`, `despill` and `drawbox` are required by all three
    platforms' bundle policies, not only Linux. None of the key's filters was
    pinned before. The bundled macOS FFmpeg 8.1.1 has all three.
  - No WARP render test for the D3D11 keyer. Windows CI compiles the shader
    and pins the constant buffer's layout, and a test on every host pins the
    D3D11 key to the shared spec and its validation. A keyed render on WARP
    is still owed.
  - Hide edges has a "Show all edges" button while any side is set, like
    Crop's "Reset crop".
- **Evidence:** `~/videorc-test-2026-11-11-green-screen/`: before/after
  images and the offline prototype scripts (`scripts/*.py`, stdlib Python,
  run with `python3 -I`). It is the owner's camera footage, so it stays out of
  the repo.
- **Path:** the Metal compositor keyed this recording. The session log says
  "compositor: … 0 cpu, 0 cpu-fallback" and "Recording uses the protected
  compositor encoder bridge".
- The plan targets main. The cloud version (#727, never merged by agents)
  picks it up in its next merge from main.

## What the recording shows

The numbers come from the camera take
(`videorc-session-20261111-155517-26cd75bd-…-camera.mp4`) at 2 s, 10 s and
20 s. Each pixel went through the keyer's own math (`chroma_key_alpha`,
defaults). Regions are raw camera pixels, 1920×1080.

| Region                             | Mean RGB    | Chroma p10 / p50 / p90 | Angle from key | Opaque / partial today |
| ---------------------------------- | ----------- | ---------------------- | -------------- | ---------------------- |
| Bright screen, upper left          | (26,135,61) | 49 / 52 / 54           | 17°            | 0 % / 0 %              |
| Bottom-right shadow, x≥1700 y≥900  | (1,34,12)   | 11 / 15 / 23           | 17°            | **45 % / 34 %**        |
| Bottom-left shadow, x 20–260 y≥900 | (4,56,20)   | 16 / 24 / 35           | 17°            | 5 % / 19 %             |
| Far-left edge, x 0–20 y≥700        | (8,32,13)   | 1 / 15 / 20            | 14°            | **48 % / 41 %**        |
| T-shirt                            | (27,23,25)  | 1.0 / 1.6 / 1.9        | 105°           | 100 % / 0 % (correct)  |

"Chroma" is the CbCr vector length the keyer computes. The hue cone at
Similarity 40 is 24°.

### Cause 1: shadowed screen falls under a fixed saturation floor

The keyer (`scene_geometry.rs:605`) keys by the hue angle between a pixel's
CbCr vector and the key direction. Hue doesn't change with lighting. Before
that test it refuses any pixel whose chroma is at or below 14, and it only
fully keys from 20 (`CHROMA_KEY_SATURATION_FLOOR` / `_RAMP`,
`scene_geometry.rs:521`). The floor exists so greys and blacks never key. It
is an absolute number, though, and chroma shrinks with brightness. So the
screen in shadow stays opaque: `(1,23,6)`, `(0,26,9)` and `(3,22,9)` are
clearly green, 13–17° from the key and well inside the cone, but their chroma
is 9–12.

The existing "shadowed screen" pin `(30,100,40)` has a chroma of 33, so no
test ever covered a real shadow.

### Cause 2: the real curtain at the frame's edge

Below y≈850, the first 8–14 pixels of the camera frame are neutral dark grey:
`(17,19,16)`, `(6,6,6)`. That is the curtain or the screen's edge. No colour
keyer can remove a colour that isn't green. On the canvas (camera at 0.375×)
it shows as a 3–5 px dark seam down the camera's left edge.

### Why no setting fixes it today

- Similarity widens the hue cone, and the shadows are already inside it.
  Smoothness and Spill removal don't touch the floor.
- Crop is screen and window only (plan 213 G2, `freeform-memory.ts:40`). The
  camera frames itself with Zoom and Pan.
- Zoom 105 % removes the edge seam today, along with 2.4 % of every side. It
  does nothing for the shadows.
- Lighting the bottom of the screen more evenly helps; the switch's helper
  text already asks for that. The keyer should still handle a normal home
  setup.

## The fix, tried offline on this footage

### A: a saturation floor that scales with brightness (no new control)

```
Y     = (77·R + 150·G + 29·B) / 256          // color.rs:10, full-range BT.601
floor = min(14, max(5, 0.15 · Y))
ramp  = floor · 6 / 14
```

- Pixels with Y ≥ ~93 behave exactly as today. Every existing pin holds:
  pure, bright, well-lit, mid, shadowed and overexposed screen key; skin,
  dark hair, white shirt, red and grey survive; the green garment still keys;
  `(100,135,100)` is still partial (56) and `(110,130,110)` still opaque.
- Dark pixels get a floor that drops with their brightness, down to 5. The
  shadowed screen keys. Near-black subject and the neutral curtain have
  chroma under 2 and stay opaque: the t-shirt `(27,23,25)`, the mic arm
  `(6,9,6)` and `(1,4,1)`, and codec noise such as `(2,7,3)`.

Measured over the three frames:

| Frame | Partial alpha today → fixed | Bottom-right changed | Bottom-left changed | Face changed | T-shirt changed |
| ----- | --------------------------- | -------------------- | ------------------- | ------------ | --------------- |
| 2 s   | 3.6 % → 0.4 %               | 53 %                 | 21 %                | 0.1 %        | 0.0 %           |
| 10 s  | 3.0 % → 0.5 %               | 49 %                 | 20 %                | 0.9 %        | 0.0 %           |
| 20 s  | 2.7 % → 0.4 %               | 50 %                 | 7 %                 | 0.8 %        | 0.0 %           |

"Changed" means the alpha moved by more than 32 levels. No pixel became more
opaque. The face change is a one-pixel tightening where green spill mixes
into dark hair and shirt edges (`alpha-change-map.png`).

### B: hide the edges that aren't green (a matte)

A 1 % left matte removes the remaining seam. The matte makes the cut-off
edge see-through; it doesn't reframe the camera.
`before-after-bottom.png` shows three panels: today, fix A, and fix A with
the 1 % left matte.

### The FFmpeg filter-graph leg already copes

`camera_chroma_key_filter` (`recording.rs:24967`) approximates the angle
keyer with `chromakey` at a reference saturation of 55. I ran FFmpeg 8.1 with
the production default string
(`chromakey=color=0x44AB43:similarity=0.1175:blend=0.0128`) on the same
frame. Only 2.4 % of the bottom-right shadow stays opaque (11.4 % partial),
and the t-shirt and face stay 100 % opaque. The deepest tones sit in the
blend band: `(1,23,6)` is 44.8 units from the effective key, against a disc
of 42.4 plus a 4.6 blend. This plan doesn't change that mapping.

`hsvkey` was tried and rejected. Its distance includes brightness, so it
either keeps the shadows or keys the t-shirt.

## Owner decisions (2026-11-11: all four taken as recommended)

| #   | Question                                   | Decision                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Shadow fix: new keyer default or a slider? | **The keyer's default, no new control.** No setting can fix this today, so nobody would find a "Shadows" slider. Built-in defaults that work are the house rule.                                                                                                                                                      |
| D2  | How is a non-green edge hidden?            | **"Hide edges" in the Green screen section: a matte.** The hidden edge becomes see-through and the camera keeps its framing. Rejected: Crop on the camera, because it reverses 213 G2, Fill re-zooms a cropped camera and you move on the canvas. Also rejected: only pointing at Zoom 105 %, which costs every side. |
| D3  | What shape does Hide edges take?           | **Four % fields (Left, Top, Right, Bottom, 0–25 %)**, like the screen's Crop fields, shown while Key out background is on. One slider for all sides would also cut the sides that are fine.                                                                                                                           |
| D4  | What are the matte's coordinates?          | **Fractions of the camera's full frame, as you see it.** With Mirror on, Left still means the left you see. The curtain doesn't move when you change Zoom or Pan, so the matte doesn't either.                                                                                                                        |

## What exists on main (`f17babf30`)

| Current main                                                                                                                                                                                                                                                                                                                  | What this plan does with it                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `scene_geometry::chroma_key_alpha` (`scene_geometry.rs:605`) is the f64 reference; the CPU compositor calls it directly (`compositor.rs:12875`, `:13103`). Floor and ramp are `CHROMA_KEY_SATURATION_FLOOR = 14` and `_RAMP = 6` (`:521`).                                                                                    | A luma-relative floor, one helper shared by the alpha function and its mirrors.                         |
| The Metal fragment shader (`metal_compositor.rs:137–170`) mirrors the keyer in f32. The floor arrives in `chroma_key2.w`, the ramp `6.0` is hard-coded, and `metal_compositor.rs:223` mirrors both constants.                                                                                                                 | Mirror the new floor the same way.                                                                      |
| The D3D11 HLSL `chromaKeyAlpha` (`windows_d3d11_shaders.hlsl:166`) has already drifted: a hard floor with no ramp, and `smoothstep` on the angle where CPU and Metal ramp linearly. `windows_d3d11_session.rs:3462`, `:3665` pass the floor as `14/255`. No Windows test covers the keyer.                                    | Same model as the reference, plus a test.                                                               |
| The FFmpeg leg (`recording.rs:24967`) uses `chromakey` + `despill` at the camera's native resolution, before crop and scale. Neither filter is in `REQUIRED_LINUX_FFMPEG_FILTERS` (`scripts/lib/ffmpeg-linux-pin.mjs:23`).                                                                                                    | Unchanged keyer. The matte adds `drawbox`, and the pin list gains `chromakey`, `despill` and `drawbox`. |
| `LayoutSettings` key fields (`protocol.rs:542–561`), TS type (`backend.ts:787`), strict contract (`backend-rpc-contract.ts:1734`), storage defaults (`storage.rs:12519`, `:12873`).                                                                                                                                           | One new field for the matte, in all four places and in `protocol-fixtures/high-risk-contracts.json`.    |
| Green screen section (`layout-tab.tsx:1669–1745`): switch, Key color, Similarity, Smoothness, Spill removal. The screen's Crop fields are in `source-transform-fields.tsx:230`.                                                                                                                                               | "Hide edges" goes under Spill removal.                                                                  |
| Tests: `chroma_key_keys_a_realistic_screen_palette_with_defaults`, `chroma_key_alpha_ramps_by_angle_and_saturation` (`scene_geometry.rs:1496`, `:1533`), `cpu_and_metal_chroma_keyers_agree_on_the_same_fixture_or_skips` (`compositor.rs:15501`), `ffmpeg_chroma_mapping_keys_the_realistic_palette` (`recording.rs:42326`). | All stay. The new pins use the footage's real tones.                                                    |

## Slices

Each slice is one commit. S0–S3 are backend, S4 is UI, S5 is the gates.

**Routing (CLAUDE.md):**

- S0–S3: Implementation route, fit 9 (recording output across CPU, Metal,
  D3D11 and FFmpeg), so `fable-5.1`.
- S4: UI/Product Design route, scoped UI, so `opus-5.5`, with
  `.claude/skills/videorc-design/SKILL.md`.
- Follow AGENTS.md's one-backend-build-at-a-time rule.

### S0: Pin the real footage (red first)

- In `scene_geometry.rs` tests, add `chroma_key_keys_a_deep_shadowed_screen`.
  These must key (0): `(1,23,6)`, `(0,26,9)`, `(3,22,9)`, `(1,25,6)`,
  `(1,34,12)`, `(8,32,13)`.
- Add `chroma_key_keeps_near_black_subjects`. These must stay (255):
  `(27,23,25)`, `(6,9,6)`, `(1,4,1)`, `(2,7,3)`, `(10,18,12)`, `(17,19,16)`,
  `(6,6,6)`.
- In `ffmpeg_chroma_mapping_keys_the_realistic_palette`, add `(1,34,12)` and
  `(4,56,20)` as inside the disc. Pin `(1,23,6)` and `(0,26,9)` as in the
  blend band, with a comment naming the bounded divergence.
- **Done when:** on main, only the new deep-shadow test fails. The
  near-black test, every existing chroma test and the FFmpeg pin pass.

### S1: A luma-relative floor in the reference keyer and the Metal shader

- `scene_geometry.rs`: replace the two constants with
  `CHROMA_KEY_SATURATION_FLOOR_MAX = 14.0`, `_MIN = 5.0`, `_PER_LUMA = 0.15`
  and the ramp ratio `6/14`. Add one
  `pub fn chroma_key_saturation_floor(luma: f64) -> (f64, f64)` that
  `chroma_key_alpha` uses. Rewrite the doc comment (`:490–522`): the floor
  now scales with brightness, which is why it is lighting-invariant like the
  angle.
- Metal shader: compute Y with the same coefficients and the same min/max
  formula. Mirror the constants the way `:223` mirrors them today. Update the
  shader comment (`:137–141`).
- Extend `cpu_and_metal_chroma_keyers_agree…` with `(1,23,6)`, `(0,26,9)`,
  `(27,23,25)` and `(6,9,6)`.
- **Done when:** S0 is green. Every existing chroma test passes unchanged.
  The CPU/Metal parity test and the `metal_compositor` chroma tests
  (`chroma_key_quad_keys_green…`, `…spill_clamps…`, `…circle_mask…`) pass on
  this Mac.

### S2: The Windows keyer on the same model

- In `chromaKeyAlpha` (`windows_d3d11_shaders.hlsl:166`), use the luma floor
  with its ramp, and the linear angle ramp instead of `smoothstep`.
  `WindowsD3d11ChromaKey` carries what the shader needs (`:344`, validation
  at `:795–810`).
- Add a test pinning the D3D11 constants to the reference constants. Add a
  keyed-layer render test gated like the other D3D11 GPU tests, with the S0
  tones.
- **Done when:** Windows CI is green (shader compile plus the new tests).

### S3: Hide edges, the matte (backend and contract)

- Add `LayoutSettings.camera_chroma_key_edges: CameraKeyEdges { left_pct,
top_pct, right_pct, bottom_pct }` as f64 0–25 with `#[serde(default)]`.
  Use no `Option` (the serde null trap). Add it to `backend.ts`, the strict
  contract, storage defaults and the high-risk fixture (the strict-contract
  trap).
- `ChromaKeySpec` gains the kept box in source-frame fractions, with Mirror
  resolved so Left is the left the streamer sees. It applies only while the
  key is on.
- Alpha is 0 outside the box in every path:
  - CPU: the `chroma_key_alpha` callers, from the source pixel's coordinates.
  - Metal: a source-UV test.
  - D3D11: the same test in HLSL.
  - FFmpeg leg: one `drawbox=…:color=black@0:t=fill:replace=1` per non-zero
    side, right after `chromakey`.
- Add `chromakey`, `despill` and `drawbox` to the Linux FFmpeg pin list.
- **Done when:**
  - A 4×4 fixture with a 25 % left matte keys the left column and leaves the
    rest as it was; Mirror swaps the sides; it passes on CPU and Metal.
  - The FFmpeg filter string is pinned.
  - `backend-rpc-contract` tests accept the field and refuse values out of
    range.
  - A layout saved before this plan loads with no matte.

### S4: Hide edges in the Green screen section

- Under Spill removal, add "Hide edges": four % inputs (Left, Top, Right,
  Bottom). Follow the Crop fields' pattern; don't reuse the component, which
  is tied to `SceneSource`. Proposed helper text: "For anything at the edge
  that isn't green screen, like a curtain or a light stand."
- Show it only while Key out background is on. Build it from shadcn
  components only.
- "Reset camera settings" (`camera-reset-button.tsx`) resets the chroma
  key, so it resets Hide edges with it.
- **Done when:** a renderer test covers the patch. Typecheck, lint and format
  pass. A by-eye check at the narrow inspector width passes in **light and
  dark**.

### S5: Verify end to end

- `cargo fmt --check --all`; targeted `cargo test -p videorc-backend chroma`
  plus the S3 matte tests; `cargo clippy -p videorc-backend -- -D warnings`.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm --filter @videorc/desktop test`.
- `pnpm smoke:recording-studio`, because this touches layout composition and
  recording output. No smoke drives a keyed camera, and the dev app has no
  camera grant (AGENTS.md).
- **Owed, the owner with the real green screen:** 30 s recorded on the built
  branch.
  - The bottom corners are clean in the Preview and the file.
  - Hide edges Left 1 % removes the seam.
  - Hair and beard edges are not eaten.
  - The corners don't flicker in motion.
  - Re-run `scripts/key_proto.py` on the new camera take for the numbers.

## Risks

- **Hair edges:** dark hair and shirt edges tighten by about a pixel. If the
  by-eye pass says hair looks eaten, raise `_PER_LUMA` from 0.15 to 0.2
  before anything else.
- **Flicker in deep shadow:** at chroma ≈10, codec noise of ±1.5 units moves
  the angle by about ±8°. The shadows sit 7–11° inside the cone. The stills
  show partial alpha falling from 3 % to 0.4 %, but only motion proves it
  (smoothness is judged by eye).
- **Dark green clothing:** it keys a little further into its shadows. A green
  garment already keys today; that physics is documented in the palette test.
- **Footage noise:** the footage is the re-encoded ISO take, slightly noisier
  than live camera frames. Live frames should key at least as well.

## Not in this plan

- Matte cleanup (clip black/white, choke).
- Dragging Hide edges on the stage.
- A key-colour eyedropper.
- Per-scene key settings.
- Light wrap.
- Making the FFmpeg leg fully key its deepest tones.
