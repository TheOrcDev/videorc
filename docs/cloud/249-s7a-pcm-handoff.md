# Plan 249 S7a: bounded native PCM test microphone

## State and bases

Source bridge and runnable end-to-end acquisition implementation are ready for
coordinator review. Acquisition execution, production enablement and runtime
qualification remain **not run**. No S7b device/capture/RNNoise work.
No commit, push, PR, merge, deployment, provider call or paid operation performed.

- Branch: `feat/249-s7a-cloud-parity`.
- Worktree: `/Users/orcdev/projects/videorc-wt-249-s7a`.
- Initial base: S2 `27a8380b4` (`feat/249-s2-cloud-parity`, PR 1439).
- Reconciled HEAD/base: S3 `a93168fc46b8edc1b1fc6947562ea54e4c7b2be0`
  (`feat/249-s3-cloud-parity`, desktop PR 1440).
- Web reference: S3 `a68454e0`, PR 126, read-only. No web files changed.
- Saved the S7a patch, fast-forwarded the branch to committed S3, reapplied the
  patch, and resolved the single room-client import conflict by retaining both
  imports. No merge commit. Index is unstaged.
- Central plan/inventory/execution ledger is unchanged.

## Source, authority and clock contract

A debug-only mono fixture supplies the existing `Track.Source.Microphone` lane.
Its 440 Hz background has a 1 ms pulse each second, followed by a 40 ms 3,500 Hz
sync and twelve 20 ms 1,500/2,500 Hz FSK bits encoding the second ID. Unique IDs
prevent ambiguous one-second clock matching; the maintained decoder accepts
IDs 0–3,599 and records a 480-frame detection uncertainty. There is exactly one microphone producer:
normal joins keep browser capture/AEC; opted-in test joins skip browser capture.
The cloud program already consumes that lane for the on-stage host. No auxiliary
sink, room return, speakers, system capture, native device or recording is used.
Initial mute is applied before publication. Failures stop the test source and
report an explicit microphone problem; they never open a fallback device.

Three gates must all be explicitly enabled for a future runtime exercise:

1. Development renderer URL query `roomPcmTest=1`, DEV harness seam
   `window.__videorcSmokeScenePresets.roomPcmTest(true)`, or explicit test factory
   `TalkShowRoomDeps.pcmTestSource`. This is not a production UI mode.
2. Unpackaged Electron main with `VIDEORC_ROOM_PCM_TEST=1`.
3. Debug native backend with `VIDEORC_ENABLE_SMOKE_RPC=1`.

`room-pcm:test` and read-only `room-pcm:inspect` go through the existing secure IPC registration: trusted exact
main document, main frame and main renderer role. Other renderer roles get no
preload API and cannot invoke the channel. Main owns a private admin websocket;
no token or general RPC escapes to the renderer. The backend admits only that
admin role, debug build and explicit smoke opt-in. The command fixes the IPC
role to `host-microphone-test`; it is **not a new LiveKit media role/manifest**.
Metadata, generation and length are checked before copying/allocating samples.

Portable contract in `shared/room-pcm.ts`, native `room_audio_bridge.rs` and
`protocol-fixtures/room-pcm.json`:

- 48,000 Hz, one channel, exactly 480 Float32-compatible samples per block.
- Positive safe-integer generation; monotonically increasing sequence;
  `firstSample = sequence * 480`, `firstSampleUs = sequence * 10000`.
- `observedAtUs` is the actual native monotonic elapsed time at pull, at least
  `firstSampleUs + 10000`; it is not the nominal sample position.
- Timestamp origin is the native monotonic `Instant` at that generation's open.
  It is not UTC, renderer performance time, RTP time or an archival show clock.
- Native retains only indices for at most four due blocks (40 ms). It allocates
  one 480-sample response per pull. If late, it drops oldest blocks and reports
  cumulative `droppedFrames` instead of backfilling seconds of queued audio.
- Main allows one outstanding PCM request, with a two-second timeout. Its socket
  includes no unsolicited event subscriptions. One renderer/worklet pull credit
  prevents MessagePort accumulation when the renderer stalls.
- Worklet ring is fixed at 1,920 frames (40 ms). Timestamp gaps become silence;
  large gaps/drop-oldest remain bounded. Late/replayed/stale-epoch frames cannot
  replay audio. Every underrun produces zeros. Diagnostics count underruns,
  overruns, gaps, stale frames, discontinuities and native drops explicitly.
- Source disposal stops tracks/nodes/port, closes its AudioContext and native
  socket, and cancels its timer. Renderer navigation/crash/destruction also
  retires main ownership. Socket loss drops the connection-local native source;
  there is no native capture handle, worker or producer timer to leak.
