# Plan 249 S13a: native camera-role frame and clock bridge

## State, bases and index

Publication checkpoint on current main. Acquisition has **not run**; runtime
qualification, managed budgets and both platform capabilities remain
**unqualified**. Native and packed production stay disabled. No commit, push,
PR, deployment, credential read, provider call or private memory write.

- Desktop: `/Users/orcdev/projects/videorc-wt-249-s13a-main`, branch
  `feat/249-s13a-cloud-parity-main`, HEAD = `origin/main`
  `4ff7156818f425112ef3575ff102cfdfdea853d7` (contains S6, S7b, S9, S10, S12,
  S15, S21c). Nothing staged; the S13a delta is the whole working change.
- Web: `/Users/orcdev/projects/videorcweb-wt-249-s13a-main`, branch
  `feat/249-s13a-cloud-parity-main`, HEAD = `origin/main`
  `ab811051b29345ee13ae7686c4534892de6fe077` (contains web S6, S9, S10, S12).
  Nothing staged.
- Port: the S13a delta (working tree vs the staged prerequisite index of the
  integration trees) applied with a three-way apply and rerere disabled.
  Desktop applied cleanly; web had one additive conflict in the emitter module
  list (main already lists the graphics modules; only `camera-frame` added).
  Changed lines are identical to the integration delta for all 31 desktop and
  9 web tracked files; new files are byte copies. Web emitted modules were
  regenerated on main's sources.
- Preserved, untouched: the integration trees
  `/Users/orcdev/projects/videorc-wt-249-s13a-int` (staged three-parent merge
  S10+S7b+S12, index tree `ea719dbb...`) and
  `/Users/orcdev/projects/videorcweb-wt-249-s13a-int` (staged S10+S12, index
  tree `206b7ade...`); the frozen original `/Users/orcdev/projects/videorc-wt-249-s13a`;
  backups with SHA-256 in `/Users/orcdev/249-s13a-frozen-backup/` (`main-port/`
  holds the exact patches and new-file tars used for this port).
- History: Codex agent G3a8y held the trees about 00:25 to 00:38; its S12
  application was verified against an independent rebuild and kept, and it
  confirmed no unique implementation remains.
- Central ledger, parity plan and inventory JSON unchanged. S8 files untouched.

## What the slice adds

A disabled native test source carries camera-role frames through a bounded
frame-copy transport into browser encoding with explicit native timestamps:

1. **Native** `crates/videorc-backend/src/room_frame_bridge.rs`: debug build +
   smoke-RPC opt-in + admin socket only. Renders a synthetic packed color+alpha
   frame (S10 packing `rgb-left-alpha-right`, 8 px gutter, logical 640x360,
   packed 1288x360) carrying a 24-bit sequence stamp with check bits, a
   once-per-second flash (sequence % 30 == 0) and solid/half/transparent alpha
   patches. 30 fps, latest-wins (older due frames counted as `droppedFrames`,
   never queued).
2. **Ownership**: at most two leased frames per generation. A pull may release
   one lease of the current surface epoch. `reset` (GPU/surface loss) bumps the
   epoch and revokes every lease; a late release from an old epoch is counted
   stale and cannot free a newer frame. Source and leases are connection-owned:
   socket loss drops them. Every replacement/reconnect opens a new generation.
   Native `room.frame.test.inspect` reports actual source/lease counts.
3. **Transport**: one binary websocket message per frame (96-byte header +
   exact payload). Command text is bounded to 512 bytes and validated before
   any work. **No BMP/JPEG, no polling of preview debug endpoints, no Rust
   WebRTC.** The existing preview lease, native preview window and Preview
   ownership are not touched.
4. **Main** `apps/desktop/src/main/room-frame-bridge.ts`: private admin socket,
   one request credit, 2 s timeout, no event forwarding, no credentials in
   preload. The complete header and exact length are validated against the
   expected generation and request serial **before** pixels are copied; an
   unsolicited, oversized or mismatched binary closes the bridge. Main-only
   secure IPC `room-frame:test` / `room-frame:inspect` (trusted main frame only,
   unpackaged main, `VIDEORC_ROOM_FRAME_TEST=1`). One owner per sender, retired
   on navigation, crash or destruction.
