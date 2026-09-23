# Plan 046: Change camera, microphone, and screen sources during a session

> Executor: read the whole plan and `AGENTS.md` before implementation. Finish
> each phase with its verification gate. Source switching must never stop and
> restart the recording or broadcast. Update this plan and its index status
> with actual evidence; a passing RPC is not evidence that viewers received it.

## Status and implementation baseline

- Status: IN PROGRESS — execution on `feat/live-source-switching`; capabilities remain disabled until the relevant adapter gates pass.
- Priority: P1. Effort: L. Risk: HIGH (capture ownership, continuous audio,
  session cancellation, native preview, and both recording/stream outputs).
- Planned: 2026-09-23. Plan-storage checkout: `15206746`.
- Implementation baseline inspected: local `main` at `92190364`, in
  `/Users/orcdev/projects/videorc-wt-scheduled-livestreams`. The observations
  below were checked against that newer checkout as well as the storage branch.
- Start from current main in an isolated worktree. Do not implement against
  the older storage branch or overwrite the other active worktrees.
- Dependencies: the current main versions of clean scene switches, Freeform
  continuity, and saved visual scenes. Those behaviors are already present at
  the inspected implementation baseline; the old TODO labels in Plans 042–044
  are not instructions to rebuild them. Existing Windows and capture-decay
  release restrictions remain independently applicable.
- Before editing, run `git diff --stat 92190364..HEAD -- crates/videorc-backend/src
apps/desktop/src scripts package.json` and `git status --short`. Compare changed
  relevant symbols to the evidence below. Reconcile drift before implementation.

## Requested outcome and product decisions

The user can select another camera, microphone, screen, or window while recording,
streaming, or doing both. Quick Settings and Sources offer the same behavior.
The recording stays one take and the broadcast stays connected.

| Situation                                  | Required behavior                                                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle                                       | Existing selection/preview behavior remains available.                                                                                                                 |
| Recording, streaming, record + stream      | Source selectors remain usable; route selections through backend transactions.                                                                                         |
| Starting or stopping                       | Disable source changes briefly with an explicit reason. Backend independently refuses them.                                                                            |
| Switch pending                             | Show the target and “Switching…” beside the confirmed current source. Disable the conflicting source/scene controls; Stop and microphone mute stay available.          |
| Target cannot open or become ready         | Show the actual failure. Keep the previous healthy input where possible; otherwise attempt bounded restoration and report its actual result. Session/output continues. |
| No microphone → microphone → no microphone | Supported within the same session. “No microphone” writes silence and closes device capture, without removing the output audio track.                                  |
| Unplugged microphone                       | Keep output audio time moving with silence, report the loss, and allow choosing a replacement. Do not silently select the OS default.                                  |
| Camera off/on                              | Support intentional removal/addition without changing output dimensions. Preserve layout geometry; an intentionally empty camera-only canvas is black.                 |
| Screen/window removal                      | Only offer None where the active layout permits it. Required screen/window slots must receive a replacement or an explicit layout change.                              |

Source warm-up and output continuity are different guarantees. The encoder,
muxer, transport connections, session ID, output file, timer, and media timeline
must remain continuous. A native device may require a brief capture gap. The
current singleton camera owner retires the old capture before starting its
replacement; for that path keep the compositor running with black in the
unavailable region and honest pending status. Never call the old camera “still
live” after it has stopped. Other layers and audio continue normally.

For microphones, prepare the replacement while the healthy old input continues
when device sharing permits it. Commit only after timestamped PCM arrives;
silence is valid PCM and readiness must not depend on someone speaking. If
exclusive ownership makes overlap impossible, use a bounded release/open
transition with silence and attempt restoration on failure. State that outcome
explicitly. Zero-gap camera replacement across all devices is not a prerequisite
for this feature and is not promised by this plan.

Changing resolution, frame rate, codec, canvas orientation, recording destinations,
or provider broadcast metadata is outside this feature. Preserve gain and mute
across input switches, including a mute issued during warm-up. Preserve the
session's configured sync offset; changing a device does not silently reset or
recalibrate it. Physical device latency can differ and must be measured in QA.

## Current state and evidence

Paths below are relative to the repo; line references use `92190364` unless
explicitly marked otherwise. Search the symbols when line numbers drift.

1. `apps/desktop/src/renderer/src/components/studio/quick-settings.tsx:143,157,188`
   disables screen, camera, and microphone with `disabled={isSessionActive}`.
   Its handlers directly edit `captureConfig.sources`.
2. `components/tabs/sources-tab.tsx:158–180,309–341` already routes active video
   selection through `switchSourceDeviceLive`. The microphone at line 414 is
   still disabled for the whole session and only edits local config.
3. `hooks/use-studio.tsx:7971` has the existing video transaction:

   ```tsx
   const status = await client.request<LiveLayoutApplyStatus>('scene.source.device.switch', {
     sources,
     layout: captureConfig.layout,
     video: captureConfig.video,
     background: activeSceneBackground,
     protectedOverlayWindowIds
   })
   // Later: rememberLiveLayoutCommit, applyScene, setCaptureConfig,
   // and persistWorkingVisual after the response.
   ```

   This sends a whole captured configuration, has no explicit session ID in
   this request, and uses React pending state as its local guard. A delayed
   response can overwrite unrelated source selections unless updates become
   field-scoped and generation-checked. Its output-proof warning is valuable:
   a committed mutation with delayed proof is not a failed/uncommitted switch.

4. `crates/videorc-backend/src/live_layout.rs:437` delegates video switching to
   `apply_scene_transaction`. It checks selected device identity/readiness and
   commits a scene revision without restarting encoders. Existing camera/screen
   readiness budgets are 15 seconds. It does not switch the session microphone.
   The special dual-orientation branch must also be checked: a device change
   must not return through a scene-only fast path that skips source preparation.
5. `preview_camera.rs:1408` calls
   `stop_current_camera_for_restart_if_admitted` before opening the replacement.
   The existing “old layout stays live” comments are not proof of continuous old
   device capture. Generation/admission/recovery fencing must survive this work.
6. `compositor.rs::publish_compositor_frame` now calls
   `live_sources.adopt_for_scene(state, render_cache)` directly after refreshing
   the scene. Keep this identity-aware adoption and black missing-source output;
   do not reintroduce periodic-only adoption, stale-device frames, or diagnostic
   colors from before Plan 042.
7. `audio.rs:507,567,926` couples a `NativeAudioSource` to a
   `NativeAudioCaptureSession` and its FIFO writer. The session owns the device,
   receiver, stop flag, writer, and FIFO cleanup. Its writer exits and closes the
   FIFO on producer loss. Dropping/replacing this object would close the output
   input, which cannot implement a recoverable mid-session switch.

   ```rust
   pub fn attach_fifo_writer(
       source: NativeAudioSource,
       fifo_path: PathBuf,
       video_epoch: Option<Arc<OnceLock<Instant>>>,
   ) -> NativeAudioCaptureSession
   ```

