# Videorc OBS-Quality Acceptance Checklist

Final acceptance for the OBS Quality Root Fix plan (Phase 8). It has two halves:
an **automated** half (objective metric gates that cannot be fooled by synthetic
inputs) and a **manual** half (a human OBS side-by-side, which no automation can
replace). Both must pass before the plan is considered done.

The automation here measures the *real recorded artifact* and the *live diagnostics*,
not synthetic test patterns or `requestAnimationFrame` cadence — that distinction is the
whole point of the root-fix work.

## Tooling

| Tool | What it does |
|---|---|
| `pnpm baseline:real-source [--gate]` | Real screen + camera + mic → 60s record → samples live diagnostics → runs the analyzer → writes a baseline + acceptance verdict. `--gate` makes the exit code reflect the gates. |
| `pnpm baseline:real-source:av-sync-mpegts-output` | Real screen + camera + mic + visible flash/click browser stimulus → record an MP4 for `measure:av-sync`. Use `VIDEORC_BASELINE_MIC_SYNC_OFFSET_MS` to verify microphone calibration. |
| `pnpm acceptance:obs-side-by-side` | Manual acceptance harness: launches the motion or A/V sync stimulus, optionally opens OBS and the Videorc dev app, writes `obs-side-by-side-manifest.json`, and prints the human side-by-side checklist without changing OBS settings. |
| `pnpm smoke:recording-native-preview` | Native/proof preview recording smoke that writes startup and final-file analyzer reports beside each MP4, including the first-60-frame startup thumbnail sheet. |
| `pnpm smoke:preview-motion` | Native preview motion/currentness smoke that exercises scene/layout changes and verifies native-surface/CAMetalLayer cadence, blank-frame count, and compositor lag. |
| `pnpm analyze:recording <file> --fps N` | Honest final-file analyzer on any recording (freeze / repeated-frame bursts / pacing / audio gaps / A/V skew). |
| `pnpm analyze:startup <file> --width W --height H --fps N` | First-2-seconds startup analyzer (metadata + decoded frame dimensions + first-frame hashes + startup thumbnail sheet). |
| `pnpm measure:av-sync <recording-or-evidence-json> --current-offset-ms N --require-target` | Lip-sync measurement against the flash+click fixture. Evidence manifests resolve to their recorded MP4. `--require-target` makes the 100 ms target a failing acceptance gate, and `--current-offset-ms` prints the next microphone sync estimate. Add `--json` for a machine-readable recommendation that can be copied into calibration tooling. Use `--click-noise-db -55` when the browser click is quiet through a real microphone. |
| `pnpm measure:av-sync --make-fixture out.mp4 --seconds 120` | Generate the flash+click reference to play on a second screen / through speakers while recording. |
| `pnpm test:scripts` | Unit/integration tests for all of the above (must stay green). |

The acceptance gate logic lives in `scripts/lib/acceptance-gate.mjs` and is unit-tested,
so the bar itself is verifiable without hardware. Real-source baseline reports also
include a problem-ownership triage that maps first-2-seconds glitches, preview lag,
preview softness, and recording hot-path risk to the next responsible slice.

## Automated acceptance — metric gates

Run `pnpm baseline:real-source --gate` for each scenario (set the source/output via env).
Every gate below must pass; the gate is **hard-fail**, and a "native" preview that fetched
any image-poll route during the session fails on transport honesty.

