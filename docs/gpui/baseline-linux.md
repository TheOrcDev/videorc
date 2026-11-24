# The Electron baseline on Linux (plan 260 S0.10, lane L5)

The Linux half of [baseline.md](baseline.md): today's Electron app on
Linux, shot with the same shooter, and what its processes cost.

- **Archive:** `~/linux-beta/plan260-s0-10/archive/2026-11-24-linux/` on
  ogre, 428 PNGs (45 MB) in 35 screen folders, outside the repository.
- **Manifest:** [baseline-manifest-linux.json](baseline-manifest-linux.json),
  one entry per shot with its size and SHA-256, the same format as the
  macOS manifest, plus `notShotOnLinux`.
- **App:** the dev build of `main` at `afe203ec5` (the S0.10 shooter's
  commit; app code as 0.37.x), the release backend, the shooter's isolated
  profile seeded with the test pattern (camera and microphone off), fake
  keys, saved scenes and two test recordings. Signed out.
- **Where:** ogre (Omarchy, Hyprland 0.56.2, i7-8750H). The owner's session
  was locked, so the app ran on Wayland in a nested Hyprland on the lab
  output, with a private session bus (no portal, none of the owner's
  services). Every core was pinned at 800 MHz (the T2 firmware's PROCHOT).
- **Looks and sizes:** as on macOS (dark, light, Increase Contrast over
  each; pages at 960x660, 1100x720 and 1280x800). The PNGs are **1x** (the
  nested output's scale is 1); macOS's are 2x.

## Not shot on Linux

| What | Why |
| --- | --- |
| First run, all five steps, all four looks (20 shots) | **Not applicable on Linux today.** First run is hidden on Linux by design: `firstRunSnapshotDecision` returns `hide` for `platform === 'linux'` (`apps/desktop/src/renderer/src/lib/first-run.ts:84`), so a fresh profile, and a seeded in-progress record after a reload, both open Studio. The shooter waited for `[data-first-run-setup]` and timed out. Linux first run is plan 257's S17 (Linux steps: screen portal, groups, Secret Service, destinations); shoot it once S17 lands |
| The signed-in Sidekick part (`--parts=buddy`) | It needs the debug backend (the mock account); a debug backend target (25 to 33 GB) does not fit ogre's free disk next to the lanes' targets. The Sidekick pages are shot signed out |

## Shoot it again (on ogre)

```sh
# In a checkout of main with pnpm install done and Electron fetched:
VIDEORC_DEV_BACKEND_PROFILE=release WAYLAND_DISPLAY=<the nested display> \
  node scripts/capture-ui-pages.mjs --baseline \
  --baseline-out=$HOME/linux-beta/plan260-s0-10/archive/<date>-linux \
  --parts=idle,windows,live,first-run
node scripts/capture-ui-pages.mjs --baseline-manifest \
  --baseline-out=$HOME/linux-beta/plan260-s0-10/archive/<date>-linux
# --baseline-manifest writes docs/gpui/baseline-manifest.json: rename it to
# baseline-manifest-linux.json and fix `folder` and the 1x note.
```

Build the release backend under the ogre build lock first
(`cargo build --release -p videorc-backend`, `CARGO_BUILD_JOBS=3`): about
23 minutes at 800 MHz. The full shoot took about 40 minutes at 800 MHz,
13 of them the first-run steps timing out (macOS: 25 minutes).

## What Electron costs (Linux, 2026-11-24)

Percent of one core, averaged over 180 s after 30 s of settling, from the
CPU time of the app's process tree in `/proc` (sampled every 2 s); the dev
build of the renderer, so an upper bound for the packaged app. **800 MHz.**

| State | Electron main | Renderer, GPU and helpers | Electron total | Backend |
| --- | ---: | ---: | ---: | ---: |
| Idle, Studio, preview closed | 0.1 (p95 0.5) | 15.1 (p95 20.7) | 15.2 | 0.7 (p95 1.4) |

Memory, median: main 223 MB, renderer, GPU and helpers 674 MB, backend
59 MB. On Linux the renderer and GPU processes fork from the zygote and
keep its command line, so the sampler could not split them.

- **Recording 1080p60: owed.** The Linux recording smoke
  (`smoke-recording-matrix-app.mjs`, synthetic content) refuses a release
  backend (it needs the debug backend's test tone), and the performance
  runner's `record-1080p60` records the real screen, camera and microphone,
  which on ogre's locked session means the screen-share portal and the
  owner's devices. Measure it with the debug backend on a box with the disk
  for it, or on the owner's unlocked session.
- Start-up against GPUI is in plan 260's S0.9 results on Linux.
