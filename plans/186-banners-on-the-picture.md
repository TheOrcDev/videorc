# Plan 186: Banners (your own images, placed anywhere on the picture)

> **Executor instructions**: Follow this plan slice by slice. Run every "Done
> when" check before moving on. If anything in "STOP conditions" happens, stop
> and report; do not improvise. When done, update this plan's row in
> `plans/README.md` and fill in "As built". Gates run once at the end
> (owner rule): write and commit all Phase 1 slices first, then run S9.
>
> **Drift check (run first)**:
> `git diff --stat dacbec26..origin/main -- crates/videorc-backend/src/compositor.rs crates/videorc-backend/src/metal_compositor.rs crates/videorc-backend/src/overlay_layout.rs crates/videorc-backend/src/recording.rs crates/videorc-backend/src/storage.rs crates/videorc-backend/src/main.rs crates/videorc-backend/src/remote_control.rs crates/videorc-backend/src/windows_d3d11_session.rs crates/videorc-backend/src/windows_d3d11_compositor.rs apps/desktop/src/main/index.ts apps/desktop/src/shared/backend.ts apps/desktop/src/shared/backend-rpc-contract.ts apps/desktop/src/shared/electron-ipc-contract.ts apps/desktop/src/renderer/src/components/tabs/assets-tab.tsx apps/desktop/src/renderer/src/components/tabs/layout-tab.tsx apps/desktop/src/renderer/src/components/scene apps/desktop/src/renderer/src/components/stream-manager apps/desktop/src/renderer/src/lib/overlay-layout.ts apps/desktop/src/renderer/src/lib/remote-surface.ts apps/desktop/src/renderer/src/hooks/use-studio.tsx docs/overlays.md`
> If an anchor quoted below has moved, re-find it by the symbol name. If a
> _behaviour_ changed (not just a line number), that is a STOP condition.

## Status

- **Priority**: P1. Owner request, 2026-10-20: "a new feature in Videorc
  where we can put a banner wherever we want and put an image there. That
  could be a sponsor banner or maybe a 'follow me' banner or whatever kind
  of banner. It should be flexible so we can put something inside to upload
  an image and it should have some recommended height and width. … I think
  this is going to be a really useful feature".
- **Effort**: L. Phase 1 has 10 slices (S0 is decisions only, S9 is the
  gates). Phase 2 has 2 optional slices.
- **Risk**: MEDIUM–HIGH. This plan changes what viewers see, on every render
  path: the Metal and CPU compositors, the Windows D3D11 session, the
  legacy FFmpeg graph and the Electron proof surface. A bug is visible on
  stream and burned into recordings. It is bounded in three ways:
  - Banners reuse the overlay placement model and the leg plan unchanged
    (`docs/overlays.md`).
  - They never touch capture or the scene graph.
  - Images are prepared off the render thread and drawn as 1:1 blits.
- **Depends on**: nothing merged. PR #704 (drop and multi-select import for
  takeovers) is open. If it lands first, S5 reuses its drop path; if not,
  drop import for banners is a follow-up.
- **Category**: feature (stream graphics)
- **Planned at**: commit `dacbec26` (origin/main), 2026-10-20
- **Route**: Orchestrator, fit 10. The work spans the backend compositor on
  every platform, the wire contracts, the renderer UI and the remote
  surfaces. Model lanes per slice:
  - `fable-5`: S1, S3, S4, S8. These cover storage, the render paths and
    the artifact smoke. They are release-critical, and preview and recording
    must stay in parity.
  - `gpt-5.5`: S2 and S7. Contracts and wiring are mechanical, with clear
    acceptance.
  - `opus-4.8`: S5 and S6. Assets and the Scene inspector are taste-heavy
    UI. Load `.claude/skills/videorc-design/SKILL.md` and the shadcn skill
    first.
  - Escalate to `fable-5` without asking if a by-eye pass comes back below
    the bar.

## Goal

