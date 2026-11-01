# Plan 195: A slow Windows microphone makes Record fail, lose live mic switching, and say "busy"

> Executor: this is a diagnosis handoff and an implementation plan. Read
> `AGENTS.md` first. Work in your own worktree off current `origin/main`
> (`4891fc53` or later). Paths and line numbers below are `origin/main` at
> `4891fc53`. The Mac can compile and unit-test everything here
> (`pnpm check:windows`), but the only real proof is on Windows. Part W at the
> end is a self-contained test guide for Windows testers.

## Status

- Status: BUILT 2026-10-25 on branch `fix/195-windows-slow-mic-recording-start`
  (S1–S5; see Execution notes). Owed: S0 and W4 on the affected laptop, W3
  on any Windows PC, owner calls D1 and D2. Diagnosed from a support bundle
  (`videorc-support-bundle-20261024-230023Z.json`, kept outside the repo) and
  its screenshot. Windows 11 build 26200, packaged 0.9.150, Intel Iris Xe
  laptop, "Digital Microphone (2- Cirrus Logic High Definition Audio)" plus an
  AudioRelay virtual mic, CPU compositor, software OpenH264. This is the same
  tester as plans 065 and 067.
- Priority P0: Record fails on this PC about one start in five, and every
  start that does work runs on a degraded microphone path. Effort M for
  S1–S4, L for S5. Risk HIGH: session start and audio capture, and no local
  Windows hardware.
- Owner route: Diagnose (done here), then Implementation. Model lane
  `fable-5` (fit 9: audio capture plus FFmpeg startup plus encoder choice,
  Windows only, two earlier plans did not close it).
- Relation to other work:
  - Plan 065 A3 made a failed capture worker fall back to FFmpeg's direct
    DirectShow input instead of silence. That fallback is now what fails.
  - Plan 067 hypothesis 2 ("DirectShow input startup is causal") is now
    supported by measurements; see Findings.
  - Open PR #769 (petercr) raises the Windows FFmpeg output-startup deadline
    from 8 s to 20 s and lets priority maintenance (posters) cancel a running
    quality check. Both help here. S3 and S4 build on it and must not
    duplicate it.
  - Merged #790 (petercr) caches hardware probe successes. Not shipped in
    0.9.150, so the tester has not had it yet.

## Execution notes (2026-10-25)

What was built, and where the code corrected the findings above:

- **S1.**
  - Readiness failures now say what arrived, for example "The microphone
    did not deliver fresh PCM within 10s: 0 frames received." or "...: 9
    frames received, all stale (newest 2480 ms old), largest packet 500 ms,
    first after 1210 ms."
  - When the worker passed or dropped packets before the bus saw any, the
    reason adds "capture worker passed N and dropped M PCM frames".
  - The worker's last stderr lines are kept (3 lines, 300 bytes, device name
    and moniker redacted).
  - New start-timeline marks: `bridge-admission`, `ffmpeg-work-permit`,
    `recordable-video-probe`, `preview-stop`. No TypeScript consumer
    enumerates phases.
  - Every expired command logs `Command expired before dispatch:
    lane=... method=... queuedMs=...` (never params).
- **S2.**
  - Readiness budget: 10 s for `microphone:windows-dshow:*`, 2 s for
    everything else. The outer wait gets 500 ms on top, so the owner thread's
    reason wins.
  - **Correction to F1/W2:** the worker already judged a packet's age at its
    end. Big DirectShow packets were rejected by three hard caps instead:
    `CaptureClock::interval` (PCM more than 100 ms past its anchor),
    `parse_pcm_description` (4,800 frames) and `dshow_anchor` (100 ms). They
    are now bounded by the packet's own duration, up to 1 s. The raw PCM
    queue grew from 8 to 64 chunks.
  - Test switches (Part W, W3), honored only with `VIDEORC_ENABLE_SMOKE_RPC=1`
    (release builds included): `VIDEORC_TEST_CAPTURE_WORKER_FIRST_PCM_DELAY_MS`
    and `VIDEORC_TEST_CAPTURE_WORKER_FAIL`.
  - Live replacement fits: backend switch execution 65 s, renderer request
    76 s.
- **S3.** `ffmpeg_output_startup_deadline`: 8 s with only FIFO inputs, 18 s
  (8 + 10) with a direct DirectShow or Pulse input. This supersedes PR #769's
  "20 s on Windows" commit; expect a one-hunk conflict on
  `FFMPEG_OUTPUT_STARTUP_TIMEOUT` if #769 lands later. Probe flags were not
  added (S0 decides).
