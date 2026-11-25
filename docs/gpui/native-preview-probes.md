# GPUI native preview probes (plan 260, L6)

Electron's four native-surface probes prove things about its detached `CAMetalLayer` helper and proof surface. The GPUI
app has neither: its preview is a `videorc_preview` element whose layer lives in the main window (docked) or the Preview
window (floating). This note designs the GPUI versions: the same promise, checked with GPUI oracles. They extend the four
probes already on GPUI (`probe:preview-lifecycle`, `probe:preview-window`, `smoke:preview-interaction-stress`,
`probe:library-player`), share `scripts/lib/gpui-preview-probe.mjs`, and run with `VIDEORC_APP=gpui`, which hands each
Electron script over to its GPUI version as the existing four do.

## Oracles already on GPUI

- `native-preview-surface-status`: the element's live `presentedFrameId`, `presentedSceneRevision`, frame size, phase,
  `state` (`live` while presenting), the layer's set and displayed frames and the slot.
- `preview-window-state`: mode, phase, `closed`, `floatingOpen`.
- `preview-surface-sample` and `capture-page`: the composited window (`screencapture -l`).
- The backend: `compositor.status` (`sceneRevision`, `frameSceneRevision`, `framesRendered`), `preview.surface.status`
  (the surface's own record: state, `presentedFrameId`, `droppedFrames`, `compositorFrameLag`, present fps and
  intervals) and the recording analyzer.

## 1. `smoke:preview-pump-diagnostics` → the preview says why it waits

**Electron's promise:** a present skipped in main surfaces why, so the preview never starves silently.

**GPUI version:** whenever the element is not presenting, its status names a reason, and its counters say what happened.

- **Steps:**
  1. Docked and presenting.
  2. Starve it three ways: `preview.surface.destroy` (the backend surface goes away), Close Preview (⌘P, parked since
     #2207) and a scene the compositor holds still (`preview.live.stop`).
  3. Sample every 100 ms.
- **Holds when:**
  - Every sample that is not `presenting` carries a non-empty `message`.
  - `presentedFrameId` doesn't advance while parked.
  - Each starvation either heals by itself or names the step that heals it (Retry).
  - `skipped`, `refused` and `dropped` are reported, and only grow.
- **Needs:** `native-preview-surface-status` to also report the telemetry counters `skipped`, `refused` and `dropped` (they
  are in `Telemetry`; not yet in the answer).

## 2. `smoke:preview-click-focus` → a click on the Preview keeps it presenting

**Electron's promise:** clicking or focusing the detached preview neither stops presentation nor strands scene updates.

**GPUI version:** the same for the Preview window and for the docked slot.

- **Steps:**
  1. Open the Preview window.
  2. Click into its video (`ui-click` at a point inside the slot, `window: preview`).
  3. Focus the main window, then the Preview window, five times each.
  4. Click the docked slot after docking back.
  5. Between steps, commit a new scene (`select-layout-preset` or `scene.layout.apply_preview`).
- **Holds when:**
  - `presentedFrameId` advances through every step: never still for more than 1 s.
  - The phase stays `presenting`.
  - `presentedSceneRevision` reaches each new `compositor.status` `sceneRevision` within 2 s.
- **Needs:**
  - A window-scoped `ui-click` at a point. The driver has `clickAt`, so this checks whether it takes `window`.
  - `main-window-focus`, which GPUI doesn't answer yet; it's added with this probe.

## 3. `smoke:recording-native-preview` → the preview stays current while recording

**Electron's promise:** during a take, the native preview keeps presenting the current scene, and the recording is sound.

**GPUI version:**

- **Steps:**
  1. Test pattern, docked and presenting.
  2. Record 10 s (`studio-record` / `studio-stop`).
  3. During the take, change the layout twice and open and dock the Preview window once.
  4. Sample the element every 100 ms and `compositor.status` every 250 ms.
- **Holds when:**
  - The preview never stands still for more than 1 s and never leaves `presenting` (a parked or closed Preview is not part
    of this probe).
  - `presentedSceneRevision` catches up with every `frameSceneRevision` within 2 s.
  - The layer stays on its slot (`displayedFrame` = `layerFrame` = `slot`) after each placement change.
  - The take lands in the isolated recordings folder and passes `analyzeRecording` (frames, A/V skew, no frozen run).
- **Needs:** nothing new.

## 4. `smoke:preview-surface` → the backend's record of the surface matches the screen

**Electron's promise:** the detached native surface's lifecycle and placement are owned by its presenter, and the
packaging invariants hold.

**GPUI version:** the element is the presenter. What it tells the backend (`FeedCommand::Bounds`, the surface bounds)
must match where the layer is, and the backend's surface record must follow the lifecycle.

- **Steps:** each of these, with `preview.surface.status` read from the backend:
  - Docked.
  - After main-window moves and resizes.
  - Floating, after moving and sizing the Preview window.
  - Closed (⌘P).
  - Reopened.
  - Retry.
- **Holds when:**
  - The backend record is `live` while presenting, with `presentedFrameId` advancing, and drops while parked.
  - The bounds the element last sent (screen position and size, scale factor) equal the layer's window frame plus the
    window's screen origin, within 1 point.
  - `visible` is false while hidden or closed.
  - `droppedFrames` and `compositorFrameLag` stay bounded: report-only on a test pattern.
- **Needs:** `native-preview-surface-status` to report the element's `last_bounds` (the `PreviewSurfaceBounds` it last
  sent).

## Order and scope

1. **First PR:** the two small status fields (counters, last bounds), `main-window-focus`, and probes 1 and 2.
2. **Second PR:** probes 3 and 4.

Each comes with a run on the sentinel's build under the app-run lock, and rows in `S1.6e/gpui-smoke-matrix.md`.
All four are macOS-first: Linux's presenter child and Windows (no preview yet) get named SKIPs, as the existing GPUI probes
do.
