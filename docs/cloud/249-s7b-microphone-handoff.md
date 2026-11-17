# Plan 249 S7b: room microphone processing and device lifecycle

## State and exact base

Implementation and runnable acquisition/analysis are ready for coordinator review.
Runtime qualification remains open. Native mode is disabled by default and cannot
be enabled in a production build. This is not a speaker-AEC, clock, latency or
final-A/V qualification report.

- Worktree: `/Users/orcdev/projects/videorc-wt-249-s7b`.
- Branch: `feat/249-s7b-cloud-parity`.
- Initial base: published S7a `58c3ab5cd9a80d8122fbfe5555371bb8b9fd6189` (PR 1444).
- Final HEAD/base: main `dda61b03ef52a97bd74a6796a2a0032d480878e5`.
- Eventual PR base: `main`. No S7b commit, push or PR created.
- Main includes S7a integration `84934688773813567b168bda90b502f9c7721dc3`.
  Both commits have tree `0e7569dc4db0f2b910aaa974c0d29d1ae32392a1`.
- Saved all S7b files and a tracked binary patch under
  `/tmp/249-s7b-before-main`, moved the empty S7b branch onto the supplied main
  tip, and reapplied the patch with three-way application. All tracked paths
  applied cleanly. Index is intentionally unstaged.
- Read `/tmp/249-s7a-integration-checkpoint.md` and preserved its accepted
  resolutions. No other agent worktree or central execution ledger was edited.
- Source skill and `src repo view --json nameWithOwner` detection were applied;
  this repository is on GitHub, not TanStack Source. Only `git fetch origin main`
  was needed for reconciliation; no forge write occurred.

## Source, processing and ownership

`session_audio/room_tap.rs` is a capture-only processing consumer. It reuses the
existing `ManagedProducer`, exact-device native/adapter opening, `SourceClock`,
bounded `AudioTimeline`, voice fold, real RNNoise processor and peak limiter.
It does not create a native camera, recording, FIFO writer or encoder session.
On platforms whose existing capture adapter uses FFmpeg, that process belongs to
the capture producer; the processing tap does not depend on recording/encoder
lifetime. The existing session mixer and mic-only PCM golden algorithm are
unchanged.

`room_microphone.rs` binds this owner to the authenticated websocket, show ID and
positive generation. It exclusively claims room-native capture, fences warm
opening, disarms and waits for actual producer cleanup, and refuses admission
beside an active/pending local capture session. Native ownership is released by
acknowledged close or websocket disposal; physical producer counts remain until
actual completion. Close timeout is an error, not an invented zero. Warm capture
and the independent visual analyser are suppressed while the room is open.
Joining the room awaits warm cleanup before either microphone mode can open.

The renderer source owns the complete graph, tracks, timers and contexts. Device,
mode or offset changes retire the prior source before opening another generation.
Gain, mute and noise updates keep the owner. None unpublishes and closes capture.
EOF, ended tracks and a two-second current-PCM timeout report loss; changing gain
does not reopen a lost device. Explicit selection or reconnect opens a new owner.
Late acquisition after cancellation stops its own tracks. A module-level
acquisition queue also serializes replacement across distinct room-client
instances, including the same show, without delaying immediate local disposal. Cleanup failure fences
replacement, while room teardown still unpublishes and disconnects. An unresolved
PCM resource owner also blocks a new browser capture.

There is one publication on the existing `Track.Source.Microphone` lane. The
S7a test fixture takes precedence when explicitly selected. Neither microphone
mode uses the S3 auxiliary sink, room return, system audio or speaker capture.

## Supported mode and opt-in mode

- `browser-aec`: supported browser echo-cancellation mode, pinned to the selected
  browser device. Gain, mute, limiter and post-processing meter apply. Browser
  noise suppression and AGC are explicitly false. Native RNNoise and native sync
  offset are explicitly unavailable; RNNoise is never replaced by browser NS.