8. `recording.rs::prepare_native_audio_source` (11625),
   `resolve_microphone_input` (10080), and `capture_input.rs::append_microphone_input`
   establish inputs at session startup. CoreAudio feeds a 48 kHz stereo float32
   FIFO. AVFoundation fallback and Windows DirectShow microphones are inputs of
   the main FFmpeg process itself. A Windows device switch therefore also needs
   capture/output separation; a UI-only unlock cannot work.
9. `audio.rs::discard_audio_until_video_epoch`, `trim_audio_frame_before_epoch`,
   and `pad_leading_silence_once` align startup audio. Raw f32le writing does not
   carry frame timestamps; FFmpeg derives time from sample count. Restarting
   these startup helpers per input would reset or misalign the running audio.
10. `audio.rs` offers post-control frames to `captions::offer_caption_frame`.
    `captions.rs` resets anchors when frame timestamps regress. Replacement
    devices need session-relative timestamps, with captions remaining attached
    to the bus, rather than to a retired microphone producer.
11. `recording.rs::update_active_audio_processing` checks session ID and
    `stop_requested`, then updates native processing or the acknowledged FFmpeg
    control lane. Follow its session fencing. `main.rs` dispatches gain/mute
    independently so Stop is not blocked waiting for an audio acknowledgement.
12. `warm_microphone.rs` owns idle standby capture and transfers it at startup.
    `hooks/use-studio.tsx` also reconciles source selections after device refresh
    (line 5223). Neither standby nor inventory reconciliation may become a
    competing owner of the active source during a switch.
13. `lib/mic-stream.ts` and `hooks/use-studio-mic-visual.tsx` own a visual-only
    browser microphone stream. A waveform from that stream does not prove what
    the encoder receives. `lib/scene-presets.ts::VisualSources` intentionally
    excludes microphone settings; keep audio global when saving visual scenes.

Conventions: Rust `Result`/explicit reason codes, serde camelCase wire types
mirrored in `apps/desktop/src/shared/backend.ts`; pure TS state helpers with
Vitest tests next to them; provider behavior in
`hooks/studio-provider.integration.test.ts`. Match existing source builders in
`lib/capture.ts`, authenticated backend commands, and source generation leases.

## Architecture

### A. One session-bound source-switch coordinator

Add a small `live_source_switch.rs` module; avoid putting another large state
machine directly into `main.rs` or `use-studio.tsx`. Expose the proposed commands:

- `session.source.switch`: `{ sessionId, requestId, expectedSourceRevision,
kind: "capture" | "camera" | "microphone", deviceId: string | null }`.
  Resolve names, platform IDs, and permissions on the backend. Do not accept a
  client-supplied output profile or a whole source/config snapshot.
- `session.sources.get`: confirmed selection, actual per-source health,
  source revision, pending operation, last terminal operation, and capabilities
  for the requested active session. Include this state in the reconnect snapshot.
- `session.sources.changed`: bounded operation/status events using the same
  shape, available to the authenticated renderer. Do not add them to LAN events
  or the remote-role allowlist. Redact paths/credentials from failures.

Seed confirmed session selection from the actual resolved startup inputs, not
just the renderer's requested IDs, and update it with all accepted scene/source
mutations. Source revisions track selection changes; keep them distinct from
compositor scene revisions and device generations. Preserve screen-capture
exclusion protection: capture switches carry the refreshed
`protectedOverlayWindowIds` through the existing trusted main/renderer helper
and backend validation, or obtain the equivalent current trusted snapshot on
the backend. Never drop overlay exclusions when narrowing the new request.

An operation moves through admitted → preparing → committing → applied, or a
terminal failed/cancelled outcome. A failed outcome also reports whether the old
source was preserved, restored, or remains unavailable. Output-observation
status is separate from selection commit status.

Use one admitted device-switch transaction per session initially. Reject a
concurrent switch as busy; do not build an unbounded queue. Stable duplicate
`requestId`s return the same in-flight or terminal result rather than reopening
hardware. Keep a bounded, session-scoped result cache so response loss/retries
can be reconciled. A no-op selection of a healthy current source is idempotent;
reselecting a failed current device may deliberately retry capture.

Check session identity, stop marker, expected revision, target kind/availability,
and transport capability before native work and again at commit. Do not hold the
recording, compositor, or dispatcher lock while opening/closing devices. Use
owned cancellation/cleanup workers: timing out `spawn_blocking` does not stop
its native work, so a late opener must close its own device and never publish it.

Coordinate video changes with existing layout intents and capture-recovery
leases. The frontend prevents conflicting scene edits during an operation;
backend fencing also covers remote layout shortcuts and reconnects. A newer
layout intent can cancel the pending video switch, but cannot be overwritten
by its late response. Stop always preempts preparation and prevents further
commits. Gain/mute updates remain available and feed the current bus settings.

Initial proposed operation budgets: mic open ≤5 seconds, then first-PCM readiness
≤2 seconds, then commit acknowledgement ≤1 second; restoration gets its own
equivalent bounded attempt. Video keeps the existing ≤15-second source-start
budget, plus a separately bounded ≤15-second restoration attempt. Define shared
backend/client timing contracts that also include bounded queue and response
delivery time; the RPC timeout must cover the whole operation, not just opening
the target. Report stage durations, calibrate on supported hardware, and retain
explicit timeout tests. Retired-worker cleanup has a separate ≤5-second deadline
where a killable worker exists; uninterruptible native work remains quarantined
under its owner until it exits and cannot publish after cancellation.

Keep `scene.source.device.switch` compatible for existing internal clients, but
make active-session video calls use the same ownership checks. Reject attempts
to change microphone identity through a scene-only mutation. Update maintained
callers to the session command; do not leave an unfenced alternate route.

### B. A continuous session audio bus

Create `session_audio.rs` to own the session's normalized PCM output, timeline,
gain/mute, captions tap, active device adapter, pending replacement, and source
health. `audio.rs` retains reusable capture/format helpers and CoreAudio opening.

```text
CoreAudio / AVFoundation capture adapter / DirectShow capture adapter
                       ↓ selected producer + generation
       normalize → align to session sample position → gain/mute
                       ↓
        session audio bus ─────→ captions and backend level meter
                       ↓
      one open FIFO / named pipe for the entire session
                       ↓
       existing output FFmpeg → recording + stream destinations
```

