# Plan 110: Reject glass evidence obstructed by system dialogs

> Harness fix plan. Planned at `05ff9188`, 2026-10-03, release 0.9.129. Drift check: `git diff --stat 05ff9188..HEAD -- scripts/ui-glass-probe.mjs scripts/lib/float-glass-checks.mjs scripts/lib/glass-neutrality.mjs scripts/lib/glass-parity.mjs scripts/lib/app-launcher.mjs`.

Implementation should start from release 0.9.129 (`05ff9188`) or newer main in an isolated worktree. Preserve the original checkout's existing user changes, and perform the drift check before editing.

- Priority: P1; visual acceptance can report contaminated measurements
- Effort: S–M
- Risk: LOW; never dismiss/approve security prompts automatically
- Depends on: none
- Category: tests / evidence validity
- Confidence: HIGH; screenshots visibly include a macOS Keychain prompt

## Execution status

Harness repair merged as `d91a7cb7` in [PR 551](https://github.com/TheOrcDev/videorc/pull/551), main `ab980cc5`. The original capture/report regressions failed; 60 focused validity/oracle/float/neutrality/parity tests now pass, independently rerun by root. The exact generated Swift compiled against the local SDK without execution. TS checks, direct script format/syntax, diff checks and Shadscan 37 passed. Fresh before/after target/reference ownership is required, and uncertain/obstructed evidence invalidates the entire run in both report and gate modes. No security dialog action or production styling/API change occurred; thresholds are unchanged. Fresh unobstructed all-role/all-theme/floating acceptance is deferred until all fixes.

## Observed discrepancy and attribution

The first `pnpm probe:ui-glass` report passed all twelve base-region rows. A later `pnpm probe:ui-glass --gate --surfaces` exited 1 with four Notes/Captions base-region failures across dark/light; the main/chat floating tiers passed. The contact sheet clearly shows an Electron Keychain-access prompt over the test windows. The measured failed regions and reference captures are obstructed. This run is INVALID visual evidence; it does not prove product glass/contrast regressed, nor does it establish acceptance for the rows labeled PASS.

Evidence: `/tmp/videorc-qa-evidence-extra-20261003/11/glass/report.json`, `contact-sheet.png`, raw shots in the same directory, and `/tmp/videorc-qa-evidence-extra-20261003/11/run.log`. No password was entered and no Keychain permission granted. The computer-use tool refused access to SecurityAgent, so a user dismissal was requested. Preserve the invalid run and report its obstruction rather than discarding it silently.

## Current implementation and scope

`scripts/ui-glass-probe.mjs::shoot` around line 351 raises/positions a role over its controlled backdrop and captures pixels; `shootWithReference` around line 655 obtains reference captures. `measureNeutrality` around line 672 and `measureSurfaces` around line 570 assume those images belong to the unobstructed target. `evaluate` around line 858 applies material/transmission/contrast/theme/neutrality/parity thresholds without an obstruction-validity contract. The final contact sheet is currently the only evidence revealing this run's modal obstruction.

Follow maintained `scripts/lib/float-glass-checks.test.mjs`, `scripts/lib/glass-neutrality.test.mjs` and `scripts/lib/glass-parity.test.mjs` and the existing CGWindow oracle conventions in `scripts/lib/preview-interaction-stress.mjs`. An obstruction helper should be small/pure and accept window identity, z-order and sample rectangles; do not create a general desktop scanner or record arbitrary user window contents.

Execution preparation: the actual CGWindow reader lives in `scripts/smoke-preview-interaction-stress-app.mjs::startCgWindowOracle`; the library owns its interpretation/tests. The existing `raise-window` smoke reply already supplies `windowId` and bounds, so the probe can identify its exact target without a new production command. Use only the necessary window metadata transiently and retain the reduced validity diagnostics described below, without arbitrary window titles.

In scope: probe validity state, bounded preflight/per-shot intersection checks, focused tests, diagnostics and evidence labeling. Out of scope: lowering glass thresholds, changing product window colors based on contaminated samples, changing OS Keychain ACLs, entering passwords, approving prompts, disabling secure storage/encryption, broad process cleanup and automatically closing unrelated user windows.

## Ordered work and verification

1. Add failing-before fixtures for an unobstructed target, a system dialog intersecting a sampled/reference region, a non-intersecting dialog and a window behind the target. Verify that occlusion is distinguished from actual contrast/material failure. Run the affected Node tests and `pnpm test:scripts`.
2. Introduce a bounded validity check before capture and recheck when geometry or foreground ownership changes. Mark affected samples/run INVALID with only role, window-owner category, intersection and timestamp; retain raw evidence in the isolated output directory. Refuse to call contaminated rows PASS or a product FAIL. Do not auto-approve/dismiss security UI; tell the operator the required action and stop that probe cleanly through the owned launcher API.
3. After the operator dismisses the unrelated prompt, run a fresh `pnpm probe:ui-glass --gate --surfaces` with a unique directory. Inspect its contact sheet and all required base/floating tiers. Only diagnose product coats/native material if a clean repeat still fails. Require preserved thresholds and valid per-shot ownership, then run full Node tests and renderer asset checks.

## Done and STOP criteria

- [x] A system dialog intersecting a scored/reference region makes the evidence explicitly INVALID.
- [x] Unobstructed genuine material/contrast failures remain FAIL; no failure is converted to PASS.
- [x] No unrelated window is closed, permission granted, password entered or security protection bypassed.
- [ ] A fresh unobstructed all-theme/all-role floating-surface gate exits 0, or a separately attributed product failure is planned with clean evidence.

Stop while a system prompt remains present and operator action is unavailable. Keep its measurements invalid instead of changing product styling. Future visual probes should carry visibility/occlusion validity separately from their product metrics.
