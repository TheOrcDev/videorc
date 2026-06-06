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
| `pnpm analyze:recording <file> --fps N` | Honest final-file analyzer on any recording (freeze / repeated-frame bursts / pacing / audio gaps / A/V skew). |
| `pnpm analyze:startup <file> --width W --height H --fps N` | First-2-seconds startup analyzer (metadata + decoded frame dimensions + first-frame hashes + startup thumbnail sheet). |
| `pnpm measure:av-sync <file>` | Lip-sync measurement against the flash+click fixture. |
| `pnpm measure:av-sync --make-fixture out.mp4 --seconds 120` | Generate the flash+click reference to play on a second screen / through speakers while recording. |
| `pnpm test:scripts` | Unit/integration tests for all of the above (must stay green). |

The acceptance gate logic lives in `scripts/lib/acceptance-gate.mjs` and is unit-tested,
so the bar itself is verifiable without hardware.

## Automated acceptance — metric gates

Run `pnpm baseline:real-source --gate` for each scenario (set the source/output via env).
Every gate below must pass; the gate is **hard-fail**, and a "native" preview that fetched
any image-poll route during the session fails on transport honesty.

| Gate | Threshold | Where measured |
|---|---|---|
| Final-file freeze segment | none > **100 ms** | analyzer (`freezedetect`) |
| Repeated-frame burst | none > **2** consecutive | analyzer (`framemd5`) |
| Startup resolution | first 2s decoded frames match target output; no preview-sized frame leak | startup analyzer |
| Frame count vs `duration × fps` | within **2%** | analyzer (`ffprobe`) |
| Recording duplicate/synthetic fed frames | **0** | `encoderBridgeRepeatedFrames` / `encoderBridgeSyntheticFrames` |
| Encoder speed | ≥ **0.98×** | diagnostics |
| Mic dropped frames | **0** | live diagnostics |
| Mic capture coverage | ≥ **95%** | live diagnostics |
| A/V duration skew | target 100 ms, hard-fail **150 ms** | analyzer |
| Lip-sync (flash+click) | median target 100 ms, hard-fail **150 ms** | `measure:av-sync` |
| Transport honesty | **0** image-poll requests during a "native" preview | `previewImagePollCounts` delta |
| Native preview backing | `cametal-layer` | `previewSurfaceBacking` |
| Encode backend | `hardware-videotoolbox` | diagnostics |
| Maintenance ffmpeg/ffprobe during capture | **0** | diagnostics |

### Scenarios (set via env, then `pnpm baseline:real-source --gate`)

```sh
# 1080p30 screen+camera+mic, 60s (default)
pnpm baseline:real-source --gate

# 1440p30
VIDEORC_BASELINE_WIDTH=2560 VIDEORC_BASELINE_HEIGHT=1440 VIDEORC_BASELINE_BITRATE_KBPS=8000 \
  pnpm baseline:real-source --gate

# 1080p60 (if the selected sources support it)
VIDEORC_BASELINE_FPS=60 pnpm baseline:real-source --gate

# 10-minute endurance at your normal preset
VIDEORC_BASELINE_RECORDING_MS=600000 VIDEORC_SMOKE_TIMEOUT_MS=900000 \
  pnpm baseline:real-source --gate
```

Stress variants (perform during the run, by hand): drag/resize the camera overlay; scroll
screen text quickly; move a window; move your hand quickly in front of the camera. Re-run
the gate afterward — the final file must still pass freeze/repeated-frame/pacing.

Lip-sync pass: play `--make-fixture` output on a second screen + through speakers (or clap
on camera), record 30–120 s, then `pnpm measure:av-sync <recording>`.

## Manual acceptance — OBS side-by-side

No metric replaces a human watching both. Open **OBS** and **Videorc** side by side with
the **same** camera, the **same** screen/window, and the **same** output FPS.

- [ ] **Preview sharpness** — screen text is as readable in Videorc preview as in OBS (the preview path badge reads **OBS-native**, not Fallback).
- [ ] **Preview hand latency** — move your hand quickly; Videorc preview keeps up with OBS, no rubber-banding.
- [ ] **Screen scroll smoothness** — scroll a long page; no stutter vs OBS.
- [ ] **Cursor freshness** — the cursor is current, not lagging.
- [ ] **Record 2 minutes** in each app with the same scene.
- [ ] **Final recording smoothness** — play both back; Videorc is as smooth as OBS, no micro-stutter or freezes.
- [ ] **Voice/mouth sync** — mouth and voice stay aligned for the full clip.
- [ ] **No voice gaps** — no dropouts or skips in the audio.

### Done gate

- [ ] All automated metric gates pass for 1080p30, 1440p30, (1080p60 if supported), and the 10-min endurance run.
- [ ] The startup-resolution report passes for every real-source recording; the first 2 seconds match the requested output resolution/layout.
- [ ] The lip-sync measurement is within target on a flash+click (or clap) recording.
- [ ] The manual OBS side-by-side checklist is fully checked — a normal user cannot tell Videorc preview motion/currentness apart from OBS, and the final recording is smooth and synced.
- [ ] The user's previous failure pattern (laggy/soft preview, glitchy/desynced recordings) no longer reproduces.

Record the outcome (pass/fail per scenario, the diagnostics/analyzer reports, and the
manual notes) in a dated acceptance note alongside this checklist.

> **Status:** the automated gates and tooling are implemented and unit-tested. The native
> Metal preview (Phase 2) and GPU compositor (Phase 3) are the remaining work that the
> "OBS-native" preview-path and sharpness checks above are designed to hold accountable;
> until they land, expect the preview-path badge to read **Fallback** or **Proof surface**
> and the transport/backing honesty gates to fail a native claim — which is the intended,
> honest behavior.
