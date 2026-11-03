# Plan 216: Freeform fails, the screen box is the wrong size, and the canvas won't drag

> **Executor instructions**: This plan has four workstreams (A to D). A, B
> and C are one PR each; D is an investigation that may become a small PR.
> Pick a workstream from "Order of work", follow its slices in order, and
> run every "Done when" check before moving on. If anything in "STOP
> conditions" happens, stop and report; do not improvise. A slice marked
> **red first** must be seen failing on the base before the fix starts.
> Gates run once at the end of each workstream (owner rule): write and
> commit its slices first, then run its gate. When a workstream is done,
> update this plan's row in `plans/README.md` and fill in its "As built"
> line.
>
> **Drift check (run first)**: `git diff --stat bc84c35ec..origin/main --`
> plus the paths listed under your workstream. If an anchor quoted below has
> moved, find it again by its symbol name. If a _behaviour_ changed (not
> just a line number), that is a STOP condition.

## Status

- **Status:** EXECUTING since 2026-11-03. Owner, 2026-11-03: "Yes I pick
  all recommended decisions execute the entire plan and create PRs for
  each of these things". So D1 to D5 are all taken as recommended, and
  every workstream below is written to them.
- **Source:** a streamer's report, relayed by the owner on 2026-11-03,
  with a 105 s screen video (`~/Downloads/bug_video_orc.mp4`, edited, music
  only, no narration) and a support bundle
  (`videorc-support-bundle-20261103-145146Z.json`). The bundle shows the
  same iPhone camera and LG ultrawide as plan 215's streamer, so it is very
  likely the same person (**guess**).
- **Their build:** Videorc 0.18.0, packaged, macOS arm64, kernel
  `27.0.0`. That is a newer macOS than our test Macs (25.5).
- **Planned against:** `origin/main` `bc84c35ec`, in
  `~/projects/videorc-wt-216` (branch `plan-216-freeform-canvas-fixes`).
  0.18.0 is `471dcf34f`. Every path in this plan is the same in 0.18.0 and
  on main, so **all three bugs are still on main** (verified by diff).
- **Owner route:** Orchestrator, fit 10, for the plan. Each workstream
  names its own route and model lane from `CLAUDE.md`.
- **How the facts were found:** the video read frame by frame and the
  bundle parsed. Then three read-only investigations of `bc84c35ec`. The
  load-bearing claims were then re-read by hand. Each fact is marked
  **verified** (read in the code or the bundle), **reported** (found by an
  investigation, not re-read) or **guess**. Nothing was reproduced on a
  Mac yet.
- **In flight elsewhere:** plan 215 E (`plan-215-e-bigger-than-canvas`:
  sources up to 400%, cut at the canvas edge, Zoom slider) changes
  `scene_geometry.rs`, `compositor.rs`, `scene-stage.tsx`,
  `stage-transform.ts`, `transform-fields-math.ts` and `layout-tab.tsx`.
  Workstream B here edits the same files, so it goes on top of E. Plan 215
  F (rounded screen) must come after B, because its mask belongs on the
  picture rect that B introduces.

## The report (verbatim)

- "freeform switch error"
- "the selector / box around screen is not following the screen's actual
  size"
- "arrow keys allow to move screen around but with cursor it cannot"

## What the video and bundle show

- **At launch:**
  - Their LG ULTRAWIDE (3440×1440) was missing, so capture fell back to
    the MacBook's own display, 3456×2234. That display is captured at
    2228×1440, aspect 1.547.
  - Their iPhone camera was missing too, so the camera fell back to the
    MacBook Pro Camera. Both fallbacks show in `automaticSourceFallbacks`,
    reason `unavailable-selected`.
  - The scene list says "Unsaved scene · LG ULTRAWIDE · 3440 × 1440".
  - The output is 2560×1440.
- **The camera never sent a frame** (verified, bundle):
  - `previewCameraState` is `live`.
  - `previewCameraCaptureCallbackCount`, `previewCameraFrameStorePublications`
    and `compositorCameraSourceFreshServes` are all 0.
  - The capture log shows two `force-recovery` restarts of the camera at
    14:51:44 and 14:51:46.
- **The preview ran on the fallback path** (verified, bundle):
  - transport `electron-proof-surface`, host kind `proof-surface`.
  - `firstFrameReason`: "Native preview presenting watchdog requested a
    clean presenter."
  - Health says "Preview path: Fallback window".
