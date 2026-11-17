# Plan 249 S13b: processed camera contributions

## State, bases and index

Working change only. Acquisition has **not run**; runtime qualification,
managed budgets and every platform/device capability remain **unqualified**.
The processed camera stays disabled everywhere (`ROOM_PROCESSED_CAMERA_ENABLED
= false`; native, main and renderer gates below). No commit, push, PR,
deployment, credential read, provider call or private memory write.

- Desktop: `/Users/orcdev/projects/videorc-wt-249-s13b`, branch
  `feat/249-s13b-cloud-parity`, HEAD = S13a publication tip
  `3e42ca9af06fbff8f646b58823b6c29405e92e43`
  (`feat/249-s13a-cloud-parity-main`, PR #1459). Nothing staged; the S13b
  delta is the whole working change.
- Web: `/Users/orcdev/projects/videorcweb-wt-249-s13b`, branch
  `feat/249-s13b-cloud-parity`, HEAD = web S13a tip
  `952ce7b554791551d4d58198726354afa90785ed` (PR #140). Nothing staged.
- `node_modules` in both trees are temporary symlinks for focused checks and
  are removed before handoff (not part of the change).
- Preserved, untouched: the S13a publication trees
  `/Users/orcdev/projects/videorc-wt-249-s13a-main` and
  `/Users/orcdev/projects/videorcweb-wt-249-s13a-main` (clean at the tips
  above), the frozen S13a original and every S13a backup.
- Backups and manifest: `/Users/orcdev/249-s13a-frozen-backup/s13b/`
  (`desktop.patch`, `web.patch`, `desktop-new-files.tar`, `MANIFEST.sha256`).
- Central ledger, parity plan, inventory JSON, S8 and S12 files unchanged.

## What the slice adds

The S13a bridge carries the app's real processed camera, not a test pattern:

1. **Processed role** (`crates/videorc-backend/src/room_frame_bridge.rs`):
   role `host-camera` beside S13a's synthetic `host-camera-test`. The logical
   size follows the camera's aspect, never a crop: even sides 64..640, at most
   640x360 pixels (`logical_size_for`: 1920x1080 -> 640x360, 640x480 ->
   554x414, 1080x1920 -> 360x640, 4096x2160 -> 640x336); packed width
   `2w + 8`. `pull_processed` keeps S13a's lease, epoch and latest-wins rules;
   a camera generation change, backwards sequence or size change is an error
   (the client opens a new generation), a missing frame is idle
   `camera-unavailable`. Dropped frames = camera sequence gaps.
2. **Timestamps**: header flag bit 1 `ptsObserved` marks `ptsUs` as the native
   first-observation time of a camera sequence (an upper bound on capture
   time). The frame store has no per-frame capture timestamp; nothing claims
   one.
3. **One owner of camera processing** (`compositor.rs`
   `camera_role_rgba`): the compositor's own `KeyedLevelPlane::build` (key,
   Hide edges, speck cleanup, despill, camera look) at the compositor's key
   reduction level, area-averaged to the logical size with straight alpha. Key
   off: average + `camera_look_rgb`. No geometry: crop, fit, mirror and mask
   remain S12's scene renderer's, so nothing is applied twice. Low-light is a
   device setting the native camera owner applies on open, not pixel work.
4. **Producer** (`room_camera_source.rs`): reads the app's current scene
   layout and the native preview camera's latest frame. Zero-copy frames
   without CPU bytes, a camera lent to the browser room, no camera or no frame
   are `camera-unavailable` (logged), never guessed. Processing runs on
   `spawn_blocking`.
5. **One camera owner** (`main.rs`): with `VIDEORC_ROOM_PROCESSED_CAMERA=1`
   (debug build + smoke RPC), the room's camera Lend is skipped; the native
   camera stays the owner (`keptForRoom`), and Return clears it. `open`
   refuses while the camera is lent and opens only at the size the camera
   gives now. Admin-socket RPCs `room.camera.processed` and
   `room.camera.processed.inspect` (sources, leases, logical size, layout
   source, key, native mirror, look, kept/lent, fixture).
6. **Main/preload** (`apps/desktop/src/main/index.ts`): IPC
   `room-camera:inspect`, `room-camera:processed`, `room-camera:fixture`,
   registered only when unpackaged and the variable is set; one camera owner
   per sender and generation, mutually exclusive with the S13a fixture owner;
   navigation, crash or destruction closes the socket.
7. **Renderer**: the room asks main for the processed size; no size means the
   camera is reported off, published as off, and the open fails (never a raw
   camera). With the processed camera on, the room's media grant has no
   browser camera. `room-frame-source` pauses the publication after 2 s of
   `camera-unavailable` (no raw fallback); the room then shows the camera off
   with the reason, and turning it back on opens a new generation (no
   automatic reopen). The monitor tile and S12's preview get the logical size from
   the camera-frame descriptor.
8. **Web**: the camera-frame adapter derives the logical size from the first
   decoded frame (`(videoWidth - 8) / 2`) when no size is given; the stage
   binds once per adapter (`cameraFrameBound()`).

## Frozen public contracts (additions to S13a)

- Role `host-camera`, flags `packed = 1`, `ptsObserved = 2`; header unchanged
  otherwise. Fixture: `protocol-fixtures/room-camera.json` (role, flags,
  zones, logical sizes, 32 pixel vectors), generated from `room-camera.ts`
  and checked by the native test.
- `RoomCameraResources` (`apps/desktop/src/shared/room-camera.ts`) is the
  inspect shape; `RoomCameraFixtureAction = 'fixture-switch' | 'fixture-unplug'`.
- Debug fixture `VIDEORC_ROOM_PROCESSED_CAMERA_FIXTURE=WxH` substitutes the
  device only (green ground, warm subject, green fringe, grey look patch, red
  mirror marker on the left, stamp rows). Processing, transport and consumers
  are production code.
- S10 limits and S12's `logicalSize()` seam unchanged; S12 still owns mirror.

## Maintained acceptance: `pnpm smoke:cloud-parity -- --case camera` (not run)

`scripts/lib/cloud-parity-camera.mjs` (acquisition) and
`scripts/lib/cloud-parity-camera-contract.mjs` (pure rules, budgets):

- Per fixture source size (`VIDEORC_CAMERA_SOURCES`, default
  `1280x720,640x480`): a fresh harness with the processed camera and fixture,
  the app layout patched to key on `#00ff00`, look `{0.08, 1.15, 1.2}` and
  native mirror ON; a room opens; the SFU must show a camera-frame descriptor
  and no raw camera.
- Ownership: `keptForRoom`, not lent to the browser room, no browser camera.
- Program page (loopback, `cameraFrameExperiment=1`) samples the decoded
  packed track at logical points: resolution and packed width; keyed ground
  alpha; subject alpha and colour (look applied once); look patch shifted to
  the expected value; fringe kept with green excess removed (spill); red
  marker on the source side and not the mirrored side (mirror never baked);
  keyed-edge ramp width; at least 30 distinct stamped sequences.
- Lifecycle (first source): off, fixture switch, fixture unplug each pause
  within 5 s with no raw camera; switch and unplug reopen with a new
  generation.
- Unavailable (never a pass): real device unplug/switch, Windows low-light
  device, zero-copy capture cameras, capture timestamps, recording matrix and
  preview probes, managed budgets. The analysis never sets
  `productionQualified`.
- Modes: `VIDEORC_CAMERA_MODE=acquire|analyze|acquire-analyze`,
  `VIDEORC_CAMERA_SECONDS` (5..600), `VIDEORC_CAMERA_EVIDENCE` for analyze,
  `VIDEORC_CAMERA_OUTPUT` (default `~/videorc-parity-evidence/camera`, outside
  the checkout and `/tmp`). Needs a debug backend built from this slice,
  installed dependencies, local LiveKit, Chrome and `VIDEORC_PARITY_WEB_ROOT`.

## Verification (focused only)

- Desktop TS7 `tsconfig.node.json` and `tsconfig.web.json`: pass.
- Vitest (7 files: room-camera, room-frame, room-frame-bridge,
  electron-ipc-contract, room-frame-source, talk-show-room,
  camera-frame-media): 151 pass.
- Node: cloud-parity-contract, camera-contract, camera-bridge-contract: 29
  pass.
- Isolated scratch crate with `room_clock.rs` + `room_frame_bridge.rs` (by
  path): 9 tests pass, clippy `-D warnings` clean. `cargo fmt --check -p
videorc-backend`: pass.
- Prettier and oxlint on all touched files: clean (one oxlint warning in
  `use-studio.tsx` exists on the base, unchanged).
- Web: emit check up to date, `tsc --noEmit` pass, camera-frame + program
  tests 235/242: the 7 failures (`cloud-program-stage-metadata`,
  `cloud-program-bundle`) fail identically on the untouched base `952ce7b5`.
  ESLint and Prettier clean on touched files.
- Shadscan final: desktop 27, web 47 (baseline unchanged).
- **Not compiled**: `compositor.rs` (`camera_role_rgba` + 4 tests),
  `room_camera_source.rs`, `main.rs` handler + admission tests. Backend
  compilation, `cargo test -p videorc-backend` and clippy are owed.
- Not run: the camera case, recording-studio and preview gates, devices,
  managed runs.

## PR-ready text

### Desktop

Title: `Plan 249 S13b: add disabled processed camera contributions`

Body:

Carry the app's processed camera on the S13a frame bridge instead of a
browser capture. A new `host-camera` role sends the native camera through the
compositor's own camera-source processing (key, Hide edges, speck cleanup,
despill, look) at an aspect-preserving logical size within S10's limits, with
native observation timestamps flagged as such. Scene crop, fit, mirror and
mask stay S12's, so nothing is applied twice. One camera owner: when the
processed camera is on, the room no longer borrows the camera and the browser
gets no camera grant. Camera loss, switch or zero-copy frames pause the
publication; a raw camera is never published in its place. Add the maintained
`camera` parity case (keyed edge, spill, look, mirror, resolution,
ownership and off/switch/unplug with a debug fixture device) and its rules.

