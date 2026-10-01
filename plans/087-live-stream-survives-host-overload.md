# Plan 087: a live stream survives a host stall (the OBS-launch incident)

**Status:** EXECUTED 2026-10-01 on `fix/087-live-stream-host-overload` (S1,
S2, S4, S5 and the in-process part of S3; device smokes and the load probe
are owed, see Verification).
**Priority:** P0 (a live stream to 4 platforms died on air, twice in five
minutes, and the app did not say so). **Size:** L, 6 slices. **Planned
against:** `9f1a46a3` (0.9.125, the build that was running). **Owner route:**
Diagnose → Implementation (fit 9; recording/streaming behaviour, failed on air).
**Model lane:** `fable-5`. Desktop-only: no videorc-web change.

## Symptom

Owner, live on YouTube + Twitch + Kick + X (session `7bb67af1`, started
13:08 local), opened OBS at 13:35:42 to compare it with Videorc on stream. The
stream died within seconds. A restarted session (`b98b909d`, 13:37:12) died
again 73 s in and was ended at 13:40:25 with `FFmpeg exited with exit status:
187`.

## What happened (evidence)

Times are local (CEST); the backend log is UTC (subtract 2 h).

| Time | Event | Source |
| --- | --- | --- |
| 13:08:01 | Session 1 starts, record+stream, 1080p30, 4 destinations | `sessions` row |
| 13:31, 13:36 | Two `rustc` builds start in other agent worktrees | `ps` elapsed times at 13:49 |
| 13:35:42 | OBS 32.1.2 starts: 3840x2160 canvas, ~10 ScreenCaptureKit sources, the same ZV-E10M2 camera, the same Shure MV7+ | OBS log `2026-10-01 13-35-42.txt` |
| 13:35:52 | Session audio FIFO reader (FFmpeg) stops draining for 16.5 s | `backend.log` 11:36:08.819 |
| 13:35:57 | Camera fresh 12 fps, screen fresh 10.7 fps; later 2.4 / 2.1 fps | `[capture-health]` lines |
| 13:35:59 | `recording-degraded`: recording leg at 5 fps of 30 | `health_events` |
| **13:36:00** | **Stream encoder writer exits (`role=stream state=fifo-exited`). The stream to all 4 platforms is dead.** | `session_logs` |
| 13:36:02 | Stream VideoToolbox session destroyed (46,262 frames in) | unified log, `VTEncoderXPCService` |
| 13:36:18 | OBS quits | OBS log |
| 13:36:30 | `replayd` crashes (SIGSEGV in an AudioQueue input callback). Videorc's ScreenCaptureKit video, audio and microphone queues all fail with `-16665` | `replayd-2026-10-01-133644.ips`, unified log |
| 13:36:54 | Owner presses stop. **Only now** is `stream-output-failed` written: "Encoder FIFO write exceeded the complete-frame delivery budget" | `health_events` |
| 13:37:12 | Session 2 starts (start takes 6.4 s) | `recording-start-timeline` |
| 13:37:20 | `recording-output-pressure` and `stream-output-pressure` immediately | `health_events` |
| 13:38:31 | Stream encoder destroyed again after 540 frames in 73 s (7.4 fps) | unified log |
| 13:40:25 | Owner ends session 2. `stream-output-failed`: "exceeded its bounded latency contract (depth 1/8, oldest 2090/150ms)". Mic: 3,903,503 of ~8.2 M frames dropped | `health_events` |

The Videorc process itself never crashed (no `videorc_backend` crash report
today; `backend-crashes.json` untouched since 09-28).

### Host state

Measured at 13:49, nine minutes after the incident, with Videorc live again:

- Load average **64.7 / 71.9 / 78.9** on a 10-core M4. The 15-minute figure
  covers 13:34–13:49, so it includes the incident.
- Swap **17.6 GB used of 19.5 GB**; the kernel logged ~12–16 GB in the
  compressor throughout 13:35–13:37.