A streamer imports an image once, for example a sponsor strip, "Follow me
@handle", a logo or a full-frame frame with a transparent hole. They place
it anywhere on the picture and show or hide it with one click while
recording or live. It looks exactly the same in the preview, the recording,
the horizontal stream and the vertical stream. Videorc tells them what size
the image should be, both at import ("sharp sizes") and for the exact spot
where they put it ("your image is 800 × 133 px: it will look soft at this
size, use one at least 2304 × 384 px").

## What exists today (verified at `dacbec26`)

Paths are under `crates/videorc-backend/src/` or `apps/desktop/src/` unless
stated.

### Overlay items: the placement and output model banners reuse

`docs/overlays.md` defines the three overlay items: the highlight card,
captions and the Buddy.
- **Places**: each has a normalized `OverlayRect` per orientation, horizontal
  and vertical (`overlay_layout.rs:94-108`).
- **Output switches**: **Show on stream** and **Show in recording**.
- **Where they burn**: one pure leg plan decides which output carries each
  item (`overlay_leg_plan`, `overlay_layout.rs:447`). When both switches
  cannot be honoured, the D13 sentence appears in the Go Live sheet
  (`overlay_start_notices`, `overlay_layout.rs:577`).
- **One drawing oracle**: `overlay_blit_layout` (`overlay_layout.rs:353`)
  places a bitmap 1:1 for CPU, Metal and D3D11.
- **Editing**:
  - They are placed on the Scene canvas (`beginOverlayGesture`,
    `components/scene/scene-stage.tsx:542`; inspector `OverlayItemInspector`,
    `components/tabs/layout-tab.tsx:1336`).
  - They stay editable while recording or live. Sources do not
    (`SCENE_POSITION_LOCK_REASON`, `layout-tab.tsx:86`).
- **Storage**: the layout is a fixed three-key struct stored in the
  `app_settings` row `overlayLayout`. It has no room for a variable list.
- **Limits that banners must lift**:
  - The bitmap keeps its pixel size and is never scaled.
  - The CPU blit treats alpha as a threshold when it scales
    (`compositor.rs` `blit_rgba_to_yuv420p`, `if a < 16 { continue; }`).
    Only `composite_overlay_at` (`compositor.rs:8989`) blends true straight
    alpha, and only 1:1.
  - The overlay slots are session-gated, so overlays never appear on the
    idle preview.

### Takeovers: the import and lifecycle model banners reuse

Plan 182 is merged.
- **Import**: main's picker (`pickScreenImage`, `main/index.ts:13596`)
  issues a resource capability (`issueResourceCapability`, `:9608`). The
  backend imports on its own `AssetImport` lane (`main.rs:5734`) into
  SQLite `stream_screens` (`storage.rs:6905`) and the managed dir
  `userData/Screens`.
- **Display**: the renderer reads `videorc-asset://screen/<file>`
  (`resolveManagedScreenFile`, `index.ts:14076`).
- **Activation** is a LiveControl-lane RPC (`screens.activate`).
- **Remote**: intents `takeoverShow` / `takeoverHide` exist
  (`remote_control.rs:54`, `lib/remote-surface.ts:371`, the Stream Deck
  plugin, the phone page).
- **What banners must not copy**: the takeover import flattens every image
  to a 3840×2160 `rgb24` frame with a blurred fill
  (`storage.rs import_screen_image`, `:5917`), which **loses alpha**.

### Compositor: one choke point, five render paths

- **The choke point**: `publish_compositor_frame` (`compositor.rs:7527`)
  snapshots everything once per tick in `CompositorRenderCache::from_runtime`
  (`:852`), then splits.
- **The paths after the split**:
  - Metal: `try_gpu_compose_with_chrome` (`:6385`), used for the native
    preview, the recording and the stream.
  - CPU: `render_compositor_yuv420p_frame` (`:8071`), used on Linux, as the
    Windows fallback and as the macOS fallback.
  - The auxiliary leg (vertical stream or split stream):
    `publish_auxiliary_compositor_frame` (`:7991`).
- **Windows D3D11**: its media session reads takeover and background images
  live per tick through `windows_scene_images` (`compositor.rs:4371`,
  `windows_d3d11_session.rs:841`). The direct D3D11 recording path takes no
  scene at all (`recording.rs:4303`).
- **Legacy FFmpeg graph**: used for 4K60 recordings and for the bridge-off
  override. It is static per session; its only live layer is the takeover's
  full-canvas RGBA FIFO at 4 fps. That FIFO exists only when the session
  starts with a takeover or streams (`recording.rs:4117`).
- **Electron proof surface**: the Windows idle preview and the Linux preview
  draw image layers in main (`buildPreviewSurfaceScene`, `index.ts:5012`).
- **Image caching**:
  - Metal uploads immutable textures once per content key. Its key-addressed
    slots allow one per namespace (`KEYED_TEXTURE_NAMESPACES = [7]`,
    `metal_compositor.rs:295`, the Buddy).
  - The compositor image cache pins at most two images, the takeover and the
    background (`COMPOSITOR_IMAGE_CACHE_MAX_PINNED_ENTRIES = 2`,
    `compositor.rs:85`, with an assert in `set_pinned_keys`).
  - The Buddy pet atlas is the template for scaled images with alpha. It is
    pre-scaled off-thread with Lanczos3 on premultiplied pixels and drawn
    from a key-addressed texture (`buddy_sprite.rs:7`, `:569`).
- **Decoding**: `image = "0.25"` with png, jpeg and webp. There is no GIF
  decoder, and D3D11 marks `AnimatedImage` unsupported.

### Live controls

- **Stream Manager** is a separate window with no backend socket. Its
  actions relay through main to the Studio renderer (Mark clip:
  `comments-window:clip-mark`, `index.ts:15306`; status bar
  `components/stream-manager/stream-manager-status-bar.tsx:291-310`).
- **Chat composer commands**: `/marker` and `/help` (`ComposerCommand`,
  `shared/session-markers.ts:209`).
- **Command palette**: has a Scenes group
  (`components/command-palette.tsx:346`).
- **Buddy voice grammar**: already owns "show … / hide … / take … down" for
  the highlight card (`cohost_command.rs:146-172`).

### Prior art and rules this plan must respect

- **No prior plan proposes banners, logos or watermarks.** The web site
  promises "no watermark" (videorcweb `app/premium/page.tsx:32`), so
  Videorc never injects its own branding.
- **Owner 2026-10-12**: no feature switches beside Record and Go Live in
  Studio. Prefer one button in Stream Manager, a chat `/command` and a
  Buddy voice phrase.
- **Owner 2026-10-11**: check the UI in light and dark.
- **Vocabulary**: "Source" is a capture input only, "Takeover" is a full
  frame, "Preset" is quality only, and "Import…" (never "Upload") brings in
  a local file (`CONTEXT.md`, `docs/ui-copy.md`).

## Owner decisions (answer before S1)

Each decision has a recommendation, and the slices below assume it. ⚑
marks the ones most worth a look.

**Answered 2026-10-20:** the owner said "this one can be available for
free, we can have one set of banners in the beginning, Scene page is
probably good to control this one, yes for stacking order, I think it's
good like you said".

- D2: free.
- D3: one set of banners to start.
- D4: the Scene page controls banners, and there is no Studio section. The
  live mirrors stay as recommended: Stream Manager, `/banner`, ⌘K and the
  remotes. They follow the owner's 10-12 rule of one button, a chat command
  and voice.
- D5: the stacking order as recommended.

D1 and D6–D11 were not raised separately, so their recommendations stand.
Ask before building if any of them should change.

**Answered 2026-10-20, later:** "Execute the entire plan and create a PR."
D11 changes: Phase 2 (S10 timer, S11 voice) is built in the same PR, after
Phase 1's slices. The owner's by-eye pass covers both phases.

| #     | Question | Recommendation |
| ----- | -------- | -------------- |
| D1    | What is it called? | **Banner**, everywhere in copy, plus a `CONTEXT.md` entry. Avoid "overlay" (it is an internal word for the three existing items), "image source" ("source" means a capture input), "sticker" and "Sponsors" (the web already has a "Sponsor Videorc" program). |
| D2 ⚑  | Free or Premium? | **Free.** It is local, Videorc pays nothing to serve it, and it is a layout control, which the open-core boundary keeps free (`docs/distribution.md`). Image overlays were made free in plan 164 D6. It also helps the "Go live everywhere. Free." story. |
| D3 ⚑  | One set for everything, or per saved scene? | **One set.** A banner that is showing stays when you switch scenes, like the highlight card and the Buddy. Saved scenes do not remember banners, because plan 044 keeps on-stream items out of saved scenes. Whether a banner is showing **survives a relaunch**, unlike a takeover: a "Follow me" banner is part of your look. Per-scene banners are a follow-up. |
| D4 ⚑  | Where do you control them? | Each control has one home. **Assets → Banners** manages them: import, rename, order and delete. The **Scene** page places them and shows or hides them, through its Banners section and the canvas. While on air there are mirrors: a **Banners** button in Stream Manager, `/banner` in the chat composer, ⌘K, and the Stream Deck and phone. **No Studio section**, per the owner's 10-12 rule; the alternative is a Banners section under Takeover in the Studio inspector. Buddy voice comes in Phase 2. |
| D5    | What draws on top of what? | **Scene → takeover → banners → captions → Buddy → highlight card.** Banners stay over a takeover ("Be right back" with "Follow me" still showing). Captions, the Buddy and the card stay on top because they are urgent and change live. Among banners, the Assets order decides, and a later banner draws on top. The inspector has Bring to front and Send to back. |
| D6    | Can a banner be on the stream but not in the recording? | **Yes.** Each banner has two switches, **Appears in: Stream** and **Recording**, both on by default. They follow the overlay leg plan and its D13 sentences unchanged, with the mid-sentence label `banners`. They are labelled "Appears in", not "Show on stream", because banners already have Show and Hide. |
| D7    | Limits | PNG, JPEG or WebP; up to 25 MB and 40 megapixels per file. Videorc stores a copy whose longest side is at most 3840 px; it keeps alpha and applies the photo's rotation (EXIF orientation). At most **24 banners** in Assets and **4 showing at once**. Animated images are refused ("Animated images aren't supported yet. Export a still PNG."). |
| D8 ⚑  | Recommended sizes | **Two kinds.** (a) Fixed "sharp sizes" in the Assets description: wide banner 2400 × 400, logo 512 × 512, full frame 3840 × 2160. Each is sharp at its default place on a 4K recording. (b) The Scene inspector computes the exact size for where you put the banner: "Your image is 800 × 133 px: it will look soft at this size. Use one at least 2304 × 384 px." See "Recommended sizes". |
| D9    | Editing while recording or live | Place, size, opacity, both switches, order and Show/Hide all work while recording or live, as overlay items do. A move lands when you release, with no glide. **Delete** of a banner that is showing is refused during a session ("Hide this banner before you delete it."). Import works while live (the plan 182 lane). |
| D10   | Motion | **A 200 ms fade on Show and Hide.** On the 4K60 legacy path it is instant. Moves and resizes jump to the new place on release. |
| D11   | Phase 2 | Build after the owner's by-eye pass on Phase 1. S10 is a **timer**: "Hide after 30 s" and "Show every 15 min", for sponsor rotation. S11 is **Buddy voice**: "show the sponsor banner", "hide the banners". |

## Design

### What a banner is

A row in a new backend table `banners`:

| Field | Meaning |
| ----- | ------- |
| `id` | UUID, stable. Used by remotes, the Stream Deck and the chat command. |
| `name` | The file stem at import (trimmed to 40 characters), renamable. |
| `imageFile`, `thumbnailFile` | Basenames `<id>.png` and `<id>.thumb.png` in the managed `Banners` dir (beside `Screens`). Only basenames reach the renderer, never a path. |
| `width`, `height` | Pixel size of the stored image. |
| `hasAlpha` | Whether any pixel is not fully opaque. Shown in the inspector. |
| `sortOrder` | Assets order, which is also the drawing order: later is on top. |
| `shown` | Showing now. Persists across a relaunch (D3). |
| `horizontal`, `vertical` | `OverlayRect` places, `x y w h` in canvas units, one per orientation. |
| `showOnStream`, `showInRecording` | The "Appears in" switches (D6). Both default to true. |
| `opacity` | 0.2 to 1.0, default 1.0. |
| `createdAt`, `updatedAt` | Timestamps. |

**Drawing rule.** The image is drawn **contained** in its rect: it keeps its
aspect ratio and hugs the rect edge given by the overlay gravity rule.

**Resizing.** On the canvas a resize keeps the image's aspect ratio, so the
rect normally fits the image exactly. If the output aspect changes later,
the picture is never stretched.

### Recommended sizes

**Fixed sharp sizes** go in the Assets → Banners description. The section
description is where the design skill puts the rules a streamer needs.

| Kind | Sharp size | Why |
| ---- | ---------- | --- |
| Wide banner (sponsor strip, "Follow me") | 2400 × 400 (6:1) | Its default width is 60 % of the canvas, which is 2304 px on a 4K recording. |
| Logo or badge | 512 × 512 | Its default height is 20 % of the canvas, which is 432 px on 4K. |
| Full frame (a frame with a transparent hole) | 3840 × 2160 (1920 × 1080 if you record at 1080p) | It covers the whole canvas. |

**Size for this place** goes in the Scene inspector. It is computed by a
pure helper, `bannerSizeAdvice`, in `lib/banner-size.ts`:

1. For every canvas the banner can appear on, take the contained draw size
   of the image in the rect:
   - the Output resolution with the horizontal rect;
   - the vertical stream canvas, when a vertical destination is armed, with
     the vertical rect;
   - a vertical program canvas, with the vertical rect.
2. `needed` is the largest of those draw sizes, rounded up to even pixels.
3. The verdict is **sharp** when `image.width ≥ 0.9 × needed.width`, because
   an upscale of up to 10 % does not show. Otherwise it is **soft**.
4. The copy (the canvas in the first line is the largest one):
   - Line 1: "Size on your 3840 × 2160 recording: 2304 × 384 px".
   - Line 2, sharp: "Your image is 2400 × 400 px: sharp at this size."
   - Line 2, soft: "Your image is 800 × 133 px: it will look soft at this
     size. Use one at least 2304 × 384 px."
   - Line 2 is plain text with a warning icon when soft, never `text-subtle`.

**Default places** are computed once at import by a pure Rust helper,
`banner_default_places(width, height)`, from the image aspect
`a = width / height`. Canvases are assumed to be 16:9 and 9:16, and drawing
is contained in any case.

| Shape | Horizontal place | Vertical place |
| ----- | ---------------- | -------------- |
| Full frame: `abs(a − 16/9) ≤ 0.02` and `width ≥ 1280` | `0 0 1 1` | Full width, centred vertically |
| Wide: `a ≥ 2.5` | 60 % wide, bottom centre, 4 % margin | Full width between the portrait side margins, bottom edge at 0.78 (the 22 % portrait safe area) |
| Tall: `a ≤ 0.6` | 70 % high, right edge with a 4 % margin, top at 0.15 | 40 % high, right edge with a 4 % margin, top at 0.30 |
| Badge: anything else | 20 % high, top right, 4 % margin | 30 % wide (or 30 % of the height when tall), top right below the 8 % safe top |

Every rect is clamped inside 0..1 with sides of at least 0.02, the overlay
rule.

Pinned numbers (2026-10-20). The margins are the existing constants in
`overlay_layout.rs`: `LANDSCAPE_SIDE_MARGIN` = 0.0225,
`LANDSCAPE_EDGE_MARGIN` = 0.04, `PORTRAIT_SIDE_MARGIN` = 0.071111,
`PORTRAIT_TOP_MARGIN` = 0.08 and `PORTRAIT_BOTTOM_MARGIN` = 0.22. On a
canvas of aspect `C` (16/9 horizontal, 9/16 vertical), a rect's two sides
are linked by `h = w × C / a`.

- **Full frame**
  - Horizontal: `0 0 1 1`.
  - Vertical: `w = 1`, `x = 0`, `y = (1 − h) / 2`.
- **Wide**
  - Horizontal: `w = 0.60`, `x = 0.20`, `y = 1 − 0.04 − h`.
  - Vertical: `w = 1 − 2 × PORTRAIT_SIDE_MARGIN`, `x = PORTRAIT_SIDE_MARGIN`,
    `y = 0.78 − h`.
- **Tall**
  - Horizontal: `h = 0.70`, `x = 1 − LANDSCAPE_SIDE_MARGIN − w`, `y = 0.15`.
  - Vertical: `h = 0.40`; if `w` would be over
    `1 − 2 × PORTRAIT_SIDE_MARGIN`, shrink both sides; then
    `x = 1 − PORTRAIT_SIDE_MARGIN − w` and `y = 0.30`.
- **Badge**
  - Horizontal: `h = 0.20`, `x = 1 − LANDSCAPE_SIDE_MARGIN − w`, `y = 0.04`.
  - Vertical: `w = 0.30 × min(a, 1)`, `x = 1 − PORTRAIT_SIDE_MARGIN − w`,
    `y = 0.08`.

Round each value to 6 decimals, then clamp. `banner_default_places` is
Rust-only (the renderer receives the stored rects), with a unit test for
each row.

**Where the image lands inside its rect** (`banner_draw_rect` in Rust,
`bannerDrawRect` in TS). Both must reproduce every case in
`protocol-fixtures/banner-geometry.json` exactly:

1. `(left, top, right, bottom) = OverlayRect::pixels(canvas)`.
2. `rw = max(1, right − left)` and `rh = max(1, bottom − top)`.
3. Fit the image's longer side to the rect:
   - If `iw × rh ≤ ih × rw`, then `dh = rh` and
     `dw = min(rw, max(1, round(iw × rh / ih)))`.
   - Otherwise `dw = rw` and `dh = min(rh, max(1, round(ih × rw / iw)))`.
   - `round` is half away from zero. JS `Math.round` matches it for these
     positive values.
4. Horizontal position from `OverlayRect::horizontal_gravity`:
   - Left: `dx = left`.
   - Center: `dx = left + floor((rw − dw) / 2)`.
   - Right: `dx = left + rw − dw`.
5. Vertical position: `dy = top + rh − dh` when `bottom_gravity()`, else
   `dy = top`.
6. Finally `dx = min(dx, W − dw)` and `dy = min(dy, H − dh)`.

### Where it draws

Every path draws banners after the scene and the takeover, and before
captions (D5).

| Path | How a banner is drawn |
| ---- | --------------------- |
| **Metal** (macOS preview, recording, stream, both legs) | A blended quad (`blend: true`) from a key-addressed texture in a new namespace 9. The slot key is `(namespace, banner id)` and the content key is the prepared revision, so the texture uploads once per prepare and never per frame. Opacity × fade goes in the existing per-layer opacity. |
| **CPU** (Linux, Windows fallback, macOS fallback) | `composite_overlay_at` with a new `opacity` argument (true straight-alpha blend, 1:1). |
| **Windows D3D11 media session** | `windows_scene_images` returns banner images too. They become immutable `BgraUpload` image layers at z 6–9, below captions at 10, with `effects.opacity`. They update live per tick, like the takeover. |
| **Windows direct D3D11 recording** | Not chosen when a banner is showing at start. A banner shown later is refused (see "Refusals"). |
| **Legacy FFmpeg graph** (4K60, bridge off) | Banners are composed into the takeover's full-canvas RGBA FIFO frame at 4 fps (takeover first, then banners). The FIFO is also created when a banner is showing at start. Show and Hide are instant here. A banner shown later on a session without the FIFO is refused. |
| **Electron proof surface** (Windows idle preview, Linux preview) | `buildPreviewSurfaceScene` adds an image layer per banner from `videorc-asset://banner/<file>`, placed by the same contained-rect maths (a TS twin of the Rust function, pinned by a shared fixture). |

**Prepared bitmaps** are what make 1:1 drawing possible on every path.
- A `BannerPrepare` worker runs on `spawn_blocking`, outside the compositor
  lock.
- It decodes the stored PNG, scales it to the exact contained pixel size for
  each canvas it appears on, using Lanczos3 on premultiplied pixels and then
  un-premultiplying (the `buddy_sprite.rs` recipe, so soft edges get no
  halo), and bakes in the opacity.
- It stores BGRA and RGBA in a `BannerBitmapCache` keyed by
  `(banner id, file revision, canvas w×h, rect, opacity)`.
- The cache budget is **160 MB**: four 4K full frames plus their vertical
  twins fit. A Show that would exceed it is refused (see "Refusals").
- A re-prepare is triggered by:
  - Show;
  - a rect or opacity change;
  - an output canvas change;
  - a session start that adds a vertical leg.
- Until it lands, the last prepared bitmap is drawn: scaled into the new
  rect on Metal (linear sampler) and at its old size on CPU and D3D11. No
  frame is ever skipped or blanked waiting for a prepare. A prepare for a
  4K full frame must finish in under 150 ms on the owner's Mac.

**State plumbing.**
- `CompositorRuntime` gains `banners: Arc<BannerSet>` at snapshot level,
  next to the takeover, not inside `Scene`. The primary leg, the auxiliary
  leg and the idle preview therefore read one set.
- Showing, hiding, reordering or re-placing a banner swaps the `Arc`. The
  next tick sees it. No scene commit and no capture change is involved.
- `from_runtime` clones the `Arc` once per tick.
- The draw helper `draw_banners(inputs, leg)` is called from all three
  branches of `try_gpu_compose_with_chrome` (takeover, missing placeholder,
  normal) and from `render_compositor_yuv420p_frame` before the caption
  blit.
- The rect for each canvas comes from `OverlayOrientation::for_canvas`.

**Which leg carries a banner.**
- **Idle**: the preview draws every banner that is showing and has at least
  one switch on.
- **During a session**: per banner, the leg plan is
  `overlay_leg_plan(record, stream, aux_leg, showOnStream, showInRecording)`.
  The `shared_leg_fallback` applies when it `needs_split` and the session
  has no split, exactly as for the highlight card and the Buddy.
- **Mid session**: switch changes re-plan in place (the
  `update_overlay_flags` pattern, `compositor.rs:600`).
- **Go Live sheet** (`overlay_start_notices` plus its TS twin): one D13
  sentence covers all banners, built byte for byte the same in Rust and TS:
  - "Both the stream and the recording will include banners: this computer
    shares one encode for them."
  - "Recording will include banners while streaming vertical."
  - "The horizontal stream will include banners while streaming vertical."

**Fade (D10).**
- Each `BannerLayer` carries `fade_from` and `fade_started_at`. The opacity
  factor is computed once per tick at the snapshot over 200 ms (ease-out).
  A hidden banner keeps drawing until its fade-out ends, then leaves the
  set.
- The pre-baked opacity times the fade factor is the layer opacity, so the
  bitmap is never re-prepared for a fade.
- The legacy FIFO and the proof surface switch instantly.

### Import

1. **Main**: `banners:pick-image` opens `dialog.showOpenDialog` for png, jpg,
   jpeg and webp, then `issueResourceCapability(path, 'input-file')`, the
   same as `pickScreenImage`. If PR #704 has merged, its preload drop-path
   bridge and multi-select apply to banners too, in S5.
2. **Backend**: `banners.importImage {sourceCapability}` runs on the
   existing `AssetImport` lane (one import process-wide, never in the
   LiveControl, Stop or AccountMaintenance lanes). Steps:
   1. Resolve the capability, then sniff the magic bytes: PNG, JPEG or
      RIFF/WEBP; anything else is `not-an-image`.
   2. Refuse animated PNG (an `acTL` chunk) and animated WebP (an `ANIM`
      chunk).
   3. Refuse files over 25 MB, or with more than 40 MP from the header (use
      `into_dimensions` before decoding), or with a side under 16 px.
   4. Refuse if there are already 24 banners.
   5. Decode with `image::ImageReader` under `Limits { max_alloc: 192 MB }`
      and apply the EXIF orientation.
   6. Downscale to a longest side of at most 3840 px with premultiplied
      Lanczos3.
   7. Compute `hasAlpha`.
   8. Write `<id>.png` atomically (`atomic_file.rs`) to `userData/Banners/`.
   9. Write a thumbnail of about 480 px, `<id>.thumb.png`.
   10. Insert the row with `banner_default_places`, `shown = false`, both
       switches on and opacity 1.0.
   11. Emit `banners.changed`.
3. **Failure**: nothing is published half done (the plan 182 rule). The
   import never auto-shows the new banner.

**Refusals.** Each is a warning, never an error, and its sentence is
verbatim:
- "This file isn't a PNG, JPEG or WebP image."
- "Animated images aren't supported yet. Export a still PNG."
- "This image is too large. Use one under 25 MB and 40 megapixels."
- "You have 24 banners. Delete one to import another."
- "Four banners are showing. Hide one first." (a fifth Show, or the 160 MB
  budget)
- "This recording can't add banners after it starts. Show the banner before
  you press Record." (legacy FFmpeg without the FIFO, or Windows direct
  D3D11)