- `native-headphones`: unqualified test mode using actual capture and native
  processing through S7a's authenticated PCM/worklet transport. Gain is -24 to
  +24 dB, mute is exact zero, noise is `off` or real `rnnoise`, and intentional
  delay is 0–1000 ms. Negative offset is rejected rather than silently changed.
  This delay is not a measured video-sync correction. Sources copy states the
  configured delay and the missing speaker-AEC/clock qualification.

Native mode requires all of: DEV renderer opt-in (`roomNativeMic=1` or the DEV
`roomNativeMicrophone(true)` seam), unpackaged main with
`VIDEORC_ROOM_NATIVE_MIC=1`, and a debug backend with
`VIDEORC_ENABLE_SMOKE_RPC=1` plus the same native-mic flag. It stays off otherwise.
The acquisition-only synthetic devices additionally require
`VIDEORC_CAPTION_CONTRACT_TEST=1` and `VIDEORC_LIVE_SOURCE_SWITCH_TEST=1`.

The meter is sampled after the actual processing graph and only after successful
publication. A suspended, unopened, lost or stale graph is unavailable, not a
fabricated zero or an unrelated backend/visual reading. Epoch fencing prevents
an old owner from overwriting the new owner's meter. Muted live samples read
negative infinity; loss reads unknown.

## Wire contract and bounded behavior

- Private IPC extension: `room-microphone:pcm` / `roomMicrophonePcm` and read-only
  `room-microphone:inspect` / `getRoomNativeMicrophoneResources`.
- Backend methods: `room.microphone.pcm` and `room.microphone.inspect`.
  Existing exact-document, main-frame, main-renderer and backend admin checks
  apply. No credentials or generic RPC access are exposed to the renderer.
- Shared TS/native serde mirrors and `protocol-fixtures/room-microphone.json`
  define `host-microphone`, 48 kHz, mono, exactly 480 frames, safe generation,
  show binding and bounded settings. Unknown fields, invalid lengths/rates,
  invalid/stale owner, default-device aliases and Pulse speaker monitors fail
  before capture allocation. This is not a new LiveKit manifest/capability.
- S7a's frame contract, 1920-frame worklet queue, one pull credit, timestamps,
  generation checks and explicit overrun/underrun counters remain intact.
  Native timeline retains four transport blocks plus 30 ms capture/denoiser
  headroom and the explicitly bounded intentional delay. It drains at most 256
  capture packets per pull and counts dropped/late input. Consumed chunks cannot
  repeat. Missing provenance is zero even if RNNoise retains an internal tail.
- Timestamps are native monotonic generation time and sample positions. They
  are not UTC, RTP time or an archival/video clock. Native processing reuses
  existing source-clock correction; no new measured drift guarantee is asserted.
- Main allows one request at a time. Native control acknowledgements have a
  15-second deadline; pull retains the two-second deadline. Native close waits
  for backend acknowledgement; after an EOF socket failure, main can wait up to
  five seconds for actual native completion through an internal inspection.
  Renderer cleanup independently checks actual
  native/socket/request counts. Navigation/crash closes the owned socket.
- Debug `disconnect-test` exercises the real synthetic producer EOF. Debug
  `starve-test` drops its input before the processing timeline for at most 12
  seconds, while keeping the producer alive; `resume-test` clears that bounded
  injection. These controls require the actual synthetic capture owner and do
  not manipulate physical devices or manufacture resource counters.

## Maintained acquisition and analysis (not executed)

`pnpm smoke:cloud-parity -- --case microphone` implements acquisition through the
actual native capture adapter, authenticated main/preload IPC, renderer worklet,
existing room publication, local LiveKit and compatible real program page. It
reuses the existing parity/local harness, loopback restrictions and audio
artifact analyzer. Imports of the pure helper module execute no application.

The case acquires baseline, live-owner underrun/recovery, -6 dB, mute, RNNoise
response, configured offset, alternate device, None, actual synthetic EOF,
explicit recovery and network reconnect. It then repeats room open/close with
actual native, main, renderer and SFU resource snapshots. Warm standby is disabled
in the isolated fixture profile so unrelated post-room warm capture cannot be
mistaken for a leaked room producer. No separate recording/camera session starts.