- 18 `claude` processes, 9 `codex`, 3–4 `rustc`, ~10 vitest workers.
- Every one of them, and Videorc's FFmpeg, at the same scheduler priority
  (`PRI 31, NI 0`).
- Thermal level rose to 1 at 13:36:36 and 2 at 13:38:09.

The machine was already struggling before OBS: session 1 logged 1,071 stream
queue pressure recoveries and averaged 18.7 fps screen capture over its 29
minutes. OBS was the last straw, not the only cause.

## Root causes

Ordered by how much each contributed to "the stream died and stayed dead".

### 1. A 2-second stall permanently kills the stream leg (proven)

`write_all_until` (`encoder_bridge.rs:6097`) fails the stream writer when one
FIFO write exceeds `FIFO_FRAME_WRITE_HARD_TIMEOUT = 2 s`
(`encoder_bridge.rs:104`). `encoder_bridge_over_budget_escalation`
(`encoder_bridge.rs:1203`) fails it when the queue stays over budget for
`STREAM_OUTPUT_SUSTAINED_FAIL_WINDOW = 2 s` (`:97`) or the oldest frame passes
150 ms at full depth. The error text says so itself: "the stream stopped
instead of corrupting its reference chain".

Nothing restarts the leg. No restart or respawn path for the stream bridge
exists in `recording.rs` or `encoder_bridge.rs`. One 2-second host hiccup ends
the broadcast for the rest of the session.

Session 1 died by the first rule, session 2 by the second.

### 2. The app does not say the stream died (proven)

`stream-output-failed` is emitted only in the session-end path
(`recording.rs:9021`), from `monitored_recording.stream_bridge_terminal_failure`.
In session 1 that was 54 s after the leg died; in session 2, 115 s. In between,
the only trace is an `info`-level `encoder-bridge-writer-lifecycle` row, and
`backend.log` has no line at all. The owner kept presenting to a dead stream.

### 3. Videorc has no priority over background work (proven absent)

`git grep` for `qos_class`, `pthread_set_qos`, `setpriority`, `taskpolicy`,
`posix_spawnattr` over `crates/` and `apps/desktop/src/main` on `origin/main`
returns nothing. The capture, compositor, encoder-writer and audio threads and
the FFmpeg child all run at default priority, so the scheduler gives a Rust
compile the same share as a live broadcast.

### 4. A ScreenCaptureKit stop is silent and never recovered (code proven)

The code path below is proven by reading it. That the delegate fired during
the incident is inferred, not logged: the unified log shows the three remote
queue errors, and the session's frame accounting shows the screen held for
23 s before stop.

`stream:didStopWithError:` in `preview_screen.rs:4999` only stores a string in
`last_error`. No log line, no health event, no restart. `replayd` relaunched
within a second (new pid 94951), so a restart would have worked. The screen
stayed frozen until the owner stopped the session. `capture_health.rs` logged
nothing either; session 1 used the camera-only layout, so the screen may not
have been a monitored compositor source at the time.

The `replayd` crash itself is in Apple's code (a segfault in `objc_retain`
inside its AudioQueue input callback, 12 s after OBS tore down its streams). Videorc cannot prevent it; it
must survive it.

### 5. Audio timeline loses the mic when output runs slow (observed, not yet diagnosed)

Session 2 dropped 48% of microphone frames as `ahead-of-cap` and re-anchored
the mic timeline nine times. This looks like a consequence of the output
running at 14 fps rather than an independent bug, but that is not proven. It
is covered by the S0 harness below, not designed here.

## Not the cause

- **Camera format change.** OBS asked for 3840x2160 but UVCAssistant logged
  `Unchanged active format index 0 Total 1`.