- **Freeform** (video at about 0:08 to 0:28, and again after a relaunch at
  about 0:52 to 1:08):
  - The Layout row's "Screen + camera" button and the Freeform toggle both
    read "Switching…" for about 15 to 20 s.
  - Then the toast "Couldn't switch the scene" appears, with the generic
    next step.
- **The box:**
  - The inspector reads X 9.3% Y 9.3% W 90.7% H 90.7% (2321×1306 px,
    16:9).
  - On the canvas, the handles sit on that 16:9 frame. The screen picture
    is drawn Fit inside it at about 1.55:1, so there is empty space at the
    left and right inside the handles.
- **The drag** (video at about 1:26 to 1:38):
  - The cursor presses on the screen picture and X stays at 16.6%.
  - The inspector's arrow pad then moves it: X goes 16.6 → 17.1 → 20.1 →
    21.1% and Y goes 0 → 1 → 4 → 4.5 → 6%.
- **The support bundle doesn't explain the toast** (verified):
  - Its backend `logs` holds only 7 startup lines.
  - There is no renderer error section.
- **Also in the bundle, not in this plan:**
  - Both recent streams (11-01 and 11-02) were 60 fps with capture at
    about 40 fps and 63k to 98k output-queue drops.
  - The 11-02 stream ended `failed` after 67 minutes.
  - These are worth their own look.

## What we found, in one table

| #   | What they hit                                 | Cause (short)                                                                                                                                                                                                                                                                                                                                             | Workstream | Size |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---- |
| 1   | Freeform hangs on "Switching…", then fails    | Every layout change, even one that only rearranges, waits for **every** source in the scene to show a fresh frame. Their camera reported "live" but never sent one. After 15 s the backend gives up. The error code is unknown to the renderer, so the toast is generic.                                                                                  | A          | M    |
| 1b  | Two buttons say "Switching…"                  | The pending label is keyed by the layout preset, so entering Freeform lights the current preset's button too.                                                                                                                                                                                                                                             | A          | S    |
| 1c  | The bundle can't explain the toast            | Raw errors only go to `console.warn`. The bundle has no renderer errors, and the export clears `lastError` first.                                                                                                                                                                                                                                         | A          | S    |
| 2   | Box around the screen is not the picture      | The stage and the compositor's selection chrome draw the source's **frame**. The picture is fitted inside it. No scene or stage code knows the source's size, and Freeform copies the preset's canvas-shaped frame.                                                                                                                                       | B          | L    |
| 3   | Mouse drag does nothing; the arrows work      | On macOS the fallback preview is two separate borderless windows over the canvas. Linux hosts it inside the main window. Pass-through is asked for (`setIgnoreMouseEvents`), but no gate checks it with a real OS mouse. On their macOS the mouse never reaches the canvas (**guess**, about 60%). Keys and the arrow pad never cross AppKit hit-testing. | C          | M    |
| 4   | Why this Mac had a dead camera and a fallback | Unknown. It needs the streamer's macOS version and a fresh bundle.                                                                                                                                                                                                                                                                                        | D          | S    |

## Evidence by workstream

### A: the Freeform failure

- **The call chain** (verified):
  - `layout-tab.tsx:541` `enterFreeform` →
    `applyCameraPreset(freeformEntryPatch(...))`.
  - That reaches `use-studio.tsx:10024` `requestLayoutTransaction`, which
    sends `scene.layout.apply_preview` while idle.
  - The Toggle's `onPressedChange={enterFreeform}` (`layout-tab.tsx:744`)
    fires on every click, pressed or not.
- **The wait:**
  - `live_layout.rs` gates the commit on source liveness. A source counts
    as live only with a frame at most 1.5 s old
    (`SOURCE_FRESH_FRAME_MAX_AGE_MS`, `:83`, verified).
  - A source that isn't live goes to a warm start (`live_scene.rs:71-86`
    `plan_live_swap` → `ApplyMode::Warm`, reported).
  - That polls for up to `WARM_CAMERA_START_TIMEOUT` = 15 s (`:71`,
    verified), then `bail!`s at `:1911` (verified) with: "Live preview
    layout switch blocked after camera (15s) exceeded its
    source-start/readiness budget: camera session never delivered a
    frame …".