- SDK reconnect retires the old producer before opening a fresh generation.
  Full reconnect/close and late source/publication completions are fenced.

The renderer emits test-only `videorc:pcm-test-diagnostic` observations. Worklet
cursor and worklet-frame indices refer to the same next output sample. Native
frame timestamps and renderer request/ack intervals are retained separately;
open RTT only brackets clock mapping and does **not** certify encoder latency.
No clock correction, drift measurement or AEC support is claimed by source code.

## S3 integration

Consumed the committed `docs/cloud/249-media-v2-contract.md` interface. S3's
auxiliary publisher/sink/manifest, TTL receipts and permissions remain intact.
No alternative manifest or PCM capability was added; v2 does not certify PCM.
This fixture changes the producer of the already supported microphone lane, so
it requires no new web role, grant or generated program bundle. The private IPC
fixture is a transport contract, not consumer negotiation. Production native
processing/capability design remains later work under S7b and qualification.

Focused tests cover existing S1 mute/None, S2 privacy and S3 aux paths alongside
PCM-only publication, mute, stale source completion, reconnect and teardown.

## Maintained acquisition and analysis

`pnpm smoke:cloud-parity -- --case microphone-bridge` now defaults to
**acquire-analyze**. It implements the full local native → authenticated Electron
main/preload → renderer worklet → LiveKit microphone → real program path. It no
longer requires externally prepared evidence to acquire observations. Importing
helper modules launches nothing. The command itself is runtime/heavy and was
**not executed** under the current instruction.

Acquisition reuses `managedHarness`, `prepareParityRoom` and `startParityPages`:

- Launches an isolated fake-cloud/local-LiveKit fixture and explicitly gated
  development Electron process, with existing binaries and fake browser camera.
  The microphone source is the native PCM fixture, not fake browser microphone
  capture. No provider or managed egress is called.
- Enables the DEV renderer seam through the actual Electron command channel,
  opens a room, waits for one actual unmuted microphone SID, and asserts one
  native source, main socket and renderer worklet/track owner.
- Loads the existing web program page with a local recorder token and loopback
  network restriction, sets the host on stage, and waits for its actual final
  audio bus and video. Records that bus with bounded MediaRecorder Opus chunks;
  Playwright retains separate program video. This is local encoded program-bus
  evidence, not managed-egress qualification or a synchronized A/V container.
- Polls raw native-frame/worklet/renderer/program diagnostics into bounded
  NDJSON, incrementally writes encoded chunks, decodes audio with FFmpeg, and
  retains ffprobe output, decode arguments and SHA-256 hashes of the artifacts.
- Opens/closes 25 actual room owners by default. The first owner runs for 1,805
  seconds; later captures run four seconds each. Checks native source count,
  main socket/request/timer count, renderer context/worklet/track/request/timer
  count, actual SFU publications and remaining browser contexts after close.
- Retains evidence JSON and attempted artifact paths on failure. Unavailable
  observations and failed acknowledgements remain unavailable; they never
  become zero cleanup counters. Observation loss fails acquisition explicitly.

The runtime uses the existing fixture launcher's skip-native-prebuild path. It
requires already installed desktop/web dependencies, an appropriate **debug
backend built from this slice**, local LiveKit/media tooling, ffmpeg/ffprobe and
Chrome. The normal development launcher/fixture bundler still prepares its JS
assets when run; no such launch or bundling occurred here. Use a clean compatible
web checkout, initially S3 `a68454e0`. Its source and generated program bundle
must agree. Missing/stale runtime prerequisites fail the capture rather than
claiming evidence. All configuration below is for a later authorized runtime.

```sh
# Acquire local evidence only; success means acquired, not qualified.
VIDEORC_PARITY_WEB_ROOT=/absolute/path/to/clean/web-checkout \
VIDEORC_PCM_MODE=acquire \
pnpm smoke:cloud-parity -- --case microphone-bridge

# Default acquire + analyze (currently fails full qualification for missing APIs).
VIDEORC_PARITY_WEB_ROOT=/absolute/path/to/clean/web-checkout \
pnpm smoke:cloud-parity -- --case microphone-bridge

# Analyze existing machine-acquired artifacts without launching anything.
VIDEORC_PCM_MODE=analyze VIDEORC_PCM_EVIDENCE=/absolute/path/to/evidence.json \
pnpm smoke:cloud-parity -- --case microphone-bridge
```

`VIDEORC_PCM_SECONDS` is an integer 5–3,500 (default 1,805);
`VIDEORC_PCM_CYCLES` is 1–50 (default 25). Short runs exercise acquisition but
cannot pass the 30-minute/25-owner acceptance gates. Polling is 500 ms, readiness
and external clock/recorder observations have 30-second deadlines, and resource
cleanup polls for ten seconds (individual inherited RPCs retain their own
bounded timeouts). Each artifact is capped at 768 MiB and raw trace at 512 MiB.
Encoded chunk conversion, browser observer queues and renderer collectors are
bounded and report drops; inherited diagnostic tails are capped at 4,096 items.