- **S4.**
  - **Correction to F4:** the tester's toast came from the background
    `screens.active` reads inside the launch and focus-refresh request
    batches.
  - Live-control commands wait behind a running `session.start`
    reconciliation fence and expire after 5 s of queueing
    (`WEBSOCKET_LIVE_CONTROL_MAX_QUEUE_AGE`). A 3–31 s Record start expired
    the read, failed the whole batch and toasted with no context.
  - Fix: the read now runs on its own, never toasts, and retries at launch.
    Takeover Show and Take off name the takeover when offline. Every other
    live-control action already named itself; tests now pin those titles.
- **S5.**
  - Media Foundation rejections persist in the settings table under
    `windows_mf_probe_rejections`, keyed by adapter driver identity and app
    version (either change drops them). Entries are per encoder preference,
    topology and profile; they expire after 7 days, with at most 64 kept.
  - The stored performance check (when not stale) caps record-only software
    encoding at its highest passed rung, never below 540p. It only tightens
    the CPU cap, and only after every hardware probe was rejected, using the
    existing step-down message.
  - Electron retries hardware acceleration once per app version after a
    persisted GPU fallback. A crash in that launch restores software
    rendering for that version. `VIDEORC_DISABLE_GPU` and
    `VIDEORC_FORCE_GPU` still win.
- **Not done:** S0, W3 and W4 (need Windows hardware), D1, D2, and the probe
  flags.
- **Follow-ups found during the work:**
  - Other background reads in the launch and focus batches can still fail
    the batch with a context-free toast.
  - Busy banner and sound actions from the Stream Manager lose the busy code
    in `runBannerAction`/`runSoundAction`.
  - `executeRemoteIntent` reports errors without context.
  - Live-control commands queue behind a slow `session.start` at all; that
    fence is the deeper fix.
  - The worker's `-rtbufsize 65536` is smaller than one 500 ms s16 stereo
    packet (96 KB); watch S0's `nb_samples`.


## What the user saw

Three toasts at once:

1. **Couldn't start recording.** "FFmpeg output startup failed: FFmpeg did
   not confirm positive output media progress within 8000ms of process
   spawn". Has a Retry button.
2. **Videorc hit a problem.** "Videorc was busy and didn't do it. Try again
   in a moment."
3. **Microphone can't be changed until you stop.** "The capture worker could
   not open it (The microphone did not deliver fresh PCM within 2s.), so
   Videorc is recording it directly."

## Findings

### F1. The microphone never passes the capture worker's 2 s readiness check

In every session since at least 2026-10-05 (five takes in the bundle), the
log shows `Capture-worker microphone fell back to DirectShow` with either
"Microphone readiness exceeded 2s." or "The microphone did not deliver fresh
PCM within 2s."

- `crates/videorc-backend/src/session_audio.rs:827-871`: after the worker
  opens, the owner thread waits at most 2 s for one `valid_fresh_frame`, and
  the caller wraps `ready_rx` in a second hard 2 s timeout. Both are fixed for
  every platform.
- On Windows the worker is `ffmpeg-capture.exe` reading the microphone over
  DirectShow (`audio_capture_adapter.rs:506-580`, `windows_worker_path` at
  `:889`). Its frames must also be younger than `MAX_CAPTURE_AGE` (100 ms,
  `audio_capture_adapter.rs:71`), or the worker drops them
  (`:1294-1300`). `valid_fresh_frame` then requires an age of 2 s or less and
  no timestamp in the future (`session_audio.rs:2039`).
- The bundle cannot tell which of these two causes it is:
  - **W1, slow device start.** The first DirectShow buffer from this driver
    takes longer than 2 s to arrive. F2 shows the same device needs 4–7 s
    inside FFmpeg, which fits.
  - **W2, big buffers.** The driver ignores the 20 ms buffer request and
    delivers large chunks (for example 500 ms). Each chunk's start time is
    already older than 100 ms when it arrives, so the worker drops every
    packet. Readiness can never pass, whatever the budget.
- Whichever it is, the fallback costs the user live microphone switching
  (toast 3) and system audio. The session log says "System audio is off for
  this session because the microphone is on a fallback input."

### F2. With the direct DirectShow mic, FFmpeg needs 5–7 s to start, and the limit is 8 s

FFmpeg's inputs are the compositor's raw-video FIFO (input 0) and, after the
fallback, the DirectShow microphone (input 1, `aist#1:0/pcm_s16le`). The
recording-start timeline gives the gap from `bridge-ready` to the first
positive output clock (`muxer-progress`). Same laptop, same software
OpenH264:

