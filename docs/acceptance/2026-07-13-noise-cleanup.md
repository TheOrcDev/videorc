# Noise Cleanup — acceptance, 2026-07-13

Scope: the Premium Noise Cleanup implementation in the desktop/backend repository
and the companion Premium-copy change in `videorcweb`, following the Obsidian plan
`2026-07-13 - Videorc Noise Cleanup Premium Feature Plan`.

This note records deterministic evidence separately from release-stage manual and
platform evidence. It intentionally contains no secrets, recordings, generated
media, usernames, or machine-local evidence paths.

## Product and safety contract

| Contract                    | Result | Evidence                                                                                                                                                                                                                                                                    |
| --------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Premium gate                | PASS   | `noise-cleanup` is an explicit Rust/TypeScript capability. Basic and missing snapshots fail closed; Premium and Developer pass. Backend authorization runs before durable work is created, and the old environment override cannot unlock a release build.                  |
| One-click Library action    | PASS   | The responsive direct action and matching kebab command cover upgrade, start, queued, processing, validating, cancel, retry, completed, derivative, reconnecting, and unsupported-session states. Intrinsic blockers resolve before the Premium upsell.                     |
| Local-only processing       | PASS   | The backend resolves the managed session path and bundled FFmpeg locally. No upload, provider credential, cloud-consent, quota, Creem product, or entitlement-database change was added.                                                                                    |
| Non-destructive derivative  | PASS   | Work stages beside a numbered destination, validates before publication, and inserts a managed `— Noise Cleaned` session with immutable source-title/provenance fields. The original is never overwritten.                                                                  |
| Exact media policy          | PASS   | MP4 uses AAC 192 kbps; MKV uses `pcm_s16le`; video and non-audio streams are copied. Unsupported containers, imported sessions, missing/unfinished/live sessions, test-tone sources, no-audio input, and ambiguous multi-audio input fail clearly.                          |
| Durable jobs                | PASS   | SQLite owns queued/processing/validating/completed/failed/cancelled state, active-job uniqueness, restart recovery, completed-result idempotency, bounded history, and missing/unavailable media reconciliation. Renderer navigation or row unmount does not own job truth. |
| Capture precedence          | PASS   | Full-file identity reads, FFprobe/FFmpeg work, validation, and publication checks all observe app-owned cancellation/capture-preemption state. Capture returns cleanup to queued; user cancellation is terminal.                                                            |
| Identity and path ownership | PASS   | Full SHA-256 plus sampled content and filesystem-object identity reject same-size and object replacements. Output naming reserves every Library-owned database path, including currently missing files, and unavailable volumes never cause derivative metadata deletion.   |
| Entitlement freshness       | PASS   | Focus, bounded signed-in polling, explicit refresh, and backend events update the renderer. The capability HTTP request has an 8-second request timeout inside the 10-second RPC deadline.                                                                                  |
| Marketing truth             | PASS   | Pricing, Premium, account, FAQ, CTA, metadata, and showcase copy promise one-click on-device cleanup with no upload or quota. Smart Zoom and Silence Removal remain experimental; free 4K recording and Basic single-destination streaming remain truthful.                 |

## Media proof

The versioned `speech-v1` preset is locked to
`afftdn=nr=18:nf=-34:tn=1`. The bundled macOS FFmpeg passed capability and
artifact preflight for `afftdn`, AAC, `pcm_s16le`, RTMP/TLS, and VideoToolbox.

| Artifact | Noise reduction | SNR gain | Voice-band delta | Duration delta | Video                              |
| -------- | --------------: | -------: | ---------------: | -------------: | ---------------------------------- |
| MP4      |          3.4 dB |   2.0 dB |           0.1 dB |         0.0 ms | Packet hashes match; stream copied |
| MKV      |          3.1 dB |   2.0 dB |           0.0 dB |         1.0 ms | Packet hashes match; stream copied |

Both sources remained byte-for-byte unchanged. Both outputs decoded, retained
audio, and passed the maintained final-artifact A/V analyzer. The smoke generates
its deterministic fixtures at runtime and commits no media.