- **Network / destinations.** All four RTMP legs were healthy until the
  writer exited; the `stream-output-pressure` copy ("a destination is accepting
  data slower") was wrong here. The slow reader was local FFmpeg.
- **A Videorc crash.** None occurred.

## Design decisions

1. **The stream leg waits instead of dying.** Reading the writer showed the
   kill was never needed to protect the reference chain: a skipped tick never
   reaches the encoder, and every encoded access unit is kept and written in
   order. So on a stall the stream role keeps skipping ticks (the existing
   latest-wins coalescing) and resumes on the same RTMP connections. Viewers
   see a freeze. No forced keyframe is needed, because nothing encoded is
   dropped.
2. **Only a wedged output fails.** No encoder completion and no FIFO write for
   30 s (`OUTPUT_WEDGED_TIMEOUT`). The VideoToolbox recording role waits the
   same way (see S2).
3. **Truth is immediate.** A dead, frozen or resumed stream raises a health
   event and a toast when it happens, not at stop.
4. **Live threads outrank background work; FFmpeg cannot.** See S3.
5. **No in-session stream restart (spike result).** The stream outputs live in
   the same FFmpeg process as the recording. When the stream MPEG-TS input
   ends, that process's stream legs are finished; a restart means a second
   FFmpeg with its own audio feed from the session audio bus. With decision 1
   the only remaining terminal cases are a 30 s wedge or a dead FFmpeg, and a
   dead FFmpeg ends the recording too. The second-process restart is therefore
   not built; it is listed under follow-ups.

## What was built

### S0: reproduce it

The repo already had the probe: `pnpm smoke:multistream-endurance` freezes the
session's FFmpeg with `SIGSTOP`, 500 ms in session A and 6 s in session B. It
had gone stale (it looked for the capture MKV, and since instant stop the
artifact is the MP4), so it is fixed here and is the reproduction:

- On the first fix (stream role only) session B showed the stream resuming
  after a 5.7 s stall, and the recording role dying at its own 2 s limit with
  the session marked failed. That drove the recording change in S2.
- With the final change both resume and the session completes.

Unit level: `fifo_writer_outlasts_a_reader_stall_longer_than_the_old_two_second_limit`
runs the real FIFO writer loop against a reader that accepts nothing for
2.4 s.

Not built: a load probe (CPU and memory pressure, ScreenCaptureKit churn).
`SIGSTOP` reproduces the stall, not the contention, so the S3 gain is
unmeasured.

### S1: say it when it happens

- `publish_stream_output_failure_if_active` (`recording.rs`) emits
  `stream-output-failed` and an error log line the moment the stream writer
  reports a terminal error. The stop path keeps a fallback and never repeats
  it (`announce_stream_output_failure_once`).
- `stream-output-stalled` / `stream-output-resumed` while the stream is
  frozen and when it moves again (`stream_output_stall_watch_update`).
- Toasts for all of them (`session-runtime-recovery.ts`); each pair shares a
  key so good news replaces bad news.
- `stream-output-pressure` no longer blames a destination when the computer
  is the slow side.

Not built: per-destination "Stream stopped" in the Stream Manager. With
dual-orientation simulcast the stream bridge feeds only some destinations, and
marking all of them from here would be wrong for the others.

### S2: stream and recording wait out a stall

- `encoder_bridge_over_budget_escalation` fails the stream only after
  `OUTPUT_WEDGED_TIMEOUT` (30 s) without progress. A full queue and time over
  budget both degrade.
- `VIDEOTOOLBOX_FIFO_WRITE_STALL_TOLERANCE` is the same 30 s for both roles.
- `encoder_bridge_recording_no_progress_timeout` returns the same 30 s for
  VideoToolbox outputs, so a recording pauses before encode through the stall
  and resumes with a truthful gap.

This changes the macOS recording contract, which the plan first meant to
leave alone. The smoke showed why it cannot stay: with only the stream
waiting, a freeze between 2 s and 30 s kept the stream and condemned the
recording. Media Foundation and the raw fallback keep their existing limits.

Both incident failures map to these changes: session 1 died on the 2 s FIFO
write timeout, session 2 on the 2 s sustained-budget window.

### S3: priority for the live pipeline (macOS)

- `host_pressure::promote_current_thread_for_live_media` raises the encoder
  bridge writer thread and both FIFO writer threads to
  `QOS_CLASS_USER_INTERACTIVE`. A unit test reads the class back.
- **FFmpeg cannot be raised.** Tested on this Mac: `posix_spawn` accepts only
  utility and background classes, and `pthread_set_qos_class_self_np` in a
  forked child returns `EPERM`. A parent can lower a child, never raise it.
- The gain is **not measured**: that needs the load probe above. The change
  is small and isolated so it can be reverted if the probe shows nothing.

### S4: recover from a ScreenCaptureKit stop

- `stream:didStopWithError:` now logs and hands the stop to the metrics poll
  (`handle_screen_stream_stop`) instead of only storing a string.
- The poll restarts the same source through the existing forced-restart path,
  at most 3 times per minute, and reports `screen-capture-stopped` /
  `screen-capture-restored`.
- A user stop from the menu bar (`SCStreamErrorUserStopped`, -3817) is never
  restarted.
- Found on the way: a Failed screen source could never be restarted by the
  recovery coordinator, because its restart snapshot requires a Live source.
- System audio (`system_audio_capture.rs`) already classifies a stream stop
  and reports it through the session audio loss path; unchanged.

### S5: tell the streamer the computer is overloaded

- `host_pressure.rs` samples the load average, core count and swap in use.
- `host-overloaded` (Warn, once per session) when the load holds at 2x the
  core count, with a toast.
- The `[capture-health]` slow-delivery line now ends with
  `host_load=71.9/10 swap_used_mb=17579`.

Not built: thermal state, and naming the top CPU consumers.

## Verification

Run on the owner's Mac:

- Targeted `cargo test` for the touched modules (214 tests),
  `cargo clippy -p videorc-backend -- -D warnings`, `cargo fmt --check --all`.
- `pnpm typecheck`, eslint and prettier on the changed files, the
  `session-runtime-recovery` vitest file.
- `pnpm smoke:multistream-endurance` (dev app, three local RTMP sinks).

**Owed before release** (recording-studio change, `AGENTS.md`): the broad
device smokes were not run; most of this work happened beside the owner's
live session on an overloaded Mac. Run
`pnpm smoke:recording-studio`, `pnpm smoke:record-latency:gate`,
`pnpm smoke:recording-matrix` and `pnpm probe:preview-lifecycle` on an idle
Mac, then owner acceptance: live to a private destination, open OBS with the
"Long" scene collection, the stream continues.

## Out of scope / follow-ups

- The `replayd` crash is Apple's; file a Feedback with
  `replayd-2026-10-01-133644.ips`.
- The mic `ahead-of-cap` loss: re-measure after S2 and S3; open its own plan
  if it persists at healthy output cadence.
- A load probe (CPU and memory pressure, ScreenCaptureKit churn) that
  measures the S3 gain; the endurance smoke covers only the stall.
- A second FFmpeg process for the stream leg, so a wedged stream can restart
  inside a session (design decision 5).
- Per-destination "Stream stopped" in the Stream Manager.
- The Windows stream path shares the new escalation rule but keeps its own
  2 s Media Foundation FIFO timeout; Windows and Linux thread priority are
  not done (S3 is macOS-only).
- Operational, no code: background agent builds on the streaming Mac can run
  under `taskpolicy -b` until S3 ships.

## Evidence locations

- `~/Library/Application Support/Videorc/logs/backend.log` lines 6384–8837.
- `videorc.sqlite3` tables `session_logs` and `health_events`, sessions
  `7bb67af1-…` and `b98b909d-…`.
- `~/Library/Logs/DiagnosticReports/replayd-2026-10-01-133644.ips`.
- `~/Library/Application Support/obs-studio/logs/2026-10-01 13-35-42.txt`.
- Unified log 13:35:30–13:41:00 (`/usr/bin/log show`; it ages out, the key
  lines are quoted above).