Bounds: 3–10 seconds per audio capture (default 4), 1–50 cycles (default 25),
32 MiB per retained artifact, bounded readiness/close deadlines and a bounded raw
observation collector. At least 25 distinct owner generations are required for
the cleanup gate. Shorter diagnostic configurations cannot pass that gate.

Artifacts include encoded program Opus, decoded 48-kHz PCM, ffprobe/decode
provenance, separate unsynchronized program video, source revisions, diff and
untracked-source hashes, program-bundle hash, raw native/worklet/renderer
observations, publications and real resource snapshots. Analysis verifies file
identity/size/hash and recomputes measurements from registered decoded artifacts.
Missing observations fail their gate. Underrun silence requires a live native
producer and publication, real drop observations, and subsequent measured recovery.

Future authorized commands (do not run under the current lightweight-only instruction):

```sh
VIDEORC_PARITY_WEB_ROOT=/path/to/compatible/clean/web \
VIDEORC_PCM_MODE=acquire VIDEORC_MIC_SECONDS=4 VIDEORC_MIC_CYCLES=25 \
pnpm smoke:cloud-parity -- --case microphone

VIDEORC_PCM_MODE=analyze VIDEORC_PCM_EVIDENCE=/path/to/microphone/evidence.json \
pnpm smoke:cloud-parity -- --case microphone
```

Default mode is `acquire-analyze`. Analysis remains nonzero/unqualified while
clock/final-A/V, offset timing, native speaker AEC and physical unplug measurements
are unavailable. Synthetic EOF is lifecycle evidence, not physical unplug
qualification. Separate video/audio artifacts do not establish final A/V sync.
S7a's full `microphone-bridge` acquire/analyze case remains intact.

## Integration and outstanding measurement interfaces

Reconciled against main containing S2/S3/S4/S16/S18/S20/S21a and emotes. S3's
negotiated role manifest, auxiliary publisher and TTL behavior are unchanged.
The S4 avatar publication and DEV seams coexist with microphone ownership.

S16's `closeRoom` still awaits confirmed live-output stop before room close.
Pending End remains an open show/room; the microphone follows actual room and
controller ownership, not a requested stream stop or canonical live interval.
Its provider lifecycle and pending-End backend methods are unchanged. The S16
owner confirmed that exact show/room-generation binding needs no new S16
interface. Stream End, recording takes, `liveIntervalId` and encoder lifetime do
not own PCM; pre-live and record-only room audio remain independent. Reconnect
and resume invalidate old callbacks even for the same show. Handoff/disconnect
performs no provider settlement, interval end or independent recording stop.
The existing immediate cancellation and join/leave serialization are retained;
a focused late-acquisition test covers disposal before a replacement client opens.

S18 has no microphone, audio-tap or consent interface and touches no capture or
audio processing. S7b has no S18 audio dependency and adds no caption/service
subscription or paid speech activation. The S18 owner confirmed this boundary.
Its `cloud_services` module, cloud-state release scheduling, Go Live remembering,
resume reattachment, confirmed-End forgetting and X-broadcast hooks remain
unchanged from the reconciled main base. Its `managedHarness` YouTube option and
parity `services` dispatch are also preserved. S16 owns lifecycle; S18 only reads
its typed `CloudStatus.live_interval`. Peer worktrees were not modified. S20
Library/takes, S21a segment ring, recording associations and emotes are unchanged.

S24 peer coordination: `TalkShowRoomClient.disconnect()` already aborts pending
acquisition and disposes the local microphone source through `#stopLocal`; no
additional disarm RPC is needed. `setMicrophoneSelection(null, null)` releases a
connected microphone, and selecting an exact ID/name explicitly opens it. Muting
alone still opens capture. S24 must mask the effective microphone ID/name to
None until explicit enable after continuation, keeping saved preferences
separate. S24 owns `controllerEpoch` and must include epoch replacement in the
existing serialized hook cleanup/rejoin even for the same show ID. No competing
epoch or continuation interface was introduced by S7b. SDK disconnect retires
processed/native PCM immediately before takeover grace/reconnect backoff;
terminal ownership loss also fences stale reconnect callbacks and controls.
S24's in-progress tree was not edited. Its all-off/needsEnable integration remains
S24-owned and is not claimed as runtime-qualified by this slice.

