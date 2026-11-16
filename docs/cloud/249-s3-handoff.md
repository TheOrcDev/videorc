# Plan 249 S3: soundboard auxiliary audio

Status: implementation prepared; live acceptance **not run**. Production
qualification and automatic enablement remain false. Explicit per-room preview
opt-in is required, followed by compatibility negotiation. This is the S3
checkpoint, not completion of Plan 249.

## Paired branches

- Desktop: `/Users/orcdev/projects/videorc-wt-249-s3`,
  `feat/249-s3-cloud-parity` from `feat/249-s2-cloud-parity`,
  `27a8380b496667fc2d12b06fdb356ee48fe571cc` (desktop PR #1439).
- Web: `/Users/orcdev/projects/videorcweb-wt-249-s3`,
  `feat/249-s3-cloud-parity` from `feat/249-s2-cloud-parity`,
  `03b31e8e1c030f0a4fedd8517242f3de8ea06e57` (web PR #125).
- Coordinator creates and cross-links both commits/PRs; no issue URL exists for
  S3. Prior stack branches and both active checkouts are preserved.

## Wire and behavior

`room-media-v2.ts` and mirrored JSON pin media version 2 and the exact
`videorc:v2:host-aux:stereo` role on the already-authorized host
`screen_share_audio` source. No microphone, system-audio or speaker capture is
used for auxiliary playback. One stereo 48 kHz destination feeds one Opus
publication (128 kbps, stereo, DTX off), independent of microphone mute and host
monitor. Sound import normalization, limits and backend voice IDs are retained.

Every active guest/program session must advertise v2. The guest's same-origin
POST `/api/guest/[slug]/media` uses existing HttpOnly cookie membership, validates
show/invite/own guest ID/current participant SID, bounds the body to 1024 bytes,
and rate limits IP and participant. Program capabilities ride existing beacons:
the signed page token, accepted boot/sequence, own orientation/current egress ID
and current LiveKit participant SID must all match. No guest publish-data grant
or metadata authority is added. Server-only `videorc.media-capability.v2` receipts
are targeted at the host and expire after 25 seconds. Participant-originated
receipts are rejected. Loaded old pages remain incompatible until reload/rejoin.

Host subscription permissions default-deny unknown SIDs before publication;
known sessions retain ordinary camera/microphone/privacy-screen SIDs. Only a
currently capable SID receives the auxiliary SID. Losing capability synchronously
stops its source and retires the publication. Async publication/decode completions
are fenced by epoch/ticket. Existing one-shots are not replayed on re-enable or
reconnect; loops resume at phase. Opt-in survives a reconnect of the same room
but a new room defaults off.

Program aux routing ignores screen selection and host stage position. Guests
keep all allowed audio SIDs, so aux cannot replace mic. Backend `onAir` continues
to describe actual native placement only. The room separately reports queued
decodes, published track, blocking reason and per-consumer observed-audio times.
Observations require nonzero decoded aux samples in a running playback path,
current host auxiliary SID and freshness (5 seconds); no observation means
unconfirmed. They do not prove human hearing or final managed egress. A local
speaker monitor is never on-air evidence.

S2 source gates, privacy generations, receiver frost checks and authorization are
preserved. Web PR #118 (head `af5be462f5d790fd5c808c0acfd4b801382f5e9c`)
remains independent; no takeover changes or branch dependency were introduced.
Its stage/audio conflict needs normal integration and module regeneration.
S8 owns deliberate speech/aux routing during takeover.

## Maintained acceptance, not executed

`pnpm smoke:cloud-parity -- --case soundboard` now records actual final program
and both guest return waveforms. It asserts one 1 kHz sound (including a double
copy amplitude rejection) with the 440 Hz mic; screen off, host offstage, mic
mute, monitor off, gain, loop/stop, rapid presses, cold decode cancellation,
reconnect, legacy/unconfirmed consumers, and one-shot replay prevention.
Fixture admission/token transport is synthetic; the real capability validator
and relay check current local SFU sessions. Route authorization is separately
covered by focused tests. This local harness cannot qualify managed egress.

Explicitly deferred by user: soundboard real-page case, soundboard and soundboard
fixture smokes, all smoke/real-page/device suites, remote-control smoke,
recording-studio and latency/matrix gates, full builds/full TS suites, Rust tests,
Rust compilation/clippy and full advisory audits, managed/paid output and
platform acceptance. No deployment, merge or paid egress was attempted.

## Focused evidence

Scoped desktop Vitest and web Node tests cover role/version compatibility,
authorization/session isolation, stale decode/publish/receipt handling,
reconnect and independent monitor/routing. Node waveform-validator tests exercise
numeric assertions without media devices or browsers. TypeScript checks,
scoped formatting/lint, Rust file formatting and emitted-module consistency
are the lightweight gates. Exact final results and Shadscan scores are in the
coordinator handover; do not treat this paragraph as an execution result.

Known baseline findings retained: web `cloud-program-bundle.test.ts:339` expects
an absent `.tile-dim` rule; both test/CSS are unchanged from the S2 base. Desktop
oxlint reports the existing stop-confirmation `useMemo` dependency warning for
`recording` in `use-studio.tsx`. No unrelated audit repair is included.

## Desktop PR ready

Title: Plan 249 S3: publish negotiated soundboard auxiliary audio

Body: Add a per-room opt-in stereo auxiliary publisher for backend-owned
soundboard voices, independent of microphone mute and speaker monitor. Require
current authenticated media-v2 program/guest capabilities, deny unknown
subscriber sessions, and stop publication on incompatibility. Fence pending
backend/browser decode and publication work and prevent one-shot replay across
reconnects. Maintain waveform acceptance and update S0–S3 ledger mappings.

Base: `feat/249-s2-cloud-parity` (desktop #1439). Pair with the coordinator's
web S3 PR. Focused checks only; live/managed/device acceptance not run and
production qualification remains false. No new issue to close.

## Web PR ready

Title: Plan 249 S3: negotiate and route host auxiliary audio

Body: Route the exact v2 host auxiliary role independently of screen/stage
selection and retain all allowed guest audio SIDs. Relay bounded, rate-limited
capabilities and fresh aux observations through existing guest-cookie and
program-token authority, validating current participant sessions and egress
orientation. Keep older loaded consumers incompatible and preserve privacy.
Update emitted program modules and add compatibility/authorization tests.

Base: `feat/249-s2-cloud-parity` (web #125). Pair with the coordinator's desktop
S3 PR. PR #118 remains separate; S8 owns takeover routing. Focused checks only;
known `.tile-dim` baseline failure retained; live acceptance not run.

## Final lightweight evidence

- Desktop focused Vitest: 108 tests across 15 files passed; the publisher race
  tests were rerun after type-only fixture cleanup (4 passed).
- Desktop Node inventory/media/control/privacy/waveform logic: 18 passed.
- Web selected source/stage/beacon/privacy/capability/guest route/page logic:
  137 passed. Authorization was rechecked after adding the 8-second API timeout.
- Desktop renderer and web TypeScript checks passed. Scoped oxlint (one known
  baseline warning), ESLint, formatting, Rust file format and script syntax
  checks passed. Emitted program module consistency passed.
- Bundle test retains the known unchanged `.tile-dim` baseline failure. No
  unrelated test or CSS weakened. No smoke, real page, device, full build or
  Rust compile/test was executed.
- Shadscan baseline/floor: desktop 27/27, web 47/47. Final advisory audit runs
  on the frozen complete diff immediately before coordinator handover; its
  numeric result is reported there. No commit is created by this thread.

## Exact changed paths

### Desktop (26 paths)

- `apps/desktop/src/renderer/src/components/studio/room-sounds.tsx`
- `apps/desktop/src/renderer/src/components/studio/soundboard-section.tsx`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/lib/room-aux-publisher.test.ts`
- `apps/desktop/src/renderer/src/lib/room-aux-publisher.ts`
- `apps/desktop/src/renderer/src/lib/room-aux-sink.test.ts`
- `apps/desktop/src/renderer/src/lib/room-aux-sink.ts`
- `apps/desktop/src/renderer/src/lib/room-media-v2.ts`
- `apps/desktop/src/renderer/src/lib/sound-monitor.test.ts`
- `apps/desktop/src/renderer/src/lib/sound-monitor.ts`
- `apps/desktop/src/renderer/src/lib/soundboard-store.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.test.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.ts`
- `crates/videorc-backend/src/sound_player.rs`
- `docs/cloud/249-execution-ledger.md`
- `docs/cloud/249-media-v2-contract.md`
- `docs/cloud/249-s3-handoff.md`
- `protocol-fixtures/cloud-parity-inventory.json`
- `protocol-fixtures/cloud-parity-media-v2.json`
- `protocol-fixtures/cloud-parity-plan.json`
- `scripts/lib/cloud-parity-baseline.mjs`
- `scripts/lib/cloud-parity-browser.mjs`
- `scripts/lib/cloud-parity-soundboard-contract.mjs`
- `scripts/lib/cloud-parity-soundboard-contract.test.mjs`
- `scripts/lib/cloud-parity-soundboard.mjs`
- `scripts/smoke-cloud-parity-app.mjs`

### Web (26 paths)

- `app/api/guest/[slug]/media/route.ts`
- `components/guest/guest-audio.ts`
- `components/guest/guest-room.tsx`
- `components/guest/guest-tracks.tsx`
- `components/guest/use-guest-connection.ts`
- `docs/cloud/249-media-v2-contract.md`
- `docs/cloud/249-s3-handoff.md`
- `lib/cloud/program-route.ts`
- `lib/cloud/program/beacon.ts`
- `lib/cloud/program/room-media-v2.ts`
- `lib/cloud/program/source.ts`
- `lib/cloud/program/stage-audio.ts`
- `lib/cloud/program/stage.ts`
- `lib/cloud/program/tools/emit.ts`
- `lib/cloud/program/wire.ts`
- `lib/cloud/room-media-relay.ts`
- `lib/cloud/talk-route.ts`
- `public/cloud/program/v1/beacon.js`
- `public/cloud/program/v1/room-media-v2.js`
- `public/cloud/program/v1/source.js`
- `public/cloud/program/v1/stage-audio.js`
- `public/cloud/program/v1/stage.js`
- `tests/cloud-invites.test.ts`
- `tests/cloud-program-source.test.ts`
- `tests/cloud-room-media-v2.test.ts`
- `tests/fixtures/cloud-parity-media-v2.json`