| Session | Audio input to FFmpeg | Canvas | bridge-ready → muxer-progress |
| --- | --- | --- | ---: |
| Perf check 10-05 (`59628e05`) | Session PCM FIFO (no mic) | 1080p30 | 543 ms |
| Perf check 10-08 (`f429d000`) | Session PCM FIFO (no mic) | 720p30 | 534 ms |
| Perf check 10-08 (`6a72706d`) | Session PCM FIFO (no mic) | 540p30 | 555 ms |
| Take 10-05 23:41 | Direct DirectShow mic | 1080p30 | 6,963 ms |
| Take 10-05 23:44 | Direct DirectShow mic | 540p30 | 4,821 ms |
| Take 10-24 22:55 | Direct DirectShow mic | 720p30 | 7,176 ms |
| Take 10-24 22:58 | Direct DirectShow mic | 1080p30 | 6,782 ms |
| **Take 10-24 22:51 (failed)** | Direct DirectShow mic | 720p30 | **> 8,000 ms** |

The 1080p performance check encoded at 0.17× real time and still produced
output in 543 ms. CPU load does not delay the first output; the DirectShow
microphone does. The failed take matches that: the bridge wrote 13 raw frames
and then stalled (`encoderBridgeRawVideoCopiedFrames: 13`, queue full at 16,
oldest frame 5,601 ms, `ffmpeg-startup-evidence outputReady=false`). FFmpeg
was still opening its second input and had stopped reading the first.

The 8 s deadline is `FFMPEG_OUTPUT_STARTUP_TIMEOUT`
(`recording.rs:1046`), enforced by `wait_for_ffmpeg_output_startup`
(`:1507-1533`). It does not account for a live device input inside the FFmpeg
graph. The direct mic input (`capture_input.rs:275-287`) also lacks the
`-probesize 32 -analyzeduration 0` that every other live input in that file
carries. Whether that matters for DirectShow audio is unproven; S0 measures
it.

**Conclusion (high confidence):** the start failure comes from the
microphone fallback path, not from the encoder or the canvas size. Fix F1 and
FFmpeg's inputs become FIFOs again, so it starts in about 0.5 s. Fixing the
deadline (S3) only protects the fallback.

### F3. Clicking Record waits 3–31 s before anything visible happens

The start timeline's `admission → device-resolve` phase took 30,741 ms on the
failed take, 12,362 ms and 3,263 ms on the working ones, and 5.5–6.3 s on
10-05. The session row (`recording-start-requested`) is only written at the
end of that phase, so the user waits up to half a minute with nothing to see.

Between `RecordingStartPhase::Admission` (`recording.rs:3632`) and
`DeviceResolve` (`:3882`) the start path does, in order:

1. `wait_for_encoder_bridge_start_admission` (2 s bound).
2. `ffmpeg_work.begin_capture_when_available()`. This asks the running
   maintenance job (quality check or repair) to cancel and waits until it
   exits (`ffmpeg_work.rs:60-89`). A post-recording quality check was running
   at 22:58:16, before the 22:58:24 click.
