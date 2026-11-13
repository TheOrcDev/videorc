# Plan 233: The green screen without snow on the edges

The owner's stream on 0.22.1 (2026-11-12, session `24b955d6`, stream only,
17:04–18:00 local) already had plan 229's neighbourhood key. Key out
background was on with the defaults (`#00FF00`, Similarity 40, Smoothness 8,
Spill removal 10, no Hide edges), and the camera was Large in the bottom right
on Fill. "Snow" still shows: green dots along the edges of the head, the ears,
the hair and the shoulders, in a new place every frame. The open screen
around the subject is clean now. Source: the Twitch VOD
`~/Downloads/2926793672-1298584691-00684c04-8ea6-4658-94cf-dfbde52ce5e4.mp4`
(56 min, 1920×1080, 30 fps).

## Status and scope

- **Status: EXECUTING 2026-11-13** on branch `plan-233-green-screen-edges`
  (base `origin/main` `ed0cc2b10`, worktree `~/projects/videorc-wt-233`).
  The owner said "start" without picking, so the recommended options are
  taken: D1 a (despill near the edge), D2 a (one tap), D3 a (keyed camera
  only), D4 a (macOS first: S0–S3 and S5 in this PR, S4 D3D11 in a second
  PR). The owner can still change any of them; D2 can switch after the take.
- **Evidence:** `~/videorc-test-2026-11-13-green-edges/`: VOD frames and
  crops, the edge measurement, the simulation and its outputs
  (`out/edge_snow_shipped_vs_fix.mp4`, `out/final/*.txt`), and the scripts in
  `scripts/` (Python with numpy:
  `uv run -q --no-project --with numpy python -I scripts/<name>.py`). It is
  the owner's footage, so it stays out of the repo.
