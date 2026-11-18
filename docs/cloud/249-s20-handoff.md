# Plan 249 S20 handoff

## Status and exact stack

S20 dependency integration complete on the exact published S16 tips (including
S4/S3/S2). Paired diffs are ready for coordinator commits and linked PRs.
**Live acceptance not run.** No commit, push, PR, merge, deployment, provider
request or real user database migration performed.

- Worktree: `/Users/orcdev/projects/videorc-wt-249-s20`.
- Branch: `feat/249-s20-cloud-parity`.
- Current base branch: `feat/249-s16-cloud-parity`.
- Exact base: `5b340c09c50b8500c312a00634bdf122fc04855c`.
- Paired worktree: `/Users/orcdev/projects/videorcweb-wt-249-s20` (same S20 branch name).
- S16 prerequisites: desktop https://github.com/TheOrcDev/videorc/pull/1442;
  web https://github.com/TheOrcDev/videorc-web/pull/128.
- S4 is included: desktop https://github.com/TheOrcDev/videorc/pull/1441;
  web https://github.com/TheOrcDev/videorc-web/pull/127.
- Original frozen S20 diffs and file copies are preserved under
  `/tmp/249-s20-before-s16-integration/{desktop,web}`; no stash or commit created.
- S20 dedicated issue/PR: none found; coordinator owns creation/mapping.
- Published stack branches and both shared active checkouts preserved.

## PR title

Plan 249 S20: recover cloud takes into Library

## PR body

Cloud recording downloads previously saved a file without registering it in
Library, while record-only room activity had no history row. This paired slice
adds explicit show/take/live-interval metadata, conservative historical backfill,
and a durable local download journal. A completed remux registers one
`cloud-recording` session, preserving its real start time. Repeat downloads reuse
the registered file, interrupted remuxes clean only their recorded filesystem
object, and completed-but-unregistered files recover locally on startup even
when the cloud retention window has ended.

Record-only history uses `cloud-room`, never a fabricated native recording or
stream interval. Downloaded takes open in the existing Library for Play/export,
Clean cut and noise cleanup, preserving those workflows' entitlement/consent
checks. Historical unknown interval association stays unknown rather than
claiming record-only evidence. Web keeps canonical existing `tk_` identities,
observed interval links, and original start/expiry timestamps on completion
retries. Expired owned requests and confirmed missing storage objects return
truthful 410 errors; other-account requests remain 404. Network/storage outages
remain unavailable, not missing. Existing 7/30-day retention/deletion and legacy
node-MP4 website downloads are preserved.

Validation: 102 focused desktop behavior/UI tests; 2 focused cloud recording RPC
schema tests (79 unrelated cases filtered out); 88 focused web association,
recording authorization/retention, take-key and migration-runner tests; 11 focused
Node tests including production SQLite SQL on disposable old-schema fixtures.
Scoped TypeScript checks, lint, formatting, Rust formatting and harness syntax
checks are used. Rust compilation/tests, all builds/full suites, smoke, real-page,
device, live provider and artifact acceptance are explicitly not run per user.
The maintained `smoke:cloud-parity -- --case library` path uses the actual artifact
analyzer; no analyzer thresholds were weakened. New production qualification
remains false.

Depends on the paired S20 change and the S16 PRs linked above. S16 source
integration is complete; runtime acceptance and production qualification remain
explicitly deferred. Please cross-link the paired S20 PRs.

## S16 integration completed

1. Actual mutation order is event → settle → `observeLiveInterval` →
   `associateRecordingIntervals` → final state/revision build. A focused route
   integration test proves the first confirmed live event links the take in
   the same mutation; record-only creates no interval.
2. Accepted-take initialization is preserved in `recording.ts`, `destinations.ts`
   and `legs-end.ts`, including S16's recording continuation fallback. One
   continuing take links two canonical intervals across End → Go Live and
   finalization/retried completion preserves its identity/start time.
3. `db/schema.ts` contains S16's canonical typed interval and provider journal
   plus S20's additive recording fields. Migration 0040 and SQLite backfill
   remain additive, without timestamp rewrites or real user migration.
4. Rust reads `status.live_interval.as_ref()` directly. Web reads canonical
   `CloudShowMediaRecord.state.liveInterval`; the parallel structural type and
   casts are removed. Fixtures import canonical `LiveInterval`. Neither side
   allocates an interval ID in S20. The maintained Rust regression covers
   canonical interval persistence and pending-End not implying `endedAt`.
5. S16 `ControlRevAnswer.ending`, `raise_floor`, and `videorc_api.rs` pending-End
   handling remain unchanged from the exact base. Web pending-End/provider
   fixture tests pass. S4 signed `output: recording` and `output: stream` claims
   remain in recording/destination egress requests; the new integration test
   verifies their HMAC claims. S2 privacy and S3 audio code are unchanged.