- "Hide this banner before you delete it." (Delete of a showing banner
  during a session)

### Wire shape

**Backend RPCs.** Strict schemas (`allowUnknown: false`) in
`shared/backend-rpc-contract.ts`. The Rust rows go in the `main.rs`
mutation and lane tables, next to the `screens.*` rows (`main.rs:5520-5750`).

| Method | Lane | Params → result |
| ------ | ---- | --------------- |
| `banners.list` | observation | → `Banner[]` |
| `banners.importImage` | AssetImport | `{sourceCapability}` → `Banner` |
| `banners.update` | mutation | `{id, name?, horizontal?, vertical?, showOnStream?, showInRecording?, opacity?, hideAfterSec?, repeatEveryMin?}` → `Banner` |
| `banners.reorder` | mutation | `{ids}` → `Banner[]` |
| `banners.delete` | mutation | `{id}` → `Banner[]` (the remaining list; deletes the row and both files; refuses a path outside the managed `Banners` dir) |
| `banners.show` | LiveControl | `{id}` → `Banner` |
| `banners.hide` | LiveControl | `{id?}` → `Banner[]` (no `id` hides all) |

Event `banners.changed` carries the full list to every window.

**`Banner` on the wire** (pinned 2026-10-20; the example is
`protocol-fixtures/high-risk-contracts.json` → `banner.minimal` /
`banner.withTimer`):
- camelCase:
  `{id, name, imageFile, thumbnailFile, width, height, hasAlpha, sortOrder, shown, horizontal, vertical, showOnStream, showInRecording, opacity, hideAfterSec?, repeatEveryMin?, createdAt, updatedAt}`.