5. **Renderer** `room-frame-source.ts`: each frame becomes one `VideoFrame`
   (`RGBX`, timestamp = native `ptsUs`) written into a
   `MediaStreamTrackGenerator`. No canvas/captureStream fallback (it would drop
   the native timestamp) and no raw/browser camera fallback: a runtime without
   a generator refuses explicitly. One request, one held lease and one open
   VideoFrame at most. An encode/GPU failure requests a native surface reset
   and continues on the new epoch; three consecutive failures stop the source
   and report a problem. Frames from an older epoch are never encoded.
6. **Room client** (`talk-show-room.ts`): with `frameTestSource`, the bridge is
   the only camera producer on the existing `Track.Source.Camera` lane. No
   browser camera, no `TalkShowCameraEffects`/key processor (no double key).
   Camera off/None, reconnect (retire + new generation), late source resolution
   after close and room teardown all close the source. Track name
   `videorc:camera-frame:v1;frameLayout=rgb-left-alpha-right:g8;generation=<n>`
   is a label only (see the S22 layout descriptor below).
7. **Gates** (all three required): DEV renderer (`roomFrameTest=1` query or DEV
   seam `__videorcSmokeScenePresets.roomFrameTest(true)`), unpackaged main with
   `VIDEORC_ROOM_FRAME_TEST=1`, debug backend with `VIDEORC_ENABLE_SMOKE_RPC=1`.
   Processed devices are not enabled anywhere.

## Frozen public contracts

### Camera role (agreed with S12; S10 reviewed)

`apps/desktop/src/shared/room-frame.ts` (`cameraRoleDescriptor`):

- Role `host-camera`, identical to S12's `SceneRole`. LiveKit source stays
  `camera`; no new grant or role reader. The bridge replaces the single camera
  producer; it adds no extra publication (S10's two-publication ceiling is its
  own H/V experiment, not a permission).
- Authority is a **separate** versioned contract,
  `CAMERA_FRAME_CONTRACT = 'videorc:experimental:camera-frame:v1'`, via
  `bindCameraFramePublication(authority, nativeGeneration, alphaMode)`. The
  trusted controller supplies show, `host:<show>` identity, `PA_`/`TR_` SIDs,
  epoch, generation, `source: 'camera'` and `canPublishSources` after actual SFU
  inspection; the native generation is bound to that publication here. Never
  from frame metadata or a track name. Per S10 (G6ltc), S10's frozen
  `AlphaManifest`/`parseAlphaManifest`/`ALPHA_ROLE` are **not** reused, cast or
  weakened; only the packing (`rgb-left-alpha-right`, 8 px gutter, straight
  alpha) and the logical-dimension rule (`cameraAlphaDimensions`) are shared.
- `CAMERA_PACKED_ALPHA_ENABLED = false`: packed camera mode is disabled and
  unqualified independently of opaque camera support; binding a packed
  publication requires an explicit `{ experiment: true }` caller. A CAMERA grant
  permits attempting the experiment only.
- The frame stamp encodes the frame **sequence**, not a clock; it is unrelated
  to S10's wall-clock `stampBits`/`stampLatency`. No A/V alignment is inferred
  from equal `VideoFrame.timestamp` values; timing is only the measured
  brackets with uncertainty.
- A frame is the **full, uncropped, unmirrored** source. Native camera
  processing owns key/spill/look once (`keyApplied: 'native-once'`); the scene
  renderer (S12) owns crop/fit/mirror/radius/mask once (`geometryApplied:
'none'` in the frame).
- `packed` alpha: straight (non-premultiplied) alpha; decoded track is
  1288x360 but **source aspect for geometry is the logical 640x360**. Consumers
  read `logicalWidth/logicalHeight`, never `videoWidth` of a packed track.
- `opaque` remains the named partial mode until transparent composition is
  qualified by S10's consumer.

### Clock (frozen with S7b/S8 owner G67rq; sent to S22 G1wkh)

`crates/videorc-backend/src/room_clock.rs`:

- `room_clock::init()` is the first statement of backend `main()`, before any
  room audio/video generation epoch can exist. Idempotent.
