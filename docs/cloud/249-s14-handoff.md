# Plan 249 S14: complete screen and background behavior

## State and bases

Published for review. **Live acceptance not run; nothing qualified.** The new
behavior only acts while a room's scenes are turned on (S12's per-room,
off-by-default switch), and the background contract is
`CLOUD_BACKGROUND_PRODUCTION_QUALIFIED = false`. No Rust changes, so nothing
here is uncompiled Rust.

- Desktop branch `feat/249-s14-cloud-parity` on `origin/main` `468f2777f`
  (S13a merged) plus S13b's own commit `701177bd6` cherry-picked (desktop
  #1464). **S13b #1464 and web #145 must merge first**; this diff then shrinks
  to the S14 commit.
- Web branch `feat/249-s14-cloud-parity` on web `main` `99d565ce` plus S13b web
  commit `816f0696` cherry-picked (web #145).

## What it does

### Screen follows the scene (V10, V12)

- `lib/room-screen-source.ts`: a scene's native source maps to the capturer
  id of the same display or window (macOS ScreenCaptureKit
  `window:screencapturekit:<CGWindowID>` -> `window:<id>:0`,
  `screen:screencapturekit:<display>` -> `screen:<id>:0`). A window wins over a
  display; None keeps the share; an id that does not map (other platforms) is
  said, never guessed.
- `cloud-scene-adapter.ts`: before the S12 commit, a scene that shows a screen
  and names another source than the room shares calls `shareScreen`. Use-studio
  names the source to main (`setTalkShowMediaGrant`, the existing one-shot
  grant main checks against its capturer list), then
  `TalkShowRoomClient.replaceScreenSource`. **Transactional**: the new capture
  opens before the old one stops; a refused or vanished source throws, the old
  share stays, and the scene is not committed. A newer change during the swap
  commits nothing.
- The swap goes through S2's privacy gate unchanged: a new epoch and
  publication; a hidden screen stays frosted across the swap; nothing raw is
  published in between.
- Follow and app scenes in room mode now resolve the app's window as natively
  (`resolveSceneWindowForApply` with Follow's `preferWindowId`, the scene's
  display by UUID via `withSceneDisplay`); a refused app window refuses the
  switch with the native copy.
- The room snapshot carries `local.screenSourceId`; a hand-picked share records
  its source too, so a scene naming the same source does not re-capture.
- Capture facts (V13), stated, not claimed: `ROOM_SCREEN_CAPTURE_FACTS` =
  browser capturer, cursor = capturer default (the native cursor setting is
  not applied), own windows left out only where they use content protection.
- Not used: S13a's frame bridge for screens. It is a 640x360 camera transport;
  shared text would be unreadable. A native screen role needs its own measured
  transport.

### Scene background on the program (V6)

- Contract `shared/cloud-background.ts` (mirrored as web
  `lib/cloud/program/cloud-background.ts`, vectors in
  `protocol-fixtures/cloud-parity-background.json` == web
  `tests/fixtures/cloud-parity-background.json`). The parse functions and types
  live in `cloud-scene.ts` (re-exported), because Node's type stripping loads
  `cloud-scene.ts` as is and it must keep no relative imports.
- S12's scene gains an optional `background`; older pages ignore it. A scene
  without one keeps its S12 content key (fixture-checked).
  - `picture`: SHA-256 hash, mime, size, fit (`fit` = contain, `fill`/`stretch`
    = cover, as the compositor) and Rust `background_zoom_crop`. Drawn over
    black. Blur, saturation and vignette are not drawn by the native compositor
    for pictures either, so they are not sent.
  - `live`: id, look, Dim (`dimPercent/100`, 0..0.8) and one phase clock
    (`anchorAt`, `anchorPhase`, `rate` with Calm = half) that continues across
    look and motion changes without a jump (clock.rs rule). Every lane computes
    the same phase from wall time.
- Pictures travel once per consumer connection on
  `videorc.presentation.background-asset.v1`, targeted to authorized `EG_`
  program consumers only (never guests): `u32 header length | JSON header |
  bytes`, at most 2 MiB, header bound to show and publisher SID. The page checks
  sender, size, rate and concurrency before reading, then SHA-256 and decoded
  size before use; a 2-entry cache keeps the picture on the program.
- Desktop `lib/room-background.ts` (lazy): decodes the managed asset, draws it
  down to at most 2560 px, encodes WebP (JPEG fallback) under 2 MiB, hashes it;
  one preparer per Studio keeps the live clock. A background that cannot be
  prepared is said in the scene result; the scene still changes without it.
- `room-scene-publisher.ts`: sends the picture before the scene that names it
  (a missing picture fails the delivery instead of sending a scene without it);
  status gains `background` (what each lane drew, how many lanes cannot draw
  backgrounds). The Program preview line adds "Background shows still: ..." or
  "Background unconfirmed: reload older program pages"; a still is never
  reported as moving.
- Web `stage-background.ts`: a layer beneath every scene (scene grounds go
  clear while it shows). Live looks run the desktop's own WebGL2 runner and the
  backend's render export, byte-mirrored to `public/cloud/program/v1/`
  (`live-background-webgl.js`, `live-backgrounds.render.json`, pinned by
  SHA-256 on both sides) and loaded as a classic script only when a live
  background is shown (the page never lazy-imports). At most 30 fps; the
  desktop guard rule steps full -> half -> still on slow median frames. No
  WebGL2, a failed shader, a lost context or the budget give a still with its
  reason; there is no web poster, so a still shows the React Bits base colour.
- The page reports `scene.background = {version: 1, live: 1, drawn?: {key,
  rendering, reason?}}` in its capability; the web relay keeps the lane and
  strips a drawn background observed for an older host session.
- Keyed camera: with packed alpha still disabled (S10/S13), a keyed room camera
  is the named opaque partial mode over the cloud background.

## Maintained acceptance: `pnpm smoke:cloud-parity -- --case sources` (not run)

`scripts/lib/cloud-parity-sources.mjs` (runner, inside the S12 scenes harness)
and `scripts/lib/cloud-parity-sources-contract.mjs` (pure rules, verdict):
saved scenes naming window A, window B, a gone window (refused, old share
kept, nothing committed) and a Follow switch to a display; Hide then a source
switch (the screen box stays frost on every lane, never the new colour) and
Show; picture and live backgrounds with the key off and on (each lane reports
what it drew, the margin ring shows the background, a live ring moves and a
picture's does not); clear. The fake capturer paints one colour per capturer
id the Studio asked for. Named unavailable, never passed: native cursor
setting, protected-window exclusion, real window capture, app-scene window
swap, Windows hide gate, managed egress. Smoke hooks added:
`roomScreenSource`, `roomScreenWanted`, `roomFollowApply`.

## Verification (focused only)

- Desktop `tsc --noEmit` for `tsconfig.node.json` and `tsconfig.web.json`: pass.
- Desktop Vitest: new `shared/cloud-background.test.ts`,
  `lib/room-screen-source.test.ts`, `lib/room-background.test.ts`,
  `lib/cloud-scene-room-s14.test.ts`, two S14 cases in `talk-show-room.test.ts`,
  the background note in `room-scene-preview.test.ts`; S12 scene suites,
  `show-stage.test.ts`. Full suite result in the PR body.
- `node --test scripts/lib/cloud-parity-*.test.mjs`: 102 pass.
- oxlint (only the inherited `use-studio.tsx` dependency warning), Prettier on
  touched files, text-file and em-dash gates: pass.
- Web: `tsc --noEmit`, ESLint on touched files, emitter `--check`: pass. Full
  `node --test tests/*.test.ts`: the same 21 failures as the untouched base
  (S13b tip), none new; new `cloud-background.test.ts` and
  `cloud-stage-background.test.ts` pass.

## Deferred (user: none until all merges on main)

D (full), B (no Rust touched), N, W (full), WB, C, R, P,
`pnpm smoke:smart-scenes`, `smoke:cloud-parity -- --case sources`, Windows
hide gate, renderer budget (`pnpm build`), managed egress, macOS/Windows
device capture (cursor, protected windows, real windows), GPU cost of live
shaders on the managed recorder (likely software GL: the guard steps down,
but real cost is unmeasured).

## Known gaps

- The desktop Program preview draws no background (tiles only).
- Live backgrounds on a page without WebGL2 show the base colour, not the
  look's poster (posters are desktop assets).
- Other platforms' native screen ids do not map; the room keeps the
  hand-picked share there and says so.
- The vertical lane gets a background with a vertical scene only (S17 owns
  dual orientation).