3. `resolve_windows_recordable_video` (`:16349`): on a record-only start, the
   opt-in Quick Sync check, then a Media Foundation topology probe per canvas
   rung. On this PC every probe is rejected. A probe costs about 1–4 s (see
   the bundle's `windowsMfProbe`), and the result is cached per process per
   exact profile. The failed take was the first 720p start in that app run.
4. DB writes, `stop_idle_live_preview_for_recording`,
   `resolve_capture_inputs`.

The timeline has no marks inside this phase, so the split between step 2 and
step 3 is unproven. The likely cause is step 3 on a first start at a new size,
plus step 2 when a quality check is running. S1 adds the marks. S5 removes the
repeated probe cost.

### F4. "Videorc was busy" is a command that expired in a blocked lane

- `KNOWN_CODES` in `apps/desktop/src/renderer/src/lib/user-error.ts:63-74`
  maps `command-expired-before-dispatch`, `command-lane-full` and
  `command-not-applied` to that sentence. The "Videorc hit a problem" title
  means the caller passed no context (`couldNotTitle(undefined)`).
- The bundle's transport stats show `liveControl.expiredBeforeDispatchCount: 5`.
  The liveControl lane (`main.rs:5862-5879`) carries `screens.*`,
  `banners.*`, `sounds.*`, `captions.*`, `comments.highlight.*` and
  `capture.recovery.retry`.
- An older backend log in the same bundle shows how this PC blocks lanes:
  `stateful command sessions.poster still running after 2000ms; later ordered
  commands are barriered behind it ... completed after 19288ms`. A poster
  waits behind a quality check that a weak CPU runs for minutes. PR #769's
  "priority maintenance cancels the in-flight background job" targets exactly
  this.
- Nothing records which command expired, so the bundle cannot name the
  feature that failed. S1 fixes that.

### F5. This PC records 1080p30 in software, which it can't sustain

- The Intel Quick Sync Media Foundation encoder rejects every topology,
  bitrate and canvas: `process-output` with `0x8000FFFF` for NV12, and
  `set-input-type 0xC00D36B4` for I420 (the bundle's 72-row `windowsMfProbe`,
  run 2026-10-02). The fallback is OpenH264 on the CPU.
- The machine's own performance check (10-08) passed only 540p30. 1080p30
  failed to start, and 720p30 failed with a backlog. The user still records
  1080p30. The 1080p take shows capture at 23.2 fps, encoder at 0.98×,
  `recordingAtRisk`, and a quality check of "11 long freeze segments, longest
  5.1 s". Earlier takes look the same.
- `select_windows_recordable_video` keeps 1080p on a PC with more than 4
  logical cores even when every hardware probe failed (plan 065 finding B).
  The performance-check verdict is not used.
- The opt-in **Settings → Output → Fallback video encoder → Intel Quick Sync
  (Beta)** (FFmpeg `h264_qsv`, plan 090) was never tried on this PC. It is the
  quickest thing to test (Part W, W2).
- Electron hardware acceleration has been off since 2026-07-09
  (`gpuFallback: gpu-process-crashes`, persisted, `retryAttempts: 0`). The UI
  renders in software on the same weak CPU. That is a side finding; see S5.

## Decisions

- **A selected, working microphone uses the capture worker, even when it is
  slow to start.** The readiness budget follows the device class: DirectShow
  gets a budget a laptop DSP microphone can meet. CoreAudio and Pulse keep
  2 s. The fallback is for a microphone that never delivers, not for a slow
  one.
- **Freshness is judged by when audio arrives, not by the driver's buffer
  size.** If S0 shows large buffers (W2), the worker's age test covers a
  whole packet, following the system-audio rule already in
  `valid_system_frame` (`session_audio.rs:2053-2070`).
- **A start that keeps a direct device input gets a deadline that includes
  that device's open time.** Land #769's Windows 20 s first. Do not raise the
  deadline for every platform (plan 067 rule).
- **Evidence first, so the next bundle answers the question.** Readiness
  failures say what arrived. The start timeline has marks inside
  device-resolve. Expired commands are logged with their method.
- **No silent quality changes.** Any automatic canvas or encoder step-down is
  stated in the UI (existing `recording-output-stepped-down` event).

## Slices

Each slice leaves `main` working. S0 runs in parallel with S1. S2's exact
change depends on S0's W1/W2 verdict, but S2's tests can be written first.

### S0. Measure the microphone and encoders on the tester's laptop (Windows, no code)

Run Part W, W1, on the affected laptop (the contributor can run it on their
own PC as a baseline). It reports for each microphone:

- time to the first audio packet through `ffmpeg.exe` with Videorc's
  fallback arguments, and through `ffmpeg-capture.exe` with the worker's
  arguments;
- `nb_samples` per packet (960 at 48 kHz = 20 ms; 24,000 = 500 ms);
- whether `-probesize 32 -analyzeduration 0` changes the direct-path time;
- whether `h264_qsv` and `h264_mf` encode 1080p30 on this GPU, and the
  OpenH264 speed at 1080p30 and 720p30;
- GPU name and driver version, CPU and logical cores.

Done when: the output file is attached to the PR and this section records
the verdict: W1 (first packet over 2 s with small packets), W2 (packets of
100 ms or more), or both.

### S1. Evidence that the next support bundle can answer from

- `session_audio.rs` `prepare_producer_in`: during readiness, count frames
  received, frames rejected as stale or as future-dated, the first-frame
  arrival time, and the largest frame duration. Put them in the failure
  reason, for example: "No fresh PCM within 2s: 0 frames received" or "...: 9
  frames received, all stale (newest 480 ms old, 24000-sample packets)". Keep
  the existing first sentence so the renderer copy still matches.
- Keep the worker's last stderr lines (bounded, with the device name
  redacted) in the failure reason when it exits or fails.
