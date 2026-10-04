# Plan 148: Diagnose legacy recording startup admission

## Status

P1. Source repair verified locally; complete runtime acceptance is in progress. Pre-repair full matrix on source-equivalent main `cabc32bf` finishes **17/18**; no aggregate acceptance claimed.

## Frozen failure and hypotheses

4K60 session `7abb6d9c-d2c2-4bec-b731-28e00c527029` contains 350 distinct frames / 5.833 seconds, below the unchanged 5.88-second minimum. Cadence is 60 fps, keyframes occur every two seconds, and A/V tail difference is 31 ms. The prior five-frame queue stall is gone. All other 17 cases pass, including hard-content and shared-pressure artifacts.

The session reports Running after 7 ms at16:17:45.049869UTC; first positive FFmpeg media time0.200 arrives at16:17:45.574088UTC, approximately524ms later. Stop is requested at16:17:51.050516UTC; final retained FFmpeg clock is5.800seconds. Legacy startup creates no output-startup receiver, marks muxer progress immediately, and drains its preview stdout only after publication. These facts identify a missing readiness proof, but do not alone establish the duration shortfall's entire cause.

Ranked hypotheses: early Running admission (an explicitly held FFmpeg initialization must remain Starting; delaying initialization should expose false admission and reduce duration), sustained below-real-time encoding (warm media-clock increments remain below wall time), or Stop/export truncation (the original MKV or final clock contains duration absent from MP4). Preserve the original failed cohort; change one variable per probe.

## Feedback loop and scope

Use an exec-preserving FFmpeg shim outside Git with an explicit loopback readiness/release channel. The owned PID stays identical before and after exec; no shell-wrapped grandchild or temporary-file readiness handshake. Hold only the actual legacy4K60 command, inspect the real backend status while no media can exist, then release initialization and let the original maintained six-second smoke finish. Any deliberate startup delay is a stress input, not evidence of readiness. Retain the original MKV through a read-only descriptor if needed.

A supported repair must have a regression at the real startup call site, preserve all startup/stop deadlines and profile/quality gates, start stdout draining before any readiness wait, and retain existing VideoToolbox bridge admission/latency behavior. Run relevant cancellation/reader cleanup controls, full source gates, the original profile matrix, recording latency, recording-studio/device and complete local bundle after all source fixes. Windows asynchronous ownership checks require the actual25filter/three-full PowerShell evidence where affected. Never lower the duration threshold or extend the recording solely to get a green artifact.

Private evidence:`/Users/orcdev/projects/videorc-qa-evidence-20261004/full-matrix-fixed/`. Plans146/147 retain the separate queue repair and original intermittent shared stop failure.


## Actual gated RED

The first private fixture incorrectly calls `session.status`; that attempt is invalid, applies no controlled delay, and cannot establish a product result. The corrected real `recording.status` probe sees **recording before FFmpeg exec**, holds initialization500ms through explicit PID/parent-PID/nonce readiness, then completes the original smoke with342frames/5.699seconds (FAIL). The retained original MKV is342frames/5.700seconds, excluding export as the cause in this reproduction. Controller96656, backend96803 and owned FFmpeg96954 complete maintained teardown. The final fixture also records renderer Starting events: the status-query endpoint represents uncommitted Starting as idle, so admission asserts no Recording/Streaming before media, with Starting proven by its actual event. This does not change the original duration/keyframe gates.

The source correction reuses the existing8-second positive-output proof for legacy capture, starts preview draining before waiting, and assigns the reader to startup rollback until successful commit. VideoToolbox bridge deferral and all deadlines remain unchanged. Existing maintained matrix coverage is the end-to-end regression; explicit gated evidence remains outside Git. Startup owner controls now check that commit retains its reader and rejection actually drops the future. Verification is in progress.


Independent post-teardown probes find all four explicitly recorded controller, Electron, backend, and exec-preserved FFmpeg PIDs absent in the corrected RED. No unrecorded descendant cleanup or broad process signalling occurs. Preview task commit/rejection controls use explicit task-entry and future-drop channels, with bounded waits; no sleep/file handshake is introduced.

## Corrected GREEN and verification

The first GREEN fixture uses a Node EventEmitter listener on an EventTarget WebSocket and fails before completing its observation. It is invalid product evidence. Its two explicitly recorded live Electron/backend PIDs are closed through the authenticated maintained `app-quit` command; both are independently absent afterward. The private fixture uses the documented listener API and retains its controller spawn receipt before the next run.

The corrected probe holds the same actual FFmpeg initialization for 500 ms. Backend status remains idle while the actual status event reports Starting; Recording occurs only after release. The unchanged 4K60 smoke passes **6.583 s / 395 distinct frames / 60 fps**, four keyframes with a two-second maximum interval, BT.709/video range, H.264 level 5.2 and 13 ms A/V tail. The original MKV is retained privately. Controller 21699, Electron 21832, backend 21837 and exec-preserved FFmpeg 21886 are independently absent after normal teardown. Evidence: `/Users/orcdev/projects/videorc-qa-evidence-20261004/legacy-startup-green-corrected/`.

Focused recording tests pass 386 / three ignored. Full Rust passes 3,080 / 13 ignored, including the existing startup failure, cancellation and stderr controls. Strict Clippy, Rust fmt, TypeScript format/lint (one existing warning), both advisory audits, typecheck, build and unchanged renderer asset budgets pass. The complete local bundle is running on this source; matrix, latency, recording-studio/device and unshortened 60-minute preview / 15-minute recording soaks remain pending. No complete-bundle or all-platform PASS is claimed.