- `horizontal` and `vertical` are `OverlayRect {x, y, w, h}`.
- The only optional fields are the Phase 2 timer, `hideAfterSec` and
  `repeatEveryMin`. They are omitted when off (`skip_serializing_if`; never
  `null`). In `banners.update`, `0` turns a timer off.
- The renderer builds `videorc-asset://banner/<imageFile>` itself, the way
  takeover cards do with their basename.

**Refusals** come back as ordinary RPC errors whose message is the exact
sentence from "Refusals". The renderer shows any `banners.*` refusal as a
warning, never an error toast.

**Remote intents** (`remote_control.rs` `RemoteIntent`,
`docs/remote-control.md`):
- `bannerShow {bannerId}`, `bannerHide {bannerId?}` and
  `bannerToggle {bannerId}`, debounced in the takeover bucket.
- `remote.describe` gains `banners: [{id, name, shown}]`.

**Phone (LAN) leak argument**, which the PR must repeat:
- Ids are opaque UUIDs.
- Names are labels the streamer typed for graphics they show viewers.
- No file paths and no image bytes cross the LAN. The phone shows names
  only.
- No route is added to the LAN router and nothing is added to `LAN_EVENTS`.
  The intents ride the existing `remote.intent` and `remote.describe`.

### UI

Load `.claude/skills/videorc-design/SKILL.md` first. Check every surface in
light **and** dark.

