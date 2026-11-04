# Plan 217: The stream never waits for the recording

> **Executor instructions**: one workstream, one PR, slices in order. Run
> every "Done when" check before moving on. S0 is **red first**: see it fail
> on the base before S1 starts. Gates run once at the end (owner rule).
> Anything under "STOP conditions" means stop and report, not improvise.
>
> **Drift check (run first)**: `git diff --stat <this plan's merge>..origin/main --
crates/videorc-backend/src/recording.rs crates/videorc-backend/src/source_audio_tap.rs
crates/videorc-backend/src/source_iso.rs crates/videorc-backend/src/session_audio.rs
crates/videorc-backend/src/encoder_bridge.rs`. Anchors below are symbol
> names; find them again if lines moved. A changed _behaviour_ is a STOP.

## Status

- **Status:** PLANNED 2026-11-04. Not started. Owner decisions D1 to D3 are
  open; each has a recommendation.
- **Source:** the owner's live stream on 2026-11-04 (0.19.0), "my entire
  stream started to lag, probably because I was recording 4K". The same
  stream's X chat failure was a separate bug, fixed in videorc-web#104.

## What happened (evidence)

Backend log `~/Library/Application Support/Videorc/logs/backend.log` and the
`health_events` table, session `8432879e-a4e3-4196-ae80-63a722fcb7b3`:

- The session recorded 3840x2160@30 at 30 Mbps and streamed 1920x1080@30 at
  6 Mbps to YouTube, Twitch and X (`roles=recording+stream`, overlay leg plan
  `aux=true`). One FFmpeg read three inputs: the session audio FIFO (`in#0`),
  the 4K recording video (`in#1`) and the 1080p stream video (`in#2`).
- At 15:44:58Z a local 0.19.1 release build started
  (`~/projects/videorc-rel191/target`, both architectures). Host load went
  3.3 → 6.0 → 10.5 → 18 → 24.7 on 10 cores within two minutes. Videorc's
  own CPU stayed at 10–12 % and the compositor kept 30 fps.
- 15:45:55–15:47:44Z: the recording queue sat at its 15–16 frame bound
  ("recording leg is producing 16 fps"). The stream output stalled
  2.2–2.8 s at a time, and the audio FIFO reader stopped draining five times
  (2.9 s, 15.3 s, 4.0 s, 9.1 s, 4.8 s), so up to 11.9 s of audio was silent
  on the stream _and_ in the file. The owner stopped and restarted the stream
  with the recording at 1080p (one shared encode).
- Control: at 16:06Z the same build's last phase drove the load to 29.7.
  The 1080p shared session dropped a few stream frames and nothing else: no
  audio stall and no stream stall.

## Why

FFmpeg 8.1's scheduler (`fftools/ffmpeg_sched.c`, `trailing_dts` and
`schedule_update_locked`) lets no output stream run more than
`SCHEDULE_TOLERANCE` (100 ms) ahead of the slowest stream across **all**
outputs of the process. It stops ("chokes") a demuxer whose outputs are all
that far ahead. So when the 4K recording input trails, FFmpeg stops reading
the audio FIFO and the stream's video FIFO too. A macOS FIFO holds at most
64 KB (about 170 ms of f32 stereo audio), so the audio bus stalls almost at
once. One process means the live stream runs at the speed of the heaviest
recording leg.

The 4K leg trails first under load because it carries 5× the bytes through
the same 64 KB pipes: every 30 Mbps keyframe needs many writer/reader
hand-offs. The FFmpeg reader runs at default QoS, and macOS does not let a
parent raise a child's QoS (see `host_pressure::promote_current_thread_for_live_media`).

The local trigger (agent builds during a stream) is now gated by
`waitWhileVideorcLive` in `scripts/lib/host-lock.mjs`. This plan fixes the
product: any streamer can have a busy Mac.

## Goal

In a session where the recording runs its own leg (split output, see
`separate_provider_roles_fit_bridge_envelope` and
`recording_compositor_stream_output_with_plan`), the stream's audio and
video never wait for the recording. Under host load the recording may hold
frames (as it already does); the stream keeps its cadence and its audio.

## Design

Split-output sessions run **two** FFmpeg processes:

- **Stream process** (the live path): the session audio bus FIFO plus the
  stream video FIFO, writing the fifo-wrapped FLV targets. It keeps every
  current stream behaviour: `RTMP_LEG_FIFO_RECOVERY_OPTIONS`, `-tag:v 7`,
  `StreamLegMonitor` attribution, per-leg health.