The output format remains 48 kHz, stereo, float32. Create its input/track at
startup even when no mic is selected, using paced silence with no device open.
This deliberate track-topology choice enables None→mic without restarting a
muxer. Update FFmpeg input mapping, captions admission, and post-recording
expectations accordingly. Synthetic silence is not evidence of working capture,
and does not bypass existing caption eligibility or explicit-consent checks.

The bus owns one monotonically increasing sample cursor tied to the existing
video/session epoch. With 48,000 samples/second, sample position advances across
every device transition. Use bounded chunks (initially 10 ms) and queues; emit
silence when input is unavailable, trim overlapping/late input, and bound future
buffering. Do not replay prepared pre-roll after commit or replay accumulated
audio after downstream pressure. Resample/channel-normalize at the adapter
boundary, with measured clock drift handled without resetting the bus cursor.

Readiness requires valid fresh PCM for the exact candidate generation. On commit,
drop pre-cutover samples, select the candidate at a bus chunk boundary, apply the
latest gain/mute exactly once, and retire the old producer. Use a short bounded
ramp through zero (proposed total ≤10 ms) to suppress clicks; never mix two
microphones into program output. No unmuted candidate or pre-commit candidate
samples may reach encoding, captions, or the confirmed level meter.

Preserve the same bus on input loss/None. Distinguish device loss, intentional
silence, and downstream pipe failure. Only final session teardown closes the
output pipe. Keep intentional generated samples separate from real captured,
discarded, and dropped sample counters; use per-device generations for health
and silence warnings, plus cumulative session counters for finalization.

Do not directly reuse `NativeAudioCaptureSession::Drop` for a device replacement:
split device cleanup from bus cleanup. Shutdown must interrupt bounded IO and
reap owned workers before completion without hanging under the recording lock.
Preserve startup FIFO-open ordering and existing stop/finalization safeguards.

### C. Platform capture adapters

1. macOS CoreAudio: reuse native capture and standby handoff, transferring only
   the producer into the session bus. Standby may not arm/disarm the active bus.
2. Windows DirectShow and macOS AVFoundation fallback: separate capture from the
   main encoder. The initial implementation should reuse the bundled FFmpeg as
   an owned capture-only worker producing normalized PCM, with bounded stdout
   draining, explicit first-PCM readiness, stderr health, and exact device IDs.
   Only this producer worker changes on device replacement; the output FFmpeg
   process and transport connections remain stable.
3. A capture-worker timestamp/sample-clock contract must be established in S4:
   raw stdout receive time alone cannot prove capture time. Carry timestamp
   metadata if needed, or prove a bounded queue/latency mapping with measured
   artifacts. Do not pretend a DirectShow string can be passed to the numeric
   CoreAudio API. If this adapter cannot meet the A/V gate, stop that phase and
   specify a native capture adapter before claiming Windows support.
4. Expose actual capabilities per running session. Legacy/debug paths without
   switchable video or audio must return a concrete reason. Supported production
   macOS and Windows paths are completion requirements; silently retaining
   disabled Windows microphones is only an intermediate phase, not “done.”

### D. Video source changes

Reuse `live_layout.rs` and the compositor rather than rebuilding encoding. Apply
only the requested source field to the latest authoritative scene/config;
preserve custom transforms, backgrounds, source order, and animation settings.
Readiness and commit must use the selected identity and generation.

Audit all output consumers: primary, stream auxiliary, vertical simulcast,
preview, and Windows proof surface/direct media path. A global camera/screen
selection must reach every output that uses that source, including a source
currently needed only by the vertical leg. Do not assume primary preview proof
proves the other outputs changed. Source retirement uses the union of consumers.

For the current sequential camera/screen lifecycle, retain confirmed selection
while preparing but report actual capture health. On failure, restart the
previous selected input if it was retired; do not call an unchanged scene a
rollback when its device is closed. Bound target start using existing budgets,
and bound restoration separately; expose both stages to the client. Restore
against current generation/session, never after Stop or a superseding intent.
If restoration fails, render black for the missing source and allow retry.

Intentional camera removal must explicitly disable its contribution and release
its lease without changing canvas/profile or resetting transforms. Adjust the
existing missing-selection blocker deliberately for this case; do not allow
arbitrary invalid scenes. Re-adding a camera restores the retained slot geometry.

## Implementation phases

Every phase leaves existing capture usable. Keep new capabilities disabled
until their backend path and tests exist. Use an isolated branch such as
`feat/live-source-switching`; make focused commits only when requested, staging
only intended files. No release, push, or provider broadcast is part of this plan.

### S0 — Establish the baseline and observable contract

Read the listed symbols on current main. Characterize Quick Settings versus
Sources, all three session modes, current gain/mute, initial None microphone,
video switch gaps, and loss behavior. Use existing provider fakes and audio test
sources; do not rely on real devices for deterministic ownership tests.
Record the production video/audio paths in each platform and their capability
requirements. Capture the same-source no-switch A/V baseline for comparison.

Verify: `pnpm --filter @videorc/desktop test src/renderer/src/hooks/studio-provider.integration.test.ts
src/renderer/src/lib/live-audio-processing.test.ts` and
`cargo test -p videorc-backend audio::tests` → exit 0. Record existing failures
separately. No new controls are enabled at this phase.

### S1 — Add the source transaction protocol and cancellation model

Add the coordinator/state described in A, serde/TS mirrors, snapshot/events,
capabilities, error codes, idempotency, and renderer request timing contracts.
Wire authenticated dispatch and mutation inventory/deadlines in `main.rs`.
Keep Stop responsive while hardware work is pending. Initial unsupported
adapters return an explicit capability refusal without mutation.

Add deterministic tests for duplicate requests, stale revision/session, busy,
stopping, target identity, late completion, lost response then status lookup,
timeout, and stop/start on a new session. Do not use sleeps for race ordering.

Verify: `cargo test -p videorc-backend live_source_switch`;
`pnpm --filter @videorc/desktop test src/renderer/src/backendClient.test.ts`;
`pnpm typecheck` → all pass, including protocol/capability coverage. Extend the
existing backend method inventory/authorization tests and run
`cargo test -p videorc-backend` before moving on.

### S2 — Introduce the persistent audio bus without enabling device changes

Separate output transport/timeline from `NativeAudioSource`, wire the existing
CoreAudio producer through the bus, and route gain/mute/captions/health through
it. Add silence for initially absent and lost input. Update track/input mapping,
start admission, and teardown without changing output profile or audio codec.
Retain startup epoch alignment, warm microphone handoff, and capture privacy.

Test exact sample accounting, zero-input startup, producer EOF followed by
silence, short stalls, downstream closure, bounded pressure, capture-versus-
silence counters, and cancellation during startup/teardown. Characterize captions
timestamps and mute before introducing replacement adapters.

