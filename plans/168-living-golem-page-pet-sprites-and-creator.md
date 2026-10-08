# Plan 168: The living Golem: page-pet sprite atlases on stream, and a creator for everyone's own

> **Executor instructions**: Follow this plan one phase at a time. Each phase
> is a PR. Run every verification command in the phase and confirm the
> expected result before moving on. If anything in "STOP conditions" occurs,
> stop and report. Do not improvise on wire shapes, motion numbers or copy;
> owner-overridable decisions are marked ⚑. When a phase is merged, update
> this plan's entry in `plans/README.md` and the phase table below.
>
> **Built on the plan 164 branch, in PR #647 / #75** (owner call 2026-10-08). Every
> line reference below is from the plan 164 branch `plan-164-golem-b` at
> `3ccc0888` unless it says origin/main. **Drift check (run first, per
> phase)**, after #647 has merged:
> `git fetch origin main && git diff --stat <#647 merge sha>..origin/main -- crates/videorc-backend/src/golem_overlay.rs crates/videorc-backend/src/compositor.rs crates/videorc-backend/src/metal_compositor.rs crates/videorc-backend/src/windows_d3d11_session.rs crates/videorc-backend/src/windows_d3d11_compositor.rs crates/videorc-backend/src/windows_d3d11_shaders.hlsl crates/videorc-backend/src/overlay_layout.rs crates/videorc-backend/src/captions.rs crates/videorc-backend/src/cohost.rs apps/desktop/src/renderer/src/lib/golem-overlay.ts apps/desktop/src/shared/golem-assets.ts apps/desktop/src/main/golem-assets.ts`
> If `publish_compositor_frame`, `GpuSource`, `ensure_source_texture`,
> `SceneVs` or `overlay_blit_layout` moved, re-read "What exists today"
> against the live code before Phase B or C.

## Status

- **Priority**: P2 (product feature, owner request 2026-10-08)
- **Effort**: XL, 8 phases (0 and A to G), one PR each (web work in
  Phase E is its own videorc-web PR)
- **Risk**: 0 LOW (spacing only), A LOW, B HIGH (three render paths, sampler and texture cache
  changes on the recording path), C MEDIUM (first character animation on
  air, first animation clock in the D3D11 pump), D LOW, E MEDIUM (cost
  and quota), F MEDIUM (image algorithms), G LOW