Real backend integration also proves MP4 completion, MKV completion with
`pcm_s16le`, ambiguous-audio rejection, queued and running cancellation,
capture preemption/resume, restart recovery, changed-source rejection, and
identity-owned rollback.

## Gate record

| Gate                                 | Result                | Notes                                                                                                                                                                                                                                                  |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript typecheck / lint / format | PASS                  | Node 24 and pnpm 11; no warnings.                                                                                                                                                                                                                      |
| Desktop production build             | PASS                  | Main, preload, and renderer bundles built.                                                                                                                                                                                                             |
| Desktop tests                        | PASS                  | 127 files; 1,034 passed and one existing OBS-import test skipped.                                                                                                                                                                                      |
| Node script tests                    | PASS                  | 618/618 across 120 suites, including macOS/Windows FFmpeg capability and Noise Cleanup artifact assertions.                                                                                                                                            |
| JS production advisory audit         | PASS                  | No known production vulnerabilities found.                                                                                                                                                                                                             |
| Rust format / clippy                 | PASS                  | `cargo fmt --check --all`; clippy with warnings denied.                                                                                                                                                                                                |
| Rust tests                           | PASS                  | 48 native-preview-helper + 1,251 backend + 1 wire test = 1,300 passed; 8 ignored, 0 failed.                                                                                                                                                            |
| Bundled Noise Cleanup artifact smoke | PASS                  | MP4/MKV source immutability, objective metrics, stream-copy hashes, codec policy, duration, and A/V analysis passed.                                                                                                                                   |
| macOS package preflight              | PASS                  | Release backend/helper and universal native-preview addon built; bundled FFmpeg capability and artifact proof passed.                                                                                                                                  |
| Recording Studio aggregate           | PARTIAL / ENV BLOCKED | Steps 1–23 passed, including maintained Noise Cleanup, all-layout recording, imported-screen, captions, native preview lifecycle/window/surface, scene, focus, and stress gates. Step 24 stopped because this host exposes no ScreenCaptureKit source. |
| Notes-window real-screen smoke       | ENV BLOCKED           | Rerun separately; the same missing ScreenCaptureKit source blocked before capture.                                                                                                                                                                     |
| Companion web verification           | PASS                  | 305/305 tests, typecheck, build, and Vercel preview checks passed; lint has one unrelated existing contributors-image warning.                                                                                                                         |

The focused aggregate desktop suite printed one non-failing `window is not
defined` diagnostic from an upstream native-preview async callback after its
test completed. The full desktop suite, typecheck, lint, production build, and
the maintained native-preview smokes all passed; this is not attributed to
Noise Cleanup and is not silently represented as a clean log.

## Release-stage evidence still required

| Evidence                                | State   | Required proof                                                                                                                                                                                                                        |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real-voice listening panel              | BLOCKED | An owner must compare clean, noisy, gentle, selected `speech-v1`, and strong samples by ear and reject pumping, metallic speech, or clipped consonants. Objective evidence alone does not satisfy this row.                           |
| Windows native/package run              | BLOCKED | No Windows host or MSVC/Windows SDK is available here. A compile-only cross-check stopped in native dependencies because Windows C headers were absent; run the real Windows package preflight and MP4/MKV artifact smoke on Windows. |
| Desktop dark/light/narrow/keyboard pass | BLOCKED | Automated semantics, SSR accessibility, responsive-state, focusable-disabled-tooltip, and keyboard-native Button coverage pass. A human Electron sweep at both themes and narrow/wide widths remains required.                        |
| Real ScreenCaptureKit recording         | BLOCKED | The host has no discoverable native screen source. This does not block the local post-processing engine, but cross-feature recording acceptance remains explicit.                                                                     |

## Review verdict

The implementation is suitable for draft-PR review. Deterministic product,
authorization, persistence, media, macOS package, web-copy, and regression proof
is green. It is not yet a declaration of Windows parity, by-ear audio acceptance,
or final desktop visual acceptance; those rows must be completed before changing
the PR from draft or shipping the Premium promise to production.