**Assets → Banners**: a new `PanelSection` between Backgrounds and
Takeovers (`components/tabs/assets-tab.tsx:196-311`):

```
Banners                                                  [Import image…]
Images you place on your picture: a sponsor, your socials, a logo.
PNG with transparency works best. Sharp sizes: wide banner 2400 × 400,
logo 512 × 512, full frame 3840 × 2160.

┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ ░▒ checker ▒░ │ │  ACME  ►►►    │ │  @theorcdev   │
│  [logo.png]   │ │               │ │               │
├───────────────┤ ├───────────────┤ ├───────────────┤
│ Logo  Showing ⋯│ │ Sponsor      ⋯│ │ Follow me    ⋯│
└───────────────┘ └───────────────┘ └───────────────┘
```

- **Tiles** are `MediaCard`s. A neutral grey checkerboard sits behind the
  image so transparency is visible; it is monochrome, per the design rules.
- **Showing** uses the one "in use" treatment: a ring plus a neutral chip.
- **Kebab** (`KebabMenu`, `reveal="hover"`, destructive last): Show / Hide,
  Place on Scene, Rename…, Move earlier, Move later, Delete….
- **Keyboard**: Alt+←/→ reorders (the takeover pattern, plan 174 S3.10).
- **Delete…**: `ConfirmDialog`, title "Delete banner?", body "“Sponsor” and
  its image will be deleted. This can't be undone.", button "Delete banner".
- **States**:
  - Import pending: "Choosing image…", then "Importing…", with the shared
    Spinner and no percentage.
  - A failure goes through `toastUserError`: "Couldn't import the image"
    plus the refusal sentence.
  - Loading and offline states come before the empty state.
  - Empty: `Empty` with "No banners yet" and an Import image… action. The
    sharp-sizes line stays in the description.

**Scene page**

- **Banners section** in the inspector, below the existing items. It is a
  `GroupedList` of 32 px `ListRow`s:
  - Each row: thumbnail, name, a Showing chip and an `xs` **Show** / **Hide**
    button.
  - Clicking a row selects that banner on the stage.
  - Empty: "No banners yet." with an **Open Assets** button.
- **Stage**:
  - Showing banners, plus the selected one, appear as overlay items: a chip
    in the toolbar `ToggleGroup` with the banner's name, and a dashed rect.
    They are drawn the way each platform draws overlay items today.
  - A selected hidden banner is drawn dimmed with a "Hidden" badge (the plan
    174 S3.9 "off" treatment).
  - Gestures use `beginOverlayGesture` with `locked = true` and the image's
    aspect converted to canvas units.
  - A released gesture is one `banners.update`.
  - While idle on macOS, the chrome-only draft is extended so the banner
    picture follows the pointer: `snapshot_with_editor_draft` looks up
    banner stage ids too. A resize shows the last prepared bitmap scaled,
    and a re-prepare follows the release. The acceptable fallback is the
    chrome-only draft that overlay items use today. Say in "As built" which
    one shipped.
  - The **Overlays on: Horizontal | Vertical** control places the vertical
    rect when a vertical destination is armed.
- **`BannerInspector`**, shown when a banner is selected, modelled on
  `OverlayItemInspector`:

```
Sponsor                                        [Hide]
Showing
Place      [Top left] [Top center] [Top right]
           [Bottom left] [Bottom center] [Bottom right] [Full frame]
Size on your 3840 × 2160 recording: 2304 × 384 px
⚠ Your image is 800 × 133 px: it will look soft at this size.
  Use one at least 2304 × 384 px.
Opacity    ────────●──  100 %
Appears in [●] Stream   [●] Recording
Order      [Bring to front] [Send to back]
                                   Manage in Assets →
```

- Snaps keep the banner's size and move it, unlike overlay snaps, which
  write a default size. **Full frame** sets `0 0 1 1` on the orientation
  shown.
- Opacity is the shared `ParameterSlider`.
- When the switches differ, the stage label carries the existing **stream
  only** / **recording only** badge (`overlayItemOutputBadge`).

**Stream Manager.**
- A **Banners** `StatusBarAction` next to Mark clip. It is always present,
  because banners matter in recordings too. It opens a `DropdownMenu`:
  - one `DropdownMenuCheckboxItem` per banner (checked when showing);
  - a separator;
  - **Hide all banners**.
- With no banners it has one disabled item, "Import banners in Assets".
- It is mirrored in the narrow ⋯ menu.
- Relay, the plan 156 D6 / `clip-mark` pattern:
  - `comments-window:banner-set {id, shown}` and `comments-window:banner-hide-all`
    go comments window → main → Studio renderer → backend;
  - the list reaches the window as a read-only projection push,
    `comments-window:banners-push [{id, name, shown}]`.

**Chat composer `/banner`.** `ComposerCommand` gains `banner`
(`shared/session-markers.ts:209`). The command never posts to chat.
- `/banner <name>`: toggles the banner whose name matches, case-insensitive.
  An exact match wins; otherwise a unique prefix.
- `/banner off`: hides all banners. "off" is reserved.
- `/banner` alone: the completion list shows the banner names.
- Composer errors: "No banner called “x”." and "“sp” matches Sponsor and
  Spring sale."

**⌘K.** A **Banners** group lists "Show banner: Sponsor" and "Hide banner:
Logo" for each banner, then "Hide all banners".

## Slices: Phase 1

### S0: Owner decisions

Get answers to D1–D11, or "go with the recommendations". Record them under
"Owner decisions" as **Answered <date>:**.

Done when: the answers are in this file. **Done 2026-10-20** (D2–D5
answered as recommended; the others keep their recommendations).

### S1: Backend store, import and RPCs

Files:
- `crates/videorc-backend/src/banners.rs` (new): `Banner`, the default
  places, sniffing, import, the delete path guard, and tests.
- `storage.rs`: the `banners` table migration, CRUD, and `retire`/`delete`
  helpers.
- `protocol.rs`: wire types.
- `main.rs`: the RPCs, the mutation and lane tables, and the
  `banners.changed` emit.

Steps:
1. Add the table and storage CRUD, following `stream_screens`
   (`storage.rs:6905`, `:6213-6560`).
2. Add the import pipeline from "Import", reusing the `AssetImport` lane
   and its single-admission guard.
3. Add `banner_default_places`, with unit tests for every shape row, the
   clamps and the safe area.
4. Add the RPCs in the table above, with `banners.show` and `banners.hide`
   on the LiveControl lane. Enforce the 4-showing cap here, not only in the
   UI.
5. Add the session refusal for deleting a showing banner.

Done when:
- `cargo test -p videorc-backend banners` covers:
  - the sniff table (PNG, JPEG, WebP, animated PNG, animated WebP, a text
    file renamed `.png`);
  - the 25 MB, 40 MP and 16 px limits;
  - the 24-banner cap;
  - EXIF rotation;
  - alpha kept, with a red half-transparent pixel surviving the round trip;
  - the 3840 cap;
  - the default-place table;
  - the cap of 4 showing;
  - delete outside the root refused;
  - an import concurrent with `banners.show` that does not block it (a
    regression test in the style of plan 182).
- `cargo clippy -p videorc-backend -- -D warnings` is clean for the new
  module.

### S2: Contracts, main process and asset protocol

Files: `shared/backend.ts`, `shared/backend-rpc-contract.ts` (+ test),
`shared/electron-ipc-contract.ts` (+ test), `protocol-fixtures/high-risk-contracts.json`,
`shared/protocol-contract-fixtures.test.ts`, `preload/index.ts`,
`preload/api-policy.ts`, `main/index.ts`.

Steps:
1. Add the types and strict schemas for `Banner` and every method and event,
   registered in `runtimeContracts` and `runtimeEventSchemas`. Add a
   high-risk fixture for `Banner`, including `null`-free optional fields
   (the serde null trap: `skip_serializing_if` on every `Option`).
2. Add `banners:pick-image` (main dialog plus capability) through the full
   IPC chain.
3. Add a `videorc-asset://banner/<file>` host with a
   `resolveManagedBannerFile` root resolver (realpath, no symlinks; mirror
   `resolveManagedScreenFile`, `index.ts:14076`). The managed dir is
   `Banners` beside `Screens`.

Done when:
- `pnpm --filter @videorc/desktop test -- backend-rpc-contract electron-ipc-contract protocol-contract-fixtures`
  passes.
- `pnpm typecheck` passes.
- A Rust serialization test proves that a `Banner` with no optional fields
  emits no `null`.

### S3: Compositor: Metal, CPU, both legs, fade

Files: `compositor.rs`, `metal_compositor.rs`, `overlay_layout.rs`, and a
new `banner_prepare.rs`.

Steps:
1. Add `BannerSet` and `BannerLayer` on `CompositorRuntime`. Install them
   from S1's show, hide and update paths through one
   `install_banner_set(state)` that reads storage. Also install at backend
   start, because `shown` survives a relaunch.
2. Add the `BannerPrepare` worker, the `BannerBitmapCache` and the 160 MB
   budget. This is a separate cache; do **not** touch
   `COMPOSITOR_IMAGE_CACHE_MAX_PINNED_ENTRIES`.
3. Snapshot the set in `from_runtime`. Add `banners` to
   `CompositorRenderInputs` (`compositor.rs:8042`) for both legs.
4. Add `draw_banners` to all three Metal branches and to the CPU path, with
   the z order from D5.
5. Metal: extend the key-addressed slots to `(namespace, key)` with a
   bounded map (at most 4 entries for namespace 9), keeping the Buddy
   (namespace 7) unchanged.
6. CPU: add `opacity` to `composite_overlay_at`, with every existing caller
   passing 1.0.
7. Leg plan per banner, the in-place re-plan, the D13 notices with the label
   `banners`, and the TS twin in `lib/overlay-layout.ts`.
8. The fade (D10).

Done when:
- `cargo test -p videorc-backend banner` and `cargo test -p videorc-backend overlay_layout`
  cover:
  - a new `cpu_and_metal_draw_the_same_banner` parity test (half-alpha
    edges, opacity 0.5, a banner overlapping the highlight card, which wins)
    that runs on the owner's Mac and skips elsewhere like its siblings;
  - the leg plan per banner across the exhaustive session table;
  - the notice sentences pinned byte for byte, with `lib/overlay-layout.test.ts`
    pinning the same strings;
  - prepare-off-lock (a slow prepare never delays a tick);
  - the budget refusal;
  - the fade curve at 0, 100 and 200 ms;
  - the vertical leg drawing the vertical rect.