- **Depends on**: plan 164 (Golem: persona, overlay item, bubble,
  utterances, auto chat). **Owner call 2026-10-08: built on the plan 164
  branch and shipped in the same PRs** (desktop #647 on `plan-164-golem-b`,
  web #75 on `plan-164-golem-web`).
- **Category**: feature
- **Planned at**: desktop origin/main `cadb02f3`, plan 164 branch
  `3ccc0888`, web `plan-164-golem-web` `1ecf0fb9`, page-pet
  `gvastethecreator/page-pet-skill` `0b6a0ef`, 2026-10-08
- **Route**: Orchestrator → Implementation per phase. 0 fit 8 `opus-4.8`
  (UI polish). A fit 8 `gpt-5.5`.
  B fit 9 `fable-5` (compositor, three paths). C fit 9 `fable-5`
  (animator, on-air motion). D fit 8 `opus-4.8` (UI, taste). E fit 9
  `fable-5` (prompts decide art quality and cost). F fit 9 `fable-5`
  (builder port) with the wizard UI on `opus-4.8`. G owner + orchestrator.
  Every UI slice follows `.claude/skills/videorc-design/SKILL.md`.

| Phase                                                        | PR   | Status  |
| ------------------------------------------------------------ | ---- | ------- |
| 0: Golem settings spacing (ships first)                      | none | PLANNED |
| A: Pet pack format, storage, import, still packs             | none | PLANNED |
| B: Sprite layer in CPU, Metal and D3D11                      | none | PLANNED |
| C: The animator: gaze, reactions, talk, blink, sleep, motion | none | PLANNED |
| D: Living preview and settings in the app                    | none | PLANNED |
| E: Web: pet build sessions, sheet generation, allowance      | none | PLANNED |
| F: The creator: Rust builder and the wizard                  | none | PLANNED |
| G: Our default Golem made with the creator                   | none | PLANNED |

## The owner's ask (2026-10-08)

"Use [page-pet](https://gvastethecreator.github.io/page-pet-skill/) to
make our sidekick alive. Do it for our Golem, and people should be able to
create their own sidekick / Golem with this."

Owner answers to the planning questions (2026-10-08):

1. **Default Golem art**: made with our own in-app creator once web PR #75
   is deployed with an image model. The owner reviews the frames before it
   ships.
2. **Who creates**: Premium, with a monthly allowance (for example three
   new pets a month plus single-row redos). Importing a ready-made pack is
   free. The still-image Golem stays free.
3. **Gaze on stream**: viewer plus events. Looks at the viewer by default,
   glances at the highlight card, idle glances, sleeps on long silence.
4. **The page-pet collection**: import only. Users can import any page-pet
   pack they made or downloaded. We bundle only our own Golem.

## What page-pet is (facts, repo `0b6a0ef`)

- MIT licence, copyright 2026 Cristian (`LICENSE`). Its runtime vendors
  **GSAP 3.15.0 under the GSAP Standard No Charge License, not MIT**
  (`runtime/vendor/gsap/NOTICE.md`). We do not ship GSAP (D6).
- A pet is one folder: `manifest.json` (v1) plus one lossless
  `mascot.webp` atlas, 3200 × 5120, 640 px square cells. Rows 0 to 4 are
  25 complete-character **gaze** cells, a 5 × 5 yaw/pitch grid with gaze
  coordinates in {-1, -0.5, 0, 0.5, 1}², negative x = viewer's left,
  negative y = up. Rows 5 to 7 hold 12 **reaction** cells: `laugh`,
  `surprised`, `wink`, `kiss`, `blink`, `sleep`, `worried`, `annoyed`,
  `proud`, `confused`, `excited`, `calm`. Every cell is the whole
  character; head turns are drawn, not synthesized.
- Manifest v1 rules (`runtime/manifest.js`): `version: 1`, non-empty
  `name`, `frames[]` each `{id, kind: 'gaze'|'reaction', sheet, rect:
[x,y,w,h], gaze?: [x,y]}`; ids unique; rects square, integer, non-empty,
  inside their sheet; sheet names match `^[a-zA-Z0-9_-]+\.(png|webp|avif)$`
  (no paths, no URLs); gaze points inside [-1,1]² and unique; `neutral`
  names a gaze frame; optional `pivot` normalized `[x,y]` (Moklo uses
  `[0.5, 0.9]`). A historical `layers` object (two-layer head/body packs)
  still loads in their runtime; complete-character packs have none.
  Import guards: 32 MB per file, 128 MB total, opaque backgrounds rejected.
- Runtime behaviour (`runtime/page-pet.js`): a 160 ms tick; nearest gaze
  cell to the pointer with a 16 px dead zone and radius
  `max(120, 1.3 × size)`; blink every 3.5 to 6 s only while on the neutral
  cell, 160 ms; `sleep` after 14 s without activity; click reactions cycle
  through reactions except blink and sleep, 250 ms cooldown; reactions hold
  1100 ms or the motion envelope, whichever is longer.
- Motion (`runtime/motion.js`): one transform owner with channels
  `x, y, angle, skew, squash`; a spring (stiffness `300 − weight × 210`,
  damping `2√k × (0.3 + damping × 0.8)`, 120 Hz substeps); reaction
  envelopes in three tween segments (0.11 s `power2.out` crouch, 0.19 s
  `power2.out` to the pose, then `elastic.out(1, 0.55 − bounce × 0.25)`
  back to rest, plus a laugh shake) with a per-reaction pose table
  `[y, angle, squash]`, e.g. `surprised: [-17, -3, -0.10]`,
  `laugh: [-9, 3, 0.065]`, `excited: [-20, 4, -0.11]`; clamps ±20 px x,
  ±26 px y, ±10° rotation, ±7° skew, squash ±0.18 with area preserved
  (`scaleY = 1 / scaleX`). Tuned at a 180 px display size.
- Creation (`SKILL.md`, `references/generation.md`, `alignment.md`): one
  locked neutral reference; an identity-side map of asymmetric features;
  a pilot (neutral, left, right, one reaction) before expanding; then
  **five 5 × 1 gaze strips** (one per pitch row, each a profile → profile
  yaw sweep) and **two 3 × 2 reaction sheets**, each a separate image
  generation with the reference; cells are cut on real alpha gutters
  (`prepare_layout.py`: column profile of alpha > 16, a zero-alpha run
  near each ideal boundary, no equal-width fallback), overlapping
  silhouettes are separated by connected components (`isolate_strip.py`),
  each cell is registered on a foot anchor (alpha-weighted centre of the
  82 to 96 % lower band plus the bottom), scaled per sheet (gaze:
  `neutral-height`; reactions: `full-height` within 0.75 to 1.55), packed
  at `--occupancy` 0.65 with an 8 px minimum margin, root drift ≤ 1.5 px x
  and ≤ 1 px bottom, and written as one lossless WebP. Publication needs a
  human visual review of every direction; their docs say counts and hashes
  never approve art.
- It has no "talk" frames and no on-stream use: it is a web page
  companion that follows a visitor's mouse.

## What exists today in Videorc (plan 164 branch `3ccc0888`)

- **The Golem overlay** is a renderer-rasterized PNG per target: avatar
  (state image, square box `floor(rect.w × canvasWidth)`, contained,
  bottom-aligned) plus the comic bubble above it
  (`apps/desktop/src/renderer/src/lib/golem-overlay.ts` 59-82, 170-255,
  323-448). It is pushed only when persona, image, state, bubble, style or
  targets change (`use-studio.tsx` 4257-4335) through `golem.overlay.set`
  into `AppState.golem_overlay` (`golem_overlay.rs` 366-396,
  `captions.rs` `CaptionOverlaySlots` 2458-2484). It is decoded once per
  push, synchronously on the async task (`main.rs` 9419-9435; the
  highlight card uses `spawn_blocking`, `comment_highlight.rs` 361-380).
  The slot keeps RGBA and BGRA copies (`captions.rs` 2418-2426) and caps
  4096 × 2048, 4 MB (2350-2352).
- **Render paths blit overlays 1:1**: `overlay_blit_layout`
  (`overlay_layout.rs` 353-385). CPU `composite_caption_overlay`
  (`compositor.rs` 8694-8774): axis-aligned, unscaled, straight alpha
  into YUV420p. Scaled sources (`blit_rgba_to_yuv420p` 8776-8932) sample
  nearest and threshold alpha. **No rotation anywhere.**
- **Metal**: `GpuSource {dest, crop, blend, content_key, …}`
  (`metal_compositor.rs` 221-269); `crop` is a real source rect
  (121-124); quads are built on the CPU per frame by `quad_vertices(dest)`
  (2431-2445, vertex shader passes positions through 71-77), so a rotated
  quad is a CPU-side change. The texture cache is **per source index**
  (`source_textures.truncate` 1236, `ensure_source_texture` 1501-1653):
  a layer whose index shifts re-uploads. **Recording and stream
  compositors sample NEAREST** (2303-2308, chosen at `compositor.rs`
  4997-5003); no mipmaps (2147-2163); straight-alpha blend (2292-2296); no
  per-layer opacity. Namespaces: 1 images, 2 captions, 3 highlight,
  4 camera storage, 5 screen, 6 editor chrome, and **the Golem also uses
  4** (`compositor.rs` 6390-6399, 6475-6484, 6740-6749).
- **D3D11**: overlay geometry `windows_d3d11_overlay_layer_geometry`
  (`windows_d3d11_session.rs` 27-69), Golem source ids 14/15 at z 11
  (604-615), uploads keyed by source id and revision
  (`windows_d3d11_compositor.rs` `resolve_upload` 1436-1499), linear
  sampler (2151-2162), layers carry `source_uv` sub-rects and an opacity
  (344-414). `SceneVs` (`windows_d3d11_shaders.hlsl` 51-63) is
  axis-aligned; `normalized_rect_to_pixels` (711-741) squashes a layer at
  the canvas edge instead of clipping it. Leg flags are fixed at session
  start (`recording.rs` 3839-3850). **The pump has no animation clock
  today**; its deterministic clock is `tick.output_sequence / fps`
  (`windows_d3d11_session.rs` 482-545, 1995).
- **The one existing on-air animation** is the scene transition
  (`compositor.rs` 1307-1459) with `ease_in_out_cubic` and the documented
  **"no overshoot, nothing bounces" rule for on-air motion** (1317-1318,
  test 7232). The frame clock is `published_at` (7500, 7618), shared by
  both legs in one `publish_compositor_frame` call (7389).
- **Gaze targets available per frame**: the highlight card's pixel rect
  per leg (`compositor.rs` 7523-7550, 7667-7673 via `overlay_blit_layout`;
  `state.comment_highlight` phase and `expires_at`,
  `comment_highlight.rs` 33-46, TTL 10 s), the caption bar rect
  (8627-8644), the Golem's own rect (`load_overlay_layout`,
  `overlay_layout.rs` 611). **No screen cursor coordinates exist** on any
  platform (ScreenCaptureKit bakes the cursor in, `preview_screen.rs`
  936; DXGI's pointer position stays on the media thread).
- **Dependencies**: `image 0.25.10` with `png`, `webp`, `jpeg`
  (`image-webp 0.2.4`: WebP decode with alpha, **lossless** WebP encode),
  `imageops::resize` Lanczos3 already used (`compositor.rs` 4824-4829),
  `rayon`. No AVIF, no connected-components crate. The renderer has no
  image libraries (OffscreenCanvas, `createImageBitmap`).
- **Golem assets**: main sets `VIDEORC_MANAGED_GOLEM_ROOTS` to
  `userData/golem-assets` (`main/index.ts` 8951-8953); the backend writes
  to the **first** root (`cohost_avatar.rs` 90-95) and can read any path
  under a root (`resource_authority.rs` 511, 532-540). Main's rules only
  allow `<persona>/(idle|talk|laugh|think).(png|webp|jpg)`, 4 MB, 20 MP
  (`shared/golem-assets.ts` 9-10, 77-89). The default pack is
  renderer-bundled (`assets/golem/default/idle.webp`) and invisible to the
  backend. Bundled backend-readable art has a precedent:
  `electron-builder.yml` 32-38 ships `assets/backgrounds` as
  `background-assets/bundled`, passed as a second root.
- **Image cache precedent**: `CompositorImageCache` (`compositor.rs`
  83-96): 256 MiB total, decode budget 128 MiB, BGRA-only resident,
  downscale with Lanczos3 (4768-4850).
- **Eager bundle budget**: 390,000 gzip / 2,000,000 raw
  (`scripts/check-renderer-asset-budget.mjs` 37-42); plan 164 left it at
  about 367 KB gzip. Lazy chunks are dynamic `import()`.
- **Web (plan 164, PR #75)**: `POST /api/ai/cohost/avatar` (Gateway
  `/v1/images/generations` and `/v1/images/edits`, transparent background
  for `openai/*` models, alpha check, daily cap 24, `ai_usage_events` kind
  `cohost-avatar`), capabilities `cohost: { tick, avatar }`, tick v4 with
  persona and `mood`.

## Decisions (⚑ = owner may override before the phase starts)

**Format and storage**

- D1. The **pet pack is page-pet manifest v1, unchanged**, plus a Videorc
  sidecar `golem.json` in the same folder. Any complete-character page-pet
  pack imports as is. Legacy two-layer packs (`layers`) are refused with a
  plain reason. AVIF sheets are refused (no decoder in our build); PNG and
  WebP are accepted.
- D2. Two avatar kinds per persona: **Still** (today's four state images)
  and **Alive** (a pet pack) ⚑ names. Still is rendered through the same
  sprite path as a **flat pack** built from the state images at load time
  (idle = the only gaze cell at [0,0]; talk, laugh, think = reactions), so
  there is one render path and the still Golem also gains the reaction
  bounce. The renderer stops drawing the avatar; it rasterizes the bubble
  only.
- D3. Packs live at `<golemRoot>/<personaId>/pets/<packId>/` with
  `manifest.json`, the sheets, `golem.json`, and for created packs
  `build-report.json`, `provenance.json` and `sources/`. `packId` is a
  uuid. The bundled default pack lives in a read-only **second** golem
  root shipped by `electron-builder.yml` as `golem-assets/bundled`
  (backgrounds precedent), id `bundled:golem`. "Start over" already
  deletes the persona folder, pets included.
- D4. Pack guards: 32 MB per file, 128 MB per pack (page-pet's), sheets
  ≤ 8192 × 8192, cells 128 to 1024 px, ≤ 64 frames, every cell must have
  transparent pixels, and the decoded total stays under the compositor's
  decode budget (128 MiB). Created packs use 640 px cells, same as
  page-pet.

**Rendering (Phase B)**

- D5. **The backend owns the atlas and the clock.** It decodes the pack
  once (`spawn_blocking`, bounded `image::Limits`), and **pre-scales the
  atlas per target leg** to the on-canvas cell size
  (`round(rect.w × canvasWidth)`, never upscaled, Lanczos3), with 2 px
  transparent gutters per cell and **alpha-bled RGB** so linear filtering
  never pulls dark halos or neighbour pixels. It keeps BGRA only, in a new
  `GolemSpriteSlot` with a process-unique revision. A re-scale runs when
  the rect size changes (debounced 250 ms; the old atlas keeps drawing,
  scaled, until the new one lands). Budget: ≤ 64 MiB for all resident
  pet atlases; over budget, the cell size steps down and the log says so.
- D6. **No GSAP.** Motion is ported from `motion.js` into one Rust module
  (`golem_motion.rs`) and one TS module (`shared/golem-motion.ts`) with a
  shared fixture proving they produce the same envelope samples. Ported
  page-pet code (manifest rules, cut, isolate, register, pack, motion
  formulas) is credited in `docs/third-party/page-pet.md` with the MIT
  notice.
- D7. Each path draws the pet as **one textured quad with a source rect
  (the atlas cell) and a 2D affine** (translate, rotate, skew, scale):
  Metal with a 4-corner `quad_vertices` variant and a **per-quad linear
  sampler flag**; D3D11 with a rotation/scale/skew `float4` in the
  cbuffer applied around the destination centre in `SceneVs`, and
  clipping instead of squashing at the canvas edge for this layer; CPU
  with a new inverse-affine **bilinear, straight-alpha** blit over the
  sprite's bounding box, rayon over rows. Nearest sampling stays for every
  other recording layer.
- D8. The pet gets **its own Metal namespace (7) and a key-addressed
  texture slot** that does not move when other layers appear, so a caption
  appearing never re-uploads the atlas. The bubble moves to its own
  namespace (8). Namespace 4 is camera storage again.
- D9. Z order is unchanged: captions, then the Golem (pet, then bubble),
  then the highlight card.

**Motion on air (Phase C)**

- D10 ⚑. The "nothing bounces" rule stays for scene, layout and camera
  motion. **The Golem is a character and is exempt**: it moves within
  page-pet's limits, scaled from their 180 px tuning to the drawn size
  (`px × size / 180`): ±20 px x, ±26 px y, ±10° rotation, ±7° skew, squash
  ±0.18 area-preserving. A per-persona **Motion** setting 0 to 1 (default
  0.45, page-pet's default) multiplies everything; 0 keeps frame changes
  and removes all transforms. The compositor test that enforces "no
  overshoot" is scoped to scene transitions by name.
- D11. **Gaze (owner answer 3)**, evaluated per leg because the pet and
  the card sit in different places per orientation:
  - default target: the viewer, gaze `[0, 0]`;
  - idle glance: every 7 to 14 s (random), a 0.8 to 1.6 s glance to a
    random cell with |x| ≤ 0.5 and |y| ≤ 0.5, never while a bubble is up;
  - highlight card shows: look at the card (vector from the pet's head
    anchor to the card's centre in canvas pixels, divided by
    `max(1.3 × size, 120)`, clamped to [-1,1], nearest cell; page-pet's
    tracking formula), hold 1.5 s, back to the viewer, one more glance at
    mid-TTL;
  - a bubble shows: look at the viewer;
  - an Answer is pending (`think`): look up-left `[-0.5, -1]`;
  - a gaze change adds page-pet's turn nudge (angle spring
    `Δx × 9 × intensity`).
- D12. **Talk**: while a bubble is up, cycle `talk-a`, `talk-b`, neutral
  at a jittered 110 to 150 ms per step for `min(bubble duration, 65 ms ×
characters)`, then hold neutral. A pack without talk frames talks with a
  small vertical bob (y spring impulses at the same cadence) on the
  neutral cell.
- D13. **Blink** every 3.5 to 6 s, 160 ms, only on the neutral cell (as
  page-pet). **Sleep** after `sleepAfterSeconds` (default 180 s ⚑, 0 =
  never) with no chat, activity, utterance or Say; any of those wakes it
  with `surprised` held 600 ms. Sleep never starts while the highlight
  card or a bubble shows.
- D14. **Reactions from events**, defaults, each editable per persona,
  each falling back to the next available id, then to a motion-only hop:

  | Trigger                                                 | Reaction                               |
  | ------------------------------------------------------- | -------------------------------------- |
  | Follow                                                  | `wave` → `proud`                       |
  | Sub, resub, membership                                  | `excited`                              |
  | Sub gift, community gift                                | `excited`                              |
  | Cheer, bits, kicks, Super Chat, Super Sticker, Power-up | `surprised`                            |
  | Raid                                                    | `surprised`                            |
  | Watch streak                                            | `proud`                                |
  | Redemption                                              | `wink`                                 |
  | Utterance mood laugh                                    | `laugh`                                |
  | Destination failed                                      | none (⚑ `worried`)                     |
  | Moderation flag                                         | none (flags are private; never on air) |

  A greeting template keeps `state` for the bubble and gains an optional
  `reaction` (any reaction id of the persona's pack). Reactions use
  page-pet's per-id pose table; unknown ids use its default
  `[-8, 3, -0.05]`. Reactions do not interrupt a playing reaction; they
  queue (max 2, 6 s max age), same spirit as Activity auto-show.

- D15. **Breathing** (new, not in page-pet): a squash sine of amplitude
  `0.012 × intensity` at 0.22 Hz while idle on a gaze cell. It is what
  makes a still pack look alive between events. ⚑ remove if it reads as
  wobble on stream.

**Bubble**

- D16. The bubble is a separate renderer-rasterized PNG (plan 164's
  layout minus the avatar) in its own slot, anchored above the pet's head:
  `golem.json` stores `headTop` (normalized top of the neutral silhouette
  inside its cell, measured by the builder or on import). The bubble does
  not follow squash or rotation; it stays readable.

**Creation (Phases E and F)**

- D17. **Cutting, registration and packing run in the desktop backend**
  (a Rust port of `prepare_layout.py`, `isolate_strip.py` and the parts of
  `build_pack.py` we need). The web only generates images. Sources stay on
  the user's computer; the build works offline once sheets exist.
- D18. One creation = **one pilot sheet (2 × 2: neutral, left, right,
  laugh), five 5 × 1 gaze strips, two 3 × 2 reaction sheets (page-pet's
  12), one 3 × 1 extra strip (`talk-a`, `talk-b`, `wave`)**: 9 base
  generations. Each generation is an image edit of the accepted neutral
  with the identity notes (D19) in the prompt.
- D19. **Identity notes** replace page-pet's hand-written identity-side
  map: one vision call on the reference returns palette, materials, body
  proportions and every asymmetric feature with its anatomical side. The
  user sees them as plain sentences and can correct them before the
  pilot.
- D20. **Allowance (owner answer 2)** ⚑ numbers: Premium, **3 creations
  per calendar month**, each with **9 base sheets plus 6 redos**; pilots
  are capped at 3 per creation and 6 per day. A creation counts against
  the month when its first non-pilot sheet succeeds, so abandoning at the
  pilot costs no creation. Failed generations never count. Import is free;
  Still is free; an Alive pet renders for free.
- D21. **Review gate** (page-pet's publication gate, made usable): the
  builder's mechanical checks (alpha present, margin ≥ 8 px, root drift,
  duplicate cells, scale ratio bounds) must pass, and the user must mark
  each of the 5 gaze rows and the 3 reaction sheets "Looks right" in the
  review grid, with the live preview following their mouse. A redone row
  needs a fresh mark. Saving is disabled until every row is marked.
  Automated direction checking by a vision model is out of scope ⚑.
- D22. Generation needs a model with **transparent background and image
  edits**: per web PR #75 only the `openai/*` image models expose the
  transparency knob. The pet route reads `VIDEORC_AI_PET_IMAGE_MODEL`,
  falling back to `VIDEORC_AI_AVATAR_IMAGE_MODEL`.

**Default art (owner answer 1)**

- D23. Our default Golem pack is made **with the creator** from
  `assets/brand/golem/golem-master.png` in Phase G and reviewed by the
  owner. Until then the default persona renders the Still flat pack from
  the existing idle image.

## Wire shape

Persona additions (`cohostSettings.persona`, Rust `#[serde(default)]`,
strict runtime schema, fixtures):

```ts
avatar: { kind: 'still' } | { kind: 'alive'; packId: string }  // default still
motion: {
  intensity: number          // 0..1, default 0.45
  sleepAfterSeconds: number  // 0 = never, else 30..1800, default 180
  breathing: boolean         // default true
}
reactions: Partial<Record<GolemTrigger, string | 'none'>>   // D14 overrides
```

```ts
type GolemTrigger =
  | 'follow'
  | 'subscription'
  | 'gift'
  | 'tip'
  | 'raid'
  | 'watch-streak'
  | 'redemption'
  | 'destination-failed'
```

`GreetingTemplate` gains `reaction?: string` (1 to 40 chars, `[a-z0-9-]`).

Sidecar `golem.json` (D1, D16):

```json
{
  "version": 1,
  "source": "videorc-creator",
  "headTop": 0.18,
  "talk": ["talk-a", "talk-b"],
  "createdAt": "2026-10-20T12:00:00Z",
  "referenceSha256": "…"
}
```

`source` is `videorc-creator`, `page-pet-import` or `still`. A pack
without the sidecar gets one on import (`headTop` measured, `talk` = the
ids present among `talk-a`, `talk-b`).

New RPCs (backend, `// --- Golem pets (plan 168) ---` blocks in
`backend.ts` and `backend-rpc-contract.ts`):

- `cohost.pet.list` (observation) → `GolemPetSummary[]` `{packId, name,
cellSize, gazeCount, reactions: string[], source, hasTalk}` for the
  persona plus `bundled:golem`.
- `cohost.pet.import { folderToken }` (mutation): main resolves the
  folder the user picked, copies it under the managed root, the backend
  validates and returns the summary; `cohost-pet-invalid` with a reason.
- `cohost.pet.remove { packId }` (mutation).
- `cohost.pet.react { reaction }` (mutation, for the in-app preview's
  "Try" buttons and the Say box chips).
- Event `cohost.pet.frame` is **not** streamed; the app preview runs its
  own animator (D6, Phase D).

Creator RPCs (Phase F): `cohost.pet.identity { reference }`,
`cohost.pet.sheet.generate { buildId, kind, row? }` (accept + event, like
`cohost.avatar.generate`), `cohost.pet.build { buildId }` (accept + event
`cohost.pet.build.progress {buildId, step, done, total, error?}`),
`cohost.pet.save { buildId, name }`.

Web (Phase E):

- `POST /api/ai/cohost/pet/builds` → `{ buildId, sheetsAllowed,
redosAllowed, pilotsAllowed, expiresAt }` or 429 `pet-allowance-used`.
- `POST /api/ai/cohost/pet/identity` `{ buildId, reference }` →
  `{ notes: { palette: string[], materials: string[], proportions:
string, asymmetric: { feature: string, side: 'left' | 'right' }[] } }`.
- `POST /api/ai/cohost/pet/sheet` `{ buildId, kind: 'pilot' | 'gaze' |
'reactions-a' | 'reactions-b' | 'extras', row?: 'up2' | 'up1' | 'level'
| 'down1' | 'down2', reference, notes, redo: boolean }` →
  `{ pngBase64, width, height, opaque, sheetsRemaining, redosRemaining }`.
- Capabilities: `cohost.pet: { enabled, creationsRemainingThisMonth,
monthlyLimit }`.
- Metering: `ai_usage_events` kinds `cohost-pet-sheet` (one per delivered
  sheet) and `cohost-pet-build` (one per counted creation).

## Phase 0: Golem settings spacing (PR 0, ships first)

Owner route UI/Product Design, `opus-4.8`. Follows `videorc-design`. This
phase does not wait for the animation work: it can land right after plan
164 merges, or be folded into PR #647 before it merges.

**The owner's report (2026-10-08, screenshot of Golem → Chat → Replies)**:
the Answers and Banter rows sit flush against the card's left and top
edges, with their titles touching the separator above, while Reply tone
and Golem notes in the same card have proper padding.

**Root cause (plan 164 branch `3ccc0888`)**: the grouped card pads its
rows with a selector on the shadcn slot name,
`*:data-[slot=field]:px-3 *:data-[slot=field]:py-2.5`
(`components/ui/field.tsx` 44, `FIELD_GROUP_GROUPED`). The Answers and
Banter rows come from a helper that renders
``<Field data-slot={`${id}-field`}>``
(`components/cohost-settings-section.tsx` 299). That prop replaces the
`data-slot="field"` the shadcn `Field` sets, so the card's padding
selector never matches those two rows. Reply tone and Golem notes are
plain `<Field>`s and keep their padding. It is the same class of bug as
the Tailwind `data-active` trap fixed in #392:
a selector keyed on an attribute the app overrides.

The same override exists on two grouped cards, also on origin/main:
`<FieldGroup variant="grouped" data-slot="cohost-listen-field">`
(`cohost-settings-section.tsx` 132) and
`<FieldGroup variant="grouped" data-slot="orcle-voice-commands-settings">`
(`orcle-voice-commands.tsx` 164). Those replace `data-slot="field-group"`,
which the nested-group gap selector `*:data-[slot=field-group]:gap-4`
(`field.tsx` 56) depends on. A `FieldDescription` also overrides its slot
(`tabs/orcle-tab.tsx` 362, `data-slot="orcle-live-pointer"`).

### S-00 Restore the shadcn slots

1. Remove the `data-slot` prop from those `Field`, `FieldGroup` and
   `FieldDescription` usages. Where a test or smoke needs a hook, use
   `data-testid` (the repo's existing convention, e.g.
   `studio-tab.tsx` 292), never `data-slot`, on a shadcn primitive.
2. Move the test hooks with them: `tabs/orcle-tab.test.ts` 187 and 380
   query `[data-slot="orcle-live-pointer"]`; grep `scripts/` and
   `apps/desktop/src` for every renamed hook before deleting it.
3. Do not add padding classes to the helper to compensate. The card owns
   the row rhythm (`px-3 py-2.5`); every row in a grouped card inherits it.
4. **Done when**: the Answers and Banter rows have the same 12 px side and
   10 px top and bottom padding as Reply tone, measured in the DOM by a
   renderer test (computed `padding-left` of each row in the card is
   equal), and the moved test hooks pass.

### S-01 A guard so it cannot come back

1. `renderer-style-guards.test.ts`: a rule "never overrides `data-slot`
   on a shadcn primitive outside `components/ui`". Scan each `.tsx` file's
   full text (not line by line, JSX props wrap) for
   `<(Field|FieldGroup|FieldSet|FieldLabel|FieldDescription|FieldContent|FieldLegend|FieldTitle|FieldSeparator|FieldError)\b[^>]*\bdata-slot=`
   and extend the name list with any other `components/ui` export whose
   styles select on a child's `data-slot` (check `components/ui/*.tsx` for
   `data-[slot=` and `[data-slot=` selectors and list those components).
2. **Done when**: the guard fails on a scratch copy of the old helper and
   passes on the fixed tree.

### S-02 Spacing pass on every Golem surface

1. Capture every Golem surface with `node scripts/capture-ui-pages.mjs`
   (it already walks the Golem sub-tabs: Golem, Chat, Voice, Reports,
   Clean cut) at 1280 × 800, in dark and light, plus the Stream Manager
   Golem pane (header, mode control, utterance cards, Say box) and the
   greetings editor open on one row.
2. Check each against the design skill's rhythm: grouped rows `px-3
py-2.5`; section headers 16 px above, 8 px below; panel gutter 16 to
   20 px; 12 px between an icon and its title; controls under a
   description start on the text's left edge; a slider row never touches
   the separator below it. Fix only spacing (classes on the app
   components, never `components/ui`), and only by using the shared
   primitives the way the rest of Settings does.
3. **Done when**: before and after captures are attached to the PR (not
   committed) and the owner signs off by eye in both themes.

### Phase 0 gates

`pnpm typecheck && pnpm lint && pnpm format:check &&
pnpm --filter @videorc/desktop test`, and `node scripts/capture-ui-pages.mjs`
for the evidence. No recording smoke: nothing here touches capture or
output.

## Phase A: Pet pack format, storage, import, still packs (PR 1)

Owner route Implementation, `gpt-5.5`. No render-path change yet: the
renderer keeps drawing the avatar until Phase B lands.

### S-A1 The pack contract in Rust and TS

1. `crates/videorc-backend/src/golem_pet.rs`: `PetManifest`, `PetFrame`,
   `PetSidecar` (serde), `validate_manifest` mirroring page-pet's
   `manifest.js` rules exactly (D1) plus D4 guards, `validate_images`
   (rects inside decoded sheets, transparent pixels per cell),
   `measure_head_top` (top of alpha > 16 in the neutral cell).
2. `apps/desktop/src/shared/golem-pet.ts`: the same validation for the
   renderer preview, and the shared fixture
   `protocol-fixtures/golem-pet-manifests.json` with valid packs and one
   case per rule that must fail (legacy `layers`, AVIF, path in sheet,
   duplicate gaze, non-square rect, neutral missing, out of bounds).
   Rust and TS run the same fixture.
3. **Done when**: `cargo test -p videorc-backend golem_pet` and
   `pnpm --filter @videorc/desktop test -- golem-pet` pass the shared
   fixture; every failing case names its rule.

### S-A2 Storage, roots and the bundled root

1. `shared/golem-assets.ts`: `parseGolemPackPath` for
   `<persona>/pets/<packId>/<file>` with a filename allow-list
   (`manifest.json`, `golem.json`, `build-report.json`,
   `provenance.json`, `*.webp`, `*.png`, `sources/*.png`), pack caps
   from D4. The state-image rules stay.
2. `electron-builder.yml`: ship `apps/desktop/resources/golem` as
   `golem-assets/bundled`; `main/index.ts` passes it as the **second**
   entry of `VIDEORC_MANAGED_GOLEM_ROOTS` (first stays the write root).
   Dev runs read it from the source tree.
3. **Done when**: unit tests accept a pack path and refuse traversal,
   unknown files and oversize files; `pnpm build` lists the bundled root
   in the packaged resources.

### S-A3 Import a page-pet pack

1. Main: `golem-pets:import-folder` IPC (contract, preload, security
   policy) opens a folder picker, checks sizes before reading, copies
   allowed files to `<root>/<persona>/pets/<uuid>/`, then calls
   `cohost.pet.import`. On any refusal the copy is removed.
2. Backend `cohost.pet.import`: validate (S-A1), decode in
   `spawn_blocking`, write `golem.json` if missing (D1), return the
   summary.
3. `cohost.pet.list` / `cohost.pet.remove` (removing the active pack
   switches the persona to Still).
4. **Done when**: importing the page-pet Moklo pack from a local clone
   (test-only, never committed) succeeds; a legacy layered pack and an
   AVIF pack are refused with their reason; the Rust and main tests cover
   the refusal paths with synthetic packs.

### S-A4 Still as a flat pack

1. `golem_pet::still_pack(persona)` builds an in-memory pack from the
   persona's images (or the bundled idle when absent): cells at the
   largest image's size, idle → gaze `[0,0]`, talk / laugh / think →
   reactions, `headTop` measured. No file is written.
2. Persona wire: `avatar`, `motion`, `reactions` (Wire shape), strict
   schema and fixture; `GreetingTemplate.reaction`.
3. **Done when**: round-trip tests for the new persona fields; a test
   proves `still_pack` of the default persona has one gaze cell and three
   reactions that fall back to idle when images are missing.

### Phase A gates

`pnpm typecheck && pnpm lint && pnpm format:check &&
pnpm --filter @videorc/desktop test && cargo fmt --check --all &&
cargo clippy -p videorc-backend -- -D warnings &&
cargo test -p videorc-backend golem` and `pnpm build`.

## Phase B: Sprite layer in CPU, Metal and D3D11 (PR 2)

Owner route Implementation, `fable-5`. Ships the sprite path with a
static cell (the animator arrives in Phase C), so the Golem looks exactly
as today on stream, now drawn by the backend.

### S-B1 `GolemSpriteSlot` and the pre-scaled atlas

1. `golem_sprite.rs`: load the active pack (alive or still) in
   `spawn_blocking`; per target leg, pre-scale cells to
   `round(rect.w × canvasWidth)` capped at the cell size, 2 px gutters,
   alpha-bleed (each transparent texel takes the RGB of its nearest
   opaque neighbour within 2 px), BGRA only, revision from a process-wide
   counter. Rebuild on pack change, persona change, rect size change
   (debounced 250 ms), leg canvas change. Budget per D5, logged.
2. Per-frame input: `GolemSpriteDraw { cell: [x,y,w,h] (atlas px),
center: [x,y] (canvas px), size: f32, affine: [a,b,c,d] (2×2),
opacity: f32 }` per leg, computed by a `GolemSpriteSource` trait that
   Phase B implements as "neutral cell, identity affine" and Phase C
   replaces with the animator.
3. Remove the avatar from `golem-overlay.ts` (bubble only, anchored by
   `headTop`, D16) and move the bubble to namespace 8 (D8).
4. **Done when**: unit tests for pre-scale size, gutters, alpha bleed
   (no texel with alpha 0 keeps black RGB next to an opaque edge), budget
   step-down, and the debounce.

### S-B2 Metal

1. `GpuSource` gains `corners: Option<[[f32; 2]; 4]>` and
   `sampler: Nearest | Linear`; `quad_vertices` honours corners; the
   compose loop binds the linear sampler for quads that ask for it.
2. A key-addressed texture slot for namespace 7 that survives index
   shifts (D8): the cache looks up by `GpuSourceContentKey` first, then by
   index for everything else.
3. **Done when**: a test proves the atlas uploads once across 100 frames
   while a caption appears and disappears; `cargo clippy` clean.

### S-B3 CPU

1. `blit_sprite_affine_to_yuv420p(dst, atlas, draw)`: bounding box of the
   transformed quad, inverse affine per pixel, bilinear sample in the
   cell (clamped to the cell, gutters guard bleed), straight-alpha blend,
   rayon over rows.
2. **Done when**: the parity fixture below passes.

### S-B4 D3D11

1. `windows_d3d11_shaders.hlsl`: `SceneVs` reads a `float4 affine` and
   `float2 pivot` from the cbuffer and transforms the unit quad around the
   destination centre with aspect correction; default identity keeps every
   other layer byte-identical.
2. A new layer kind `GolemSprite` with `source_uv` = the cell and clipping
   at the canvas edge for this kind (D7); upload once per revision via
   `BgraUpload { immutable: true }`.
3. Windows-only tests under the same cfg; mirrored by reading on macOS
   (say so in the hand-back).
4. **Done when**: Windows CI green including the new tests.

### S-B5 Parity fixture

`cpu_and_metal_draw_the_same_sprite`: a synthetic 3 × 2 atlas whose
cells are flat, distinct colours with a 1-pixel alpha ramp edge, drawn at
a 30° rotation, 1.1 × 0.9 scale, onto a 1280 × 720 canvas. CPU and Metal
readbacks match within ±3 per channel inside the quad and ±8 on the
edge ring; the D3D11 twin runs in Windows CI.

### Phase B gates

TS + Rust gates as Phase A, plus `pnpm smoke:recording-studio`,
`pnpm smoke:recording-matrix` (hard-content pass included),
`pnpm smoke:record-latency:gate`, `pnpm smoke:comment-highlight-stream`
and the three captions smokes. Windows CI for D3D11. Memory
[[feedback-gates-at-the-end]]: write every Phase B slice, then run the
smokes once.

## Phase C: The animator (PR 3)

Owner route Implementation, `fable-5`.

### S-C1 `golem_motion.rs` and `shared/golem-motion.ts`

1. Port `motion.js` (D6): channels, spring, reaction envelopes with
   `power2.out` and `elastic.out(1, p)` easing, the laugh shake, the pose
   table, clamps, area-preserving squash, all scaled by `size / 180` and
   the persona intensity (D10). No pointer drag or inertia (not used on
   stream; the app preview keeps a simple drag in Phase D).
2. Fixture `protocol-fixtures/golem-motion.json`: for each reaction id and
   for a gaze nudge, samples of `(x, y, angle, skew, squash)` every
   16.667 ms for 2 s at intensity 0.45 and 1.0. Rust and TS must match
   within 1e-4.
3. **Done when**: both fixture tests pass; a test proves intensity 0
   yields identity transforms for every reaction.

### S-C2 `golem_animator.rs`

1. Pure state machine, clock-injected: inputs are events (utterance
   start / end with state and text length, reaction requests, highlight
   live / idle with per-leg card rects, think start / settle, any chat
   activity), outputs `GolemSpriteDraw` per leg at time `t`.
2. Implements D11 gaze (per leg), D12 talk, D13 blink and sleep, D14
   reactions with the queue, D15 breathing.
3. Deterministic tests with a fake clock and a seeded RNG: a scripted
   session (follow at 1 s, highlight at 3 s on the left, utterance at 6 s,
   silence for 200 s) produces an exact cell sequence and transform
   snapshots; the left card makes the gaze cell's x < 0 on that leg and
   the other leg follows its own card position.
4. **Done when**: `cargo test -p videorc-backend golem_animator` covers
   every row of D11 to D15, fallbacks of D14, and the queue limits.

### S-C3 Wiring the events

1. `golem_overlay.rs` and `cohost.rs`: utterances, think and settle feed
   the animator (the bubble keeps plan 164's `show_for_utterance` gate).
2. Activity rows (the `LiveChatMessage` ingestion that feeds greetings)
   map to `GolemTrigger` and the persona's reaction table; the greeting's
   own `reaction` wins when set.
3. `comment_highlight.rs` phase changes and the per-leg card rects reach
   the animator.
4. `cohost.pet.react` for manual reactions; the Stream Manager Say box
   gains reaction chips (Laugh, Wave, Surprised, Proud) ⚑.
5. **Done when**: integration tests from a fake follow to the reaction
   cell, and from a highlight to the gaze cell.

### S-C4 The clocks

1. CPU and Metal: evaluate once per `publish_compositor_frame` at
   `published_at`, shared by both legs (one state, per-leg gaze).
2. D3D11: evaluate at `output_sequence / fps` from the pump's tick, the
   first animation clock there; the leg flags stay start-time.
3. **Done when**: a test proves two frames at the same timestamp produce
   identical draws, and the D3D11 clock test runs in Windows CI.

### S-C5 `smoke:golem-pet`

1. A fixture generator script (`scripts/lib/golem-pet-fixture.mjs`)
   builds a synthetic pack where every cell is a simple silhouette with a
   **unique colour tag** in a fixed spot, so the analyzer can tell which
   cell is on screen from a recorded frame.
2. `scripts/smoke-golem-pet-app.mjs` (package script `smoke:golem-pet`):
   dev app, import the fixture, set Alive, show the Golem on recording,
   record 12 s while scripting a follow (expect the `wave` or `proud`
   tag), a left-side highlight (expect a left gaze tag on the primary
   leg), an utterance (expect talk tags alternating), and silence with
   `sleepAfterSeconds: 30` in a second run (expect the `sleep` tag).
   It also asserts the sprite's bounding box moves during a reaction
   (motion is on) and not with intensity 0.
3. Added to `smoke:recording-studio`.
4. **Done when**: the smoke passes twice in a row on a quiet host.

### Phase C gates

Phase B's set plus `pnpm smoke:golem-pet`, `pnpm smoke:freeform-editor`
(compositor cadence with the pet animating: longest stall within the
existing budget), `pnpm smoke:live-chat-fake-providers` (reactions on the
fake activity), `pnpm smoke:remote-control`.

## Phase D: Living preview and settings in the app (PR 4)

Owner route UI/Product Design, `opus-4.8`. Follows `videorc-design`.

### S-D1 `GolemPetPreview` component

1. `components/golem-pet-preview.tsx` (lazy chunk): a canvas that plays a
   pack with `shared/golem-motion.ts`, page-pet's mouse tracking (nearest
   gaze cell, 16 px dead zone, radius `max(120, 1.3 × size)`), click to
   react (cycle, 250 ms cooldown), blink and sleep, breathing,
   `prefers-reduced-motion` honoured (no gaze tracking, no transforms,
   drawn reactions still on click). It reads the pack through main IPC
   (`golem-pets:read`), never over the network.
2. **Done when**: tests for nearest-cell selection, reduced motion, and
   that the chunk is outside the eager budget (`pnpm check:renderer-assets`).

### S-D2 The Golem tab

1. The **Looks** section becomes **Avatar** with a `ToggleGroup`
   Still | Alive ⚑. Still keeps the four state tiles. Alive shows the
   preview (160 px, follows the cursor across the window), the pack row
   (name, "37 poses", source), and actions: **Create** (Premium, "2 of 3
   left this month", opens Phase F's wizard; disabled with a pointer to
   Phase F until it ships), **Import pack…** (`Kbd` I), **Remove**.
2. **Reactions** section: a sectioned list, one row per `GolemTrigger`
   with a `Select` of the pack's reactions plus None, and a Try button
   that plays it in the preview.
3. **Motion** section: Motion `Slider` (0 to 1, ticks at Off / Calm /
   Lively), Sleep after `Select` (Never, 1, 3, 5, 10 min), Breathing
   `Switch`.
4. Copy is short and plain; no success toasts (design skill).
5. **Done when**: owner by-eye in both themes; tests for the toggle
   persisting `avatar`, the reactions table writing `reactions`, and Import
   refusals showing their reason inline.

### S-D3 Stream Manager

1. The Golem pane header shows the small preview (32 px) instead of the
   state image, following the cursor inside the Stream Manager window,
   with the Say box's reaction chips (S-C3.4).
2. **Done when**: owner by-eye; the pane test covers the chips relaying
   `cohost.pet.react`.

### Phase D gates

TS gates, `pnpm build`, `pnpm check:renderer-assets`,
`pnpm smoke:remote-control`.

## Phase E: Web: pet build sessions, sheet generation, allowance (PR 5, videorc-web)

Owner route Implementation, `fable-5`. Deploy before Phase F ships.

### S-E1 Model probe

1. With the owner's Vercel env, generate one pilot and one gaze strip
   for the stone golem with each candidate model that supports
   transparency and edits. Record native size, alpha, identity hold and
   the real cost per sheet in `docs/ai-gateway.md`.
2. **Done when**: the owner picks `VIDEORC_AI_PET_IMAGE_MODEL` and the
   monthly numbers of D20 are confirmed or changed against the measured
   cost.

### S-E2 Routes

1. `app/api/ai/cohost/pet/builds/route.ts`,
   `…/pet/identity/route.ts`, `…/pet/sheet/route.ts` (Wire shape), bearer
   auth and Premium as the avatar route; Zod schemas reject unknown
   fields; one image call per request, no retries; failures meter
   nothing.
2. Prompts (one module, versioned `PET_PROMPT_VERSION = 1`) built from
   page-pet's generation rules: the whole character in every cell, same
   scale, palette, lighting and foot baseline, transparent background,
   clear transparent gutters between characters, real head turns (not
   pupils), the identity notes with anatomical sides, per-kind layout
   (pilot 2 × 2 order neutral, left, right, laugh; gaze 5 × 1 left profile
   → left three-quarter → front → right three-quarter → right profile at
   the row's pitch; reactions-a 3 × 2 laugh, surprised, wink, kiss,
   blink, sleep; reactions-b 3 × 2 worried, annoyed, proud, confused,
   excited, calm; extras 3 × 1 talk-a (mouth open, neutral pose), talk-b
   (mouth half open), wave). Landscape 1536 × 1024 for strips, square for
   the pilot.
3. Allowance per D20, enforced server-side with the build id; capability
   block `cohost.pet`; metering kinds.
4. **Done when**: route tests with a mocked gateway for success, opaque
   result, allowance used, redo limit, pilot limit, unknown fields, and
   the month rollover; deployed.

## Phase F: The creator: Rust builder and the wizard (PR 6)

Owner route Implementation, `fable-5` for the builder, `opus-4.8` for the
wizard.

### S-F1 Cut

`golem_pet_build/cut.rs`: alpha-gutter cuts (port of `prepare_layout.py`:
alpha > 16 column and row profiles, zero runs within ±35 % of the ideal
boundary, nearest run's middle, no equal-width fallback). **Done when**:
tests on synthetic sheets with gutters, uneven widths, and a missing
gutter (error).

### S-F2 Isolate

`isolate.rs`: union-find labelling of alpha > 16 pixels (8-connected);
the N largest components are the characters; smaller components join the
nearest character by bounding-box distance when within 24 px, else the
sheet fails with "loose pieces"; never resample, never drop pixels.
**Done when**: tests with overlapping horizontal extents, a detached
sparkle that joins its owner, and a stray blob that fails.

### S-F3 Register and pack

`register.rs` and `pack.rs` (port of the `build_pack.py` parts in D17):
foot anchor (alpha-weighted centre of the 82 to 96 % lower band plus the
bottom), gaze sheets `neutral-height` scale (the strip's middle cell),
reaction and extras sheets `full-height` scale within 0.75 to 1.55 of the
neutral, occupancy 0.65 of 640 px cells, margin ≥ 8 px (reject, never
shrink a pose), root drift ≤ 1.5 px x and ≤ 1 px bottom, duplicate-cell
rejection by pixel hash, atlas row-major (gaze rows up2 → down2 then
reactions then extras), lossless WebP, `manifest.json` (ids
`gaze-<col>-<row>` with page-pet coordinates, reactions by name),
`golem.json`, `build-report.json` (per cell: scale, margin, root, bounds),
`provenance.json` (reference and every source SHA-256). **Done when**:
tests for each rejection and a round trip whose manifest passes S-A1.

### S-F4 Orchestration RPCs

`cohost.pet.identity`, `cohost.pet.sheet.generate`, `cohost.pet.build`,
`cohost.pet.save` (Wire shape): accept + event, one generation at a time,
sources saved as versioned files (`sources/gaze-level-v2.png`), state
persisted in `build-state.json` so a restart resumes at the right step.
**Done when**: a fake-web test runs a full creation from pilot to saved
pack and a resume after a simulated restart.

### S-F5 The wizard

Follows `videorc-design`; a sub-view of the Golem tab with a step header
and `⌘↵` to continue.

1. **Reference**: the persona's idle image, an upload, or Generate (the
   avatar route). Checks: transparent, full body, front facing (the
   identity call says so); the identity notes appear as editable
   sentences.
2. **Pilot**: four poses; "Looks like my Golem" or Redo (3 max).
3. **Build**: a list of the 8 sheets with status, progress and Cancel;
   then the builder runs locally.
4. **Review**: the 5 × 5 gaze grid laid out spatially with an arrow per
   cell for the intended direction, the reactions and extras below, the
   live preview beside it following the mouse; per row "Looks right" or
   "Redo row" (counts against redos); builder failures name the cell and
   the reason.
5. **Save**: name the pack; sets the persona to Alive.
6. **Done when**: owner by-eye in both themes; tests for the gate (save
   disabled until every row is marked, a redo clears that row's mark),
   allowance copy, and cancel leaving no partial pack.

### Phase F gates

TS + Rust gates, `pnpm build`, `pnpm check:renderer-assets`, the builder
tests, a real creation on the owner's Premium account against the
deployed web.

## Phase G: Our default Golem made with the creator (PR 7)

1. The owner runs the creator with `assets/brand/golem/golem-master.png`
   as the reference and reviews every row (owner answer 1).
2. Commit the saved pack (manifest, atlas, `golem.json`,
   `build-report.json`, `provenance.json`; **not** the sources) to
   `apps/desktop/resources/golem/golem/`, id `bundled:golem`; target
   ≤ 6 MB. The default persona becomes Alive with it.
3. Docs: `docs/golem.md` (Still and Alive, creating, importing, motion
   and reactions, the allowance), `docs/overlays.md` (the sprite layer),
   `docs/third-party/page-pet.md` (credit and MIT notice, D6).
4. Owner acceptance: a 10-minute live stream with fake and real activity,
   by eye on both orientations, recorded in
   `docs/acceptance/<date>-living-golem.md`.

## STOP conditions

- Any path decodes or re-scales the atlas per frame, or the Metal atlas
  re-uploads when another layer appears or disappears.
- The CPU and Metal sprite readbacks differ beyond the S-B5 tolerance: do
  not loosen it.
- `smoke:recording-matrix`, `smoke:record-latency:gate` or the freeform
  cadence budget regresses with the pet animating.
- The Rust and TS motion samples disagree beyond 1e-4.
- The web allowance can be exceeded by any sequence of calls, or a failed
  generation is metered.
- An imported pack can make the backend read outside the managed roots.

## Out of scope

- Following the streamer's mouse cursor (no cursor coordinates exist;
  owner chose viewer plus events).
- Lip sync, voice, and skeletal animation; frames are drawn poses.
- Bundling page-pet's collection (owner chose import only).
- An automated vision check of gaze directions (D21 ⚑).
- AVIF sheets and legacy two-layer packs.
- Selling or sharing pets between users.

## Open questions for the owner

1. D2: "Still" and "Alive" as the two names, or other words?
2. D10 and D15: default Motion 0.45 and breathing on, both for the stream?
3. D13: sleep after 3 minutes of silence by default?
4. D14: should a failed destination make the Golem look worried on air?
5. D20: 3 creations a month with 6 redos each, confirmed after the S-E1
   cost probe?

## Handoff (cold start)

- Goal: this plan, one phase per PR, in order 0 → A → B → C → D → E →
  F → G. Phase 0 ships first and alone (spacing only). E (web) can run in
  parallel with B to D. D can start after A.
- Current state: nothing built. Plan 164 must be merged first.
- Work in a fresh worktree from origin/main per phase
  ([[feedback-shared-checkout-use-own-worktree]]); brief sub-agents with
  `git show origin/main:<path>` ([[feedback-subagents-read-origin-main]]).
- Gates: per phase above; long smokes once at the end of a phase
  ([[feedback-gates-at-the-end]]) and one at a time (the host flakes under
  load).
- Reading page-pet: clone `gvastethecreator/page-pet-skill` into a
  scratch folder and read it; never run its scripts or install it into
  the repo. Its art never enters the repo, not even as a test fixture;
  fixtures are synthetic (S-C5).
