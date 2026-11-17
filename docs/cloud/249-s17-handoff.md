# Plan 249 S17: H/V outputs and truthful quality

Status: **ready for publication on current main, uncommitted.** Source
wiring, focused tests and the maintained `outputs` acquisition are in place;
the acquisition was authored, not run. Live, managed, device and provider
acceptance **not run**. Higher profiles stay unqualified and refused. No
commit, push, PR, merge or deploy. The central ledger and
`protocol-fixtures/cloud-parity-{plan,inventory}.json` were not edited by this
slice. Exact per-file SHA-256 of the publication content and its parents:
`docs/cloud/249-s17-manifest.json` (same file in both repos).

## Publication (2026-11-17)

- S12 and S15 are merged on main (desktop #1455/#1456 in
  `4ff7156818f425112ef3575ff102cfdfdea853d7`, which also has S21c #1450; web
  #137/#138 in `ab811051b29345ee13ae7686c4534892de6fe077`). The staged S12+S15
  merge in the worktree index is therefore already on main and is **not**
  published; S17 is one commit per repo on main.
- **Desktop parent:** `4ff7156818f425112ef3575ff102cfdfdea853d7` (origin/main).
  The delta also applies to the open repair #1457
  (`1f372525d402f5e58118df36f052e50f0816ccf6`) with the same resolution and no
  further conflict (#1457 touches `cloud_show.rs`/`cloud_talk.rs` elsewhere).
  The Rust can only compile once #1457 is in, so publish S17 after #1457 merges
  or stack it on #1457.
- **Web parent:** `ab811051b29345ee13ae7686c4534892de6fe077` (origin/main), a
  clean apply.
- **One real conflict, resolved:** `scripts/lib/cloud-parity-baseline.mjs`
  (main's S21c `archive` and `avatar-animation` cases against S17's `outputs`
  and `captions` case names and the vertical lane). Resolution keeps every case:
  `outputs`, `captions`, then main's chain unchanged, and the vertical stream
  lane for `outputs || graphics || scenes` with main's comment. The publication
  copy therefore differs from the worktree copy (which sits on the S12+S15
  index); the manifest lists the publication bytes and both hashes.
- Everything else applied without conflict. Main's overlapping changes
  (`show-stage.tsx`, `use-studio.tsx`, `use-talk-show-room.ts`,
  `backend-rpc-contract.ts`, `backend.ts`, `fake-cloud-web-managed.mjs`,
  `smoke-cloud-parity-app.mjs`; web `livekit-api.ts` segment playlist) merged
  textually, and every `ShowRecord`/`CloudShowSummary` literal on main still
  sets `output_profile` or spreads.

## Ownership and history

- Commissioned to this thread (G98zv); taken over by a Codex agent (G67rq)
  during an Opus quota pause; handed back 2026-11-17 03:44 after Codex hit its
  weekly limit (no writes after 00:30).
- Everything Codex left was kept. Backups before any edit:
  `~/s17-scratch/takeover-0344/` (staged and unstaged patches, index trees,
  untracked tars, both repos). Nothing was reset, discarded or stashed.
- 2026-11-17: the coordinator (G3l7j) asked for publication on current main
  and confirmed the disclosed effective profile for admitted 60 fps and
  above-6 Mbps requests. The worktree index (S12+S15) and the S17 delta on it
  are kept as they were; the publication trees were built in a separate index.

## Worktrees, bases and the staged prerequisite

- Desktop `/Users/orcdev/projects/videorc-wt-249-s17`, web
  `/Users/orcdev/projects/videorcweb-wt-249-s17`, both on branch
  `feat/249-s17-cloud-parity` at the published S12 commits
  (`4d22beb4c01dac22a4cbcd1ac2c7f618892b126a` #1455 /
  `125d35686329de32c50df992bb3c9f0f1662ea95` web #137, both on S9).
- **Staged in the index (Codex's integration, kept as found):** published S15
  merged on S12. Desktop index tree `0ff8f6084cf25524a9fa938eca08c0d4a40ceca7`
  = S12 `4d22beb4c` + S15 `97ec02dcca20bd03ea9674ffbfb3a379f2302e5f` (#1456,
  which contains S7b #1448 `68c623f07`), with the one merge conflict
  (`scripts/lib/cloud-parity-baseline.mjs`) resolved keeping every case. Web
  index tree `a7d1ed83b6300594fba9d4a70abcd7dbf940a387` = S12 `125d3568` + S15
  `3f181288cf8731514b867cd9c5847c67b08ad558` (web #138), a clean merge,
  verified equal with `git merge-tree`.
- **S17 itself is the unstaged and untracked delta on top of that index** (the
  manifest lists exactly those paths). S15 is not an S17 dependency; Codex
  merged it so the outputs case can judge captions per output. Both are now on
  main; see Publication above.
- `node_modules` symlinks (both repos, and `apps/desktop/node_modules`) are
  not deliverables.

## What S17 does

### One output contract (desktop `shared/cloud-output-profile.ts` == web `lib/cloud/media/output-profile.ts`)

- `MANAGED_ENCODING` is what every managed program egress encodes: 1080p
  (1920x1080, upright 1080x1920), H.264 High 6 Mbps, 60 fps stream, 2 s GOP,
  AAC 160 kbps 48 kHz. The web's `EGRESS_ENCODING` is now this constant.
- `MANAGED_QUALIFIED` is the measured qualification: Plan 234 Phase 0
  (`docs/cloud/spike-livekit-managed-2026-11.md`) passed 1080p at 6 Mbps with
  a 30 fps picture; 60 fps motion failed its frame test. So the truthful
  profile is "a 30 fps picture in a 60 fps stream".
- Admission (`managedOutputProblem`): above 1080p (1440p, 4K) and above 60 fps
  is **refused with its reason**, never created and sent as 1080p under that
  claim. `MANAGED_HIGHER_PROFILES` lists 1440p and 4K as `not-run`; nothing in
  code or environment can turn one on (the qualification path is a measured
  record added there after a separately authorized managed-egress run).
- Disclosure (`managedOutputProfile`): a request at or below 1080p is admitted
  and its effective output says what differs (`resolution`, `fps`, `bitrate`),
  e.g. 1080p60 8 Mbps sends a 30 fps picture at 6 Mbps. Refusing those would
  have closed rooms people open today; the room says the difference before it
  opens. Decided by the coordinator (2026-11-17): admit 60 fps and higher
  bitrates with the disclosed effective profile; keep 1440p and 4K refused.
- Cost: `pricePerHour: null` (no price is published for a show; nothing is
  invented). `maxProgramEgresses` = outputs x 2 (a stream egress and a
  recording `rec=1` egress per orientation); the copy says each orientation is
  its own cloud output and recording adds one per orientation (measured in
  `lib/cloud/cost-inputs.ts`).
- Destinations (`managedDestinationProblem`): a destination fits a room when
  its orientation is one the room opened with and its address is RTMP/RTMPS
  (the web's own guard). Codex's YouTube/custom-only vertical allow-list was
  removed: there is no evidence for it, and it refused the app's own default
  TikTok and Instagram vertical destinations.
- Vectors: `protocol-fixtures/cloud-parity-outputs.json` (web
  `tests/fixtures/cloud-parity-outputs.json`, byte-equal); the fake web's JS
  mirror (`fakeManagedOutputProblem/Profile` in
  `scripts/lib/cloud-parity-outputs-contract.mjs`) is pinned to them too.

### Web

- `handleCreateCloudShow`: a managed (LiveKit) talk show's outputs are admitted
  after the entitlement check and before anything exists; a refusal is
  `400 cloud-output-unqualified` with the reason, no LiveKit call.
- `serializeCloudShow` adds `outputProfile` to a managed talk show (create
  answer and every current/state read).
- The new code is in the wire contract: `docs/cloud/managed-media-wire.md`
  (create table and quality row), `protocol-fixtures/cloud-managed-wire.json`,
  the web copy and its pinned SHA (`tests/cloud-managed-wire-pin.test.ts`). The
  web copy already differed from the desktop fixture at the base (its extra
  collision refusal); the pin hashes the web copy, as before.

### Desktop

- `lib/talk-show-outputs.ts` `talkShowOutputPlan`: the room's outputs come from
  every enabled destination (one per orientation, at the highest profile any
  asks for) plus the canvas orientation when recording or with no destination.
  It runs before `cloud.room.open`; a refusal toasts through the room's own
  error path (`use-talk-show-room.ts openRoom`) and the Guests tab shows the
  reason and keeps Open the room off.
- `talkShowOutputStartProblem`: in an open room, before metadata or any
  provider preparation (both the start-blocked reason and the Go Live path),
  every destination of the start must fit the room's reported outputs, so a
  vertical destination never fails as a surprise after a YouTube broadcast was
  prepared. A node show, or a web from before S17, reports no profile: the check
  then defers to the web's own guard instead of guessing.
- Rust `cloud_talk.rs validate_room_outputs`: the same refusal before the camera
  is lent or the show is created. `cloud_show.rs`: `ManagedOutputProfile`,
  `ManagedRequestedOutput`, `ManagedEffectiveOutput` pass the web's profile to
  the renderer whole (nothing dropped on re-serialize); `CloudShowSummary` and
  `ShowRecord` carry `output_profile`.
- Strict contract: `cloud.state` `show.outputProfile` is validated by
  `parseManagedOutputProfile` in `backend-rpc-contract.ts` (an unknown field
  would otherwise fail the status read).
- UI: Guests tab says what the room will send (or why it can't open) before
  opening, and what it reported once open; the Show stage shows the reported
  profile as one plain line. S6's "Program preview" label and badge unchanged.

### Independent H/V graphics, captions and record-only flags

Already per egress lane from S4/S9/S12/S15: avatar, static graphics, captions
(S15 as an S9 layer with per-output rects) and scenes are sent per (stream |
recording) x (h | v) to authorized `EG_` consumers. S17 adds the outputs, so a V
lane exists when a vertical destination does. Recording runs its own `rec=1`
egress per orientation (`recordSharesFirstEgress` stays off), so record-only
flags stay independent.

## Maintained acceptance (authored, NOT run)

`pnpm smoke:cloud-parity -- --case outputs` (`scripts/lib/cloud-parity-outputs.mjs`,
pure checks in `cloud-parity-outputs-contract.mjs`). Needs local LiveKit plus a
local `egress` worker and Redis (`VIDEORC_SMOKE_EGRESS_PATH`,
`VIDEORC_SMOKE_REDIS_PATH`); no managed or remote fallback.

- A 4K room open is refused by the real app before any room exists.
- The room opens H 1920x1080 + V 720x1280; the reported profile is checked
  (both 1080p, 60 fps stream, 30 fps picture, 6 Mbps, V marked scaled, no price,
  higher profiles unqualified).
- For banners and captions shown on both, record-only and stream-only, each of
  the four egress lanes (h/v x stream/recording) is encoded by a real local
  LiveKit egress using the web's own `buildStartEgressRequest` encoding, and
  the finished MP4 is checked with ffprobe: dimensions, 60 fps and frame
  count, H.264 High, BT.709 tags and TV range, a bitrate envelope, AAC 48 kHz,
  plus decoded pixels for the banner (present/absent per flag), caption glyph
  ink in its per-output rect, and the three voices' tones.
- A local egress proves encoder settings and page composition, not managed
  capacity, cost or provider acceptance.

## Focused checks (lightweight only)

On the publication trees (main + S17, exported with the installed
`node_modules`; 2026-11-17):

- Desktop `tsc --noEmit` (node and web projects): pass. Vitest, 17 files, 604 tests
  pass: the S17 files, Guests tab, Show stage, RPC contract, IPC contract,
  room, room join, session, cloud test outputs, scene preview, resender, guest
  roles, graphics publisher, cloud graphics and scene, and
  `studio-provider.integration.test.ts` (passes on main: see Known issues).
- `node --test scripts/lib/cloud-parity-*.test.mjs`: 62 pass (17 files,
  with main's archive test).
- rustfmt (edition 2024) on `cloud_show.rs`, `cloud_talk.rs`: pass. Rust **not
  compiled or run**.
- Prettier on every delta file, `git diff --check`, no added em dash: pass.
  oxlint: the `no-control-regex` error in `fake-cloud-web-managed.mjs` and the
  `use-studio.tsx` warning, both also on main.
- Web `tsc --noEmit --incremental false`, ESLint and Prettier on the delta,
  emitter `--check` (up to date): pass. The 41 web test files that touch shows,
  the route, LiveKit, the wire or the profile: 440 of 466 pass on main + S17
  against 437 of 463 on pristine main; the same 15 tests fail on both (talk
  end, destinations, recorded sequence, program colours and others), and the
  3 new S17 tests pass.

On the worktree (S12+S15 index + S17), at the checkpoint:

- Desktop renderer and node `tsc --noEmit`: pass. Vitest, 13 files, 303 tests
  pass: new `shared/cloud-output-profile.test.ts` (20), `lib/talk-show-outputs.test.ts`
  (9), Guests tab (mock completed with the canvas), Show stage, RPC contract,
  room, room join, cloud test outputs, session, S9 graphics, S12 scenes.
- Node `scripts/lib/cloud-parity-*.test.mjs`: 61 pass (new outputs contract: fake
  mirror vectors, ffprobe pass/fail cases, pixel placement, bounds).
- Rust: rustfmt (edition 2024) on `cloud_show.rs`, `cloud_talk.rs`; new unit tests
  (validation rules; profile serde round trip). **Not compiled or run.** Every
  `ShowRecord` literal sets `output_profile` or spreads.
- Web `tsc --noEmit --incremental false`, ESLint and Prettier on touched files,
  emitter `--check`: pass. Focused node tests, 18 files: 230 of 242 pass with
  the 3 new S17 tests; the same 12 fail identically on a pristine export of the
  S12+S15 base (destinations, talk end, program colours and others): not S17.
- oxlint: the existing `use-studio.tsx` warning, and an existing
  `no-control-regex` error in `scripts/lib/fake-cloud-web-managed.mjs` (same on
  S12 `4d22beb4c`). Prettier, em-dash gate, `git diff --check`: pass.
- Shadscan (`@shadscan/cli` 0.1.0-rc.7, `--json`): baselines on pristine
  S12+S15 exports desktop 27, web 47; finals desktop 27, web 47.

## Known issues outside S17

- **Resolved on main:** the S15 branch tip (`97ec02dcca`) failed 219 of 228
  in `studio-provider.integration.test.ts` because `use-talk-show-room.ts`
  read `window.location.search` for the dev native-mic switch. Main fixed it
  in `69156d5a380c2b68f7b4e60cc8adfa1367ff1e04` (S7b,
  `globalThis.location?.search`), and the file passes on main + S17. S17
  changes nothing there. The worktree still has the old line (its index is the
  S12+S15 merge), so the file still fails in the worktree, not in publication.
- Web: the 15 failures above predate S17 (identical on pristine main).

## Coordination

- S15 (G55dg): no caption contract change; S17 relies on the published per-output
  caption layer. Regression above reported.
- S22 (G1wkh) confirmed: ISO uses raw track egress with its own qualification
  record and export accounting, never reads `maxProgramEgresses`, and keeps its
  published ISO price out of `show.outputProfile`. No shared field needed.
- S13a (G7e0v): unaffected.

## Deferred gates

D, B (`cargo fmt --check --all`, `cargo test -p videorc-backend`, clippy incl.
release), N, W, WB, C, R, `pnpm smoke:recording-matrix`,
`pnpm smoke:cloud-parity -- --case outputs`, managed and macOS/Windows device
acceptance, and any higher-profile qualification (separately authorized).

## PR text for the coordinator

Desktop title: **Plan 249 S17: support H/V room outputs and truthful quality**

> A talk-show room now opens with the outputs its destinations need, one per
> orientation, decided before the room exists, and refuses what cloud output
> can't send: above 1080p (1440p, 4K) or above 60 fps, with the reason, never
> sent as 1080p under that claim. Rooms report what each output really sends
> (1080p, a 30 fps picture in a 60 fps stream, 6 Mbps H.264, AAC 160, as
> measured in Plan 234 Phase 0), what differs from the user's settings, that
> each orientation and each recording is its own cloud output, and no price.
> Go Live checks every destination against the room's outputs before any
> platform preparation, so a vertical destination never fails as a surprise.
> Adds the maintained `outputs` parity case with real local egress and
> ffprobe/pixel checks (not run). Rust not compiled; smoke, managed and device
> gates deferred. Base: main after the #1457 repair (or stacked on #1457).

Web title: **Plan 249 S17: admit managed talk outputs and report their profile**

> A managed talk show's create refuses outputs above the measured 1080p
> profile (`400 cloud-output-unqualified`, with the reason) before anything
> exists, and every show read reports `outputProfile`: requested and effective
> outputs, the qualified 30 fps picture, the differences, egress count and no
> price. The egress encodes from the same constant. The wire contract, fixture
> copy and pin are updated. Deploy before the desktop. Base: main.
