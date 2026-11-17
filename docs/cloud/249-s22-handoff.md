# Plan 249 S22 handoff: opt-in cloud ISO recording

## Status

Source-complete for S22 behind `productionQualified: false`, rebased onto
current main on 2026-11-17 (the earlier Plan 249 batch, S21c included, is
merged). Nothing is committed, pushed, published or deployed. Production
refuses enabling with `409 not-qualified` and writes nothing; no environment
variable can supply qualification. Smoke, app, real-page, managed, build and
Rust backend compilation are **not run** (user instruction). Measured cost,
concurrency, provider clock and the owner decision D8 remain deferred.

Ownership: S22 thread G1wkh, resumed after the Codex successor G2anc
relinquished it. Every G2anc change was kept and is included below.

| Repository | Publication worktree                                  | Branch                             | Base (parent)                                                                                              |
| ---------- | ----------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Desktop    | `/Users/orcdev/projects/videorc-wt-249-s22`           | `feat/249-s22-cloud-parity`        | desktop main `4ff715681` (after #1450)                                                                     |
| Web        | `/Users/orcdev/projects/videorcweb-wt-249-s22-on-s24` | `feat/249-s22-cloud-parity-on-s24` | S24 web `db7ce88e5de3e2f878ccf0be3d57c1aaeb08cebb` (`publish/249-s24-on-main`, parent web main `ab811051`) |

The web publication tree is stacked on the exact S24 web tip and has the S24
fence wired. The earlier web tree `/Users/orcdev/projects/videorcweb-wt-249-s22`
(on web main `ab811051`, no fence) is kept untouched as a fallback. The
desktop needs nothing from S24: it stays on main and trial-merges clean with
S24's committed desktop `7c2e0ed519417a4132c6670a982907d4b80b1ddd` (six shared
files, no conflicts). Land S24 first, then S22 web, then S22 desktop.

The desktop branch was moved forward (fast-forward of the local branch only,
never pushed) and S22's working changes reapplied with a 3-way apply; there
is no `MERGE_HEAD` any more. Each tree commits as one S22 commit on main.
Resolved overlaps with main: desktop `storage.rs` (S15's `cloud_speech`
module beside `cloud_source_iso`) and `smoke-cloud-parity-app.mjs`; web
`db/schema.ts` and `media-store.ts` (S21a's replay ring fields beside the ISO
ones). S22's earlier mock change to `library-cloud-recordings.test.ts` is
already on main, so that file is no longer S22's. Ignored dependency links
(`node_modules`, `apps/desktop/node_modules`) point at the S3 worktrees: do
not stage them. Backups of the pre-rebase trees and patches:
`/Users/orcdev/cloud-parity-scratch/s22-backup-101841-premain`, the web tree
before stacking on S24 in `s22-backup-103628-pre-s24`, and the first
checkpoint in `s22-backup-234413`.

Frozen cross-repo contract: `docs/cloud/249-s22-contract.md` (desktop).

## What S22 implements

**Manifest v1 (web, desktop TS, Rust).** One file per stable role
(`host-camera`, `host-microphone`, `host-aux`, `host-screen`, `guest-camera`,
`guest-microphone`, `guest-screen`, `guest-screen-audio`) and publication
generation, bound to the canonical S20 program take (`tk_…`) and copied S16
interval ids. Roles come from SFU facts only (identity, source, kind). Host
aux needs the exact S3 name and is the combined S3 soundboard + S8 system aux,
never separate stems and never folded into a microphone. Clock: origin =
program take start, basis `provider-egress-start`, uncertainty `unmeasured`.
`frameLayout` is versioned: the host camera is always `unknown` (basis
`unavailable`) in v1, and S13a's track-name descriptor is kept only as an
untrusted `declared` claim. Other video roles are opaque by role. The shared
fixture `protocol-fixtures/cloud-source-iso.json` (identical to web
`tests/fixtures/`) has `valid` plus 23 fail-closed mutations, accepted or
refused identically by all three parsers.

**Web durable runtime (`lib/cloud/iso/`).**

- State `CloudShowMediaStateJson.iso` (JSON field, written only through
  `mediaStore.media.mutate`) under a 30 s ISO lease. The strict reader refuses
  an unreadable state instead of repairing it.
