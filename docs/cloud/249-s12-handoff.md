# Plan 249 S12: saved scenes on the cloud program

Status: **publication-ready, uncommitted**, reconciled onto the published S6
and S9 tips, with the scene-aware Program preview, live Freeform/Show-Hide
edits and a supported guest-roles control. Focused checks only. Live,
real-page, managed and device acceptance **not run**. Production qualification
false. No commit, push, issue, PR, merge or deploy was made by this thread. The
central ledger and `protocol-fixtures/cloud-parity-{plan,inventory}.json` were
not edited. Exact per-file SHA-256 manifest: `docs/cloud/249-s12-manifest.json`
(same file in both repos).

## Worktrees and bases

- Desktop: `/Users/orcdev/projects/videorc-wt-249-s12`, branch
  `feat/249-s12-cloud-parity`, HEAD = S9 `894810e69650ea71812d78efd6f0771216144836`
  ([#1454](https://github.com/TheOrcDev/videorc/pull/1454), on S6 `f27307cd9`
  [#1452](https://github.com/TheOrcDev/videorc/pull/1452), on `main` `dda61b03e`),
  plus uncommitted S12.
- Web: `/Users/orcdev/projects/videorcweb-wt-249-s12`, branch
  `feat/249-s12-cloud-parity`, HEAD = S9 `c419182892fda1aec058df86710cc425458b0f16`
  ([web #136](https://github.com/TheOrcDev/videorc-web/pull/136), on S6
  `b615c28b` [web #134](https://github.com/TheOrcDev/videorc-web/pull/134), on
  `main` `59fb8ba6`), plus uncommitted S12.
- PR base: `feat/249-s9-cloud-parity` in each repo (then `main` once S6 and S9
  merge). Upstream tracking is unset; the coordinator sets the push target.
- `node_modules` (both repos) and `apps/desktop/node_modules` are untracked
  symlinks to `videorc-wt-249-s3` / `videorcweb-wt-249-s2`. Never stage them.
  No install, lockfile or dependency change.
- Backups: `~/s12-scratch/pre-s6/` and `~/s12-scratch/pre-s9/` (tracked patches,
  untracked tars) and desktop stashes `s12 pre-s6` / `s12 pre-s9`. The desktop
  stash list is shared with other worktrees: drop only those two entries, by
  message, when no longer needed. The web keeps stash `s12 pre-s9 web` (its pop had conflicts); the pre-S6 web stash was consumed by a clean pop.

## Dependency status

| Dependency                    | State                                             | What S12 relies on                                                           |
| ----------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| S2 privacy, S3/S4 negotiation | Merged on `main`                                  | Host screen publication (S2); `ConsumerCapability`, receipts, relay (S3/S4). |
| S6 views                      | Published #1452 / web #134, **reconciled**        | Stage key, guest lane, Program preview.                                      |
| S9 static graphics            | Published #1454 / web #136, **reconciled** (HEAD) | Graphic roots above the stage; EG-only `graphics.static`.                    |
| S5 animation                  | Published #1451 / web #133, not absorbed          | Additive avatar seams only; S12 touches none.                                |
| S13a camera bridge (`G7e0v`)  | In progress, frozen                               | `host-camera` role and `logicalSize` seam below; no shared code.             |

## Reconciliation record

- **S6** (fast-forward plus replay). Desktop conflicts, all kept both sides:
  `room-media-v2.ts` (S6 guest graphics lane kept; `scene` stays EG-only, so
  guests never get scenes), `talk-show-room.ts` (S6 `#avatarGuests` and
  `setAvatarGuests`; `#bind` runs S6 `guests()` then `#bindScene`),
  `use-studio.tsx` (S6 `roomAvatarGuests` and the S12 hooks), baseline runner
  and entrypoint (`views` and `scenes` cases). Web replayed cleanly. S6's stage
  key hashes the stage as sent, so scenes leave its acknowledgement unchanged.
- **S9** (fast-forward plus replay). Desktop: baseline runner (case flags,
  lanes, sibling `exerciseGraphics` / `exerciseScenes` calls and artifact
  checks) and `cloud-parity-browser.mjs` (taken whole from S9). The scenes case
  now reuses S9's vertical lane identity `EG_parity_graphics_v`, so the browser
  fixture carries no S12 change. Web: `stage.ts` keeps S9's `takeGraphics` /
  `onGraphics` whole beside S12's `takeScene` / `onScene`; source registration
  order is S9 GRAPHICS, AVATAR, S12 SCENE; the beacon capability carries S9's
  `graphics.static` and S12's `scene`; S9's EG-only static relay and
  applied-only avatar ack stripping are untouched; the handler-list test names
  all five topics. Emitted v1 assets regenerated. S9's byte-mirrored
  `cloud-avatar.ts` / `cloud-graphics*.ts` are untouched (their web-Prettier
  warnings are S9's, unchanged).

## What it does

### Contract (`apps/desktop/src/shared/cloud-scene.ts` == web `lib/cloud/program/cloud-scene.ts`)

- Topic `videorc.presentation.scene.v1`: targeted byte streams to current
  authorized `EG_` consumers only, 16 KiB cap, 30 s lease refreshed every 10 s.
  Guests never receive a scene (their call view and S6's D4 lane are unchanged).
- Snapshot `{version:1, show, publisherSid, revision, output, orientation,
expiresAt, scene|null, transition:{kind:'cut'|'motion', durationMs, applyAt}}`.
  `scene: null` is a clear: the room's own layouts return.
- Roles: `host-camera`; `screen` = the stage's selected screen. Each item:
  canvas-fraction rect (native bounds, freeform may start off canvas),
  source-space crop, `contain|cover`, mirror after crop, mask
  `rectangle|rounded(radius)|circle`, z (native order).
- Guests (D7): explicit `guests.slots`, the rest in `guests.region` as equal
  16:9 cells; with any guest on stage the host scene is drawn into
  `guests.host`. With nobody else on stage the host scene is the native
  geometry exactly. A scene never removes a guest or changes who is on stage.
  Defaults for old scenes: landscape host 75% left, guest column right; portrait
  host top 70%, guest band below.
- Transition: native `ease_in_out_cubic`, 320 ms (Animate scene changes),
  matched by `identity|kind`, new boxes grow from 92%, leavers vanish; wall
  clock `applyAt`, a late join continues the phase.
- `SceneReceiver`: current host SID owner; latest revision wins; clear, lease
  expiry or owner change drops; applied only after the page drew it.
- Capability `ConsumerCapability.scene?: {version:1, output, orientation,
applied?}`, EG only, relayed with the token-bound lane; an `applied` from an
  older host session is stripped.
- Vectors: `protocol-fixtures/cloud-parity-scenes.json` == web
  `tests/fixtures/cloud-parity-scenes.json` (byte-equal).

### Desktop

- `cloud.scene.resolve` (renderer only, observation lane): Rust
  `scene_from_capture_config` without committing (no capture, compositor or
  camera-lend wait). The native layout engine is reused, not rewritten.
- `lib/cloud-scene-native.ts`: native scene to roles via the existing mirrors
  (`previewProofLayerFit`, `effectiveCameraMaskShape`, `sceneStageRect`,
  `sceneCameraOnStage`); hidden and test-pattern sources are named, never faked.
- Saved format: `SavedScene.cloud?: {version, ...}` beside untouched native
  fields; library version stays 1; any bounded (4 KiB) versioned object is kept
  as saved; edits keep it; the lazy adapter reads v1, defaults otherwise.
- `lib/cloud-scene-adapter.ts` (lazy): resolve at the lane canvas, translate,
  wait at most 2 s for the scene's sources in the room, put the host screen up
  when needed, then one atomic commit. The other orientation keeps room layouts
  until S17. `ok` only for `applied` (every egress lane drew it) or `preview`
  (no egress yet).
- `lib/room-scene-publisher.ts`: targeted delivery, generations, superseding,
  bounded uploads, confirmed clears; status (with the committed `content`) on
  `TalkShowRoomSnapshot.scene`. Reconnect re-commits as a cut.
- `use-studio.tsx`: while the room holds the camera, saved scenes and presets
  (click, hotkey, remote, agent, Follow) go to the adapter. One shared preset
  composition helper. Per room, **off by default**, with a **Use scenes** toast
  action. Show stage layout choices clear the scene.
- **The native working scene follows the room scene.** After a room commit
  that was not refused or superseded, the scene is committed natively idle
  (`scene.load_from_capture_config`: scene state and compositor config only,
  no capture start, no camera wait) and the working state is updated with the
  same `applyLayoutTransactionState` a native switch uses (origin, saved scene
  id, orientation coupling; a switch, not an edit, so nothing autosaves). The
  Scene editor therefore edits the scene viewers see, and the Preview shows it
  when the room closes.
- **Live edits** (`lib/room-scene-resender.ts`, `createRoomSceneEditSync`):
  every confirmed native edit while a scene is on the program (Freeform
  `scene.source.transform.update`, nudge, reset, `scene.source.visibility.update`,
  a look change, new guest roles) requests a re-send through the same adapter,
  as a cut. Coalesced: one send in flight, at most one waiting, sends at least
  120 ms apart, each reading the latest working layout, sources, background and
  guest roles. Fenced: a scene chosen meanwhile cancels the waiting edit and
  marks the running one stale; the room connection is fixed at request time; a
  clear, scenes turned off or another room drop it; the adapter re-checks
  "still wanted" in the same tick as its commit, so nothing lands after a
  clear. A real failure warns once; superseded and unconfirmed sends do not
  toast (the Program preview line says what is unconfirmed). Each send is a
  normal scene commit settled on every egress lane's rendered revision.
- **Guest roles you can choose** (D7): before this change explicit guest roles
  existed only as saved-scene JSON (fixtures and dev hooks); no interface
  could set them. Now a saved scene's ⋯ menu has **Guests in the room…**, a
  dialog with a `SegmentedControl` (Beside, Below, Over the scene) saved as the
  scene's versioned `cloud` extension with the placement name
  (`lib/scene-guest-roles.ts`). Beside is the stable default; Over keeps the
  scene whole with six explicit guest boxes. Freehand guest boxes are not
  offered. Choosing roles for the scene on the program re-sends it.
- **Program preview** (S6's `show-stage.tsx`): while a scene is on the
  horizontal lane, `ProgramStage` draws `programScenePreview` tiles
  (`lib/room-scene-preview.ts`: the shared `planSceneTiles` for the people and
  screen the page reports drawing, via S6's `managedProgramStageInput`), each
  with its z, mask and a clip box laid out by the shared `scenePicture` (crop,
  fit, mirror after crop) from the track's decoded size. The Room view still
  draws the room layout; S6's stage badge and applied-stage semantics are
  unchanged; a separate line says what the outputs confirmed for the scene
  ("Scene drawn by each output · Preview reconstruction", "Scene set · Shows
  once the stream or recording starts", or the reason). Off, cleared or
  vertical-only: S6's room-layout preview as before. Existing primitives only
  (no new component, colour or motion).

### Web program page

- `stage.ts`: authenticated, bounded, rate-limited scene reads for the signed
  lane; `planFromScene` while a scene is current, `planStage` otherwise; ack
  after two frames; beacon `capability.scene`.
- `stage-layout.ts`: optional `PlannedTile.scene` / `StagePlan.scene`,
  `planFromScene` (guest plates as the room; host boxes none); room `planKey`
  unchanged.
- `stage-view.ts`: scene tiles (z, mask, crop/fit/mirror clip box) and the
  native glide; roster changes within a scene keep the room crossfade.
- `source.ts` routes the topic; the emitter adds `cloud-scene`.

### S13a seam (agreed with `G7e0v`)

- Role id `host-camera` frozen. S13a sends full source frames (key, spill, look
  applied once natively); S12 alone applies crop, fit, mirror, mask and z on the
  logical size, and never keys.
- Web `stage-view.ts` exports `SceneMediaSize = { logicalSize?: () => {h, w} | null }`;
  a tile's media that reports a logical size is laid out at it, otherwise at
  the decoded `videoWidth`/`videoHeight`. S13a's frozen mount (its uncommitted
  `videorcweb-wt-249-s13a-int`): `StageMedia.logicalSize()` returns 640x360
  while its adapter is live (null otherwise), and a
  `canvas.tile-camera-frame[data-camera-frame="rgb-left-alpha-right:g8"]` is
  mounted beside the video and fires `resize` on its first frame. S12 lays the
  picture out again on any `resize` inside the picture box (a capture-phase
  listener, since `resize` does not bubble), so the canvas, mounted later, is
  covered without S12 knowing its class. Expect a small merge in
  `stage-media.ts` / `stage.ts` when S13a lands; S12 does not edit
  `stage-media.ts`.
- The scene snapshot is the only camera geometry authority. S13a's
  `CAMERA_FRAME_CONTRACT` carries identity, epochs and the descriptor, no rect
  or crop; S10's AlphaManifest is not used for the camera. Packed camera mode
  stays disabled.

## Maintained acceptance (authored, NOT run)

`pnpm smoke:cloud-parity -- --case scenes` (`scripts/lib/cloud-parity-scenes.mjs`,
matrix and pure checks in `cloud-parity-scenes-contract.mjs`), through the
baseline runner with two real guests and the real program page as H stream,
H recording (`rec=1`) and V stream (`EG_parity_graphics_v`):

- Off by default; a screen scene before any room screen is refused uncommitted.
- Every shipped preset (4 H, 6 V) at 0, 1 and 2 guests; freeform H/V (cropped
  screen, mirrored zoomed circle camera partly off canvas) at 0 and 2; explicit
  guest roles; hidden camera. Each waits for every lane's rendered revision,
  compares drawn boxes with the shared plan, checks no guest was dropped, and
  reads decoded screenshot pixels (screen corner markers with mirror/crop,
  host camera colour, circle corner).
- Real controls on a Freeform scene with two guests (`SCENE_CONTROL_CASES`):
  one drag, a burst of 12 drags (coalesced: fewer commits than drags, last box
  wins), Hide and Show camera, guest roles set to Over, and edits then a clear
  (room layouts return, no commit after the clear). Each waits for every
  horizontal lane's rendered revision and compares the program pages and the
  desktop Program preview (`show-stage-program` tiles, percent of the frame)
  with the shared plan.
- Native glide (between, settles at 320 ms ±120, no overshoot) and cut; late
  join re-confirmed; no scene on guest pages; clear on all three lanes; apply
  p95 at most 500 ms locally; finalized videos contain the host camera on H and V.

3–6 guests are unit vectors only. Not covered: the desktop Program preview's
pixels (unit-tested), managed egress, devices, Windows/Linux, background pixels.

## Focused checks (lightweight only, on the S9-reconciled trees)

- Desktop renderer and node `tsc --noEmit`: pass.
- Desktop Vitest, 22 files, 700 tests pass, including new
  `shared/cloud-scene.test.ts`, `lib/cloud-scene-room.test.ts` (overtaken edit
  commits nothing), `lib/room-scene-preview.test.ts`,
  `lib/room-scene-resender.test.ts` (burst coalescing with latest state,
  Show/Hide, edits then clear, a clear while an edit resolves, another room,
  a chosen scene cancelling, warn-once, bounds), `lib/scene-guest-roles.test.ts`,
  the `scene-list.test.ts` ⋯ menu and Guests in the room… dialog cases and the
  `show-stage.test.ts` scene preview case; S6/S9 suites and backend-rpc-contract,
  talk-show-room, scene-presets, avatar, room join, layout, studio-actions,
  studio-provider integration.
- `node --test scripts/lib/cloud-parity-*.test.mjs`: 51 pass; `node --check` on
  the scenes runner, contract, baseline, browser fixture and entrypoint.
- oxlint on touched desktop files: only the existing `use-studio.tsx`
  missing-`recording` warning. Prettier, em-dash gate, `git diff --check`: pass.
  rustfmt (edition 2024, `skip_children`) on `main.rs`: pass. **Rust not
  compiled or tested.**
- Web (unchanged since the S9 reconciliation): `tsc --noEmit --incremental
false`, ESLint and Prettier on touched files, emitter write and `--check`:
  pass. Focused node tests, 14 files: 163 of 165 pass; the 2 failures fail
  identically on a pristine export of S9 `c4191828` (and S6): "the stage's
  colours are the runner's luma values" (`program.css`) and "end: no feed
  never ends a talk show...". S12 touches neither.
- Mirrors: the desktop module under web Prettier differs only in its header;
  fixtures byte-equal (`cmp`).
- Shadscan (`@shadscan/cli` 0.1.0-rc.7, `--json`): baselines on pristine S9
  exports desktop 27, web 47; finals desktop 27, web 47
  (`~/s12-scratch/shadscan-*-s9-*.json`).

## Deferred gates (user: none until all merges on main)

D (full), B (`cargo fmt --check --all`, `cargo test -p videorc-backend`,
clippy incl. release), N, W (full), WB, C, R, P, `pnpm smoke:smart-scenes`, RC
(`smoke:remote-control`, `smoke:agent-mcp`), `smoke:cloud-parity -- --case
scenes`, renderer budget (`pnpm build`), managed and macOS/Windows device
acceptance. Page acknowledgements are render observations, never
encoded-output proof.

## Known gaps

- Background and live background pixels are S14 (geometry already uses the
  stage margin); keyed-camera transparency is S10/S13.
- A scene goes to its own orientation's lane only; the Program preview shows
  the horizontal lane (S17 owns dual-orientation outputs).
- Guest roles are three placements, not freehand guest boxes.
- Scene-editor stage drafts (pointer moves before a drag is committed) stay
  local, as natively; the room gets each committed edit.
- `cloud.scene.resolve` is uncompiled Rust; eager renderer budget unmeasured
  (adapter, translation and contract are lazy; the edit sync is about 2 KB in
  the Studio bundle; `show-stage` loads with the room).

## Changed paths

Desktop modified: `apps/desktop/src/renderer/src/components/studio/show-stage.test.ts`,
`apps/desktop/src/renderer/src/components/studio/show-stage.tsx`,
`apps/desktop/src/renderer/src/components/scene/scene-dialogs.tsx`,
`apps/desktop/src/renderer/src/components/scene/scene-list.test.ts`,
`apps/desktop/src/renderer/src/hooks/use-scene-presets.ts`,
`apps/desktop/src/renderer/src/hooks/use-studio.tsx`,
`apps/desktop/src/renderer/src/hooks/use-talk-show-room.ts`,
`apps/desktop/src/renderer/src/lib/room-media-v2.ts`,
`apps/desktop/src/renderer/src/lib/scene-presets.ts`,
`apps/desktop/src/renderer/src/lib/talk-show-room.ts`,
`apps/desktop/src/shared/backend-rpc-contract.ts`,
`crates/videorc-backend/src/main.rs`, `scripts/lib/cloud-parity-baseline.mjs`,
`scripts/smoke-cloud-parity-app.mjs`.

Desktop new: `apps/desktop/src/renderer/src/lib/cloud-scene-adapter.ts`,
`apps/desktop/src/renderer/src/lib/cloud-scene-native.ts`,
`apps/desktop/src/renderer/src/lib/cloud-scene-room.test.ts`,
`apps/desktop/src/renderer/src/lib/room-scene-preview.ts`,
`apps/desktop/src/renderer/src/lib/room-scene-preview.test.ts`,
`apps/desktop/src/renderer/src/lib/room-scene-publisher.ts`,
`apps/desktop/src/renderer/src/lib/room-scene-resender.ts`,
`apps/desktop/src/renderer/src/lib/room-scene-resender.test.ts`,
`apps/desktop/src/renderer/src/lib/scene-guest-roles.ts`,
`apps/desktop/src/renderer/src/lib/scene-guest-roles.test.ts`,
`apps/desktop/src/shared/cloud-scene.ts`, `apps/desktop/src/shared/cloud-scene.test.ts`,
`protocol-fixtures/cloud-parity-scenes.json`, `scripts/lib/cloud-parity-scenes.mjs`,
`scripts/lib/cloud-parity-scenes-contract.mjs`,
`scripts/lib/cloud-parity-scenes-contract.test.mjs`, `docs/cloud/249-s12-handoff.md`,
`docs/cloud/249-s12-manifest.json`.

Web modified: `lib/cloud/program/room-media-v2.ts`, `lib/cloud/program/source.ts`,
`lib/cloud/program/stage-layout.ts`, `lib/cloud/program/stage-view.ts`,
`lib/cloud/program/stage.ts`, `lib/cloud/program/tools/emit.ts`,
`lib/cloud/room-media-relay.ts`, `public/cloud/program/v1/room-media-v2.js`,
`public/cloud/program/v1/source.js`, `public/cloud/program/v1/stage-layout.js`,
`public/cloud/program/v1/stage-view.js`, `public/cloud/program/v1/stage.js`,
`tests/cloud-program-source.test.ts`.

Web new: `lib/cloud/program/cloud-scene.ts`, `public/cloud/program/v1/cloud-scene.js`,
`tests/cloud-scene.test.ts`, `tests/fixtures/cloud-parity-scenes.json`,
`docs/cloud/249-s12-handoff.md`, `docs/cloud/249-s12-manifest.json`.

## PR text prepared for the coordinator

Desktop title: **Plan 249 S12: Apply saved scenes to cloud composition**

> While a talk-show room holds the camera, saved scenes and preset choices
> (click, hotkey, remote, agent, Follow) now change the room program instead
> of refusing. The native engine resolves the scene without committing it
> (`cloud.scene.resolve`, Rust `scene_from_capture_config`); the renderer
> translates it into host camera and screen roles with the native fit, crop,
> mirror, mask and background stage margin, waits until the sources it shows
> are in the room, and commits it atomically to each egress lane. Guests are
> explicit roles with a stable default layout and are never removed by a scene.
> Transitions match the native 320 ms ease-in-out glide or cut. The commit
> reports each lane's rendered revision; nothing unconfirmed is called applied.
> The native working scene follows the room scene, so Scene editor drags,
> nudges, resets and Show/Hide reach the program live, coalesced and fenced
> against a newer scene, a clear or another room. A saved scene's ⋯ menu adds
> Guests in the room… (Beside, Below, Over the scene).
> The Program preview draws the scene with the same shared geometry while the
> Room view stays the room, and S6's stage confirmation is unchanged. Saved
> scenes keep their native format with a versioned `cloud` extension. Off by
> default per room (Use scenes). Includes the maintained `scenes` parity case
> (not run), shared vectors and focused tests. Rust not compiled; smoke,
> real-page, managed and device gates deferred. Production qualification
> false.
>
> Base: `feat/249-s9-cloud-parity` (#1454, on S6 #1452). Pair: web PR (deploy
> first). No issue.

Web title: **Plan 249 S12: draw the host's scene on the cloud program**

> The program page accepts a host scene snapshot on its signed egress lane
> (authenticated host session, bounded size and rate), plans it with the
> shared scene geometry (host camera and screen boxes, guest slots and region),
> draws crop, fit, mirror, masks and z-order, and runs the native glide on the
> snapshot's clock. It confirms a revision only after drawing it and reports it
> in the beacon capability beside S9's static field; the relay keeps it only
> for the token's EG lane and the current host session. A clear, a new host
> session or a lapsed lease returns the room's own layouts. Old pages ignore the
> topic and stay unconfirmed. Includes the emitted v1 modules and shared
> vectors. Focused checks only; the two pre-existing failures (also on S9 and
> S6) are unchanged.
>
> Base: `feat/249-s9-cloud-parity` (web #136, on S6 #134). Deploy before the
> desktop PR. No issue.
