# Plan 260, Windows code: the Windows slices for contributors

This document is for the outside contributors who write the Windows code of
Videorc's new desktop app. It goes with [plan 260](260-gpui-rewrite.md)
(the rewrite of the Electron app in GPUI, Zed's GPU UI framework) and with
the [Windows testing plan](260-gpui-rewrite-windows-testing.md), which says
how each slice is tested and how evidence is sent.

The owner, 2026-11-23: "We have two contributors on Windows. We'll make a
plan for testing for them and a plan for writing code." All three platforms
switch to the GPUI app together (plan 260, D8), so the Windows slices are on
the critical path: the switch waits for them.

## How the work is organised

- **Two kinds of code.** Phase 0 spikes are throwaway programs that answer
  one question each; they go in PRs against the branch `spikes/gpui`, one
  folder per spike under `spikes/gpui/`, and never reach `main` (the
  repository keeps scratch code out of `main`, `AGENTS.md`). Product code
  from Phase 2 on goes in PRs against `main`.
- **One slice, one PR.** Small PRs (a few hundred lines where possible),
  titled `type(scope): what changes` as the history does, for example
  `feat(gpui-windows): the preview as a native view`. The PR description
  links the slice in this document and says how it was tested.
- **Checks.** Every PR to `main` runs Windows CI (`.github/workflows/windows.yml`),
  which must be green. Spike PRs need no CI; they need the evidence
  comment from the testing plan.
- **Review.** A maintainer reviews the code. A slice that the testing plan
  checks on a PC is done when its evidence comment is posted and the owner
  has reviewed it (the rule from plan 220, P4-D6: a contributor's run with
  a screen recording and the app's logs is the physical pass).
- **Who does what.** Each slice is marked:
  - **Solo:** one contributor can do it end to end.
  - **Waits on maintainers:** it needs a backend or app change on
    Videorc's side first; the slice names it. Until then, the contributor
    can do the parts listed as "can start now".
  - **Pair:** a contributor writes and tests it, with a maintainer in the
    loop for design or release access (signing keys and release feeds stay
    with the maintainers).
- **Licences.** Videorc is AGPL-3.0. GPUI and its platform crates are
  Apache-2.0 and may be used and patched. **Never copy code from Zed's GPL
  crates** (`ui`, `ui_input`, `component`, `theme`, `editor`, `settings`,
  `livekit_client`, and anything else in Zed marked GPL-3.0-or-later).
  gpui-kit (`gpui-base`, `gpui-component`) is Apache-2.0.
- **GPUI version.** Pinned exactly to one weekly `gpui-pre` snapshot
  (plan 260 D1; `gpui-pre = "=0.3.14"` and its platform crates at the time
  of writing). Don't bump it in a slice; bumps are their own PR.
- **Patching GPUI.** A change to GPUI goes in a fork of the one platform
  crate under `[patch.crates-io]` (for spikes: `spikes/gpui/patches/`),
  and is also sent upstream to `zed-industries/zed` as a PR with an
  example. Keep patches small: plan 260 stops and asks the owner before a
  fourth patch.

## What Videorc already has on Windows

You don't need to rebuild these; the new app uses them through the backend.

- **The backend** (`crates/videorc-backend`) records, streams and composes
  on Windows with D3D11: capture (`windows_graphics_capture.rs`,
  `windows_d3d11_capture.rs`), the compositor (`windows_d3d11_compositor.rs`),
  Media Foundation encoders (`windows_media_foundation_encoder.rs`) and its
  own preview presenter (`windows_d3d11_preview.rs`: a swap chain for
  composition on a DirectComposition visual in a window the backend
  creates, hidden from capture with `WDA_EXCLUDEFROMCAPTURE`).
- **The app talks to the backend** over a loopback WebSocket with JSON
  messages (`crates/videorc-backend/src/protocol.rs`, moving to the
  `videorc-protocol` crate in plan 260 S1.1).
- **Today's preview in the Electron app on Windows** is a bitmap polled over
  HTTP (the "proof surface"). Anything below beats it.
- **Not on Windows today, so not in scope:** a tray icon (no platform has
  one), Videorc Camera (hidden on Windows until proven).
- The dev loop, gates and launcher rules: [docs/windows-dev-loop.md](../docs/windows-dev-loop.md).

## Phase 0: spikes (on the `spikes/gpui` branch)

Each spike prints `[spike] summary <json>` and writes `summary.json` (the
testing plan's fields), closes itself after `--seconds`, and has a README
with the exact command and a macOS or reference screenshot where one
exists. The macOS spike that showed a native layer under GPUI (plan 260,
"Spike S0.0") is on the branch as `spikes/gpui/spike-native-preview/` to
read as a model.

### WC-0.1 GPUI on Windows (`spike-hello`). Solo.

- **Goal:** prove GPUI builds and runs on your PC, and give every other
  spike its frame: a 280-pixel sidebar, a content pane, a translucent box
  and pill drawn over a coloured area that GPUI repaints once a second, a
  `summary.json` with `renders`, `startup_to_first_paint_ms` and `errors`.
- **Files:** `spikes/gpui/Cargo.toml` (the spikes' workspace, if not there
  yet), `spikes/gpui/spike-hello/`.
- **Done when:** the testing plan's S0.2a checks pass on one PC, with the
  build time and target size posted.

### WC-0.2 Route (a): a native view on Windows, in one process. Solo.

- **Goal:** the Windows twin of GPUI's macOS `NativeView`: a
  DirectComposition visual placed **beneath** GPUI's own visual in the same
  composition tree, laid out by a GPUI element (position, size, clipping to
  rounded corners on the visual), with content presented by a thread of its
  own. In this spike the content is a synthetic swap chain
  (`IDXGIFactory2::CreateSwapChainForComposition`) the spike clears to a
  changing colour 60 times a second.
- **Where in GPUI:** `gpui-pre-windows` builds its composition target and
  one visual in `src/directx_renderer.rs` (about lines 116 to 181); the
  macOS API to mirror is `gpui-pre` `src/window/native_view.rs`. The patch
  goes in `spikes/gpui/patches/gpui-pre-windows/`.
- **Done when:** the visual sits under GPUI content and moves and resizes
  with layout; translucent GPUI elements blend over it; the present thread
  runs at the display's rate while GPUI redraws at most twice a second when
  idle; the patch's size is counted in lines (added, changed) in the PR.

### WC-0.3 Route (b): GPUI draws a shared texture, in one process. Solo.

- **Goal:** GPUI's DirectX renderer draws a D3D11 texture shared by NT
  handle each frame (today its `draw_surfaces` is empty,
  `src/directx_renderer.rs` about lines 845 to 850). In the spike, a second
  D3D11 device on another thread fills a texture created with
  `D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX`
  and the GPUI element opens and draws it.
- **Done when:** it draws at the producer's rate; the summary reports the
  cost of redrawing the whole window per video frame (this is route (b)'s
  known price) and the patch size.

### WC-0.4 Route (d): CPU frames as a GPUI image. Solo to start; waits on maintainers for real frames.

- **Goal:** a second process writes BGRA frames into shared memory and the
  GPUI app draws the newest as an image element, with one copy per frame
  and no tearing.
- **Can start now** with a synthetic producer. **Waits on maintainers:**
  plan 260 S1.7 lands Videorc's shared-memory ring (`videorc-preview-ring`)
  on `main`; then the spike reads that ring instead.
- **Done when:** the testing plan's numbers for route (d) at 1080p60 and
  4K60 are posted (route (d) copies by design; the question is its cost).

### WC-0.5 All routes with the real backend (`spike-preview-windows`). Waits on maintainers.

- **Goal:** the four routes with the backend's real 4K60 synthetic scene,
  one binary with `--route a|b|c|d`, `--floating`, and the testing plan's
  summary fields.
- **Route (c) can start now:** the backend already presents its own
  preview window. The spike starts the backend, asks for the preview the
  way the Electron app does, and keeps the backend's window placed over its
  pane with the bounds messages (`PreviewSurfaceBounds`, and
  `MainOwnedPreviewSurfaceBounds`, which carries the owning window's
  handle: `crates/videorc-backend/src/protocol.rs`, about lines 4128 to
  4290). This route is the fallback
  plan 260 wants to avoid, so it is measured, not polished.
- **Waits on maintainers for (a), (b) and (d): plan 260 S0.2b**, the
  backend handing its preview over across processes:
  - for (a), a DirectComposition surface handle
    (`DCompositionCreateSurfaceHandle`) that the backend's presenter
    presents into, duplicated into the app's process, which shows it with
    `IDCompositionDevice::CreateSurfaceFromHandle` as the content of
    WC-0.2's visual: the presenter stays in the backend, zero copies, the
    same shape as macOS;
  - for (b), a small ring of shared NT-handle textures with a keyed mutex;
  - for (d), the shared-memory ring (S1.7);
  - and a preview lease message in the protocol that says which one the
    app gets.
- **Done when:** the testing plan's S0.2c checks are posted for all four
  routes on both contributors' PCs. The owner then picks the route (D12).

#### Taking the hand-over (routes (a) and (b), plan 260 S0.2b)

The backend half of routes (a) and (b) is on `main`
(`crates/videorc-backend/src/windows_d3d11_preview_handover.rs` is the
contract; `preview_handover.rs` is the message). Route (d) follows when the
shared-memory ring lands (S1.7).

- **Which preview.** The hand-over serves the backend's D3D11 media session:
  the one that runs while a Windows recording or stream captures a display
  (the session today's presenter shows). Start one first, with the display
  as the screen source; a test-pattern source takes another path. With no
  session, the open answers `preview-handover-unavailable`.
- **The message,** on the backend's WebSocket with the main-process (admin)
  credential, one per connection:

  ```json
  {"id": "1", "method": "preview.handover.open",
   "params": {"leaseId": "<a new UUID>", "route": "composition-surface",
              "consumerPid": <your process id>}}
  ```

  `route` is `composition-surface` (a) or `shared-texture` (b). The answer
  (`PreviewHandoverLease` in `protocol.rs`) carries `headerMappingHandle`,
  `frameEventHandle`, `compositionSurfaceHandle` (route (a) only),
  `adapterLuid` and `mediaGeneration`. Every handle is already in your
  process: use the number as a `HANDLE` and close each one yourself when you
  are done. `preview.handover.close` with the same `leaseId` ends it; so does
  closing the connection.
- **The header.** Map `headerMappingHandle` (`MapViewOfFile`, read and
  write, 4096 bytes). Its layout is the `HandoverHeader` struct (byte offsets
  in its comments, checked by a test); `HandoverHeader::read` is the reader
  to copy. Wait on `frameEventHandle` (auto-reset, set after each frame),
  then read: `framesPublished` counts frames, `width`/`height` is the latest
  frame's size, `publishedQpc` is `QueryPerformanceCounter` at publish (for
  the hand-off latency), `retired` turns nonzero when it ends (1 closed, 2
  the session stopped or recovered, 3 failed): close every handle, send
  `preview.handover.close`, and open again (a connection holds one lease at
  a time).
- **Route (a):** `IDCompositionDevice::CreateSurfaceFromHandle(compositionSurfaceHandle)`
  and set the result as the content of WC-0.2's visual. The backend presents
  into it at the session's rate; nothing in your process runs per frame.
  The surface is the frame's size: scale the visual to the element from the
  header's `width`/`height` (a new size keeps the same surface).
- **Route (b):** when `textureGeneration` changes, open the three
  `slotHandles` on a device of the adapter `adapterLuid` names
  (`ID3D11Device1::OpenSharedResource1`), close the previous set's handles,
  and store the generation in `textureGenerationSeen` (the backend waits for
  that before it makes another set). To draw: take `latestSlot`, acquire its
  keyed mutex with key 0, draw, release key 0. Hold it no longer than one
  draw. **Trap:** `windows-rs`'s `IDXGIKeyedMutex::AcquireSync` returns `Ok`
  on `WAIT_TIMEOUT` (a success code); call it through the vtable and compare
  the raw `HRESULT` as `try_acquire` in the backend does.
- **What to report** (in the S0.2c summary): `frames_published` per second
  against the session's frame rate, `frames_dropped` from the header, and the
  hand-off latency (`QueryPerformanceCounter` when you draw minus
  `publishedQpc`).

### WC-0.6 The look on Windows (`spike-chrome`). Solo.

- **Goal:** the macOS look spike (plan 260 S0.4) built and run on Windows:
  remove or `cfg` away anything macOS-only, keep every drawing call.
- **Done when:** the testing plan's S0.4 screenshots are posted.

### WC-0.7 Text on Windows (`spike-text`). Solo.

- **Goal:** the text spike's Windows half: IME through GPUI's input handler
  (GPUI uses IMM32 on Windows, `gpui-pre-windows src/events.rs`, about line
  1507), colour emoji and font fallback through DirectWrite, selection and
  copy, the 10,000-row chat with animated emotes.
- **Done when:** the testing plan's S0.5 checks are posted; anything that
  fails is listed with a guess at the fix's size.

### WC-0.8 Narrator and the test driver (`spike-a11y`). Solo.

- **Goal:** GPUI's AccessKit tree reaches Narrator (`gpui-pre-windows`
  already depends on `accesskit_windows`), and a small driver finds and
  clicks a control by role and name through UI Automation. The real UI
  driver (plan 260 S2.5) uses the same tree on every platform.
- **Done when:** the testing plan's S0.6 checks are posted.

### WC-0.9 Desktop integration (`spike-desktop`). Solo.

- **Goal:** each row of the testing plan's S0.7 table in one spike: the
  title bar with Windows' caption buttons and snap layouts (hit-testing the
  maximise button as `HTMAXBUTTON`); a global shortcut with the
  `global-hotkey` crate; a URL scheme registered under
  `HKCU\Software\Classes\videorc-spike` and a cold start from it; single
  instance (a named mutex, and the second start's arguments handed to the
  first over a named pipe or loopback); `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`;
  a topmost window; `SetThreadExecutionState` while "keeping awake"; a
  system notification through GPUI (an unpackaged app needs an
  AppUserModelID, set on a Start menu shortcut); file dialogs, Show in
  folder, drag and drop.
- **Done when:** the S0.7 table is posted with a verdict per row.

## From Phase 2: the app (PRs to `main`)

The app is `apps/videorc` (the `Videorc` binary), built by maintainers in
plan 260 S2.1 on macOS first. Its platform code lives in
`apps/videorc/src/platform/windows/`; Windows slices change files there and
in the GPUI patch crates, and touch shared files only where the slice says.

| Slice | What | Who | Waits on | Done when |
| --- | --- | --- | --- | --- |
| WC-2.1 | Windows CI builds, tests and lints `apps/videorc` and the kit crate (the Windows runner has the SDK's `fxc.exe`) | Solo | S2.1 | `windows.yml` runs `cargo build`, `cargo test` and `cargo clippy -D warnings` for them on every PR |
| WC-2.2 | The preview element on Windows on D12's route, docked and floating: the first-frame contract and the fallback labels as on macOS, the floating window hidden from capture | Pair | S0.2b, S2.3a (the element's shape on macOS), D12 | The testing plan's S0.2c checks pass against the real app; the GPUI form of `probe:preview-lifecycle` passes on Windows |
| WC-2.3 | If D12 picks (a): the native-view patch cleaned up and sent to `zed-industries/zed` as a PR with an example | Solo | WC-2.2 | The upstream PR is open; our patch crate matches it |
| WC-2.4 | Window frame, scale, theme and type: the custom header with Windows' caption buttons and snap layouts, per-monitor scale, dark, light and contrast themes following Windows live, saved window positions | Solo | S2.1, S2.2 | The testing plan's "Scale", "Title bar" and "themes" rows pass |
| WC-2.5 | Keys, links and one instance: global shortcuts (`global-hotkey`), the shortcut recorder, `videorc://` (sign-in, Stream Deck, remote) cold and warm, single instance with the arguments handed over, the sleep guard | Solo | S2.1, S2.6a (the shared OS interface) | The keyboard, links, one-instance and stay-awake rows pass |
| WC-2.6 | Hide from stream on every window, files (dialogs, Show in folder, Recycle Bin through the `trash` crate, drag and drop) and the camera and microphone privacy prompts (linking to `ms-settings:privacy-webcam` and `ms-settings:privacy-microphone` as today) | Solo | S2.1 | The hide, files and privacy rows pass |
| WC-2.7 | System notifications (watchdog, update ready) with the app's AppUserModelID, and the signed-in session sealed in Windows Credential Manager through the `keyring` crate | Pair | S1.6 (the sign-in store in app-core) | A notification opens the right page; sign-in survives a restart; nothing secret is written in plain text |
| WC-3.x | Windows-only fixes found by the per-screen passes in Phase 3: one small PR each | Solo | That screen's macOS PR | The screen's Windows rows pass |
| WC-4.1 | The smokes with `VIDEORC_APP=gpui` on Windows: the launcher's Windows rules for the GPUI binary (`scripts/lib/app-launcher.mjs`; docs/windows-dev-loop.md "Windows-specific launcher rules") | Solo | S2.5 (the smoke command server and UI driver) | `pnpm smoke:local-gates:windows` runs against the GPUI app |
| WC-4.2 | The installer: NSIS for the GPUI app, the same install folder, uninstall entry, Start menu shortcut and AppUserModelID as today's app, `videorc://` registered, the FFmpeg files where the backend expects them; upgrading an Electron install in place | Pair (signing stays with maintainers) | WC-2.5, S5.1 | Installing over Electron keeps every setting and scene; uninstall leaves no app files; SmartScreen and UAC prompts as today |
| WC-4.3 | The updater on Windows: `videorc-updater` downloads, verifies and runs the signed installer from the feed, with a way back | Pair | S5.2 (the feed and updater wiring) | An update from one signed test build to the next works on both PCs |
| WC-5.1 | The crossover on Windows: a signed Electron build updates itself into the signed GPUI app | Pair (testing by a contributor, release by maintainers) | S5.0, WC-4.2, WC-4.3 | The testing plan's Phase 5 row passes on both PCs |

## The order

```text
now:            WC-0.1 ─► WC-0.2 ─► WC-0.3            (contributor A)
                WC-0.1 ─► WC-0.5 route (c) ─► WC-0.4  (contributor B)
                WC-0.6, WC-0.7, WC-0.8, WC-0.9        (whoever is free)
after S0.2b:    WC-0.5 routes (a), (b), (d) on both PCs ─► the owner takes D12
after S2.1:     WC-2.1 ─► WC-2.4 ─► WC-2.5 ─► WC-2.6
after S2.3a:    WC-2.2 ─► WC-2.3
Phase 3:        WC-3.x per screen, behind each macOS screen PR
Phase 4–5:      WC-4.1 ─► WC-4.2 ─► WC-4.3 ─► WC-5.1
```

WC-0.1 comes first on both PCs: it proves the toolchain on each machine
and gives every later spike its frame and summary format.
