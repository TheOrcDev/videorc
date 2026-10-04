# Plan 113: Restore the initial renderer asset budget without raising it

> New regression during QA fix execution. Planned at `43716ab32cd59f0ec573dffd91184553e48487b2` / merged main `1d3cabb2b0972f55d166faae0f296c02f4feeefb`, 2026-10-03. Drift check: `git diff --stat 1d3cabb2..HEAD -- apps/desktop/src/renderer/src apps/desktop/electron.vite.config.ts scripts/check-renderer-asset-budget.mjs scripts/lib/renderer-asset-budget.mjs`.

## Status

- Priority: P1; the JS CI job fails the maintained production asset gate
- Effort: S–M
- Risk: MED; preserve synchronous hydration and capture/consent ownership
- Depends on: implement the remaining 097–111 slices first, then measure the final renderer graph
- Category: performance / regression introduced during execution
- Confidence: HIGH; adjacent CI production builds isolate the threshold crossing

## Problem and evidence

[PR 551 JS CI](https://github.com/TheOrcDev/videorc/actions/runs/37137237638/job/111244139323) passed at 1,999,851 eager raw bytes, 386,220 gzip, entry 729,149 raw / 145,311 gzip. The following [PR 552 JS CI](https://github.com/TheOrcDev/videorc/actions/runs/37137906621/job/111246099183) failed at 2,000,285 eager raw, 386,370 gzip, entry 729,583 raw / 145,461 gzip. The added 434 raw bytes crossed the unchanged 2,000,000-byte ceiling by 285 bytes. Local logs are `/tmp/videorc-fix110-ci-js.log` and `/tmp/videorc-fix101-ci-js.log`; do not commit logs or generated output.

PR 552 added required Camera Off snapshot normalization/validation. Do not remove that correctness repair to recover bytes. The preceding build had only 149 bytes of headroom, and subsequent source/long-session fixes may add eager code. Measure the completed batch before choosing a reduction.

The later PR 556 JS CI confirms that required additions now cross both eager limits: 2,018,030 raw bytes against 2,000,000 and 390,332 gzip bytes against 390,000. The completed job log is `/tmp/videorc-fix114-ci-js.log` ([job](https://github.com/TheOrcDev/videorc/actions/runs/37143435679/job/111262433246)). This remains the same required asset-budget follow-up, not a new feature defect. Its final reduction must pass both limits after the remaining source fixes.

After Plan 100, [PR 557 JS CI](https://github.com/TheOrcDev/videorc/actions/runs/37146590698/job/111271698452) measures 2,018,252 eager raw / 390,400 gzip bytes, with entry 736,120 raw / 146,733 gzip. The same two eager limits fail; the entry limits pass. Log: `/tmp/videorc-fix100-ci-js.log`. Use a fresh final production graph after 097, 106 and 107 rather than treating these intermediate sizes as the final reduction target.

## Current state and scope

`scripts/check-renderer-asset-budget.mjs` keeps four versioned limits: 2,000,000 eager raw, 390,000 eager gzip, 1,200,000 entry raw and 235,000 entry gzip. Its calibration comments call for resplitting rather than further budget increases. `scripts/lib/renderer-asset-budget.mjs` reads the actual production HTML entry/modulepreload assets and measures real raw/gzip output. Preserve the measurement and all four limits.

`apps/desktop/electron.vite.config.ts` defines index/comments/captions/notes production entries. `hooks/use-studio.tsx` already lazy-loads optional helpers (scheduled streams, command failure policy, dashboard relay, remote surface and post-stream work), but initial scene library/checkpoint hydration is synchronous and must stay authoritative. The development scene smoke effect already uses `import.meta.env.DEV`; do not assume its diagnostic body is retained in production.

In scope: the narrow measured eager dependency/helper boundary in `apps/desktop/src/renderer/src`, focused tests for its behavior and any genuine chunk ownership seam, and production build graph verification. Inspect actual imports before naming final touched files; document the selected owner. Out of scope: asset-limit increases or environment overrides, HTML/modulepreload removal that hides required eager bytes, weakened checks, Camera Off/consent regression, dependency replacement, broad renderer redesign, native capture/encoding, releases or publishing.

## Ordered work

1. After the remaining QA implementations, run `pnpm build` and `pnpm check:renderer-assets` with default limits; retain the failing-before report outside the repository. Inspect reported assets, production HTML and their dependency graph. Attribute eager bytes to a concrete owner rather than assuming development diagnostics caused them. This is build verification, not an app/E2E run.
2. Choose a small reduction that preserves existing behavior: consolidate measured duplicate pure logic or defer an optional feature/helper at its existing action boundary. If asynchronous loading is introduced, preserve latest-owner/cancellation/error semantics and add a failing-before focused behavioral regression; avoid an import-only test that mirrors syntax. Do not make initial saved-scene/working checkpoint hydration asynchronous.
3. Run focused affected desktop/Node tests, typecheck/lint/format and direct formatting for any scripts. Rebuild and rerun the actual default asset gate. Record all four sizes and the selected boundary. Root reviews the entire diff and Shadscan, then commits/pushes this follow-up through its own normal PR.
4. Include affected feature acceptance and production build/asset gate in the final batch validation. No release or publication.

## Done and STOP criteria

- [x] A fresh production build passes all four unchanged default asset limits, with real measurements recorded.
- [x] Camera Off normalization/validation and every prior QA repair remain intact.
- [x] The measured reduction belongs to an identified import/helper owner; focused tests prove any behavior changed by a lazy boundary.
- [x] No required eager code is merely omitted from measurement, no environment ceiling override and no weakened gate.

Stop if the proposed boundary would weaken synchronous capture/scene/consent ownership, or if the build graph cannot attribute a safe reduction. Document the observed graph before trying a different approach. Future correctness fixes must preserve the production initial asset gate.

After the backend-only Plans 097 and 115, [PR 559 JS CI](https://github.com/TheOrcDev/videorc/actions/runs/37150382042/job/111282873753) still fails the same two eager limits: 2,018,252 raw bytes and 390,400 gzip bytes. Log: `/tmp/videorc-fix115-ci-js.log`. This confirms the required follow-up remains unchanged; it is not a new budget discrepancy or evidence of final asset acceptance.

[PR 560 JS CI](https://github.com/TheOrcDev/videorc/actions/runs/37151924243/job/111287395830), after the audio analyzer timing repair, reports the same 2,018,252 eager raw / 390,400 gzip bytes and entry 736,120 raw / 146,733 gzip bytes. Its failure is still the two unchanged eager limits. Log: `/tmp/videorc-fix106-ci-js.log`. Measure the fresh graph after the Plan 107 evidence seam before selecting the reduction.

## Selected graph owner and failing-before evidence

After Plan 107 merged at `7f2f83b29923aaa4407677dd11ea97acbf62c5b0`, the fresh local production build passes but the unchanged default asset gate fails: 2,018,252 eager raw / 391,610 gzip bytes; entry 736,120 raw / 146,881 gzip bytes. This local Node v24.6.0 measurement is independent of the preceding CI gzip values. Logs and report remain outside the tree: `/tmp/videorc-fix113-exec-build-red.log`, `/tmp/videorc-fix113-exec-assets-red.log` and `/tmp/videorc-fix113-exec-assets-red-report.json`.

The concrete owner is `apps/desktop/src/renderer/src/components/icons.tsx`. Its semantic slots currently use local runtime `export const` aliases. Actual Vite bundling of an initial consumer of `StudioIcon` and an existing-style deferred consumer of `BrainIcon` places both Brain component and six-weight glyph-definition modules in the initial static dependency closure. The focused test fails on those two actual module IDs, while the alias/SVG/all-weight semantics test passes. Failing-before log: `/tmp/videorc-fix113-exec-registry-red.log` (one failed, one passed).

The selected repair replaces those local aliases with equivalent direct ES re-exports, preserving every semantic slot, its glyph, all six weights, ordinary SVG props, the custom Kick SVG, the registry-only import rule and compile-time compatibility with `AppIconProps`. This lets existing deferred consumers own their glyph chunks. It introduces no asynchronous action, hydration, capture, scene, checkpoint or consent boundary; no Vite/HTML/budget/dependency change is proposed. Root reviewed this concrete scope before final implementation verification. Actual full production build and all four default sizes remain the acceptance gate; the reduced fixture graph alone cannot establish budget acceptance.

[PR 561 JS CI](https://github.com/TheOrcDev/videorc/actions/runs/37152794405/job/111289939170) independently confirms the same existing eager-budget failure after the diagnostic seam: 2,018,252 raw / 390,400 gzip bytes; entry 736,120 raw / 146,733 gzip bytes. Format, lint, typecheck and production build pass; desktop and Node suites are skipped after this gate failure. Log: `/tmp/videorc-fix107-ci-js.log`. This does not establish final suite acceptance or introduce a distinct defect.

## Independent verification discrepancy and immediate diagnostic plan

Root's first 71-case desktop verification ran alongside typecheck, lint, format and production compilation. It passed 69 cases but timed out the two existing provider/detached Activity rollover consumers at their unchanged 5,000 ms deadline (9,131 ms and 5,408 ms recorded). The icon graph/semantics cases pass. Failure log: `/tmp/videorc-fix113-root-desktop.log`. This is an observed test discrepancy, not yet an attributed product or icon regression.

Immediate plan: preserve this failed run; finish the competing compiler checks; rerun the exact six-file desktop command alone under unchanged deadlines; inspect the 2,000-row Activity consumer if failure persists. Do not raise timeouts, drop rollover coverage or call a loaded-run failure acceptance. A reproduced independent defect receives its own source plan/commit; the final full desktop suite remains required even if isolation passes.

## Independent implementation acceptance

Root reviewed the entire frozen two-file diff (`b03f59d5ab0540231949c424262aa7d2e919243a101162b191433572b811d493`) and independently confirmed all 90 semantic slots/85 glyph mappings, exact custom Kick source and complete compile-time glyph prop coverage. The initial root review script accidentally matched unrelated prop literal unions; narrowing its review to the actual type-contract block confirms equality. This was a review-script error, not a product regression.

The exact six-file desktop rerun alone passes 71/71 under the unchanged deadlines, including both Activity consumers (3,148 ms / 2,922 ms). The earlier loaded-run failures remain retained; no timeout or assertion was changed. Full-suite stability remains pending in the final batch. Root also independently passes the three asset-measurement cases, typecheck, lint (one existing hook warning), formatting, production build and default gate. The resulting real HTML/modulepreload measurement is 1,815,069 eager raw / 354,376 gzip bytes, with entry 792,997 raw / 158,723 gzip bytes. Bundle regrouping increases the entry but passes all four existing ceilings; no measurement or preload was changed. Reports/logs remain outside the tree: `/tmp/videorc-fix113-root-assets-report.json`, `/tmp/videorc-fix113-root-{desktop-isolated,node,typecheck,lint,format,build,assets}.log`.

Implementation acceptance is distinct from the final full-suite and app/E2E batch; this repair introduces no async feature authority boundary. Normal separate commit/PR and its merged main owner are recorded below when complete.

Plan 113 implementation is committed as `a82947b11dcb447c27deca172257b6ba3023bf57`, pushed and normally merged through [PR 562](https://github.com/TheOrcDev/videorc/pull/562) to main `c508520da655f8a5ab176b8d2daadff5612cd759` at 20:58:11 UTC. Shadscan immediately before this commit remains 37 with 54 findings. The execution checkout is fast-forwarded to merged main and clean. The final broad verification batch begins on this exact source; no app/E2E result is claimed yet.

[PR 562 JS CI](https://github.com/TheOrcDev/videorc/actions/runs/37153421327/job/111291780520) independently passes the unchanged asset gate at 1,815,069 eager raw / 354,338 gzip bytes; entry 792,997 raw / 158,607 gzip bytes. Its subsequent full desktop step fails the separately diagnosed follow rollover deadlines in Plan 116. Asset acceptance and that fixture failure are distinct. Log: `/tmp/videorc-fix113-ci-js.log`.
