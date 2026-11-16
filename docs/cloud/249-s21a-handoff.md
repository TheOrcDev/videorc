# Plan 249 S21a: bounded authorized program segment ring

## Status and bases

Implementation prepared for paired coordinator publication; local real-page and
managed qualification **not run**. Production remains disabled. No commits,
pushes, PRs, merges, provider requests, paid egress, deployments or real database
migrations made by this agent. No dedicated S21a issue or PR found; null issue
mappings are intentional.

| Repository | Worktree                                        | Branch / intended PR base                                  | Exact HEAD/base                            |
| ---------- | ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| Desktop    | `/Users/orcdev/projects/videorc-wt-249-s21a`    | `feat/249-s21a-cloud-parity` / `feat/249-s20-cloud-parity` | `d3f6a6dcb92c6fa17c166806a64ed1536d44416c` |
| Web        | `/Users/orcdev/projects/videorcweb-wt-249-s21a` | `feat/249-s21a-cloud-parity` / `feat/249-s20-cloud-parity` | `3c72571af05ab374dca752a4616278d85043e26a` |

Prerequisites: desktop [S20 #1443](https://github.com/TheOrcDev/videorc/pull/1443),
web [S20 #129](https://github.com/TheOrcDev/videorc-web/pull/129), including S16,
S4, S3 and S2. Published branches/shared active checkouts are preserved. The
independent YouTube emote checkout/thread G4z27 was not touched. Dependencies
are inherited without changing identities, migrations, output-token claims or
pending-End acknowledgements.

## Contract and rollout

- `ProgramRing` is a concrete bounded byte store, manifest, window selector and
  read meter. It requires explicit local-fixture consent, forbids provider calls,
  and accepts only a zero provider-cost ceiling. There is no production enable
  environment variable. These local permit facts are not managed price evidence.
- The managed session API at `GET /api/cloud/shows/:id/replay-ring` reports
  `enabled:false`, `productionQualified:false`, provider adapter `unimplemented`,
  pre-finalization support `unavailable`, cost/clock/active-egress/recording
  prerequisites `unmeasured`. POST refuses with 409. No recording starts, URLs,
  credentials, grants or storage keys are minted. A query requesting media from
  this unqualified production endpoint returns 409, never invented segments.
- Reads use the existing owner session and show lookup. Missing session is 401;
  cross-owner/show is 404; expired show, stale generation or evicted media is 410. Responses are private/no-store. Guests/program page tokens cannot read
  replay bytes. The loopback harness injects its session fixture into the same
  handler; no new production credential authority exists.
- Manifest v1 binds owner internally plus show, generation, orientation, output
  lane, optional canonical S20 take and typed S16 `LiveInterval`. It clones these
  values; it never allocates either identity. Record-only/no-stream scope has no
  interval. Generation is an independent random acquisition epoch, not a live
  interval or take ID. New source/clock epochs require a new ring/directory.
- Clock exposes segment sequence, media-relative start/end, HLS program date-time
  origin and unknown uncertainty. Muxer HLS independent-segment flags are declared
  metadata, not decoding proof. No correlated A/V p95 or provider-clock accuracy
  is inferred. Deferred packet/artifact validation independently examines media.
- Hard ceilings: 64 MiB retained, 90 seconds media span and idle-read expiry,
  64 segments, 8 MiB/10 seconds per segment, five-minute acquisition lease,
  256 MiB cumulative acquisition and 256 MiB reads. Callers may only lower limits.
  Retries are idempotent; conflicting bytes, sequence gaps/rewinds and clock jumps
  fail closed. Acquisition-budget exhaustion clears owned bytes; read-budget
  exhaustion refuses further transfer. Metering counts actual retained/acquired/
  served bytes; managed cost remains null.
- `LocalHlsAdapter` reads atomically published growing MPEG-TS HLS playlists
  before ENDLIST. It rejects remote paths, traversal, symlinks, encryption,
  byte ranges, discontinuities and oversized files/playlists. No HTTP ingest or
  arbitrary filesystem read API is exposed. Only the harness supplies its private
  generation directory. Polling is serialized; stale callbacks are fenced by the
  ring. Cleanup is explicit during polling/disposal and expiry is enforced on
  every read, even without a poll. Ring eviction deletes only copied buffers;
  disposal removes only recognized local generation-owned muxer files after its
  process stops, never original recording/provider objects.

## Maintained acquisition and analyzer (not executed)

After authorization to run acceptance, from an installed desktop checkout with
its already-built fixture app and a clean, installed paired web revision:

```sh
VIDEORC_PARITY_WEB_ROOT=/path/to/clean/paired/web pnpm smoke:cloud-parity -- --case replay-ring
```

The case uses the existing isolated local SFU, actual publisher, actual guest
components and actual program page. It opts into S3 aux only in that fixture,
keeps host monitor off, loops the real soundboard tone and adds a real card.
A Chrome tab capture records program pixels; one MediaRecorder combines that
video track with the real final program audio bus. No speaker/system capture,
fake muxed output, screenshot animation or post-hoc audio alignment is used.
Capture must identify itself as a browser surface; unavailable tab capture fails
explicitly. The browser still observes loopback network restrictions.

Bounded chunks flow with backpressure to one owned FFmpeg process. Its rolling,
atomic HLS playlist is ingested while the recorder is still running; failure to
observe a pre-finalization segment fails acceptance. The local HTTP fixture then
fetches a known retained window, checks authorization, byte/time/count bounds,
expired access and content hashes, and reconstructs MP4 from those actual bytes.
Capture is capped at 18 seconds, input at 128 MiB, muxer runtime at 45 seconds and
source files at 32 MiB; the acceptance ring lowers retention to eight seconds,
four segments and 16 MiB. Owned capture/process/server/source files are cleaned.
Reconstructed artifacts and reports live only in the existing harness run dir.

The analyzer decodes the reconstructed file, requires all host/guest/aux tones,
prohibited system stem below -60 dBFS, actual camera/card pixels, first-keyframe
segments, continuous packet clocks and agreement with manifest duration. Existing
artifact gates remain intact; A/V edge thresholds are tightened to 80 ms. Edge
skew and packet-clock checks are **not** correlated A/V p95, which remains
unmeasured. No live result or release qualification is inferred from unit tests.

## Focused verification

Executed without browser/device/provider/FFmpeg or app launch:

- Web: `node --import tsx --test tests/cloud-program-ring.test.ts tests/cloud-recording-lifecycle-integration.test.ts`: **14 passed**, covering bounds,
  expiry, retry/epochs, auth/consent/budgets, strict local acquisition, canonical
  S16/S20 projection and existing output-claim preservation.
- Desktop: `node --test scripts/lib/cloud-parity-ring-clock.test.mjs scripts/lib/cloud-parity-contract.test.mjs scripts/lib/cloud-parity-media.test.mjs`:
  **16 passed**, including packet-clock failures and all 32-slice registry checks.
- Web TypeScript `tsc --noEmit --incremental false`, scoped ESLint; desktop scoped
  Oxlint and MJS syntax; scoped formatting and diff whitespace checks.
- `node --import tsx lib/cloud/program/tools/emit.ts --check`: generated program
  assets up to date; no source/generated program modules changed.
- Shadscan advisory baseline/floor: desktop **27/27**, web **47/47**. Same audit
  command `pnpm dlx @shadscan/cli@next --json`; final frozen-diff scores are reported
  at handoff. No unrelated audit findings fixed, no dependency installs/config.

No failing focused checks observed. Known inherited web `.tile-dim` assertion and
desktop use-studio recording-dependency lint warning were not reclassified or
fixed; their broader suites were not run for this slice.

## Deferred gates / unresolved production contract

All smoke, real-page, device, managed, runtime/artifact acceptance, heavy tests,
Rust compilation/tests and builds are **not run**, per explicit user instruction.
In particular the maintained replay-ring command above has not been executed.
No availability, continuity, graphics correctness, clock precision or cost has
been measured in managed output. Before any production enablement, qualify an
actual authorized provider segment adapter, active-egress versus recording
prerequisites, persistent/distributed ring ownership and cleanup, storage/egress
metering, monetary ceilings and explicit opt-in; then perform real mixed-program
artifact/clock/correlated A/V tests. Do not use finalized S20 take listing as
proof of rolling availability. Until then S21b may consume the disabled contract
but cannot claim cloud Clips. No native camera-owning replay was started.

## Exact desktop paths

- `docs/cloud/249-execution-ledger.md`
- `docs/cloud/249-s21a-handoff.md`
- `protocol-fixtures/cloud-parity-plan.json`
- `scripts/lib/cloud-parity-baseline.mjs`
- `scripts/lib/cloud-parity-replay-ring.mjs`
- `scripts/lib/cloud-parity-ring-clock.mjs`
- `scripts/lib/cloud-parity-ring-clock.test.mjs`
- `scripts/smoke-cloud-parity-app.mjs`

## Exact web paths

- `app/api/cloud/shows/[id]/replay-ring/route.ts`
- `docs/cloud/249-s21a-handoff.md`
- `lib/cloud/replay/local-hls.ts`
- `lib/cloud/replay/ring.ts`
- `lib/cloud/replay/route.ts`
- `tests/cloud-program-ring.test.ts`

## Desktop PR-ready text

Title: **Plan 249 S21a: acquire and analyze a bounded local program ring**

Body:

Add the maintained `replay-ring` acceptance case: capture actual program tab
pixels and final mixed audio, ingest growing HLS before capture finalizes,
reconstruct an owner-authorized retained window, and analyze decoded media,
keyframes, clocks and retention. Update all central slice mappings with S20/S7a
publication and current parallel ownership. The web ring is the paired change;
link its coordinator-created PR here. Base: S20 desktop #1443.

Validation: 16 focused helper/registry/media tests, scoped syntax/lint/format and
diff checks. Acceptance source is implemented but **not run** under the explicit
no-smoke/heavy instruction. Managed segment support, cost and correlated A/V
remain unmeasured; production remains disabled. No provider calls or recording
activation. No dedicated issue exists. Frozen Shadscan score is in the handoff.

## Web PR-ready text

Title: **Plan 249 S21a: bound and authorize program segment buffering**

Body:

Add a concrete local growing-HLS adapter and bounded generation-scoped byte ring,
clock manifest, window selection, retention and I/O metering. Read only through
the existing owner/show session boundary; refuse cross-show, stale or expired
media. The production route reports unavailable provider support and unmeasured
cost, refuses activation and never starts recording/egress. Preserve S20 take
and S16 interval identities without schema changes. Link the paired desktop
acquisition/analyzer PR here. Base: web S20 #129.

Validation: 14 focused ring/lifecycle tests, TypeScript, scoped lint/format,
generated program consistency and whitespace checks. Actual acquisition/artifact,
real-page/device/managed and heavy acceptance **not run**. Managed adapter,
persistent ownership, clock and cost must be qualified before any enablement.
No dedicated issue exists. Frozen Shadscan score is in the handoff.