- `room_clock::incarnation() -> Option<u64>`: random, non-zero, < 2^53.
- `room_clock::origin_us(epoch) -> Option<u64>`: `None` before init, for an
  epoch earlier than the anchor (never saturated to zero) or past 2^53-1.
- Frame wire: `ptsUs` (capture) and `observedAtUs` (actual native pull) are
  both relative to the generation epoch; `originUs` (nullable) + `incarnation`
  (nullable, required when origin is present). Absolute native time =
  `originUs + ptsUs`, valid for pairing only within one incarnation.
  `originUs + observedAtUs` is checked against `MAX_SAFE_INTEGER` natively and
  in TypeScript before allocation. Not UTC, RTP, renderer time or a show clock.
- Both PCM producers now carry the same anchor (section "Common clock on the
  PCM producers" below). Absolute audio time is `originUs + firstSampleUs`;
  for S7b that is the processed-timeline position, not raw capture time.

### Layout descriptor (frozen with S22 ISO, G1wkh)

Server-readable, **non-authoritative**, carried in the LiveKit track name
(`TrackInfo.name`): `videorc:camera-frame:v1;frameLayout=<layout>;generation=<n>`,
key `frameLayout`, values `opaque` or `rgb-left-alpha-right:g8`
(`cameraFrameTrackName` / `parseCameraFrameTrackName`). The host grant has no
`canUpdateOwnMetadata` and LiveKit has no per-track attributes, so no grant is
widened. A layout is fixed per publication: any opaque<->packed change
unpublishes and publishes a new track (new SID), never `replaceTrack` or an
in-band switch, so each S22 ISO file has one layout. A camera track without
this name is the existing browser camera. ISO stores the source as published:
no re-key, no geometry. S22 keeps its clock at `provider-egress-start` /
`unmeasured` until a measured anchor-to-wall/RTP mapping is published.

### Binary frame header (little endian, `protocol-fixtures/room-frame.json`)

`magic 'VRCF' u32 @0, version u16 @4, flags u16 @6 (bit0 packed), serial @8,
packedWidth @12, height @16, surfaceEpoch @20, leaseSlot @24, reserved @28`
(u32); `generation @32, sequence @40, ptsUs @48, observedAtUs @56, originUs @64
(u64::MAX = absent), incarnation @72 (0 = absent), droppedFrames @80,
leaseStalls @88` (u64). Payload = 1288 x 360 x 4 bytes RGBX.

### Platform capability

`roomFrameCapability(platform)`: macOS and Windows `frame-copy`, `qualified:
false`, unmeasured; Linux `unsupported`. Electron 39.8.10 typings expose only
offscreen-paint shared-texture handles and no renderer import of a native
texture, so `sharedTexture: 'unavailable-in-electron-39'`. Re-check on an
Electron upgrade; zero-copy is not claimed.

## Maintained acquisition and analysis (not executed)

`pnpm smoke:cloud-parity -- --case camera-bridge` (default acquire+analyze).
Modules: `scripts/lib/cloud-parity-camera-bridge-{contract,acquire,page}.mjs`.
Importing them launches nothing.

- Cycle 0 (endurance + load): host plus `VIDEORC_CAMERA_BRIDGE_GUESTS` (default 5) real `GuestRoom` pages on stage side by side, real web program page,
  `VIDEORC_CAMERA_BRIDGE_SECONDS` (default 1,805). Every
  `VIDEORC_CAMERA_BRIDGE_RESET_SECONDS` (default 300) a native surface reset;
  records epoch advance, frames after and native leases.
- Cycle 1 also replaces the source in place (camera off/on, new generation).
- Cycles 1..N-1 (`VIDEORC_CAMERA_BRIDGE_CYCLES`, default 25) are short
  close/reopen owners; after each close every owner must be observed at zero:
  native sources/leases, main sockets/requests/timers, renderer
  generators/timers/held leases/open frames, SFU host publications, browser
  contexts. Unavailable observations stay unavailable.
- Trusted authority: each cycle (and after the in-place replacement) the
  harness reads the desktop's authority bound from its publish answer and
  accepts it only when its participant SID and camera track SID equal the
  SFU's `GetParticipant` facts; then hands it to the program and guest pages
  through the loopback-only `cameraFrameExperiment=1` hook.
- Observers: `requestVideoFrameCallback` on the real decoded packed video
  (program and every guest page) decodes the transport stamp each presented
  frame and samples transport patches/flash every 15th sequence, keeping
  browser metadata (presentation, expected display, RTP, receive, capture
  times) as given. The same callback samples the camera-frame adapter's
  unpacked canvas (logical coordinates, real alpha channel) on program and
  guest pages, and records whether the packed video was ever visible. In
  cycle 0 the desktop monitor's adapter canvas is sampled every poll.
- Clock: native pull brackets -> renderer performance -> Node monotonic;
  program presentation -> Node monotonic; piecewise linear within 2 s, no
  extrapolation. Latency is an interval; the budget uses its upper bound.
- `VIDEORC_CAMERA_BRIDGE_MODE=analyze VIDEORC_CAMERA_BRIDGE_EVIDENCE=<file>`
  re-analyzes after verifying artifact hashes.

Budgets (declared, **not measured**): native->decoded upper p95 <= 250 ms
(local), drift growth <= 80 ms over >= 1,800 s, decoded/written >= 0.95 with

> = 6 participants, native leases <= 2, alpha +/-16 and color +/-24 (S10),
> flash luma >= 200 / <= 55, post-warm-up renderer heap rise <= 10 %, >= 25
> generations closed cleanly, surface resets and replacement continue frames.

Gates added for the consumers: `unpackedPatches.program`,
`unpackedPatches.monitor`, `unpackedPatches.<guest>` (adapter output against S10
tolerances), `packedNeverShown` and `authorityMatchesSfu`; the packed-frame check
is now `transportAlphaPatches`.

Explicitly **unavailable** (qualification fails until supplied):
`packetizedSentTiming` (per-frame wire send and SFU arrival are not observable
from supported APIs), `managedRecorderBudgets` (needs a separately authorized
managed run; the recording analyzer is ready for its artifact) and the other
platform's run. `droppedFrameDelta` is unavailable until a matched baseline
evidence file is supplied; `encoderObservation` is unavailable when the run
cannot prove the RTP association.

## Consumers: program, guest and monitor (new)

All three use a separate camera-frame adapter over S10's GPU helper
(`createAlphaGpu(canvas, 640, 360, 'unpack')`). None uses `AlphaManifest`,
`receiveAlphaExperiment`, `ALPHA_ROLE`, S10's wall-clock stamp, or a track name
as authority (a web test strips comments and asserts this).

- **Authority.** Desktop `TalkShowRoomClient` binds the generation to its own
  publication from the SFU's publish answer: `room.localParticipant.sid`,
  `publication.trackSid`, `host:<show>`, `canPublishSources` from the actual
  permission (LiveKit source numbers mapped by `publishSourceNames`), and a
  random epoch per room connection. `bindCameraFramePublication(...,
'packed', { experiment: true })` must pass, otherwise a problem is reported.
  Exposed as `snapshot.local.cameraFrame` only while the source lives.
  Receivers check the authority against the facts they themselves observed
  (`cameraFrameBinds`: identity, participant SID, track SID, `camera`) on every
  decoded frame.
- **Disabled capability.** `CAMERA_PACKED_ALPHA_ENABLED = false` on both
  sides. Web pages accept authority only through `cameraFrameExperiment(win)`:
  loopback host AND `cameraFrameExperiment=1`; a deployed page never installs
  the hook. The desktop monitor runs only for the DEV frame fixture.
- **Program page** (`lib/cloud/program/camera-frame.ts`, emitted;
  `stage-media.ts`, `stage.ts`, `source.ts`): `onTrack` now carries the SFU
  facts (participant SID, track SID). `StageMedia.setCameraFrame(frame)` draws
  the adapter canvas instead of the video; placement and stills use the
  logical size. Once a packed track is bound its raw video stays hidden
  (opacity 0, still decoding) even after the adapter closes; only a new track
  resets that.
- **S12 seam.** `StageMedia.logicalSize()` (and the adapter's own
  `logicalSize()`) implement S12's `SceneMediaSize` structurally: 640x360 for a
  1288x360 packed track, null otherwise so S12 uses `videoWidth/videoHeight`.
  Mount contract for S12: the adapter mounts `<canvas class="tile-video
tile-camera-frame" data-camera-frame="rgb-left-alpha-right:g8">` as the
  video's next sibling in the tile, sized to the logical source, and fires a
  `resize` event on that canvas when its first frame is drawn.
- **Guest page** (`components/guest/guest-tracks.tsx`, `guest-room.tsx`): the
  host camera tile passes the host's participant SID; `TrackVideo` binds the
  adapter to `track.sid`, hides the packed video and mounts the canvas with
  the same fit classes (mirror is never applied by the adapter).
- **Desktop monitor** (`renderer/src/lib/camera-frame-media.ts`,
  `components/studio/show-stage.tsx`): the host's own camera tile draws the
  adapter canvas; the adapter module is loaded with a dynamic import so S10's
  GPU helper stays out of the eager Studio bundle. The packed picture is never
  shown, even if the adapter is refused.
- **Packing mirror.** Desktop `room-frame.test.ts` checks gutter, fps,
  `packedSize` and `alphaDimensions` agreement against S10's `cloud-alpha.ts`;
  web `cloud-camera-frame.test.ts` checks the layout string and sizes against
  `alpha-transport.ts`.

## Acceptance evidence: composited, baseline, encoder, scenes (new)

All runnable, none executed. Evidence keeps three labels apart: `raw`
(decoded packed transport, `patchSamples`), `adapter` (unpacked canvas,
`unpackedSamples`) and `composited` (final compositor pixels, `composites`,
plus `composited-recording`).

- **Composited pixels** (`compositedPixels.<surface>`): Playwright page
  captures (Chromium compositor) of the program and a guest tile, and the
  desktop window capture (`capture-page`) for the monitor, decoded with
  FFmpeg. `cameraFrameGeometry` measures the canvas's drawn box after CSS fit
  and transforms, composes every ancestor's mirror (S12 mirrors its clip),
  intersects every clipping ancestor and reads radius/clip-path and the CSS
  ground. `compositeProbes` maps patch probes, edge probes either side of each
  band boundary (catches misplacement or rescale), a mask-corner probe and
  crop probes just outside the tile; points outside the visible tile or mask
  shape are crop/mask expectations, never dropped. `assessComposite` checks the
  transparent patch against the ground, the half-alpha blend over the measured
  background (and that it is distinguishable from an unblended source), solid
  colour, and that clipped points show no camera.
- **Program copy fix (web `stage-media.ts`)**: under a translucent frame the
  still-copy beneath would blend twice; it is hidden while a live adapter
  draws and returns whenever it must cover (stall, privacy, adapter closed).
- **Finalized recording** (`scripts/lib/cloud-parity-camera-bridge-recording.mjs`):
  streams the composited program screencast through FFmpeg with one frame
  buffer and an explicit frame bound, reads stamps and blended patches at the
  measured geometry, and reports continuity (runs, gaps, backwards, coverage,
  span). Too-small cameras are `unavailable`. `--mode analyze-recording`
  analyzes an operator-supplied managed egress recording only with
  `VIDEORC_MANAGED_RECORDING_AUTHORIZED=1`; it never downloads anything.
  Container PTS and A/V sync are not claimed.
- **Matched no-bridge baseline**: `VIDEORC_CAMERA_BRIDGE_VARIANT=baseline`
  repeats the run with the ordinary browser camera (same guests, layout,
  duration). Every program video reports unique presented frames per fixed
  1 s window (zero-frame windows included). `VIDEORC_CAMERA_BRIDGE_BASELINE_EVIDENCE`
  enables `droppedFrameDelta` (budget ≤ 1 percentage point); unmatched runs
  (platform, web revision, guests, duration > 5 %) are refused.
- **Encoder observation** (`room-frame-encode-observer.ts`,
  `room-frame-encode-worker.ts`, `cloud-parity-camera-bridge-encode.mjs`): a
  harness-only `RTCRtpScriptTransform` on the camera sender passes every
  encoded frame through unchanged and records RTP timestamp, type, size and
  transform time (cross-context clock bracket measured on each drain).
  Association to native frames is accepted only if one RTP offset matches ≥ 95 %
  of ≥ 30 frames within 1 tick of 90 kHz × `ptsUs`; otherwise `unavailable`,
  never synthesized. Gate `encoderObservation` (declared budget: encode delay
  upper p95 ≤ 100 ms). `packetizedSentTiming` stays unavailable: the transform
  runs before packetization, pacing and send, and outbound-rtp stats are
  aggregate counters only. Without `RTCRtpScriptTransform` the observer reports
  `unavailable` with that API name and leaves the sender untouched.
- **S12 scene geometry on the camera** (`cloud-parity-camera-bridge-scenes.mjs`
  on S12's own `savedScene`/`layoutOf`, now exported): cover + crop + rounded,
  contain + mirror, and circle. After the endurance recording closes, each is
  saved and applied through S12's real seams, waits for S12's applied receipt
  and the logical scene canvas, then is captured. `sceneGeometry.<case>`
  requires the receipt, composited checks, a visible patch, and the expected
  mirror/mask/crop. Tests drive S12's committed `scenePicture` and catch an
  ignored mirror, geometry from the packed size, a missing mask and a missing
  crop. (A zoomed circle hides every patch, so the circle case does not zoom.)

## Common clock on the PCM producers (new)

Coordinated with G67rq (S7b/S8). Additive; S8 system audio stays frozen and
consumes the published API later.

- S7a synthetic (`room_audio_bridge.rs`) and S7b processed
  (`room_microphone.rs`, `session_audio/room_tap.rs`): the generation's
  existing epoch (`Source.start` / `RoomMicrophoneTap.epoch`) yields
  `originUs = room_clock::origin_us(epoch)` and `incarnation`, captured once.
  Open replies are now `{generation, originUs, incarnation}`; every frame
  carries both (null when absent, never 0). `origin + observedAtUs` above
  2^53-1 is refused before draining or allocating.
- `firstSampleUs`/`observedAtUs` keep their generation-relative meaning. For
  S7b `originUs + firstSampleUs` is the PROCESSED timeline (SourceClock,
  intentional offset, RNNoise lookahead); the offset stays in `delay_frames`.
- TS `room-pcm.ts`: `parseRoomPcmOpened`, clock fields on `RoomPcmFrame`,
  `pcmNativeCaptureUs`; validation before sample traversal. The main bridge
  validates the open reply and still returns null to renderers (IPC schema
  unchanged). Renderer `native-frame` diagnostics add `originUs`,
  `incarnation`, `nativeCaptureUs` and `timeline` (`synthetic`/`processed`).
- Fixtures `room-pcm.json`, `room-microphone.json` gain a `clock` block;
  `clockQualification` stays unavailable.
- `derivePcmClocks` adds per-sample `nativeUs`/`incarnation`, records
  `commonClockOrigin` unavailable for a null origin, and refuses mixed
  incarnations, moving origins and unsafe sums. No A/V timing is claimed: the
  camera-bridge case captures no audio, and encoder timing stays unavailable.

## Verification (focused only)

On current main (desktop `4ff715681`, web `ab811051`), 2026-11-17:

- Desktop TS7 node and web projects: pass.
- Desktop Vitest, 35 files / 589 tests (frame/PCM/microphone bridges and
  sources, encode observer, camera-frame adapter, room-frame contract and S10
  mirror, room client, S15 speech source, Show stage, IPC contract, security
  policy, S6 views, S9 graphics, S12 scene/preview/resender/guest roles, RPC
  contract, aux/avatar publishers, room join): all pass.
- Node `scripts/lib/cloud-parity-*.test.mjs`: 92/92.
- Rust compiled only in isolated scratch crates (`room_clock` +
  `room_frame_bridge` 5/5, `room_clock` + `room_audio_bridge` 7/7, Clippy
  clean). NOT compiled: `room_microphone.rs`, `room_tap.rs`, `main.rs`.
  `cargo fmt --check --all` passes.
- Prettier, Oxlint (one existing `use-studio.tsx` warning; two justified
  worker-scope `postMessage` suppressions), em-dash, text integrity,
  `git diff --check`: pass.
- Web `tsc --noEmit` pass; 387 focused tests, 379 pass. The 8 failures are
  pre-existing: the same 8 fail on clean web main `ab811051` (stage-metadata,
  bundle, managed-talk). Emitter `--check` up to date; scoped ESLint and
  Prettier clean.
- Shadscan: desktop 27 (floor 27), web 47 (floor 47).
- Not run: every smoke, the `camera-bridge` case in any variant, real pages,
  devices, builds, full suites, managed or provider calls.

## PR-ready text

### Desktop

Title: `Plan 249 S13a: add disabled native camera-role frame and clock bridge`

Body:

Room camera contributions come only from browser capture. Add an explicitly
gated native test source that carries packed color+alpha camera-role frames
through authenticated main/preload IPC into a timestamp-preserving
`MediaStreamTrackGenerator` on the existing LiveKit camera lane, with two-slot
leases, surface-epoch revocation on GPU reset, one request credit, generation
fencing and connection-owned cleanup. Bind each generation to the SFU's own
publish answer as a separate camera-frame contract (never S10's layer manifest
or a track name) and draw the monitor tile through an unpacking adapter whose
logical size feeds S12's scene preview. Add one native monotonic clock anchor
with a process incarnation and carry its nullable origin on the S7a and S7b
PCM producers, mirrors, diagnostics and clock derivation. Extend the
maintained `camera-bridge` case with SFU-matched authority, adapter and final
composited pixel checks (program, guest, monitor and the finalized program
recording), S12 scene cases (crop, fit, mirror, mask), a matched no-bridge
baseline for the dropped-frame delta, and an encoded-transform observer whose
RTP association is accepted only when proven.

Packed and native production stay disabled; no grant, Preview, device or
security change. Base: main `4ff715681` (S6-S21c merged). Pair with the web PR and deploy
web first. Focused checks only: TS7, Vitest, Node, isolated Rust module tests,
lint and format. Backend compilation and every runtime, managed and platform
gate are deferred; no latency, drift, A/V, encoder or platform qualification is
claimed.

### Web

Title: `Plan 249 S13a: add disabled camera-frame consumer for program and guests`

Body:

Add a camera-frame adapter that unpacks S10-packed camera-role tracks with
S10's GPU helper and binds them only to a trusted controller authority that
matches the publication the page itself subscribed (participant SID, track
SID, camera source). The program stage draws the adapter canvas at the logical
640x360 source and reports it through S12's `logicalSize()` seam, hides its
still-copy while a translucent frame is live, and never shows the raw packed
picture once bound. Guests draw the host camera the same way. Authority is
accepted only on a loopback page with `cameraFrameExperiment=1`; packed camera
mode stays disabled everywhere else. Emits the new module and the changed
stage, media and source modules. Base: web main `ab811051`. Focused checks only; pre-existing failures
unchanged.

## Exact changed paths

Desktop (vs main `4ff715681`), 31 modified + 25 new:

- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/room-pcm-bridge.test.ts`
- `apps/desktop/src/main/room-pcm-bridge.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/components/studio/show-stage.tsx`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/hooks/use-talk-show-room.ts`
- `apps/desktop/src/renderer/src/lib/room-microphone-source.ts`
- `apps/desktop/src/renderer/src/lib/room-pcm-buffer.test.ts`
- `apps/desktop/src/renderer/src/lib/room-pcm-source.test.ts`
- `apps/desktop/src/renderer/src/lib/room-pcm-source.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.test.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.ts`
- `apps/desktop/src/shared/backend.ts`
- `apps/desktop/src/shared/electron-ipc-contract.test.ts`
- `apps/desktop/src/shared/electron-ipc-contract.ts`
- `apps/desktop/src/shared/renderer-security-policy.ts`
- `apps/desktop/src/shared/room-microphone.test.ts`
- `apps/desktop/src/shared/room-microphone.ts`
- `apps/desktop/src/shared/room-pcm.ts`
- `crates/videorc-backend/src/main.rs`
- `crates/videorc-backend/src/room_audio_bridge.rs`
- `crates/videorc-backend/src/room_microphone.rs`
- `crates/videorc-backend/src/session_audio/room_tap.rs`
- `protocol-fixtures/room-microphone.json`
- `protocol-fixtures/room-pcm.json`
- `scripts/lib/cloud-parity-media.mjs`
- `scripts/lib/cloud-parity-pcm-acquisition-contract.mjs`
- `scripts/lib/cloud-parity-pcm-acquisition-contract.test.mjs`
- `scripts/lib/cloud-parity-scenes-contract.mjs`
- `scripts/smoke-cloud-parity-app.mjs`
- `apps/desktop/src/main/room-frame-bridge.test.ts` (new)
- `apps/desktop/src/main/room-frame-bridge.ts` (new)
- `apps/desktop/src/renderer/src/lib/camera-frame-media.test.ts` (new)
- `apps/desktop/src/renderer/src/lib/camera-frame-media.ts` (new)
- `apps/desktop/src/renderer/src/lib/room-frame-encode-observer.test.ts` (new)
- `apps/desktop/src/renderer/src/lib/room-frame-encode-observer.ts` (new)
- `apps/desktop/src/renderer/src/lib/room-frame-encode-worker.ts` (new)
- `apps/desktop/src/renderer/src/lib/room-frame-source.test.ts` (new)
- `apps/desktop/src/renderer/src/lib/room-frame-source.ts` (new)
- `apps/desktop/src/renderer/src/lib/room-frame-test-state.ts` (new)
- `apps/desktop/src/shared/room-frame.test.ts` (new)
- `apps/desktop/src/shared/room-frame.ts` (new)
- `crates/videorc-backend/src/room_clock.rs` (new)
- `crates/videorc-backend/src/room_frame_bridge.rs` (new)
- `docs/cloud/249-s13a-handoff.md` (new)
- `protocol-fixtures/room-frame.json` (new)
- `scripts/lib/cloud-parity-camera-bridge-acquire.mjs` (new)
- `scripts/lib/cloud-parity-camera-bridge-contract.mjs` (new)
- `scripts/lib/cloud-parity-camera-bridge-contract.test.mjs` (new)
- `scripts/lib/cloud-parity-camera-bridge-encode.mjs` (new)
- `scripts/lib/cloud-parity-camera-bridge-encode.test.mjs` (new)
- `scripts/lib/cloud-parity-camera-bridge-page.mjs` (new)
- `scripts/lib/cloud-parity-camera-bridge-recording.mjs` (new)
- `scripts/lib/cloud-parity-camera-bridge-recording.test.mjs` (new)
- `scripts/lib/cloud-parity-camera-bridge-scenes.mjs` (new)

`scripts/lib/cloud-parity-scenes-contract.mjs` changes only by exporting S12's
`savedScene` and `layoutOf` builders.

Web (vs main `ab811051`), 13 paths:

- `components/guest/guest-room.tsx`
- `components/guest/guest-tracks.tsx`
- `docs/cloud/249-s13a-handoff.md`
- `lib/cloud/program/camera-frame.ts`
- `lib/cloud/program/source.ts`
- `lib/cloud/program/stage-media.ts`
- `lib/cloud/program/stage.ts`
- `lib/cloud/program/tools/emit.ts`
- `public/cloud/program/v1/camera-frame.js`
- `public/cloud/program/v1/source.js`
- `public/cloud/program/v1/stage-media.js`
- `public/cloud/program/v1/stage.js`
- `tests/cloud-camera-frame.test.ts`

SHA-256 manifests: `/Users/orcdev/249-s13a-frozen-backup/main-port/{desktop,web}-manifest.txt`.

## Dependencies before PR-ready

- All prerequisites (S6, S7b, S9, S10, S12) are on main; nothing to merge first.
- Repair PR 1457 is open on main; rebase if it touches the same files.
- S8 (G67rq): frozen; consumes `room_clock` after this is published.
- S19 (G55dg) and S15: server show clock and source offset stay separate from
  the native anchor; no conversion is claimed.
- S22 (G1wkh): layout descriptor and role frozen; no code dependency.
- S17 (G98zv): shared contracts only (camera role, logical size, descriptor).
