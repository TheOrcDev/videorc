# Plan 065: Windows loses the microphone at session start, and Iris Xe never gets its hardware encoder

> Executor: this is a diagnosis handoff plus an implementation plan. Read
> `AGENTS.md` first. Work in a dedicated worktree off current main (`7c461763`
> or later); paths below are origin/main paths. Every change is Windows-only
> backend code plus a small renderer surface. Local proof is
> `pnpm check:windows` (cargo xwin) and the Windows CI jobs; the only real
> acceptance is on the reporting tester's Intel Iris Xe laptop, through the
> probe matrix tool in B0 and one live Twitch session.

## Status and decisions

- Execution 2026-09-26, first PR (`fix/065-windows-mic-and-mf-probe`):
  A0-A4, B1 and B2 done. A2 notes: no Windows process-tree terminate was
  added (the probe children spawn no subprocesses; `child.kill()` plus the
  new 2 s bounded reap covers them), and `yield_to_capture` needed no change
  (the check's `running` flag clears only after `stop_recording` has
  drained, bounded at 8 s). B2 ships two topologies: `auto` (D3D11 upload on
  a video-capable, multithread-protected device) and `system-memory` (no
  device manager). No separate I420 rung: the MFT setup already tries I420
  before NV12 at `SetInputType`, and the bundle's `input=NV12` shows Quick
  Sync refused I420 there. The rejection cache keys on adapter driver
  identity plus profile. B4: each rung's `start_error` is already in the
  backend log (support bundle); showing it in Settings needs a contract
  change and moves to the second PR.
- Second PR, NOT started: B0 (probe matrix tool), then B3 (stream
  step-down) and the B4 renderer surface. B3 is larger than written below:
  per-target stream profiles come from named presets
  (`stream_target_output_video`) validated per provider, so a step-down
  needs a per-target override threaded through
  `resolve_provider_stream_output_plan_with_separate_roles`, the split-role
  plan and the simulcast exclusion. Start it only if the tester's run on a
  build with B1/B2 still shows `software-open-h264`.
- Acceptance without B0: when both topologies fail, the combined probe
  reason keeps the first topology's full text and only the stage and HRESULT
  of the later one, so it fits the 480-byte fallback reason the session log
  and support bundle carry. The tester's next bundle names which topology
  passed or how each one failed, which answers B1 versus B2.
- Status: PLANNED 2026-09-26. Diagnosed from the tester's support bundle
  `videorc-support-bundle-20260926-135101Z.json` (Windows 0.9.112 packaged,
  Intel Iris Xe laptop, Windows 11 26200, Cirrus Logic digital mic plus an
  AudioRelay virtual mic, Twitch record+stream) against main `7c461763`.
- Priority P0 for A (every Windows stream since #389 can silently lose its
  microphone); P1 for B (Iris Xe streams run at 14 fps on the CPU). Effort M
  for A, L for B. Risk HIGH: session start and encoder selection, no local
  Windows hardware.
- Outcome wanted: a Windows session never starts with silence when a
  microphone was selected and is present. A rejected hardware encoder never
  silently costs the user half their frame rate: the app either finds a
  configuration the GPU accepts, steps the canvas down and says so, or names
  the exact failure so a support bundle answers the question.
- Owner route: Diagnose (done) then Implementation; model lane `fable-5`
  (fit 9: two subsystems, Windows media APIs, no local repro). A4 and the
  README slice can go to `gpt-5.5`.
- Decisions taken here: keep the capture worker as the preferred microphone
  path (it is what makes live microphone replacement and the timestamped bus
  work), but never let it turn a present microphone into silence. Keep the
  bitrate ladder, but put the input topology and the canvas on the ladder
  too, for streaming sessions as well as record-only.

## Findings

### A. The microphone is dropped when the session starts

Both of the tester's sessions carry the same health event:

| Session (UTC) | `microphone-capture-worker-unavailable` message | mic-warm phase |
| --- | --- | ---: |
| 2026-09-25 23:50 | Microphone opening exceeded 5s; its owner is still responsible for cleanup. | 6,438 ms |
| 2026-09-26 13:49 | Owned child exceeded its 2000ms deadline. | 3,005 ms |

Discovery had listed both microphones as `available`, so `devices.list` is
not the problem. The user's words, "before I started my livestream I had a
mic then after I started the livestream my mic was removed", describe this
exactly.

