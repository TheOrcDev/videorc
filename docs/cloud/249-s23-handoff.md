# Plan 249 S23: room-program virtual camera

Status: implementation complete, live acceptance **not run**. Rust **not
compiled** (owner rule: the full Rust build, tests, clippy and smokes run once
on main before the release). Production stays off
(`ROOM_PROGRAM_CAMERA_PRODUCTION_ENABLED = false`). Desktop only: S23 has no web
change (it reads the program page as S6 left it).

## Base

- Branch `feat/249-s23-cloud-parity` on `origin/main` `468f2777f` (S13a #1459
  merged) plus a cherry-pick of S13b's single commit `701177bd6` (PR #1464,
  still open, based on the pre-merge S13a branch). **#1464 must merge first.**
  The S13b commit is the first commit on this branch; once #1464 merges, rebase
  S23 on main and drop it (the S23 delta is the second commit only).
- S23's dependencies in `protocol-fixtures/cloud-parity-plan.json`: S6 (merged),
  S13a (merged), S13b (#1464). S23 itself does not call S13b code; it is built on
  it so the camera tile it rasterizes is the merged S13b behaviour.

## What the slice adds (D10)

1. **One explicit opt-in per room.** The Program preview (managed show, S6
   `program-page-report`) gets a row: "Send to Videorc Camera" / "Stop
   sending" and a status line. Off by default, never remembered, and it ends
   with the room (`talk-show-room-host.tsx` retires it when `hostIdentity`
   changes). A node show's runner return never offers it (that is encoded).
2. **What the camera shows.** The renderer rasterizes the Program preview's own
   DOM (`room-program-raster.ts`) into a 1280x720 canvas 30 times a second:
   every visible `<video>`, `<img>` and `<canvas>` at its laid-out box with
   `object-fit`, mirror, opacity and clip (overflow, rounded corners, the
   host's circle), plus painted backgrounds. So graphics (S9 `<img>`), avatar
   (S4/S5 `<img>`/`<canvas>`), takeover image and scene geometry (S12) appear
   exactly as the preview shows them, and anything the preview hides (a packed
   camera drawn at opacity 0) stays hidden. Text is not drawn (camera-off
   initials, status copy).
3. **Transport (`VRPC`).** Renderer → main IPC (`room-program-camera:frame`,
   exact 1280x720 RGBA, one in flight, latest wins) → one chunked loopback
   upload per generation `POST /room-program-camera/frames?token=<admin>&generation=<n>`
   (admin token only) → backend converts RGBA to I420 with the CPU
   compositor's BT.709 video-range helpers (`color.rs`) off the runtime
   (`spawn_blocking`) → a frame store Videorc Camera's existing output engine
   reads (`virtual_camera_service.rs` picker). 40-byte header pinned by
   `protocol-fixtures/room-program-camera.json` (TS and Rust tests).
4. **Ownership.** The upload is the owner: one at a time, generations only
   grow (a used or older one is refused), and when it ends (opt-out, room end,
   renderer navigation/crash/destruction, main gone) the camera returns to its
   Studio source on the next tick. While it owns the camera, the camera does
   not arm the native preview run (`refresh_wants_lease`), and nothing touches
   native camera ownership (S13b's Lend/keep rules are unchanged).
5. **Privacy and stills.** When frames stop for 1 s (Show stage closed,
   preview not displayed, renderer stalled), the camera shows a black paused
   still, never a frozen picture and never the Studio program. The renderer
   sends nothing while the preview has no box. Turning Videorc Camera off keeps
   its existing off still.
6. **Identity.** `VirtualCameraStatus.source` (optional, omitted when absent):
   `room-program-preview` or `room-program-paused`, only on a running camera.
   In the RPC contract and `protocol-fixtures/virtual-camera.json`. The Output
   line says "Showing the room's Program preview"; the Program preview row says
   "Videorc Camera shows this Program preview · Not the encoded stream".
   Inspection (`room-program-camera:inspect`) reports `viewSource:
   program-page-report` and `encodedOutput: false`.
7. **No feedback loop.** `pickRoomCameraDevice` never opens Videorc Camera as
   the room camera, even if the Sources camera is named that (the room already
   opens only an exact named device, so nothing else is opened in its place).

## Gates (all three required to offer it)

- Unpackaged main with `VIDEORC_ROOM_PROGRAM_CAMERA=1` (`room-program-camera:available`).
- Debug backend with the same variable (`room_program_camera::enabled`); the
  upload route answers 403 otherwise.
- Videorc Camera registered on the host (it still needs its own switch on).

## Maintained acceptance: `pnpm smoke:cloud-parity -- --case virtual-camera` (not run)

`scripts/lib/cloud-parity-virtual-camera.mjs` (acquisition) and
`scripts/lib/cloud-parity-virtual-camera-contract.mjs` (pure rules, 7 Node tests):
local LiveKit room, program page on loopback, the real opt-in button, Videorc
Camera read from outside the app with the platform's FFmpeg (the
`smoke:virtual-camera` reader plan), per-frame summaries only.

- `live`: 30 ± 1 fps over the read, a moving lit picture, status
  `room-program-preview`, inspection `program-page-report` / `encodedOutput: false`.
- `paused` (preview hidden): black within 2.5 s, status `room-program-paused`, cadence kept.
- `resumed`: lit again within 3 s.
- `off`: the feed released, the status names no source (Studio source).
- `reconnected`: a strictly newer generation, lit again.
- `noFeedbackLoop`: no `<video>` plays a Videorc Camera track; the room camera is not Videorc Camera.
- Modes `VIDEORC_VIRTUAL_CAMERA_MODE=acquire|analyze|acquire-analyze`,
  `VIDEORC_VIRTUAL_CAMERA_SECONDS` (5..600), `..._PHASE_SECONDS` (3..60),
  `VIDEORC_VIRTUAL_CAMERA_EVIDENCE`, output `~/videorc-parity-evidence/virtual-camera`.
- Unavailable (never a pass): signed packaged apps (`smoke:virtual-camera`),
  marker-exact graphics (views/graphics cases), backend restart mid-upload,
  managed room.

## Verification (focused only)

- `pnpm typecheck`, `pnpm lint` (one existing `use-studio.tsx` warning),
  `pnpm format:check`: pass.
- Vitest, touched files: room-program-camera (shared, main, renderer),
  room-program-raster, virtual-camera-view, backend-rpc-contract,
  electron-ipc-contract, preload-api-policy, renderer-security-policy,
  talk-show-room, show-stage, videorc-camera-section, diagnostics-tab-page,
  command-palette, backend-event-message, virtual-camera-action,
  use-talk-show-room(-join): pass.
- Node: cloud-parity-* and virtual-camera-smoke tests: 130 pass.
- Renderer budget (`pnpm build` = electron-vite, no Rust; `pnpm check:renderer-assets`):
  pass. Eager JS 2,404,925 raw / 494,968 gzip against ceilings 2,405,000 /
  495,000; the base (main + S13b) is 2,404,872 / 494,950, so S23 adds 53 raw /
  18 gzip bytes. Headroom left: 75 raw / 32 gzip.
- `cargo fmt --all`: clean. **Not compiled:** `room_program_camera.rs` (new,
  5 tests), `virtual_camera_service.rs` (picker, lease rule, status source, 1
  test), `virtual_camera.rs` (fixture test), `protocol.rs`, `main.rs` routes.

## Owed after merge

- Rust build, `cargo test -p videorc-backend`, clippy `-D warnings`.
- `pnpm smoke:cloud-parity -- --case virtual-camera` on a host with Videorc
  Camera registered; `pnpm smoke:virtual-camera` on signed packaged apps (macOS
  and Windows); C, R and P gates.
- Ledger: set S23 to `source-implemented-review-open` with the PR URL in
  `cloud-parity-plan.json` and the execution ledger (left to the ledger owner;
  open PR #1463 rewrites those entries).
