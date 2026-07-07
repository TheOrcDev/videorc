# Plan 025: Native preview breaks across displays (stuck surface, "Waiting for preview")

> **Executor instructions**: External tester (François Best, Discord 15:56)
> report + screenshot. Moving the detached preview to a **secondary display**
> left the native video surface **stuck at the top-right of the main display**
> while the (parented) fallback window followed to the secondary and showed
> "Waiting for preview / Waiting for the first native frame". This is a
> Diagnose-route native-preview bug: the helper source IS in-repo and fixable,
> but the exact on-screen failure needs a **dual-display Mac to reproduce** (the
> executor almost certainly has only one — instrument first, then fix).
> Native-preview changes are NOT done on typecheck alone: cargo + the preview
> probes. Backend/helper changes need `cargo`.
>
> **Drift check (run first)**: `git status --short --branch`; re-read
> `crates/videorc-backend/src/native_preview_host.rs` (`appkit_y` ~114,
> `set_bounds` ~450, `window_frame`/`appkit_clip_frame` ~80/~691,
> `drawable_size` ~54), `apps/desktop/src/main/index.ts`
> (`previewWindowState` scaleFactor/screenHeight ~1997-1998,
> `pushPreviewWindowPlacement` ~2123, the preview-window `move` handler ~2287),
> and `apps/desktop/src/main/native-preview-helper-process-driver.ts` (~634) if
> they moved since `da1c4d80`.

## Status

- **Priority**: P1 — a multi-monitor creator (the target user) can't use the
  detached preview on a second display, the app's headline surface
