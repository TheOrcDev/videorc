# Live Video Freeze Incident Plan

Status: investigation complete, fix plan ready.

Incident: during a live session, audio continued but video appeared frozen. The
closest maintained repro is the split-output 4K local recording plus 1080p RTMP
stream gate:

```sh
pnpm baseline:stream:split-output-4k-record
```

## Evidence

Two runs on 2026-07-02 reproduced the same shape:

- Local 4K recording artifact had only about 500 decoded frames across about 60s
  (`~8.4fps` observed, expected about `1800` at 30fps).
- The file showed many freeze segments around `797-799ms`.
- Audio continued and FFmpeg advanced at about realtime speed.
- The fixed diagnostic sampler proved the split:
  - 4K recording encoder: `258` VideoToolbox output frames.
  - 1080p stream encoder: `1742-1750` VideoToolbox output frames.
  - FIFO write/enqueue p95 on the hot path: about `660-760ms`.
- Adding FFmpeg `-thread_queue_size` to the encoded inputs did not change the
  failure, so this is not just a missing demux input queue.

Latest failed evidence:

```text
/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-stream-av-sync-1782992924188/record-stream/videorc-session-20260702-114851.evidence.json
/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-stream-av-sync-1782992924188/record-stream/videorc-session-20260702-114851.baseline.md
/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-stream-av-sync-1782992924188/stream-av-sync-evidence.json
```

## Diagnosis

The split-output path currently runs two VideoToolbox encoders but one FFmpeg
mux process:

```text
4K compositor target -> 4K VideoToolbox encoder -> recording FIFO -> FFmpeg input #1 -> local MKV/MP4
1080p compositor target -> 1080p VideoToolbox encoder -> stream FIFO -> FFmpeg input #2 -> RTMP FLV
audio FIFO -> FFmpeg input #0 -> both outputs
```

In the reproduced failure, FFmpeg keeps draining the 1080p stream input close to
realtime while the 4K recording input FIFO backs up. The recording encoder thread
then blocks in the FIFO handoff, stops submitting 4K frames, and the finished local
video stretches a few hundred frames over a full minute. This is why the incident
looks like "audio still live, video frozen."

The durable fix is to remove the shared-muxer bottleneck from split output. Each
encoded video leg must have an independently drained mux/output path, with audio
duplicated explicitly, so a slow 4K recording writer cannot starve a livestream
or vice versa.

## Implementation Slices

### LVF1 - Preserve incident diagnostics

- Keep `record+stream` samples in baseline summaries, not only `record`.
- Persist per-role timing fields in the evidence manifest:
  - recording/stream input FPS,
  - recording/stream writer loop and active p95,
  - recording/stream FIFO enqueue p95/max.
- Gate: `node --test scripts/lib/native-preview-diagnostics.test.mjs`.

### LVF2 - Split FFmpeg muxers for split-output sessions

- Replace `bridge_compositor_split_output_ffmpeg_args` single-process fan-in with
  separate recording and streaming mux workers for the split-output shape.
- Recording worker:
  - reads the 4K encoded FIFO,
  - reads its own audio FIFO,
  - writes the local MKV/MP4 source artifact.
- Stream worker:
  - reads the 1080p encoded FIFO,
  - reads its own audio FIFO,
  - writes one or more RTMP FLV targets.
- Keep same-profile record+stream on the existing shared path until it needs a
  companion output. Only split when separate output encoders are active.
- Gate: unit tests for args/process shape and stream target runtime attribution.

### LVF3 - Duplicate native audio safely

- Teach native audio capture to fan out to two session-owned FIFOs when split muxers
  are active.
- Keep a single shared `video_epoch` so both audio FIFOs trim the same pre-roll.
- Surface per-leg audio FIFO failures as explicit health events.
- Gate: Rust unit tests for fan-out lifecycle, cancellation, and pre-roll trimming.

### LVF4 - Process lifecycle and stop semantics

- Extend `ActiveRecording` to own multiple FFmpeg children for split output.
- Stop order:
  1. stop both encoder bridge sessions,
  2. close audio fan-out,
  3. wait for recording muxer and stream muxer,
  4. remux/repair only after the recording muxer finishes.
  Since the instant-record work (2026-09) the terminal `recording.status`
  is published as soon as the MKV muxer has exited and the row is committed;
  the MKV→MP4 remux, caption artifacts, final probe and poster run in the
  background finalization job (`recording.finalization` events,
  `sessions.finalization_state`). Quit and updater gates wait for that job.
- Stream target status must be driven by the stream muxer only; local recording
  failure must not mark RTMP targets failed.
- Gate: focused Rust tests plus a synthetic split-output smoke.

### LVF5 - Freeze-risk UI and early failure

- Keep the incident risk classifier active during capture:
  - capture/render/input FPS below 80% target,
  - writer loop/active/enqueue p95 over 100ms,
  - per-role split-output metrics over budget.
- Show a Degraded/At Risk health event while live instead of waiting for the final
  file analyzer.
- Gate: existing diagnostics risk tests plus desktop typecheck.

### LVF6 - Acceptance gates

Required before merging:

```sh
pnpm test:scripts
pnpm --filter @videorc/desktop test
pnpm typecheck
pnpm lint
pnpm format:check
cargo fmt --check --all
cargo test -p videorc-backend
cargo clippy -p videorc-backend -- -D warnings
pnpm baseline:stream:split-output-4k-record
pnpm smoke:recording-studio
```

If local macOS permissions are available, also run:

```sh
pnpm smoke:recording-studio:devices
```

## Temporary Operator Mitigation

> **2026-07-07 (plan 023):** the wallclock/Annex-B stopgap this mitigation
> guarded is FIXED — record+stream now runs MpegTs with real encoder PTS,
> minimal FIFO probing, and fifo-muxer-isolated RTMP legs (single ffmpeg;
> LVF2's split workers were not needed). Keep this mitigation only until the
> owner's real Twitch + 4K-recording by-eye passes on the next release, then
> delete this section.

Until LVF2-LVF4 land, avoid 4K local recording while livestreaming. Use one of:

- stream-only,
- 1080p recording plus streaming,
- 4K local recording without RTMP streaming.

These avoid the currently reproduced split-output 4K recording FIFO bottleneck.