Artifacts live beneath the isolated harness output root in `pcm-acquisition/`:
`evidence.json`, per-cycle `observations.ndjson`, `program-audio.webm`, decoded
`program.f32le`, and program browser video. The analyzer writes
`evidence.json.qualification.json`. Schema v2 records actual desktop/web HEADs,
tracked desktop diff hash, untracked source hashes, program bundle hash, artifact
hashes and FFmpeg decode provenance. These identify source inputs; they do not
assert that an existing native binary was built from those inputs. Gate checks
must run with the matching debug backend. Evidence contains no fabricated
startup, encoder or video timing.

## Clock acquisition and unavailable qualification APIs

Native pull replies expose measured monotonic `observedAtUs` plus source sample
indices. Renderer timestamps bracket actual IPC pulls. Worklet message exchanges
bracket actual `currentFrame` observations in renderer/program performance time.
Node brackets actual `performance.now()` reads with `process.hrtime`. Source
worklet output markers and decoded program FSK markers carry matching second
IDs. Mapping composes measured intervals, interpolates only between surrounding
anchors within two seconds, and refuses extrapolation. It includes one worklet
quantum plus marker-detection uncertainty. Raw events and mapping anchors are
retained. Latency gates use conservative upper bounds, not exact invented times.
This is a measured-event clock model; accuracy still requires runtime review.

The streaming analyzer independently checks 30-minute decoded marker continuity
and sample drift (80 ms envelope), invalid/clipped samples, silence over 10 ms,
queues over 1,920 frames, monotonic diagnostic counters, native-to-program-bus
latency upper p95 ≤250 ms and ≤80 ms growth, and at least 25 unique generations
with observed zero remaining resources. Thresholds are acceptance budgets,
**not measurements**. It verifies retained artifact hashes before analysis.

Two gates intentionally report **unavailable**, so overall qualification fails
even if the independent audio/cleanup gates pass:

- `encoderDeliveryLatency`: Owner/API is browser MediaRecorder,
  `BlobEvent.timecode` / `ondataavailable`. These expose chunk timing, not a
  per-sample encoder-completion timestamp. Chunk metadata is retained, but cannot
  establish encoder latency. A timestamp-preserving encoder observation adapter
  is still required; receipt time must not be substituted for completion time.
- `finalAvSync`: Owner/API is Plan 249 **S13a**, native video capture timestamp →
  published-frame mapping. S7a has no shared timestamped video source. Separate
  browser-video start cannot be assumed synchronized with the audio recorder.
  The retained video is explicitly labeled unsynchronized.

Startup latency is also not established: the consumer joins an already-running
source. No measured drift, latency, AEC, runtime stability or platform support is
claimed. Keep all source gates disabled; S7b remains uncommissioned.

## Resource ownership observations

Native source construction/drop maintain an actual atomic active-source count;
`room.pcm.test.inspect` is admin/debug/opt-in only. Secure IPC
`getRoomPcmTestResources()` combines it with actual main socket/request/timer
counts, keeping closing sockets registered until acknowledged closed.
Renderer registry entries read real AudioContext states, track `readyState`,
owned timers and requests. Successful owners unregister only after resources
settle; failed acknowledgements remain visible as unavailable. Browser observer
nodes/ports are detached, MediaRecorder is stopped/drained, contexts are closed,
and SFU responses confirm remaining publications. Protobuf omission of an empty
repeated field is accepted only in a successfully observed SFU response.

## Verification

Passed focused checks:

- TypeScript 7 node and renderer checks, using the installed compiler directly
  against `apps/desktop/tsconfig.node.json` and `tsconfig.web.json`.
- Nine selected Vitest files: 153 tests covering the PCM buffer/source/worklet,
  main bridge, room client, IPC schema/security, and S3 aux publisher/sink.
- Thirteen deterministic Node helper tests: configuration, capture/finalization,
  external deadlines, publication readiness, resource counts, bracket mapping,
  marker decoding, bounded collectors, recorder disposal and analyzer failure
  behavior. Synthetic helper inputs are not runtime acceptance evidence.
- Changed-file Oxlint, Prettier check, Node syntax checks, Rustfmt for the two
  changed Rust files, and `git diff --check`. Oxlint retains one existing
  `react-hooks/exhaustive-deps` warning in `use-studio.tsx`; this slice only adds
  its import and DEV smoke seam.
