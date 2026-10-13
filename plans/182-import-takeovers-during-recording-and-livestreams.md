# Plan 182: Import takeover images while recording or live

Status: IMPLEMENTED; feature checks passed, broader gate blockers below (2026-10-13). Source baseline:
`origin/main` `672b185c`. Branch: `feat/live-takeover-import`.

Implementation includes the bounded import lane, live Assets import, picker
and reconnect fencing, scoped management locks, Studio navigation and the
recording/local-RTMP smoke. The import's list publication is serialized with
management publications; newer events also fence late management replies.
The Windows source gate repeats the new concurrency test 25 times alongside
its existing three full Rust suite passes.

PR: <https://github.com/TheOrcDev/videorc/pull/696> (draft because the full
verification set is not green).

Verification recorded on 2026-10-13:

- Local full Rust suite: 3,549 passed, 15 ignored (backend, native helper
  and wire integration tests). The new same/across-connection import
  concurrency regression passed independently too.
- Initial full desktop suite: 4,850 passed, one skipped. Focused import,
  provider and UI checks passed, including session start during the picker
  and Stop during processing. Subsequent interrupted/loaded runs timed out;
  affected files passed on retry. JS CI passed the full suite independently.
- Node scripts: 2,418 passed, one skipped. Typecheck, formatting, Rust fmt
  and desktop build passed. Lint passed with the existing captureConfig
  dependency warning.
- Real-backend command-lane smoke passed, with Stop and live controls
  replying in 2–3 ms before releasing blocked account maintenance.
- Final `VIDEORC_SCREENS_SMOKE_UI=1 pnpm smoke:screens` passed recording,
  local streaming and combined mode. All six recording/receiver artifacts
  passed image-sequence, audio and strict A/V analyzer checks, including
  horizontal and vertical destinations. Imports and corrupt-image failures
  preserved the active takeover and session; live compositor samples stayed
  within the 250 ms frame-age bound. Controlled PCM stayed audible before
  activation, was digitally silent during takeover, and returned on clear.
  New thumbnail images decoded successfully. Composited 960×660 light/dark
  screenshots were inspected; Import stayed enabled and management locked.
- `smoke:recording-studio` and its device-enabled superset were run. The
  bundle stopped at the Comments clipboard assertion; all remaining steps
  were then executed individually from the maintained gate definitions.
  Passed: frontend/Node/backend suites, live audio and caption contracts,
  caption/noise-cleanup artifacts, CPU/Metal scene-switch artifacts,
  all-layout recordings, quit finalization, enforced Record/Stop latency,
  output-stall microphone survival, takeovers, real launch, layout/source
  liveness, live layout switching, highlight and Buddy artifacts, preview
  scene commits/pump/focus/interaction, window placement, native surface
  reattach, real ScreenCaptureKit recording, Notes invisibility, real-device
  interaction/layout switching and source-complete native-preview recordings.