- **Path:** the Metal compositor keyed this stream (backend log: "Metal GPU
  compositor enabled"; the camera is a zero-copy BGRA import).
- The plan targets main. The cloud version (#727, never merged by agents)
  picks it up in its next merge from main.

## What the stream shows

Nineteen consecutive frames at 30:00 (17:34 local), inside the 720×405 camera
slot. A pixel counts as green when `g − max(r, b) > 8` and `g > 18`. The
background behind the camera that hour is a dark UI and grey chrome, so
nothing green belongs there (`scripts/vod_specks.py`).

| Measure                                        | Per frame |
| ---------------------------------------------- | --------- |
| Green pixels in the slot                       | 38–70     |
| Of those, within 3 px of the subject's outline | 93–100 %  |
| Also green in the previous frame               | 2–28 %    |
| Positions green in at least half of the frames | 0 of 803  |

- Every speck sits on the outline and moves every frame. The edge is crawling.
  It is not a fringe that stays, and it is not the open screen (plan 229
  holds there).
- The outline is hard and stair-stepped: no pixel along it is partly
  see-through.

## Why

- **The camera is 4K now.** Since 2026-11-11 14:57 the camera has run at
  3840×2160 at 25 fps. The backend log says "Camera capture format selected:
  3840x2160@25.00 (requested 1920x1080@30)"; before that it was 1920×1080 at 30. Large on a 1080p canvas is 720×405 (`scene_geometry::camera_box_size`,
  480 × 1.5), so every output pixel covers 5.3 × 5.3 camera texels. In the
  Preview (1280×720, a 480-wide slot) each pixel covers 8 × 8.
- **The key runs once per output pixel, on a shrunken picture it never
  averages.** `f_main` in `metal_compositor.rs` (from line 146) reads the
  colour with ONE bilinear tap: 2×2 texels, under half an output pixel. The
  key judges nine taps at ±1.2 texels, about 0.8 of an output pixel. The
  sampler (`build_preview_sampler`, line 2798) is linear with no mip filter,
  and the camera texture has one level. Two things follow:
  1. Each output pixel sees about 4 of the 28 texels under it. Which 4 changes
     with every sub-texel movement and every frame of camera noise. The key is
     hard (Smoothness 8 is a 4.8° band). So along the outline a pixel flips
     between kept and keyed out from frame to frame: the crawl.
  2. The colour and the key look at different footprints. On the outline, the
     key's neighbourhood takes in some of the subject and keeps the pixel,
     while the colour tap lands on the screen: an opaque green pixel. Spill
     removal 10 takes only 10 % of the green off it. That is the green snow.
- **Plan 229 could not see it.** Its simulation keyed the camera take at the
  take's own 1920×1080 and never shrank it into the slot. Its 5×5 judge fixed
  the specks in the open screen, and that stays.
- **The other paths:** the CPU blits and the D3D11 shader key per output pixel
  in the same way. The FFmpeg leg already keys at camera resolution and scales
  after: `chromakey` comes before `crop` and `fit` in the camera chain
  (`recording.rs`, line 24997).
- **A mip chain on the camera alone does NOT fix it.** Keying the shrunken
  colour (model F3 below) leaves more green on a sharp edge than today. The
  key has to judge the camera's own texels, and the shrink has to run on the
  keyed result.

## Simulation

`scripts/decimate_sim.py` puts a 4K picture through each model, into the
720×405 slot, with the owner's settings, over dark grey. Each of 12 frames
moves the picture by a random 0–2 texels and adds camera noise: σ 1.5 luma per
texel and σ 1.5 chroma per 2×2 block. There are two inputs:

- A frame of the 2026-11-11 camera take (1080p) upscaled to 4K. It carries
  real green spill on the hair and ears, but its colour edges are wider than a
  real 4K camera's.
- A synthetic 4K frame with sharp edges and no spill (`synth_subject.py`).

"Outline" means within 2 px of the true outline. "Detail" is the mean
gradient inside the subject on a noise-free run. Exact area averaging (6.68)
is the honest reference; anything above it is aliasing.

| Model | What it does                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------ |
| S1    | Shipped 0.22.1                                                                                                     |
| S1a   | Shipped, plus strong despill near the key colour                                                                   |
| F3    | Shrink the camera first (mips), then key                                                                           |
| F1    | Key every camera texel, then exact area average                                                                    |
| F1e   | F1 plus despill near the edge                                                                                      |
| F2ne  | Key every texel, despill near the edge, shrink by powers of two to the level just above the slot, one bilinear tap |
| F2qe  | F2ne with four taps over the pixel's footprint                                                                     |
| F2a   | Key every texel, despill near the key colour everywhere, trilinear mips                                            |

Real footage (`out/final/real_noisy.txt`, `real_clean.txt`):

| Model                       | Green on outline / frame | New green / frame | Alpha flips / frame |   Detail | Green off the outline |
| --------------------------- | -----------------------: | ----------------: | ------------------: | -------: | --------------------: |
| S1 shipped                  |                      942 |               422 |                 755 |     7.77 |                   383 |
| S1a shipped + despill       |                      137 |                50 |                 755 |     7.77 |                   199 |
| F3 shrink, then key         |                      401 |                87 |                 128 |     6.68 |                   251 |
| F1 key, area                |                      588 |               177 |                  60 |     6.68 |                   265 |
| F1e key, area, edge despill |                      133 |                14 |                  60 |     6.68 |                   251 |
| **F2ne (recommended)**      |                  **129** |            **12** |              **30** | **6.31** |               **251** |
| F2qe four taps              |                      124 |                 9 |                   5 |     5.99 |                   252 |
| F2a despill everywhere      |                       53 |                 4 |                   3 |     5.70 |                   168 |

"Alpha flips" counts outline pixels whose alpha changes by more than 0.5
between frames. "Green off the outline" is mostly the teal shirt logo and the
mic's light ring, which are the subject's own colours.

Synthetic sharp edges, no spill: the crawl alone (`out/final/synth.txt`):

| Model      | Green on outline / frame | New green / frame | Alpha flips / frame |
| ---------- | -----------------------: | ----------------: | ------------------: |
| S1 shipped |                     33.6 |              24.4 |                 120 |
| S1a        |                      2.5 |               1.9 |                 120 |
| F3         |                     61.1 |              31.9 |                 110 |
| F1, F1e    |                        0 |                 0 |                 0.1 |
| F2ne, F2qe |                        0 |                 0 |                   0 |

What the tables say:

- Despill alone (S1a) turns the specks grey, but the edge crawls just as much
  (755 flips).
- Keying the camera's own texels and shrinking the keyed result ends the
  crawl. F2ne cuts flips by 96 % and new green per frame by 97 %.
- What stays green on the outline with F1/F2 is spill: green light on the
  hair and ears. Despill near the edge takes it from 470–590 to about 130 and
  leaves the logo and the mic ring alone (251). Despill near the key colour
  everywhere (F2a) gets it to 53, but greys the logo (168).
- Shipped looks sharper (7.77) because its shrink aliases. F2ne is 6 % under
  exact area, F2qe 10 %, and trilinear 15 %.

## The fix

Key at the camera's own resolution, then shrink.

1. **Reference (`scene_geometry`).**
   - `chroma_key_reduction_level(camera_px, drawn_px)` is
     floor(log2(camera px per drawn px)), the smaller axis, never below 0.
   - The keyed picture works per camera texel: plan 229's judge (the exact
     5×5 binomial at texel spacing), then the angle, floor and ramp, Hide
     edges, despill (D1) and the camera look. It is premultiplied by alpha.
   - The picture is reduced by averaging each 2^L × 2^L block, premultiplied.
     It is drawn with one bilinear tap per output pixel, which leaves at most
     a 2× shrink. It is un-premultiplied for the existing straight-alpha
     blend.
   - At L = 0 (a camera that is not shrunk), every texel's alpha and colour
     are what they are today.
