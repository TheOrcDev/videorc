# Plan 231: HTML overlays (animated banners with a transparent background)

> **Executor instructions**: follow the slices in order. Run every "Done
> when" check before moving on. S1 to S6 are the first vertical slice and
> ship in one PR; S7 onward are follow-ups. Gates run once at the end (owner
> rule). When a slice lands, fill in "As built".

## Status

- **Status**: S1 to S6 BUILT 2026-11-12 on `feat/html-overlays` (draft PR).
  S7 onward are follow-ups. See "As built".
- **Priority**: P1 (owner request, 2026-11-12).
- **Effort**: L. A new banner kind in the store, an import, a sandboxed
  page host in the main process, a frame transport into the backend, one
  branch in the compositor's banner draw, the Assets and Scene copy, and a
  record-and-stream smoke.
- **Risk**: MEDIUM-HIGH.
  - It runs HTML and JavaScript the streamer got from somewhere. D4 and D5
    are the fence.
  - It changes what viewers see on every macOS output leg. It is bounded
    because it rides the banner layer unchanged: one place, one leg plan,
    one z-order.
  - It adds a per-frame texture upload, which plan 186 forbade for images.
    D7 caps it and "Measured cost" records it.
- **Depends on**: plan 186 (banners), merged.
- **Category**: feature (stream graphics).
- **Planned at**: `4eec3d78` (origin/main), 2026-11-12.

## The owner's ask (2026-11-12)

> "Let's add support for HTML with a transparent background so we can add
> animated stuff on our live streams or recordings. Same thing as we have
> now for our images that we can put on our live stream to be shown. Same
> thing but with HTML."

## What a streamer gets

1. In **Assets → Banners**, next to **Import image…**, there is
   **Import HTML…**. The streamer picks an `.html` file, or a folder that
   has an `index.html` beside its images, fonts, styles and scripts.
2. The overlay is a banner. It shows as soon as it is imported (plan 205
   D3), with the page's transparent background kept and its animation
   running.
3. Everything a banner does, it does: Show and Hide, a place per
   orientation on the Scene page, opacity, **Appears in: Stream /
   Recording**, the 200 ms fade, Hide after and Show every, the Stream
   Manager menu, `/banner`, ⌘K, the Stream Deck, the phone and Buddy voice.
   None of those surfaces changed: they address a banner by id and name.
4. It looks the same in the Preview, the recording, the horizontal stream
   and the vertical stream.

## What exists today (verified at `4eec3d78`)

- **Banners** (plan 186): a `banners` row, an image in the managed
  `Banners` folder, a `BannerSet` on the compositor that every leg draws
  after the scene and the takeover and before captions
  (`banner_draws_for_leg`, `compositor.rs`). The leg plan is
  `banner_leg_carries` (`banners.rs`).
- **How a banner is drawn**: a bitmap prepared once per place
  (`banner_prepare.rs`), then a 1:1 blit. On Metal it is a key-addressed
  texture in namespace 9: slot = the banner, content key = the bitmap's
  revision. `ensure_keyed_texture` (`metal_compositor.rs`) reuses the
  texture while the size holds and uploads once per new revision. A bitmap
  that is not the exact size is scaled into the rect by the linear sampler.
- **Renderer → backend rasters today**: `captions.overlay.set`,
  `chat.overlay.set` and `buddy.overlay.set` send a PNG as base64 in a
  JSON RPC. That is fine for a card that changes a few times a minute and
  far too slow for 30 frames a second.
- **Backend → main frames today**: the native preview hands main an
  IOSurface id (`metalTargetIosurfaceId`), which main's native addon looks
  up. That works because the backend creates the surface itself. There is
  no shared-memory or IOSurface path in the other direction.
- **Main ↔ backend**: WebSocket JSON on `/ws`, plus a few HTTP routes on
  the same loopback listener, each checked with the renderer or the admin
  token (`http_backend_role`). Only main holds the admin token.
- **Electron**: 39.8. Offscreen rendering gives `paint` events with a
  bitmap. `webPreferences.offscreen.useSharedTexture` exists (experimental)
  and hands back a Chromium-owned IOSurface.

## Decisions

Each has a recommendation; the slices assume it. ⚑ marks the ones the
owner should look at.