- `compositor_scene_switch_tests` still pass.
- No test sees a per-frame texture upload in steady state (assert the
  upload counter does not change across 120 ticks).

### S4: Windows D3D11, legacy FFmpeg and the proof surface

Files: `compositor.rs` (`windows_scene_images`), `windows_d3d11_session.rs`,
`windows_d3d11_compositor.rs`, `recording.rs`, and `main/index.ts`
(`buildPreviewSurfaceScene`).

Steps:
1. D3D11: return banner images from `windows_scene_images`. Build image
   layers at z 6–9 with `effects.opacity`. Add a Windows parity fixture,
   `windows_banner_layers_sit_between_scene_and_captions`.
2. Direct D3D11 recording (`recording.rs:4303`): add "no banner showing" to
   the gate. A later Show on that session is refused with the legacy
   sentence.
3. Legacy FFmpeg:
   - extend the FIFO condition (`recording.rs:4117`) with "a banner is
     showing at start";
   - build the FIFO frame as takeover then banners, through one pure
     `legacy_overlay_frame(takeover, banners, w, h)` with a unit test;
   - refuse a later Show when the session has no FIFO.
4. Proof surface: add image layers for banners, using a TS twin of the
   contained-rect maths pinned by a shared fixture.

Done when:
- `cargo test -p videorc-backend legacy_overlay_frame` passes.
- The Windows CI job runs the new parity fixture green; link the run in
  the PR.
- `pnpm --filter @videorc/desktop test -- preview-surface` passes.
- The Linux CI job is green. This is the compile gate for the CPU path's
  Linux arm.

### S5: Assets → Banners

Files: `components/tabs/assets-tab.tsx`, a new
`components/banners-section.tsx` (+ test), a new `lib/banner-import.ts`
(+ test, single-flight like `lib/takeover-import.ts`), and
`hooks/use-studio.tsx` (the banner list, the `banners.changed`
subscription, and the actions).

Steps:
1. Build the section from "UI → Assets → Banners". If PR #704 has merged,
   wire its drop and multi-select for banners as well, capped by the
   24-banner limit.
2. Add the copy in "Refusals" and "UI".

Done when:
- The component tests cover:
  - the loading, offline, empty and list states;
  - import pending labels;
  - each refusal through `toastUserError`;
  - the Delete confirm, plus the refusal while a session runs;
  - Alt+←/→ reorder;
  - the "Showing" ring and chip.
- `renderer-style-guards`, `renderer-copy-guards` and
  `renderer-toast-guards` pass.
- `pnpm build && pnpm check:renderer-assets` stays under the ceiling. Do not
  raise it; the section goes in the Assets lazy chunk.

### S6: Scene canvas, inspector and size advice

Files: `components/tabs/layout-tab.tsx`, `components/scene/scene-stage.tsx`,
`components/scene/overlay-stage.ts` (+ test), a new
`components/scene/banner-inspector.tsx` (+ test), a new
`lib/banner-size.ts` (+ test), `components/go-live-dialog.tsx`, and
`compositor.rs` (`snapshot_with_editor_draft`, for banner stage ids).

Steps:
1. Build the Banners inspector section and `BannerInspector` from "UI →
   Scene page".
2. Add the stage chips and rects, with the aspect-locked gesture through
   `beginOverlayGesture`. A released gesture is one `banners.update`.
3. Add `bannerSizeAdvice` and its copy.
4. Show the D13 sentences in the Go Live sheet.
5. Extend the idle draft for banners, or use the chrome-only fallback
   (record which in "As built").

Done when:
- `lib/banner-size.test.ts` covers sharp and soft at 1080p and 4K, the
  vertical stream, the 10 % allowance and even rounding.
- An `overlay-stage` test shows that a drag on a banner calls
  `banners.update` once, with an aspect-locked, clamped rect.
- `pnpm smoke:freeform-editor` still passes.

### S7: Live controls: Stream Manager, `/banner`, ⌘K, remote

Files:
- `components/stream-manager/stream-manager-status-bar.tsx`,
  `stream-manager.tsx`, `renderer/comments/main.tsx`, `main/index.ts`,
  `shared/electron-ipc-contract.ts`, `preload/api-policy.ts`;
- `shared/session-markers.ts`, `components/stream-manager/chat-pane.tsx`;
- `components/command-palette.tsx`;
- `lib/remote-surface.ts`, `remote_control.rs`, `main.rs` (dispatch),
  `apps/streamdeck-plugin/src/plugin.ts`, `apps/streamdeck-plugin/manifest.json`,
  `crates/videorc-backend/remote_web/app.js`, `docs/remote-control.md`.

Steps: build every item in "UI → Stream Manager", "Chat composer",
"⌘K" and "Remote intents". Put the leak argument into the PR description.

Done when:
- Tests cover:
  - `classifyComposerDraft` for `/banner sponsor`, `/banner off`, an unknown
    name and an ambiguous prefix;
  - the relay round trip from Stream Manager (an `electron-ipc-contract`
    test);
  - `executeRemoteIntent` for the three intents and their refusal copy;
  - `RemoteIntent` validation and debounce in Rust.
- `pnpm smoke:remote-control` passes.
- `pnpm smoke:remote-lan` passes.

### S8: Docs and the banner artifact smoke

Files:
- a new `docs/banners.md`;
- `docs/overlays.md`: a short "Banners" section and the z order line;
- `CONTEXT.md`: the **Banner** entry (D1);
- `docs/ui-copy.md`, if it lists features;
- the changelog draft entry;
- a new `scripts/smoke-banners-app.mjs`, modelled on
  `scripts/smoke-screens-app.mjs`;
- `package.json` (`smoke:banners`);
- `scripts/smoke-recording-studio.mjs`, to add the step.

What `smoke:banners` drives through the dev app:
1. It imports three fixture PNGs, generated at run time (never committed
   media):
   - a 2400×400 wide banner with a solid colour key and a 50 % alpha
     border;
   - a 512×512 logo;
   - a 3840×2160 full frame with a transparent centre.
2. It runs three sessions, each with a vertical destination armed on a
   local receiver: record only, stream only to the local RTMP receiver, and
   record plus stream.
3. During each it shows a banner, moves it mid-session, hides it, shows the
   logo with Appears in: Recording off, and shows a takeover so the
   banners stay above it.
4. It checks every artifact with ffmpeg pixel sampling at the banner rects:
   - the colour key is present while showing and absent after hide (with a
     frame tolerance for the 200 ms fade);
   - the half-alpha border is blended, not thresholded;
   - the stream-only and recording-only routing follows the leg plan;
   - the vertical leg uses the vertical rect;
   - the banner is above the takeover and below the highlight card.
5. It also checks:
   - the strict A/V analyzer on every artifact;
   - that the compositor keeps rendering during prepares (the frame-age
     bound from `smoke:screens`, 250 ms);
   - that no session or capture restarted (camera session id and recording
     id unchanged).