- Shadscan: S2 baseline **27**, advisory floor **27**, frozen-diff final **27**.
  Command: `pnpm dlx @shadscan/cli@next --json` from `apps/desktop`; JSON logs
  `/tmp/249-s7a-shadscan-baseline.json` and `/tmp/249-s7a-shadscan-final.json`.
  Advisory audit, not a commit checkpoint; no commit requested.

Tooling note: the shared checkout's dependencies lacked TS7/happy-dom. The first
pnpm wrapper refused dependency reconciliation without a TTY; nothing was
installed. Subsequent checks used direct binaries through temporary symlinks to
S3's installed dependencies, without changing either shared checkout. Temporary
symlinks are removed before handoff and are not deliverables.

Deferred by the explicit lightweight-only instruction:

- Native compilation, native unit/admission/mirror tests and Clippy. The tests
  are maintained in source; Rustfmt alone is not compilation evidence.
- Full desktop/Node/web suites, builds, generated-bundle qualification.
- Every smoke, real-page/local-LiveKit runtime, device and packaged-platform run,
  recording-studio gates, managed/legacy/solo cloud gates and final-artifact A/V.
- Measured 30-minute drift/latency, repeated-close runtime resource measurements,
  speaker AEC, macOS/Windows/Linux and managed deployment qualification.

## PR-ready text

Title: `feat: add disabled bounded native PCM room microphone fixture`

Body:

Room microphone contributions currently originate from browser capture. Add an
explicitly gated native fixture through authenticated main/preload IPC and a
48 kHz AudioWorklet into the existing LiveKit microphone publication. Fixed
queues, pull credits, generation checks, counted silence/drops and owned close
prevent the fixture from accumulating audio or surviving its room owner.

Reconciles onto S3 without changing auxiliary audio negotiation or screen
privacy. Adds portable protocol vectors, focused lifecycle/security tests and
a runnable local real-page acquisition driver with raw observations, repeated
owner cleanup, artifact provenance and a final-artifact clock/continuity/drift
analyzer. Production paths remain disabled; no capture ownership, RNNoise or speaker AEC is introduced.

Validation: TS7 checks, 153 focused desktop tests, thirteen Node helper tests,
changed-file lint/format and Rustfmt. Native compilation and all runtime/media,
heavy/build/device/managed gates deferred by owner instruction. No measured
latency/drift or production qualification claimed. Encoder completion timing
and synchronized final video mapping remain explicitly unavailable and fail
qualification. Stack on desktop S3 PR 1440; web S3 PR 126 is the consumer reference.

## Exact changed paths (36)

- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/room-pcm-bridge.test.ts`
- `apps/desktop/src/main/room-pcm-bridge.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/hooks/use-talk-show-room.ts`
- `apps/desktop/src/renderer/src/lib/room-pcm-buffer.test.ts`
- `apps/desktop/src/renderer/src/lib/room-pcm-buffer.ts`
- `apps/desktop/src/renderer/src/lib/room-pcm-source.test.ts`
- `apps/desktop/src/renderer/src/lib/room-pcm-source.ts`
- `apps/desktop/src/renderer/src/lib/room-pcm-test-state.ts`
- `apps/desktop/src/renderer/src/lib/room-pcm-worklet.test.ts`
- `apps/desktop/src/renderer/src/lib/room-pcm-worklet.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.test.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.ts`
- `apps/desktop/src/shared/backend.ts`
- `apps/desktop/src/shared/electron-ipc-contract.test.ts`
- `apps/desktop/src/shared/electron-ipc-contract.ts`
- `apps/desktop/src/shared/renderer-security-policy.ts`
- `apps/desktop/src/shared/room-pcm.ts`
- `crates/videorc-backend/src/main.rs`
- `crates/videorc-backend/src/room_audio_bridge.rs`
- `docs/cloud/249-s7a-pcm-handoff.md`
- `protocol-fixtures/room-pcm.json`
- `scripts/lib/cloud-managed-smoke.mjs`
- `scripts/lib/cloud-parity-browser.mjs`
- `scripts/lib/cloud-parity-pcm-acquire.mjs`
- `scripts/lib/cloud-parity-pcm-acquisition-contract.mjs`
- `scripts/lib/cloud-parity-pcm-acquisition-contract.test.mjs`
- `scripts/lib/cloud-parity-pcm-marker.mjs`
- `scripts/lib/cloud-parity-pcm-observer.mjs`
- `scripts/lib/cloud-parity-pcm-page.mjs`
- `scripts/lib/cloud-parity-pcm-page.test.mjs`
- `scripts/lib/cloud-parity-pcm.mjs`
- `scripts/lib/cloud-parity-pcm.test.mjs`
- `scripts/smoke-cloud-parity-app.mjs`