| Gate | Threshold | Where measured |
|---|---|---|
| Final-file freeze segment | none > **100 ms** when visible motion is required; warning-only for no-motion real-source baselines | analyzer (`freezedetect`) |
| Repeated-frame burst | none > **2** consecutive when visible motion is required; warning-only for no-motion real-source baselines | analyzer (`framemd5`) |
| Startup resolution | first 2s decoded frames match target output; no preview-sized frame leak; report includes first-frame evidence and dimension timeline | startup analyzer |
| Frame count vs `duration × fps` | within **2%** | analyzer (`ffprobe`) |
| Recording duplicate/synthetic fed frames | synthetic **0**; duplicate re-feed bursts must stay within the decoded-file proof budget and are recorded as evidence when final-file proof passes | `encoderBridgeRepeatedFrames` / `encoderBridgeSyntheticFrames` |
| Encoder speed | ≥ **0.98×** | diagnostics |
| Mic dropped frames | **0** | live diagnostics |
| Mic capture coverage | ≥ **95%** | live diagnostics |
| A/V duration skew | target 100 ms, hard-fail **150 ms** | analyzer |
| Lip-sync (flash+click) | median target 100 ms, hard-fail **150 ms** | `measure:av-sync` |
| Transport honesty | **0** image-poll requests during a "native" preview | `previewImagePollCounts` delta |
| Native preview backing | `cametal-layer` | `previewSurfaceBacking` |
| Encode backend | `hardware-videotoolbox` | diagnostics |
| Maintenance ffmpeg/ffprobe during capture | **0** | diagnostics |

Every generated real-source baseline report must also print a media quality mode from
[`docs/native-4k-media-engine-refactor.md`](native-4k-media-engine-refactor.md): `fallback-baseline`,
`native-preview-only`, `zero-copy-recording`, `record-stream-split-output`, or `4k-accepted`.
Treat the mode as the strongest path proved by the run, not the path the command intended to use.

### Scenarios (set via env, then `pnpm baseline:real-source --gate`)

```sh
# 1080p30 screen+camera+mic, 60s (default)
pnpm baseline:real-source --gate

# 1440p30
VIDEORC_BASELINE_WIDTH=2560 VIDEORC_BASELINE_HEIGHT=1440 VIDEORC_BASELINE_BITRATE_KBPS=8000 \
  pnpm baseline:real-source --gate

# 4K30 with required screen motion stimulus
pnpm baseline:real-source:4k30 -- --gate
pnpm baseline:evidence:4k30 -- <output-dir>/latest-real-source-evidence.json

# 4K30 A/V sync stimulus, then measure the generated MP4
pnpm baseline:real-source:4k30:av-sync -- --gate
pnpm measure:av-sync -- <output-dir>/latest-real-source-evidence.json --require-target

# 1080p60 (if the selected sources support it)
VIDEORC_BASELINE_FPS=60 pnpm baseline:real-source --gate

# 10-minute 4K30 endurance with required screen motion stimulus
pnpm baseline:real-source:4k30:endurance -- --gate
pnpm baseline:evidence:4k30:endurance -- <output-dir>/latest-real-source-evidence.json

# 10-minute endurance at your normal preset
VIDEORC_BASELINE_RECORDING_MS=600000 VIDEORC_SMOKE_TIMEOUT_MS=900000 \
  pnpm baseline:real-source --gate
```

Stress variants (perform during the run, by hand): drag/resize the camera overlay; scroll
screen text quickly; move a window; move your hand quickly in front of the camera. Re-run
the gate afterward — the final file must still pass freeze/repeated-frame/pacing.

Static real-source baselines do not guarantee visible pixel motion. In those runs,
`VIDEORC_BASELINE_REQUIRE_MOTION=0` keeps exact decoded-frame repeats and freezedetect
segments as warnings, while frame pacing, startup dimensions, synthetic frames, transport
honesty, mic capture, and native preview currentness remain hard gates. Use
`VIDEORC_BASELINE_REQUIRE_MOTION=1` or the stress/manual scenarios when the goal is to
prove motion smoothness from the final file alone.

Lip-sync pass: play `--make-fixture` output on a second screen + through speakers (or clap
on camera), record 30–120 s, then `pnpm measure:av-sync <recording-or-evidence-json>`. For the automated
browser-stimulus path, run `pnpm baseline:real-source:av-sync-mpegts-output`, then run
`pnpm measure:av-sync <recording-or-evidence-json> --current-offset-ms N --require-target`. Add
`--json` when you need the stable recommendation fields (`medianOffsetMs`,
`currentMicrophoneSyncOffsetMs`, `recommendedMicrophoneSyncOffsetMs`,
`targetMs`, `pass`, and `pairCount`) for a guided calibration flow. If the median
is over the 100 ms target but under the 150 ms hard fail, set
`VIDEORC_BASELINE_MIC_SYNC_OFFSET_MS` to verify the matching microphone calibration and
re-measure before considering mouth/voice sync accepted.

