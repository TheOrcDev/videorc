# Studio Audio balance acceptance (plan 201), 2026-10-27

Scope: [plan 201](../../plans/201-studio-audio-balance.md), slices S0 to S4.
The Studio's Audio section holds Microphone and System audio, each with its
level and shared Gain fader, on one audiocn Mixer scale. The Sources mirror
keeps Screen and Camera. This record separates automated evidence from the
owner checks still owed; it is not final visual or granted-audio signoff.

## Host

| Item          | Value                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Baseline      | Main at `0438849f`, the plan's pinned `origin/main`                                            |
| Product head  | S3 `13060516`, with S2 `d931105f`, S1 `81ebc5e6`, S0 `3eb22cbc`                                |
| Machine       | Apple M4, `Mac16,1`, macOS 26.5.1 (25F80), Node 24.22.1, pnpm 11.0.9                           |
| Checkout      | Detached HEAD in the implementation worktree; no `crates/` differences between baseline and S3 |
| Dev app grant | Screen Recording missing; System audio cannot be On                                            |

The fetch moved `origin/main` to `cb70d4ff`. Every comparison below uses
the requested `0438849f` baseline.

## Automated evidence

### S0: idle Clips data path

The execution notes report 2,568 script tests passed, 0 failed and 1 skipped,
including all 31 focused System audio gate tests. The first native smoke
timed out at `Backend still compiling after 1200s`; the retry with a
3,600,000 ms prebuild timeout built the backend. The host's
`ELECTRON_RUN_AS_NODE=1` then prevented app launch at `getVersion`;
unsetting it reached the permission check.

The authorized missing-grant run exited 0 with this output:

```text
system-audio: SKIPPED (VIDEORC_SYSTEM_AUDIO_SMOKE_ALLOW_MISSING_GRANT=1): System audio device is permission-required; the dev app needs the Screen Recording grant (System Settings > Privacy & Security > Screen & System Audio Recording).
```

No native audio case ran. S0 did not prove ring readings, the 12 dB gain drop
or the return to the floor on this host. The granted run remains owed.

### Gates by slice

S0 to S3 results and bundle sizes below are copied from the plan's execution
notes. S4 repeated the desktop suite through the requested guard command,
as listed separately; it did not re-derive bundle sizes.

| Slice | Gate output                                                                                                                                                                                                                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0    | `pnpm test:scripts`: 2,568 passed, 0 failed, 1 skipped; focused gate 31/31. `pnpm smoke:system-audio`: SKIPPED for the missing grant, as above.                                                                                                                                                                               |
| S1    | Typecheck and format check passed. Lint: 0 errors, the existing `captureConfig` effect dependency warning. Desktop tests: 524 files, 5,470 passed, 1 skipped; focused tests 75/75. Remote surface and phone projection tests passed unchanged.                                                                                |
| S2    | Typecheck, format check, build and `check:renderer-assets` passed. Lint: 0 errors, the existing `captureConfig` warning. Desktop tests: 524 files, 5,481 passed, 1 skipped.                                                                                                                                                   |
| S3    | Typecheck, format check, build and `check:renderer-assets` passed. Lint: 0 errors, the existing `captureConfig` warning. Desktop tests: 524 files, 5,486 passed, 1 skipped.                                                                                                                                                   |
| S4    | `pnpm format:check` and explicit Markdown Prettier check passed. All four comparison builds and the final restored-S3 build passed. The requested copy/style guard command ran the full desktop suite: 524 files, 5,486 passed, 1 skipped, including 6 copy and 24 style guards. All four CPU attempts failed; details below. |

S4 changes documentation only. It changes no product code, vendored audiocn
files, scripts or backend files. The plan does not require
`smoke:recording-studio` for these slices because they keep the existing
capture, processing, mixing and encoding paths.

### Renderer bundle

| Build         | Eager JS raw bytes | Eager JS gzip bytes | Entry gzip bytes |           Studio section raw |
| ------------- | -----------------: | ------------------: | ---------------: | ---------------------------: |
| S1 `81ebc5e6` |          1,972,397 |             396,471 |          180,196 | `microphone-section` 6.82 kB |
| S2 `d931105f` |          1,972,336 |             396,448 |          180,173 |     `audio-section` 13.97 kB |
| S3 `13060516` |          1,972,275 |             396,407 |          180,130 |     `audio-section` 14.02 kB |

At S2, `audio-section` is 3.9 kB gzip. Rollup split out a shared `mixer`
chunk, 26.46 kB raw / 6.6 kB gzip, used by Sources and the Studio; the
`sources-tab` chunk fell from 56.57 to 44.04 kB raw. S3's 14.02 kB
`audio-section` includes the Retro Audio view. Eager JS shrank by 64 gzip
bytes from S1 to S3.

## CPU comparison

Detached-HEAD order: main, S3, main, S3, with `pnpm build` after every
switch. The first run prebuilt the backend with
`VIDEORC_SMOKE_PREBUILD_TIMEOUT_MS=3600000`; it completed without a prebuild
timeout. Later runs reused that build:

```sh
env -u ELECTRON_RUN_AS_NODE VIDEORC_SMOKE_SKIP_PREBUILD=1 VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS=1 pnpm smoke:preview-performance
```

