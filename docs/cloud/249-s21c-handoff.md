# Plan 249 S21c: optional local program archive

## Checkpoint and bases

Source implementation is prepared for coordinator review. **Runtime/managed
qualification and actual archive acceptance are not run.** Production remains
disabled by S21a's server policy (`qualified:false`, null measured pricing).
No commit, push, PR, merge, deployment, provider/paid call, credential access or
real user database migration was performed. No private memory notes were made.

Both branches: `feat/249-s21c-cloud-parity`. Both intended PR bases:
`feat/249-s21a-managed-replay` (open/unmerged source dependency).

| Repository | Isolated worktree                               | HEAD / diff base / next commit parent      |
| ---------- | ----------------------------------------------- | ------------------------------------------ |
| Desktop    | `/Users/orcdev/projects/videorc-wt-249-s21c`    | `183f4812dd8bbf4405d264031eec139176fd9de2` |
| Web        | `/Users/orcdev/projects/videorcweb-wt-249-s21c` | `cd32e7e7ba1a025f2b4f4c805dd6a8d0a6dea914` |

Desktop source PR [#1449](https://github.com/TheOrcDev/videorc/pull/1449), parent
`dda61b03ef52a97bd74a6796a2a0032d480878e5`. Web source PR
[#131](https://github.com/TheOrcDev/videorc-web/pull/131), parent
`59fb8ba6c3cd9559523c5d320bad2065f3cdce1d`. S20 is inherited through main.
Original S21a/published/shared/peer trees remain untouched. Indexes match HEAD;
all followup files are unstaged, with no pending merge/rebase/cherry-pick.
No new issue URL is invented. Coordinator creates and cross-links paired PRs.

## Behavior and limits

- Library's optional archive controls query server availability, disclose the
  cloud/network dependency and bounded cost, and require explicit enablement.
  Record is an independent user action. H/V is explicit; no camera-owning native
  session, implicit recording, new provider output or enlarged credential scope.
- Backend reads authenticated same-origin account API responses with redirect
  refusal, finite body/time limits, generation/account/take fences and hashes.
  It persists each owned staging object, durable completed segment and cleanup
  quarantine in a separate additive SQLite journal. No user path is accepted
  from the renderer without Output's existing resource capability.
- One local worker, 512 segment entries, 256 MiB of source data and the S21a
  five-minute generation. Remux temporarily needs another copy (up to roughly
  512 MiB peak staging); at most 16 jobs are retained. Server byte/request/cost
  quotas may stop acquisition sooner. No automatic renewal or budget increase.
  User cost ceiling: 100,000 micro account-currency units; no prices measured.
- Restart requires explicit resume. Every already retained segment is checked;
  missing, expired, reordered, conflicting or corrupt media is not silently
  spliced. Disk-full/network failures retain an interrupted journal; unrecoverable
  gaps/limits stay partial, invalid media stays corrupt. Stop finalizes the local
  available window as partial; Cancel removes only archive-owned staging.
- At recording completion, only the matching completed S20 take permits a bounded
  final-tail drain from the SAME generated live playlist. It requires prior live
  acquisition and ENDLIST, preserves existing metering/leases and accepts at most
  four pending segments. Ordinary replay still rejects finalized playlists. No
  finalized-take index polling is used as a rolling source. Missing final tail
  remains unavailable/partial; provider delivery is not claimed.
- FFmpeg remux and full decode validate the local artifact; ffprobe checks duration.
  Only full contiguous sequence-zero coverage matching the finished take enters
  S20's existing prepare/recover/Library registration. Local completed recovery
  can finish after cloud expiry without a new provider read. Canonical IDs and
  historical timestamps remain unchanged. A shared per-take publication guard
  serializes archive and existing S20 downloads; existing Library files win.
- Play/export/Clean cut/noise cleanup reuse that registered Library session/file.
  Partial/corrupt staging is explicitly excluded from completed Library entries.
  Source recording retention/deletion remains unchanged; cleanup never deletes
  source objects and never recursively removes unknown local files.

## Cross-thread contracts

Stable interface note: `docs/cloud/249-s21c-contract.md`, sent early to S22.
S22 confirmed it adds no SQLite/storage.rs/table change: only pure
`cloud_source_iso.rs` and a mod line, with source objects below `<takePrefix>iso/`.
Archive never writes that prefix. `crate::cloud_archive::claim_take_file(id)` is
the native RAII canonical-file publication guard; pure ISO manifest logic does
not need it. Shared integration files are main.rs and the maintained smoke
case dispatcher; additive changes must survive coordinator reconciliation.

S24 explicitly confirmed that archive reads survive controller transfer.
Account/show/take/ring-generation fences apply; controller epochs fence actual
show commands, not these archive reads. No `controllerFenceResponse` on archive
arm/acquisition/cleanup. S16 pending End/Close acknowledgements and explicit
recording ownership remain intact. Additive S24 integration overlaps are
main.rs, videorc_api.rs and fake-cloud-web-managed.mjs; no peer tree was edited.

Central ledger records S7b [#1448](https://github.com/TheOrcDev/videorc/pull/1448)
(`68c623f07754e755af0def3d9ed24383059bd36f`) open on main, S8 G67rq active,
and S21a #1449/#131 open/unmerged. S21b is not started because S19 is unstarted.
The six coordinator threads were preserved; no new thread was spawned.

## Focused evidence

- Desktop RPC schema tests: **2 passed**; explicit consent, unknown-field refusal,
  truthful partial states and no token/path projection.
- Node migration/registry tests: **11 passed**. SQLite fixture uses an in-memory
  database, runs the additive migration twice, preserves historical timestamps
  and enforces the journal size bound. No real user database was opened.
- Web focused archive/replay/SDK/recording/reaper/ring/lifecycle tests:
  **79 total, 78 passed, one inherited failure**. All **5 archive tests passed**,
  including owner/CSRF/generation authorization, no implicit Record, canonical
  metadata, final-tail-only draining and preservation of default replay refusal.
- Inherited unchanged failure: `tests/cloud-managed-reaper.test.ts:882`,
  "lost, no room and no active egress": revision assertion **7 !== 6**.
  Previously reproduced on untouched source base; not weakened or fixed here.
  The broader known tile-dim assertion was not rerun.
- Desktop node/renderer TypeScript and web TypeScript passed. Scoped oxlint,
  ESLint, Prettier, Rust format and maintained-script syntax checks passed.
  Web emitter `--check` confirms generated program assets are up to date;
  source/generated program modules are unchanged.
- Shadscan fresh baseline/floor: desktop **27/27**, web **47/47**. Final advisory
  scores and unchanged frozen hashes are recorded in the coordinator report.
  No agent commit. No unrelated audit fixes.
- Initial `pnpm ... typecheck` triggered pnpm's automatic up-to-date install/prepare
  wrapper; it produced no manifest/lockfile change. Subsequent scoped checks used
  existing local binaries directly. No provider or credential calls were made.

Logs: `/tmp/s21c-web-final-tests.log`, `/tmp/s21c-node-tests.log`,
`/tmp/s21c-contract-tests-final.log`, `/tmp/s21c-desktop-node-types-final.log`,
`/tmp/s21c-desktop-web-types-final.log`, `/tmp/s21c-web-types-verified.log`,
`/tmp/s21c-desktop-lint.log`, `/tmp/s21c-web-lint.log`.

## Maintained acceptance and deferred gates

`pnpm smoke:cloud-parity -- --case archive` is implemented and **NOT RUN**.
It first captures real program-tab video plus final mixed audio through S21a's
maintained acquisition, then serves those actual captured media segments through
an injected loopback account API to the REAL native archive coordinator. It
checks explicit independent Record, live download, app kill/relaunch, explicit
resume, bounded network loss, no duplicate Library session, canonical start,
owned staging discard, unrecoverable gap, final-artifact ffprobe/analyzer gates,
actual host/guest/aux tones and host/guest/card pixels. Its local simulated
qualification is never installed into production or counted as provider proof.

Maintained Rust unit tests cover sequence/clock/byte bounds, fractional HLS
clocks, replaced-file preservation, journal restart facts and shared publication
claims. **Rust compilation/tests were not run**, per the full-build restriction.
Rust format parses syntax but is not a Rust type or runtime check.

Still deferred: real-app/native journal/crash/disk-full/cancel acceptance,
real-page/device/managed acquisition, provider pre-finalization and final-tail
availability, artifact/clock/A/V/cost qualification, full D/B/N/W/C/R suites,
recording-studio/record-latency gates and platform acceptance. No enabled replay
or archive capability is claimed. User explicitly prohibits these executions
for this checkpoint. Missing evidence remains not-run, never passed/qualified.

## Desktop PR-ready text

Title: **Plan 249 S21c: add gated local cloud-program archive and Library recovery**

Body: Add explicit optional local archive controls and a bounded native downloader
for S21a program segments. Persist recovery/file ownership, fence account/show/
take/generation, validate remuxed media, and register only complete canonical
takes through S20 Library workflows without duplicate publication. Stop/cancel
operate on the local archive; cloud recording remains independently owned.
Document cloud/network dependence, partial/corrupt outcomes and bounded costs.

Validation: 2 desktop RPC tests and 11 Node migration/registry tests pass;
TypeScript, scoped lint/format and Rust syntax formatting pass. Maintained actual
program/restart/loss/pixel/audio acceptance is added but not run. Rust compilation,
smoke/device/heavy/managed acceptance remain deferred; production stays gated.
Base: S21a desktop #1449. Link the paired S21c web PR after creation.

## Web PR-ready text

Title: **Plan 249 S21c: expose authorized archive facts and bounded final-tail drain**

Body: Add the owner-session archive API over the existing gated S21a ring. Project
canonical S20 take metadata without storage keys, preserve generation/auth/quota
checks, and allow bounded final-tail acquisition only for an already acquired
live source and its matching completed take. Ordinary replay still refuses
finalized playlists. No recording activation, extra egress, grant expansion,
source deletion or recording-retention change.

Validation: 79 focused tests, 78 pass; the unchanged inherited reaper revision
assertion remains failing (7 !== 6, line 882). All 5 archive tests pass; TypeScript,
scoped lint/format and generated-asset consistency pass. No managed/provider,
smoke/heavy or media acceptance executed. Production qualification remains false.
Base: S21a web #131. Link the paired S21c desktop PR after creation.

## Exact desktop paths (21)

- `apps/desktop/src/renderer/src/components/tabs/library-cloud-archive.tsx`
- `apps/desktop/src/renderer/src/components/tabs/library-cloud-recordings.tsx`
- `apps/desktop/src/shared/backend-rpc-contract.ts`
- `apps/desktop/src/shared/backend.ts`
- `apps/desktop/src/shared/cloud-archive-contract.test.ts`
- `crates/videorc-backend/src/cloud_archive.rs`
- `crates/videorc-backend/src/cloud_control_web.rs`
- `crates/videorc-backend/src/main.rs`
- `crates/videorc-backend/src/storage.rs`
- `crates/videorc-backend/src/storage/cloud_archives.rs`
- `crates/videorc-backend/src/storage/cloud_archives.sql`
- `crates/videorc-backend/src/videorc_api.rs`
- `docs/cloud/249-execution-ledger.md`
- `docs/cloud/249-s21c-contract.md`
- `docs/cloud/249-s21c-handoff.md`
- `protocol-fixtures/cloud-parity-plan.json`
- `scripts/lib/cloud-parity-archive.mjs`
- `scripts/lib/cloud-parity-archive.test.mjs`
- `scripts/lib/cloud-parity-baseline.mjs`
- `scripts/lib/fake-cloud-web-managed.mjs`
- `scripts/smoke-cloud-parity-app.mjs`

## Exact web paths (8)

- `app/api/cloud/shows/[id]/archive/route.ts`
- `docs/cloud/249-s21c-contract.md`
- `docs/cloud/249-s21c-handoff.md`
- `lib/cloud/replay/archive-route.ts`
- `lib/cloud/replay/archive.ts`
- `lib/cloud/replay/managed.ts`
- `lib/cloud/replay/provider.ts`
- `tests/cloud-archive.test.ts`