- **Why the camera counted as "live":** macOS acks Live as soon as
  `startRunning()` returns, before any frame (`preview_camera.rs:211-216`,
  reported). The `reuse` at 14:51:22 then joined that frameless session
  (`preview_camera.rs:3420-3429`, reported).
- **The toast:**
  - `main.rs:11188-11196` wraps the error as `layout-preview-failed`
    (verified). `user-error.ts` `KNOWN_CODES` doesn't have that code
    (verified), so the toast gets `UNKNOWN_REASON`.
  - `layoutTransactionFailureDisposition` returns `definitely-not-applied`,
    so the renderer reports "Couldn't switch the scene".
- **The asymmetry that makes it a bug:** a move or nudge
  (`scene.source.transform.update`, `scene.source.nudge`) commits with no
  readiness wait (`main.rs:11266`, `live_layout.rs:2317`, reported). That
  is why the arrows worked while Freeform failed.
- **The double label** (verified):
  - `use-studio.tsx:10088` sets `layoutSwitchPending = layout.layoutPreset`.
  - `layout-tab.tsx:713` lights the preset with that id.
  - `layout-tab.tsx:746` lights Freeform with `layoutSwitchPending && isFreeform`.
- **The bundle gap** (verified):
  - `exportSupportBundle` (`use-studio.tsx:12436-12460`) sends only
    `cameraSelection`, `automaticSourceFallbacks`,
    `nativePreviewSurfaceStatus`, `runtimeInfo` and `virtualCamera`.
  - It calls `setLastError(null)` first.
  - `user-error.ts:8-9` claims the console is collected. It isn't.

### B: the box is the frame, not the picture

- **What the stage draws:** the frame. `displayed(source)`, the hit
  target, the held selection and the drag draft all use `source.transform`
  (`scene-stage.tsx:489-496`, `:1067-1074`, `:561-589`, `:513-516`,
  reported).
- **The compositor's selection chrome** turns that same frame into pixels
  (`editor_chrome.rs:222-231`, reported).
- **What the picture is:** a Freeform screen is Contain unless Fill is
  chosen (`scene_geometry.rs:233-246`, reported). Metal, the CPU path and
  the fallback window (CSS `object-fit: contain`,
  `native-preview-proof-geometry.ts:44-63`) all fit the picture inside the
  frame (reported).
- **Why the frame is 16:9:**
  - Every preset places the screen as a full-canvas frame
    (`scene.rs:505`, reported).
  - Freeform copies it (`freeform-memory.ts` `freeformEntryOverrides`,
    verified).
  - The aspect lock keeps the frame's own 16:9 (`stage-transform.ts:150-205`,
    reported).
  - `SceneConfigParams` has no source size field (`protocol.rs:1041-1054`,
    reported).
- **Where the size could come from:**
  - The renderer already has `previewScreenStatus` width/height and
    native size (`use-studio.tsx:4007`, reported).
  - The compositor's per-source `width`/`height` exists in the contract
    but is left empty (`compositor.rs:13370-13371`, reported).
- **The same bug elsewhere:**
  - A camera with lens Fit, the vertical orientation's Fit, and the
    schematic stage all show it.
  - With a scene background on, the compositor shrinks the screen onto a
    stage margin (`scene_geometry.rs:107-126`, reported) that the stage
    ignores.

### C: the drag on the fallback preview

- **How the fallback takes over** (verified):
  - The first-frame watchdog's `reset-native-path` (`index.ts:2183-2190`)
    → `resetNativePreviewRealSurfaceDriver`. That clears the in-process
    driver.
  - So `previewDockedInWindow()` (`index.ts:4743-4752`) turns false on
    macOS, because `proofSurfaceHostedInWindow` is Linux-only
    (`index.ts:7099`).
  - The docked placement then shows the lifecycle preview BrowserWindow
    at the canvas rect (`index.ts:4855-4867`, `showInactive`).
  - The transparent proof-surface BrowserWindow is parented above it
    (`createProofSurfaceBrowserWindow`, `index.ts:7110-7141`, reported).
