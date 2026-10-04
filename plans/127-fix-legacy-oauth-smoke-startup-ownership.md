# Plan 127: Give OAuth smokes the maintained build and startup ownership contract

## Observed failure

The unchanged final `pnpm smoke:local-gates` run on main `4403adfd` stops at its first app smoke, `smoke:oauth`. It passes text integrity, typecheck, renderer build/assets, the full Rust suite (2,994 passed, 12 existing ignored), and strict Clippy. OAuth then times out waiting for `backend-ready` after the original 90,000 ms. No marker payload is received. The failure log remains private at `/tmp/videorc-fixes-final-local-gates-main4403adfd.log`; owned aggregate session 77998 exits 1. The recorded backend wrapper PID 67010 is confirmed absent after awaited teardown. This is a fresh failed gate, not a successful retry or a Windows audio failure.

During startup, main reports its cargo-backed dev backend wrapper and two `backgrounds:bundled-assets` admin-connection failures. Native preview correctly reports waiting for a committed scene. These messages do not establish a GPU, background rendering, OAuth protocol or production startup cause.

Priority P1 for final verification reliability; effort S–M; risk MED because launch failure must preserve exact owned cleanup. Confidence HIGH for the missing shared preparation contract, attribution of this exact timeout pending controlled evidence.

## Verified source discrepancy

`scripts/smoke-oauth-app.mjs::launchAndReadConnection` starts its 90-second clock and directly spawns `pnpm dev`. `smoke-oauth-guards-app.mjs` repeats the legacy pattern. Both parse individual data chunks without retaining partial lines. They bypass `scripts/lib/app-launcher.mjs::launchDevApp`, which already builds the whole backend package under a separate bounded preparation deadline before starting the app readiness clock, accumulates marker lines, and awaits owned cleanup on launch failure. The shared launcher's existing comments describe quiet cargo recompilation exceeding the app launch clock (Plan 0009); that known mechanism is a lead, not direct proof of this run's hidden compiler progress.

## Ordered work

1. Retain the failed trace, exact source and completed gates. Read both OAuth launch paths and the shared launcher/test contracts. Establish a controlled failing-before case for launch preparation/readiness or cleanup at the actual owning seam; use explicit readiness channels or spawn-boundary evidence. Preserve all existing OAuth callback, single-use state, normalized scope and cancellation assertions. Do not infer a compiler stall solely from absent READY.
2. Reuse the maintained launcher for both OAuth smokes, or propose an equally small correction that actually shares its preparation, buffered handshake and exact cleanup contracts. Keep each existing app readiness and OAuth operation timeout unchanged. Do not add sleeps, retry a mutation, enlarge startup limits, suppress launch failure, or change production preview/background/OAuth behavior to obtain a green smoke.
3. Verify the meaningful regression plus launcher/OAuth neighbors, script formatting/syntax and text/diff checks. Review the exact minimal diff. Run Shadscan baseline/floor/immediate-precommit at the existing score 37, then commit/push only intentional files through a normal PR. Defer app/E2E to the final batch.
4. After the slice is merged and all local compiler/app owners are terminal, rerun the full unchanged final local gate bundle. Preserve both failed aggregate runs. Include all remaining feature/device/IPC/browser checks and the existing full-duration soaks; preparation must not substitute for app startup or artifact acceptance.

## Done criteria

- [x] The missing shared preparation/readiness/cleanup contract has a meaningful failing-before regression.
- [x] Both OAuth smokes preserve their protocol assertions and original deadlines while using the maintained ownership path.
- [x] Focused checks pass, the reviewed slice is committed/pushed/merged, and all exact local owners are terminal.
- [ ] The final full bundle passes or records concrete, separately attributed blockers; earlier failures remain retained.

## Separate UI observation

`BackgroundAssetsProvider` makes one bundled-assets request and swallows rejection. Its default registry already contains renderer image URLs and ready slots, so startup log warnings alone do not prove that users lost the catalog or that the registry is empty. If an actual delayed-backend UI case demonstrates a missing capability/background or absent recovery, create a separate attributed plan before changing production code. Preserve this distinction rather than conflating a cold dev-launch failure with a rendering defect.

## Implementation evidence — review pending

The regression imports both actual OAuth smoke callers and controls the existing child-process and WebSocket boundaries. On the original callers it executes 12 cases: 8 fail as expected and 4 controls pass. The failing cases demonstrate missing preparation, READY split across data callbacks, a killed-but-still-live owner, and a failed preparation that still spawns an app. They do not assign the cause of the recorded 90-second timeout. The private RED log is `/tmp/videorc-fix127-node-red.log`.

Both callers now use the existing `launchDevApp` preparation, buffered marker parsing and awaited stop contract. Their OAuth action/assertion bodies, environment overrides and operation/app deadlines remain unchanged. The same regression and 31 maintained launcher neighbors pass: 43 passed, 0 failed, 0 skipped; private log `/tmp/videorc-fix127-node-green.log`. Controlled preparation advances beyond 90 seconds before the unchanged app timer starts; there are no wall-clock settling sleeps. The fixture intercepts signals only for its exact synthetic PID and restores builtin/global/environment mocks and owned temporary directories. It fails the actual connection after listener registration to exercise cleanup without claiming OAuth protocol payload coverage.

The new cross-platform async ownership test also models Windows taskkill. The repository requires 25 affected-filter passes and three full Windows Rust suites in PowerShell 7; one local Node run does not prove that stability. The reviewed workflow addition runs this exact Node file once inside each existing 25-pass ownership iteration, requiring a successful exit and a positive TAP pass count. Existing Rust filters, the three full-suite passes and the 120-minute job cap remain unchanged. Windows evidence, final diff review, commit/merge and the full final app gate are still pending.

## Reviewed slice merged

Commit `00ba8ad91147ec333cc91fc77f7dc4c6da7c6b8e` merges normally through [PR 574](https://github.com/TheOrcDev/videorc/pull/574) to main `c51f9e5fbce11f89de2255807c5604aecbceaeb3` at 2026-10-04T02:22:16Z. Only the two callers, the 12-case actual-caller regression and the seven-line Windows loop addition change. Final focused validation passes 44 tests (12 new cases, 31 launcher neighbors and one existing workflow contract), with 0 failures/skips. Direct four-file formatting, three syntax checks, YAML parsing/exact reverse-byte equivalence, text integrity and diff checks pass. Immediate Shadscan is 37, matching baseline/floor. All exact local executor validation and publication sessions are terminal; execution checkout is clean on current main. No app/E2E runs for this individual fix.

Root independently verifies both callers' protocol bodies, helper bodies, environment overrides and deadlines against the exact 4403adfd baseline. All four committed file hashes and per-file diff blocks match the frozen review. The frozen whole diff hash is `540d3e5efe1d02c832d398bc3314ea7d6eb3adedc3be18921e75ba347ae0f010`; Git's committed serialization is `fbebff61f53d1ac47094dfe4b81995f2cd2a35ca59d29c207490eae453fd6049` solely because the appended new-test block sorts second in `git show`. The maintained launcher itself remains unchanged. Actual Windows job 111343187906/run 37170800945 and the final broader app gate remain pending.
