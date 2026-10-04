# Plan 121: Diagnose native preview scene update budget failure

Discovered during the independent remainder of final recording-studio QA on clean main `812ba01a7dfe59f30b823aaace0f25ed95059002`, 2026-10-03 UTC. Priority P1; effort M; risk MED. Cause unassigned; preserve the unchanged gate.

## Observed failure

The maintained detached native preview surface reattach smoke exits1 with **Native preview scene update took50.2ms, expected<=50ms.** It runs with the exact recording-studio environment: minimum30fps, maximum interval p95=120ms and maximum input-to-present p95=100ms. The stage stops at its separate50ms scene-update assertion. Do not claim that unexecuted later source/reattach/frame gates pass, or diagnose a transport/freshness defect from this one elapsed time.

Log: `/tmp/videorc-fixes-final-independent-smoke-preview-surface.log`; serial step report: `/tmp/videorc-fixes-final-evidence-20261003/recording-studio-independent-remainder.json`. The parent recording-studio aggregate already failed at Plan120 and remains failed. Independent scene commits, pump diagnostics, click/focus, native interaction stress,100 lifecycle cycles and placement/docked-stick probes pass before this separate failure. No competing local QA compiler/test/media workload runs during measurement.

## Ordered work

1. Preserve the exact command, clean source, active scene/assertion and owned teardown evidence. Identify which part the50ms measurement includes and which backend/renderer/native publication owns it; compare existing bounded diagnostics without printing credentials or user state.
2. Run bounded fresh repetitions after the current serial queue finishes, retaining every failure and original thresholds. Separate deterministic state/ownership disagreement from timing variation. Do not introduce retry-to-green, settle sleeps, fixture simplification or threshold increases.
3. If the source cause is attributed, demonstrate meaningful failing-before coverage for that boundary and review a minimal repair. Otherwise record the unresolved measurement and propose the smallest bounded diagnostic slice needed to distinguish it.
4. Focused gates and root review precede a separate fix commit/push/normal PR merge with Shadscan37. Run applicable native-preview/recording/lifecycle/device gates after the source batch. Complete acceptance requires the unchanged maintained assertions or an explicitly documented blocker.

## Done criteria

- [x] Exact measured caller/owner and scene are established.
- [x] Repetition/diagnostics attribute the failure or define the remaining evidence gap.
- [ ] Any demonstrated source defect has a failing-before regression and scoped correction.
- [ ] Final native surface and broader acceptance results preserve original failed evidence.

Do not conflate this scene-update budget with Plan107's input-to-present measurement or Plan117's intermittent main-window owner loss.

## Exact measurement owner

Main's `exercise-native-preview-scene` first awaits `updateNativePreviewSurfaceCompositor(firstStatus)` outside the timing window. It then times one detached `webContents.executeJavaScript` round trip: serialize/set revision2/camera left62%, set compositor proof status, consume the proof-status wrapper and its metrics, synchronously inspect DOM/revision metrics and return to main. The wrapper does not invoke the native driver. The50.2ms measurement includes serialization, renderer scheduling/IPC, JS work and main continuation; it is not direct frame-presentation timing. Prior revision2/compositor equality/layer-count/camera-placement assertions passed before the timing failure. The smoke subsequently aborts before background/reattach/FPS/resize assertions and performs its maintained owned app teardown. Source owner: `apps/desktop/src/main/index.ts` near9940 and `scripts/smoke-preview-surface-app.mjs` near442. No production source cause is established by that scope alone.

Independent read-only review identifies two metrics snapshots in the timed script; they sort percentiles over arrays bounded at900 samples. That is identifiable work, not a proven stall. Existing native driver/helper/pump counters do not partition this renderer round trip. After the source queue, predeclare **five fresh exact maintained trials**, preserving all results and the original50ms/30fps/120ms/100ms limits. If still unattributed, add only bounded smoke-command stage timings and persist sanitized results before assertion: main serialization, renderer scene/status/wrapper/DOM work, renderer total and unchanged main total. A large unmeasured remainder narrows transport/scheduling but cannot distinguish renderer queueing from main continuation delay without further evidence. Do not remove either snapshot or call a later pass cause attribution.

## Five predeclared current-main trials

All five fresh exact maintained trials pass, exit0, on clean main `1b50883d677a242b19972493dfd670b474c1bfaa`, with the original50ms/30fps/120ms/100ms gates unchanged. Scene-update times are **0.870/1.139/0.957/0.939/1.339ms**; every trial passes later surface-loss/reattach, first-frame, resize, move/restore and automated native-surface assertions, with zero measured blank frames. No retries of failed measurement or early stop on GREEN are introduced. The existing launcher readiness policy is unchanged. Separate private report/log roots are `/tmp/videorc-plan121-main1b50883d-trial{1..5}-20261004/`. The exact five-result projection is retained in the final batch manifest.

These current-main passes do not attribute the original50.2ms failure. The remaining evidence gap is a bounded per-stage partition of that same round trip when the rare slow result occurs. No production optimization or timing-budget change is justified by the current measurements. Proposed smoke-only stage timings remain a diagnostic continuation if the failure recurs. Maintained by-eye hand-wave/screen-scroll checks are separately pending operator, and broader app/device acceptance is still running. Original failed evidence remains retained.