2. **Metal (`metal_compositor.rs`).**
   - Add a key pass before the scene's render pass, in the same command
     buffer. For each keyed camera source, it renders (or computes) the keyed
     picture at level L into a cached RGBA texture. One texel is 2^L × 2^L
     keyed camera texels, so there is no full-size keyed texture and no mip
     generation.
   - The camera quad then draws that texture through the plan 190 route
     (`GpuSource.texture`). The key branch leaves `f_main`.
   - Cache by the camera frame's content key, the spec and L. The camera runs
     at 25 fps under a 30 fps canvas, and the preview and program compositors
     each key on their own.
   - Crop, mirror, circle and rounded masks stay in the draw. The crop's
     half-texel clamp uses the keyed texture's texel.
   - RGBA8 premultiplied loses colour at very low alpha. Use RGBA16Float if
     the CPU parity test shows banding on the outline (a 960×540 RGBA16F
     texture is 4 MB).
3. **CPU blits (`compositor.rs`).** Use the same order. `KeyJudgedPlane`
   (line 13203) already judges every texel; add the premultiplied keyed
   plane, the 2^L box and the bilinear draw (`blit_linear_rgba_to_yuv420p`,
   line 13361). This path is the oracle for the Metal and D3D11 tests.
4. **D3D11 (`windows_d3d11_shaders.hlsl`, `windows_d3d11_compositor.rs`).**
   The same key pass and draw (D4).
5. **Edge despill (D1, recommended a).** Despill strength is the larger of
   Spill removal and (nearness to the key colour × nearness to keyed-out
   texels). Nearness to the key colour fades over 30° past the cone. Nearness
   to the keyed-out area reaches about 2 output pixels. Spill removal stays the
   floor everywhere.
6. **FFmpeg leg:** unchanged.

## Decisions for the owner

- **D1: Green light on the hair and ears, once the snow is gone.**
  - a. (Recommended) Remove it only near the edge: strong despill within about
    2 px of the keyed-out area. Green on the outline goes from 588 to 133, and
    the teal logo and the mic ring keep their colour.
  - b. Remove it from anything close to the key colour, anywhere. This gives 53
    and the cleanest edge, but green and teal things on you (the shirt logo,
    the mic ring) turn grey-blue.
  - c. Leave Spill removal as set. The snow is gone, but a thin, steady green
    rim stays on the hair and ears.
- **D2: The shrink filter, sharp or calm.**
  - a. (Recommended) One tap on the nearest level: 6 % softer than the ideal,
    30 edge flips a frame (from 755).
  - b. Four taps: 10 % softer, 5 flips. It can switch after your take.
- **D3: The camera without the key.** Today it goes through the same 5.3×
  shrink, so fine hair and beard can shimmer.
  - a. (Recommended) Not in this plan. Only the keyed camera changes, with a
    follow-up if you want it for every camera.
  - b. Yes, every shrunken camera.