The first command omitted `VIDEORC_SMOKE_SKIP_PREBUILD=1`. All attempts
kept gate mode and the required live Studio microphone assertion. Default
sampling was 8 seconds warm-up, then 30 seconds at 1-second intervals.
S3 was restored with `git switch --detach 13060516` and `pnpm build`
after the series.

Clips was left at its default On; this preview smoke does not independently
assert that its ring is running. This dev app has no Screen Recording grant,
so System audio could not be On and its meter could not run live. These
attempts cannot establish the second live meter's cost, or complete the
plan's CPU acceptance. The smoke uses the default look; it does not enable
Retro LCD.

| Run    | Commit     | Renderer CPU avg | Renderer CPU p95 | GPU process CPU avg | GPU process CPU p95 | Gate                                            |
| ------ | ---------- | ---------------: | ---------------: | ------------------: | ------------------: | ----------------------------------------------- |
| main 1 | `0438849f` |            9.70% |           23.00% |               0.00% |               0.00% | FAIL: fallback and wire rate                    |
| S3 1   | `13060516` |            7.75% |           11.90% |               0.18% |               0.00% | FAIL: wire rate                                 |
| main 2 | `0438849f` |      Unavailable |      Unavailable |         Unavailable |         Unavailable | FAIL: eval-js timeout; no samples               |
| S3 2   | `13060516` |      Unavailable |      Unavailable |         Unavailable |         Unavailable | FAIL: end geometry and mic idle; no CPU summary |

Percentages are the report's process CPU summaries, not GPU utilization.
The first pair reports a mounted, live microphone in `monitoring` state.
The second pair has empty CPU summary objects: main timed out before
sampling; S3 failed its end-geometry check before the summaries were built.
Unavailable readings are not zero. All four commands exited 1. No assertion
was relaxed, and no unrelated failure was investigated or retried.

### Failure output and reports

Reports are local, git-ignored JSON under
`docs/acceptance/artifacts/performance/`; no generated evidence is committed.

main 1 (`detached-native-preview-2026-10-27T08-17-44-172Z.json`):

```text
explicit fallback did not resume the visible Electron proof surface: {"exists":true,"visible":true,"animationSuspended":false,"bounds":{"clipHeight":540,"clipWidth":960,"clipX":276,"clipY":171,"height":540,"scaleFactor":2,"screenHeight":982,"screenX":276,"screenY":171,"visible":true,"width":960,"orderAboveWindowId":40294,"elevated":false},"placement":{"visible":true,"rect":{"x":276,"y":171,"width":960,"height":540}},"transport":"native-surface","backing":"cametal-layer"}
unfiltered WebSocket wire rate 82.06KiB/s exceeded 80KiB/s
```

S3 1 (`detached-native-preview-2026-10-27T08-20-01-809Z.json`):

```text
unfiltered WebSocket wire rate 83.58KiB/s exceeded 80KiB/s
```

main 2 (`detached-native-preview-2026-10-27T08-24-36-551Z.json`):

```text
eval-js timed out after 180000ms
Studio live microphone visualizer did not remain active through measurement (meter state: none)
detached preview geometry: beforeWarmup captured 0/5 required stable geometry samples
detached preview geometry: measurementStart captured 0/1 required stable geometry samples
detached preview geometry: measurementEnd captured 0/5 required stable geometry samples
performance wall-clock sampling evidence was missing
frame progress was 0; expected more than zero frames
preview transport was missing; expected native-surface
preview backing was missing; expected cametal-layer
```

S3 2 (`detached-native-preview-2026-10-27T08-42-46-405Z.json`):

```text
Detached preview geometry measurementEnd failed: preview content was 910x512; expected 960x540; native surface was 910x512; expected 960x540
Studio live microphone visualizer did not remain active through measurement (meter state: idle)
detached preview geometry: measurementEnd captured 1/5 required stable geometry samples
detached preview geometry: measurementEnd: preview content was 910x512; expected 960x540; native surface was 910x512; expected 960x540
detached preview geometry: measurementEnd sample 1 was not valid detached native geometry: preview content was 910x512; expected 960x540; native surface was 910x512; expected 960x540
performance wall-clock sampling evidence was missing
frame progress was 0; expected more than zero frames
preview transport was missing; expected native-surface
preview backing was missing; expected cametal-layer
```

## Owed by the owner

- The granted `pnpm smoke:system-audio` run, including `clips-idle`:
  ring session ids, tone readings, the 12 dB ± 2 dB gain drop and the return
  to the floor.
- The dev-app Sources idle meter check with Clips on and System audio On:
  play music and confirm that the level moves and follows Gain.
- By-eye acceptance and shots in both looks (default and Retro LCD), both
  themes, at the narrowest inspector width: idle with Clips on and off,
  muted, recording, live, permission missing and echo pause. Check both
  meters and their faders, mute and its hotkey, the System audio switch,
  disabled reasons, Resume, the Clips-off line, and Screen/Camera with Open
  Sources in the Sources mirror. No screenshots or media are committed.
- D5: decide whether the shared LCD-skinned Gain faders read right in both
  themes. S3 uses `LCD_FADER` inside the Audio screen; the owner's fallback
  remains an LCD value row with step buttons, keyboard arrows and
  double-click reset if the faders read wrong.
- A granted CPU comparison with Clips on and System audio On, two
  interleaved runs each of `0438849f` and the final branch, with both
  meters live. The owner judges the second meter's cost.
