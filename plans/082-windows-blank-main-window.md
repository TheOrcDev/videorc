# Plan 082: Windows main window opens blank (Mica with nothing painted on it)

Status: **IMPLEMENTED, in review** 2026-10-01: PR #518 on `fix/windows-blank-main-window`
(S1-S3; see [Implementation record](#implementation-record-2026-10-01)). The
picture is reproduced on a GitHub Windows runner by crashing the main renderer
(see [Repro record](#repro-record-2026-10-01)); what killed the reporter's
renderer is still unknown. Owed: the on-box Windows 11 pass (S3.4), the
Windows alpha and the reply to the reporter (S4). Priority P1 (launch failure
on a supported platform is `impact:blocker` in
`docs/support/windows-alpha-triage.md`).

Owner route: **Diagnose** (fit 9), model lane `fable-5` (launch-blocking,
platform-specific, cannot be reproduced locally). Build on `main`, in your own
worktree: the plan-storage checkout (`feat/windows-owner-waiver`) is at 0.9.98.

## The report

One Windows user on 0.9.124 (`0.9.124-alpha.1`, shipped by owner waiver with
no physical pass: `docs/acceptance/windows-alpha/0.9.124-alpha.1.json`). The
screenshot (`~/Downloads/win.png`, not committed) shows a maximized Videorc
window: native title bar, native menu bar, and a client area with no UI at
all. The user calls it "the entire app crashing".

## Findings

### What the screenshot proves

- The client area is bare Mica. Sampled pixels: title bar `(28,34,30)`,
  client area `(29,34,31)` at the same x. The page's window coat
  (`--glass-window`, `oklch(0.13 … / 34%)` on dark win32, `styles.css:279`)
  would darken the client area to roughly `(22,25,23)`. It did not.
- So **nothing from the web contents reached the screen**, not even the
  `body` background from the stylesheet. That rules out a React render crash
  or any JS exception (the coat paints without JS, and `AppErrorBoundary`
  would show a card). The document either never loaded, its process is gone,
  or its pixels are not being composited.
- The main process is alive: the system menu in the screenshot is drawn by
  the window's own message loop.

### Why a blank main window is possible at all

1. **The main window has depended on GPU compositing since 0.9.102.** Plan
   050 (#395) gave the Windows 11 main window `backgroundMaterial: 'mica'`
   with `backgroundColor: '#00000000'` (`window-glass.ts:158-162`). Before
   that it was opaque.
2. **We already diagnosed this failure class once.** #51 (`10fa23b8`): on a
   machine with a broken Chromium GPU process, a transparent-backed window
   "composites NOTHING", silently. That fix made the proof surface opaque off
   macOS (`index.ts:5250-5266`). Plan 050 then put the same dependency on the
   whole app.
3. **Electron has the same bug on file.** electron/electron#42446:
   `backgroundMaterial` makes the window "blank and unusable" on a VM/RDP
   display adapter; closed "not planned". Native Mica apps fall back to
   opaque there; Electron does not. Related maximize bugs: #41824, #42393,
   #46753 (the reporter's window is maximized).
4. **The GPU self-heal does not know about Mica.** `glassMode` is resolved at
   `index.ts:845` from platform, env and Windows build only. The GPU fallback
   decision is made later (`index.ts:887-916`) and never feeds back. So a
   launch with `app.disableHardwareAcceleration()` (persisted
   `gpu-fallback.json` after two GPU crashes, or `VIDEORC_DISABLE_GPU=1`)
   still creates a transparent Mica window. Whether that combination paints
   is **unverified** on a real box; no test or smoke covers it. If it does
   not, the fallback bricks the app, and "Retry hardware acceleration" lives
   in Settings, which is not visible.
5. **The main window has no failure handling.** In `createWindow`
   (`index.ts:1702-1900`): no `did-fail-load`, no `unresponsive`, and
   `render-process-gone` only disarms the shortcut recorder (`:1822`). A dead
   or never-loaded renderer leaves exactly this window on screen for ever.
   Nothing is logged for a renderer exit either: `child-process-gone`
   (`:919`) does not fire for renderer processes.
6. **Mica never got its on-box pass.** `docs/acceptance/2026-09-23-real-glass.md:92`
   still lists the Windows 11 box check as owed, and the coats are "starting
   values".

### Candidates (re-ranked after the repro: H2 now leads)

| # | Cause | Fits | Tell |
| - | ----- | ---- | ---- |
| H1 | Mica + this machine's display path (VM, RDP, basic/remote adapter, bad driver, or the persisted software-rendering fallback): the renderer runs, its pixels are never composited | Blank from launch, every launch; known Electron bug; our own #51 | `VIDEORC_GLASS=0` fixes it |
| H2 | Renderer process died (crash, OOM, GPU-driver fault) and nothing reloads it | "Crashing"; may be mid-session | App worked for a while first; `VIDEORC_GLASS=0` does not help |
| H3 | Main document failed to load | Same picture | Rare in a packaged build; logged by nothing today |

One fix set covers all three, so the plan does not wait on telling them apart.

## Repro record (2026-10-01)

Branch `repro/windows-blank-main-window` (throwaway, never merge): workflow
`repro-windows-blank-main-window.yml` + `scripts/repro-windows-blank-main-window.mjs`.
It installs the unsigned installer CI built from the 0.9.124 source commit
(`06c295db`, run 36685662146), launches it, photographs the real desktop and
queries the renderer over CDP. Runner: Windows Server 2025 build 26100 (so
the Mica branch is taken), "Microsoft Hyper-V Video", no GPU, 1024x768.

- Run 36834347391: default, `VIDEORC_GLASS=0`, `VIDEORC_DISABLE_GPU=1`, and
  both together. **The main window paints in all four** (sidebar and Studio
  visible on screen; renderer reports `rootChildren: 3`). So a missing GPU
  alone, and software rendering with Mica, are not sufficient on this image.
  H1 survives only as a driver- or session-specific fault (real GPU driver,
  RDP), which a hosted runner cannot show.
- Run 36834804103: after `Page.crash` on the main renderer, the main window
  is **title bar + menu bar + empty client area**, the reporter's picture.
  It stays that way (photographed 6 s later), the page target is still
  listed, and neither stdout nor `backend.log` has any line about it. This
  confirms findings 5 and D4/D5: one renderer death is permanent and silent.
- Not covered: the maximized main window (the script's `FindWindow` call
  passed an empty class name instead of null; use `[NullString]::Value`), a
  real GPU driver, RDP.

The same script, pointed at the fixed build, is the starting point for S3's
paint smoke: after the fix the post-crash photograph must show the UI again.

## Ask the reporter now (no build needed)

Send with the first-response template in `windows-alpha-triage.md`:

1. Does it happen on every launch, or after using the app for a while? After
   maximizing? Did 0.9.122 work?
2. Windows build (`winver`), GPU model, and whether this is a VM, Remote
   Desktop, or a laptop on a dock / external GPU.
3. Workaround to try, in order. Each is also a diagnostic:
   - `setx VIDEORC_GLASS 0`, then quit and reopen Videorc. Fixed means H1.
   - If not: `setx VIDEORC_DISABLE_GPU 1` and reopen.
   - Whether `%APPDATA%\Videorc\gpu-fallback.json` exists (yes means the
     software fallback was active).
4. Do not ask for `%APPDATA%\Videorc\logs\backend.log` yet (triage privacy
   rule); ask only whether it contains a line starting `GPU process crashed`
   or `Chromium`.

## Decisions

- **D1. Mica is opt-out by evidence, not by default trust.** Windows gets
  Mica only when GPU compositing is really available. Otherwise the solid
  palette, which is the Windows 10 path and already shipped.
- **D2. Software rendering always means solid.** No transparent backing when
  hardware acceleration is off, on any path.
- **D3. A window that cannot prove it painted drops to solid by itself** and
  remembers that, so the next launch starts solid. The user never needs an
  environment variable.
- **D4. A dead or failed renderer is reloaded, with a bound,** then a native
  dialog (it must not depend on the renderer) offers Reload and Quit.
- **D5. Every one of these events writes a line to `backend.log`** through
  `logBackend`, and the applied glass mode and its reason go into
  `runtimeInfo` for the support bundle.
- Out of scope: tuning Mica coats, a custom title bar, changing the macOS
  material, the aux windows (already solid on Windows), upgrading Electron.

## Slices

### S1: solid window whenever the GPU cannot be trusted

Files: `apps/desktop/src/main/window-glass.ts`, `window-glass.test.ts`,
`index.ts`, `shared/backend.ts` (RuntimeInfo), `runtime-info` builder + test.

1. Move the GPU fallback block (`index.ts:887-916`) above the `glassMode`
   resolution (`:845`). It only needs `app.getPath('userData')`; keep the
   `VIDEORC_USER_DATA_DIR` / `VIDEORC_APP_DATA_DIR` overrides (`:862-870`)
   ahead of it so smokes stay isolated.
2. `GlassEnvironment` gains `softwareRendering?: boolean` and
   `glassDisabledByWatchdog?: boolean`. `GlassMode` solid reasons gain
   `'software-rendering'` and `'paint-watchdog'`. In the `win32` branch,
   either flag returns solid before the build check.
   `softwareRendering = gpuFallbackDecision.disable ||
   VIDEORC_SMOKE_DISABLE_ELECTRON_GPU === '1'`.
3. After `app.whenReady()` and before `createWindow()`, on win32 with mode
   `mica`: read `app.getGPUFeatureStatus().gpu_compositing` and
   `app.getGPUInfo('basic')`. If compositing is not `enabled`, or the active
   device is Microsoft's software or remote adapter (vendor `0x1414`:
   Basic Render Driver, Hyper-V Video, Remote Display Adapter), downgrade to
   solid with reason `'gpu-unsuitable'`. Put the predicate in a pure
   `micaAllowedForGpu(featureStatus, gpuInfo)` with tests. `glassMode`
   becomes a `let`, or is resolved lazily at first window creation.
4. `runtimeInfo` reports `windowGlass: { kind, reason }`. Remember the serde
   trap does not apply (TS-only), but the renderer contract must accept the
   new optional field.

Done when: unit tests cover every new branch; `pnpm typecheck`, `pnpm lint`,
`pnpm --filter @videorc/desktop test` pass; macOS values are bit-identical
(existing `window-glass.test.ts` darwin cases unchanged).

### S2: main-window recovery and the paint watchdog

Files: new `apps/desktop/src/main/main-window-recovery.ts` + test (pure
policy, injected clock), `index.ts` wiring, preload + renderer one-line beat.

1. `render-process-gone` on the main window (keep the recorder disarm): log
   `reason` and `exitCode`. Unless the reason is `clean-exit` or `killed`,
   reload. Policy: at most 2 automatic reloads in 60 s, then
   `dialog.showMessageBox` with Reload / Quit. Never reload while
   `mainCaptureState` says a recording or stream is live without also logging
   that the backend session survives (the backend owns the session; the
   renderer reattaches on load). Verify that reattach path before relying on
   it, and say so in the PR.
2. `did-fail-load` (main frame, not `ERR_ABORTED`): log code and description,
   retry once after 500 ms, then the same dialog.
3. `unresponsive` / `responsive`: log only.
4. Paint watchdog, win32 only, mode `mica` only:
   - The renderer sends `window:first-paint` from `main.tsx` after the first
     `requestAnimationFrame` following `createRoot().render`.
   - 5 s after the window is shown, main calls
     `webContents.capturePage()` on a small centre rect and checks it is not
     fully transparent. Missing beat means the renderer never ran (H2/H3:
     handled by step 1-2). Beat present but transparent capture means H1.
   - On H1: `setBackgroundMaterial('none')`,
     `setBackgroundColor(solidWindowBase('main', dark))`, re-record applied
     glass as solid `'paint-watchdog'`, persist
     `userData/window-glass.json` (`{ disableMica: true, reason, updatedAt }`),
     log it. S1 reads that file at launch (`glassDisabledByWatchdog`).
   - `capturePage` may not see what DWM fails to show. That is the open
     question S3 answers; if it cannot, the watchdog keeps only the beat and
     S1's GPU predicate carries H1.
5. Settings → General, next to the hardware-acceleration row: one row that
   shows when Mica was turned off and a "Try the glass window again" action
   that deletes the file (applies on next launch). `videorc-design` skill
   applies; plain copy, no new components.

Done when: policy tests pass; on macOS the app behaves identically
(handlers are platform-neutral, the watchdog is win32-gated);
`pnpm probe:preview-lifecycle` still passes, since `createWindow` changed.

### S3: prove it on Windows

1. Extend the smoke command `main-window-state` (`index.ts:9969`) with
   `glass` (applied mode + reason) and `painted` (the watchdog's capture
   verdict).
2. New `scripts/smoke-windows-main-window-paint.mjs` + package script
   `smoke:windows-main-window-paint`: launch the app three ways (default,
   `VIDEORC_SMOKE_DISABLE_ELECTRON_GPU=1`, `VIDEORC_GLASS=0`) and assert
   `painted: true` and the expected glass mode in each. Follow the AGENTS.md
   Windows process rules: readiness channel, bounded cleanup, no sleeps.
3. Add it to `.github/workflows/windows.yml`. `windows-latest` has no GPU, so
   it exercises exactly the no-GPU path; record in the PR which glass mode
   the runner resolved.
4. On the physical Windows 11 box (or the reporter, if they agree): default
   launch shows Mica and UI; maximize / restore / minimize; then force each
   fallback and confirm a readable solid window. Record in
   `docs/acceptance/2026-10-xx-windows-blank-main-window.md`, and close the
   Mica row still owed in `2026-09-23-real-glass.md`.

Done when: the new smoke is green in Windows CI and the acceptance note
exists. If no box is available, say so in the PR and ship on CI evidence plus
the reporter's confirmation.

### S4: ship and close the loop

1. Windows alpha with the next numeric version (`videorc-release` skill; it
   must be a version bump, never `-alpha.2`). macOS rides along unchanged.
2. Add a known-issue entry with the `VIDEORC_GLASS=0` workaround for anyone
   still on 0.9.102-0.9.124.
3. Reply to the reporter; ask for one confirmation launch.

## Implementation record (2026-10-01)

What shipped in the PR, and where it departs from the slices above:

- **Recovery (S2.1-S2.3) as planned.** `main-window-recovery.ts` (pure policy
  + tests) and `installMainWindowRecovery` in `index.ts`: a dead renderer or a
  failed main-frame load reloads the window, at most 2 times in 60 s, then a
  native Reload / Quit dialog. Every renderer exit in any window is logged
  (`Renderer process gone (reason, exit code) for <page>`); `unresponsive` is
  logged. The reload is deferred 500 ms out of the failure event: reloading
  inside it made one crash report twice and spend the whole budget.
- **S1.2 as planned:** software rendering resolves to the solid window
  (`software-rendering`). The GPU decision now runs before the glass mode.
- **S1.3 dropped.** The repro showed Mica painting correctly on the "Microsoft
  Hyper-V Video" adapter with no GPU, so a vendor/adapter predicate would turn
  Mica off on machines where it works. The paint check covers the case by
  evidence instead.
- **Paint check (S2.4) without a renderer beat.** Main asks
  `capturePage()` what the page drew, 5 s after load; no alpha anywhere, twice,
  means blank. `isCrashed()` replaces the beat. On blank: `setBackgroundMaterial('none')`
  + the solid base, and `window-glass-fallback.json` keeps the solid window
  for **this app version** (an update tries Mica again).
- **No Settings row (S2.5).** The version-scoped fallback replaces the manual
  retry; `VIDEORC_GLASS` still overrides.
- **Diagnostics:** `runtimeInfo.windowGlass` = `{ kind, reason, paintCheck }`.
- **Smoke (S3.1-S3.3):** `pnpm smoke:windows-main-window-recovery`
  (`scripts/smoke-windows-main-window-recovery.mjs`, gates in
  `scripts/lib/main-window-recovery-gates.mjs`), wired into `windows.yml`'s
  installer job. Four scenarios against the packaged app: default launch +
  paint verdict, crash + recovery, software rendering, forced blank + the
  remembered fallback (`VIDEORC_SMOKE_FORCE_BLANK_PAINT_CHECK=1`). It reads
  `runtimeInfo` over CDP instead of extending the `main-window-state` smoke
  command.
- **Verified on macOS** with the built app: `Page.crash` on the main renderer,
  UI back within seconds, one `Renderer process gone` + one `Reloading the
  main window` line.
- **Verified on Windows CI** (PR #518, run 36836853964, build 26100, packaged
  app): default launch `mica` + paint check `painted`; crash then UI back with
  both log lines; `VIDEORC_DISABLE_GPU=1` gives `solid/software-rendering`;
  forced blank gives `solid/paint-check-blank`, persisted, and the next launch
  starts solid. So `capturePage()` does not misread a healthy Mica window.
- `pnpm probe:preview-lifecycle` on the branch: 2 failures ("Main window is
  not ready", the failure #513 also recorded), then 2 passes at 100/100;
  clean main passed once. No recovery line in the failing logs. Read as the
  existing flake, not proven.
- **Not verified:** a reload while a recording or stream is live (the default
  View > Reload menu already reaches that path; the log line records the
  capture state); the repeated-crash dialog by hand; a real GPU driver; RDP.

## Verification

- `pnpm typecheck && pnpm lint && pnpm format:check`
- `pnpm --filter @videorc/desktop test`
- `pnpm build`
- `pnpm probe:preview-lifecycle` (main-window lifecycle touched)
- Windows CI green including `smoke:windows-main-window-paint`
- No Rust change expected; if one appears, targeted `cargo test` + clippy.

## Risks

- **Wrong candidate.** If the reporter's cause is none of H1-H3, S2's logging
  is what tells us; the fixes are still correct on their own.
- **Reload during a live session.** The renderer has never been reloaded
  mid-stream in production. Bound it and verify reattach (S2.1).
- **`capturePage` blind spot.** See S2.4; do not claim the watchdog covers H1
  until S3 shows it.
- **False Mica downgrades** on hybrid-GPU laptops: the predicate must look at
  the active device, and the applied reason is visible in Settings and the
  bundle, with a retry.

## References

- electron/electron#42446, #41824, #42393, #46753
- #51 `10fa23b8` (blank proof surface on broken GPU), #395 `09568cc5` (Mica)
