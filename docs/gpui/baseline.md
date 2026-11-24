# The Electron baseline (plan 260 S0.10, macOS)

What the GPUI app is compared against: every window, page, tab and dialog of
today's Electron app, shot in four looks, and what Electron's processes cost.
The pictures live outside the repository; this folder holds their manifest.

- **Archive:** `~/videorc-gpui-baseline/2026-11-24/` on the owner's Mac,
  532 PNGs (168 MB) in 38 screen folders.
- **Manifest:** [baseline-manifest.json](baseline-manifest.json), one entry
  per shot with its size and SHA-256, the looks, and how the shots were
  taken (`notes`). The GPUI shooter reads it (plan 260 "Verification":
  `rust-ui-baseline.mjs compare`).
- **App:** the dev build of `main` (app code unchanged since 0.37.1),
  isolated profile, seeded with the test pattern, three saved scenes, fake
  destination keys and two short test recordings. Signed out, except the
  signed-in Sidekick run (the dev-only mock account and local fakes; no
  real account or service).
- **Looks:** dark, light, and Increase Contrast over each. Pages and their
  tabs at 960x660, 1100x720 and 1280x800; menus, dialogs, the palette,
  toasts, Retro LCD, the live states and first run at 1280x800; the Stream
  Manager at its four widths; Captions reader and Notes at their default
  frames. Sizes are CSS pixels; the PNGs are 2x.
- **Windows and Linux:** their halves are the contributors' (the Windows
  testing plan's S0.10 section) and L5's on ogre.

## Shoot it again

```sh
# Idle, windows, live and first run (release backend)
VIDEORC_DEV_BACKEND_PROFILE=release \
  node scripts/capture-ui-pages.mjs --baseline --baseline-out=$HOME/videorc-gpui-baseline/<date> \
  --parts=idle,windows,live,first-run
# The signed-in Sidekick run (debug backend: the mock account is debug-only)
node scripts/capture-ui-pages.mjs --baseline --baseline-out=$HOME/videorc-gpui-baseline/<date> --parts=buddy
# The manifest
node scripts/capture-ui-pages.mjs --baseline-manifest --baseline-out=$HOME/videorc-gpui-baseline/<date>
```

`--screens=` and `--looks=` narrow a run; a step that fails is listed and
the run goes on. The shooter is plan 220 S0.1a's, ported: today's tab ids
and labels, Electron's localStorage settings
(`scripts/lib/rust-ui-baseline-settings.mjs`), and the Library player in
the Markers dialog. It refuses the signed-in part with a release backend,
which would ignore the mock account. A run takes about 25 minutes on this
Mac.

## What Electron costs (macOS, 2026-11-24)

Percent of one core, averaged; the dev build of the renderer (React
development mode), so these are an upper bound for the packaged app.

| State | Electron renderer | GPU process | Main | Helpers | Electron total | Backend | FFmpeg |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Idle, Studio, preview closed (180 s, load 3 to 4) | 14.7 | 6.6 | 0.9 | 0.1 | 22.3 | not captured | |
| Recording 1080p60, native preview docked (300 s, load 9 to 12) | 36.2 (p95 55) | 14.4 | 8.5 | 0.9 | 60.0 | 16.0 (p95 18.7) | 2.1 |

Memory, median at the end of the run: idle, the renderer 232 MB, main
134 MB, GPU 76 MB, backend 47 MB, total process tree up to 1.09 GB with the
dev tooling; recording, the renderer 482 MB, main 155 MB, GPU 82 MB,
backend 106 MB, FFmpeg 20 MB, total up to 1.24 GB. The recording ran at
59.9 fps with a 20 ms p95 frame interval.

Measured with `scripts/performance-scenario-runner.mjs` (`ui-idle`,
`record-1080p60`, `--report-only`); idle CPU from `ps` CPU time of the
app's processes over 180 s, because `ui-idle` samples memory only. Owed: the
packaged 0.37.1 app's numbers (the `performance-macos` workflow on its
authorized runner), and the backend's idle CPU.