- `recording.rs`: add start-timeline sub-marks inside device-resolve:
  `bridge-admission`, `ffmpeg-work-permit` (with
  `maintenance_cancel_requested` noted), `recordable-video-probe`,
  `preview-stop`, `inputs-resolved`. Add new `RecordingStartPhase` variants in
  `recording_timeline.rs` and keep the existing phase names and order, because
  scripts parse them (check `scripts/` for `device-resolve` consumers).
- `main.rs`: when a lane command expires before dispatch, log a `warn` line
  with lane, method and queue age. Never log params.
- Done when: unit tests pin each new reason text (0 frames, all stale,
  future-dated), the timeline test fixture shows the new marks in order, and a
  lane test asserts the expiry log names the method.
  `cargo test -p videorc-backend -- session_audio recording_timeline command_lane`
  and `pnpm check:windows` pass.

### S2. The capture worker accepts a slow DirectShow microphone

- `session_audio.rs`: replace both hard-coded 2 s readiness waits with one
  per-role budget, `readiness_budget(protocol)`: DirectShow 10 s, everything
  else 2 s. The inner deadline and the outer `tokio::time::timeout` must use
  the same value. The outer one currently runs after `opened_rx`, so give it
  the budget plus a small margin and let the inner deadline decide.
- If S0 says W2: in `audio_capture_adapter.rs` judge a packet's age by its end
  (`captured_at + packet duration`) against `MAX_CAPTURE_AGE`, or allow an
  age of up to one packet duration plus 100 ms. Do the same in
  `valid_fresh_frame` for worker frames. Do not loosen it for CoreAudio.
- Live microphone replacement goes through the same readiness path. Check
  that a slower Windows switch still shows its pending state and that the
  existing switch deadline in the renderer (if any) is at least the new
  budget.
- Done when: a fake producer that first delivers at 6 s passes readiness
  under the DirectShow budget and fails at 2 s under CoreAudio. A W2 fixture
  (500 ms packets arriving 500 ms late) passes. `cargo test -p videorc-backend --
  session_audio audio_capture_adapter` passes, and so does `pnpm
  check:windows`. On Windows (Part W, W3, case B), a worker held back 6 s is
  still used: no `microphone-capture-worker-fallback` event, and live mic
  switching works.

### S3. The direct DirectShow fallback can't lose the take

- Land PR #769's Windows `FFMPEG_OUTPUT_STARTUP_TIMEOUT = 20 s` (owner call
  D1). If #769 does not land, make that one change here instead, with its
  test.
- Better still: base the deadline on the graph. With a direct device input
  (`MicrophoneInput::WindowsDshow` or `LinuxPulse`), the deadline is the
  base 8 s plus the DirectShow open budget. With only FIFO inputs, it stays
  8 s. That keeps the fast-fail for a wedged pipe on normal sessions.
- If S0 shows the probe flags shorten the direct path, add `-probesize 32
  -analyzeduration 0` to the `WindowsDshow` arm in `capture_input.rs` and
  update `selected_windows_screen_and_microphone_resolve_to_windows_inputs`
  and the argument test at `capture_input.rs:597-620`.
- Done when: a unit test pins the deadline per input topology (FIFO only →
  8 s; direct DirectShow → 8 s + budget). `cargo test -p videorc-backend --
  ffmpeg_output_startup` passes. On Windows (W3, case C), a forced fallback
  on a normal microphone still records.

### S4. "Busy" toasts name the action, and posters stop blocking live controls

- Land PR #769's priority-maintenance commit (D1). It is the fix for the
  poster barrier in F4.
- Using S1's expiry log, find the liveControl callers that pass no
  `UserErrorContext`. Background reads (`screens.active` bootstrap and
  refresh in `hooks/use-studio.tsx:8031`, `:8633`, `:12386`, `:12419`) must
  not toast at all. User actions must pass their verb and object so the title
  says "Couldn't show the banner", not "Videorc hit a problem".
- Done when: `user-error.test.ts` and the affected hook tests cover a context
  for each liveControl action. `pnpm typecheck`, `pnpm lint` and
  `pnpm format:check` pass.

### S5. Right-size output on a CPU-only Windows PC (after S0, owner call D2)

- Remember Media Foundation rejections across app runs, keyed by adapter
  driver identity, encoder identity and profile, with the existing TTL
  idea (plan 065 B2), so `recordable-video-probe` stops costing seconds on
  every first start. Invalidate on a driver version change.
- Use the stored performance-check verdict, when its `capabilityKey` matches
  this machine, as the software cap in `select_windows_recordable_video`.
  Step down the canvas and say so with `recording-output-stepped-down`.
