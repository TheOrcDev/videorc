# Plan 058: The Scene canvas shows the real picture (live Freeform editing, and Circle works in Freeform)

> Executor: implement the ordered slices below in an isolated worktree of current
> main (`git worktree add ../videorc-wt-<topic> -b <branch> origin/main`). Read
> `AGENTS.md` and `.claude/skills/videorc-design/SKILL.md` first. Keep each slice
> independently testable and leave the tree green between slices. Planning
> authorizes no merge and no release.

## Status and decisions

- Status: **EXECUTED 2026-09-25** on `feat/scene-live-editor` (PR pending
  review; owner by-eye pending, see
  `docs/acceptance/2026-09-25-live-scene-canvas.md`). S0 was folded into S2/S3
  and its result is recorded under S0 below; S1–S5 are done and every local
  gate listed in S6 passes except the fixed renderer gzip ceiling, which clean
  `origin/main` already exceeds on this Mac (386 098 vs 385 000; CI's Linux gzip
  reads ~1.6 KB lower) — the branch adds +101 B gzip (386 199) and no eager code
  beyond two context callbacks in `use-studio.tsx`.
- Priority P1. Effort L: about 6 agent-days over 7 slices. Risk MED–HIGH: the
  work touches the native CAMetalLayer preview placement and the compositor's
  per-tick scene snapshot. Every slice keeps `probe:preview-lifecycle`,
  `probe:preview-window` and `smoke:freeform-editor` green.