In the Sources tab, the microphone Sync control can import the JSON output,
apply the measured recommendation, or reset back to the structural `0 ms`
default. Importing a measurement never changes the offset until Apply is
pressed.

## Manual acceptance — OBS side-by-side

No metric replaces a human watching both. Open **OBS** and **Videorc** side by side with
the **same** camera, the **same** screen/window, and the **same** output FPS.

Repeatable harness:

```sh
pnpm acceptance:obs-side-by-side -- --stimulus=motion
```

For mouth/voice sync, use the flash/click variant:

```sh
pnpm acceptance:obs-side-by-side -- --stimulus=av-sync
```

The harness does not mutate OBS. It only opens OBS/Videorc, starts the selected stimulus,
prints the checklist, writes a comparable-settings manifest, and keeps the stimulus alive
until Ctrl-C. Use `--output-dir <dir>` to keep the manifest beside screenshots and notes.
Local inspection on 2026-06-07 found OBS websocket disabled, so the manual pass should not
depend on hidden OBS automation. OBS CLI exposes `--startrecording` but no stop-recording
counterpart in the local help output, so do not manufacture an automated OBS recording by
force-quitting OBS during MP4 output. Also match OBS/Videorc output settings before
judging quality; the local OBS profile was detected as 3840x2160 at 24 NTSC, while the
current automated Videorc evidence is 1920x1080 or 2560x1440 at 30fps. The harness
defaults to the `Long` OBS scene because it has visible screen/window and camera sources;
it prints the visible OBS sources before launch and warns if the chosen scene is camera-only, such as
`talking head`.

- [ ] **Preview sharpness** — screen text is as readable in Videorc preview as in OBS (the preview path badge reads **OBS-native**, not Fallback).
- [ ] **Preview hand latency** — move your hand quickly; Videorc preview keeps up with OBS, no rubber-banding.
- [ ] **Screen scroll smoothness** — scroll a long page; no stutter vs OBS.
- [ ] **Cursor freshness** — the cursor is current, not lagging.
- [ ] **Record 2 minutes** in each app with the same scene.
- [ ] **Final recording smoothness** — play both back; Videorc is as smooth as OBS, no micro-stutter or freezes.
- [ ] **Voice/mouth sync** — mouth and voice stay aligned for the full clip.
- [ ] **No voice gaps** — no dropouts or skips in the audio.

### Record start/stop feel — OBS side-by-side

Videorc's Record and Stop must feel as instant as OBS. This cannot be automated
here (OBS websocket is off and its CLI has no stop-recording command), so time it
from a screen recording of the desktop instead of by feel alone. The automated
counterpart is `pnpm smoke:record-latency` (renderer-path click → `recording` /
click → `idle`, report JSON with cold/warm p50/p95); run it before and after the
manual pass and quote both in the acceptance note.

1. Match scene, camera, screen/window and output fps in both apps (as above).
2. Start a 60 fps screen recording of the whole desktop (QuickTime → New Screen
   Recording, or `screencapture -v <file>.mov`) with a visible mouse cursor and a
   stopwatch app in frame as a cross-check.
3. In each app perform five Record clicks and five Stop clicks, holding each
   recording about five seconds.
4. Frame-step the screen recording (QuickTime arrow keys, or
   `ffmpeg -i <file>.mov -vf showinfo -f null -` and read frame times) from the
   frame the button visibly depresses to the frame the app's recording indicator
   first changes — OBS: red dot + timer; Videorc: Stop button + session timer.
   Milliseconds = frames × 1000 / 60. Do the same from Stop click to the app being
   ready to record again (OBS: REC indicator gone; Videorc: Record button enabled).
5. Record the median of the five for each app and each direction in the acceptance
   note next to the `smoke:record-latency` numbers.

- [ ] **Start feel** — Videorc's start indicator changes within +100 ms of the OBS median.
- [ ] **Stop feel** — Videorc's Record button is enabled again within +100 ms of the OBS median.
- [ ] **No pre-roll** — the first second of the Videorc file has no black/placeholder frames and is at the requested resolution (startup-resolution report).
- [ ] **Indistinguishable** — the operator cannot tell which app is faster without the frame-stepped numbers.