- **D4: Windows.**
  - a. (Recommended) macOS (Metal and the CPU reference) in the first PR,
    D3D11 in a second PR of this plan. Windows CI only compiles the shader, and
    a keyed WARP render test is still owed from plan 227.
  - b. All paths in one PR.

## Slices

- **S0: Oracle test.** Changes `scene_geometry.rs` and the `compositor.rs`
  tests.
  - Add a seeded synthetic camera frame: the `synth_subject.py` shape (skin
    head, hair cap, black shirt on screen green, σ 1.2 lens blur, 4:2:2
    chroma, seeded noise, sub-texel shift), 3840×2160 into the 720×405 Large
    slot.
  - Metrics: green on the outline, alpha flips between two shifted frames, and
    detail against an exact area reference.
  - Done when the test runs on today's CPU blit and fails the new thresholds:
    green on the outline ≤ 10 % of today's, flips ≤ 10 %, detail ≥ 90 % of
    area. Every existing keyer pin still passes.
- **S1: Reference and CPU blits.** Add the reduction level, the keyed plane,
  the box and the draw.
  - Done when S0 passes on the CPU path, and 1:1 keyed draws are unchanged
    (the existing tests). Targeted `cargo test -p videorc-backend` keyer
    filters and clippy are green.
- **S2: Metal key pass and draw.**
  - Done when:
    - A headless Metal test composes the S0 frame and matches the CPU oracle
      within the tolerance the existing Metal/CPU keyer tests use.
    - S0's thresholds hold on Metal, the existing Metal keyer tests pass, and
      `f_main` has no key branch.
    - The compositor's render p95 ("Preview program leg cost") rises by no more
      than 1.5 ms with a 4K keyed camera (measured with a synthetic 4K
      source).
- **S3: Edge despill (D1).**
  - Done when:
    - A green-tinted subject texel next to keyed-out texels loses its green.
    - The same colour 20 texels inside the subject keeps it (only the Spill
      removal floor applies).
    - The teal logo's colour is unchanged.
- **S4: D3D11 (D4).**
  - Done when:
    - The shader compiles on Windows CI and the constant buffer pins are
      updated.
    - The D3D11 key spec is pinned to the reference.
    - Every new `windows_d3d11_*` test is listed in
      `scripts/lib/windows-d3d11-media.mjs`.
- **S5: Gates and the owner's take.**
  - Gates: `cargo fmt --check --all`,
    `cargo clippy -p videorc-backend -- -D warnings`, targeted
    `cargo test -p videorc-backend` (compositor, metal_compositor,
    scene_geometry keyer), `pnpm typecheck`, `pnpm smoke:recording-studio`,
    one record + stream run (the aux compositor leg keys too), and
    `pnpm build`.
  - The owner's take: 2 minutes of record + stream with the green screen and
    the camera Large in the bottom right. Run `scripts/vod_specks.py` on the
    file. Today it finds 38–70 green pixels a frame on the outline; the target
    is under 5, with no edge crawl by eye in the Preview.
  - The dev app has no camera grant, so S0's synthetic frame is the automated
    check and the owner's take is the real one.

## Also seen, not in this plan

- At 4K the camera offers only 25 fps (advertised range 25–25), under the
  30 fps canvas, so one frame in six repeats. The capture-health warnings at
  17:37–17:43 local come from that, not from the key. A 1080p30 (or 50 fps)
  mode on the camera would avoid it.
- The FFmpeg leg scales the keyed camera with straight alpha. If a keyed
  FFmpeg-leg output shows a green rim, premultiply before `scale`. This stream
  ran on Metal, so it does not show that.

## Handoff

- **Owner route:** Implementation of a recording and compositor change; the
  diagnosis is done here. Fit 9: a GPU change across several paths, after an
  earlier attempt fell short. Model lane: `fable-5.1`.
- **Start** with the recommended D1–D4 (taken 2026-11-13). Read `AGENTS.md`,
  plans 227 and 229, and this plan.
- **Worktree:** `~/projects/videorc-wt-233`, branch
  `plan-233-green-screen-edges`.
- **Out of scope:** the settings UI, the FFmpeg leg, the camera format, and
  the camera without the key (unless D3 b).
- **Rules:** the footage stays out of the repo. Never run the bare backend
  binary without a temporary profile.