Verify: `cargo test -p videorc-backend session_audio`,
`cargo test -p videorc-backend audio::tests`,
`cargo test -p videorc-backend recording::tests`, `pnpm test:scripts`,
`pnpm smoke:captions-contract`, `pnpm smoke:record-latency:gate`, and
`pnpm smoke:recording-studio` → pass. Real-device blockage must be documented
with the closest runnable gate, never recorded as acceptance.

### S3 — Implement microphone replacement on macOS

Connect the microphone coordinator to the CoreAudio producer, including candidate
readiness, bounded preparation, latest gain/mute, commit acknowledgement from the
bus, failure/restoration, None transitions, and unplug→replacement. Transfer
standby ownership at startup; active switches never use standby as a second
capture controller. Give operation status confirmed input and bus sample position.

Use two injected sources with distinct tones/markers for deterministic tests.
Verify stale source frames and candidate pre-roll cannot reach output/captions.
Create the maintained source-switch smoke and analyzer skeleton here, exercising
the actual app/output process in record, stream-to-local-receiver, and combined
modes. Do not substitute gain/mute tests for device replacement tests.

Verify: `cargo test -p videorc-backend live_source_switch`,
`cargo test -p videorc-backend session_audio`, and new
`pnpm smoke:live-source-switch` → pass for the deterministic audio modes with
one output process/session and decoded A→B→A/no-mic/replacement evidence.
Run a permissioned packaged macOS test with two real microphones before calling
this path ready. Native opening and permissions cannot be proved by fake PCM.

### S4 — Bring fallback and Windows microphones onto the same bus

Add `audio_capture_adapter.rs` and platform adapters/owned capture workers as
described in C. Remove main-output-process ownership of switchable DirectShow
and AVFoundation input; migrate their gain/mute to the shared bus exactly once.
Use `fifo.rs` named-pipe support on Windows. Test worker startup, malformed/partial
PCM reads, buffering, permission/device errors, cancellation, and kill/reap.

Verify: `cargo test -p videorc-backend audio_capture_adapter`,
`cargo test -p videorc-backend capture_input::tests`, and the complete Rust suite
→ pass on each applicable host. On macOS, `pnpm check:windows` proves compilation
only. On Windows, run `pnpm smoke:windows-live-audio-controls` and the new switch
smoke plus final-artifact A/V analysis. Per `AGENTS.md`, run affected Windows
async/process filters at least 25 times and the full Windows Rust suite three
times from PowerShell 7; fail and clean up boundedly, with no sleep/file/shell-
grandchild lifecycle handshakes. Record real-device evidence on that host.

Example required repetition gate after naming the affected tests with their
module filters (also add any changed existing process-test filters):

```powershell
foreach ($iteration in 1..25) {
  foreach ($testFilter in @('audio_capture_adapter', 'live_source_switch', 'session_audio')) {
    cargo test -p videorc-backend $testFilter
    if ($LASTEXITCODE -ne 0) { throw "Failed $testFilter iteration $iteration" }
  }
}
foreach ($iteration in 1..3) {
  cargo test -p videorc-backend
  if ($LASTEXITCODE -ne 0) { throw "Full Rust suite failed iteration $iteration" }
}
```

Confirm the filters actually execute the intended tests; a zero-test pass does
not count toward this gate.

### S5 — Harden existing video switching and unify both picker locations

Route camera/screen through the coordinator and existing scene transaction,
including dual-output readiness, restoration, optional camera removal, and
generation-bound compositor proof. Preserve current main's scene-adoption fixes.

Extract a small renderer helper/controller, e.g. `lib/live-source-selection.ts`,
for idle-versus-running selection, session/ref guards, partial updates, and
confirmed/pending/error state. Expose one operation to Quick Settings and Sources.
Use a synchronous admission ref as well as rendered pending state so two events
in the same render turn cannot start competing requests. Apply results by source
field and matching session/revision; never write a stale whole `sources` object.

During sessions, device inventory refresh updates available options and health,
not confirmed capture selection. Automatic fallback must not change the UI to a
device the backend never opened. A timeout/socket loss queries source status;
an unknown result shows “Checking source…” until reconciled. Do not optimistically
restore A when B committed but its response was lost. Stop clears operation UI
without allowing old replies into the next session or persisted preferences.

Keep saved visual scene semantics: confirmed video switches update working visual
state as today; microphone switches do not rewrite saved scenes or recall audio
settings with a visual preset. Retain source IDs/names for missing confirmed
devices rather than displaying a new default as active.

UI follows `.agents/skills/videorc-design/SKILL.md` and shadcn: reuse SourceSelect,
Popover, existing status components, and Sonner for failures. Dense inline
pending/error copy, keyboard operability, accessible status announcements, both
themes. No success dialog per switch. The confirmed backend audio meter is the
authority during a session; any browser waveform remains explicitly visual-only
and follows confirmed selection, never the pending candidate or default input.

Verify: new pure/helper tests and `studio-provider.integration.test.ts`,
`pnpm --filter @videorc/desktop test`, `pnpm typecheck`, `pnpm lint`,
`pnpm smoke:preview-scene-commit`, `pnpm smoke:live-layout-switch-recording`,
`pnpm probe:preview-lifecycle`, `pnpm smoke:live-source-switch` → pass. Exercise
the real renderer picker in both locations, not only backend RPC scripts.

### S6 — Complete artifact, device, and endurance acceptance

Finish `scripts/smoke-live-source-switch-app.mjs`,
`scripts/lib/live-source-switch-gates.mjs` and its tests, and package commands
`smoke:live-source-switch` and `smoke:live-source-switch:devices`. Add the
deterministic gate to the recording-studio bundle and the device mode to its
device run. Follow `scripts/lib/recording-studio-gates.mjs`/tests for wiring.

Use existing analyzer, local RTMP receiver patterns in
`scripts/stream-av-sync-baseline.mjs`, and owned app/process launchers. Inspect
the finalized local recording and the received stream, with distinguishable
video source markers and timed audio stimuli. A successful switch RPC, preview,
file size, or manual playback is insufficient.

Run the full matrix and gates below. Save machine-readable evidence under the
existing ignored acceptance artifact locations; summarize commands and blockers
in the plan. Never commit private recordings, screenshots, device recordings,
tokens, or generated evidence. Keep `TODO`/`IN PROGRESS` until required platform
evidence exists; use `BLOCKED` with the missing host/permission/device if needed.

## Verification matrix and measurable acceptance

Cover record-only, stream-only, and record+stream; primary+auxiliary/simulcast
where enabled; macOS and Windows supported production paths.