- If S0 shows `h264_qsv` works on the Iris Xe and Media Foundation does not:
  owner call D2 on making Quick Sync the automatic fallback on Intel when its
  own probe passes, instead of opt-in Beta.
- Side finding: a persisted Electron GPU fallback from 3 months ago is never
  retried. Retry once per app version (one new crash puts it back). Track it
  as its own small PR; it is not part of the P0.
- Done when: unit tests pin the persisted-rejection cache and the
  verdict-based cap. On the tester's laptop, a second app launch shows
  `recordable-video-probe` under 500 ms in the start timeline.

### S6. Gates and acceptance

- Mac: `cargo fmt --check --all`, `cargo test -p videorc-backend` (targeted
  filters per slice, then the full suite once at the end),
  `cargo clippy -p videorc-backend -- -D warnings`, `pnpm check:windows`,
  `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:scripts`,
  `pnpm --filter @videorc/desktop test`, `pnpm build`.
- Mac smokes, because start and audio paths change: `pnpm
  smoke:recording-studio` and `pnpm smoke:record-latency`.
- Windows: Part W, W3, on any Windows PC, then W4 on the tester's laptop.
  CI's Windows installer artifact for the PR is the build to test.
- Record which gates could not run and why. Cross-compiling is not hardware
  evidence.

## Owner decisions

- **D1.** Land PR #769 (Windows 20 s startup window, priority maintenance,
  raw-FIFO downstream close). Its PR body flags one sub-change for a call:
  MP4 export after a non-zero FFmpeg exit on a user Stop. Recommendation:
  land #769 and split that sub-change out if you want main's
  recovery-media rule kept as is.
- **D2.** After S0: make Intel Quick Sync (FFmpeg `h264_qsv`) the automatic
  fallback on Intel PCs whose own Quick Sync probe passes? Recommendation:
  yes, if S0 shows it encodes 1080p30 at 1.0× or better on the Iris Xe.
- **D3.** Who runs what: the original tester runs W1 and W4 (they have the
  hardware). The contributor runs W1 as a baseline, W2 if they have Intel
  graphics, and W3.

## Out of scope

- Fixing the Intel Media Foundation `E_UNEXPECTED` itself (plans 065 B and
  067 own it). S0's `h264_mf` result says whether it is our MFT usage (if
  FFmpeg's `h264_mf` works) or the driver.
- Releases, waivers, and a global startup-deadline increase.
- Redesigning the microphone UI. Toast copy changes only where S4 says.

---

## Part W: Windows test guide

This part is self-contained. The person running it needs no other context.

**Why we need Windows:** the bug lives in Windows audio capture
(DirectShow) and Windows encoders. A Mac cannot run either.

**Background in two lines:** on one Intel laptop, the microphone takes too
long to start for Videorc's 2 s check. Videorc then falls back to a slower
path, and recording sometimes fails with "FFmpeg did not confirm positive
output media progress within 8000ms".

### W1. Measure the microphones and encoders (any Windows PC, about 2 minutes)

1. Quit Videorc completely (tray icon → Quit), so it does not hold the
   microphone.
2. Check Windows Settings → Privacy & security → Microphone → "Let desktop
   apps access your microphone" is On.
3. Save the script below as `videorc-windows-check.ps1` on the Desktop.
4. Open PowerShell and run:
   `powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Desktop\videorc-windows-check.ps1"`
5. Send back `videorc-windows-check.txt` from the Desktop. It contains device
   and GPU names and timings, and no recordings, keys or account data. Talk
   or make a sound during the microphone tests if you like; no audio is saved.