| # | Question | Decision |
| - | -------- | -------- |
| D1 | What is it? | A **banner whose picture is a web page**. The wire and the store call it `kind: "html"`. Copy says **HTML banner** where the kind matters and **banner** everywhere else: `CONTEXT.md` keeps "overlay" out of copy for banners, so "HTML overlay" names only this plan, the code (`html_overlay.rs`, `htmlOverlays.*`) and the smoke. One list, one cap of four showing, one z-order. |
| D2 | What can be imported? | An `.html` or `.htm` file, or a folder with `index.html` at its top. Videorc keeps its own copy in `Banners/<id>.overlay/`. Limits: 64 MB, 512 files, 8 folders deep, the entry page at most 5 MB, no symbolic links. A single file is copied alone: its neighbours are not, and the import says so. |
| D3 ⚑ | How big is the page? | The page says: `<meta name="videorc-overlay-size" content="640x360">`. Without it the page is **1920 × 1080**, the size overlays made for other streaming apps use. Sides are 16 to 3840 px. It is the banner's `width` and `height`, so the default place and the contained draw follow from it. An inspector field to change it is S8. |
| D4 | How is untrusted content fenced? | Each overlay renders in its own offscreen window with its own in-memory session: sandbox on, context isolation on, no Node, **no preload at all**, no app IPC (main also sends it no broadcast and never counts it as an app window). No navigation away, no new windows, no downloads, every permission denied (camera, microphone, screen, location, notifications, clipboard, USB, HID, serial, MIDI, fullscreen, pointer lock). Its sound is muted. It can read only its own folder, through a scheme that exists only in its session. |
| D5 ⚑ | Network? | **Off.** Every request that is not the overlay's own `videorc-overlay://<id>/…`, `data:` or `blob:` is cancelled before it leaves (`webRequest.onBeforeRequest`), WebSocket included. Behind that rule the session's only proxy is a closed loopback port, and WebRTC may not use UDP outside a proxy. An overlay that needs a font or a library ships it in its folder. Blocked requests are counted, and the Scene inspector says how many. A per-overlay "Allow network" switch is S9 and needs the owner's yes: it lets the page phone home with the streamer's IP address. |
| D6 | Engine and transport? | Electron offscreen rendering in the main process, software `paint` path. Main writes each frame (premultiplied BGRA) down one long-lived loopback HTTP upload to the backend, authenticated with the admin token. The backend turns it into straight alpha off the render thread and keeps the latest frame per overlay. See "Transport". |
| D7 | Frame size and rate? | The backend names the size: the overlay's contained draw size on the largest canvas that carries it, so the page is rasterised by Chromium at the pixels it lands on. Capped at **2,073,600 px** (a 1080p frame). Rate: the compositor's rate, at most **30 fps**. A still page sends nothing after its first frame. |
| D8 | Which legs? | The banner legs, unchanged: the primary leg, the auxiliary leg (the stream leg of a record-and-stream session, the vertical stream) and the Preview's program leg. Hide screen is done at the capture source (plan 210 D8) and is not touched. |
| D9 ⚑ | Platforms? | **macOS only in this slice.** On Windows and Linux the import is refused with one sentence and the button is disabled with it. On macOS, a session on the legacy FFmpeg graph (4K60, bridge off) cannot draw one: Show is refused there, and one that already shows is left out and says so. |
| D10 | Thumbnail? | The backend saves the overlay's own picture one second after its first frame, as the banner's stored image and thumbnail. Until then the tile shows the HTML glyph. |

## Design

### Transport

The frames are the hard part. What was weighed:

| Option | Verdict |
| ------ | ------- |
| PNG over JSON RPC (the caption path) | No. Encode, base64 and decode per frame. |
| Binary WebSocket message | No. Client frames are masked: one more pass over every byte, in JavaScript. |
| Shared texture (`useSharedTexture`) | Not now. Chromium owns the IOSurface and does not make it global, so the backend cannot look it up by id. Passing it needs a Mach port between two processes that share no bootstrap name, plus native code in main. Worth it only if the measured cost says so (S10). |
| A file both sides map | No. Node has no `shm_open`; a real file means the SSD takes 100 MB a second. |
| **One streaming HTTP upload on loopback** | **Yes.** No masking, no per-frame request, the token check the other routes use, the same on every platform. |

**Wire** (`POST /html-overlays/frames?token=<admin>`, chunked; admin role
only, so the renderer and remote clients can never put pixels on the
picture). The body is records, one per frame:

```
magic      4 bytes  "VHOF"
version    u8       1
flags      u8       0
reserved   u16      0
id         16 bytes the banner's UUID
width      u32 LE
height     u32 LE
sequence   u64 LE
pixels     width × height × 4 bytes, BGRA, premultiplied alpha
```

- A record whose header is wrong ends the upload (400). A frame for an
  overlay that is not showing, or larger than the cap, is read and dropped.
- **Latest wins, on both sides.** Main does not write a frame while the
  socket still holds the last one (`writableNeedDrain`); it counts the drop.
  The backend keeps one frame per overlay.
- **Straight alpha.** Chromium paints premultiplied; the banner layer blends
  straight alpha. The backend divides while it copies the frame out of the
  socket buffer, on the upload task, never on the render thread.
- The frame is an `Arc<BannerBitmap>` with a fresh revision, the type the
  banner draw already takes.

**Targets.** The backend tells main what to render. A task watches the
compositor (twice a second, and at once after any banner change) and
publishes `htmlOverlays.targets` when the answer changes:

```
{ targets: [{ id, pageWidth, pageHeight, frameWidth, frameHeight, fps }] }
```

An overlay is a target while it shows, the platform can draw it and a
compositor run exists. Main fetches the list once on connect
(`htmlOverlays.targets.get`).

**Pixel size in main.** An offscreen window paints `DIP × display scale`
pixels, and the page's CSS viewport is `DIP ÷ zoom`. So for a page `P` and
a target `T` on a display of scale `S`: the window is `T ÷ S` DIP and the
zoom is `T ÷ (S × P)`. The page lays out at `P` CSS pixels and paints `T`
device pixels. Zoom is clamped to Chromium's 0.25 to 5; `T` is rounded up
to a multiple of `S`. When the paint size is not exactly the draw size the
Metal sampler scales it (a pixel or two); the CPU path draws it nearest.

### Where it draws

`banner_draws_for_leg` gets one branch: an HTML banner's bitmap is the
latest frame, not a prepared bitmap. The rest is the banner path.

| Path | HTML overlay |
| ---- | ------------ |
| **Metal** (macOS Preview, recording, stream, both legs) | The same keyed slot. The texture is reused while the frame size holds and is uploaded when the revision changes, so once per new frame per compositor that draws it. Opacity × fade is the layer opacity. |
| **CPU** (macOS fallback) | A straight-alpha blit: 1:1 when the frame is the draw size, nearest-neighbour otherwise. |
| **Legacy FFmpeg graph** (4K60, bridge off) | Not drawn. Show is refused; one already showing is left out and says so. |
| **Windows D3D11, Linux, the Electron proof surface** | Not drawn; the import is refused (D9). |

### Import

1. **Main**: `banners:pick-html` opens a dialog that takes a file or a
   folder, then issues a single-use capability (`input-file` or the new
   `input-directory`).
