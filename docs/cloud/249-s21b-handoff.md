# Plan 249 S21b desktop handoff

## Source checkpoint

Paired bounded program Clips source and maintained acquisition implemented;
**production remains disabled/unqualified; runtime acceptance not-run**.
No commits, pushes, PRs, merges, deployments, provider/paid requests, credentials
or user DB migrations were performed. Peer/published/shared trees preserved.

- Worktree: `/Users/orcdev/projects/videorc-wt-249-s21b`.
- Branch: `feat/249-s21b-cloud-parity`.
- HEAD, eventual parent and diff base: `28d21f8c5b9f37d978c3632d498da37b648dc348`.
- Eventual PR base: `integrate/249-s19-s24-reconcile` (published S19).
- Index matches HEAD; no staged changes, unmerged files or pending merge/rebase/cherry-pick.
- Partner worktree: `/Users/orcdev/projects/videorcweb-wt-249-s21b` on its exact S19 tip. Paired links: coordinator to insert after publication. No dedicated issue URL is known; do not invent one.
- S19 upstreams: [desktop #1463](https://github.com/TheOrcDev/videorc/pull/1463), [web #144](https://github.com/TheOrcDev/videorc-web/pull/144), open/stacked on S24. S21a/S21c source already on main. S13a/S13b anchors are not show clocks and require no copied peer code here.
- Central accounting: 18 merged source checkpoints, 6 open-PR slices (S13a/S13b/S17/S19/S22/S24), 8 unpublished; 0 runtime-qualified. W4, repair1457 and urgent local Studio audio fix G2heq remain separate.

## Behavior

Owner session + generation + persisted clip mark + server-owned measured clock
proof select an immutable bounded window. No evidence can come from client time,
PDT, a take association, latest interval, native anchor or S15 offset. Production
proof remains absent and managed price/qualification false. Enable/poll/disable
reuse S24 controller reservation; extraction is an account read. No recording or
native capture is started implicitly.

Desktop uses the existing Clips section and mark owners, configured recordings
folder capability, one bounded local worker, hash verification, AV decode/trim/
re-encode, decode/duration gates, cancellation, retry journal, no-replace publication,
and existing Library workflows. Derived clip provenance survives job dismissal;
canonical takes/archives/ISO files are never overwritten. Queue acknowledgement
is not a saved clip; completion refreshes Library.

The runnable `clips` acceptance acquires actual program pixels and mixed audio
through S21a, uses an explicitly simulated local clock with the real web routes,
then exercises the real desktop worker, Library, repeated save, cancellation and
expiry. It checks finished overlay pixels, tones, duration and packet PTS/DTS.
It has **not run**, and local clock simulation cannot qualify managed alignment.

## Focused evidence

- Desktop focused Vitest: 20 tests (Clips UI/consent, RPC schemas, marker/clip copy, existing Stream Manager controls), passed.
- Web focused tests: 18 Clips plan/auth/controller/refusal tests and 16 managed replay regressions, passed. Fake adapter tests do not measure provider behavior.
- Node focused helpers/registry: 14 tests passed, including actual extracted Rust `trim_args` compiled standalone with `rustc` (no backend/dependency build) and additive SQLite SQL applied twice to an in-memory fixture. This does not compile the worker.
- Desktop web/node TypeScript and web TypeScript passed. Scoped Rust format and diff whitespace passed. Web scoped ESLint passed. Web generated program modules are unchanged; `node --import tsx lib/cloud/program/tools/emit.ts --check` passed.
- Desktop scoped oxlint retains two inherited findings: `fake-cloud-web-managed.mjs:58` no-control-regex error; `use-studio.tsx` stopConfirmation useMemo missing recording dependency warning. Their exact base code is unchanged; neither suppressed or weakened. The unrelated known tile-dim assertion, full reaper and broad suites were not rerun.

## Deferred gates and limitations

- Smoke/real-page/device/managed/provider/paid testing, desktop builds, full Rust compilation/tests/clippy, real migration/recovery/filesystem and final-artifact execution: not-run by explicit user instruction.
- Rust worker tests are authored but uncompiled. Standalone trim helper compilation is not whole-worker validation. Windows cancellation/device behavior is not measured.
- Required `pnpm smoke:cloud-parity -- --case clips`, S21a managed source/clock/cost/D8 qualification and relevant recording/remote/device gates remain deferred. Nothing here marks Plan249, S21a or S21b runtime acceptance complete.
- Before any production enablement, obtain measured show-origin/take/generation/segment proof with bounded uncertainty and independent AV segment evidence, qualify provider availability/cost/quotas, and review installation of server-owned proof. No fallback or synthetic production clock is supplied.
- Web adds no SQL migration, browser page change or generated module change. Desktop additive `cloud_program_clips`/`cloud_clip_sources` migration was exercised only in-memory. Existing 0041/0042/0043 reservations are untouched.

## Audit and frozen diff

Baseline/floor: **27/27**. Final advisory Shadscan audit on the frozen
complete tree: `/tmp/249-s21b-desktop-shadscan-final.json` (numeric result reported
in final coordinator handoff). Command `pnpm dlx @shadscan/cli@next --json`, run
from apps/desktop. No agent commit was created.
Exact file hashes, parents, index tree and tool evidence are in
`/tmp/249-s21b-desktop-frozen.json`; maintained path/hash manifest excludes its own
self hash. Dependency symlinks (`node_modules` and `apps/desktop/node_modules`) are **not part of the diff**.

## PR-ready title

Plan 249 S21b: Save gated cloud program Clips to Library

## PR-ready body

Room clip marks currently save timeline metadata without a local program file. Add explicit cloud Clips controls and a bounded cancellable downloader that verifies selected segment hashes, trims and re-encodes both video and audio, validates the artifact and registers a derived file in Library. Existing UI/remote/agent/consented-host-voice owners share the path; retries preserve the marker and canonical take identities.

Production remains disabled: managed ring availability/cost, D8 and show-to-media
clock qualification are unmeasured. Missing proof refuses extraction. Maintained
real-program acquisition and artifact acceptance are included but were not run.
Focused helper/auth/controller/schema/UI checks and scoped static checks passed;
desktop retains the two documented inherited lint findings. Full Rust/runtime/
artifact/migration gates are deferred by instruction. Stack on S19 and link the
paired S21b PR; this is a source checkpoint, not a parity qualification.

## Exact paths

- `apps/desktop/src/renderer/src/components/cloud-markers-dialog.tsx`
- `apps/desktop/src/renderer/src/components/tabs/cloud-clips-section.test.ts`
- `apps/desktop/src/renderer/src/components/tabs/cloud-clips-section.tsx`
- `apps/desktop/src/renderer/src/components/tabs/recording-tab.tsx`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/lib/marker-toast.ts`
- `apps/desktop/src/renderer/src/lib/studio-actions/studio-context.ts`
- `apps/desktop/src/shared/backend-rpc-contract.ts`
- `apps/desktop/src/shared/clip-marks.ts`
- `apps/desktop/src/shared/cloud-clips.test.ts`
- `apps/desktop/src/shared/cloud-clips.ts`
- `apps/desktop/src/shared/cloud-markers.ts`
- `crates/videorc-backend/src/agent_look.rs`
- `crates/videorc-backend/src/cloud_clips.rs`
- `crates/videorc-backend/src/cloud_markers.rs`
- `crates/videorc-backend/src/main.rs`
- `crates/videorc-backend/src/replay_buffer.rs`
- `crates/videorc-backend/src/storage.rs`
- `crates/videorc-backend/src/storage/cloud_clips.rs`
- `crates/videorc-backend/src/storage/cloud_clips.sql`
- `crates/videorc-backend/src/videorc_api.rs`
- `docs/cloud/249-execution-ledger.md`
- `docs/cloud/249-s21b-contract.md`
- `docs/cloud/249-s21b-handoff.md`
- `docs/cloud/249-s21b-manifest.json`
- `protocol-fixtures/cloud-parity-inventory.json`
- `protocol-fixtures/cloud-parity-plan.json`
- `scripts/lib/cloud-parity-baseline.mjs`
- `scripts/lib/cloud-parity-clips-contract.mjs`
- `scripts/lib/cloud-parity-clips-contract.test.mjs`
- `scripts/lib/cloud-parity-clips-source.test.mjs`
- `scripts/lib/cloud-parity-clips.mjs`
- `scripts/lib/cloud-parity-replay-ring.mjs`
- `scripts/lib/fake-cloud-web-managed.mjs`
- `scripts/smoke-cloud-parity-app.mjs`
