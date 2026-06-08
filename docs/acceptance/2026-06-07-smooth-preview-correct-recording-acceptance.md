# 2026-06-07 Smooth Preview + Correct Recording Acceptance

Acceptance note for the preview/recording slices
(`docs/preview-recording-parity-slices.md`). The real goal is a **smooth live preview and a
correct recording** — OBS side-by-side parity is no longer the bar. Perceptual items are judged
**by eye on a moving clip**; the metrics below are guardrails, not the goal.

Slices 1–7 shipped to `main` with deterministic gates green. This note records what is already
covered automatically and the **operator real-camera pass** that closes the plan — only the
operator can sign that off.

**2026-06-08 status update:** Slice 2's adaptive VideoToolbox zero-copy default shipped in
`878d948` but was later reverted in `8afe2e4`. The current no-env encoder bridge default is
`RawYuv420p`, so this note is historical evidence for the preview/recording slice work, not a
claim that zero-copy is currently the default. Until the native 4K media-engine refactor
re-promotes the path, VideoToolbox zero-copy checks must be run explicitly with
`VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT=videotoolbox-h264-mpegts`.

## What shipped (slices 1–7)

| # | Change | Commit |
|---|---|---|
| 1 | Native CAMetalLayer preview confirmed as the macOS default | `6da97b4` |
| 2 | Adaptive hardware VideoToolbox zero-copy as the default encoder, later reverted by `8afe2e4` | `878d948` |
| 3 | "Preparing recording…" label + copyable preflight failure report | `6a10584` |
| 4 | Studio health badge + degraded "Preview may not match recording" | `5327533` |
| 5 | Developer-only synthetic diagnostic source (frame number + timecode) | `6668c2a` |
| 6 | Preview↔recording frame-parity check | `6e5493e` |
| 7 | Visual/timing parity fixtures | `e4d5c0b` |

## Automated evidence (agent-run, deterministic)

- `cargo test -p videorc-backend` — **469 pass** (incl. adaptive-encoder, preflight-report,
  and synthetic frame-number round-trip tests).
- `cargo clippy -p videorc-backend -- -D warnings` — clean.
- `pnpm typecheck` / `pnpm build` — clean (incl. the Studio health badge + dev synthetic toggle).
- `pnpm --filter @videorc/desktop test` — **40 pass** (incl. `studioHealth`).
- `pnpm test:scripts` — **130 pass** (incl. preview/recording parity + visual/timing fixtures).

These prove the *logic* (encoder selection safety, preflight reporting, parity/fixture math).
They do **not** prove on-device pixels or the VideoToolbox path under real load — that is the
operator pass below, by design.

## Operator real-camera pass (the closing gate)

Run on the Mac with a **real camera + screen + mic** and capture permissions granted.

### Automated metric gates

```sh
# 1080p30 current default baseline. As of 2026-06-08 this uses the raw-YUV fallback
# unless the encoder bridge output is explicitly overridden.
pnpm baseline:real-source --gate

# Opt-in VideoToolbox zero-copy proof for this historical slice.
VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT=videotoolbox-h264-mpegts \
  pnpm baseline:real-source --gate

# 1440p30
VIDEORC_BASELINE_WIDTH=2560 VIDEORC_BASELINE_HEIGHT=1440 VIDEORC_BASELINE_BITRATE_KBPS=8000 \
  pnpm baseline:real-source --gate

# 10-minute endurance
VIDEORC_BASELINE_RECORDING_MS=600000 VIDEORC_SMOKE_TIMEOUT_MS=900000 \
  pnpm baseline:real-source --gate
```

For the opt-in VideoToolbox proof, expect `encode backend = hardware-videotoolbox`,
`zero-copy > 0`, `raw/Metal copied = 0`, startup PASS, and final-file PASS. The current
no-env run is a raw-YUV fallback baseline and must not be treated as the final accepted
zero-copy path.

### By-eye checklist (judge on a moving clip)

- [ ] **Idle preview** — wave a hand fast; preview keeps up, no rubber-banding.
- [ ] **Recording preview** — start recording, repeat the hand wave; preview stays live.
- [ ] **Screen scroll** — scroll a long page while recording; preview stays current.
- [ ] **Preparing/preflight** — Start shows `Preparing recording…`; covering the lens (or
      unplugging the camera) blocks the start with **no file** and a copyable report in
      Diagnostics (slice 3).
- [ ] **Health badge** — Studio shows a health chip; `VIDEORC_METAL_COMPOSITOR=0 pnpm dev`
      flips it to **Degraded / Preview may not match recording** (slice 4).
- [ ] **Final file** — play back; smooth, no micro-stutter or freezes.
- [ ] **Layout move** — drag the camera overlay mid-recording; preview and recording change
      together; final file matches the preview (crop, mirror, color).
- [ ] **Mouth/voice sync** — clap once on camera; final mouth/hand/audio sync feels right
      (verify the −350 ms mic offset on your hardware).

### Optional: deterministic frame fixture (slice 5/7)

Enable the dev **Synthetic diagnostic source** toggle (Sources tab, dev build), record a short
clip, then extract frames and read the rendered frame numbers — the sequence should be
continuous (no drops/freezes) per `scripts/lib/visual-parity.mjs`.

## Result

- 1080p30: _pending operator run_
- 1440p30: _pending operator run_
- 10-min endurance: _pending operator run_
- By-eye pass: _pending operator_

Record the baseline report paths and by-eye notes here once run. The plan closes when the
by-eye pass holds on the real camera.