S13a's timestamped video/encoder completion interface is still pending. This
slice reports those measurements unavailable; it does not infer samples across
unrelated clocks, invent encoder timing, or enable native speaker support.

S13a clock proposal reviewed with its owner: one native anchor plus `originUs`
is compatible, but is not yet implemented in PCM. Initialize that shared anchor
before either generation's epoch; never saturate an older epoch to zero. Current
`observedAtUs` is generation-relative pull observation. For S7b,
`originUs + firstSampleUs` will describe the processed timeline (source-clock
mapping/resampling and intentional delay), not automatically raw physical capture
time. Preserve offset metadata, processing/delivery uncertainty and backend
process-incarnation identity when pairing stems. Missing origin is unavailable.
Future reconciliation must update both native PCM producers, TS/fixture mirrors,
renderer diagnostic projection and acquisition clock derivation together. No
parallel anchor or speculative PCM field was added. Exact peer reply is retained
at `/tmp/249-s7b-s13a-clock-reply.txt`.

S22 ISO public contract confirmed: host identity plus `Track.Source.Microphone`
classifies this publication as `host-microphone`. Device ID/name, mode and offset
replacements retire/unpublish the old track before publishing a new
`LocalAudioTrack`; S7b does not use same-SID `replaceTrack` for them. Gain, mute and
noise updates keep the source/publication. None removes it; explicit recovery and
reconnect publish fresh tracks. No new microphone name, attribute, grant or
replacement marker is requested. ISO SID generations and private PCM generations
are different domains. S22 should still report observed SFU overlap rather than
assuming runtime ordering from these source guarantees. Exact reply:
`/tmp/249-s7b-s22-public-contract.txt`.

## Focused verification

On final main base:

- 185 tests passed across 14 focused Vitest files, with two workers: main PCM
  transport; shared microphone/IPC contracts; microphone source/state; room
  client; room controller/join; microphone meter/visual providers; provider
  lifecycle; auxiliary publisher; avatar publisher.
- 12 Node helper tests passed across microphone contract and S7a PCM acquisition
  contract. Includes bounds, measured-sample math, live-owner underrun evidence,
  missing-evidence refusal, resource observations and clock bracket helpers.
- Both desktop TS7 node/web `--noEmit` checks passed.
- Focused Oxlint passed with the existing, unchanged `use-studio.tsx` missing
  `recording` memo-dependency warning. No suppression added.
- Changed TS/TSX/MJS/JSON Prettier, changed Rust Rustfmt with `skip_children=true`,
  maintained script syntax and `git diff --check` pass.
- Six native regressions are maintained source-only: wire/device admission and
  mirror bounds, gain/mute/no replay, delay/overrun/EOF, and real RNNoise response
  with exact underrun silence. Rust was not compiled or executed.

Deferred by explicit instruction: acquisition/smoke execution, real app/page or
physical device runs, native compilation/tests/clippy, full/heavy suites, builds,
`smoke:rnnoise`, recording studio/record-latency gates, mic-only golden execution,
final-artifact A/V and clock/drift/latency/speaker-AEC qualification. No paid,
managed/provider call, merge, deploy or publication was performed by this agent.

Shadscan uses the applied `shadscan-pre-commit` skill: baseline 27, floor 27;
integrated main's same-tree checkpoint also records 27. Final frozen-diff audit is **27** (baseline/floor/final **27/27/27**).
Command: `pnpm dlx @shadscan/cli@next --json` from `apps/desktop`.
Reports: `/tmp/249-s7b-shadscan-baseline.json` and
`/tmp/249-s7b-shadscan-final.json`. Frozen file manifest:
`/tmp/249-s7b-frozen-diff.json`. This is advisory because no agent-created commit is requested.