- **Recording process**: a new **mixed** `SourceAudioTap` (the same chunk the
  bus writes, see `source_audio_tap.rs`) plus the recording video FIFO,
  writing the MKV. The tap's bounded queue already drops and silence-fills
  when its reader stalls, so a slow recording muxer can never slow the bus.

Shared sessions (one profile) and Linux (tee, no aux leg) are unchanged.

## Slices

- **S0 (red first): a gate that shows the coupling.** Add a debug-only
  fault-injection env, for example `VIDEORC_SMOKE_RECORDING_FIFO_DELAY_MS`
  (compiled under `debug_assertions` only, like the existing smoke paths).
  It delays the recording bridge's FIFO writes. Add
  `pnpm smoke:stream-survives-slow-recording`: test pattern, 4K record +
  1080p stream to a local RTMP sink (reuse
  `scripts/probe-split-flv-capture.mjs` and the sink in
  `scripts/stream-av-sync-baseline.mjs`), with the delay at 800 ms for
  10 s mid-session. Assert on the received FLV: no audio gap over 200 ms
  and no video gap over 500 ms. Assert in the backend log: no
  `audio-output-stalled`.
  _Done when:_ it fails on main with an audio gap.
- **S1: the mixed tap.** A `SourceAudioTap` kind that carries the bus's
  mixed chunk. Unit test it: the bytes equal the bus FIFO bytes, and a
  stalled reader drops and silence-fills without slowing the bus (copy the
  existing ISO tap tests).
- **S2: two argument builders.** Split
  `bridge_compositor_split_output_ffmpeg_args_with_replay` into a
  recording-process builder (mixed tap + `in` recording video → MKV) and a
  stream-process builder (bus FIFO + stream video → FLV legs). Keep
  `ENCODED_RECORDING_INPUT_THREAD_QUEUE_PACKETS` and
  `SPLIT_STREAM_INPUT_THREAD_QUEUE_PACKETS` where they apply. Update the
  arg tests (`bridge_record_and_stream_tees_mkv_and_flv_targets` and its
  split siblings).
- **S3: lifecycle.** Spawn both processes behind the same start barrier, and
  register both PIDs in the owned-process registry. The output-startup proof
  needs both. Stop sends `q` to both: the stream first, then the recording,
  so the MKV finalizes last. `StreamLegMonitor` and the tee-failure parser
  read the stream process's stderr. If the stream process dies, emit a stream
  health event and keep recording (D2). If the recording process dies, fail
  the recording as today and keep the stream live.
- **S4: replay buffer.** Put the replay output (`ReplayOutput`) on the
  process D1 picks.
- **S5: Windows.** The Media Foundation path also runs an aux leg. Either
  make the same split (Windows CI compile + `smoke:windows-stream-performance`
  on the Windows box) or keep Windows on one process with a code comment
  naming this plan (D3).

## Gates (once, at the end)

- `pnpm smoke:stream-survives-slow-recording` (S0) green.
- `pnpm baseline:stream:split-output-4k-record`,
  `pnpm smoke:comment-highlight-stream`, `pnpm smoke:multistream`,
  `pnpm smoke:recording-studio`.
- `cargo fmt --check --all`, targeted `cargo test -p videorc-backend` for the
  touched modules, and both clippy runs from `AGENTS.md`.
- One real record-4K + stream-1080p session on the owner's Mac while
  `yes > /dev/null` runs on every core (load ≥ 2× cores) for two minutes.
  The stream must keep its audio. Note what the recording shows.

## Owner decisions

- **D1: where does the replay buffer live?** Recommended: the stream
  process. Clips are of what viewers saw, and the replay buffer then never
  depends on a struggling 4K leg.
- **D2: the stream process dies mid-session.** Recommended: keep recording,
  raise a stream health event, and let the existing fifo recovery reconnect
  legs as it does now.
- **D3: Windows in this PR?** Recommended: no, macOS first. Windows keeps one
  process until the Windows box can run its stream-performance smoke.

## STOP conditions

- S0 cannot be made red on main: the coupling is not what this plan says.
  Report the measurements.
- A/V sync between the stream and the recording drifts by more than one
  frame over a 10-minute `baseline:stream:av-sync:endurance` run after S3.
- Any change to shared (single-profile) sessions or to Linux arguments.

## Until this ships

On a busy Mac, record at the stream's resolution while live (one shared
encode). The 2026-11-04 control shows that shape survives a load the 4K
split did not.
