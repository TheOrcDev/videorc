# Plan 125: Diagnose fake-provider activity accounting contract

Discovered by final `pnpm smoke:local-gates` on clean main `2f999dac88fc8561a40fb450e7136de74265584a`, 2026-10-04 UTC. Priority P1; effort S–M; risk MED. Product versus fixture attribution is unassigned.

## Observed discrepancy

The maintained aggregate exits1 at `pnpm smoke:live-chat-fake-providers`, `scripts/smoke-live-chat-fake-providers.mjs:532`: **Confirmed fake activity accounting disagreed with the normalized fixture.** Preserve private log `/tmp/videorc-fixes-final-local-gates-main2f999dac.log`. The assertion must retain the normalized fixture and authoritative confirmed-state contract; the error alone does not identify a product defect.

Before failure, text integrity/typecheck/build/asset budget, full Rust2993/12ignored, strict Clippy, OAuth/guards, sources/session/start labels/secrets/platform/screens, multistream/dev artifacts, enforced five-cycle recording latency, system audio, all16 recording matrix cases (including hard content and both transient-pressure cases), remote-control, LAN and provider readiness all exit0. Later YouTube quota/command lanes/Comments/glass/recycle/resilience/encoder/memory/session decay/one-hour soak/15-minute recording stages are unexecuted by this aggregate. The earlier current-production36-stage recording/device aggregate remains independently passed.

## Ordered work

1. Trace the actual fixture normalizer, command/receipt and confirmed activity projection at the failed assertion. Preserve bounded expected/observed counts and provider/kind ownership without raw credentials, user data or full status. Verify owned teardown. Compare Plans099/100 durable accounting and Plan105 smoke projection with the real contract; do not assume they caused this failure.
2. Reproduce the attributed boundary in a meaningful existing test or actual owned callback/RPC seam, with relevant controls. Distinguish stale fixture expectation, incorrect snapshot projection, event accounting or asynchronous confirmation. No permissive retries, threshold changes, omitted activity kinds, shorter rollover fixtures, or counter resets are authorized by this generic error.
3. Root reviews actual RED and the minimal concrete repair before production changes. Run smallest relevant logic/static gates and any necessary neighboring accounting tests. Preserve durable session totals, deduplication, unread rollover, gift/tip/follow semantics and provider isolation. No per-fix broad app/E2E batch.
4. Root reviews full final diff and focused GREEN; immediate Shadscan floor37, one intentional fix commit/push/normal PR merge to main. Run unchanged fake-provider gate in the final batch, then complete the remaining applicable local/feature/stability/documentation work with original failure retained.

## Done criteria

- [x] Exact expected/confirmed mismatch and owning source boundary are attributed.
- [x] A meaningful failing-before regression passes after the smallest reviewed repair.
- [ ] Unchanged maintained fake-provider gate completes with owned teardown.
- [ ] Final report preserves this failed aggregate and distinguishes all remaining requirements.

## Attributed RED and reviewed repair

The frozen four-file mechanical extraction, SHA256 `c2ac0126d73239eaf1ae6f5c50d6fc521f118b455fa2aab78a2c847f074dc1c5`, preserves the original predicate and error. Executor and root independently observe one failing actual-wire acceptance case and18 passing controls. Equivalent fixture property order succeeds; every incorrect scalar, tip amount/currency, currency-row order, missing/extra row and extra-property control refuses acceptance.

The actual fake connectors, normalizer, persistence worker, SQLite and `handle_text_message` RPC return the exact required totals: available, messages13, chatters7, supporters7, follows2, raids1, bits1500 and ordered USD5,000,000/EUR2,000,000 micros. Both independent Rust controls pass, including13 distinct canonical messages, three provider-ended barriers and bounded exact connector joins/session stop before assertions. The serialized tip objects have `amountMicros` before `currency`; the literal expected objects have the reverse property order. `JSON.stringify` rejects this structurally identical reply. Root proof logs are private `/tmp/videorc-fix125-root-node-red.log` and `/tmp/videorc-fix125-root-rpc-control.log`.

Root approves only replacing the tip-array string comparison with `isDeepStrictEqual`, preserving exact ordered rows, values, property sets, every scalar predicate and the error. No readiness wait, fixture length, backend accounting or durable-rollover behavior changes. The actual asynchronous RPC case is added by its exact name to the existing Windows25-pass filter loop; three full Windows suites remain required.

The full reviewed five-file diff SHA256 `dc7290e7b8d605c404eb93b04c8fb2ba40c510e0981c49c6f0bb966156e4fd1a` merges as source `fd4e614c6cbbf2d3dd1f9da75c2f34ca839942aa`, [PR571](https://github.com/TheOrcDev/videorc/pull/571), main `8dd2aa9dfb1ab3bcff172232020c1099cb39ac6a`. Root independently verifies19 focused Node cases plus one existing workflow control,13 real Rust totals cases, one durable rollover case and strict Clippy. Executor typecheck/lint/format/Rustfmt/syntax/diff checks pass, retaining one pre-existing lint warning. Shadscan baseline/floor/precommit37. The committed diff matches the frozen reviewed bytes, both execution checkouts are clean and all owned local sessions are terminal. The unchanged maintained app gate and Windows25/three-full acceptance remain pending; no broad E2E ran after this individual fix.

Actual source-head JS CI job111335067756 subsequently completes successfully. Root verifies every audit/format/lint/typecheck/build/asset-budget/test step and private raw log `/tmp/videorc-fix125-ci-js-green.log`: desktop2,851PASS/one existing skip/270files; Linux Node1,819PASS/five existing skips/279suites (1,824tests). This is separate from the pending macOS/Linux Rust, Windows stability and final real-app gates.

Modern source125 Rust CI also passes (macOS2,994total/12ignored; Linux2,769backend plus one integration/11ignored). Windows source [job111335068432](https://github.com/TheOrcDev/videorc/actions/runs/37168049508/job/111335068432) now completes successfully under PowerShell7. Root verifies the actual raw log: all25 preview passes; all26 affected filter series, including the real fake-provider RPC case, repeated25times; each audio run68PASS/0FAIL/0ignored; three full backend runs2,814PASS plus one integration test/13existing ignored each. All audits and required steps succeed. Windows desktop2,850PASS/2skips and Node1,814PASS/10skips are platform-specific counts. Private raw log `/tmp/videorc-fix125-ci-windows-source-green.log`. The newer observation/OAuth slices and the unchanged final app gate remain separate and pending. This green source run does not attribute or erase the earlier intermittent audio failures.