## PR-ready text

Title: `Add room microphone processing and device ownership (Plan 249 S7b)`

Body:

> Room microphone selection, gain, mute and meters now follow the actual
> published source. Browser AEC remains the supported mode, with no silent
> RNNoise-to-browser-noise-suppression substitution. An explicitly gated native
> headphones path reuses capture, source timing, RNNoise and limiting independently
> of a recording session, then publishes through S7a's bounded authenticated PCM
> worklet and the existing microphone lane.
>
> None, loss, switch and reconnect retire the previous owner before replacement;
> cleanup failures remain fenced and observable. Published levels come from the
> processed graph. Native intentional delay is bounded to 0–1000 ms and is not
> claimed as measured video sync. Default-device aliases and speaker-monitor
> sources are refused.
>
> Adds a maintained local acquisition/analyzer for gain, mute, noise, live-owner
> underrun, offset configuration, switching, synthetic EOF/recovery, reconnect
> and 25 close/reopen cycles, with program artifacts, provenance and actual
> resource observations. Native mode stays disabled/unqualified. Physical unplug,
> clock/final-A/V, offset timing and speaker-AEC qualification remain unavailable.
>
> Based on main `dda61b03ef52a97bd74a6796a2a0032d480878e5`; preserves S16's live
> stop barrier and pending-End behavior, S18 services, S20 Library/takes, S21a
> segment ring, S2 privacy, S3 aux, S4 avatar and emotes.
>
> Validation: 185 focused desktop tests, 12 Node helper tests, both TS7 checks,
> focused lint/format/Rustfmt and script syntax. No smoke, real-page/device run,
> heavy suite/build or Rust compilation was executed, per instruction. Native
> regressions are maintained source-only. This PR does not claim runtime or
> production qualification. Shadscan baseline/floor/final: 27/27/27 (advisory).

## Exact changed paths relative to final main

- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/room-pcm-bridge.test.ts`
- `apps/desktop/src/main/room-pcm-bridge.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/components/sources/sources-audio-mixer.tsx`
- `apps/desktop/src/renderer/src/hooks/studio-mic-meter.integration.test.ts`
- `apps/desktop/src/renderer/src/hooks/studio-mic-visual-provider.test.ts`
- `apps/desktop/src/renderer/src/hooks/use-studio-mic-sources.ts`
- `apps/desktop/src/renderer/src/hooks/use-studio-mic-visual.tsx`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/hooks/use-talk-show-room-join.test.ts`
- `apps/desktop/src/renderer/src/hooks/use-talk-show-room.ts`
- `apps/desktop/src/renderer/src/lib/room-microphone-source.test.ts`
- `apps/desktop/src/renderer/src/lib/room-microphone-source.ts`
- `apps/desktop/src/renderer/src/lib/room-microphone-state.test.ts`
- `apps/desktop/src/renderer/src/lib/room-microphone-state.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.test.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.ts`
- `apps/desktop/src/shared/backend.ts`
- `apps/desktop/src/shared/electron-ipc-contract.test.ts`
- `apps/desktop/src/shared/electron-ipc-contract.ts`
- `apps/desktop/src/shared/renderer-security-policy.ts`
- `apps/desktop/src/shared/room-microphone.test.ts`
- `apps/desktop/src/shared/room-microphone.ts`
- `crates/videorc-backend/src/main.rs`
- `crates/videorc-backend/src/room_microphone.rs`
- `crates/videorc-backend/src/session_audio.rs`
- `crates/videorc-backend/src/session_audio/room_tap.rs`
- `crates/videorc-backend/src/warm_microphone.rs`
- `docs/cloud/249-s7b-microphone-handoff.md`
- `protocol-fixtures/room-microphone.json`
- `scripts/lib/cloud-parity-microphone-contract.mjs`
- `scripts/lib/cloud-parity-microphone-contract.test.mjs`
- `scripts/lib/cloud-parity-microphone.mjs`
- `scripts/smoke-cloud-parity-app.mjs`
