# macOS preview root fix — acceptance (2026-07-09)

Status: implementation and non-device automated verification complete on
`codex/macos-preview-root-fix`. Current real-device rerun and owner by-eye
acceptance remain pending because macOS no longer exposes a ScreenCaptureKit
source to the rebuilt local backend permission target.

## Product contract

- The production macOS preview is an in-process `CAMetalLayer` attached to the
  Electron preview window. A separate helper window is an explicit diagnostic
  fallback only.
- Floating and docked movement stay OS-atomic. Placement and frame delivery are
  bounded latest-wins lanes, and position-only movement does not rebuild or
  invalidate the IOSurface presentation cache.
- Clicking, focusing, resizing, docking, undocking, minimizing, restoring, and
  moving between display scales cannot expose the Electron base underneath the
  native video.
- Scene/layout selection is backend-owned and last-intent-wins. The previous
  good frame remains visible until the winning scene is ready, and scene,
  compositor, frame, and native-presented revisions must agree.
- Preview failure never silently impersonates native success. Diagnostics state
  whether the in-process host is attached and why any fallback was selected.
- Closing or failing preview presentation must not stop or perturb recording or
  streaming.

## Implemented architecture

### One native window and one placement writer

- Added a universal Rust N-API native module that accepts Electron's native
  `NSView` handle and owns a child `CAMetalLayer` in that same window hierarchy.
- Main is the sole live placement authority. Renderer reports dock-slot and
  lifecycle intent; it does not race main with absolute movement writes.
- Placement operations are serialized with lifecycle priority, one active
  mutation, and one newest pending placement. Window motion reconciliation is
  capped to display cadence.
- Docked position-only movement follows the AppKit parent/child relationship and
  avoids redundant geometry work on every main-window event.

### Latest frame without cache churn

- Compositor ingress is one active presentation plus one newest pending frame;
  intermediate superseded frames are counted and discarded before they can
  become a main-process backlog.
- Presentation metrics now expose queue wait, native present time, queued-behind
  count, coalesced frames, placement accounting, IOSurface cache reuse/imports,
  and cache/import failures.
- Drawable-size and contents-scale updates no longer discard compositor
  IOSurface imports. Cache invalidation is reserved for actual native host
  create/destroy lifecycle boundaries.

### Atomic scene transactions

- Idle preview and live-session layout changes use backend-owned scene
  transactions with monotonic intent identity.
- Required sources warm before commit; superseded work cannot publish stale
  scene or source state; retired source generations cannot resurrect later.
- Main derives native scene authority from committed compositor truth and
  rejects conflicting/stale revisions.
- Renderer keeps a newer layout control actionable while another intent warms,
  then commits UI/config state only after backend/compositor/native proof.
- Recording startup now uses that same scene-commit authority. It allocates a
  revision above current compositor truth and holds the commit lease until the
  exact startup scene owns its first encoded frame, so a delayed idle renderer
  reload, takeover screen, or debug scene write cannot replace it mid-start.
- Automatic capture-config reloads are idle-only and are canceled as soon as a
  local session transition begins. A queued idle reload cannot resume after a
  recording becomes authoritative.

### Lifecycle and packaged delivery

- In-process attach/detach is generation-guarded across close/reopen,
  dock/undock, surface loss, display-scale changes, and app teardown.
- The native addon is built for both macOS architectures, bundled as
  `videorc_native_preview.node`, included in package validation, and signed with
  the rest of the app.
- The helper-process path remains available only behind an explicit fallback
  policy with a surfaced reason.

## Automated evidence

The maintained combined gate uses one in-process bounds-storm command rather
than opening hundreds of synthetic HTTP connections per second. Its external
device oracle is PID-scoped and samples a downscaled `320x180` ScreenCaptureKit
image at 5 Hz, which is enough to catch the 250 ms disappearance contract
without becoming the source of WindowServer pressure.

| Contract / gate | Result |
| --- | --- |
| Pixel and CGWindow continuity during rapid floating movement, resize, docked movement, focus/click, and scene intent | PASS — one Electron preview window, no helper process/window, no exposed `#0D0D0F` base, 0 px native-window offset |
| Current synthetic interaction stress | PASS — 41 rapid scene transitions, 116 ms maximum stall; floating 58.7 FPS / 20 ms p95, resize 62.4 FPS / 20 ms p95, docked 58.7 FPS / 20 ms p95; 0 dropped frames, 0 compositor lag at phase end, 0 cache invalidations/import failures; report `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-preview-interaction-stress-1783643065158/report.json` |
| Earlier real-device interaction recording | PASS — 59.4 s artifact and analyzer passed before the final startup/drawable follow-ups; report `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-preview-interaction-stress-1783639298818/report.json` |
| Idle movement cadence in that run | PASS — floating 62.6 FPS / 19 ms p95; resize 57.1 FPS / 23 ms p95; docked 58.4 FPS / 22 ms p95 |
| Rapid scene continuity in that run | PASS — 41 transitions, 26 ms maximum presented-frame stall, no dropped frames or revision mismatch |
| IOSurface cache lifecycle regression | PASS — placement/drawable changes preserve imports; create/destroy resets them |
| TypeScript static gates | PASS — typecheck, lint, format, and `git diff --check` |
| Desktop unit tests | PASS — 592/592 |
| Node script/artifact tests | PASS — 402/402 |
| Backend Rust tests | PASS — 851 passed, 7 ignored; one known parallel compositor timing test passed in isolation and on the full rerun |
| Native addon unit tests and clippy | PASS — 34/34; backend and addon clippy clean |
| Builds and advisory audits | PASS — desktop build, JS production high-severity gate (one moderate advisory), Rust audit |
| Recording-studio aggregate | PASS through stages 1–18, including all-layout artifact analysis, imported-screen startup, zero-settle live layout switching, interaction stress, 100 lifecycle cycles, placement/dock, and native reattach. Stage 19 then blocked because ScreenCaptureKit enumerated no screen source; stage 20 did not run. |
| Packaged app | PASS — universal 1,078,320-byte native addon; all five packaged recording layouts passed artifact/A-V analysis at 52 ms skew; packaged native preview measured 60.4/61.0/61.0 FPS, 19 ms p95, and 57.3 ms reattach |
| Current device aggregate | BLOCKED BY HOST — focused real screen capture found no ScreenCaptureKit source, and the device interaction oracle could not acquire its persistent CGWindow capture after the backend rebuild. No device assertion failed. |

The device commands must be rerun after granting Screen Recording to the exact
permission targets reported by Runtime Info. This record does not claim that
current device or physical by-eye acceptance passed.

## Owner by-eye checklist (pending)

Automation proves frame/revision continuity and external pixels. It does not
replace the affected owner's perceptual sign-off.

- [ ] Float preview and drag it rapidly for 30 seconds. Motion must remain
      smooth and the video must never reveal the dark base.
- [ ] Stick preview to Studio and drag the main app rapidly for 30 seconds. It
      must read as one window with no visible surface chase.
- [ ] Repeatedly click/focus preview, main, and back again. Video must not
      disappear, flash, or stop advancing.
- [ ] Continuously resize; if available, move between displays with different
      scale factors.
- [ ] Switch camera-only → screen-only → side-by-side at normal speed and in
      rapid bursts. The final selection must always win without stale content.
- [ ] Repeat movement, clicking, resizing, and scene switching during a
      60-second recording.
- [ ] Inspect the finished artifact for continuity and A/V correctness.

Sign-off: _pending owner pass_

## Related plan

Obsidian: `plans/planned/2026-07-09 - Videorc macOS Preview Root Fix Plan.md`