6. Focused integration/migration/helper tests and scoped checks pass as listed
   below. All live/runtime/artifact/native build gates remain NOT RUN.

S18 remains separately owned by `S6z:P60l3:G1q9i`; it reads S16 IDs and owns
only backend-private `app_settings.cloud.showServices`, with no recording table,
migration, take or Library edits. No S18 code was copied into this slice.

## Data and recovery boundaries

- Postgres migration is additive and rerunnable: backfill managed take IDs from
  existing object keys and legacy files from stable recording IDs; no invented
  historical intervals, no historical timestamp rewrite, no destructive SQL.
- SQLite migration adds association/cache/journal tables and links old
  `cloud-stream` rows to their show ID without changing sessions. In-memory old
  fixture proves rerun and FK behavior. Real old-user databases were not opened.
- Partials are journalled by filesystem object before FFmpeg writes; completed
  files additionally carry existing bound-content identity. Recovery never treats
  a partial/nonzero file as a completed recording. It requires recorded successful
  remux completion plus matching file identity. Existing final files are never
  overwritten, and one deterministic local session identity registers per take.
- Startup recovery is bounded to 128 pending local entries and makes no network
  calls. User deletion of completed sessions is not auto-resurrected (no pending
  staging journal remains). Explicit retry can download a missing local copy.
- This slice does not enable paid recording, auxiliary media, new grants, provider
  operations or automatic post-production. Default parity qualification is false.

## Evidence and deferred gates

- Desktop focused tests: 102 passed across Library, cloud download/view, Clean cut
  and noise cleanup; schema group 2 passed / 79 unrelated filtered out.
- Web focused tests: 88 passed across ten selected files. Pure association tests
  cover record-only, two intervals, retry deduplication, stop overlap, missed active
  webhook finalization and historical uncertainty. Authorization distinguishes
  owner expiry/missing from cross-account 404 and temporary outages.
- Node tests: 11 passed, including actual production SQLite migration SQL on a
  disposable in-memory old database; Postgres migration-runner tests are fakes,
  not proof of an applied PostgreSQL migration.
- Scoped TS/lint/format and Rust format checks; known desktop unrelated warning:
  `use-studio.tsx` stop-confirmation memo lacks `recording` dependency.
- Known pre-existing web `.tile-dim` bundle assertion remains unfixed and was
  not rerun; this slice does not alter any program/guest source or generated asset.
  Source/generated web modules remain byte-for-byte at the S16 base (including S4).
- Deferred, NOT passed: native compilation/Rust unit execution, actual DB/artifact
  acceptance, local cloud/recording-studio/record-latency smokes, real-page/device
  suites, builds, full D/B/N/W gates, managed/live provider and release gates.
- Maintained Library acceptance covers record-only history, multiple interval
  metadata, interrupted download/retry once, expiry, local navigation, and actual
  final-file artifact analysis. Its fake server cannot qualify live providers or
  real production migration behavior. The script was syntax checked only.
- Shadscan baseline/floor: desktop **27/27**, web **47/47**. Final numeric scores
  are reported in the coordinator handoff immediately after the frozen-diff audit.
  No commit is made; the checkpoint is advisory for coordinator integration.

## Exact changed paths

- `apps/desktop/src/renderer/src/components/tabs/library-cloud-recordings.test.ts`
- `apps/desktop/src/renderer/src/components/tabs/library-cloud-recordings.tsx`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/lib/clean-cut-view.test.ts`
- `apps/desktop/src/renderer/src/lib/clean-cut-view.ts`
- `apps/desktop/src/renderer/src/lib/cloud-recordings-view.test.ts`
- `apps/desktop/src/renderer/src/lib/cloud-recordings-view.ts`
- `apps/desktop/src/renderer/src/lib/library-view.ts`
- `apps/desktop/src/renderer/src/lib/session-modes.ts`
- `apps/desktop/src/shared/backend-rpc-contract.test.ts`
- `apps/desktop/src/shared/backend-rpc-contract.ts`
- `apps/desktop/src/shared/backend.ts`
- `crates/videorc-backend/src/clean_cut/mod.rs`
- `crates/videorc-backend/src/cloud_control_web.rs`
- `crates/videorc-backend/src/main.rs`
- `crates/videorc-backend/src/noise_cleanup.rs`
- `crates/videorc-backend/src/storage.rs`
- `crates/videorc-backend/src/storage/cloud_recordings.rs`
- `crates/videorc-backend/src/storage/cloud_recordings.sql`
- `docs/cloud/249-execution-ledger.md`
- `docs/cloud/249-s20-handoff.md`
- `protocol-fixtures/cloud-parity-plan.json`
- `scripts/lib/cloud-library-migration.test.mjs`
- `scripts/lib/cloud-parity-library.mjs`
- `scripts/smoke-cloud-parity-app.mjs`
- `scripts/smoke-cloud-talk-show-managed-app.mjs`
