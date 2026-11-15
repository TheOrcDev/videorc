# Avatar onboarding test diagnosis

Base: `origin/main` at `05e30d12d161ce310b7053a857d2cc7841592a4d`, desktop
0.27.0, macOS arm64. The prepared checkout was moved off the older feature
base before testing. Open PRs were checked; #1380 addresses creator
cancellation, #1381 Preview startup warnings, and neither fixes this test.

## Reproduction and cause

The unchanged library test file initially passed (22 tests), but a fresh
single-worker run of the exact reported case failed with
`AssertionError: expected null not to be null` at the onboarding assertion:

```sh
pnpm --filter @videorc/desktop test \
  src/renderer/src/components/buddy-library-section.test.ts \
  --maxWorkers=1 --minWorkers=1 \
  -t 'opens the onboarding when another surface'
```

The request uses a persistent external store, not a transient DOM event.
Instrumentation observed `{ nonce: 1, step: 1 }` after the request, and
measured the real lazy module taking 1,074 ms to import. The test's
`vi.waitFor` had its default 1,000 ms deadline. Successful baseline runs
also emitted React warnings about Suspense resolving outside `act`.
Waiting for imports inside `act` rendered the real onboarding sheet with
the request intact.

To isolate import timing from navigation, a temporary 1,200 ms top-level
await delayed evaluation of the real onboarding module. With that delay,
the old DOM poll failed the same missing-element assertion; the explicit
import flush passed all 24 library tests. The delay and instrumentation
were removed. No product event/navigation defect was demonstrated.

## Change and verification

The test now waits for `vi.dynamicImportSettled()` inside React `act`, then
asserts that the actual sheet exists and has the requested step. The same
helper covers the New avatar and invitation buttons. Added cases verify
requests made before the library mounts and fresh requests after dismissal. Neither the
onboarding implementation nor any test timeout changed; the lazy module,
store, library section and dialog are real components in these tests.

- Final focused run: **43 passed across three files**, with one worker and
  default timeouts: `buddy-library-section.test.ts`,
  `buddy-onboarding.test.ts`, and `buddy-onboarding-store.test.ts`.
- ESLint and Prettier on the changed test: **passed**.
- Six fresh-worker opening runs: **passed**, covering the external request
  twice, a request before mount, dismissal/reopen, and the New avatar and
  invitation buttons.
- `git diff --check`: **passed**.
- Shadscan baseline and enforced floor: **27**, using
  `pnpm dlx @shadscan/cli@next --json` from `apps/desktop`.

The full desktop suite, build, global typecheck/lint/format, Rust and native
smokes were not duplicated on the busy shared host. This is a test-only
fix; it does not change capture, preview, recording, audio or remote
control. No GUI profile, real provider, live stream or external account
was exercised. These focused results do not turn the earlier broad QA
runs into passing full-suite results.

Local diagnostic logs: `/tmp/avatar-onboarding-repeat-1.log` (unmodified
failure), `/tmp/avatar-onboarding-instrumented.log` (import timing),
`/tmp/avatar-onboarding-slow-evaluation-red.log` and
`/tmp/avatar-onboarding-slow-evaluation-green.log` (controlled comparison),
and `/tmp/avatar-onboarding-final-focused.log` (final tests).
