# Live Scene canvas (plan 058) — acceptance record, 2026-09-25

Scope: plan `plans/058-live-scene-canvas.md`. The Scene tab's canvas shows the
real composed program frame (the docked native CAMetalLayer preview) while a
scene is composed; drags and resizes move the real picture live; Circle and
Rounded apply in Freeform from any preset. This note records what the
automated gates proved on the finished branch and what the owner still checks
by eye.

## Host and build

| Item | Value |
| --- | --- |
| Branch | `feat/scene-live-editor` (plan 058 S1–S5) on `origin/main` `f4044b71` (0.9.108) |
| Machine | Apple M4, macOS 26.5 (Darwin 25.5.0), 60 Hz display |
| App | dev app (`electron-vite dev`), **debug** backend (`cargo run`), in-process CAMetalLayer addon |
| Scene | deterministic test-pattern sources (the dev app has no camera TCC grant), landscape 16:9 and portrait 9:16 canvases |
| Preview | 60 fps preview target on this build; presenter latest-wins |

Artifacts (local only — `docs/acceptance/artifacts/` and the smoke evidence
directories under `$TMPDIR` are not committed; the numbers below are the durable
record).

## What the automated gates proved

### S0 — pointer pass-through and blended chrome (the spike)

`pnpm probe:preview-window`, 54 OK / 0 FAIL:

- The docked preview window ignores mouse events (`setIgnoreMouseEvents(true)`
  in `applyDockedPreviewChrome`, restored on undock).
- A trusted CDP `Input.dispatchMouseEvent` press/release at the centre of a
  stage source, with the live surface docked over the canvas, arrives on that
  source's `[data-videorc-stage-bounds]` (`isTrusted: true`), selects the
  source, leaves the preview window unfocused (`role: 'main'`,
  `previewFocused: false`) and keeps the surface docked.
- The OS-level HID click (a real CGEvent through a Swift helper) is recorded as
  **skipped, not passed**: this host does not let the probe process post HID
  events (the cursor did not move). The owner by-eye item below covers it.
- Blended chrome quads: pinned by the Rust tests in `editor_chrome.rs` and
  `compositor::editor_draft_tests` (CPU pixel test: source-over blend, not an
  opaque overwrite); the Metal path pushes them as ordinary blended quads from
  three constant 2×2 bitmaps, so they cannot force a CPU fallback.

### Scene canvas as a dock slot (S3)

`pnpm probe:preview-window` scene scenarios, all OK: the surface covers the
Scene canvas rect (`dockSlot === 'scene'`, no hidden reason); drawable equals
canvas points × scale; the slot is the canvas rect, not the 28 px handle
gutter; hit-only mode hides every painted shape while every pointer target
stays reachable (`elementFromPoint`); the footer offers Pop out; a main-window
move is followed from main-process state; an open overlay hides the surface
with `overlay-open` and the schematic plus a tertiary hint return; closing the
overlay restores it; Scene → Studio → Scene re-docks in each slot with the
right `dockSlot`. `pnpm probe:preview-lifecycle` (100 cycles) and
`pnpm smoke:preview-click-focus` pass unchanged.

### Live drafts (S4)

`pnpm smoke:freeform-editor` (final live run, evidence
`videorc-freeform-editor-X4Fiz5`; control run with the preview floating and
no drafts, `videorc-freeform-editor-FNS18z`): 98 trusted gestures, 96/96 live
gestures pass the live gate, 96/96 DOM gates pass.

| Measure | Result |
| --- | --- |
| Draft tracks the DOM ghost | within 1e-3 on the first status poll, all 96 gestures |
| Pointer → backend draft match | p50 10.5 ms, p95 29.0 ms, max 40.7 ms (upper bound incl. the smoke's frame waits) |
| Commits per gesture | exactly one `scene.source.transform.update`; the release draft is bit-identical to the commit on the wire; no clear after release |
| Draft gone after release | p50 145 ms / max 273 ms with the smoke's 50/250 ms delayed commits, i.e. within ~15–20 ms of the commit installing; no flash back |
| Esc / pointercancel / pointer leaving | one clear each, draft gone in 16–22 ms |
| TTL | a draft set from a raw socket and never refreshed is gone 2.5 s later; explicit clear is immediate |
| Refusal while recording | `scene.editor.draft.set` during the smoke recording is refused with `editor-draft-refused`, nothing applied; accepted again after stop |
| Preview cadence during 20 move + 20 resize gestures per orientation | landscape and portrait: proven longest compositor stall 17 ms (1.03 frames, budget 2), mean 59.98–59.99 fps; control run without drafts: 17 ms / 33 ms, 59.89–60.05 fps |
| Slow `compositor.status` round trips | 0–1 per portrait run (84–94 ms) in both live and control runs, so not caused by drafts; recorded, not gated |
| Presenter | mean 60.0–60.1 fps, present p95 19–20 ms (recorded, not gated) |

### Idle selection chrome (follow-up to S4)

A merely selected source on the live canvas holds a *chrome-only* draft
(`scene.editor.draft.set` without `transform`): the compositor draws the frame
and the eight handles around the committed rect without overriding it, the
channel heartbeats it every 500 ms, a gesture suspends it and the stage re-holds
with the acknowledged rect after the commit installs. The Freeform smoke
asserts the hold is present (`sourceId` = selection, no `transform`) after every
gesture (96/96) and while idle; composited OS screenshot inspected: frame and
handles visible around the selected camera on the live picture.

### Circle in Freeform (S1)

Rust: `scene_geometry::camera_mask` freeform rows, `scene::tests`
`freeform_circle_override_squares_the_box_in_pixels_and_keeps_its_centre`,
`compositor::tests::camera_source_mask_follows_shape_and_preset` (freeform
row), `recording.rs`
`camera_rounded_mask_pct_only_applies_to_screen_camera_rounded_or_freeform`.
TS: `native-preview-proof-geometry.test.ts` freeform rows. Smoke: the Freeform
smoke enters Freeform from `screen-only` and `side-by-side`, selects Circle and
asserts the compositor reports `shape: 'circle'` and the stage paints a circle.

## Owner by-eye checklist (pending)

- [ ] Open the Scene tab with the preview closed: the canvas shows the live
      picture inside the app (the camera LED stays on; capture is the same
      session the preview already runs).
- [ ] Click and drag the camera on the canvas with a real mouse/trackpad: the
      real camera picture follows the pointer 1:1 with the frame and handles
      attached; release does not jump; Esc snaps back. (This is the OS-level
      pass-through the probe could not post.)
- [ ] Resize from a corner and an edge; the live picture and the handles move
      together in the same frame.
- [ ] Screen only → Freeform → Circle: a round bubble on the canvas and in a
      10 s recording taken after the edit; Rect afterwards shows a square box,
      not a stretched one. Rounded radius slider updates live.
- [ ] Open a popover or dialog over the canvas: the live view pauses with a
      tertiary hint and the schematic shows; closing it restores the picture.
- [ ] Pop out → floating preview + schematic canvas + "Show live here"; Show
      live here → docked again.
- [ ] Light mode: same structure, no stray strokes around the live canvas.
- [ ] Start a recording, then confirm the Scene tab refuses edits and the
      recording never shows selection chrome.