Done when: `pnpm smoke:banners` passes on the owner's Mac, and the
`docs/banners.md` "For developers" section names every file in this plan.

### S9: Gates (once, at the end)

Run the following and record the results in "As built".

| Gate | Why |
| ---- | --- |
| `cargo fmt --check --all`, `cargo clippy -p videorc-backend -- -D warnings`, `cargo test -p videorc-backend` (targeted filters first: `banner`, `overlay_layout`, `compositor`, `remote_control`, `storage`; then the full suite once) | Backend correctness |
| `cargo build --release -p videorc-backend` | The release-build cfg gap (memory: run it after cfg edits) |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm --filter @videorc/desktop test`, `pnpm test:scripts` | TS gates |
| `pnpm build`, `pnpm check:renderer-assets` | The renderer budget; never raise the ceiling |
| `pnpm smoke:banners` | The feature's artifact proof |
| `pnpm smoke:recording-studio` | AGENTS.md: changes to composition, preview or recording output |
| `pnpm smoke:screens` | The takeover FIFO changed |
| `pnpm smoke:comment-highlight-stream`, `pnpm smoke:captions-dual-orientation`, `pnpm smoke:captions-live` | Overlay z order and leg plan neighbours |
| `pnpm smoke:recording-matrix` | Per-frame compositor work changed; the hard-content pass proves the compositor keeps up |
| `pnpm smoke:freeform-editor`, `pnpm probe:preview-lifecycle` | Scene canvas and docked preview |
| `pnpm smoke:remote-control`, `pnpm smoke:remote-lan` | New intents and the phone deck |
| Windows CI (D3D11 parity, source gates) and Linux CI | The paths macOS cannot run |

For any smoke that fails, run it on clean `origin/main` (an APFS-cloned base
worktree, as in memory "Smoke A/B vs base"). A failure that also happens on
main is inherited; say so with both outputs. A failure that does not is
this plan's to fix.

Owner by-eye, written as `docs/acceptance/<date>-banners.md`, in light
**and** dark:
1. Import a sponsor PNG with transparency.
2. Place it bottom centre.
3. Go live to a test destination plus a vertical one.
4. Show and Hide from Stream Manager and with `/banner`.
5. Check the fade.
6. Check that the soft-size warning appears for a small image.
7. Check that the recording matches the preview.

## Slices: Phase 2 (after the owner's by-eye on Phase 1)

### S10: Banner timer (sponsor rotation)

- Add "Timing" to the inspector, folded by default:
  - **Hide after**: Off, 10 s, 30 s, 1 min or 5 min.
  - **Show every**: Off, 5, 10, 15 or 30 min. It runs only during a
    session.
- The timer is backend-owned (a tokio task per banner), so it works with
  Stream Manager closed. A manual Show or Hide always wins and resets the
  cycle; this is plan 156 D3: manual always wins.
- New `banners.update` fields `hideAfterSec?` and `repeatEveryMin?`, plus
  their contracts.
- Copy: "Shows for 30 s every 15 min".
- Done when: tokio time-paused tests cover the cycle, a manual override,
  session end stopping the timer, and a relaunch that does not resume a
  repeat until the next session. `smoke:banners` gains one timed show.

### S11: Buddy voice

- Phrases: "show the {name} banner", "hide the {name} banner" and
  "hide the banners".
- The parse runs **before** the highlight and clear grammar when the
  utterance contains "banner" or "banners", the same precedence markers use
  (`docs/buddy-commands-contract.md:39-41`).
- Update `cohost_command.rs`, `CohostCommandKind` (TS), the command cards,
  the phrase help (`lib/buddy-tab-view.ts`) and the contract doc.
- This is Premium, because Buddy is.
- Done when: the parser tests include the collision cases ("show that
  comment", "take the banner down", "hide the highlight") and
  `pnpm smoke:captions-contract` passes. The voice dialect shares the
  parser.

## Out of scope

- **Image types**: animated banners (GIF, APNG, animated WebP), video
  banners and browser or URL sources.
- **Text banners**: a maker that turns "@handle" plus platform icons into a
  banner. It would be a good follow-up plan: rasterize in the renderer like
  the highlight card, then import the result as a banner.
- **Scope**: per-scene banner sets, and per-orientation Show and Hide (one
  shown state covers both orientations).
- **Editing the image** in the app (crop, rotate, recolour).
- **Viewer interaction**: clickable links and QR codes.
- **Storage**: cloud sync of banners between machines.
- **Web**: website copy. That is a separate videorcweb PR; mind the "no
  watermark" promise and the OBS comparison post.
- **Banners in Clean cut or a post-recording clean copy.** The recording
  carries what was burned.

## STOP conditions

- The Metal path falls back to CPU, or the encoder starves (exit 187, frame
  accounting stalls), while a banner shows.
- A per-frame texture upload or a per-frame scale appears in steady state.
- Showing, hiding or moving a banner restarts capture, the camera session,
  the recording or the stream.
- A slice needs a new pixel transport into the renderer, or the renderer
  reporting screen-space bounds for a new movement path (plan 058 STOP).
- The overlay leg plan table needs a new row, or a third encoded leg would
  start.
- `check:renderer-assets` would need its ceiling raised.
- A banner import blocks the LiveControl or Stop lanes.
- A smoke in S9 fails on this branch but passes on clean `origin/main`, and
  the cause is not found within the slice.

## Performance budget

- **Steady state**: zero texture uploads, zero scales and zero decodes per
  frame. Metal adds one blended quad per showing banner per leg. CPU adds
  one 1:1 blend over the banner's pixels.
- **Prepare**: off the render thread, under 150 ms for a 4K full frame on
  the owner's Mac. The last bitmap is drawn meanwhile.
- **Memory**: the prepared cache is 160 MB at most. There is no
  decoded-source cache: a prepare decodes the stored PNG again.
- **CPU path at 1080p30 on Linux**, with four badge banners: under 2 ms
  extra per frame. Measure with the existing compositor timing
  diagnostics and record the number in "As built".

## In-flight work on these files

- **PR #694 (clips, open)**: adds a Clip button to the Stream Manager
  status bar and `/clip` to the composer. Rebase S7 on whichever lands
  first; banners sit after Clip.
- **PR #704 (drop and multi-select takeovers, open)**: touches
  `assets-tab.tsx`, `panel-section.tsx`, `takeover-import.ts` and the
  preload. S5 reuses its drop bridge if it merges first.
- **PR #632 (separate source recordings, open)**: touches `recording.rs`.
  S4's FIFO change is small; rebase carefully.
- **PR #727 (cloud, draft, never merge)**: no overlap expected. The cloud
  runner will need banners later; out of scope here.

## Model lane note

S3 and S4 are the risky slices: five render paths must agree to the pixel.
Run them on `fable-5`, and do not split S3 across agents. The parity test
is the contract. S5 and S6 are taste work for `opus-4.8`, with the design
skill loaded and screenshots in both themes. S2 and S7 are wiring for
`gpt-5.5`. Every agent prompt says: "read files with
`git show origin/main:<path>`; gates run once at the end".

## As built

_Not started._