### Done gate

- [ ] All automated metric gates pass for 1080p30, 1440p30, (1080p60 if supported), and the 10-min endurance run.
- [ ] The startup-resolution report passes for every real-source recording; the first 2 seconds match the requested output resolution/layout, with a clean one-run dimension timeline.
- [ ] The lip-sync measurement is within target on a flash+click (or clap) recording.
- [ ] The manual OBS side-by-side checklist is fully checked — a normal user cannot tell Videorc preview motion/currentness apart from OBS, and the final recording is smooth and synced.
- [ ] The user's previous failure pattern (laggy/soft preview, glitchy/desynced recordings) no longer reproduces.

Record the outcome (pass/fail per scenario, the diagnostics/analyzer reports, and the
manual notes) in a dated acceptance note alongside this checklist. Current note:
[`docs/acceptance/2026-06-07-obs-parity-acceptance.md`](acceptance/2026-06-07-obs-parity-acceptance.md).
Use [`docs/acceptance/obs-parity-acceptance-template.md`](acceptance/obs-parity-acceptance-template.md)
for new Plan 013 runs.

> **Status 2026-06-07:** the latest local motion-required MPEG-TS gates now pass at
> 1080p30 and 1440p30 with real screen/camera/mic sources, native `CAMetalLayer`
> preview, zero image polling, Metal compositor, VideoToolbox zero-copy output, startup
> PASS, final-file PASS, and encoder-bridge repeats `0`. Evidence:
> `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-real-source-baseline-1780792948903/videorc-session-20260607-004236.baseline.md`
> and
> `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-real-source-baseline-1780793237944/videorc-session-20260607-004722.baseline.md`.
> A latest-code 10-minute motion-required endurance gate also passes at
> `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-real-source-baseline-1780793397213/videorc-session-20260607-005001.baseline.md`:
> acceptance PASS, final-file PASS, startup PASS, native preview `100.6fps`, interval p95
> `18ms`, source-to-present p95/p99 `25/28ms`, image polls `0`, mic dropped `0`, raw/Metal
> copied `0/0`, zero-copy `18002`, VT output `18002`, and one single-frame bridge repeat.
> The 1080p60 scenario was attempted on the selected real source set, but the selected
> MacBook Pro Camera reports only 15/30fps modes and FFmpeg rejected 60fps before any
> recording artifact was created. Evidence:
> `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-real-source-baseline-1780794317959/`.
> The automated browser flash/click stimulus now captures valid lip-sync pairs. With the
> default `0ms` microphone sync offset, the real-source MP4 at
> `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-real-source-baseline-1780794836805/videorc-session-20260607-011401.mp4`
> measured `+121ms` median audio lag (`62` pairs, max `158ms`), which passes the hard
> fail but misses the `100ms` target. Re-running the same path with
> `VIDEORC_BASELINE_MIC_SYNC_OFFSET_MS=-120` produced
> `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-real-source-baseline-1780795031566/videorc-session-20260607-011715.mp4`
> and measured `+6ms` median (`31` pairs, max `28ms`). The AV-sync stimulus now also
> carries continuous low-luma motion and the baseline gate explicitly relaxes only
> preview FPS/interval cadence for this stimulus, leaving final-file, startup, native
> transport, GPU/zero-copy, mic, and source-to-present checks active. Final calibrated
> evidence:
> `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-real-source-baseline-1780795444655/videorc-session-20260607-012409.baseline.md`
> is baseline PASS, and
> `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-real-source-baseline-1780795444655/videorc-session-20260607-012409.mp4`
> measures `+46ms` median (`31` pairs, max `49ms`) with
> `pnpm measure:av-sync ... --current-offset-ms -120 --require-target`; the command exits
> PASS and reports the current setting within target with a zero-error estimate of
> `-166ms`. The Sources tab Sync control now supports exact millisecond entry, so
> measured offsets can be applied directly instead of being rounded to the old 25 ms
> slider step. The remaining acceptance work is the human OBS side-by-side pass; an
> automatic guided calibration flow is optional polish rather than a blocker for applying
> the measured sync value.