- **Pass-through is asked for but not checked:**
  - Both windows call `setIgnoreMouseEvents(true)`: the docked chrome at
    `index.ts:5289` (verified) and the surface at `:7175` (verified).
  - No gate checks it with a real OS mouse. `preview-window-probe.mjs`
    scene-hit-only and pass-through(cdp) use CDP `Input.dispatchMouseEvent`,
    which never crosses window hit-testing (reported).
  - The real-CGEvent `pass-through(os)` case runs only on the in-process
    path, where no window sits above main (reported).
  - `smoke-freeform-editor-app.mjs` and `smoke-scene-item-drag-app.mjs`
    are CDP-only (reported).
- **The ready-made fix** (verified): Linux's `InWindowProofSurface`
  forwards mouse events from the view to the host window
  (`in-window-proof-surface.ts:90-100`, `:331-345`: `before-mouse-event` →
  `preventDefault` → `sendInputEvent`). It also keeps the lifecycle window
  hidden while docked.
- **Ruled out:**
  - Stage gating: the arrow pad runs through the same `runPreciseEdit`
    guards, so no switch or edit was pending (`layout-tab.tsx:423-432`,
    verified).
  - The backend: transform update and nudge run the same code
    (`scene.rs:283-294`, `:334-352`, reported).
  - The video shows "Freeform", not "Switching…", during the drag, so no
    scene switch was stuck.

## Decisions for the owner

All five were taken as recommended on 2026-11-03.

- **D1. A change that adds no source never waits for a source.**
  - Freeform, moving and resizing, Fill/Fit, and a preset switch that
    keeps the same sources all apply at once, even when a source in the
    scene isn't sending video.
  - Only a source the switch **adds** waits for its first frame, as today.
  - **Recommended: yes.** The other choice keeps "every source fresh" for
    preset switches and exempts only Freeform. That still fails the same
    way on Screen only ↔ Screen + camera with a dead camera.
- **D2. In Freeform, a screen's box is always the shape of its picture.**
  - Crop is how you change its shape. The aspect key never stretches a
    screen.
  - **Recommended: yes.**
- **D3. A saved scene opened on a screen of a different shape** (their LG
  ultrawide vs the MacBook display).
  - **Recommended:** the whole screen sits centred inside the old box
    (Fit), the stage shows the picture's real edges, and nothing is
    written to the scene until the streamer edits it. Swapping back to the
    ultrawide is then exact.
  - The other choice is to keep the height and centre, which pushes an
    ultrawide past the canvas.
- **D4. On macOS, host the fallback preview inside the main window, as
  Linux does.**
  - This takes AppKit window hit-testing out of the path entirely.
  - **Recommended: yes, even if C1 can't reproduce the drag bug on our
    macOS 26.** The other choice keeps the separate windows and re-asserts
    pass-through after every show and re-parent (belt and braces, but
    still untestable on their OS).
- **D5. The copy when a switch that adds a source gives up.**
  - **Recommended:** title "Couldn't switch the scene", description
    "Your camera isn't sending video. Check it in Sources, then try
    again." (or "Your screen…"). That replaces the generic "export a
    support bundle".
  - It needs a distinct backend error code; see A3.

## Order of work

1. **A and C in parallel.**
   - A is Rust plus a little TypeScript. C is the main process plus a
     probe, with no Rust.
   - They share no files except `layout-tab.tsx` (A4 labels only), so the
     second to land rebases.
2. **D starts now and needs no code.** The owner asks the streamer the D1
   questions below. Its code slices wait for answers.
3. **B goes on top of plan 215 E.**
   - If E has merged, start from main. If not, start from E's branch and
     rebase when it lands.
   - Plan 215 F (rounded screen) waits for B.
4. **Host rules** (memory: compile thrash and the 11-02 kernel panic):
   - At most three Rust delegates machine-wide.
   - Run `df -h /System/Volumes/Data` and check swap before any Rust
     build. Disk was **735 MB free** at 15:20 on 2026-11-03, then 138 GB
     after another session's cleanup.
   - Run every cargo command through `pnpm cargo:slot`.

## Workstream A: a rearrangement never waits for a source that's already on

**Route:** Diagnose → Implementation, fit 9. **Model:** `fable-5.1`.
**Branch:** `plan-216-a-freeform-never-waits`. **Paths:**
`crates/videorc-backend/src/live_layout.rs`, `live_scene.rs`, `main.rs`
(the error code only), `apps/desktop/src/renderer/src/lib/user-error.ts`,
`.../hooks/use-studio.tsx`, `.../components/tabs/layout-tab.tsx`,
`crates/videorc-backend/src/support_bundle.rs`.