- [Windows source gate](https://github.com/TheOrcDev/videorc/actions/runs/38351465217/job/115144598094):
  new import concurrency filter passed all 25 repetitions; three full Rust
  runs each passed 3,368 tests with 15 ignored. Clippy, desktop/Node tests,
  TypeScript, lint and both formatting gates passed. Installer build passed.
- [Linux gates](https://github.com/TheOrcDev/videorc/actions/runs/38351464881)
  passed.
- macOS Clippy is blocked by the existing unused `map_source_pixel` in
  `compositor.rs:9395`, unchanged from the source baseline. macOS/Windows
  CI dependency audits fail on existing `quinn-proto` advisories (the
  lockfile is unchanged). Windows' separate startup incident diagnostics
  fail A/V-tail checks, including its independent FFmpeg control cases.
- Other unresolved gate failures: Comments' Copy link test observed no
  clipboard text; system-audio cases `on`, `self` and `stream` detected extra
  tone regions (and `self` exceeded its exclusion threshold). The 100-cycle
  preview lifecycle probe lost the main window at cycle 77; a clean rerun
  with no source edits reproduced it at cycle 40. These are recorded failures,
  not waived passes; this change does not modify those production paths.

CI results above refer to `7c259438`; subsequent changes fix the dev smoke
and add verification evidence, without changing the production Rust code.
The picker seam exercises the renderer and real resource capability but does
not manually operate each OS's native file dialog. Native-picker checks on
all three OSes, and Windows/Linux visual checks, remain outstanding.

Final local media evidence: `/tmp/videorc-182-screens-final.log` and
`$TMPDIR/videorc-screens-smoke-1791886078286/` (not committed). Broader logs:
`/tmp/videorc-182-studio-devices.log`, `/tmp/videorc-182-studio-remainder.log`,
`/tmp/videorc-182-lifecycle-final.log`. Use `VIDEORC_SCREENS_SMOKE_MODE` to run
one of `recording`, `streaming`, or `both`; `VIDEORC_SCREENS_SMOKE_UI=1` adds
minimum-window/theme captures to the combined case. macOS UI capture uses
the composited app window so its native glass layer is represented.

## Outcome

While recording, livestreaming, or doing both, the streamer can open
Assets → Takeovers, import an image, and use it immediately from Studio.
Importing adds an available takeover. Only an explicit activation changes
the output or invokes the existing takeover microphone behavior.

Use the current PNG, JPEG and WebP picker and managed local image storage.
“Upload” means importing a file from the computer, not sending it to a
server. This applies to macOS, Windows and Linux.

## Product decisions

- Keep **Import image…** enabled while recording or live, provided Videorc
  is connected and no import is already pending.
- Show **Choosing image…** while the picker is open, then **Importing…**
  while processing. Canceling the picker quietly returns to the idle state.
  Use the shared Button and Spinner, without invented percentage progress.
- Append the completed image to Assets and Studio's takeover choices. Never
  publish a partially processed image as ready. Do not select or activate it
  automatically, including when it is the first takeover.
- Keep the current takeover, scene, microphone state and recording/stream
  running throughout import, success, cancellation and failure.
- Preserve Studio as the home of activation. Give its Takeover section an
  **Open Assets** action even when it already has images; retain the empty
  state's route to Assets. Importing remains on Assets.
- Rename, reorder and delete retain their current session lock in this
  slice. Replace the blanket takeover lock with scoped copy:
  **“You can import images now. Stop recording or end the livestream to
  rename, reorder or delete takeovers.”** Put disabled reasons on the
  affected controls using the shared primitives. Offline copy takes
  precedence. Do not place an enabled import button under a whole-section
  “Locked” claim.
- On failure, show an actionable image-import error through the existing
  user-error mapping. A failed import does not stop the session or remove
  an existing image. A confirmed import followed by a failed refresh must
  not be reported as an import failure.
- Finish an accepted import if the user navigates away or stops the session.
  Starting a session while the picker/import is open also remains valid.
  App/backend shutdown follows owned-child cleanup; there is no background
  service that survives quitting.

This slice adds no video/GIF takeovers, batch import, drag-and-drop file
upload, cloud upload, replacement of an existing image, or new live editing
permissions. Those are separate product changes.

## What exists on main

Read these files from the current implementation checkout before editing.
The shared checkout used for planning is older than main; do not implement
against that older UI or overwrite its unrelated local work.

- Assets lock: `components/takeover-screens-section.tsx` combines session and
  offline state in `managementDisabled`, then applies it to import too.
- Import client: `hooks/use-studio.tsx` marks pending after the picker and
  refreshes both list and active state after import.
- Studio: `components/studio/session-panel.tsx` already activates live;
  only its empty state links to Assets.
- Picker: `src/main/index.ts` returns an input-file capability.
- Backend: `src/main.rs` resolves that capability, imports on the ordered
  lane (30 s execution envelope; renderer 45 s), then emits `screens.changed`.
- Storage: `src/storage.rs` optimizes before its short SQLite transaction,
  verifies managed file identity and cleans up unadopted output. Its existing
  blocked-optimizer test proves database finalization proceeds independently.
- Image preparation: owned FFmpeg with a 20 s timeout builds the existing
  3840×2160 fitted foreground and blurred background.
- Existing smoke: `scripts/smoke-screens-app.mjs` imported both images before
  starting and checked the resulting takeover sequence in a recording.

Relevant design sources are the current `videorc-design` skill,
`docs/ui-copy.md`, and the takeover microphone contract in
`lib/screen-takeover-microphone.ts`. Reuse the current post-plan-174 UI.

## Implementation slices

### 1. Isolate and bound import work

Add an asset-import lane for `screens.importImage` using the existing
isolated command-lane machinery. Do not put expensive image preparation
into the LiveControl, Stop or AccountMaintenance lane. Keep method role
authorization, file capability resolution and the watched mutation policy.

Enforce one admitted import process-wide, across connections, with no
unbounded waiting backlog. Reject an overlapping request promptly as busy
before expensive work or file publication. Acquire this admission before
dispatch and release it on every rejection/completion path, retaining
ownership until the worker and its child really finish. Preserve per-client
response correlation and publish a completed `screens.changed` event to
all existing subscribers.

Keep import independent of session-start/stop and live scene fences: it adds
a library asset, not active output state. Continue to serialize active
takeover transitions through their existing path. Short database
transactions must still serialize import append with rename/reorder/delete.
The new row must use current database ordering at commit time.

Run blocking image preparation off the async mutation executor workers
using the existing bounded blocking-work conventions. Retain the owned
FFmpeg timeout and cleanup. Dropping an async timeout is not sufficient to
cancel blocking work: prove the child is killed/reaped, and no worker can
publish after it has been reported definitively failed. Preserve existing
outcome-unknown/reconciliation behavior where completion cannot be known.

Give the import FFmpeg process an explicit modest resource budget: start
with one codec thread and one filter/filter-complex thread. Verify both
completion within the existing 20 s bound and live-output continuity on
supported hosts before accepting that choice. Do not change output image
geometry, quality, recording profiles or global FFmpeg defaults to make an
import faster. Invalid, oversized-for-the-existing-deadline, or corrupt
images fail with cleanup and an actionable error.

Verification: deterministic blocked-optimizer tests through the actual
dispatcher, on the same connection and another connection. While import is
held, prove health reads, takeover activate/clear, microphone changes, scene
changes and Stop complete within their existing budgets before releasing
the optimizer. Prove a second import is rejected without spawning a child.
Keep the existing database finalization regression. Check a session start
can complete during asset preparation without admitting a partial asset.

### 2. Make the client import lifecycle reliable

In `use-studio.tsx`, guard the operation synchronously before opening the
picker, not only with React state after file selection. Keep one pending
operation through choosing, importing and completion. Use an operation
token/client generation check so a response from an old client cannot
overwrite current state or clear a newer operation's pending state.

Reuse the capability-based picker and `screens.importImage` wire shape.
After success, reconcile the asset list without fetching/reapplying active
takeover state solely because an image was added. Existing authoritative
active-change events and reconnect bootstrap own that state. Ignore stale
list responses relative to a newer event; use the existing bootstrap/state
patterns rather than adding a second source of truth.

Do not automatically retry an outcome-unknown mutation. On reconnect,
reload the authoritative list first so a late successful import is visible.
Separate a confirmed import result from a later list-refresh failure.
Selecting the same file again deliberately after completion can still
create another takeover, as it does today; the guard prevents accidental
concurrent invocation, not intentional duplicates.

Verification: picker cancel, rapid repeated invocation, failed import,
navigate away and back, session start/stop during the picker and processing,
success plus failed refresh, a list event racing a reply, and reconnection
with a late response. Confirm no activation/clear or microphone command is
sent by importing.

### 3. Enable and explain live importing

Split import availability from management availability in
`TakeoverScreensSection`. Wire the pending phases and scoped lock copy
above. Reuse PanelSection, MediaCard, Button, Spinner and DisabledReason;
keep identical behavior in light and dark themes. Add the always-reachable
Open Assets action to Studio's Takeover section using existing navigation.
Keep empty-state and keyboard access coherent, with no new global shortcut.

Update the lock wording examples in `docs/ui-copy.md` and the maintained
design-skill copies if they still claim that all takeover actions are
locked while live. Do not change shared SessionLockAlert globally.

Verification: component tests for idle, recording, stream-only,
stream-plus-recording, disconnected, choosing and importing states; controls
for rename/reorder/delete remain locked live; newly imported ready assets
appear in Studio without a reload and without changing its active chip.
Check the actual native picker on each OS and the UI at minimum supported
window size in both themes.

### 4. Prove it through recording and streaming

Extend the maintained `smoke:screens` path, reusing its fixture generation
and artifact sampling. Exercise the real renderer import callback through
a test-only native-picker selection seam that still issues a real resource
capability; do not validate only a direct RPC that bypasses the disabled UI.

Run recording-only, livestream-only to a local test receiver, and
livestream-with-recording. Reuse the multistream smoke's local ingest
infrastructure; no public broadcast is required. Cover both an empty
takeover library and an already-active takeover. At least one streaming
case has horizontal and vertical destinations.

For each case, start the session first, import a new recognizable image,
prove the output stays as it was until activation, activate the new image,
then clear it and return to the scene. Assert a single session ID, no
restart/reconnect caused by import, continuous preview/frame progress,
continued audio before activation, and the existing takeover mic
mute/restore semantics after activation and clear. Add failure coverage
while an existing takeover is on air. Use the controlled blocked optimizer
for deterministic concurrent-control checks, not timing sleeps as a
handshake. Test Stop during processing explicitly.

Inspect finished recordings and captured receiver output with ffprobe and
ffmpeg: expected image intervals, no import-induced blank/frozen interval,
valid duration/timestamps and final-artifact A/V continuity within existing
analyzer tolerances. Extend sampling over the actual import timeline;
the current fixed six-second sample window is insufficient. Video byte size
alone is not evidence. Keep fixture media and result artifacts out of Git.

## Verification gates for implementation

Run focused takeover, client lifecycle, dispatch, storage and optimizer
tests first. Before handoff run:

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, desktop unit tests,
  `pnpm test:scripts`, and `pnpm build`.
- `cargo fmt --check --all`, `cargo clippy -p videorc-backend -- -D warnings`,
  and `cargo test -p videorc-backend`.
- `pnpm smoke:screens`, `pnpm smoke:command-lanes`, the extended local
  stream cases, and `pnpm smoke:recording-studio`.
- `pnpm probe:preview-lifecycle` to verify preview continues through the
  native picker and live import. Add `probe:preview-window` only if preview
  placement/lifecycle code changes.
- `pnpm smoke:recording-studio:devices` where device permissions are
  available, because this change introduces work during real capture.
  Record any hardware/permission block and run the closest focused probe.
- Repeat affected Windows async/process filters at least 25 times and the
  full Windows Rust suite three times from PowerShell 7 if those tests are
  changed. Use readiness channels and owned-child cleanup as AGENTS.md requires.

If implementation touches session start/stop/finalization code, add
`pnpm smoke:record-latency:gate`. If it changes profiles, colorimetry, export
or fps handling, add `pnpm smoke:recording-matrix`. If it changes remote
intents/projections, add the corresponding remote-control/LAN gates and
retain their authority boundaries. Those changes are not required by the
planned design.

## Completion criteria

The streamer can import and then show a new takeover during every supported
session mode on all three desktop platforms. Import leaves existing output
and microphone state untouched; expensive processing cannot hold up live
controls; failed/canceled imports leave no broken library entry or owned
child behind. Renderer tests and real recorded/received media prove the
behavior. Record actual gate results and remaining platform gaps in this
plan before calling implementation complete.
