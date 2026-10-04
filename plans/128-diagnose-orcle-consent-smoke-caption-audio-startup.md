# Plan 128: Diagnose missing caption audio in the Orcle consent smoke

## Observed failure

The serial final feature batch runs the unchanged `pnpm smoke:cohost-fake` on clean main `c51f9e5fbce11f89de2255807c5604aecbceaeb3`. Backend preparation completes in 1m30s. The initial live co-host scenario passes nine ticks over 44 scripted messages, including presence, grouping, quota/backoff, dismiss/reply/greeting and 30-second idle checks. At the next same-process consent scenario, `waitUntil(() => captionFake.state.audioAppends > 0, 5_000, 'caption audio for consent scenario')` times out. The exact root session 9495 exits 1; private full log `/tmp/videorc-fixes-final-cohost-mainc51f9e5f.log`. Consent revoke/grant, held late tick/spotlight/speech responses and the later stream spotlight scenario have not executed. The initial chat PASS is not whole-smoke acceptance.

Priority P1; effort M; risk MED because this gate covers live consent/privacy ownership. Attribution is unassigned: no caption status, injection acknowledgement, transport counters or writer/reader diagnostics are retained at the failure boundary. The existing audio pump suppresses rejected injection requests. That is a diagnosis lead, not proof of a rejected request or production caption failure. The script awaits its existing cleanup but suppresses some cleanup errors; terminal exit alone does not prove every descendant exited. Do not claim physical microphone or recording-scoped clip-mark coverage from this stream-only fake-service scenario.

## Ordered work

1. Preserve the failed source/log and completed initial scenario. Inspect the actual consent caller, caption start/status and admin injection route, fake realtime token/connection/audio boundaries and the debug sample clock introduced by Plan 118. Identify whether ownership, injection delivery, reader readiness, transport admission or fixture cadence prevents the first append. Collect only sanitized counters/status and exact owned-child evidence; do not log credentials, transcripts or media payloads.
2. Reproduce the discrepancy at the actual owning production or fixture seam with an explicit start/readiness/acknowledgement boundary. Use deterministic fake-service delivery or controlled clocks where appropriate. Require a meaningful failing-before case; preserve the original five-second audio readiness limit and every consent revoke/grant, late-response, independent-caption, history and spotlight assertion. Do not add settling sleeps, retries of mutations, ignored cases, higher limits or an inferred production-policy change.
3. Review the attributed RED and smallest repair, then focused caption/consent/fake-service neighbors, direct format/syntax/text/diff checks and any applicable backend gates. New Windows async/process coverage requires the existing PowerShell 25 affected-filter passes and three full Rust suites. Run immediate Shadscan baseline/floor/precommit 37, commit/push only intentional files through a normal PR, and defer broad app/E2E to the serial final batch.
4. After merge and all local owners are terminal, run the complete maintained co-host smoke and remaining final feature/aggregate gates. Retain this failure and every later outcome. Bound and verify cleanup of exact owned children before reporting acceptance. Full-duration preview/recording soaks and distinct physical device/browser/IPC limits remain required or explicitly blocked.

## Done criteria

- [ ] The missing first audio append is attributed at its actual owning boundary.
- [ ] A meaningful original-boundary regression passes after the minimal reviewed repair.
- [ ] Focused checks pass and the intentional slice is committed/pushed/merged.
- [ ] The complete maintained co-host smoke passes with consent and late-response assertions intact, or retains a concrete separately attributed blocker.