- **A1 (red first).** In `live_layout.rs` tests:
  - Install a live camera for the layout (`test_install_live_camera_for_layout`).
  - Make it frameless: zero `frames_captured`/`sequence`, an empty frame
    store, and `live_acked_at` past the reuse grace. The fixture shape is
    near `preview_camera.rs:10379-10392`.
  - Then call `apply_layout_preview` with the same sources and only
    `arrangementMode: freeform` plus overrides.
  - Assert that it commits without a warm start. Use the test clock or a
    short test timeout if one exists; otherwise assert the plan's mode is
    not `Warm`.
  - Add a second test: a preset that **adds** a camera to a screen-only
    scene still waits.
  - **Done when:** the first test fails on the base (times out or fails
    after the budget) and the second passes.
- **A2. Readiness only for added sources.**
  - In `apply_scene_transaction`, compute the readiness `needs` minus the
    sources the installed compositor scene already composes with the same
    device id and visible.
  - Keep the full `needs` for `begin_layout_intent_owned` and source
    retirement.
  - The camera recovery driver keeps restarting a frameless camera on its
    own; the scene change doesn't wait for it.
  - **Done when:** A1's tests pass, and the existing `live_layout` and
    `live_scene` tests still pass.
- **A3. Name the source that didn't arrive (D5).**
  - At the readiness `bail!`, return a distinct code (suggested:
    `layout-source-not-ready`) with the kind (`camera`/`screen`) in the
    error details, for both `apply_preview` and `apply_live`.
  - Map it in `user-error.ts` `KNOWN_CODES` to D5's copy.
  - Check `backend-rpc-contract.ts` for error-detail typing (memory:
    strict-contract trap).
  - **Done when:** a `user-error.test.ts` case maps the code to the copy,
    and a Rust test asserts the code.
- **A4. One "Switching…" label.**
  - Track the pending target as `{ layoutPreset, arrangementMode }`
    instead of a bare preset.
  - Freeform reads "Switching…" only when the target is Freeform. A preset
    reads it only when the target is that preset in preset mode.
  - **Done when:** a `layout-tab` test covers the three cases: enter
    Freeform, a preset from Freeform, and a preset from a preset.
- **A5. The bundle explains the next toast.**
  - Keep a bounded ring of the last 50 user-facing errors in the renderer:
    time, action, object, code and raw message. Add it to
    `rendererDiagnostics.recentUserErrors`.
  - Stop clearing `lastError` before the export.
  - Confirm `support_bundle.rs` runs its redaction over the new field
    (paths, URLs, secrets).
  - Fix the comment at `user-error.ts:8-9`.
  - **Done when:** a test exports a bundle after a failed switch and finds
    the raw text redacted, inside the ring.
- **Gate:**
  - `pnpm typecheck`, `pnpm lint`, `pnpm format:check`.
  - Targeted vitest (`user-error`, `layout-tab`, the bundle test).
  - `pnpm cargo:slot test -p videorc-backend live_layout`.
  - `pnpm cargo:slot clippy -p videorc-backend -- -D warnings`.
  - `cargo fmt --check --all`.
  - Recording-studio gate (layout switching feeds recordings):
    `pnpm smoke:live-layout-switch-recording` and
    `pnpm smoke:freeform-editor`.

## Workstream B: in Freeform, the box is the picture

**Route:** UI/Product Design + Implementation, fit 9. **Model:**
`fable-5.1`, because one geometry rule spans Rust and TypeScript. Read
`.claude/skills/videorc-design/SKILL.md` first. **Branch:**
`plan-216-b-box-is-the-picture`, on top of plan 215 E. **Paths:**
`apps/desktop/src/shared/` (a new geometry file),
`crates/videorc-backend/src/scene_geometry.rs`, `compositor.rs`,
`editor_chrome.rs`, `.../components/scene/scene-stage.tsx`,
`stage-transform.ts`, `stage-gesture.ts`, `transform-fields-math.ts`,
`.../lib/freeform-memory.ts`, `.../components/tabs/layout-tab.tsx`.