| Cases                                                                   | Assertions                                                                                                                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Camera A→B→A; screen/window A→B                                         | Decoded source identity matches confirmed selection; unrelated layers keep moving; no prior-device pixels after target commit; geometry/background/animation preserved. |
| Mic A→B→A; different source rates/channel counts                        | Decode distinct input markers before/after each commit; output stays 48 kHz stereo; no old/candidate pre-roll after cutover.                                            |
| None→mic→None→mic; initially muted                                      | Exactly one continuous audio stream; silence in None/mute intervals; no accidental device capture or unmuting.                                                          |
| Silent but healthy microphone                                           | Switch succeeds from valid PCM; does not wait for an amplitude threshold.                                                                                               |
| Missing/busy/permission-denied/stalled target                           | Bounded error; confirmed state matches actual rollback/preservation; original session/output still running.                                                             |
| Active input unplug, then replacement                                   | Silence/black while unavailable; source-loss diagnostics; successful replacement without session restart.                                                               |
| Rapid/double click, duplicate RPC, stale revision, layout/recovery race | One admitted operation; latest authoritative state survives; no leaked adapters or stale frames.                                                                        |
| Gain/mute during prepare; captions active                               | Latest control applies at commit; muted audio absent from output and captions; caption timing does not restart.                                                         |
| Stop during prepare/commit/restore; new session starts                  | Stop wins at its fence; all owned resources retire; late callbacks cannot install into the new session.                                                                 |
| Response timeout, WS reconnect, renderer reload                         | Status resolves the actual outcome; persisted/visible selection follows confirmed backend state.                                                                        |
| Repeated swaps and failure loops                                        | Worker/PID/device/queue counts return to baseline; no unbounded memory or source retention.                                                                             |

Hard invariants: no extra session.start/stop calls; unchanged output FFmpeg PID,
encoder identity, recording path/session ID, stream connection count and topology
during successful switches. Capture-only worker PIDs may change. Inspect the
loopback RTMP receiver to prove no reconnect; packets/decoded frames span the
switch in the same received stream.

Audio timing criteria:

- No sample cursor reset, duplicate interval, or missing output PCM interval.
  Validate monotonic packet DTS per stream and decoded presentation order;
  do not incorrectly reject legal video PTS reordering when B-frames are used.
- Overlap-capable mic swaps introduce at most the designed ≤10 ms ramp interval
  in synthetic known-signal tests. Device warm-up time is measured separately.
  Exclusive-device switches report their measured silence interval and use the
  bounded operation/restoration budgets; never pass them as a zero-gap switch.
- Use `DEFAULT_STREAM_AV_SYNC_GATES` from `scripts/lib/stream-av-sync.mjs`:
  target absolute median offset ≤60 ms, hard ceiling 150 ms, local/received-leg
  divergence ≤40 ms. Measure windows before and after every switch, not only
  the recording-wide median. Do not claim a pass if stimuli are unmeasurable.
- Include at least a ten-minute repeated-switch run with enough flash/click pairs
  for the existing drift test (≤20 ms per 30 minutes). Preserve artifact analyzer
  stop-tail, startup-resolution, color, and video cadence gates.

Add pure tests that show the analyzer rejects injected gaps, wrong identities,
timestamp regressions, muted leakage, reconnects, and premature success. Set
camera gap budgets from the existing 15-second startup contract and separately
reported bounded restoration; healthy synthetic switches must not consume that
budget. Timeout tests use injected clocks/readiness signals.