2. **Backend**: `banners.importHtml {sourceCapability}` on the AssetImport
   lane.
   1. Refuse on Windows and Linux.
   2. A file must end in `.html` or `.htm`; a folder must hold `index.html`.
   3. Walk the folder: refuse a symbolic link, more than 512 files, more
      than 8 levels, more than 64 MB, an entry page over 5 MB.
   4. Read the page size from the meta tag (D3).
   5. Copy into `Banners/.<id>.staging/`, then rename to `<id>.overlay/`.
   6. Insert the row (`kind = 'html'`, both switches on, opacity 1, the
      default place for the page's shape), then show it under the banner
      gates and publish.
3. **Failure**: nothing is published half done.

**Refusals** (verbatim; warnings, never errors):

- "HTML banners work on macOS only for now."
- "This isn't an HTML file. Choose an .html file or a folder with index.html."
- "This folder has no index.html."
- "This HTML banner is too large. Use one under 64 MB and 512 files."
- "This HTML banner has a link to a file outside its folder. Copy the file in."
- "HTML banners can't join this recording. Hide it, or record at 30 fps."

### Wire shape

- `Banner` gains `kind?: "html"`, omitted for an image (never `null`).
  `width` and `height` are the page size. `imageFile` and `thumbnailFile`
  keep their names (`<id>.png`, `<id>.thumb.png`); the files appear with
  D10's picture.
- `banners.importHtml {sourceCapability}` → `Banner` (AssetImport lane).
- `htmlOverlays.targets.get` → `HtmlOverlayTargets`; event
  `htmlOverlays.targets`.
- `htmlOverlays.host.report {id, state, detail?}` (admin role only): main
  says `loading`, `live` or `failed`. The backend republishes it as
  `htmlOverlays.status`, with `htmlOverlays.status.get` for the first read.
- `resource.capability.issue` takes `input-directory`.

All of it is in `shared/backend-rpc-contract.ts` with strict schemas.

### UI

Load `.claude/skills/videorc-design/SKILL.md` first; both themes.

- **Assets → Banners**: the header gets a second action, **Import HTML…**
  (disabled off macOS, with the D9 sentence as its reason). The description
  gains "An HTML banner is a web page with a transparent background, so it
  can move: import an .html file, or a folder with index.html."
- **Tile**: an **HTML** tag beside the name. Before D10's picture exists
  the tile shows the code glyph on the checkerboard. Delete says "and its
  files".
- **Scene inspector**: for an HTML banner the soft-size advice is replaced
  by "An HTML banner is drawn at this size, so it stays sharp." (or, past a
  1080p frame, that it is scaled up from there). A status line appears only
  when there is something to say: "Loading the page…", "This banner
  stopped: <reason>", the session refusal, or how many network requests
  were blocked.
- No new page, no new switch beside Record or Go Live.

## Slices

### S1: Store, import and wire (backend)

`banners.rs`, `html_overlay.rs` (new), `storage.rs`, `protocol.rs`,
`resource_authority.rs`, `main.rs`.

Done when `cargo test -p videorc-backend html_overlay banners` covers the
import refusals (not HTML, no index, too many files, too deep, too large, a
symlink), the meta size parse and its bounds, the copy landing only inside
the managed root, the row round trip with `kind`, an image row that still
serialises without `kind`, and the delete removing the folder.

### S2: Frames and targets (backend)

`html_overlay.rs`: the record parser, the premultiplied to straight
conversion, the frame store, the upload route, the targets task, the host
report and status.

Done when tests cover: a record split across chunks, a bad magic ending the
upload, a frame for a hidden overlay dropped, the cap, the conversion
against hand-computed pixels (0, 255 and a half alpha), target size and
rate for one and two canvases with the cap, and the targets event firing
once per change.

### S3: Compositor (backend)

`compositor.rs`, `banners.rs`, `recording.rs`.

Done when tests cover: `banner_draws_for_leg` returning the latest frame
for an HTML banner on each leg under the leg plan, a new frame changing the
revision and nothing else, the Metal keyed slot uploading once per revision
and reusing its texture, the CPU blit 1:1 and scaled, the legacy session
leaving it out, and Show refused on a session that cannot draw it.

### S4: The page host (main)

`main/html-overlay-policy.ts`, `main/html-overlay-frames.ts`,
`main/html-overlay-host.ts`, the hooks in `main/index.ts`.

Done when unit tests cover: the window options (offscreen, sandbox, no
preload, no Node), the request verdict table (own scheme allowed; http,
https, ws, file, another overlay's id refused), the permission and
navigation verdicts, the path resolver refusing `..`, an absolute path, a
symlink and another overlay's folder, the window geometry for scale 1 and 2
with the zoom clamp, the frame header bytes against the Rust fixture, and
the pacing (drop while the socket is full, never above the target rate).

### S5: Assets and Scene (renderer)

`banners-section.tsx`, `lib/banner-import.ts`, `banner-thumbnail.tsx`,
`scene/banner-inspector.tsx`, `lib/banner-size.ts`, the IPC chain for
`banners:pick-html`.

Done when the unit tests cover the import state copy, the kind chip, the
inspector line for an HTML overlay and the off-macOS reason;
`pnpm check:renderer-assets` passes without a raised ceiling.

### S6: Fixture, smoke and docs

`scripts/fixtures/html-overlay/animated-badge/index.html`,
`scripts/smoke-html-overlay-app.mjs` (`pnpm smoke:html-overlay`),
`docs/banners.md`, `CONTEXT.md`, `AGENTS.md`.

The smoke imports the fixture through the dev app, then records, streams to
a local RTMP sink, and does both at once (the aux leg). In every artifact,
with ffmpeg, over a red takeover: the opaque block reads its colour, the
half-alpha block reads a blend and never the full colour, the hole reads
the takeover, the blinking block reads both of its colours over time, the
overlay is absent before Show and after Hide, and the session never
restarts. It never goes live on a real platform.

Done when `pnpm smoke:html-overlay` and `pnpm smoke:banners` pass.

### Follow-ups (not in the first PR)

- **S7**: live picture on the Assets tile and the Scene stage off macOS.
- **S8**: page size and "Reload" in the inspector; re-import in place.
- **S9** ⚑: per-overlay "Allow network" (owner decision, D5).
- **S10**: dirty-rect uploads, then the shared-texture path if the measured
  cost on a 4K session asks for it.
- **S11**: Windows (D3D11 image layer per frame) and Linux (CPU path).
- **S12**: the agent tool (`edit_banner` learns the kind; an import tool)
  and a Stream Deck key state for an overlay that stopped.
- **S13**: data in: chat, follows and the session clock reach the page
  through a read-only message channel (alerts, counters).
- **S14**: sound from the overlay into the mix.

## Verification

- `pnpm cargo:slot test -p videorc-backend html_overlay banners`
- `pnpm cargo:slot clippy -p videorc-backend --all-targets -- -D warnings`
- `cargo fmt --check --all`
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- Desktop tests for the touched files; `pnpm test:scripts`
- `pnpm build` and `pnpm check:renderer-assets`
- `pnpm smoke:html-overlay`, `pnpm smoke:banners`

## STOP conditions

- The page can reach the network, another overlay's folder, a file outside
  its folder, the app's IPC or any permission.
- A frame is converted, scaled or copied on the render thread.
- Showing, hiding or moving an overlay restarts capture, the camera, the
  recording or the stream.
- The stream or the recording drops frames with an overlay showing that it
  does not drop without one.
- `check:renderer-assets` would need its ceiling raised.

## Measured cost

Measured by `pnpm smoke:html-overlay` on the owner's Mac (2026-11-12), the
debug backend, with the Mac shared by several other builds and 14 to 19 GB
in swap the whole time. The fixture animates continuously, so every number
is at 30 frames a second.

**Transport, per frame**

| Step | 384 × 216 | 960 × 540 | 1920 × 1080 (the cap) |
| ---- | --------- | --------- | --------------------- |
| Main: copy the painted bitmap out of Chromium | 0.05 ms | about 0.4 ms | about 1.7 ms |
| Main: hand it to the upload | 0.10 ms | under 0.1 ms | under 0.2 ms |
| Backend: read and convert to straight alpha (upload task) | 0.05 ms | 0.36 to 0.62 ms | 2.2 to 3.8 ms |
| Bytes on loopback | 10 MB/s | 62 MB/s | 249 MB/s |

Over two smoke runs main sent 1,461 frames. The backend stored 1,460 and
dropped 1, which arrived just after its overlay was hidden. Main dropped 3
as busy and 10 as early.

**Compositor, 1080p record + horizontal stream + vertical stream**

| Overlay | Compositor frame time p95, before → with the overlay | Compositor rate | Dropped frames |
| ------- | --------------------------------------------------- | --------------- | -------------- |
| 960 × 540 (half the canvas) | 2.5 → 2.5 ms, 3.2 → 2.7 ms, 3.6 → 2.8 ms | 30.0 fps | 0 |
| 1920 × 1080 (the whole canvas, the cap) | 3.6 → 5.5 ms, 5.0 → 13.2 ms, 9.2 → 35.4 ms | 30.0, 29.5, 29.1 fps | 0 |

- An overlay up to half the canvas costs nothing measurable.
- A full-canvas overlay at the cap uploads 8.3 MB per frame to each
  compositor that draws it. It held 30 fps with no dropped frames in every
  run, but its p95 moved by 2 ms in the quietest sample and passed the
  33 ms frame budget in the busiest one (the baseline itself swung from 3.6
  to 9.2 ms between those runs). S10 (dirty rectangles, then a shared
  texture) is the way to bring this case down; until then a full-canvas
  HTML banner on a busy machine is the one place this feature can cost
  frame time.

**Renderer bundle**: eager JS 2,330,419 raw / 478,488 gzip, against
2,328,916 / 478,060 on main (+1,503 / +428). The ceilings (2,340,000 /
480,000) were not raised.

## As built (2026-11-12, branch `feat/html-overlays`)

S1 to S6 are built, on macOS.

**What deviates from the plan text above**

- **Copy says "HTML banner"** (D1). `CONTEXT.md` keeps "overlay" out of copy
  for banners, so the refusals, the Assets description and the inspector
  lines say HTML banner. The plan, the code and the smoke keep "HTML
  overlay".
- **The Content-Security-Policy names no fetch sources.** It closes
  plugins, `<base>` and form posts only. A policy that blocked network
  sources would stop those requests inside the page, before the request
  rule could count them, and the inspector could not say "3 requests were
  blocked". The network is closed by `webRequest.onBeforeRequest`, with the
  dead proxy and the WebRTC policy behind it.
- **The upload is never corked.** On Electron's Node (22.22) a corked
  chunked `http.ClientRequest` never emits `drain`, so `writableNeedDrain`
  stayed true after one frame and every later frame was dropped as busy
  (2 frames sent of 204 painted in the first harness run). A header write
  and a pixel write, uncorked, drain every time.
- **A dropped frame asks for a repaint.** A page that stands still paints
  once; if that paint is dropped (the upload was busy or not open yet), the
  host invalidates the window one frame later. A new backend connection
  repaints every page for the same reason.
- **The import takes an `input-directory` capability** for a folder (a new
  kind, checked like `output-directory`), and `authorize-smoke-resource`
  accepts it so the smoke imports the fixture as a folder.
- **`htmlOverlays.stats`** (frames, bytes, conversion time) and the
  dev-only smoke command `html-overlay-stats` (main's counters) were added
  for the measured cost.
- **The smoke has a fourth mode, `full-frame`**: record and stream 1080p
  with the overlay across the whole canvas, under the same pixel checks.

**What is in**

- Import of a file or a folder with every D2 limit; the page size from the
  meta tag; Delete removes the folder.
- The sandboxed host with every D4 and D5 rule as a tested pure function.
- Frames on every macOS compositor leg (primary, auxiliary, the Preview's
  program leg), Metal and the CPU fallback, under the banner leg plan.
- Show and Hide, place, opacity, Appears in, the fade, Timing, the order,
  and every surface that addresses a banner by id (Stream Manager,
  `/banner`, ⌘K, Stream Deck, phone, Buddy voice, the agent's `set_banner`):
  none of them changed.
- The page's own picture as its thumbnail (D10).
- Status in the Scene inspector: loading, stopped, cannot join this
  recording, requests blocked.

**What is not in** (the follow-up slices)

- Windows and Linux (S11): the import is refused and the button is off,
  with the sentence.
- A session on the legacy FFmpeg graph (4K60, bridge off): Show is
  refused; one already showing is left out and its inspector says so. The
  Go Live sheet does not yet warn before such a session starts.
- Network access (S9, the owner's call), sound (S14), data from chat or the
  session (S13), a page-size or Reload control (S8), the live picture on
  the Scene stage away from macOS (S7).
- Dirty-rectangle uploads and a shared texture (S10).
- The agent tool to import one, and a Stream Deck state for a page that
  stopped (S12).
- A staging folder left by a crash mid-import is not swept at start.

**Gates (local, macOS, 2026-11-12)**

- `pnpm cargo:slot test -p videorc-backend -- html_overlay banner`: 98
  passed. A wider run (`websocket authority capabilit fixture storage::
  overlay_layout legacy rpc_`): 392 passed, 4 failed, all
  `captions::tests::caption_contract_fixture_*` on sample-clock
  assertions. `captions.rs` is not touched here, and the same tests pass
  alone (`caption_contract_fixture --test-threads=1`: 7 passed): they are
  sensitive to a loaded machine.
- `pnpm cargo:slot clippy -p videorc-backend --all-targets -- -D warnings`
  and `cargo fmt --check --all`: clean.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: passed.
- Desktop tests: 662 files, 7,545 passed, 1 skipped. `pnpm test:scripts`:
  passed.
- `pnpm build` and `pnpm check:renderer-assets`: passed, ceilings not
  raised.
- `pnpm smoke:html-overlay`: PASS in recording, streaming, both and
  full-frame, 9 artifacts; and again interleaved (`both,full-frame` twice).
- `pnpm smoke:banners`: see the PR.
- Not run here: the full Rust suite (owner rule: targeted tests), the
  release clippy build, `smoke:recording-studio` as a bundle, and the
  Windows and Linux compile (CI).

**Owed**

- The owner's by-eye pass in light and dark, with a real overlay.
- The owner's answers to D3 (default page size), D5 (network) and D9
  (platforms).
- A packaged-app take.
