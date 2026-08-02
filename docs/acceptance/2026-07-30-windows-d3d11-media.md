# 2026-07-30 Windows D3D11 media qualification

## Status

**BLOCKED — source implementation is in progress and one interim portable
contract suite passes; no final Windows source-lane, physical Windows
qualification, installed candidate, or release claim exists.**

This record tracks Plan 040 without turning source-level or cross-compiled
checks into hardware evidence. The D3D11 path may not be promoted, published,
or described as OBS-parity qualified until the signed-candidate matrix below
has produced retained PASS evidence.

## Candidate identity

- Source commit: pending final implementation commit
- Installer SHA-256: not built
- Installed `Videorc.exe` SHA-256: not built
- Packaged-app payload SHA-256: not built
- Active D3D11 performance-budget SHA-256: unavailable

Any product, packaged-resource, executable-gate, installer, or installed-app
digest change after physical evidence begins invalidates that evidence.

## Source implementation and portable evidence

The implementation branch currently contains source contracts and in-progress
runtime integration for:

- a generation- and adapter-bound D3D11 media authority and lease model;
- bounded D3D11 capture/compositor texture leases and deterministic GPU
  fixtures;
- a separate Media Foundation NV12 DXGI-surface input contract;
- trusted Electron-main HWND normalization and renderer redaction;
- platform-aware Metal/D3D11/proof preview claims;
- exact staged Windows-only Rust discovery;
- strict D3D11 budget, natural-fallback, three-host merge, support-bundle, and
  public-acceptance contracts; and
- a protected OBS side-by-side runner that binds the signed process, display,
  audio endpoint, stimulus, loopback RTMP target, artifacts, A/V, process tree,
  GPU samples, and D3D11 invariants.

Runtime wiring and the final source verification sweep are still underway.
The following command was run from the working implementation tree on
2026-07-30:

| Command                                                                                                                                                | Result                     | What it proves                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------- |
| `node --test scripts/lib/windows-d3d11-media.test.mjs scripts/lib/windows-stream-performance.test.mjs scripts/lib/windows-performance-budget.test.mjs` | PASS — 81 passed, 0 failed | Pure evidence-schema, runner-policy, matrix, budget, fallback, and fail-closed contracts |

This interim PASS is not tied to a final source commit and must be rerun before
handoff. It does not compile the `cfg(target_os = "windows")` Rust bodies and
does not exercise a GPU, presenter HWND, encoder MFT, signed executable, or
installed app. Windows x64 Rust discovery, the full backend suite, clippy, and
all physical rows remain BLOCKED. No cross-compiled or physical PASS is
recorded in this note.

## Required physical Windows evidence

| Evidence                                    | Required result                                                                                | Current state                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Signed/private installed candidate identity | One source/installer/app/payload identity                                                      | BLOCKED — candidate not built                                      |
| `nvidia-turing-floor` OBS comparison        | 3 OBS + 3 Videorc runs, PASS                                                                   | BLOCKED — physical host required                                   |
| `intel-xe-integrated` OBS comparison        | 3 OBS + 3 Videorc runs, PASS                                                                   | BLOCKED — physical host required                                   |
| NVIDIA D3D11 profile matrix                 | Exactly 1080p30/60, PASS                                                                       | BLOCKED — physical host required                                   |
| Intel D3D11 profile matrix                  | Exactly 1080p30/60, PASS                                                                       | BLOCKED — physical host required                                   |
| Natural unsupported host                    | 1080p30 non-OBS-parity fallback policy, PASS                                                   | BLOCKED — natural fallback host required                           |
| D3D11 performance budget                    | Derived from retained physical comparison/calibration evidence, independently reviewed, active | BLOCKED — physical comparison and calibration evidence unavailable |
| Forced-path manifests                       | NVIDIA + Intel PATH_PASS                                                                       | BLOCKED                                                            |
| Automatic-default manifests                 | NVIDIA + Intel PATH_PASS without selection variables                                           | BLOCKED                                                            |
| Natural-fallback manifest                   | One 1080p30 PATH_PASS                                                                          | BLOCKED                                                            |
| Three host manifests                        | NVIDIA + Intel + fallback HOST_PASS                                                            | BLOCKED                                                            |
| Deterministic aggregate                     | Aggregate PASS                                                                                 | BLOCKED                                                            |
| Preview lifecycle/placement                 | D3D11 triple, zero BMP, click/focus continuity                                                 | BLOCKED — physical Windows required                                |
| Windows source lane                         | Exact D3D tests + full Rust + clippy                                                           | BLOCKED — final source state and Windows x64 source host required  |

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

| Gate                                  | Current state                                                     |
| ------------------------------------- | ----------------------------------------------------------------- |
| `pnpm smoke:recording-studio`         | BLOCKED — final source commit not available                       |
| `pnpm smoke:recording-studio:devices` | BLOCKED — final source commit and authorized device host required |

The ordinary Recording Studio gate is mandatory. Only the device variant may
retain an explicit permissions/hardware BLOCKED result.

## Evidence hashes

- NVIDIA OBS comparison: unavailable
- Intel OBS comparison: unavailable
- NVIDIA host manifest: unavailable
- Intel host manifest: unavailable
- Natural-fallback host manifest: unavailable
- Aggregate manifest: unavailable

No placeholder hash, forced-failure injection, portable test, or macOS result
may replace these physical Windows artifacts.