- **Effort**: M (fix is scoped; the cost is the dual-display repro loop)
- **Depends on**: a dual-display Mac for repro + by-eye (owner or reporter)
- **Category**: native preview, multi-display, macOS coordinates
- **Planned at**: commit `da1c4d80`, 2026-07-07
- **Execution**: EXECUTED 2026-07-07 on branch `plan-025-multi-display-fix`
  (one PR). S2+S4 (contentsScale + geometry tests), S1 (multi-display
  diagnostic), S3 (display-change observer). **S5 CORRECTLY DEFERRED — do NOT
  flip it**: the self-exclusion capability already exists
  (`exclude_current_process_windows`), recording already excludes
  (`live_layout.rs`), but the PREVIEW deliberately keeps the self-capture
  tunnel (`preview_screen.rs:276-282` — "OBS-parity default … the preview-tunnel
  effect is expected behavior in every streaming tool", and a documented past
  regression: window exclusion "already cost a real stream a browser window
  whose tab title matched the old name heuristic"). Forcing it would regress
  documented intent; the ghost frames are that expected tunnel and/or the
  placement bug's two-surfaces artifact (fixed by S2/S3). Owner call if the
  default should change. Deterministic gates PASS (cargo 759+42, desktop 484,
  typecheck/lint/format, backend-resilience smoke). The
  `probe:preview-lifecycle` env-flaked on this GPU-saturated machine
  (Electron GPU process `exit_code=15` under the 100× churn after a long
  session; cleared 50+ cycles with the fix logging `contentsScale=2.00
  valid=true`) — the REAL verification is a **dual-display by-eye** (owner /
  François), which the fix is defensible-blind for.

## Report + evidence

Screenshot shows: the parented fallback preview window on the SECONDARY display
saying "Waiting for preview", the native video (or a stale frame) NOT with it,
and several ghosted "VIDEORC PREVIEW" frames. Two distinct problems:

1. **The native surface does not follow to the secondary display.** The
   fallback proof-surface window is `parent: previewWindow`
   (`index.ts:3347`), so AppKit moves it with the preview window to the
   secondary display automatically. The NATIVE CAMetalLayer helper is a
   **separate process** positioned by absolute global coordinates +
   `orderWindow_relativeTo` (`native_preview_host.rs:461,485`), and it lands
   wrong on a cross-display move → the secondary shows the fallback hint while
   the real surface is stuck on the main display.
2. **Ghost frames** — almost certainly recursive self-capture: this user's
   screen source includes Videorc's own windows (Robin's bundle: *"Videorc
   windows excluded no"*), so a screen-capture scene renders the app showing
   itself. Distinct from the placement bug; folded into S3.

## Verified findings (static, current code)

- **The Y-flip is correct, not the bug.** `appkit_y = screen_height − top −
  height` (`native_preview_host.rs:113-117`) with `screen_height =
  screen.getPrimaryDisplay().bounds.height` (`index.ts:1998`). This is the
  standard Electron(top-left, primary-anchored) → AppKit(bottom-left,
  primary-anchored) global reflection; it is correct for windows on ANY
  display in a standard arrangement (worked through the offset/taller-secondary
  cases). Do NOT "fix" it to a per-display height — that would break it.
- **`update-bounds` DOES reposition the window** (`set_bounds` →
  `self.window.setFrame_display(window_frame(bounds), true)`,
  `native_preview_host.rs:461`) and every preview-window `move` re-pushes
  (`index.ts:2287-2294`). So the surface is TOLD to follow — the failure is in
  how the destination frame/scale is realized, not a missing push.
- **DEFECT A — `contentsScale` is never set.** `set_bounds` sets
  `layer.setDrawableSize(width×scale, height×scale)` (`native_preview_host.rs:
  330`) but **never** `layer.setContentsScale(scale)` (grep: zero occurrences
  in the helper). `scale_factor` is the TARGET display's
  (`index.ts:1997`, `getDisplayMatching(contentBounds).scaleFactor`). When the
  window crosses to a display with a different `backingScaleFactor`, the layer
  keeps its old contentsScale while the drawable is sized for the new scale —
  a classic macOS mismatch that renders the surface wrong-sized / off-position
  and can stop it presenting (→ the "Waiting for the first native frame" hint,
  because no real frame lands). This is the prime suspect for BOTH symptoms.
- **DEFECT B — no display-change handling anywhere.** No
  `display-metrics-changed` / `NSApplicationDidChangeScreenParameters` /
  backing-properties observer in Electron main or the Rust helper (grep: zero).
  A cross-display move relies solely on the bounds re-push; nothing re-asserts
  the layer scale, or re-orders/re-homes the surface window to the new screen.
- **SUSPECT C — `orderWindow_relativeTo(Above, targetWindowNumber)`
  (`native_preview_host.rs:485`)** re-glues the surface above the Electron
  window every sync. Cross-display + cross-Space ordering-relative-to can pin
  or mis-home the surface; needs on-device confirmation (S1 instrumentation).

## Slices

### S1 — Instrument + reproduce on a dual-display Mac (Diagnose; do FIRST)

The helper already logs `[videorc-native-preview-sizing]` bounds/scale on each
change (`native_preview_host.rs:351`). Extend it (temporarily, then keep the
useful parts) to log, on every `set_bounds`: the resolved **AppKit window
frame** actually applied, the layer's **current contentsScale vs the incoming
scale_factor**, and **which NSScreen** the window landed on
(`self.window.screen()` deviceDescription id) vs which screen the frame
targets. On the Electron side, log `previewWindowState()`'s `contentBounds`,
matched display id, and scaleFactor on each cross-display `move`.

Repro on a dual-display Mac: open the detached preview, drag it to the second
display (ideally one with a DIFFERENT scale factor — built-in Retina + external
1080p is the sharpest repro), and capture the logs at the moment it sticks.
Confirm which of A/B/C fires: (a) contentsScale ≠ target scale, (b) the
NSScreen the window lands on ≠ the target display, (c) the AppKit frame is
NaN/clamped.

**Done when**: the logs pin the failing quantity; the repro is deterministic
(sticks every time on the cross-scale move). If a dual-display Mac is
unavailable to the executor, hand this slice to the owner/reporter with the
instrumented build and STOP — do not guess the fix past the confirmed defect.

### S2 — Fix the layer scale on cross-display move (DEFECT A)

In `NativePreviewLayerHost::set_bounds` (`native_preview_host.rs:324`), set the
layer's `contentsScale` to `bounds.scale_factor` whenever it changes, alongside
the existing `setDrawableSize`. Guard the drawable/frame against invalid inputs
(non-finite, ≤0) so a transient bad bounds during the cross-display move can
never produce a NaN frame macOS clamps to the primary's corner. Keep the pure
`drawable_size()` math; add `contents_scale()` returning `scale_factor.max(1.0)`
and a `sizing_inputs` entry so the sizing log fires on scale change.

**Done when**: on a simulated scale change (unit-testable at the pure layer:
scale 2→1 updates contentsScale AND drawableSize), the values agree; cargo
tests green.

### S3 — Re-home the surface to the destination display + guard frames (DEFECT B/C)

Whichever S1 confirms:
- If the window lands on the wrong NSScreen (C): after `setFrame_display` on a
  bounds update that crosses displays, re-assert the frame and the
  `orderWindow_relativeTo` glue on the NEXT runloop turn (macOS sometimes needs
  a second pass once the window has adopted the new screen), and verify the
  window's `screen()` matches the target before declaring the surface live.
- Add a display-parameters reaction: a `screen`
  `display-metrics-changed`/`display-added`/`display-removed` listener in
  Electron main (`index.ts`) that re-pushes preview placement (so a monitor
  hot-plug or arrangement change re-homes the surface), and/or have the helper
  re-read backing properties on frame set.
- Guard: never present into a layer whose window `screen()` is nil or whose
  frame is non-finite.

**Done when**: dragging across displays keeps the native surface glued to the
preview window (owner by-eye on dual-display); a `display-metrics-changed`
re-homes it.

### S4 — Pure geometry regression tests (lock the coordinate contract)

`native_preview_host.rs` already has `appkit_*` unit tests (~700+). Add
multi-display cases so the primary-anchored flip is pinned forever: a window on
a secondary display OFFSET right (origin (Wp,0)), one ABOVE (negative CG y), and
one on a TALLER bottom-aligned secondary — assert `appkit_clip_frame` lands the
window at the correct global AppKit origin in each. Add the contentsScale/
drawable agreement test from S2. These are the guardrail against a future
"fix the flip per-display" regression (the flip is already correct).

**Done when**: the multi-display geometry cases pass; a deliberately per-display
(wrong) screen_height makes them fail.

### S5 — Ghost frames: exclude Videorc's own windows from capture (related, own toggle)

The ghosting is recursive self-capture (Robin's bundle S6 #6: *"Videorc windows
excluded no"*). Default self-exclusion ON for the screen-capture source (or
expose it clearly), so a full-display capture doesn't include the app + its
preview. Scope: the ScreenCaptureKit content filter
(`screen_capture.rs`/`preview_screen.rs`) — add the app's own window ids to the
exclusion list. **Owner decides** whether it ships here or splits out; it is
NOT the placement bug, just the other thing in the screenshot.

**Done when**: a full-display capture no longer contains Videorc's own
windows/preview by default.

## Verification

- S1: instrumented build + dual-display repro logs.
- S2/S4: `cargo test -p videorc-backend`, `cargo clippy`, `cargo fmt --check`.
- S3: `pnpm probe:preview-lifecycle` + owner by-eye on dual-display (drag across
  displays, hot-plug a monitor).
- S5: `cargo test -p videorc-backend` (content-filter unit), by-eye capture.
- Batch: `pnpm smoke:local-gates`.

## Non-negotiables

- Do NOT change `appkit_y` to a per-display height — the primary-anchored flip
  is correct; S4 pins it.
- The layer's `contentsScale` must track the target display's scale on every
  bounds update — a scale mismatch is the prime suspect and must never recur.
- No frame is ever presented into a layer whose window has no screen or a
  non-finite frame (the "stuck top-right" clamp).

## Open decisions (kickoff)

1. If S1 can't run locally (no second display), hand the instrumented build to
   the owner/reporter and pause — vs attempt the A+B fixes blind (contentsScale
   + display observer are low-risk and defensible even without the repro).
   **Recommend: ship S2 (contentsScale) + the S3 display observer as
   defensible-blind fixes, but confirm with a dual-display by-eye before
   closing** — they address verified defects regardless of which one François
   hit.
2. S5 scope: here vs its own plan. **Recommend: its own small task** — it's a
   capture-filter change, orthogonal to placement.