- Planned against `origin/main` `f4044b71` (0.9.108), which contains the
  Freeform editor (#378), the continuity fix (#384, plan 043) and saved scenes
  (#383, plan 044). The shared checkout `~/projects/videorc` is on an older
  branch without any of that; do not plan or execute from it. A worktree on
  main already exists at `~/projects/videorc-wt-scene-live`
  (`feat/scene-live-editor`); reuse it or make your own.
- Paths are relative to `apps/desktop/src/` unless they start with `crates/`,
  `scripts/`, `docs/` or `plans/`.
- Owner route: Orchestrator (fit 10) for the design; per slice: S0 Diagnose
  `fable-5`, S1 Implementation `gpt-5.5`, S2–S4 Implementation `fable-5`
  (native preview + compositor + commit ordering), S5 UI/Product Design
  `opus-4.8`, S6 Review `fable-5`.
- Branch: `feat/scene-live-editor`. Commits `feat(scene):` / `fix(scene):`;
  S1 may ship alone as `fix(scene): Circle and Rounded apply in Freeform`.
- Owner request, 2026-09-24: "We want to see the actual camera and screen
  recording while we are creating that scene. We should control, in free form,
  my camera source and my screen recording source in order to create our
  perfect scene. Also I had a bug in free form where I changed to round circle
  and it was not changing from square. We need to make this one work well and
  in a good performance way as well."

### What the Scene tab does today (verified on `f4044b71`)

- The Scene tab (`renderer/src/components/tabs/layout-tab.tsx`, nav id
  `layouts`) hosts `SceneStage` (`renderer/src/components/scene/scene-stage.tsx`),
  a **pure SVG schematic**: flat grey boxes for camera and screen, the scene
  background image, snap guides and an 8-handle selection. Its header comment
  (`scene-stage.tsx:52`): "A schematic editor only: pointer samples never start
  capture or cross IPC." Live pixels exist only in the detached preview window
  (`layout-tab.tsx:236-238`).
- The renderer never receives camera or screen pixels. The production preview
  is the composed program frame rendered by the Metal compositor into an
  IOSurface and presented by a CAMetalLayer that the in-process addon
  (`crates/videorc-native-preview-addon/src/lib.rs:145-192`, z-position
  10 000) inserts into the **preview `BrowserWindow`'s** NSView. "Stick" mode
  (`main/preview-dock.ts`, `renderer/src/hooks/use-dock-slot.tsx`,
  `main/index.ts:3754-3384`) parents that window to the main window and places
  it over a DOM slot in the Studio tab; the renderer reports only
  window-relative slot rects, main owns placement. Nothing in Electron draws
  above the surface: dialogs, popovers, menus and selects over the slot make it
  hide (`dockHiddenReason: 'overlay-open'`, `lib/dock-slot.ts:74-88`).
- Gestures: `moveGesture` (`scene-stage.tsx:297`) is rAF-throttled and updates
  local ghost state only; `endGesture` (:311) sends **one**
  `scene.source.transform.update {snap:'none'}` per gesture through
  `StageEdits.submit` → `setSceneSourceTransform` (`hooks/use-studio.tsx:7206`)
  → `lib/scene-transform-commit.ts`. The backend (`crates/videorc-backend/src/main.rs:9203`)
  sanitizes (`scene.rs:251`), commits with the current layout
  (`live_layout.rs:2227`), bumps the revision, updates the compositor and emits
  `scene.changed`. The draft stays displayed until the matching scene echoes
  back (plan 043 S3).
- Layout-level edits (shape, radius, aspect, fit, mirror, zoom, pan, chroma)
  go through `applyLayoutPatch` → `requestLayoutTransaction` →
  `scene.layout.apply_preview` (idle) or `apply_live` (session), so the
  floating preview already follows them live.

### The Circle bug, diagnosed

`camera_mask(layout)` (`crates/videorc-backend/src/scene_geometry.rs:245`)
returns `SceneMask::None` unless `layout_preset` is `ScreenCamera` or
`VerticalScreenCamera`; it never looks at `arrangement_mode`. Its TypeScript
twin `effectiveCameraMaskShape` (`shared/native-preview-proof-geometry.ts:67`)
has the same rule and feeds the stage (`layout-tab.tsx:255`) and the proof
surface. Freeform keeps whatever preset it was entered from (`enterFreeform`,
`layout-tab.tsx:151-167`, patches only `arrangementMode` and the overrides), and
the Shape control is shown in Freeform (`showCameraBubbleControls`, :147). So
entering Freeform from Screen only, Camera only, Side-by-side or any vertical
band preset, then picking Circle (or Rounded):

- stores `cameraShape: 'circle'` and shows Circle pressed in the inspector,
- but the stage, the Metal compositor (`compositor.rs:5464,5500,6900,6913`),
  the FFmpeg path (`recording.rs:16836,17018,17310`), the Windows D3D11 path
  (`windows_d3d11_session.rs:2428,2563`) and the proof surface all draw a
  rectangle. "It was not changing from square" is exactly this.

The existing tests pin the preset-only rule and never cover Freeform
(`scene_geometry.rs:865,1084`; `compositor.rs:14154-14174`;
`recording.rs:27171`). The Freeform smoke's shape matrix only ever enters
Freeform from the two inset presets (`scripts/smoke-freeform-editor-app.mjs:504-533`).

A second, smaller defect rides with it: `push_freeform_sources` /
`apply_transform_override` (`scene.rs:335-368`) take the override box as given,
so a circle in Freeform may sit in a non-square box (the circle is still round,
inscribed by `min(w,h)`, but the selection frame is wider than the bubble and a
later Rect switch reveals a stretched box). Preset/custom mode enforces the
square box through `custom_camera_box_fractions` (`scene_geometry.rs:622`).

### Decisions (the recommendation is taken)

1. **The Scene canvas becomes the docked native preview.** While the Scene tab
   is open, the real composed program frame (same CAMetalLayer path, same
   pixels as recording) docks into the canvas rect and the SVG stage under it
   keeps owning pointer input. No new pixel transport: no JPEG/MJPEG/BMP stream
   into the renderer (those are fallback/debug routes per AGENTS.md and cost a
   second FFmpeg capture or 2–8 MB uncompressed frames), no readback, no second
   compositor. Cost of the live canvas at idle: zero extra copies; the preview
   already renders at `min(fps, 30)` (`scene.rs:79`).
2. **Editor chrome is drawn by the compositor, not the DOM.** Selection frame,
   eight handles and snap guides are a few alpha-blended solid quads appended to
   the preview frame from a pure geometry function. The chrome and the dragged
   source then move in the same compositor tick: no handle lagging the video
   edge, and nothing needs to paint above the native surface. Rejected:
   a transparent click-through overlay `BrowserWindow` above the preview (a
   third window tracking one slot, chrome on a different clock than the video,
   the "preview-over-everything" family of bugs); punching a transparent hole
   through the main window's vibrancy view with the preview ordered below it
   (needs an `NSVisualEffectView.maskImage` on Electron's private effect view
   and per-resize mask regeneration; the macOS-only trick that would be hardest
   to keep alive across Electron upgrades).
3. **Drags are live.** During a move/resize the stage sends an *editor draft*
   (the ghost rect plus chrome) to the backend at most once per animation
   frame, latest-wins with one request in flight. The compositor applies the
   draft at its snapshot choke point (next to `snapshot_with_transition`,
   `compositor.rs:1347,6285`) so every render path sees the same geometry by
   construction. Release still makes **exactly one** authoritative
   `scene.source.transform.update` (plan 043's contract stays). The draft is
   dropped by the compositor the moment it installs a scene whose revision is
   at or past the commit's revision, so the picture never flashes back to the
   old rect. This supersedes plan 043 decision 4 ("the detached preview
   continues to update at commit, not on every pointer sample"): the owner now
   wants a WYSIWYG canvas, and the per-frame message is a ~250-byte JSON RPC.
4. **Drafts never reach a recording or a stream.** Editing is already disabled
   while a session is active; the backend additionally refuses
   `scene.editor.draft.set` unless the session is idle, and every draft expires
   2 s after its last refresh (the stage heartbeats it every 500 ms during a
   gesture) so a dead renderer cannot leave a phantom rect on screen.
5. **Circle and Rounded apply in Freeform.** The mask law becomes "inset
   presets OR Freeform": Freeform is the user-owned bubble everywhere. The box
   follows the mask aspect law in Freeform too (circle → square box centred on
   the old box; square/portrait aspects likewise), sanitised in the backend so
   the stage, all three render paths and the committed scene agree.
6. **Entering the Scene tab opens the preview docked into the canvas** when the
   preview is closed; it keeps floating if the user had it floating (the canvas
   then shows the schematic and offers "Show live here"); leaving the tab
   leaves the preview open and docked (it lands in the Studio slot). "Pop out"
   in the canvas footer floats it. No new persisted setting.
7. **macOS only in this plan.** Windows keeps the schematic canvas plus the
   floating proof surface; the proof surface (`main/index.ts:4348`) rebuilds
   the scene from per-source BMP layers and would need its own chrome/draft
   drawing on a Windows box. Recorded as a follow-up, not silently shipped.
8. **Occlusion keeps the existing rule.** A dialog or popover over the canvas
   hides the surface (existing `dockHiddenReason`); the SVG schematic shows
   through, so the editor never goes blank.

## Architecture

### Renderer

- `LayoutTab` wraps the stage canvas in a dock-slot element (the inner canvas
  rect only, not the 28 px handle gutter) and calls `useDockSlotReporter`
  with `slot: 'scene'`. `PreviewWindowState` gains `dockSlot: 'studio' |
  'scene' | null`; `DockSlotReport` gains `slot`. Only one tab mounts at a
  time (`app-shell.tsx:344-346`), so the reporters never fight; the field
  exists so main can log which slot owns the surface and so the stage knows
  when it is the live canvas.
- `SceneStage` gets `liveSurface: boolean` (docked in the scene slot, open,
  `dockHiddenReason === null`). When true the SVG runs in **hit-only** mode:
  painted shapes, selection, handles and guides get `visibility: hidden`
  while their pointer targets stay; the native chrome is the visual. When
  false, today's schematic renders unchanged. Nothing else in the gesture code
  branches on it.
- `flushSample` (`scene-stage.tsx:278`) additionally hands the ghost to a new
  `EditorDraftChannel` (`renderer/src/lib/editor-draft-channel.ts`, pure and
  unit-tested): coalesces to one in-flight `scene.editor.draft.set`, keeps the
  newest sample while one is pending, heartbeats every 500 ms while a gesture
  is active, sends `scene.editor.draft.clear` on cancel (Esc, blur, scroll,
  pointercancel, source/scene replacement, unmount), and on release sends the
  **rounded** rect (`roundRectForCommit`) so the draft and the commit are
  bit-identical. The commit path (`StageEdits.submit`) is unchanged.
- Chrome payload: `{ selected: rect, handles: bool, activeHandle?: id,
  guides: [{axis, position}], scale }` where `scale` = preview output pixels
  per CSS pixel of the slot (so a 1.5 px hairline is 1.5 px on screen at every
  window size).

### Main process

- `applyDockedPreviewChrome` (`main/index.ts:3754`) also calls
  `previewWindow.setIgnoreMouseEvents(true)`; `removeDockedPreviewChrome`
  restores it. The docked window has no interactive DOM (the drag bar is
  hidden by `body.docked`), so this is safe for the Studio slot too; it is
  what lets the SVG under the canvas receive pointer events. Floating keeps
  normal mouse handling.
- The Scene slot uses the same placement path as the Studio slot: epoch,
  `composeDockedScreenRect`, `showInactive`, corner radius
  `DOCKED_PREVIEW_CORNER_RADIUS`. No new movement path; the renderer stays out
  of it.

### Backend

- Protocol (`crates/videorc-backend/src/protocol.rs`, mirrored in
  `shared/backend.ts` and `shared/backend-rpc-contract.ts` with the contract
  test): `SceneEditorDraftParams { sourceId, transform: CameraTransform, chrome:
  EditorChrome }`, `EditorChrome { selected, handles, activeHandle?, guides,
  scale }`. RPCs `scene.editor.draft.set` and `scene.editor.draft.clear`,
  renderer role, refused with `editor-draft-refused` while the recording state
  is not idle.
- `CompositorRuntime.editor_draft: Option<EditorDraft { source_id, transform,
  chrome, refreshed_at, release_at_revision: Option<u64> }>`.
  `publish_compositor_frame` (`compositor.rs:6262`) applies it after
  `snapshot_with_transition`: the named source's `transform` is replaced by the
  draft rect with the committed crops preserved (same rule as
  `apply_transform_override`), and `editor_chrome_quads(&chrome, canvas)`
  (new `crates/videorc-backend/src/editor_chrome.rs`, pure, unit-tested)
  appends blended solid quads to the frame: a light 1.5 px line over a dark
  2.5 px line for the frame and guides, 8 px light squares with a dark rim for
  handles, the active handle brighter. Two 2×2 BGRA constants with stable
  `content_key`s (`GpuSource.blend = true`, `SourceMask::None`); the CPU path
  blends the same rects. `scale` decides thickness in output pixels.
- The render loop drops the draft when `refreshed_at` is older than 2 s or
  when the installed scene revision is ≥ `release_at_revision`. The
  `scene.source.transform.update` handler sets `release_at_revision` to the
  revision it committed. `scene.editor.draft.clear` drops it immediately.
- `CompositorStatus` reports `editorDraft: { sourceId, transform,
  releaseAtRevision } | null` so smokes can assert the effective geometry
  without screenshots.
- Mask law: `camera_mask` returns the shape when the preset is an inset scene
  **or** `arrangement_mode == Freeform`; `effectiveCameraMaskShape` mirrors
  it. `apply_transform_override` squares/aspects the box for the camera per the
  mask law (centre preserved, clamped to the canvas).

## Ordered execution slices

### S0 — Spike: pointer pass-through and blended chrome (Diagnose, `fable-5`, ½ day)

Prove the two primitives everything else stands on before writing product code.

1. In a scratch branch, call `setIgnoreMouseEvents(true)` on the docked preview
   window with the in-process addon on this Mac (macOS 26.5). Verify with a
   CDP-driven click and drag (reuse `scripts/smoke-preview-click-focus-app.mjs`
   conventions) that `pointerdown/move/up` arrive on `[data-videorc-stage-bounds]`
   under the surface, that the cursor changes to grab/resize, and that the
   preview window never takes focus. Record the result in this plan.
2. Append two hard-coded blended quads from a 2×2 solid texture to the Metal
   preview frame and confirm they are crisp at the docked slot size in
   `probe:preview-window`'s screenshot, and that `smoke:recording-native-preview`
   still reports zero CPU fallback frames.
3. Done when both results are written into this plan with the exact commands.
   If (1) fails: the helper-process host already ignores mouse events
   (`native_preview_host.rs:526-677`); evaluate forcing the helper driver for
   docked mode before choosing the overlay-window alternative. Stop and report
   if neither works.

**S0 result (1), recorded 2026-09-25 with the S3 code on this Mac (macOS 26.5,
in-process CAMetalLayer addon): PASS at the DOM level; OS-level HID click not
provable from this process.**

- Command: `pnpm probe:preview-window` (run as
  `VIDEORC_SMOKE_TIMEOUT_MS=900000 CARGO_TARGET_DIR=<private dir> pnpm
  probe:preview-window` because another agent's builds held the shared
  `target/` cargo lock; the private dir was pre-built with
  `CARGO_INCREMENTAL=0 cargo build -p videorc-backend --bin videorc-backend`,
  matching the dev app's own `cargo run` env).
- `OK pass-through: docked preview window ignores mouse events` (main applies
  `setIgnoreMouseEvents(true)` in `applyDockedPreviewChrome`, restored on
  undock).
- `OK scene-hit-only: schematic paint hidden, pointer targets visible and
  reachable` (`document.elementFromPoint` at every source centre lands on that
  source's `[data-videorc-stage-bounds]` while the surface is docked over the
  canvas).
- `OK pass-through(cdp): pointerdown reached the source hit rect under the live
  surface`: a trusted `Input.dispatchMouseEvent` press/release at the centre of
  `[data-videorc-stage-source="source:test-pattern"]` arrived on its
  `[data-videorc-stage-bounds]` (`isTrusted: true`), and
  `OK pass-through(cdp): the click selected the source` (the toolbar toggle for
  that source turned on and the inspector title changed to its name).
- `OK pass-through(cdp): preview window not focused after the click`
  (`focused-window` smoke command: `role: 'main'`, `previewFocused: false`), and
  `OK pass-through(cdp): surface still docked over the canvas`.
- `OK pass-through(os): skipped`: the probe also posts a real CGEvent
  left-click (`.cghidEventTap`) at the same point through a Swift helper, but
  on this host the cursor did not move, so the process is not allowed to post
  HID events and the OS-level path is recorded as unverified, not as a pass.
  Owner by-eye (S6) covers it: click and drag a source on the Scene canvas with
  the live picture showing.
- Cursor change to grab/resize was not asserted by the probe (the `cursor-grab`
  class on the source group and the handle `cursor` styles are unchanged by
  hit-only mode).
- S0 (2), blended chrome quads, is owned by S2 and not recorded here.

### S1 — Circle and Rounded apply in Freeform (Implementation, `gpt-5.5`, S)

Independent of S0; may ship on its own.

1. `scene_geometry.rs:245` `camera_mask`: apply the shape for the inset
   presets or `ArrangementMode::Freeform`. Update the doc comment.
2. `shared/native-preview-proof-geometry.ts:67` `effectiveCameraMaskShape`:
   same rule.
3. `scene.rs` `apply_transform_override`: for the camera source, conform the
   override box to the mask aspect law (circle → square, `cameraAspect`
   square/portrait → that aspect) about the box centre, clamped to the canvas;
   reuse `camera_box_size` / `custom_camera_box_fractions` rather than a new
   formula.
4. Tests: freeform rows in `scene_geometry.rs` mask tables, `compositor.rs`
   `camera_source_mask_follows_shape_and_preset`, `recording.rs`
   `camera_rounded_mask_pct_only_applies_to_screen_camera_rounded` (rename),
   `scene.rs` freeform override squaring, `native-preview-proof-geometry.test.ts`.
   Each new test must fail before the fix.
5. `scripts/smoke-freeform-editor-app.mjs` shape matrix: enter Freeform from
   `screen-only` and `side-by-side`, select Circle, assert
   `compositor.status` reports `shape: 'circle'` for the camera and the proof
   geometry matches; keep the existing inset entries.

Verify: `cargo test -p videorc-backend scene_geometry:: scene::tests::freeform
compositor::tests::camera_source_mask` and `cargo clippy -p videorc-backend --
-D warnings`; `pnpm --filter @videorc/desktop exec vitest run
src/shared/native-preview-proof-geometry.test.ts`; `pnpm typecheck`;
`pnpm smoke:freeform-editor`; `pnpm smoke:preview-scene-commit`. Real-app
check: Screen only → Freeform → Circle shows a circle on the stage and in the
preview; Rect afterwards shows a square box, not a stretched one.

### S2 — Backend editor draft and chrome (Implementation, `fable-5`, M)

1. Protocol types, RPC routes (`main.rs` dispatch tables at :4733, :4893,
   :9203 region), role/allowlist entries, `backend-rpc-contract.ts` schemas and
   its contract test (`allowUnknown:false` validators — pin every new field).
2. `CompositorRuntime.editor_draft`, the snapshot override in
   `publish_compositor_frame`, TTL and `release_at_revision` drop, refusal
   while a session is active, `CompositorStatus.editorDraft`.
3. `editor_chrome.rs`: pure quad geometry from `EditorChrome` + canvas size +
   `scale`; Metal and CPU consumers. The Windows D3D11 path ignores drafts
   (documented, not silently).
4. Tests: draft overrides only the named source and keeps crops; drops at TTL;
   drops when the installed revision reaches `release_at_revision` and not
   before; refused while recording; chrome quads inside the canvas, thickness
   from `scale`, active handle distinct; CPU pixel test that a frame edge is
   blended, not overwritten; existing `circle_mask_stays_round…` tests
   untouched.

Verify: `cargo fmt --check --all`; targeted `cargo test -p videorc-backend
editor_chrome compositor::tests::editor_draft`; `cargo clippy -p
videorc-backend -- -D warnings`; `pnpm --filter @videorc/desktop exec vitest run
src/shared/backend-rpc-contract.test.ts`; `pnpm typecheck`.

### S3 — The Scene canvas is a dock slot (Implementation, `fable-5`, M)

1. `DockSlotReport.slot`, `PreviewWindowState.dockSlot`, IPC validation
   (`shared/electron-ipc-contract.ts`, the runtime enum, not only the type),
   preload typings, `main/preview-dock.ts` parse + tests.
2. `setIgnoreMouseEvents` in `applyDockedPreviewChrome` / removal on undock;
   a unit test on the chrome helpers if they are extracted.
3. `LayoutTab`: slot element around the canvas with the output aspect;
   `useDockSlotReporter(liveCanvasSupported && docked, dockEpoch, 'scene')`;
   the auto-open policy from decision 6 in a mount effect that runs once per
   tab entry; footer actions "Show live here" / "Pop out" replace "Open
   preview" / "Close preview"; `SceneStage.liveSurface` hit-only mode.
   `liveCanvasSupported = platform === 'darwin' && nativePreviewSurfaceEnabled`.
4. `scripts/preview-window-probe.mjs`: a Scene-slot scenario (dock into the
   canvas, follow a main-window move, tab switch to Studio re-docks there and
   back, overlay hide/restore) and a pass-through scenario (a CDP click on the
   docked surface selects a stage source and never focuses the preview window).
   `probe:preview-lifecycle` unchanged but must stay green.

Verify: `pnpm --filter @videorc/desktop exec vitest run src/main/preview-dock.test.ts
src/shared/electron-ipc-contract.test.ts src/renderer/src/lib/dock-slot.test.ts`;
`pnpm typecheck`; `pnpm probe:preview-window`; `pnpm probe:preview-lifecycle`;
`pnpm smoke:preview-click-focus` (or the click/focus step of
`smoke:recording-studio`). Real-app: open the Scene tab with the preview
closed → the canvas shows the live picture inside the app; clicking a source
selects it; a popover over the canvas hides the surface and the schematic
shows.

### S4 — Live drafts from the stage (Implementation, `fable-5`, M)

1. `lib/editor-draft-channel.ts` + test (coalescing, one in flight, heartbeat,
   clear on cancel, rounded rect on release, ignores samples after cancel,
   no message when `liveSurface` is false).
2. Wire it into `SceneStage` (`flushSample`, `cancelGesture`, `endGesture`)
   and expose the RPCs through `use-studio` / `lib/scene-transform-commit.ts`
   without changing `StageEdits` semantics. The DOM ghost keeps updating (it
   is the schematic fallback and the hit layer).
3. Extend `scripts/smoke-freeform-editor-app.mjs` with a live-canvas matrix:
   during a CDP drag, `compositor.status.editorDraft.transform` tracks the
   ghost within 1e-4 and the chrome is reported; on release exactly one
   `scene.source.transform.update` is sent (existing counter), the draft's
   `releaseAtRevision` equals the committed revision, and the draft is gone on
   the next status after the scene installs; Esc clears it; a draft set while
   a smoke recording runs is refused; a stale draft (heartbeat stopped) is gone
   within 2.5 s. Record `framesRendered` cadence and present metrics
   (`main/native-preview-present-metrics.ts`) during 20 move and 20 resize
   gestures and assert no gap larger than two preview frames.

Verify: `pnpm --filter @videorc/desktop exec vitest run
src/renderer/src/lib/editor-draft-channel.test.ts
src/renderer/src/components/scene/stage-gesture.test.ts`; `pnpm typecheck`;
`pnpm lint`; `pnpm smoke:freeform-editor`; `pnpm smoke:preview-scene-commit`.
Real-app: dragging the camera moves the real camera picture under the pointer
with the frame and handles attached; release does not jump; Esc snaps back.

### S5 — Design pass on the Scene tab (UI/Product Design, `opus-4.8`, S–M)

Read the design skill first. The canvas is now the biggest thing on the tab.

1. Give the canvas the full width of the left column and the output aspect;
   the handle gutter stays a quiet 28 px ring; `rounded-panel` corners match
   `DOCKED_PREVIEW_CORNER_RADIUS`.
2. Footer: `Shift` / `Alt` / `Esc` key chips, the Freeform `Snap` toggle, then
   "Pop out" (docked) or "Show live here" (floating/closed); a tertiary hint
   while the surface is hidden ("Live view paused: a menu is open"). No toasts
   for scene/layout changes (toast discipline).
3. Hit-only mode must leave no stray strokes visible around the surface; the
   schematic fallback keeps the plan 043 look. Dark and light, landscape and
   portrait canvases, long source names, tiny sources.
4. Chrome colours in the compositor: light `#F4F4F5` at 92 %, dark `#000` at
   55 %, active handle white — monochrome per the design language; never the
   brand red.

Verify: `pnpm typecheck`; `pnpm lint`; `pnpm format:check`; `pnpm build`;
`pnpm check:renderer-assets` (the Scene tab is lazy-loaded, `app-shell.tsx:47`;
new code must stay in that chunk — the eager budget is within bytes of full);
screenshots of both themes and both orientations via the Freeform smoke's
visual matrix, inspected by eye.

### S6 — Gates, docs, owner checklist (Review, `fable-5`, S)

1. Run in order: `pnpm typecheck && pnpm lint && pnpm format:check`,
   `pnpm --filter @videorc/desktop test`, `pnpm test:scripts`,
   `cargo fmt --check --all`, targeted `cargo test -p videorc-backend` for
   `scene_geometry`, `scene`, `compositor::tests::editor_draft`,
   `editor_chrome`, `recording::tests::camera_` plus `cargo clippy -p
   videorc-backend -- -D warnings`, `pnpm build`, `pnpm check:renderer-assets`,
   `pnpm smoke:freeform-editor`, `pnpm smoke:preview-scene-commit`,
   `pnpm probe:preview-window`, `pnpm probe:preview-lifecycle`,
   `pnpm smoke:recording-native-preview` (assert zero CPU fallback frames and
   that a draft set during the recording is refused), then
   `pnpm smoke:recording-studio` and `pnpm smoke:recording-studio:devices` on
   this Mac. The owner directive on the Rust suite stands: targeted tests plus
   clippy, not the full 6-minute run, unless CI is confirmed unblocked.
2. Docs: `docs/preview-recording-parity-slices.md` (drafts and chrome are
   preview-tick state, never recorded), `docs/acceptance/2026-09-24-live-scene-canvas.md`
   with the owner by-eye checklist below, plan index row, this plan's status.
3. Owner by-eye: camera LED stays on when entering the Scene tab (capture is
   already running for the preview); drag/resize feel 1:1 with the pointer;
   circle bubble is round in the canvas and in a 10 s recording taken after the
   edit; Rounded radius slider updates live; a popover over the canvas pauses
   the live view and restores it; Pop out and back; light mode.

## Performance budget

- Idle Scene tab: no per-frame renderer work beyond today's docked preview;
  no timers except the 500 ms dock-slot heartbeat that already exists.
- During a gesture: ≤ 1 draft RPC per animation frame, ≤ 1 in flight, ~250 B
  each; compositor cost O(sources) for the override and ≤ 40 blended quads for
  chrome; no texture uploads per frame (two constant 2×2 textures).
- Targets (record machine, refresh rate, sample count): pointer-to-preview
  update ≤ 2 preview frames p95 (≈ 66 ms at 30 fps) measured by the smoke's
  `editorDraft` tracking; `framesRendered` cadence during 40 gestures shows no
  gap > 2 frames; zero CPU fallback frames; no renderer task > 50 ms
  attributable to the gesture (plan 043's targets stay in force for the DOM
  side: p95 pointer-to-paint ≤ 33 ms).

## Stop conditions

- S0 finds that a click-through docked window still swallows pointer events
  with the in-process addon and the helper driver cannot be forced for docked
  mode: stop and report; the overlay-window alternative needs its own plan.
- Blended chrome forces the Metal path into CPU fallback or costs measurable
  frame time (> 1 ms per tick at 1280×720): reduce to frame + handles without
  guides before reconsidering the approach.
- The draft cannot be dropped atomically with the committed scene install
  (a visible flash back on release in the smoke): fix the ordering; do not
  paper over it with a longer TTL.
- Any slice needs a new movement path where the renderer reports screen-space
  bounds: stop. That design failed on 2026-06-09 and must not return.
- The eager renderer budget (`check:renderer-assets`) regresses: move code into
  the lazy Scene chunk; never raise the ceiling in this plan.

## Out of scope

- Windows and Linux live canvas (proof-surface chrome and drafts; a Windows 11
  box is required). The schematic stage keeps working there.
- Editing while recording or streaming; multi-select; undo; rotation; a
  per-source thumbnail strip; a second camera.
- The FFmpeg AVFoundation fallback recording path sizes the camera from the
  preset (`recording.rs:17310` `camera_chain_filter`), not from Freeform
  overrides. Verify in S1 whether this path can still be selected with a
  Freeform scene; if yes, file it as its own fix, do not fold it in here.
- Plan 043's snap policy, plan 044's saved scenes and plan 042's scene
  animation are preserved as they are; coordinate `use-studio.tsx` edits.