- **B1 (red first). One picture-rect rule.**
  - Add `scenePictureRect` in
    `apps/desktop/src/shared/scene-picture-geometry.ts`. It takes the
    frame, kind, framing, source size, crop and stage margin.
  - Add its Rust twin in `scene_geometry.rs`, and make the compositor's
    fit a pixel wrapper around it.
  - One shared JSON fixture keeps the two equal. Put it in the repo's
    existing protocol-fixture location; find it with
    `rg -l protocol-fixtures`.
  - Fixture cases:
    - The streamer's numbers: frame 2321×1306 at 9.3%/9.3% on
      2560×1440, source 2228×1440, Fit. The picture is about 2021 px wide
      (x ≈ 0.152, w ≈ 0.789).
    - Fill, crop, margin 0.1, vertical Fit, and a 4:3 camera on Fit.
    - An unknown size, which returns the frame.
  - **Done when:** the TS and Rust tests read the same fixture and agree
    within 1 px.
- **B2. The stage knows the source's size.**
  - Fill in the compositor's per-source `width`/`height`
    (`compositor.rs:13370`).
  - Fall back to `previewScreenStatus` in the renderer.
  - If the status gains fields, add them to `backend-rpc-contract.ts`
    (memory: strict-contract trap).
  - **Done when:** a status test shows the screen's 2228×1440 reaching
    the stage.
- **B3. The stage draws, hits and snaps the picture.**
  - In `scene-stage.tsx`, the box, the handles, the hit target, the snap
    targets and the chrome `selected` rect all use the picture rect.
  - `editor_chrome.rs` draws it.
  - Plan 215 D's live outline uses it too.
  - **Done when:** `scene-stage.test.ts` asserts bounds, handles and the
    held selection on the picture for the streamer's case.
- **B4. Gestures keep box = picture (D2).**
  - A Freeform screen is aspect-forced to its picture, the way shaped
    cameras are (`StageGesture` `forced`).
  - A commit writes the picture as the new frame, mapped back through the
    margin.
  - ⌥-crop becomes exact.
  - **Done when:** `stage-gesture.test.ts` and `stage-transform.test.ts`
    pass with the forced aspect and with crop.
- **B5. The inspector shows the picture.**
  - X, Y, W and H and the px line describe the picture, and W drives H for
    a screen.
  - **Done when:** `transform-fields-math.test.ts` passes.
- **B6. Freeform starts at the picture.**
  - `freeformEntryOverrides` seeds a screen at its picture rect when the
    size is known, so nothing moves on entry.
  - **Done when:** `freeform-memory.test.ts` passes.
- **B7. A display swap writes nothing (D3).**
  - The stored frame stays and the picture fits inside it.
  - The first edit makes the frame equal the picture.
  - **Done when:** a test swaps 2.39 → 1.547 → 2.39 and gets the original
    frame back.
- **Gate:**
  - TS: typecheck, lint, format and the vitest files above.
  - `pnpm cargo:slot test -p videorc-backend scene_geometry` plus the
    compositor fit tests, and clippy.
  - `pnpm smoke:freeform-editor` and `pnpm smoke:scene-item-drag`. If the
    smokes can't fake a non-16:9 screen, add that knob or say so.
  - `pnpm check:renderer-assets`: the eager gzip budget is tight, so keep
    new UI lazy.
  - A by-eye check in **light and dark** (owner rule) with a non-16:9
    screen, Fit and Fill, docked and floating preview.

## Workstream C: the canvas drags on the fallback preview

**Route:** Diagnose → Implementation, fit 9. **Model:** `fable-5.1`.
Native-preview rules in `AGENTS.md` apply. **Branch:**
`plan-216-c-fallback-preview-in-window`. **Paths:**
`apps/desktop/src/main/index.ts`, `in-window-proof-surface.ts`,
`native-preview-window-stacking.ts`, `scripts/preview-window-probe.mjs`.

- **C1 (repro first).**
  - Force the fallback the way the watchdog does: run the smoke command
    `exercise-native-preview-proof-fallback` (`index.ts:12201-12215`,
    needs `VIDEORC_SMOKE_COMMAND_SERVER=1`; `scripts/perf-idle-probe.mjs:389`
    shows the call).
  - Open Scene, docked.
  - Post a **real** CGEvent press, drag and release on the screen source.
    Extend the probe's `osClick` Swift helper with `leftMouseDragged`.
  - Record whether a trusted `pointerdown` reaches the stage and whether
    `scene.source.transform.update` is sent.
  - **Done when:** the result is written in this plan's As built line.
    If it fails here, that is the red. If it passes here, the bug is
    specific to their macOS, so carry on under D4 and note it.