- Admission (`admission.ts`, `http.ts`), in order: explicit host consent
  (`iso-consent-v1`), a live managed talk show, plan entitlement (Max only, a D8
  proposal), caps (≤12 active, ≤180 min, ≤$5), then qualification. Published
  LiveKit raw-track-egress facts read 2026-11-16.
- Orchestrator: every new generation is persisted as `starting` before the
  provider call. Its cost to the deadline and one project export slot are
  reserved first in a transactional database reservation (`reservations.ts`,
  `reservation-store.ts`, migration `0042_cloud_iso_reservations.sql`: a
  global admission row lock; reservations are never released by elapsed time,
  only by a definite refusal or a provider terminal answer). The write-only
  key is minted and recorded before use. A lost answer is adopted by the next
  worker (matched by track SID and the take's output path) or settled as
  `start-unknown`. Stray track egresses for the take are stopped (bounded;
  only track egresses, so program and S21a replay egresses are never
  touched). Stop failures keep their accounting. Roles fail in isolation, and
  a consent withdrawal stops that guest's files.
- Ticks: the owner route, LiveKit webhooks (track, egress,
  `participant_left`, `room_finished`), the reaper per open show, and a
  bounded reaper pass over ended shows (`listShowsWithIso`), so keys and
  files settle after End. That list holds only rows with work left (keys,
  unstopped takes, open, unknown or failed-stop entries, a partial file
  still finalizing), the same rule as the tick's own check, so settled shows
  never crowd out real work. Once a show has ended, a request alone is no
  work, and a stopped take past its expiry is no work (reads judge expiry by
  time), so a settled show is never written again.
- Routes: `GET/POST /api/cloud/shows/:id/iso` (status; enable, disable,
  reconcile; disabling a show that never had ISO writes nothing) and `GET …/iso/file` (owner-only 10-minute signed GET of one
  file, with `frameLayout` and `partial`). Disabling clears guest consents.
- S24 controller fence seam: `IsoHttpDeps.controllerCommand` wraps enable,
  disable and reconcile (`iso-enable`, `iso-disable`, `iso-reconcile`) after
  the owner and body checks. Reads, the file route, guest consent and server
  ticks are never fenced. Production wires S24's real `withControllerCommand`
  in `app/api/cloud/shows/[id]/iso/route.ts` (below).
- Guest consent: `POST/GET /api/guest/:slug/iso-consent` (guest cookie, let-in
  row, same-origin, rate budgets), an optional `iso` projection on the guest
  show read, and a shadcn consent card in the guest room.

**Desktop.**

- Rust: `cloud.iso.{status,enable,disable,import,imports,cancelImport}` RPCs
  (`main.rs`, `cloud_control_web.rs`) sent through the shared `cloud_send`, so
  S24's held epoch header applies, and S24's 409 `cloud-controller-stale` or
  `cloud-controller-required` becomes `cloud-iso-controller` ("Another device
  controls this show now. Continue here first."); strict manifest re-validation; an import job
  with a per-take journal (`storage/cloud_source_iso.{rs,sql}`: tables
  `cloud_iso_imports` and `cloud_iso_import_files`), bounded staged downloads,
  no-overwrite publish and restart recovery; Library rows written under S21c
  `claim_take_file(programRecordingId)` with take role `iso:<role>` and
  `cloudIso` diagnostics. Layout-unknown files stay registered and recoverable
  through the ISO journal but get no generic Library playback path.
- Renderer: a Guests tab "Separate files" opt-in (confirm dialog, required
  consent box, cost estimate, disabled reasons, live per-file and per-guest
  status, refusal reasons) and a Library "Separate files" block under each
  matching cloud recording (import, progress, partial, overlap and
  layout-unknown badges; no preview for an unknown layout). Strict RPC
  contract entries.

**Maintained acceptance `pnpm smoke:cloud-parity -- --case iso` (authored, not
run).** The real desktop app (`managedHarness('talk')`) publishes the host
camera (red Y4M), the S7b native microphone (440 Hz, switched mid-take through
the real device switch to 880 Hz: new SID, new generation) and the S3 aux
(1 kHz). Three real GuestRoom guests publish unique colours and tones with a
4 s wall-clock marker; two consent through the real card and
`handleGuestIsoConsent`, one declines, and one consenting guest's camera start
is refused. The real program page is tab-captured with its final mix as the
take's mixed program. The real `handleIsoHttp` and `handleIsoFile` run behind
the fake web over the web's in-memory store twin, with qualification evidence
injected as a dependency (never from env). The desktop enables, imports and is
checked through its real RPCs, Library rows and `sessions.list`. The analyzer
requires: roles and generations, the isolated failure, consent refusals, each
file's own colour or tone only (aux never in a microphone), duration, guest
markers on the wall-clock grid (p95 ≤ 250 ms), every on-stage source in the
program, guest ISO markers mapped onto the program (p95 ≤ 400 ms), host camera
layout unknown and flagged, owner and stranger routes, sha256 equality, keys
revoked and a clean shutdown.

## Not qualified and fixture boundaries (named, not passed)

- Local `livekit-server --dev` has no Egress service, so a hidden `EG_`
  MediaRecorder page stands in for raw track egress. Managed availability,
  metering (raw track versus transcode), concurrency, `egress_ended`
  behaviour, the 12 h `LIMIT_REACHED`, the file container, S3 compatibility of
  `DirectFileOutput` with the Neon branch and provider clock accuracy are all
  unmeasured.
- The fake web rewrites the signed `*.neon.tech` branch origin to a loopback
  HTTPS storage server that verifies the real signature.
- The program take id is fixture-allocated, and the program artifact is a tab
  capture, not a provider HLS take. Desktop Y4M/WAV/native loops carry no
  wall-clock markers, so host files are judged on uniqueness, generations and
  duration only.
- Not publishable locally: an unnamed host screen-audio refusal and a guest
  screen role (listed under `notExercised`).
- S13a's trusted layout descriptor does not exist yet (v1 stays
  `unknown`).

## Coordination (public contracts)

- S7b (G67rq): the host mic is always `Track.Source.Microphone`; a device,
  mode or offset change is a new SID and so a new ISO generation; gain, mute
  and noise keep the SID.
- S8 (G67rq): system PCM joins the single host aux publication; ISO records
  the combined aux, never separate stems.
- S21c (G55dg): `claim_take_file(id)` is keyed by the canonical `rec_…` id; no
  shared tables; S22 adds its own SQLite tables.
- S13a (G7e0v): the `host-camera` role is agreed; an opaque/packed switch must
  be a new SID; the track-name descriptor is recorded as untrusted only; v1
  does not consume the native clock anchor (a future v2 field must carry the
  origin and the incarnation).
- S17 (G98zv): ISO never reuses the program output profile or its
  qualification and never touches `maxProgramEgresses`. ISO counts its own
  exports against provider-observed project exports plus its reservations.
  ISO keeps its own published raw-track price for cost-ceiling admission
  (labelled published, never a bill, never in `show.outputProfile`).
- S24 (G1q9i): the fence seam above. ISO is not added to `needsEnable`: a
  takeover stays within the same account, ISO keeps its consent, caps and
  deadline, and the new controller can disable it. S24 confirmed (2026-11-17):
  no collision in `db/schema.ts` (S24 adds three tables only) or migrations
  (S24 `0041`, S22 `0042`). The seam was agreed with S24 on 2026-11-17 and is
  now wired against S24's published module (below).

## S24 controller fence: wired

The web publication branch is stacked on S24's published web tip
`db7ce88e5`, so the fence is wired against the real module. The route
passes its commands through S24's fence:

```ts
import { withControllerCommand } from "@/lib/cloud/media/controller-fence";
// in handleIsoHttp's dependencies:
controllerCommand: (r, id, what, run) =>
  withControllerCommand(r, id, {}, what, run),
```

Enable, disable and reconcile now need the show's current controller epoch
once the show has a controller row. A missing header answers `409
cloud-controller-required`, and a stale epoch answers `409
cloud-controller-stale`. Neither writes ISO state or calls the provider. A
show nobody claimed keeps the behaviour from before S24. Reads, the file
route, guest consent and server ticks are not fenced. Both `reconcile.ts`
imports are kept: S24's `dbCloudPresentationStore` and S22's
`isoTickFromContext`. Migrations are S24 `0041` then S22 `0042`. ISO stays out
of `needsEnable`. On the desktop, S24's `fence_epoch` covers
`/api/cloud/shows/<held>/iso`, and S22 maps the two refusals to
`cloud-iso-controller`.

## Verification run (2026-11-17)

- Web, on the stacked S24 tree: ISO tests `tests/cloud-iso*.test.ts`
  **41/41**. That includes the production wiring run over S24's real
  `withControllerCommand` and its in-memory controller store
  (`tests/fixtures/cloud-presentation-kit.ts`): an unclaimed show passes; a
  missing epoch answers `cloud-controller-required`; a stale epoch answers
  `cloud-controller-stale` with no state write and no provider call; reads
  pass; the current epoch runs and its command is unregistered. S24's own
  `cloud-controller-handoff` and `cloud-presentation-views` suites, with the
  webhook, reaper, managed store/state/replay/ended-cleanup/talk and guest
  suites: **182/187**. The same 5 fail identically on the pristine S24 tip
  `db7ce88e5`, run from a `git archive` export in scratch
  (`lost, no room and no active egress…`, `the recorded sequence…`,
  `a show that ends during a wait…`, `end: no feed never ends a talk show…`,
  `room_finished during a hold…`). They also fail on web main `ab811051`.
  `tsc --noEmit` covers the route wiring against the real module; scoped
  ESLint, Prettier and `emit.ts --check` are clean. The `listShowsWithIso`
  SQL was run against a scratch PostgreSQL with nine rows: it lists exactly
  the five with work.
- Desktop: both `tsc` projects clean; focused vitest **51/51** (8 ISO and
  Library files) plus shared contract suites **194/194** (3 files);
  `node --test scripts/lib/cloud-parity-*.test.mjs` **69/69**; scoped Oxlint,
  Prettier, em-dash and text-file gates OK; `cargo fmt --check --all` OK; the
  fixture is byte-identical across repos.
- Rust: the pure model compiled earlier, with tests and clippy clean, in a
  scratch crate. The backend crate itself was **not compiled**. Unverified
  compile surfaces: the `main.rs` arms, startup and shutdown lines; the
  `cloud_control_web.rs` ISO client, job and the new `cloud-iso-controller`
  arm and test; `storage/cloud_source_iso.rs` against the real `Database`.
- Shadscan (`pnpm dlx @shadscan/cli@next --json`): desktop **27 → 27**, web
  **47 → 47** (floors held).
- Pre-existing, not S22: `fake-cloud-web-managed.mjs:58` `no-control-regex`
  is on main.

## Exact desktop paths (31)

```
apps/desktop/src/renderer/src/components/guests/cloud-iso-section.test.ts
apps/desktop/src/renderer/src/components/guests/cloud-iso-section.tsx
apps/desktop/src/renderer/src/components/guests/guests-tab.test.ts
apps/desktop/src/renderer/src/components/guests/guests-tab.tsx
apps/desktop/src/renderer/src/components/tabs/library-cloud-iso.test.ts
apps/desktop/src/renderer/src/components/tabs/library-cloud-iso.tsx
apps/desktop/src/renderer/src/components/tabs/library-cloud-recordings.tsx
apps/desktop/src/renderer/src/lib/cloud-iso-view.test.ts
apps/desktop/src/renderer/src/lib/cloud-iso-view.ts
apps/desktop/src/shared/backend-rpc-contract.ts
apps/desktop/src/shared/backend.ts
apps/desktop/src/shared/cloud-iso-contract.test.ts
apps/desktop/src/shared/cloud-source-iso.test.ts
apps/desktop/src/shared/cloud-source-iso.ts
crates/videorc-backend/src/cloud_control_web.rs
crates/videorc-backend/src/cloud_source_iso.rs
crates/videorc-backend/src/main.rs
crates/videorc-backend/src/storage.rs
crates/videorc-backend/src/storage/cloud_source_iso.rs
crates/videorc-backend/src/storage/cloud_source_iso.sql
crates/videorc-backend/src/videorc_api.rs
docs/cloud/249-s22-contract.md
docs/cloud/249-s22-handoff.md
protocol-fixtures/cloud-source-iso.json
scripts/lib/cloud-parity-iso-contract.mjs
scripts/lib/cloud-parity-iso-contract.test.mjs
scripts/lib/cloud-parity-iso-pages.mjs
scripts/lib/cloud-parity-iso-web.mjs
scripts/lib/cloud-parity-iso.mjs
scripts/lib/fake-cloud-web-managed.mjs
scripts/smoke-cloud-parity-app.mjs
```

## Exact web paths (34)

```
app/api/cloud/shows/[id]/iso/file/route.ts
app/api/cloud/shows/[id]/iso/route.ts
app/api/guest/[slug]/iso-consent/route.ts
app/api/guest/[slug]/route.ts
components/guest/guest-room.tsx
components/guest/iso-consent-card.tsx
components/guest/iso-consent-copy.ts
db/migrations/0042_cloud_iso_reservations.sql
db/schema.ts
docs/cloud/249-s22-handoff.md
lib/cloud/iso/admission.ts
lib/cloud/iso/consent.ts
lib/cloud/iso/guest-route.ts
lib/cloud/iso/hooks.ts
lib/cloud/iso/http.ts
lib/cloud/iso/manifest.ts
lib/cloud/iso/orchestrator.ts
lib/cloud/iso/reservation-store.ts
lib/cloud/iso/reservations.ts
lib/cloud/iso/roles.ts
lib/cloud/iso/route.ts
lib/cloud/iso/runtime.ts
lib/cloud/iso/state.ts
lib/cloud/iso/track-egress.ts
lib/cloud/iso/wiring.ts
lib/cloud/media/media-store.ts
lib/cloud/media/reconcile.ts
lib/cloud/media/webhook.ts
lib/cloud/talk-route.ts
tests/cloud-iso-consent.test.ts
tests/cloud-iso-reservations.test.ts
tests/cloud-iso-runtime.test.ts
tests/cloud-iso.test.ts
tests/fixtures/cloud-source-iso.json
```

Migration `0042` deliberately follows S24's reserved `0041`. The runner
applies by filename with a name ledger, so either landing order works.

## Desktop PR-ready text

Title: **Plan 249 S22: opt-in cloud ISO recording (desktop, disabled)**

Body: Adds the desktop half of opt-in cloud ISO:

- A strict manifest v1 in Rust and TS, with a shared fixture of 23 fail-closed
  cases and a versioned camera layout that never trusts a track name.
- `cloud.iso.*` RPCs over the shared cloud sender, so S24's controller epoch
  header applies, and a stale or missing epoch reads as "another device
  controls this show".
- A per-take import journal with bounded staged downloads, no-overwrite
  publish, restart recovery, and Library rows under S21c's take claim.
- The Guests tab opt-in, with explicit consent and a cost estimate, and the
  Library "Separate files" section.
- The maintained `--case iso` acceptance, which drives the real desktop app,
  guests, mixed program page and web runtime.

Production stays disabled until managed cost, concurrency and clock are
measured (D8).

Validation: 51 focused vitest and 194 shared contract tests, 69 parity
script tests, both typechecks, scoped Oxlint, Prettier and gates, and
`cargo fmt`. The Rust backend compile, smoke and managed runs were not run,
per instruction.

Base: desktop main `4ff715681`. Land after S24 and the paired S22 web PR;
it merges clean with S24 desktop `7c2e0ed51`. Paired web PR: link here.
Shadscan 27 → 27.

## Web PR-ready text

Title: **Plan 249 S22: opt-in cloud ISO orchestration (disabled)**

Body: Adds durable, lease-guarded ISO orchestration on the managed show row:

- SFU-derived roles; host aux is recognised only by its exact S3 name.
- A strict manifest bound to the program take.
- Admission: consent, plan, caps and cost.
- Transactional per-source reservations (migration 0042).
- Every start persisted before the provider call, recovery of unknown
  starts, and bounded track-egress cleanup.
- Key minting and revocation.
- Webhook and reaper ticks, including an ended-show pass that lists only
  rows with work left.
- An owner status and action route whose enable, disable and reconcile run
  under S24's controller fence (`withControllerCommand`).
- A signed per-file read, plus the guest consent API and card.

Production answers `not-qualified` and writes nothing.

Validation: 41 ISO tests, including the route wiring over S24's real fence
and in-memory controller store. S24's controller suites and the neighbouring
managed and guest suites are unchanged (182/187); the same 5 fail on the
pristine S24 tip. TypeScript, ESLint,
Prettier and the emitter check pass, and the ended-show listing SQL was
checked against a scratch PostgreSQL. No provider calls or managed runs.

Base: S24 web `db7ce88e5` (`publish/249-s24-on-main`, on web main
`ab811051`); retarget to main once S24 merges. Migration `0042` follows S24's
`0041`. Paired desktop PR: link here. Shadscan 47 → 47.
