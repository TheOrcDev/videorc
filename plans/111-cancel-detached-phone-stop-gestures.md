# Plan 111: Cancel Phone remote stop gestures when their control is retired

> Fix plan only. Planned at `05ff9188`, 2026-10-03, release 0.9.129. Drift check: `git diff --stat 05ff9188..HEAD -- crates/videorc-backend/remote_web/app.js crates/videorc-backend/remote_web/remote-client.js apps/desktop/src/renderer/src/lib/phone-remote-view.test.ts`.

Implementation should start from release 0.9.129 (`05ff9188`) or newer main in an isolated worktree. Preserve the original checkout's existing user changes, and perform the drift check before editing.

- Priority: P1; a stop timer can survive an early pointer release
- Effort: S–M
- Risk: MED; preserve the intentional hold guard and confirmed-state behavior
- Depends on: none
- Category: correctness / gesture lifecycle
- Confidence: HIGH for detached timer ownership; physical mobile pointer behavior needs verification

## Execution status

Source repair merged as `5a81d166` in [PR 545](https://github.com/TheOrcDev/videorc/pull/545), main `c9049f8c`. Forty-four focused DOM/protocol tests and TS checks passed; Shadscan 37. Gesture ownership is preserved across irrelevant redraws and retired on session/action/lifecycle changes. Real app/LAN E2E and physical browser pointer behavior remain pending; DOM evidence does not establish physical-phone acceptance.

## Failure and reproduction

The production Phone remote page builds Stop recording/End stream buttons with a 700 ms hold timer. `renderDeck` replaces all main deck children whenever a remote state or highlight update arrives. An in-flight timer belongs to the old button, but replacing that button never cancels it. A release reaching the current button does not reach the retired button's cancel handler.

An exploratory happy-dom probe executed the actual `remote_web/app.js` DOM code and HTML with only the transport replaced by a local fake. With no redraw, pointerdown then pointerup after 100 ms correctly sent no intent. With a microphone-state update between those events, the old button became disconnected, the release on the new Stop button happened at 100 ms, and the old timer still sent `{ kind: recordStop }` at 700 ms. The expected no-stop assertion failed. Evidence: `/tmp/videorc-qa-phone-hold-probe.log` and temporary probe `/tmp/videorc-qa-phone-hold-probe.mjs`. No actual session was stopped.

This proves a detached timer in the real page code under the stated DOM event sequence. It is not yet a physical Safari/Chrome pointer-capture reproduction: those browsers may route removal/cancel events differently. Preserve the control case and verify those event routes before claiming every phone has the same symptom.

## Current state and scope

`crates/videorc-backend/remote_web/app.js::key` around line 229 starts the timer on pointerdown and cancels only on that node's pointerup/pointerleave/pointercancel. There is no retirement/disposal hook. `renderDeck` around line 273 invokes `deck-main.replaceChildren` around line 319. Remote state events and highlight events call it around lines 409 and 420. `send` uses `RemoteClient.intent`, which already resolves transport/admission/ack failures as `{ ok: false, message }`; do not duplicate or alter that protocol behavior.

In scope: hold gesture ownership, deck control identity/disposal, page visibility/disconnect cleanup and meaningful page integration tests. Out of scope: shorter hold thresholds, automatic Stop on disconnect, new LAN routes/events, auth/key storage changes, speculative session-target protocol fields, backend recording semantics and replacing the remote page framework.

Follow the current plain ESM DOM style. Prefer a small disposable gesture owner or stable keyed controls; a general renderer rewrite is unnecessary. Add page integration coverage under the existing desktop Vitest/happy-dom test infrastructure, for example `apps/desktop/src/renderer/src/lib/phone-remote-page.test.ts`, loading the actual remote HTML/app module with a mocked RemoteClient. Use the existing phone-remote-view and component tests for conventions. If a pure helper is extracted, its tests must complement the actual-page regression rather than mirror its implementation.

## Ordered work and verification

1. Reproduce both the stable control and redraw case with fake timers in the actual page integration test. Cover unrelated microphone/system-audio/highlight updates, release before 700 ms, pointercancel, pointerleave, repeated pointerdown and switching session mode. Record browser pointercancel/lost-capture routes on iOS Safari and Android Chrome using the same state-update scenario; no real external broadcast is necessary. Run the focused desktop tests; the detached timer case must fail before the fix.
2. Give every hold a bounded owner. Replacing/retiring a control, losing the relevant session/connection, hiding the page or cancelling its gesture must clear that owner's timer. Either preserve the control and its correct release path across unrelated state updates or dispose it explicitly before replacement. A retired closure must never send a Stop against a later session. Keep the 700 ms hold and backend-confirmed display state, and show refusals through existing snack copy.
3. Run the focused regression, full desktop tests, TS typecheck/lint/format and Node script tests. Run required `pnpm smoke:remote-lan` and `pnpm smoke:remote-control`. Verify the live browser page against an isolated app: short tap never stops, a continuous valid hold sends exactly one Stop, unrelated state updates do not create an orphan gesture, and disconnect/revoke/visibility cancel pending holds. Use local recording only and analyze its final artifact when testing Stop.

## Done and STOP criteria

- [x] The early-release redraw sequence sends no Stop, including a disconnected old node.
- [x] A valid uninterrupted hold sends exactly one intended Stop after the existing threshold.
- [x] Disposal, disconnect, visibility loss, pointercancel and session replacement leave no active gesture timer.
- [ ] Actual Safari/Chrome behavior is recorded separately from DOM-model evidence; any unavailable device is explicitly blocked.
- [x] LAN auth/allowlist/credential isolation and remote confirmed-state intent smoke contracts still pass.

Stop if an observed browser event route contradicts the modeled sequence; document it and keep a regression for the actual route rather than changing the hold threshold. Future deck redraws must explicitly preserve or dispose active gesture owners.

## Current model evidence and browser scope

Current production JS CI head570334b7/job111326363846 passes the actual-page happy-dom module23 cases and remote-view4 cases as part of full desktop2851/one existing skip. The actual module tests preserve the700ms hold, exercise disconnected controls, valid exactly-once holds, session/action replacement, redraw, pointercancel/leave, visibility and disconnect cleanup. These checked criteria refer to the existing actual-page DOM model. They do not prove physical Safari/Chrome pointer dispatch.

Maintained `smoke:remote-control` and `smoke:remote-lan` both exit0 in the main2f999dac local aggregate before its later unrelated fake-provider comparison failure. Confirmed-state intents, allowlist/auth/credential isolation, signed pairing, revoke and disable contracts pass. Remote page/renderer/LAN source bytes remain unchanged through main8dd2aa9d. Separate live desktop-browser checks remain pending; no physical iOS/Android device is available.