Required final commands (all exit 0 unless documented as a real external blocker):

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:scripts
pnpm --filter @videorc/desktop test
pnpm build
cargo fmt --check --all
cargo test -p videorc-backend
cargo clippy -p videorc-backend -- -D warnings
pnpm smoke:live-source-switch
pnpm smoke:live-source-switch:devices
pnpm smoke:captions-contract
pnpm smoke:recording-studio
pnpm smoke:recording-studio:devices
pnpm smoke:record-latency
pnpm smoke:record-latency:gate
pnpm probe:preview-lifecycle
pnpm baseline:stream:av-sync
pnpm baseline:stream:av-sync:endurance
```

The two source-switch scripts are new deliverables; other commands exist at the
inspected baseline. Run `pnpm smoke:recording-matrix` if input mapping/output
changes touch container/export, encoding profiles, colorimetry, or FPS handling.
Run `pnpm smoke:windows-live-audio-controls` on Windows. Add
`pnpm smoke:remote-control` for dispatch/remote-shortcut compatibility; add
`pnpm smoke:remote-lan` only if that surface is actually modified. No LAN source
switch feature is requested. Run `pnpm probe:preview-window` only if placement or
move/resize behavior is changed. Dependency changes require `pnpm audit:deps`.

## Scope and integration boundaries

Expected source changes, with adjacent tests allowed:

- Backend: `live_source_switch.rs` (new), `session_audio.rs` (new),
  `audio_capture_adapter.rs` (new), `audio.rs`, `warm_microphone.rs`,
  `recording.rs`, `capture_input.rs`, `protocol.rs`, `state.rs`, `main.rs`,
  `live_layout.rs`, `preview_camera.rs`, `preview_screen.rs`, `source_registry.rs`.
- Focused integration only: `compositor.rs`, `capture_recovery.rs`, `fifo.rs`,
  `captions.rs`, `windows_d3d11_session.rs`, `session_ops.rs` where necessary for
  source adoption, stop priority, bus timestamps, or current output capability.
  Do not rewrite those systems or weaken their regression contracts.
- Desktop: `src/shared/backend.ts`, `renderer/src/backendClient.ts`,
  `hooks/use-studio.tsx`, its integration tests, new
  `lib/live-source-selection.ts`/tests, `lib/capture.ts`,
  `components/tabs/sources-tab.tsx`, `components/studio/quick-settings.tsx`,
  `components/source-select.tsx`, microphone visual/mixer hooks/components and
  `lib/live-audio-processing.ts` only for confirmed bus state and capability.
- Test infrastructure: the new smoke/analyzer files above, existing recording-
  studio gate scripts/tests, caption/live-audio smoke adapters as needed,
  `package.json`, focused CI wiring, and `docs/acceptance/` summary docs. This
  plan and `plans/README.md` track execution. Generated media stays ignored.

Out of scope: system/desktop audio capture, multi-microphone mixing, audio device
calibration UI, per-scene audio, browser capture as program audio, provider APIs,
scene-editor redesign, output profile changes, releases, and adding remote/LAN
device controls. Additional native dependencies or a new platform capture stack
require a written amendment with measured reasons before expanding scope.

## S4 implementation amendment: AVFoundation capture clock metadata

Approved during execution on 2026-09-23. Inspection of bundled FFmpeg 8.1.1
`libavdevice/avfoundation.m` shows that audio packet PTS comes from
`CMSampleBufferGetOutputSampleTimingInfoArray`; the stock worker does not export
the capture session clock's relationship to the host clock. Arrival time at
stdout is not that relationship. The implementation may add a narrow maintained
FFmpeg patch, rather than infer capture time from downstream scheduling.

Additional scope is limited to `scripts/build-ffmpeg-macos.sh`, a maintained
patch under `scripts/patches/`, a focused capture-clock capability probe and its
pure tests under `scripts/`, associated package/packaging preflight wiring, and
generated bundle source/build metadata. No new native capture stack or runtime
dependency is introduced. The existing D3 release-acceptance dependency and
sensitive-path inventories in `scripts/lib/capture-decay-release-acceptance.mjs`
may add the new probe and patch so these changes invalidate prior acceptance;
no acceptance, signing, or promotion rule may be weakened.

Requirements:

- Convert each delivered audio buffer's presentation timestamp from the capture
  session clock to `CMClockGetHostTimeClock()` using `CMSyncConvertTime`. Export
  versioned metadata that can be matched to the exact packet/PCM interval,
  including original PTS, converted host time, sample count/rate, and freshness
  evidence. Invalid or unmappable clock values fail the adapter explicitly.
- Keep metadata associated with the retained buffer when AVFoundation replaces
  an unread buffer. Bounded parsers reject missing, mismatched, stale, malformed,
  or discontinuous metadata; neither stderr nor stdout receive time substitutes
  for capture time. Pair the backend monotonic clock with the platform host
  clock explicitly and record the mapping uncertainty.
- Apply the patch after a clean source extraction. Fingerprint the patch and
  protocol version in source/build manifests, retain the patch with the bundle's
  source information, and refuse reuse of a bundle without the required
  capability. A capability probe must check the actual binary.
- Preserve existing FFmpeg licensing, TLS, dynamic-library and packaging gates.
  Record the exact upstream archive and modifications needed to reproduce the
  binary; future public source distribution must include the patch.
- Rebuild the local bundle, run adapter/parser rejection tests and the capability
  probe, then verify signed-candidate fallback recording/stream artifacts and
  per-switch A/V timing. This amendment does not waive physical-device acceptance.

## S4 implementation amendment: Windows capture-clock worker

The pinned Windows output FFmpeg is a prebuilt binary. Its DirectShow verbose
log samples wall time after reading the graph clock and after acquiring the
logger lock. A constant logging delay cannot be bounded by stderr receive age
or the smallest observed offset. Do not use those logs as a proven capture clock.

Complete Windows source replacement with a separate, minimal
`ffmpeg-capture.exe` worker built from maintained FFmpeg source. Preserve the
existing pinned output `ffmpeg.exe`/`ffprobe.exe`; this worker only captures and
normalizes microphone PCM. This is the already-planned FFmpeg adapter, not a new
native audio stack. Until the worker is available and verified, preserve initial
Windows recording and report live microphone replacement explicitly unsupported.

### Additional bounded scope

- Maintained `scripts/patches/dshow-capture-clock.patch`, a Windows capture-worker
  source pin, build wrapper/recipe, and capability/manifest probes with tests.
- `scripts/preflight-windows-package.mjs`, package commands, and unsigned build
  preparation in `.github/workflows/windows.yml` and
  `.github/workflows/release-windows-alpha.yml` solely to build/probe this input.
- `apps/desktop/electron-builder.yml` resource filters, including the previously
  required macOS `source-patches/**/*` and the Windows worker/source/license data.
- Existing Windows staging/candidate/resource integrity helpers and their tests
  only where their explicit required-file inventories must include the worker.
  Preserve signature, publisher, hash, role, approval and promotion checks.
- Adapter resolution, clock parser, bounded process ownership and existing
  verification commands already in S4/S6 scope.

No release, artifact publication, signing-service invocation, deployment,
credential change, updater mutation, or replacement of the main Windows encoder
is authorized by this amendment.

### Capture metadata contract

1. Add an opt-in, versioned DirectShow option (for example
   `videorc_audio_clock`, capability text `Videorc DShow clock protocol 1`).
   Patch the actual audio receive callback. Obtain wall-clock readings immediately
   before and after `IReferenceClock::GetTime`; use the midpoint as the graph-clock
   mapping and the bracket width plus clock resolution as its explicit uncertainty.
   Logging occurs afterward and must not supply the timestamp. Record the real
   sample PTS and graph time in their declared units, both wall readings, packet
   byte/sample count and negotiated sample rate/format. Check HRESULTs, invalid
   sample timestamps, arithmetic, duration and format before emitting valid data.
2. Metadata must identify the same packet delivered to FFmpeg. Refuse fallback
   graph timestamps masquerading as sample timestamps, missing/malformed metadata,
   excessive sampling brackets, unsupported PCM formats, discontinuities and stale
   intervals. Retain `-copyts`; match final `ashowinfo` PTS/sample count with exact
   stdout byte intervals. Require initial sequence zero, sequential metadata,
   non-overlapping intervals, finite samples and complete PCM reads.
3. Map worker wall time to backend `Instant` using bounded paired samples and
   detect wall-clock steps. Include both worker and backend sampling uncertainty;
   a logger delay changes delivery freshness, not capture time. A noisy capture
   clock must produce a bounded, explicit error rather than restart the session.
4. Resolve the exact selected DirectShow device against actual DirectShow audio
   enumeration. Refuse ambiguous friendly names or use the unique enumerated
   DirectShow alternative name. MediaFoundation inventory uniqueness alone is
   insufficient to establish DirectShow identity.

### Build and distribution

- Verified upstream source: `https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz`,
  SHA-256 `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`.
  Keep this worker pin separate from `vendor/ffmpeg/windows-pin.json`.
- Use the documented MSYS2 UCRT64/MinGW-w64 build route. Install only the needed
  compiler/build tools in CI (make, pkgconf, diffutils/patch, GCC and NASM); record
  toolchain versions. A maintained wrapper must locate the configured MSYS2 root
  and provide an actionable error on local hosts without it. Do not auto-install
  machine-wide tooling from ordinary recording startup.
- Build a static LGPL-compatible capture executable with DirectShow, required
  PCM decoders, `aresample`, `aformat`, `ashowinfo`, PCM-float encoding, raw f32le
  output and pipe I/O. Include minimal lavfi tone/silence inputs if needed for
  maintained normalization verification. Disable GPL/nonfree, ffplay, network and
  unrelated third-party components. Inspect actual PE dependencies and reject
  dependence on MSYS2, compiler-runtime or unbundled DLLs.
- Stage `bin/ffmpeg-capture.exe`, separate capture source/build/license manifests,
  and the exact patch alongside the current Windows bundle. Main FFmpeg fetch
  runs before worker staging because it may recreate the bundle directory.
  Source URL/hash, configure flags, patch hash, protocol and executable hash must
  identify the worker. Cache reuse must validate these inputs and probe the actual
  binary. Build/cache failure must not substitute an unpatched capture binary.
- Package and verify the worker in unpacked app resources; extend existing
  explicit resource/staging inventories without weakening their protections.
  Preserve the existing treatment of FFmpeg licensing/signatures and include
  corresponding source/patch information in future release artifacts.

### Required gates

- Pure parser/framing tests for delayed logs, wide/negative clock brackets,
  wall jumps, missing first metadata, overlap/gaps, stale/partial/nonfinite PCM,
  ambiguous names and missing/wrong protocol/manifests.
- Build and actual capability/normalization/PE-dependency probes on Windows CI;
  packaged worker presence and matching manifest/patch checks. Reuse refusal
  tests must exercise old binaries and mismatched source/build fingerprints.
- Owned child startup/cancellation/kill/reap tests, affected Windows filters
  25 times with nonzero test counts, and the full Windows Rust suite three times
  from PowerShell 7 as already required. The clock worker remains an input
  producer; output process, bus epoch, tracks and stream connection stay stable.
- Existing Windows packaged recording/preview/audio controls gates and S6 source
  artifact tests still apply. Hosted CI compilation and synthetic normalization
  do not replace the required real-device per-switch A/V and endurance evidence.

Build references: [FFmpeg Windows platform instructions](https://ffmpeg.org/platform.html)
and [MSYS2 setup action](https://github.com/msys2/setup-msys2). This amendment
permits the build prerequisite needed to finish the original Windows scope;
physical-device acceptance remains explicit and unchanged.

## Done criteria, stop conditions, and maintenance

- [ ] Both UI entry points switch all supported sources in every session mode.
- [ ] Adding a mic after starting without one works; None and unplug do not close
      the session audio bus; mute and captions remain correct through switches.
- [ ] Successful/failed switches leave the recording and stream continuous;
      fallback/restoration state is honest and verified in encoded output.
- [ ] Session/revision fencing, duplicate requests, reconnects, layout races,
      Stop, worker cleanup, and dual-output adoption have deterministic tests.
- [ ] Required macOS and Windows device/artifact gates have evidence; absent
      hardware/permissions are recorded as blockers, not waived implicitly.
- [ ] Current scene animation, geometry, saved visual semantics, capture recovery,
      startup/stop latency, and preview transport contracts pass their gates.
- [ ] Only intended files changed; plan/index updated with phase evidence.

Stop and revise the affected phase if it needs to restart an encoder or reconnect
a stream to switch a source; cannot separate producer cleanup from bus cleanup;
cannot bound adapter shutdown/late native completion; cannot identify the source
actually reaching an output leg; or cannot establish the fallback/Windows timing
contract. Do not conceal these problems by enabling a picker or declaring a
successful config update. If a gate fails repeatedly, document the reproducer and
resolve it before enabling that capability.

Future source types must implement the same producer/readiness/lifetime contract.
Review source-loss counters, fallback paths, and caption timestamps whenever
changing the bus. Future per-device calibration or multiple-mic mixing should
build on this session timeline; neither should reopen the output transport.

Planning validation: read-only inspection of both checkouts, protocol/capture/UI
call paths, existing scripts/tests, CI, and overlapping plans. This was a focused
feature plan, not a whole-repository audit. No device session, application tests,
recording, stream, or release was run during planning.

## Execution evidence (2026-09-23)

- Isolated worktree: `/Users/orcdev/projects/videorc-wt-live-sources`, baseline
  `921903643ee43368058ffb93ec7d6328dcb224a0`; pre-edit relevant diff empty.
- Toolchain: Node 24 from `/opt/homebrew/opt/node@24/bin` and pnpm 11.0.9 from
  `/Users/orcdev/Library/pnpm/.tools/pnpm/11.0.9/bin`, both prepended to PATH.
  The default shell's Node 19 / pnpm 8 failed the repository engine gate;
  no engine requirement was weakened. Fresh frozen-lockfile install passed.
- Shadscan baseline/floor: 41, command `pnpm dlx @shadscan/cli@next --json`
  in `apps/desktop`. Evidence `/tmp/live-sources-shadscan-baseline.json`.
- S0 deterministic baseline: desktop provider/live-audio tests 128/128;
  `cargo test -p videorc-backend audio::tests` 31/31. Reviewer independent
  script baseline: 1442/1442 tests, 253 suites. Logs are under
  `/tmp/videorc-live-sources-evidence/`.
- Production path characterization: CoreAudio source owns its callback queue,
  gain/mute and FIFO writer; EOF closes that FIFO. AVFoundation fallback and
  DirectShow remain main-FFmpeg inputs. Existing camera restart retires the
  previous native source before opening its replacement. New source transaction
  capabilities are explicitly unsupported until those lifetimes are migrated.
- S1 implemented (commit `2d0f06eb`): session/revision admission, bounded duplicate
  cache with explicit New/Existing admission, stop/late-completion fencing,
  startup selection snapshot, renderer-only methods, reconnect snapshot,
  source-health observations, independent timeout reconciliation, and
  client/backend operation budgets. Initial five coordinator tests passed;
  latest coordinator tests 9/9 passed. Default optimized full Rust suite passed
  2210 tests plus one wire integration test (9 ignored). Latest refinements also
  passed 2212 tests plus one wire test using temporary test opt-level 0 and
  `RUST_MIN_STACK=16777216`; default test-stack size overflowed one existing
  large async preview test under opt-level 0, and changing only the stack size
  made the same test pass. No project build profile or test was weakened.
  BackendClient 27/27, TypeScript typecheck and lint passed.
- Physical-device and output acceptance remain outstanding. Device inventory
  or passing protocol tests do not constitute encoded artifact acceptance.

- S2 implemented: persistent paced 48 kHz stereo PCM bus with intentional None,
  source-loss silence, bounded capture timeline, output-side gain/mute and caption
  delivery, sample provenance, stale speech discard, and gradual device-clock
  correction. Producer identity replacement is the next phase; capabilities
  remain disabled. The downstream pipe/demux buffering bound remains S4 work.
- S2 verification: default-profile Rust suite 2224 tests plus one wire integration
  test passed (9 ignored); focused audio/bus suite 42/42; clippy with warnings
  denied and TypeScript typecheck passed. Reviewer Node suite 1442/1442 passed.
  `smoke:captions-contract`, `smoke:record-latency:gate`, and the full
  `smoke:recording-studio` passed. The studio bundle included caption/mute/gain/
  source-loss encoded artifacts, recording and RTMP scene artifacts, all-layout
  recording, real ScreenCaptureKit recording, and preview reliability gates.
  First latency run: cold Record 143 ms, warm Record p95 90 ms, Stop p95 99 ms,
  final MP4 p95 226 ms. Evidence logs: `s2-rust-all.log`,
  `s2-audio-tests-v3.log`, `s2-clippy-final.log`, `s2-typecheck.log`,
  `reviewer-s2-scripts.log`, `s2-captions-contract.log`, `s2-record-latency.log`,
  and `s2-recording-studio.log` in the evidence directory above. These are phase
  regression gates, not final live-switch/device acceptance.

- S3 implementation: bounded producer owners (including cold start and standby),
  exact CoreAudio selection, fresh-PCM preparation, chunk-boundary replacement,
  separate old/new 5 ms ramps, authoritative commit receipts, latest bus controls,
  None/retry/loss behavior, coherent generation health and cumulative finalization
  evidence. A process-wide two-producer limit retains quarantined late open/close
  owners; startup waits for current standby opening under the publication fence.
  New caption tasks require a real input; existing authorized caption tasks retain
  their bus timeline through None/loss. Removed unused legacy preroll-only tests;
  current bus tests cover epoch trimming, bounded silence and replacement.
- S3 deterministic evidence: raw bus/ownership tests 19/19; warm handoff tests 5/5;
  explicit new-caption refusal/existing-task retention test passed. The maintained
  `smoke:live-source-switch` now runs record-only, stream-only and combined modes.
  All three passed with decoded 440/880 Hz identities, zero RMS during None,
  duplicate-request receipt parity, unchanged encoder/session/output identity,
  one 48 kHz stereo audio track, monotonic DTS, and exactly one actual RTMP
  connection per streaming session. Reports are under
  `/tmp/videorc-live-sources-evidence/s3-encoded-v2/`; aggregate log
  `s3-encoded-smoke-v2.log`. Latest Node suite 1445/1445 and typecheck passed.
  These reports explicitly set `completePlanAcceptance:false`: visual switching,
  per-switch A/V timing, endurance, and physical-device acceptance remain pending.
- S3 restoration boundary: ordinary CoreAudio open failures preserve a healthy
  previous producer; an already-lost producer is reported unavailable. Structured
  exclusive-owner release/open/restoration is integrated with the S4 adapter
  contract, rather than guessing that an arbitrary native error means exclusive
  ownership. Physical two-microphone acceptance will use the final signed candidate;
  no native-device readiness claim is made from injected PCM.
- Final S3 backend regression gate: default optimized suite passed 2233 backend
  tests, 80 native-preview helper tests and one wire integration test (9 ignored),
  including Stop while Start waits on standby and atomic warm admission/disarm.
  Log: `s3-rust-final.log`. Reviewer independently reran final warm tests 6/6.
- S3 final loss/replacement artifact run passed all three modes after exercising
  actual producer disconnect, an unavailable-target failure with honest
  previous-source health, encoded silence during loss, and successful replacement.
  Evidence: `s3-encoded-loss-v2/{record,stream,combined}/live-source-switch-evidence.json`
  and `s3-encoded-loss-v2.log`. The first loss harness attempt correctly hit the
  Electron-main-only debug-method restriction; the harness now uses the existing
  authenticated main smoke command, without weakening backend authorization.
  Final clippy with warnings denied and TypeScript lint also passed.

### S4 checkpoint — timestamped AVFoundation and Windows worker build inputs

- AVFoundation fallback startup and live replacement now use a capture-only owned
  FFmpeg worker feeding the persistent session bus. The maintained macOS patch
  exports exact retained-buffer PTS→host clock metadata; the backend samples
  host→Instant with at most 1 ms bracketing uncertainty. PCM framing requires
  initial sequence zero, sequential non-overlapping intervals, 48 kHz float
  stereo, finite samples and fresh capture times. Partial reads are assembled;
  missing/truncated/stale/discontinuous metadata cannot satisfy readiness.
- The rebuilt macOS 8.1.1 bundle passes actual clock protocol1, existing feature,
  LGPL/linkage and reuse checks. Patch fingerprint:
  `df5b99402a422c543f485b741bba3581467705733079e8217b45843aadb729f1`.
  Packaging includes corresponding source patch and verifies its manifest hash.
- Session audio gets a dedicated Windows 8 KiB named pipe and a four-packet
  FFmpeg input queue; video pipe defaults remain independent. The macOS pipe
  still uses the operating system's capacity. These configured bounds do not
  substitute for downstream-pressure and final-artifact timing measurements.
- Stock DirectShow verbose-log timestamps cannot bound constant logger delay.
  Windows startup therefore retains its existing device input at this checkpoint;
  live microphone replacement remains unsupported until the separate patched
  worker is integrated. The approved amendment is implemented as build inputs:
  pinned FFmpeg8.1.2 source, opt-in exact-packet callback metadata, MSYS2 UCRT64
  static capture-only build, source/license/recipe/binary manifests, actual x64 PE
  import inspection and decoded 997 Hz normalization proof at 48 kHz. CI builds
  and packages this sibling worker without replacing the main output encoder.
  This is not yet a completed Windows adapter or physical acceptance claim.
- Required Windows ownership filters now repeat25 times (including real FIFO
  tests); the full Windows Rust suite remains three passes. Zero-test filters
  fail the gate. Actual Windows build/test evidence is pending CI.
- Fixed the existing standalone live-control probe's progress/acknowledgement
  pipe collision exposed by Windows CI. Progress is now stdout and complete
  filter replies stderr, with `-nostats`; the production2s poll,5s deadline,
  six replies and decoded two-output gain/mute/unmute gates are retained.
- Verification under `/tmp/videorc-live-sources-evidence`: adapter6/6 plus owned
  ignored child fixture (`s4-adapter-tests-v3.log`); default Rust2240 backend,
  80helper,1wire pass,10ignored (`s4-avf-rust-all-v2.log`); clippy-Dwarnings pass
  (`s4-avf-clippy-v2.log`); Windows build/probe/staging unit tests75/75 pass
  (`s4-windows-staging-tests-v3.log`); actual standalone live-control probe pass
  (`s4-live-audio-control-probe.log`,2003/2011/2008ms complete acknowledgements).
- Signed local candidate device probing is in progress. S4 remains IN PROGRESS:
  Windows adapter integration/build evidence, classified exclusive restoration,
  actual downstream-pressure measurements and physical artifact gates remain.
  S5/S6 and final full recording-studio gates are still required.