```powershell
# videorc-windows-check.ps1 - read-only timing check for Videorc support.
$ErrorActionPreference = 'Continue'
$bin = Join-Path $env:LOCALAPPDATA 'Programs\Videorc\resources\ffmpeg\bin'
$ff  = Join-Path $bin 'ffmpeg.exe'
$cap = Join-Path $bin 'ffmpeg-capture.exe'
$out = Join-Path $env:USERPROFILE 'Desktop\videorc-windows-check.txt'
if (-not (Test-Path $ff)) { Write-Host "Videorc FFmpeg not found at $ff"; exit 1 }
"Videorc Windows check  $(Get-Date -Format o)" | Set-Content $out

function Add([string]$text) { $text | Add-Content $out }
# Runs one FFmpeg command with a hard timeout (a mic that never sends audio
# would otherwise hang) and returns its stderr text and timing.
function Invoke-FF([string]$exe, [string]$argLine, [int]$timeoutMs = 20000) {
  $err = [IO.Path]::GetTempFileName(); $std = [IO.Path]::GetTempFileName()
  $start = Get-Date
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $exe -ArgumentList $argLine -NoNewWindow -PassThru `
       -RedirectStandardError $err -RedirectStandardOutput $std
  $null = $p.Handle
  $timedOut = -not $p.WaitForExit($timeoutMs)
  if ($timedOut) { try { $p.Kill() } catch {}; $p.WaitForExit(3000) | Out-Null }
  $sw.Stop()
  $text = Get-Content $err -Raw -ErrorAction SilentlyContinue
  Remove-Item $err, $std -ErrorAction SilentlyContinue
  [pscustomobject]@{ Start = $start; Ms = $sw.ElapsedMilliseconds; TimedOut = $timedOut; Exit = $p.ExitCode; Text = "$text" }
}
function Run([string]$label, [string]$exe, [string]$argLine, [string]$pattern) {
  $r = Invoke-FF $exe $argLine
  Add ""
  Add "=== $label"
  $state = if ($r.TimedOut) { 'TIMED OUT after 20 s (no audio?)' } else { "exit $($r.Exit)" }
  Add "start $($r.Start.ToString('HH:mm:ss.fff'))  total $($r.Ms) ms  $state"
  # FFmpeg ends progress updates with a bare CR: split on both.
  $hits = @($r.Text -split "[`r`n]+" | Select-String -Pattern $pattern)
  $hits | Select-Object -First 6 | ForEach-Object { Add $_.Line }
  if ($hits.Count -gt 6) { Add "... last: $($hits[-1].Line)" }
}

Add "--- system"
Get-CimInstance Win32_VideoController | ForEach-Object { Add "GPU: $($_.Name)  driver $($_.DriverVersion)" }
Get-CimInstance Win32_Processor | ForEach-Object { Add "CPU: $($_.Name)  logical $($_.NumberOfLogicalProcessors)" }
Add "OS: $([Environment]::OSVersion.VersionString)"
Add "FFmpeg: $(& $ff -hide_banner -version 2>&1 | Select-Object -First 1)"
Add "Capture worker present: $(Test-Path $cap)"

$list = Invoke-FF $ff '-hide_banner -list_devices true -f dshow -i dummy'
Add ""
Add "--- DirectShow device list took $($list.Ms) ms"
$mics = [regex]::Matches($list.Text, '"([^"]+)" \(audio\)') | ForEach-Object { $_.Groups[1].Value }
$mics | ForEach-Object { Add "mic: $_" }

$audioPattern = 'ashowinfo.*n:[0-2] |Audio:|Error|error|Could not|I/O'
foreach ($mic in $mics) {
  $dev = "audio=`"$mic`""
  # 1. Videorc's direct fallback input, as the app builds it.
  Run "direct fallback | $mic" $ff `
    "-hide_banner -nostdin -loglevel repeat+datetime+info -f dshow -audio_buffer_size 100 -thread_queue_size 512 -i $dev -t 4 -af ashowinfo -f null -" $audioPattern
  # 2. Same, with the probe flags other live inputs use.
  Run "direct fallback + probe flags | $mic" $ff `
    "-hide_banner -nostdin -loglevel repeat+datetime+info -probesize 32 -analyzeduration 0 -f dshow -audio_buffer_size 100 -thread_queue_size 512 -i $dev -t 4 -af ashowinfo -f null -" $audioPattern
  # 3. The capture worker, as Videorc starts it.
  if (Test-Path $cap) {
    Run "capture worker | $mic" $cap `
      "-hide_banner -nostdin -loglevel repeat+datetime+info -copyts -thread_queue_size 4 -probesize 32 -analyzeduration 0 -f dshow -videorc_audio_clock 1 -audio_buffer_size 20 -rtbufsize 65536 -i $dev -t 4 -af ashowinfo -f null -" $audioPattern
  }
}

