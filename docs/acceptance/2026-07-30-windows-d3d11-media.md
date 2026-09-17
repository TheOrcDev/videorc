# 2026-07-30 Windows D3D11 media qualification

## Status

**BLOCKED — the D3D11 source path and fail-closed evidence tooling are
implemented. Portable/macOS verification and an x86_64-pc-windows-msvc xwin
compile check pass on the frozen source commit. The physical Windows source
lane, signed candidate, GPU/OBS/presenter/performance matrices, active budget,
and natural-fallback evidence remain unavailable; no release or OBS-parity
claim exists.**

This record tracks Plan 040 without turning source-level or cross-compiled
checks into hardware evidence. The D3D11 path may not be promoted, published,
or described as OBS-parity qualified until the signed-candidate matrix below
has produced retained PASS evidence.

## Candidate identity

- Source commit: `f2eaaf253a0502e68b42720f18d693f2f95ad529`
- Installer SHA-256: not built
- Installed `Videorc.exe` SHA-256: not built
- Packaged-app payload SHA-256: not built
- Active D3D11 performance-budget SHA-256: unavailable

Any product, packaged-resource, executable-gate, installer, or installed-app
digest change after physical evidence begins invalidates that evidence.

## Source implementation and portable evidence

The frozen source commit contains:

- a generation- and adapter-bound D3D11 media authority and lease model;
- bounded D3D11 capture/compositor texture leases and deterministic GPU
  fixtures;
- a separate Media Foundation NV12 DXGI-surface input contract;
- trusted Electron-main HWND normalization and renderer redaction;
- platform-aware Metal/D3D11/proof preview claims;
- exact staged Windows-only Rust discovery;
- strict D3D11 budget, natural-fallback, three-host merge, support-bundle, and
  public-acceptance contracts with failure-atomic PASS publication; and
- a protected OBS side-by-side runner that binds the signed process, display,
  audio endpoint, stimulus, loopback RTMP target, artifacts, A/V, process tree,
  GPU samples, and D3D11 invariants.

The following verification was run on the source state frozen by the commit
above:

| Command / gate                                                                | Result                                                                  | What it proves                                                                                        |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm test:scripts`                                                           | PASS — 1,009 tests across 185 suites                                    | Portable evidence schemas, runners, candidate binding, immutable publication, fallback, and artifacts |
| `pnpm --filter @videorc/desktop test`                                         | PASS — 1,322 tests across 147 files; one pre-existing skip              | Desktop protocol, lifecycle, renderer, and main-process contracts                                     |
| `cargo test -p videorc-backend`                                               | PASS — 1,521 tests in total; eight ignored                              | Backend implementation and lifecycle contracts                                                        |
| Rust format/check/clippy; TypeScript typecheck/lint/format; desktop build     | PASS                                                                    | Native and desktop static/build gates                                                                 |
| `cargo xwin check -p videorc-backend --target x86_64-pc-windows-msvc --tests` | PASS — compile-only                                                     | Windows-only Rust bodies cross-compile; this is not physical execution                                |
| `pnpm probe:preview-lifecycle`; `pnpm probe:preview-window`                   | PASS — 100/100 cycles and full placement/dock/occlusion flow            | macOS preview lifecycle regression                                                                    |
| `pnpm smoke:comment-highlight-stream`                                         | PASS — stream-only, split record/stream, and legacy RTMP artifacts      | Viewer-facing comment highlight and caption coexistence                                               |
| `pnpm smoke:recording-matrix`                                                 | PASS — 12/12, including hard-content 1080p60 and 4K30                   | Shipping profile, color, level, cadence, stop-tail, and bridge-pressure contracts                     |
| `pnpm smoke:recording-studio`                                                 | BLOCKED after gates 1-24 passed — no authorized ScreenCaptureKit source | Maintained non-device gates passed; physical macOS screen/Notes gates could not execute               |
| `pnpm smoke:recording-studio:devices`                                         | NOT RUN — BLOCKED by the same missing native screen permission/source   | No real-device qualification claim                                                                    |

The xwin check does not run a Windows binary or replace the protected physical
x64 Windows test/clippy lane. None of these results exercises a Windows GPU,
presenter HWND, encoder MFT, signed executable, installed app, or OBS workload.
All physical rows therefore remain BLOCKED.

## Required physical Windows evidence

| Evidence                                    | Required result                                                                                | Current state                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Signed/private installed candidate identity | One source/installer/app/payload identity                                                      | BLOCKED — candidate not built                                               |
| `nvidia-turing-floor` OBS comparison        | 3 OBS + 3 Videorc runs, PASS                                                                   | BLOCKED — physical host required                                            |
| `intel-xe-integrated` OBS comparison        | 3 OBS + 3 Videorc runs, PASS                                                                   | BLOCKED — physical host required                                            |
| NVIDIA D3D11 profile matrix                 | Exactly 1080p30/60, PASS                                                                       | BLOCKED — physical host required                                            |
| Intel D3D11 profile matrix                  | Exactly 1080p30/60, PASS                                                                       | BLOCKED — physical host required                                            |
| Natural unsupported host                    | 1080p30 non-OBS-parity fallback policy, PASS                                                   | BLOCKED — natural fallback host required                                    |
| D3D11 performance budget                    | Derived from retained physical comparison/calibration evidence, independently reviewed, active | BLOCKED — physical comparison and calibration evidence unavailable          |
| Forced-path manifests                       | NVIDIA + Intel PATH_PASS                                                                       | BLOCKED                                                                     |
| Automatic-default manifests                 | NVIDIA + Intel PATH_PASS without selection variables                                           | BLOCKED                                                                     |
| Natural-fallback manifest                   | One 1080p30 PATH_PASS                                                                          | BLOCKED                                                                     |
| Three host manifests                        | NVIDIA + Intel + fallback HOST_PASS                                                            | BLOCKED                                                                     |
| Deterministic aggregate                     | Aggregate PASS                                                                                 | BLOCKED                                                                     |
| Preview lifecycle/placement                 | D3D11 triple, zero BMP, click/focus continuity                                                 | BLOCKED — physical Windows required                                         |
| Windows source lane                         | Exact D3D tests + full Rust + clippy                                                           | BLOCKED — xwin compile-only passed; physical Windows x64 execution required |

Supported-host evidence must prove all of the following, not merely a
“hardware encoder” label:

- one capture/compositor/presenter/MFT adapter LUID and generation;
- zero capture readbacks, compositor CPU fallback frames, raw-video copies,
  encoder system-memory samples, and BMP requests/bytes;
- positive D3D11 texture imports, preview presents, and encoder GPU samples;
- bounded pools with no unexpected pressure, reset, mismatch, timeout, or
  fallback;
- correct cursor pixels and bounded shape uploads;
- Electron click, drag, keyboard focus, and controls remain reachable through
  the presenter; and
- Win32 message dispatch p95 is at most 50 ms and maximum is at most 100 ms
  while media cadence continues to pass.

## macOS regressions on the same source commit

| Gate                                  | Current state                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm smoke:recording-studio`         | Gates 1-24 PASS; BLOCKED at real ScreenCaptureKit because no source is exposed |
| `pnpm smoke:recording-studio:devices` | NOT RUN — BLOCKED by the same missing native screen permission/source          |
| `pnpm smoke:recording-matrix`         | PASS — 12/12                                                                   |

The ScreenCaptureKit recording and Notes-window gates were each attempted and
reported the same explicit missing-native-screen blocker. The maintained
synthetic/artifact, comment-highlight, preview-surface, lifecycle, placement,
and interaction gates all passed before that blocker.

## Evidence hashes

- NVIDIA OBS comparison: unavailable
- Intel OBS comparison: unavailable
- NVIDIA host manifest: unavailable
- Intel host manifest: unavailable
- Natural-fallback host manifest: unavailable
- Aggregate manifest: unavailable

No placeholder hash, forced-failure injection, portable test, or macOS result
may replace these physical Windows artifacts.
