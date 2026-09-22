# Plan 043: Make Freeform manipulation continuous and visually consistent

Status: IMPLEMENTED — Freeform acceptance passed; draft PR with native recording
acceptance open. Branch `fix/freeform-editor-continuity` integrates `origin/main`
at `3b7a3529`. Execution authorized 2026-09-22.
PR: [#384](https://github.com/TheOrcDev/videorc/pull/384) (draft).
Priority: P1. Effort: L (several bounded slices). Risk: MED.
Category: correctness, interaction performance, design, regression coverage.
Planned: 2026-09-22. No dependency on Plan 042; preserve its scene-switch animation decisions.

## Start in the correct implementation

The user's report concerns **the shape in the Scene editor**, not flicker in the
detached preview. They want smoother movement and a design that belongs to
Videorc. After reviewing the investigation, they authorized execution of the
entire plan and creation of a PR. This authorizes implementation, commit and
branch push for that PR; merging and release remain separate.

This plan is stored in `/Users/orcdev/projects/videorc`, HEAD `15206746`, but that
checkout does **not** contain yesterday's Freeform implementation. The source
investigated is `/Users/orcdev/projects/videorc-wt-studio-fixes`, HEAD `ebcd29da`,
which includes `de4c9fc9` (2026-09-21, PR #378, layout editor). The running
`/Applications/Videorc.app` visibly has Freeform, numeric transforms, and eight
resize handles consistent with that implementation. Its installed bundle SHA
was not independently attested. Do not apply this plan to the older SceneStage.

Executor: work from a branch containing PR #378, read this entire plan, then run:

```sh
git merge-base --is-ancestor de4c9fc9 HEAD
git diff --stat ebcd29da..HEAD -- apps/desktop/src/renderer/src/components/scene apps/desktop/src/renderer/src/components/tabs/layout-tab.tsx apps/desktop/src/renderer/src/hooks/use-studio.tsx apps/desktop/src/shared/backend.ts crates/videorc-backend/src/scene.rs crates/videorc-backend/src/protocol.rs
```

Compare changed files with the evidence below before coding. Reconcile semantic
drift rather than blindly patching line numbers. Do not merge the unrelated
Windows waiver work merely to obtain the editor. The sibling worktree was clean
at investigation time. Preserve existing user changes in the plan-storage repo,
including untracked Plan 042 and local pnpm database files.

## What was verified

- Inspected the running dark-theme Scene screen and its accessibility tree.
  Did not drag or modify the user's saved scene. Light theme, portrait behavior,
  and frame-time performance still require runtime verification.
- Executed the actual TypeScript gesture handlers and geometry helpers in an
  in-memory Node harness, transpiled from source, with synthetic pointer input
  and a simulated commit callback. No source or scratch file was written.
- Repeated release handling three times: displayed x follows
  `0.3141667 -> 0.46 -> 0.3142` (ghost, ghost cleared, commit acknowledged).
  This proves the state discontinuity; it does not measure how many real frames
  the stale position is displayed during an actual backend round trip.
- Replayed snapping at x `0.0149, 0.0151, 0.0149, 0.0151`: rendered x becomes
  `0, 0.0151, 0, 0.0151`. On a 480px canvas a 0.096px input change produces a
  7.248px output jump. No hysteresis or stable snap identity exists.
- Replayed aspect-locked southeast resizing from
  `{x:.3,y:.3,width:.3,height:.3}`, dx `-.1`, dy `.099` then `.101`: width
  jumps from `.2` to `.401`. The dominant-axis choice changes sign abruptly.
- Existing `stage-transform.test.ts` (22) and `transform-fields-math.test.ts`
  (12) tests all pass. Their coverage does not protect these sequences or the
  asynchronous component-to-backend handoff.
- The full desktop suite also passed: 177 files, 1,792 passed tests and one
  skipped test, 29.43 seconds. This does not substitute for the missing gesture
  and visual acceptance coverage.

The initial read of the older checkout found a separate clear-ref-before-read
bug. PR #378 already fixes that bug; it is explicitly **not** this plan's cause.

## Prioritized findings

All paths and line numbers below refer to `ebcd29da` in the newer worktree.

| Finding | Evidence | Impact / confidence | Effort / fix risk |
| --- | --- | --- | --- |
| Discontinuous drag snapping and corner resize | `components/scene/stage-transform.ts:90-109,157-162,263-290` under renderer `src` | Visible jumps from tiny motion; HIGH, replayed | M / MED |
| Ghost disappears before asynchronous confirmation | `scene-stage.tsx:248-280`; `tabs/layout-tab.tsx:232`; `hooks/use-studio.tsx:6854-6874` | Old geometry can reappear between release and response; HIGH for state gap, runtime frame count unmeasured | M / MED |
| Precision intent is resnapped by backend | `crates/videorc-backend/src/scene.rs:241-251,647-649,687-697`; `stage-transform.ts:80` | Alt bypass, resize, and exact numeric edits may change again on release; HIGH from code | M / MED, protocol compatibility |
| Pointer coordinates use SVG viewport instead of painted canvas | `scene-stage.tsx:159-170,291-298` | Portrait/height-capped viewports track with wrong gain; HIGH conditional geometry defect, actual dimensions not measured | S–M / MED |
| Editor chrome obstructs geometry and scales unpredictably | `scene-stage.tsx:459-481,506-511,640-675` | Covered edge targets, overlapping tiny-source handles, floating circle handles; HIGH source evidence and dark-screen inspection | M / LOW–MED |
| Pointer lifecycle and update rate lack dedicated coverage | `scene-stage.tsx:130-143,209-245,550-568,662-675` | No pointercancel/lost-capture handlers; per-event state updates and Escape listener churn; HIGH code fact, frame-time impact unmeasured | M / MED |

The branding problem is **visual weight and hierarchy**. `styles.css:154` already
defines a monochrome primary. Do not invent an accent-color migration. The
observed editor has a broad gray camera fill, duplicate source names, bright
disconnected handles, extra stage glows, and HTML controls sitting over geometry.

## Target behavior and design decisions

1. A freely moved source follows the pointer at 1:1 screen-space displacement.
   No easing, spring, or CSS transition on geometry. Keep the current canvas
   bounds and source-size limits; “free” here means predictable direct control,
   not a new off-canvas cropping model.
2. Freeform starts with **Snap off**, with an explicit, accessible `Snap` toggle
   in its toolbar. This is the proposed product default for this fix. When on,
   use stable guides and hysteresis; Option/Alt temporarily bypasses snapping.
   Existing preset corner placement remains a separate, explicit behavior.
3. One backend transform commit per completed gesture; zero on every move and
   zero for a cancelled/no-op gesture. Keep the local final position until the
   corresponding authoritative scene is applied. Errors visibly revert once.
4. Keep the schematic stage and native detached preview architecture. Do not
   start a new camera, JPEG stream, or compositor in the Scene tab. Detached
   preview continues to update at commit, not on every pointer sample.
5. One quiet editor surface: source selector above, unobstructed canvas with
   edge-handle gutter, compact action/hint footer below. Preserve actual scene
   background content; remove extra decorative stage-only glow/sheens.
6. Use semantic theme tokens and existing shadcn primitives (`Button`,
   `ToggleGroup`, `Separator`, `Kbd`, `Tooltip`, `Field`, `InputGroup`). SVG is
   for scene geometry, not a second UI component system. Do not change global
   branding tokens to compensate for one overly bright component.
7. Use a 1px non-scaling selection frame, approximately 6px visible handles,
   and separate 20–24px hit areas where space allows. Circle sources get a clear
   rectangular bounds frame. For tiny sources, remove overlapping edge handles
   first, then use a single accessible resize affordance plus numeric sizing if
   corners still collide. Never depend on SVG paint order to pick a handle.
8. Keep typography in CSS pixels: 12–13px metadata, restrained monochrome
   outlines, subdued fills from existing tokens. Source names live in the
   toolbar; avoid duplicated, stroke-outlined SVG text. Dark and light use the
   same structure. Footer advertises only implemented actions/modifiers.

Proposed arrangement (a structural sketch, not a visual approval artifact):

```text
Scene layout                       Preset / Freeform
[ Screen source ] [ Camera ]                [ Snap ]
┌─────────────────────────────────────────────────┐
│   unobstructed composition canvas               │
│   subtle source regions + selected bounds       │
└─────────────────────────────────────────────────┘
Shift: constrain   Option: no snap   Esc: cancel
                                      Open preview
```

Keep the existing inspector beside this surface. Do not redesign other tabs.
The inspector's aspect-lock choice currently lives only in
`source-transform-fields.tsx`, whereas stage corner locking has separate logic.
Share one per-source editing preference between them; camera shape constraints
remain mandatory. A disabled forced lock must explain why it is locked.

## Scope and conventions

Implementation files (relative to the implementation worktree):

- `apps/desktop/src/renderer/src/components/scene/scene-stage.tsx`
- `apps/desktop/src/renderer/src/components/scene/stage-transform.ts` and its test
- `apps/desktop/src/renderer/src/components/scene/source-transform-fields.tsx`
- `apps/desktop/src/renderer/src/components/scene/transform-fields-math.ts` and test
- New focused `stage-gesture.ts` / `stage-gesture.test.ts` and, if needed,
  `stage-viewport.ts` / `stage-viewport.test.ts` in that directory
- `apps/desktop/src/renderer/src/components/tabs/layout-tab.tsx`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx` and focused tests/helpers
  only for the transform commit result/ordering and gesture shortcut arbitration
- `apps/desktop/src/shared/backend.ts`, `crates/videorc-backend/src/protocol.rs`,
  `scene.rs`, and affected Rust parameter constructors/tests for the snap policy
- `apps/desktop/src/shared/backend-rpc-contract.ts` and test only where the new
  transform parameter has a runtime contract; inspect the actual request route
- New maintained `scripts/smoke-freeform-editor-app.mjs`, a focused testable gate
  under `scripts/lib/`, root `package.json`, and recording-studio gate wiring
- `plans/043-smooth-freeform-scene-editor.md` and plan index status

No dependency installation is needed for the initial logic slices. Match Vitest
pure-helper patterns in `stage-transform.test.ts`, keep TS/Rust style, and follow
existing `PanelSection`/shadcn compositions. Read `videorc-design` and `shadcn`
skills before UI work. The project uses React 19, Electron, Vite, Radix shadcn,
Tailwind 4, Phosphor icons and `@/` renderer imports. Its Vitest environment is
Node, not a DOM; pure tests alone are insufficient for pointer capture.

Out of scope: capture/encoder replacement, scene-switch animation changes,
remote protocols, recording start/stop behavior, release/version changes,
global theme changes, arbitrary off-canvas cropping, undo history, multi-select,
live manipulation while recording. Keep editing disabled during active sessions.

Implementation branch: `fix/freeform-editor-continuity` from the current main
branch containing PR #378. The user authorized commits and push for the PR.
Do not merge or release as part of executing this plan.

## Slice 1 — Establish the interaction regression seam

Extract gesture state/geometry without changing behavior. Preserve the actual
component call sequence in tests; do not test a duplicate implementation.

Add deterministic tests for the numerical replays above, portrait viewport
mapping, delayed commit acknowledgement, rejection/disconnect, and stale
acknowledgement during a later gesture. Use deferred promises/fake clocks, not
fixed sleeps. Tests must show the current failures before the fix. Keep failing
characterization checks local to the fixing slice; do not leave the working
branch red between handed-off slices.

Add the maintained app smoke using existing app-launcher/CDP smoke conventions.
It must drive real pointer down/move/up/cancel on a disposable dev profile and
observe geometry per animation frame. The current
`smoke-preview-scene-commit-app.mjs:129` sends a transform RPC directly; that does
not cover the gesture or ghost handoff. Cover both seams. Own every spawned PID;
never clean up with broad process matching. Keep artifacts ignored/private.

Capture baseline pointer-to-paint timing, displayed rects, commit counts,
source ID/scene revision, and snap target during active gestures only. No idle
polling or permanent debug logging. This resolves whether rendering load also
contributes; the diagnosis has not established low FPS as the primary cause.

Verify: existing focused tests stay green; new regression cases fail at the
documented assertions before fixes; new smoke reproduces at least the delayed
handoff in a controlled environment. Stop if it only exercises a mocked copy
instead of the actual component. Name its package command
`pnpm smoke:freeform-editor` when adding it (this command does not exist yet).

## Slice 2 — Make geometry and gesture ownership continuous

### Coordinates and resize

- Convert client points through the SVG screen transform into viewBox units,
  then normalize by canvas dimensions. Either freeze a valid mapping during
  the gesture and cancel on resize, or rebase explicitly on resize; never mix
  mappings. Reject non-invertible/zero-size transforms safely.
- Fix aspect-locked corners using continuous projection of the pointer vector
  onto the fixed-aspect resize direction in CSS pixels. For anchor-to-start
  vector `v` and anchor-to-pointer vector `p`, use `dot(p,v)/dot(v,v)`, then clamp
  scale to existing aspect/minimum/bounds laws. This avoids the sign-changing
  dominant-axis selector. Preserve opposite anchors for all eight handles.
- Evaluate Shift axis choice in CSS pixels, latch it after a small movement
  threshold, and do not switch axes every time a noisy pointer crosses a tie.
- Preserve pointer-down grab offset. Ignore non-primary mouse buttons and
  unrelated pointer IDs. Store capture on a stable stage-owned element, not
  arbitrary text/rect event targets. Cancel on Escape, pointercancel, unexpected
  lost capture, source/scene replacement, editor disable, window blur or unmount.
  Intentional capture release after pointerup must not cancel a pending commit.
- Process the newest sample at most once per animation frame. Flush the exact
  pointerup sample before commit and cancel pending frames on cancellation.
  Attach keyboard/cancellation listeners by gesture lifecycle, not every ghost
  coordinate update. Avoid geometry transitions. Memoize static background and
  unrelated source rendering only if measured render cost justifies it.

### Snap policy

- In Freeform, default snap off; explicit toggle on enables snapping. Prefer
  an editor-local preference, not a new saved scene-format field.
- With snap on, start with 5 CSS-pixel acquisition and 9px release distances.
  Lock one target/edge pair per axis until release; use deterministic tie order
  and deduplicate targets. Release should rebase the pointer offset so breaking
  away does not jump by the whole magnet distance. Rebase modifier toggles too.
  Verify these initial thresholds by the interaction smoke and owner device.
- Do not tell the user Option/Alt allows precision if the backend resnaps it.
  Add an optional transform-update snap policy, for example `snap: 'none' |
  'legacy'`, defaulting to legacy for old callers. New stage commits use `none`
  because the displayed final geometry already represents the chosen policy.
  Numeric edits and resize commits use `none` as precision operations.
- Keep all finite-value, crop, size and position validation; the backend remains
  authoritative. In `scene.rs`, select sanitized-unsnapped vs legacy sanitized
  behavior. Do not remove snapping globally or alter preset corner placement.
  Mirror the optional field in Rust and TS and verify old serialized requests
  retain their behavior. Update affected Rust constructors deliberately.

Current backend excerpt (`scene.rs:247`):

```rust
source.transform = sanitize_transform(apply_transform_patch(
    source.transform.clone(),
    params.transform,
));
```

Verify: all focused geometry/gesture tests pass; specific resize replay no
longer doubles width; unsnapped displacement matches client movement within
1 CSS pixel in landscape and portrait; tiny snap-boundary noise does not
alternate targets. Rust transform tests prove legacy behavior and explicit
unsnapped precision. Run typecheck, lint, Rust fmt/tests/clippy for these files.

## Slice 3 — Preserve geometry through authoritative commit

Current component and caller (`scene-stage.tsx:253`, `layout-tab.tsx:232`):

```tsx
const delta = normalizedDelta(gesture, event)
gestureRef.current = null
setGhost(null)
// ...
onCommitTransform?.(gesture.sourceId, committed)

onCommitTransform={(sourceId, transform) =>
  void setSceneSourceTransform(sourceId, transform)
}
```

The hook awaits the backend, applies `SceneCommitStatus`, syncs layout overrides,
and catches errors without returning an outcome. A `void` callback cannot tell
the stage when it is safe to relinquish the draft.

- Model `idle -> dragging -> pending -> committed/reverted` explicitly. Return
  a typed result from the transform callback with the authoritative scene and
  revision (or typed failure). Do not treat a swallowed error or no client as
  successful acknowledgement.
- Keep the final draft visible through pending. Hand it off only when the
  matching authoritative state is available for the same scene/source and edit
  generation, atomically enough to prevent a render of the old rect.
- Start a second drag from the displayed rectangle, including an outstanding
  draft. Serialize completed transform commits in order; older responses may
  advance canonical state but must not clear or overwrite newer displayed work.
  Do not globally rewrite scene authority in `use-studio` to solve a local bug.
- If the source/scene changes, invalidate that edit's presentation ownership.
  If a dependent commit fails, invalidate dependent drafts, return once to the
  last authoritative state, and use the existing error channel. Prevent a
  permanently pending UI when the backend disconnects.
- Preserve `sourceTransformOverrides` for camera and screen and the committed
  revision contract used by native preview. Avoid an extra scene reload that
  rebuilds the just-committed source. Arbitrate arrow nudges/numeric edits against
  a pending pointer operation so two edit paths cannot silently fight.
- Keep source sizing, aspect preference and focus ownership consistent between
  stage and inspector. Do not publish each pointer sample into Studio context
  solely to update numeric readouts.

Verify: fake acknowledgements delayed 50ms and 250ms never expose pre-drag
geometry; exactly one RPC per completed gesture, zero cancelled/no-op RPCs;
two quick edits cannot be overwritten by an older acknowledgement; failures
revert once with visible error; committed scene and stored overrides agree.
Run `pnpm typecheck`, focused gesture tests and `pnpm smoke:freeform-editor`.

## Slice 4 — Apply the restrained editor design and verify end to end

Move source selection and preview controls out of the canvas. Compose the
toolbar/footer from installed primitives, expose Snap state and supported
modifier hints, use subtle source fills and a clear fixed-size selection frame,
and make handle targets adaptive as specified above. Clip scene content to the
canvas but keep the separate selection gutter reachable at all four edges.
Keep actual background imagery distinct from editor chrome. Use the same aspect
mapping for selection rendering, pointer conversion and hit testing.

Use source selection buttons and precise fields as keyboard alternatives.
Do not leave interactive descendants hidden behind an undifferentiated
`role="img"` without an accessible equivalent. Ensure focus is visible, input
editing never triggers a scene nudge, and shortcut hints match real behavior.

Verify screenshots at narrow and wide app sizes, landscape and portrait, dark
and light; circle/rounded/rectangle shapes; long names; full-canvas and minimum
size sources; sources near each corner; overlapping screen/camera. The smoke
must assert toolbar/footer boxes do not intersect the editable canvas and all
visible handles map to the intended hit target without overlap ambiguity.

At 60Hz on the named local test machine, proposed interaction targets are p95
pointer-to-next-paint <=33ms and no gesture-attributable task >50ms. Treat these
as new acceptance targets, not measured current performance. Record machine,
viewport, refresh rate and sample count. Collect at least 20 move and 20 resize
gestures in both orientations. Do not use average FPS to hide position jumps.
No snapping-disabled discontinuity >1 CSS pixel beyond commanded pointer motion;
no old-position frame during successful release handoff. Include low-rate,
high-rate, diagonal reversal, pointer leaving stage, modifiers, and cancellation.

## Commands and completion gates

Use Node 24 and pnpm 11. The default login shell in this investigation resolved
Node 19 / pnpm 8 and rejected the repo; installed compatible tools are available:

```sh
export PATH="/opt/homebrew/opt/node@24/bin:/Users/orcdev/Library/pnpm:$PATH"
node --version
pnpm --version
```

Focused existing check (verified equivalent direct Vitest invocation):

```sh
pnpm --filter @videorc/desktop exec vitest run src/renderer/src/components/scene/stage-transform.test.ts src/renderer/src/components/scene/transform-fields-math.test.ts
```

Add new focused files to that command when created. Avoid `test -- <paths>` here:
the observed pnpm/Vitest forwarding invoked the full suite rather than filtering.

Before implementation handoff, all applicable commands must exit 0:

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm --filter @videorc/desktop test
pnpm test:scripts
cargo fmt --check --all
cargo test -p videorc-backend
cargo clippy -p videorc-backend -- -D warnings
pnpm build
pnpm smoke:freeform-editor
pnpm smoke:recording-studio
pnpm smoke:recording-studio:devices
```

`smoke:freeform-editor` is new work in Slice 1. Add it to the maintained
recording-studio gate list; assert its wiring using that list's existing tests.
The recording-studio gate must retain existing artifact analysis and preview
reliability checks. For native-preview lifecycle changes, additionally run
`pnpm probe:preview-lifecycle`; placement/move-resize changes add
`pnpm probe:preview-window`. Encoding/fps/color changes are out of scope; if
required, re-scope and include `pnpm smoke:recording-matrix`. Session start/stop
changes similarly require record-latency gates rather than being slipped in.

If camera/mic/screen permissions block a real-device gate, state the precise
blocker, run the closest focused preview probe, and keep device acceptance
pending. Do not claim completion with typecheck and pure tests alone.

Done means all four slices pass their stated checks, successful gestures have
continuous display and exact commits, dark/light visual evidence is reviewed,
recorded artifacts retain the committed composition, and the plan index is
updated. Do not commit app data, private screenshots, videos, tokens or logs.

## Stop conditions and limits

- PR #378 is absent, or changed ownership of transforms invalidates this plan.
- Correctness requires a renderer-owned scene authority or per-pointer backend
  commits. Reconsider the design instead of weakening the ownership contract.
- An explicit unsnapped commit is later resnapped by another pipeline stage.
  Locate and document that stage before changing protocol semantics further.
- The only reproducible flicker is native preview output or source-capture
  loss. That is outside the user-confirmed symptom and needs a separate diagnosis.
- No real component interaction seam can be established. Pure geometry tests
  alone cannot certify pointer capture, frame continuity or hit testing.
- Any fix requires changing out-of-scope behavior or repeatedly fails its gate.

Not audited: general security/dependencies, encoder performance, unrelated
Windows releases, provider integrations, full app UI, or Plan 042's missing
source output. No implementation smokes were run for this documentation-only
investigation. No assertion is made that CSS animation, capture restarts or
Electron itself causes the reported editor flicker.

Maintenance: keep display-pixel geometry independent of output pixel resolution;
extend cancellation and commit-order tests when adding touch, multi-select,
undo or live editing. Review snap behavior end to end whenever transform RPCs or
backend sanitization change. The important invariant is that the last displayed
gesture rectangle and the accepted committed rectangle agree without a stale
intermediate frame.


## Execution record (2026-09-22)

Implementation is isolated in `fix/freeform-editor-continuity`, based on
`origin/main` at `7b093ce9a`. The implementation paths had no semantic drift from
the investigated Freeform commit. The user's original working tree was preserved.

- Added a per-gesture controller with display-pixel coordinate mapping, a stable
  Shift axis, continuous aspect projection, and optional snap hysteresis. Snap
  starts off. Pointer capture, cancellation and animation-frame coalescing are
  owned by the stable SVG surface; release flushes the last sample.
- Added a serialized commit controller that retains the last presented rectangle
  through the authoritative backend acknowledgement. Rapid same-source gestures
  use the latest draft; failed or invalidated contexts discard dependent edits.
- Precision transform requests explicitly send `snap: "none"`. Omitted policy
  retains legacy backend behavior, and numeric sanitation remains enforced.
  Provider integration coverage verifies persistence, failures and stale replies.
- Moved controls outside the canvas, reduced visual weight, and kept selection
  handles a constant CSS-pixel size with nonoverlapping targets for small sources.
  The inspector and pointer editor share per-source aspect preferences and exclude
  conflicting edits while a gesture or numeric commit owns the interaction.
- Added a maintained trusted-pointer Electron smoke and a separately tested
  trajectory/geometry analyzer; wired the smoke into the recording-studio gate.
  Evidence stays in temporary directories outside the repository.

Validation history: native builds initially encountered substantial host memory
pressure; an initial smoke launch timed out waiting for the build before any
interaction assertions ran. This is not recorded as an editor pass. One initial
full Node test run hit the existing 100ms mocked readiness deadline under load;
the unchanged focused retry passed. Final gate results and runtime acceptance
are recorded below, including the unresolved native recording gate.


Verification results:

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | PASS, final UI source |
| `pnpm lint` | PASS, final UI source |
| `pnpm format:check` | PASS, final UI source |
| `pnpm build` | PASS, final UI source |
| `pnpm --filter @videorc/desktop test` | PASS: 185 files, 1,868 passed, one skipped, after saved-scene integration |
| `pnpm test:scripts` | PASS: 1,439 tests, final integrated full suite |
| `cargo fmt --check --all` | PASS |
| `cargo test -p videorc-backend` | PASS: 2,259 passed, nine ignored, post-integration |
| `cargo clippy -p videorc-backend -- -D warnings` | PASS |
| Native backend/helper/addon builds | PASS |
| `pnpm smoke:freeform-editor` | PASS: 98 gestures, 20 screenshots, finalized artifact |
| Device-inclusive recording-studio gate | Standard steps PASS; device stress rerun and real layout switching PASS; source-complete native recording FAIL (9 then 10 CPU fallback frames) |

Review additionally found that a centered resize target can cover the body of a
minimum-size source. The single tiny-source resize handle is now offset outside
the shape, with a constant gutter and a visible connecting line. Its offset stays
fixed during a resize; tests cover body access and all four canvas corners in
both orientations.

The maintained app smoke also checks a finalized Freeform MP4. It retains the
actual inspector-committed source IDs/transforms/crops, substitutes deterministic
test-pattern capture kinds, and records through the real compositor/encoder. It
checks both saved overrides separately, plus decoded pixel bounds and foreground
outside the expected rectangles. This synthetic capture proof does not claim
real camera permission or device acceptance.


Real-app acceptance passed on Apple M4 (10 cores), macOS 25.5.0, Electron 39.8.10.
The actual display measured 120 Hz (8.33ms rAF interval), rather than the proposed
60 Hz setup; no 60 Hz claim is made. Across 448 measured input-to-DOM-paint-boundary
samples, aggregate and each-orientation p95 were 10.7ms, maximum 17.7ms. Physical
scan-out was not measured. The unchanged stricter per-gesture 33ms gate also
passed. Earlier instrumentation issues were corrected (synthetic source ID,
trusted mouse button state, pointer-capture observation, and coalesced-input
sampling); an earlier loaded run's 33.9ms sample was retained as a failed run.

The successful run covered 49 gestures per orientation: 20 moves, 20 resizes,
locked diagonal reversal, active snap acquisition/release, Alt bypass, Shift,
Escape/pointercancel/outside-stage cancellation, no-op and two rapid edits.
No geometry, delayed-handoff, capture, RPC-count or long-task gate failed. Visual
review covered dark/light, narrow/wide, portrait/landscape, full/minimum source
sizes, all corners, source overlap, and simulated long-name truncation. Review
found and fixed a legacy capsule drawing for circles inside nonsquare Freeform
bounds: the stage now uses the compositor's centered short-side circle geometry,
while rectangular selection and hit bounds remain intact.

The final 640x360 recording passed ffprobe/ffmpeg quality analysis. Decoded source
bounds differed by 0.6px and 0.8px, with zero foreground outside the expected
rectangles; both persisted precise transforms survived recording start/stop.
Private evidence was inspected at `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-freeform-editor-AVlOzI/`.
The report, screenshots and recording are deliberately outside the repository.


Compatibility review restored preset-mode snapping independently of the local
Freeform toggle: presets keep snapping and Alt bypass; Freeform still defaults
off. The repeated Freeform gate passed again inside the recording-studio runner.
All standard recording-studio steps passed, including real ScreenCaptureKit
recording, 100 preview lifecycle cycles, preview placement/docking, reattach,
Record/Stop latency and final-artifact analysis. The first additional real-device
stress step reported one IOSurface import failure during floating continuous
resize, so the device-inclusive command exited nonzero. This is not counted as
a device pass, and its two later device steps did not run in that invocation.

During verification main advanced to `abb37658` (#381 clean scene switches and
#382 release instructions). The branch was rebased successfully; the only conflict
was the gate test expected order, resolved by keeping scene-switch pixel artifacts
before Freeform pointer continuity. The source implementation merged cleanly.
Post-integration typecheck, lint, formatting, all 1,836 desktop tests (one skipped)
and desktop build passed. Native rerun results are recorded below.


Post-integration native validation passed: Rust fmt, 2,259 tests (nine ignored),
clippy with warnings denied, backend/helper binaries and preview addon. The new
scene-switch artifact gate passed all four CPU/Metal recording/stream checks.
Freeform acceptance passed again with 98 gestures and 20 screenshots. This final
integrated run collected 447 timing samples: aggregate p95 15.7ms, maximum 18.2ms;
landscape p95 13.0ms, portrait p95 16.2ms. Measured median rAF interval was 9.15ms.
The strict per-gesture budget remained unchanged. The final recording repeated
0.6/0.8px source-bound errors with zero foreground outside the expected regions.
Final integrated evidence is outside the repository at
`/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-freeform-editor-B32BIh/`.


Post-integration real-device preview interaction stress passed, including floating
continuous resize and a verified 59.866-second artifact. The earlier single
IOSurface import failure did not recur; its original failed result is retained.
Real ScreenCaptureKit live layout switching also passed for recording and
simultaneous recording/streaming, with finalized artifact analysis.

The source-complete native-preview recording check then failed because it
counted nine CPU fallback frames. This is a separate native recording diagnostic,
not an editor gesture failure. The exact unchanged command failed again with ten CPU fallback frames.
No threshold, importer, presenter or encoder change was made to suppress it.


Final handoff: all five implementation slices and the Scene editor acceptance
checks are complete. The PR remains draft because the broader native recording
gate is unresolved. Reproduce with:

```sh
VIDEORC_NATIVE_PREVIEW_SOURCE_COMPLETE_SCENE=1 VIDEORC_NATIVE_PREVIEW_LAYOUT_STRESS_UPDATES=4 pnpm smoke:recording-native-preview
```

The first failure recorded 564 compositor ticks, nine CPU fallback frames, zero
dropped compositor frames, zero encoder errors and zero source import failures.
The unchanged repeat counted ten fallback frames. This smoke uses synthetic
source-complete composition (not a real camera/screen capture claim), performs no
Freeform gestures or transform-update RPCs, and the compositor source is identical
to main at `abb37658`. The diagnostics did not retain the underlying fallback
reason. These facts separate the exercised path from the reported editor symptom;
they do not prove a baseline reproduction. The plan's out-of-scope native failure
stop condition applies: investigate separately before making the PR merge-ready.

All ordinary recording-studio steps passed in the earlier aggregate invocation;
that device-inclusive invocation exited nonzero at its first additional device
step. After integration, the failed device step and real ScreenCaptureKit layout
switching passed individually. The final source-complete native check failed twice.
No fully green device-inclusive aggregate is claimed. No release or merge was
performed. Shadscan baseline and enforced floor are 41; all pre-commit audits
retained 41 using `pnpm dlx @shadscan/cli@next --json` in `apps/desktop`.


After PR #384 was opened, main advanced to `3b7a3529` (#383 saved scenes and
Studio usability), creating editor/provider conflicts. Integration preserves the
new scene-edit generations and saved-scene controls alongside Freeform draft
ownership. Focused editor/provider and real-app saved-scene/Freeform gates are
complete for this integration; no native source changed in #383.

Main's Plan 044 independently records the same source-complete native gate
failing with nine and six CPU fallback frames. This corroborates that the native
acceptance gap is also present in the saved-scenes handoff; it does not replace
a controlled clean-base reproduction. The unresolved gate remains explicit.


Saved-scene integration resolves all conflicts while retaining the existing
Freeform stage implementation. A shared busy callback blocks saved-scene actions
during gestures and queued/numeric commits; stage and inspector refuse edits
during saved-scene/layout replacement. Precision commits now also compare the
monotonic layout-intent ID, with a regression covering newer saved-scene intent
that otherwise has identical source/scene identity. Incoming transform-pending
and working-scene persistence behavior is preserved.

After integration: frozen-lockfile install, typecheck, lint, formatting, production
build, 102 provider tests, 63 focused editor/control tests, and the full desktop
suite (185 files, 1,868 passed, one skipped) passed. Native files are unchanged
by this integration, so the prior Rust/native results remain applicable.


The post-saved-scene Freeform run retained three failures: two early capture
observations and a mid-resize window blur. Both early-observation gestures moved
and committed correctly; the blurred gesture correctly cancelled without an RPC.
The blur origin is undetermined. The smoke now awaits actual trusted pointerdown
delivery before querying capture and records pointer ID, delivery/query timestamps
and focus state. Analyzer coverage rejects stale or untrusted capture observations;
31 focused gate tests pass. No capture requirement, timing budget or cancellation
behavior was weakened. This failed run remains recorded rather than retried
inside the smoke. The saved-scene real-app smoke passed atomic apply, exact-source
refusal, working-state restart, live switching and encoded background pixels.


Final saved-scene-integrated Freeform acceptance passed: 98 trusted gestures,
20 screenshots and finalized recording checks; 443 timing samples, aggregate
p95 11.0ms, maximum 18.1ms, landscape p95 12.2ms, portrait p95 10.8ms. Median rAF
interval was 9.12ms. Evidence:
`/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-freeform-editor-0m1vj2/`.
The merged Freeform and saved-scene workflows are accepted together. The only
remaining scoped handoff limitation is the separately documented source-complete
native recording CPU fallback gate; PR #384 stays draft for that reason.