$encPattern = 'speed=|Error|error|not found|Unknown encoder|Could not|failed'
$src = '-hide_banner -nostdin -f lavfi -i testsrc2=size=1920x1080:rate=30 -t 10 -pix_fmt nv12'
Run "h264_qsv 1080p30"  $ff "$src -c:v h264_qsv -b:v 6000k -f null -" $encPattern
Run "h264_mf hw 1080p30" $ff "$src -c:v h264_mf -hw_encoding 1 -b:v 6000k -f null -" $encPattern
Run "openh264 1080p30"  $ff "-hide_banner -nostdin -f lavfi -i testsrc2=size=1920x1080:rate=30 -t 10 -pix_fmt yuv420p -c:v libopenh264 -b:v 6000k -f null -" $encPattern
Run "openh264 720p30"   $ff "-hide_banner -nostdin -f lavfi -i testsrc2=size=1280x720:rate=30 -t 10 -pix_fmt yuv420p -c:v libopenh264 -b:v 4000k -f null -" $encPattern
Add ""
Add "done $(Get-Date -Format o)"
Write-Host "Saved $out"
```

How to read it (for whoever gets the file):

- **Time to first audio packet** = the timestamp on the first
  `ashowinfo ... n:0` line minus the `start` time on that block. Over 2,000 ms
  on the capture-worker line confirms W1.
- **Packet size** = `nb_samples` on the ashowinfo lines. At 48 kHz, 960 is
  20 ms and 4,800 is 100 ms. 4,800 or more on the capture-worker line
  confirms W2.
- **Probe flags matter** if the second block's first packet is clearly
  earlier than the first block's.
- **Encoders:** a `speed=` of 1.0x or more means real time. An error on
  `h264_qsv` means Quick Sync through FFmpeg does not work on this PC. If
  `h264_mf` works while Videorc's own Media Foundation probe fails, the bug is
  in Videorc's encoder setup, not the driver.

### W2. Try the Quick Sync option in the current app (Intel graphics only, 5 minutes)

1. Open Videorc → Settings → Output → **Fallback video encoder** → choose
   **Intel Quick Sync** (marked Beta). The row only appears on PCs with Intel
   graphics.
2. Record 60 s of moving content (play a video full screen) at 1080p30 with
   the microphone on.
3. Stop. Open Health and export a support bundle. Send it along with "Quick
   Sync on".
4. Set it back to **Automatic** afterwards if the recording was worse.

### W3. Test the fix build on any Windows PC (contributor)

Use the Windows installer artifact from the fix PR's CI run (or
`pnpm package:backend` and `pnpm --filter @videorc/desktop package` from the
branch). Start the app from PowerShell so the test variables apply:

```powershell
$env:VIDEORC_ENABLE_SMOKE_RPC = '1'   # allows the test-only controls below
& "$env:LOCALAPPDATA\Programs\Videorc\Videorc.exe"
```

These test-only controls ship with plan 195's build and are ignored unless
`VIDEORC_ENABLE_SMOKE_RPC=1` is also set:

- `VIDEORC_TEST_CAPTURE_WORKER_FIRST_PCM_DELAY_MS=<ms>`: hold back the
  worker's first audio by that long (simulates the slow laptop microphone).
- `VIDEORC_TEST_CAPTURE_WORKER_FAIL=1`: make the worker fail readiness, which
  forces the direct DirectShow fallback.
- `VIDEORC_WINDOWS_D3D11_MEDIA=disabled` and
  `VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT=raw` (they exist today; PR #769 used
  them): force the raw-pipe software-encoder path the Iris Xe laptop uses.

Run each case 3 times with Record (record only), screen plus microphone,
1080p30, 30 s of moving content and some speech:

| Case | Variables | Expected on the fix build |
| --- | --- | --- |
| A. Baseline | none | Records. No microphone warning. |
| B. Slow mic | `..._FIRST_PCM_DELAY_MS=6000` | Records. Start takes about 6 s longer. **No** "Microphone can't be changed" warning. Switching the mic during the take works. |
| C. Fallback | `..._WORKER_FAIL=1` | Records (does not fail at 8 s). "Microphone can't be changed" warning is shown. Audio is in the file. |
| D. Slow mic + software encoder | B's variable + the two raw-pipe variables | Records. No "Couldn't start recording". |
| E. Same as D on the **current** release (0.9.150 or newer) | the two raw-pipe variables only, a real mic | For comparison: note whether the start fails or warns. |

For each case, send: pass/fail, whether audio is in the MP4, the start time
you saw, and a support bundle (Health → Export) from one run of each case.

### W4. Acceptance on the affected laptop (original tester)

On the fix build, with the same microphone and settings as before:

1. Record 5 takes of about 30 s. Each one must start, with no "Couldn't start
   recording" and no "Microphone can't be changed" toast.
2. In one take, switch the microphone during recording. It must switch.
3. Turn System audio on and record one take. System audio must be in the
   file.
4. Export one support bundle at the end. Send it with the W1 output.

Done when: 5/5 starts, mic switching works, system audio is present, and the
bundle's start timeline shows `mic-warm` under 10 s with no
`microphone-capture-worker-fallback` event.