Disabled everywhere: debug backend with smoke RPC, unpackaged main and an
explicit environment variable only; no production grant, Preview, device or
security change. Base: S13a tip `3e42ca9af` (PR #1459). Pair with the web PR.
Focused checks only: TS7, Vitest, Node, an isolated Rust module, lint and
format. Backend compilation and every runtime, managed, device and platform
gate (including Windows low-light) are deferred; no parity is claimed.

### Web

Title: `Plan 249 S13b: size the camera-frame consumer from the decoded frame`

Body:

The processed camera's logical size follows the camera's aspect. When the
controller gives no size, the camera-frame adapter derives it from the first
decoded packed frame and reports it through S12's `logicalSize()` seam once
known; the program stage binds each adapter once. Emits the changed modules.
Still loopback-only behind `cameraFrameExperiment=1`. Base: web S13a tip
`952ce7b5` (PR #140). Focused checks only; pre-existing failures unchanged.

## Exact changed paths

Desktop modified (21): `apps/desktop/src/main/index.ts`,
`apps/desktop/src/main/room-frame-bridge.test.ts`,
`apps/desktop/src/main/room-frame-bridge.ts`,
`apps/desktop/src/preload/index.ts`,
`apps/desktop/src/renderer/src/components/studio/show-stage.tsx`,
`apps/desktop/src/renderer/src/hooks/use-studio.tsx`,
`apps/desktop/src/renderer/src/hooks/use-talk-show-room.ts`,
`apps/desktop/src/renderer/src/lib/camera-frame-media.ts`,
`apps/desktop/src/renderer/src/lib/room-frame-source.test.ts`,
`apps/desktop/src/renderer/src/lib/room-frame-source.ts`,
`apps/desktop/src/renderer/src/lib/talk-show-room.test.ts`,
`apps/desktop/src/renderer/src/lib/talk-show-room.ts`,
`apps/desktop/src/shared/backend.ts`,
`apps/desktop/src/shared/electron-ipc-contract.test.ts`,
`apps/desktop/src/shared/electron-ipc-contract.ts`,
`apps/desktop/src/shared/renderer-security-policy.ts`,
`apps/desktop/src/shared/room-frame.ts`,
`crates/videorc-backend/src/compositor.rs`,
`crates/videorc-backend/src/main.rs`,
`crates/videorc-backend/src/room_frame_bridge.rs`,
`scripts/smoke-cloud-parity-app.mjs`.

Desktop new (8): `apps/desktop/src/shared/room-camera.ts`,
`apps/desktop/src/shared/room-camera.test.ts`,
`crates/videorc-backend/src/room_camera_source.rs`,
`protocol-fixtures/room-camera.json`,
`scripts/lib/cloud-parity-camera.mjs`,
`scripts/lib/cloud-parity-camera-contract.mjs`,
`scripts/lib/cloud-parity-camera-contract.test.mjs`,
`docs/cloud/249-s13b-handoff.md`.

Web modified (7): `lib/cloud/program/camera-frame.ts`,
`lib/cloud/program/stage-media.ts`, `lib/cloud/program/stage.ts`,
`public/cloud/program/v1/camera-frame.js`,
`public/cloud/program/v1/stage-media.js`,
`public/cloud/program/v1/stage.js`, `tests/cloud-camera-frame.test.ts`.

## Dependencies before PR-ready

- S13a (#1459, web #140) merges first; this branch sits on its tips.
- Backend compile, `cargo test -p videorc-backend` (compositor
  `camera_role_tests`, `room_frame_bridge`, `room_camera_admission_tests`)
  and clippy.
- The `camera` case on macOS with local LiveKit; then real-device
  unplug/switch on macOS and Windows and Windows low-light on an actual
  device. Enabling `ROOM_PROCESSED_CAMERA_ENABLED` needs all of them and an
  owner decision.