- **C2. Host the macOS fallback in the main window (D4).**
  - Set `proofSurfaceHostedInWindow = process.platform !== 'win32'`
    (`index.ts:7099`). The lifecycle window then stays hidden while
    docked, and `InWindowProofSurface` forwards the mouse.
  - Check transparency, the corner radius (`setBorderRadius`), and what
    the separate surface window's capture or content-protection setting
    was for (`index.ts` ~7135). Also check the floating mode, which keeps
    its own window.
  - **Done when:** C1's drag moves the source, both docked and after a
    driver reset.
- **C3. Gates that use a real mouse.**
  - Add a `pass-through(os, proof-fallback)` scenario to
    `preview-window-probe.mjs` (`runPassThroughScenario`) with a click
    **and** a drag.
  - Add a macOS-host case to `in-window-proof-surface.test.ts`.
  - In `native-preview-window-stacking.test.ts`, assert that after a
    driver reset the surface's host is the main window.
  - **Done when:** all three pass on main with C2, and the probe scenario
    fails without it (if C1 reproduced).
- **Gate:**
  - TS: typecheck, lint, format and the vitest files above.
  - `pnpm probe:preview-lifecycle` and `pnpm probe:preview-window` (with
    the new scenario).
  - `pnpm smoke:freeform-editor`, `pnpm smoke:scene-item-drag` and
    `pnpm smoke:portal-preview-proof`.
  - Linux is unchanged. Say so if a Linux probe can't run here.

## Workstream D: why this Mac had a dead camera and a fallback preview

**Route:** Diagnose / Research, fit 7. **Model:** `opus-5.5` for the
investigation; escalate to `fable-5.1` if a native fix appears.

- **D1. Ask the streamer** (through the owner):
  - Their exact macOS version.
  - Whether the MacBook camera works in Photo Booth or FaceTime with
    Videorc closed.
  - Whether another app, or the iPhone's Continuity Camera, was using a
    camera.
  - A fresh support bundle right after launch, with the Scene page open
    and the iPhone connected.
- **D2. Make a silent camera visible.**
  - A camera that acks Live but sends no frame past the reuse grace should
    say so where the streamer looks: Sources row and Health, by name
    ("MacBook Pro Camera isn't sending video").
  - First check what Health's "Camera slow" chip already says, and don't
    duplicate it.
- **D3. The bundle says why the native preview fell back.**
  - Add the first-frame watchdog's last decisions (reason, the evidence it
    saw, time) to the bundle. Its `logBackend` lines didn't reach the
    bundle's `logs`.
- **D4. Only with D1's answers:**
  - Check the 1552×1552 square-format pick for a 2560×1440 request on
    their camera.
  - Check the CAMetalLayer presenter on their macOS.
  - These are **guesses** until the answers come.

## STOP conditions

- A1 or C1 behaves differently from the evidence above (for example,
  Freeform commits on the base with a frameless camera). Stop and report;
  the diagnosis is wrong.
- A2 would let a switch that **adds** a source commit without its first
  frame.
- C2 needs the separate surface window for capture protection or stacking
  that the in-window view can't provide.
- B would rewrite a saved scene without an edit from the streamer.
- Plan 215 E changes the geometry contract in a way B1's rule can't sit
  on.
- Free disk under 12 GB, or swap near full, before a Rust build.

## What to tell the streamer now (0.18.0, all untested guesses)

- **Freeform error:** your MacBook camera was on but never sent a picture,
  and Videorc waits for it. Make the camera work (close other apps using
  it, or connect the iPhone and pick it in Sources). Or turn the camera's
  "Visible in scene" off, then choose Freeform.
- **Box size:** choose **Fill** instead of Fit while the MacBook display
  is the screen. The picture then fills the box (its edges are cropped).
- **Drag:** press **Pop out** under the canvas while arranging. The canvas
  then draws its own boxes, which drag. Relaunching may also bring back
  the normal preview.

## Out of scope

- The "Unsaved scene · LG ULTRAWIDE" name while the MacBook display stands
  in. This is plan 213 D6's stand-in rule; ask the owner if it reads
  wrong.
- The 40 fps capture at a 60 fps target, the output-queue drops, and the
  11-02 stream that ended `failed`.

## As built

- A: _not started_
- B: _not started_
- C: _not started_
- D: _not started_