How the path works since PR #389 (`13139793`, after the 0.9.98 pilot):

- `crates/videorc-backend/src/recording.rs:2966-2979`: a Windows dshow
  microphone goes through `ffmpeg-capture.exe` whenever that file exists
  next to `ffmpeg.exe`. It always exists in a packaged build.
- `recording.rs:2980-3013`: `session_audio::prepare_initial_adapter` runs.
  On any error the code sets `capture.microphone = None`, logs a warning and
  emits the health event. `recording.rs:3023-3033` then substitutes a silent
  PCM FIFO. The session starts and streams silence.
- `crates/videorc-backend/src/audio_capture_adapter.rs:602-615` (`open`) and
  `resolve_target` (`412-492`) spawn two probe children before capture:
  `-h demuxer=dshow` with a 1 s limit (`466-469`) and
  `-list_devices true -f dshow -i dummy` with a 2 s limit (`476-487`). The
  "Owned child exceeded its 2000ms deadline" text is the second one, from
  `process_job.rs:78-84`.
- `crates/videorc-backend/src/session_audio.rs:624-630`: the whole `open`
  call, probes included, must finish in 5 s ("Microphone opening exceeded
  5s"). After a probe timeout, `process_job.rs:72-73` kills the child and
  waits without a bound, and `terminate_bounded_process_tree` is a no-op on
  Windows (`149-150`), so a slow DirectShow teardown eats the rest of the 5 s.
- The probes run on every session start and every live replacement; nothing
  is cached. `preview_camera.rs:885-935` runs its own `-list_devices` with the
  main FFmpeg at the same time, so two DirectShow enumerations can compete.
- The old direct path is still wired: `capture_input.rs:270-283` appends
  `-f dshow ... -i audio=<name>` for `MicrophoneInput::WindowsDshow`, but it
  is only reached when the worker file is missing. When the worker exists and
  fails, nothing falls back to it.
- Nothing in the renderer knows the code. `showSessionHealthEvent`
  (`apps/desktop/src/renderer/src/lib/session-runtime-recovery.ts:280-313`)
  toasts only the startup codes, `recording-quality-not-100` and `mic-silent`;
  the Diagnostics tab lists only events with a `permissionPane`. The drop
  reaches the log and the session record only.

Why the probes are slow on this laptop is visible in the same bundle: the
13:49 session started 250 ms after the user cancelled a running performance
check whose benchmark session was still draining (`drain_after_stop_ms:
4250`), and every start on this machine re-runs the Media Foundation probe
ladder from B (the 23:50 session spent 11.9 s in compositor-arm). The
DirectShow enumeration itself enumerates every audio and video device,
including the AudioRelay virtual device, which is slow on its own.

### B. Iris Xe rejects the hardware encoder, and streams never step down

Every session start on this laptop logs:

```
Media Foundation recording output probe rejected 1920x1080@30 6000kbps:
Media Foundation probe stage=process-output HRESULT=0x8000FFFF (E_UNEXPECTED)
encoder="Intel® Quick Sync Video H.264 Encoder MFT" input=NV12 profile=1920x1080@30 5000kbps
```

- `windows_media_foundation_encoder.rs:3096-3151` (`probe_hardware_encoder`)
  walks the bitrate ladder 6000, 5500, 5000 (`probe_fallback_bitrates`,
  `3153`). The inner text says 5000 kbps because the last rung failed too. So
  every bitrate was rejected at `process-output`; bitrate is not the cause.
  This is the same shape as the UHD 600 tester on 2026-08-26 (bundle
  `20260826-190155Z`) and the 1440p case fixed for record-only in #364.
- The probe does not feed system memory. Because the Quick Sync MFT is
  D3D11-aware, `D3D11CpuUploadInput::new` (`1353-1421`) creates a separate
  D3D11 device on the MFT's adapter with `D3D11_CREATE_DEVICE_BGRA_SUPPORT`
  only: no `D3D11_CREATE_DEVICE_VIDEO_SUPPORT`, and no
  `ID3D11Multithread::SetMultithreadProtected(true)`. The capture device in
  `windows_d3d11_device.rs:1797` and `1842` sets both. The probe thread then
  calls `UpdateSubresource` on that unprotected device while the asynchronous
  MFT's own thread reads the same NV12 textures. That is the strongest
  candidate for E_UNEXPECTED at process-output on Intel, and it is the one
  difference between the probe's device and the session's capture device.
- `recording.rs:13276-13285` (`resolve_windows_recordable_video`) returns
  `None` when `stream_enabled`, so the #364 canvas step-down never runs for a
  record+stream session. Even for record-only, when 720p is rejected too, the
  software cap keeps 1080p on a machine with more than 4 logical cores
  (`13223`).
- The result on this laptop: `software-open-h264` at 1080p30, the CPU
  compositor at 14.4 fps, 327 of ~1,450 intervals skipped in 48 s, and the
  D3D11 media path unavailable (`windows-d3d11-media-foundation-not-selected`,
  `windows_d3d11_session.rs:256-261`).
- Probe failures are never cached (`recording.rs:13528-13545` stores only
  successes), so each start instantiates the MFT three times per role; a
  record+stream session probes two roles. That is where the 6.5 s and 11.9 s
  compositor-arm phases come from, and why the performance check's rungs
  reported `did-not-start`: each rung is a full record-only session with a
  15 s start budget (`performance_check.rs:490-505`) that pays the same probe
  bill.
- `MediaFoundationProbe` carries `effective_bitrate_kbps` only. There is no
  notion of "which input topology passed", so even a probe that succeeded on
  system memory could not tell the session encoder to do the same.

## Design decisions

- **A present microphone is never replaced by silence.** The capture worker
  stays first because it powers live replacement and the timestamped bus. If
  it cannot start, the session uses the direct DirectShow input that shipped
  through 0.9.98 (`capture_input.rs` `WindowsDshow` arm), marks live
  microphone replacement unavailable with the reason (the
  `sources.microphone_unavailable` hook at `recording.rs:4725` already
  exists), and says so in the UI. Silence remains only for "no microphone
  selected" and "the device is gone", each with its own code.
- **Pay for DirectShow enumeration once, not per start.** The worker's
  protocol check depends only on the binary; the inventory depends on the
  device set. Cache both in `audio_capture_adapter` (process-wide, keyed by
  worker path and by the MediaFoundation device-id set), warm them from
  `devices.list`, and invalidate on a failed resolve. `resolve_target` then
  costs nothing on the start path in the common case.
- **Budgets that a busy laptop can meet, with bounded cleanup.** Probe
  limits become 4 s (help) and 8 s (inventory); the opening budget becomes
  15 s; the post-timeout kill and wait get their own 2 s bound with a real
  Windows process-tree terminate. Session start already waits for the mic,
  so a slow start is visible in the timeline; a silent stream is not.
- **Probe with the device the session will use.** The CPU-upload device gets
  `D3D11_CREATE_DEVICE_VIDEO_SUPPORT` and multithread protection, exactly like
  the capture device. This is the cheapest change and the most likely fix.
- **Put the topology and the canvas on the ladder, for every session kind.**
  Order per rung: D3D11 CPU upload, then system-memory NV12 (no device
  manager), then I420; then the bitrate rungs; then the next smaller canvas.
  `MediaFoundationProbe` records the accepted `input_topology`, and the
  session encoder must use it. Streaming sessions step the canvas down like
  record-only ones do, on both legs, and emit the existing
  `recording-output-stepped-down` event with streaming copy.
- **Remember rejections.** Cache probe failures per (adapter driver
  identity, encoder identity, profile, topology) with a 10 min TTL so a start
  costs one instantiation per rung at most, and the performance check fits its
  15 s budget.
- **Explicit diagnostics.** A probe matrix command runs every combination on
  the tester's machine and prints a table; its last result goes into the
  support bundle. We cannot reproduce Iris Xe here, so the tool is the
  acceptance instrument, not an afterthought.

## Slices

### A0. Red tests for the microphone fallback

- `audio_capture_adapter.rs` tests: a `resolve_target` that times out on the
  inventory child must return a typed `WorkerStartError::ProbeTimeout`, not
  a bare string, and must finish within its bound even when the child ignores
  termination (reuse the hung-child fixture from
  `bounded_output_kills_and_reaps_a_hung_owned_child` in `process_job.rs`).
- `recording.rs` tests: extract the start-path decision into a pure
  `plan_windows_microphone_input(selected, worker_present, worker_result)`
  returning `SessionPcm`, `DirectDshow { reason }` or `Silence { reason }`,
  and pin: worker ok → SessionPcm; worker failed and device present →
  DirectDshow; no selection → Silence("no-selection").
- Done when: the new tests fail on current main for the documented reason
  (today's path yields Silence on worker failure).

### A1. Inventory and protocol caches

- `audio_capture_adapter.rs`: `WorkerProtocolCache` (per worker path, checked
  once per process) and `DshowInventoryCache` (per set of MediaFoundation
  friendly names, from `audio.rs` Windows discovery). `resolve_target` reads
  the caches first; a miss or a resolve failure refreshes them.
- `devices.rs` Windows arm warms the inventory cache after
  `list_native_microphones`, on a blocking thread, never on the RPC path's
  critical section.
- Probe children use `CREATE_NO_WINDOW` like `capture_command` does.
- Done when: a unit test shows two consecutive `resolve_target` calls spawn
  one inventory child, and a device-set change spawns a second.

### A2. Budgets and bounded cleanup

- `audio_capture_adapter.rs`: help probe 4 s, inventory 8 s.
  `session_audio.rs:624-633`: opening budget 15 s, readiness stays 2 s after
  PCM starts.
- `process_job.rs`: after a timeout, terminate the process tree on Windows
  (`taskkill /T /F` or `TerminateJobObject` if the child was placed in a job)
  and bound `child.wait()` to 2 s; report both in the error text.
- `recording.rs`: `yield_to_capture` must wait for the benchmark session's
  drain before mic-warm starts, so a cancelled performance check cannot eat
  the microphone's budget. Verify with the existing performance-check tests.
- Done when: the hung-child test finishes in under 3 s on Windows CI, and the
  timeline test shows mic-warm starting after the benchmark drain.

### A3. Fall back to the direct DirectShow input

- `recording.rs:2980-3013`: on worker failure with a selected, present
  microphone, keep `MicrophoneInput::WindowsDshow` (the arm at
  `capture_input.rs:270-283`), call `sources.microphone_unavailable(reason)`
  so the live-switch capability says why, and emit
  `microphone-capture-worker-fallback` (warn) with the worker's typed reason.
  Reserve `microphone-capture-worker-unavailable` for "device gone" and keep
  the silent FIFO only for that case and for no selection.
- The `windows-directshow-audio-shape` session log (`recording.rs:4751`) must
  still fire for the fallback.
- Done when: A0's tests pass; `selected_windows_screen_and_microphone_resolve_to_windows_inputs`
  still passes; a new test pins that the fallback session's FFmpeg args contain
  `audio=<name>`.

### A4. Say it in the UI

- `lib/studio-health.ts` and `session-runtime-recovery.ts`: keyed warning
  toasts for `microphone-capture-worker-fallback` ("Microphone is live, but
  can't be changed during this session") and
  `microphone-capture-worker-unavailable` ("Streaming without a microphone:
  <reason>"), one per session.
- Quick settings Mic row (`components/studio/quick-settings.tsx`): the
  existing `SourceSwitchStatus` reason renders under the picker; no new
  component. Follow `.claude/skills/videorc-design/SKILL.md`.
- Done when: `studio-health.test.ts` covers both codes; typecheck, lint,
  format pass.

### B0. Probe matrix tool and bundle capture

- `videorc-backend --windows-mf-probe-matrix [WxH@fps kbps ...]`: runs
  `try_probe_once` for each topology (D3D11 upload with and without
  VIDEO_SUPPORT and multithread protection, system-memory NV12, I420) × the
  bitrate rungs × canvases 1080p and 720p, prints one table row per attempt
  (stage, HRESULT, milliseconds, IDR yes/no), and writes the table to the app
  data directory. `support_bundle.rs` includes the last table.
- `pnpm smoke:windows-mf-probe` wraps it for the release-candidate checks.
- Done when: the command runs on Windows CI (WARP has no hardware MFT, so the
  table shows `enumerate: none` and exits 0), and the tester's run on the
  Iris Xe laptop is attached to the PR. That run decides B1 versus B2.

### B1. Probe with a session-grade device

- `windows_media_foundation_encoder.rs` `D3D11CpuUploadInput::new`: add
  `D3D11_CREATE_DEVICE_VIDEO_SUPPORT`, query `ID3D11Multithread` and set
  protection, try feature levels 11.1 then 11.0 like
  `windows_d3d11_device.rs:1795`. Same for the session-time CPU-upload path
  (both constructors share the helper).
- Done when: a `#[cfg(windows)]` test creates the device on WARP and asserts
  `GetMultithreadProtected()`; the matrix from B0 on the tester's laptop shows
  the D3D11-upload row passing at 1080p30. If it does not, B2 carries.

### B2. Topology on the ladder, with a remembered verdict

- `MediaFoundationProbe` gains `input_topology` (D3D11Upload, SystemNv12,
  SystemI420). `probe_hardware_encoder` walks topology first, then bitrate,
  and returns the first pass. The session encoder constructors accept the
  topology and refuse to silently use another.
- Cache failures too: `WINDOWS_NATIVE_ENCODED_PROBE_CACHE` stores rejections
  with a 10 min TTL keyed by adapter driver identity, encoder identity,
  profile and topology; `media_foundation_probe_cache_replays_verdicts_including_failures`
  is extended for the TTL.
- Done when: unit tests pin the ladder order and the cache; a start on a
  machine whose MFT rejects everything runs at most one instantiation per
  (topology, bitrate) per 10 min, measured by the `compositor-arm` phase in
  the timeline test fixture.

### B3. Canvas step-down for streaming sessions

- `resolve_windows_recordable_video`: drop the `stream_enabled` early return.
  For record+stream and stream-only, probe the split roles per candidate
  canvas and select with the same rungs; apply the selected canvas to both
  legs and to the provider plan (bitrate follows the rung table; the vertical
  simulcast leg keeps its own profile).
- Software cap for streams: reuse the CPU-class cap, and if a persisted
  performance-check result exists with `belowFloor`, cap at its recommended
  canvas.
- Copy for `recording-output-stepped-down` when streaming: "This PC's GPU
  video encoder can't stream at 1920x1080, so this stream is going out at
  1280x720 instead. Pick 1280x720 in Output settings to skip this check."
- Done when: new `recording.rs` tests mirror `rejected_1440p_steps_down_to_the_first_size_the_gpu_accepts`
  for a stream plan; `stream_output_topology_requires_every_split_role_to_pass`
  still passes; the stepped-down profile uses `VideoPreset::Custom` (#364
  review note).

### B4. Performance check honesty

- With B2's cache the rungs fit the 15 s budget. Also surface `start_error`
  in the result and in the Settings performance panel, so "did-not-start"
  always carries the reason.
- Done when: `a_session_that_never_started_reports_only_that` asserts the
  reason text, and the renderer shows it.

### B5. Gates and acceptance

- Local: `cargo fmt --check --all`, `cargo test -p videorc-backend` for the
  touched modules, `cargo clippy -p videorc-backend -- -D warnings`,
  `pnpm check:windows`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm --filter @videorc/desktop test`.
- CI: both Windows jobs, including the recording matrix.
- On the tester's Iris Xe laptop, from a signed candidate: run
  `pnpm smoke:windows-mf-probe` (or the packaged command) before and after;
  start three Twitch record+stream sessions; the Stream Manager mixer shows
  the microphone live, the MKV microphone track is not silent (`ffprobe`
  `astats` mean volume above -60 dB), the encoder is hardware at 1080p30 or
  the stream stepped down to 720p with the toast, and render fps stays above
  29 for five minutes.
- Release note copy for the Windows Alpha entry states only what the run
  proved.

## Out of scope

- The 4 s encoder-bridge priming timeout and the #389 change that makes the
  Windows D3D11 pump wait for a real capture frame (the second tester's
  "encoder bridge time out" report). Diagnose separately from that user's
  bundle; B2's cache and B3's step-down will change its timing anyway.
- macOS and Linux audio paths.
- Replacing OpenH264 with a faster software encoder (LGPL-only bundle).

## Verification commands

```sh
cargo test -p videorc-backend -- audio_capture_adapter session_audio process_job windows_media_foundation_encoder recording::tests::windows performance_check
cargo clippy -p videorc-backend -- -D warnings && cargo fmt --check --all
pnpm check:windows
pnpm typecheck && pnpm lint && pnpm format:check && pnpm --filter @videorc/desktop test
```
