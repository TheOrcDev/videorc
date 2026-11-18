# Plan 249 S21a: managed provider source integration

## Current checkpoint

The production-provider **source path is implemented**. Provider availability,
latency, pixels/audio/continuity, cost and clock qualification are **not run**.
`MANAGED_REPLAY_POLICY` remains `qualified:false, price:null`; no environment or
client parameter enables it. This is not a claim that managed replay works live.

Groundwork desktop [#1446](https://github.com/TheOrcDev/videorc/pull/1446)
(`f33270b7202de4ce9f6d78ad0d253ffe0b4a9fc6`) and web
[#130](https://github.com/TheOrcDev/videorc-web/pull/130)
(`158371bf6cc04aac27d135dc273d1f2b6d92ab5b`) are merged. All earlier desktop
#1437–1447 and web #125–130 are merged per coordinator, including accepted
S18/S7a integration resolutions. Live acceptance remains **not run**.

Fresh branch **`feat/249-s21a-managed-replay`** in each repository starts directly
from fetched current main. Followup changes are uncommitted and unstaged;
indexes match HEAD, with no unmerged entries or merge/rebase/cherry-pick state.
No commit, push, PR, merge, provider call, credential configuration access,
migration or deployment was performed by this agent.

| Repository | Fresh isolated worktree                                        | HEAD / diff base / eventual commit parent  |
| ---------- | -------------------------------------------------------------- | ------------------------------------------ |
| Desktop    | `/Users/orcdev/projects/videorc-wt-249-s21a-managed-replay`    | `dda61b03ef52a97bd74a6796a2a0032d480878e5` |
| Web        | `/Users/orcdev/projects/videorcweb-wt-249-s21a-managed-replay` | `59fb8ba6c3cd9559523c5d320bad2065f3cdce1d` |

Existing HEAD commit parents (not newly created commits):

- Desktop: `7543d0c3ddb87165b6c2ee60f19d8fb069e73467`, `84934688773813567b168bda90b502f9c7721dc3`.
- Web: `927180137961f46fd49571ab7fa1b90642db8ccd`, `158371bf6cc04aac27d135dc273d1f2b6d92ab5b`.

Original dirty trees `/Users/orcdev/projects/videorc-wt-249-s21a` and
`/Users/orcdev/projects/videorcweb-wt-249-s21a`, both on
`feat/249-s21a-cloud-parity`, remain preserved at the groundwork tips above.
Frozen patches, indexes and full changed/untracked files are backed up under
`/Users/orcdev/projects/videorc-249-handoffs/s21a-before-main-20261116`.
Each restored file matched that backup before updating documentation. Main's
affected base files matched the groundwork; no runtime conflict resolution or
source change was necessary. Shared and peer worktrees were not modified.

S22 owner `S6z:P60l3:G1wkh` confirmed no edits to replay's schema, recording,
SDK, route or storage seams. ISO keys use the take's `iso/` subfolder; replay's
live playlist does not. Replay creates no additional egress or separate
concurrency reservation; `replayUsage` meters only replay costs. ISO's separate
reservation stays independent. Both consume existing S20 take and S16 interval
identities; no unresolved source overlap is known.

Paired followup PRs target **main**. No dedicated issue or new PR URL is invented;
link the pair after coordinator creation. This checkpoint does not finish Plan 249.

## Inspected SDK and actual implementation choice

- Installed `livekit-server-sdk` **2.19.2**, resolved `@livekit/protocol` **1.51.0**.
  Inspected SDK `src/EgressClient.ts`, protocol `dist/index.d.ts`, and existing
  `lib/cloud/media/livekit-api.ts`, `recording.ts`, recording-space credentials
  and S3 SigV4 signer. No provider documentation request or provider call was made.
- `SegmentedFileOutput.livePlaylistName` is protocol field **11**, documented in
  the installed definition as “optional, disabled if not provided. Path of a live
  playlist.” It is separate from `playlistName` (the take's `index.m3u8`). The
  existing `startEgress` request can supply it with the same two-second segmented
  output, S3 target and existing write-only show/take credential.
- SDK updates expose `updateLayout` and `updateStream`; there is no operation to
  attach/remove a segmented output or change its live-playlist field on an
  already-running egress. Therefore ordinary running recordings cannot be silently
  retrofitted. The API explicitly refuses that case and requires the user's
  separate stop/start Record action. It never starts or stops recording itself.
- A prepared ring makes that subsequent explicit Record action add a generation-
  named live playlist under the existing take prefix. Binding occurs only after
  recording start returns its real egress/take IDs. No alternate interval ID,
  new take naming scheme, additional egress, credential scope or LiveKit grant.
- This implementation requires an active explicit recording's segmented egress.
  It does not promise free idle-room replay. The normal recording lane remains
  `output:recording`; an already-supported shared stream/record egress retains
  `output:stream`. The manifest reports that actual lane, preserving S4 claims.
  Program graphics and mixed audio come from the existing real program page.
- Once a live output is known, explicit renewal may reuse that exact active
  take/egress/output after the old ring closes, using a new ring generation and
  unchanged source-output generation. It does not restart media. Old cleanup
  cannot erase the renewed generation. An unconfigured or different take is not
  eligible for reuse.

This SDK field is source support, **not proof of provider delivery before take
finalization**. The adapter reads only the generated live playlist, refuses
`ENDLIST`, and never polls S20's finalized-take table/index to simulate a ring.
A provider that does not supply a bounded usable live playlist stays unavailable;
there is no fabricated or finalized-file fallback.

## Authenticated orchestration, ingestion and retrieval

The existing owner-session route now wires the real runtime service:

- `POST /api/cloud/shows/:id/replay-ring`: explicit `consent:true`, orientation,
  byte/cost ceilings, bounded idempotency `requestId`, and `expectedGeneration`
  (null initially). Entitlement, recording retention and ready show storage are
  checked. Result is prepared/awaiting explicit Record, or renewal of a known
  active live output. Default production gate refuses before loading credentials.
- `PUT ...?generation=...`: poll the current active egress's live playlist,
  reserve costs before I/O, ingest at most four new segments, validate source
  prefix/sequence/clock continuity and persist immutable hashes/references.
  Polls are limited to one per two seconds across workers. A gap or rewind needs
  a new generation; missing provider objects remain unavailable.
- `GET ...?generation=...`: bounded persisted manifest. Optional `startMs/endMs`
  selects a fully available window; `segment=<sequence>` retrieves that specific
  retained object after hash, generation, owner, expiry and quota checks.
- `DELETE ...?generation=...`: close only this ring and clear references. It remains
  available while rollout is disabled, does not stop recording, and never deletes
  the original take. Reaper cleanup also runs without enabling the feature.

Unauthenticated requests are 401, cross-owner/show 404, stale/expired media 410,
quota/rate exhaustion 429. Cross-origin browser requests are refused; normal
owner-session callers remain supported. Responses are private/no-store. Guest
and program-page tokens confer no access. Signed storage URLs and secrets never
leave the server; even raw provider errors are replaced with fixed safe codes.

The S3 reader uses the **existing** parent read credential on the show's existing
child branch, as S20 downloads already do. Configuration is resolved lazily only
after the qualification/consent/ownership checks. Reads use short SigV4 URLs,
HTTPS, redirect refusal, byte ranges, streaming bounds and eight-second aborts.
Only the bound live-playlist key and safe segment names under its exact take
prefix are accepted. No list, upload, copy, credential mint or new permission.

## Persistent ownership, retention and metering

- Additive typed fields `replayRing` / `replayUsage` in existing
  `cloud_show_media.state_json`; **no SQL migration** or real database operation
  was run. Existing compare-and-swap mutations and per-show leases serialize
  workers and recording controls. Every late commit checks lease owner/expiry,
  ring generation and ring lifetime. A dead worker leaves bounded reservations;
  a stale worker cannot release a replacement lease or resurrect a closed ring.
- Persistent media storage is a **bounded reference ring over the user's existing
  recording objects**, not a duplicate binary cache. At most 64 references,
  64 MiB referenced bytes and 90 seconds of media are retained, with access expiry
  after 90 seconds and a five-minute ring lease. Cleanup removes references;
  the original recording's 7/30-day retention and deletion stay unchanged.
- Generation limits are 256 MiB reserved transfer and the caller's explicit
  monetary ceiling; show-wide hard bounds are 512 MiB, 1,024 object-read requests
  and 1,000,000 micro-currency units. Limits cannot be raised by clients. Storage
  operations reserve the maximum permitted transfer plus configured per-request
  costs **before** I/O. Crashes/errors/retries do not refund these conservative
  reservations or reset show-wide counters. These counters are not invoices.
- The extra live playlist persists until the recording ends because the SDK
  cannot remove it mid-egress. Arming therefore reserves its configured maximum
  write cost through **show expiry plus the existing 15-minute credential grace**,
  rather than only the ring TTL. A renewal of that already reserved output does
  not reserve the same writes twice. The independently requested recording's
  normal billing/retention remain separate and unchanged. Each possible writer
  on an uncertain Record retry reserves another full lifetime amount before
  credential minting or SDK start, with at most four output-start reservations.
  Budget refusal returns an explicit replay error without another provider start.
- Price inputs are server-owned and currently **null/unmeasured**. Enabling needs
  measured GET/transfer/live-playlist rates and provider byte-range/abort billing,
  with deployment-reviewed ceilings. Unit-test prices and qualification are
  explicitly simulated. No paid source was activated to obtain them.
- Cron scans at most 100 active ring rows, prunes current-generation references,
  and closes expired/ended shows' rings. Read-time enforcement protects expiry
  even if cron is delayed. Closed metadata and show-wide usage remain bounded;
  no unbounded operation history or object-copy garbage queue is created.

Program time is media-relative. Provider PDT is optional: missing wall-clock
mapping stays null, and keyframes/clock precision/A/V p95 remain unqualified.
The latest S16 interval is explicitly a control-state observation, **not a claim
that every retained segment belongs to that interval**. S20 take identity and
historical timestamps are unchanged; record-only never fabricates an interval.

## Maintained actual acquisition and deferred gates

The existing desktop `pnpm smoke:cloud-parity -- --case replay-ring` still captures
real local program-tab pixels plus the final mixed audio bus, ingests growing
HLS before capture ends, reconstructs authorized retained media and analyzes
pixels, host/guest/aux tones, keyframes, packet clocks and the existing artifact
gates. Its source was preserved, **not executed**. It remains local acquisition
proof only when eventually run; it is not the managed provider qualification.

No smoke, real-page, device, managed/provider calls, heavy suites, Rust compilation,
app/production builds, credential reads, deployment or real DB migration were
performed. Required managed qualification still includes pre-finalization object
availability, playlist shape/bounds, source/recording dependency and billing,
program graphics/mixed-audio artifacts, keyframes/continuity, clock mapping and
correlated A/V p95. Production remains disabled pending that evidence. No Clips,
archive UI or native camera-owning replay session was introduced.

## Focused verification and baseline failures

Reconciliation refresh: logs `/tmp/s21a3-focused.log`,
`/tmp/s21a3-types.log`, `/tmp/s21a3-static.log`, and
`/tmp/s21a3-desktop-tests.log`. These are local test evidence, not acceptance.

- Web selected SDK/recording/reaper/replay/S16-S20 test files: **74 tests, 73 pass,
  one inherited failure**. All **16 new managed-replay tests pass**, including
  source start wiring, reload/worker persistence, leases, stale cleanup, renewal,
  budgets, auth/CSRF, streamed S3 bounds and finalized-playlist refusal.
- Inherited failure: `tests/cloud-managed-reaper.test.ts:882`, “lost, no room and
  no active egress”: revision assertion `7 !== 6`. Reproduced with the same single
  test in a read-only source snapshot of committed web base `158371bf`, rooted
  at `/tmp/videorc-s21a2-web-baseline`. Fetched main has the same web source
  tree as that committed base, and the focused run on the reconciled followup
  reproduced it unchanged. Assertion was not weakened or edited.
- Desktop registry checks: **10 pass**. TypeScript, scoped ESLint, formatting,
  whitespace and generated program consistency checked. Source/generated program
  modules are unchanged. The known `.tile-dim` broader assertion was not rerun.
- Shadscan baseline/floor: desktop **27/27**, web **47/47**. Final advisory audit
  uses the same `pnpm dlx @shadscan/cli@next --json` against frozen diffs; final
  scores and unchanged fingerprints are reported in the coordinator handoff.

## Exact incremental desktop paths

- `docs/cloud/249-execution-ledger.md`
- `docs/cloud/249-s21a-handoff.md`
- `protocol-fixtures/cloud-parity-plan.json`

## Exact incremental web paths

- `app/api/cloud/reaper/route.ts`
- `app/api/cloud/shows/[id]/replay-ring/route.ts`
- `db/schema.ts`
- `docs/cloud/249-s21a-handoff.md`
- `lib/cloud/managed-route.ts`
- `lib/cloud/media/livekit-api.ts`
- `lib/cloud/media/media-store.ts`
- `lib/cloud/media/recording.ts`
- `lib/cloud/media/types.ts`
- `lib/cloud/reaper.ts`
- `lib/cloud/replay/managed-http.ts` (new)
- `lib/cloud/replay/managed-state.ts` (new)
- `lib/cloud/replay/managed.ts` (new)
- `lib/cloud/replay/provider.ts` (new)
- `lib/cloud/replay/ring.ts`
- `lib/cloud/replay/route.ts`
- `lib/cloud/replay/runtime.ts` (new)
- `tests/cloud-managed-replay.test.ts` (new)
- `tests/cloud-program-ring.test.ts`

## Fresh desktop PR-ready text (base main)

Title: **Plan 249 S21a: record managed replay source integration and gates**

Body: Update the central ledger and paired contract for the managed replay
followup to merged desktop #1446/web #130, including all earlier merged PRs,
current parallel ownership and clean fetched-main bases. Document real LiveKit live-playlist orchestration, persistent
references/leases/quotas/cleanup, SDK limitations and deferred qualification.
Link the paired web followup PR after coordinator creation. Ten registry tests
pass; the actual acquisition harness is preserved and not run. Production stays
disabled; no provider calls or deployment.

## Fresh web PR-ready text (base main)

Title: **Plan 249 S21a: integrate managed live segments and persistent replay ownership**

Body: Replace the local-only replay boundary with a real, gated LiveKit/S3 source
path. An explicitly armed ring adds a live playlist only to a separately requested
recording start, then ingests and serves bounded segment references through the
existing owner session. Persist generation/lease fences and conservative byte,
request and monetary reservations; prune references through the reaper and on
reads while preserving source recording retention. Support explicit renewal of
an already configured active output without restarting recording. No finalized-
take polling, new grants, extra egress, schema migration or implicit Record.

Validation: 74 focused tests: 73 pass, one unchanged reaper revision assertion
reproduced on committed base (`7 !== 6`, line 882); all 16 new replay tests pass. TypeScript,
scoped lint/format and generated assets checked. No smoke/heavy, managed/provider
or artifact acceptance run. Production policy remains false with null pricing;
simulated tests do not qualify availability, cost or A/V. Followup to web #130;
link the paired desktop followup PR after coordinator creation.
