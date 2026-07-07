# Plan 023: Fix record+stream A/V — slideshow recordings and stream audio skew

> **Executor instructions**: This is Diagnose-route work on the recording
> pipeline (recording-studio gates mandatory; typecheck/lint alone is NOT
> done). The evidence below is from the owner's real session — reproduce with
> the synthetic baseline BEFORE changing args, and lock every finding into the
> artifact analyzer so this class of regression can never ship silently again.
>
> **Drift check (run first)**: `git status --short --branch`; inspect
> `crates/videorc-backend/src/recording.rs` (split-output args, bridge video
> output selection) and `docs/live-video-freeze-incident-plan.md` if changed
> since `c8bf97f2` (2026-07-07).

## Status

- **Priority**: P0 — a livestreamer's local recording is unusable, and the
  stream's audio sync is audibly off (owner report + file evidence)
- **Effort**: L (narrow fix M; full LVF2–LVF4 L)
- **Depends on**: nothing external; by-eye needs a real Twitch stream
- **Category**: recording pipeline, streaming, A/V sync
- **Planned at**: commit `c8bf97f2`, 2026-07-07
- **Execution**: TODO

## Evidence (owner session 2026-07-07, 10:07)

File: `~/Movies/Videorc/Recordings/videorc-session-20260707-100712.mp4`
(4K record + Twitch stream, 52.4s; VOD at twitch.tv/orcdev looked smooth but
audio sync off; record-ONLY sessions are fine).

- Video: 469 frames / 52.4s = **~9 fps average** against a declared 30fps.
- PTS pathology: **353 inter-frame deltas of exactly 0.000s** (+22 of 1ms) —
  frames stacked on identical timestamps — separated by **68 gaps of ~0.73s**.
  Playback = a 0.73s slideshow with frame bursts.
- Audio: continuous and complete (2459 AAC frames = full duration). So the
  compositor and capture were healthy; the RECORDING LEG's timestamps are the
  casualty.

## Root cause (traced, three symptoms, one cause)

1. `default_encoder_bridge_video_output_for_outputs` (recording.rs ~4176):
   when `stream_enabled`, the encoder bridge output drops to **Annex-B** — a
   deliberate stopgap because "with MpegTs as the stream default the tee
   fan-out delivers no bytes to RTMP targets" (LVF2 note, live-video-freeze
   incident).
2. Raw Annex-B carries **no timestamps**, so
   `append_bridge_encoded_video_input_args` reads the FIFO with
   `-use_wallclock_as_timestamps 1` — PTS = whenever bytes reach ffmpeg's
   demuxer. FIFO/demux delivery is bursty (~0.73s chunks at this bitrate), so
   bursts share one wallclock stamp → duplicate PTS + gaps.
3. Record-only sessions use **MpegTs** (real 90kHz PTS from the bridge,
   `timing_to_90khz` in encoder_bridge.rs) → smooth. That is exactly the
   owner's observation: recording alone is fine, record+stream is broken.
4. Stream audio skew: audio inputs carry real device-clock timestamps while
   the video is stamped LATE (demux wallclock = capture time + FIFO/demux
   latency) → constant-ish audio-early offset on Twitch; on the recording the
   offset wobbles with the burst cadence, so "audio sync is not the same when
   I record vs when I livestream".
5. The designed fix already exists ON PAPER: LVF2–LVF4 in
   `docs/live-video-freeze-incident-plan.md` (split per-leg mux workers,
   per-leg audio FIFOs, shared video epoch, multi-child lifecycle) — written
   after the freeze incident, never executed. The "avoid 4K recording while
   streaming" operator mitigation was doing the job until the owner hit it.

## Slices

### L0 — Lock the evidence into the analyzer (regression gate first)

The artifact analyzer (dev-app smoke's recording checks) gains two
assertions, applied to every record+stream artifact:

1. **PTS sanity**: video PTS strictly increasing with no duplicate stamps and
   max inter-frame gap ≤ 3× the frame interval at the declared fps.
2. **Per-leg A/V skew**: measured skew ≤ 150ms (the existing 33–52ms passes;
   today's file fails catastrophically).

Run `pnpm baseline:stream:split-output-4k-record` to reproduce the owner's
shape synthetically — it must FAIL on these assertions before any fix lands,
then pass after.

**Done when**: the baseline reproduces the pathology and the new assertions
catch it; assertions green on record-only artifacts.

### L1 — Diagnose the MpegTs tee fan-out failure (the narrow fix attempt)

The Annex-B stopgap exists only because MpegTs → tee/FLV "delivered no
bytes". Root-cause THAT with the baseline harness: instrument the tee legs
(per-target byte counters already exist in stream diagnostics), then test the
ranked suspects one variable at a time —

1. mpegts demux buffering swallowing the head of the stream (`-fflags
   nobuffer -analyzeduration/-probesize` on the FIFO input);
2. missing in-band SPS/PPS/AUD when copying TS → FLV (bitstream filter
   `h264_mp4toannexb`/`dump_extra` needs, or `-tag:v`/AVCC conversion);
3. tee muxer option interplay (`onfail`, per-leg `f=flv` args, `-copyts`).

If one of these makes MpegTs flow to RTMP: flip
`default_encoder_bridge_video_output_for_outputs` to MpegTs for the split
shape, DELETE the wallclock stamping for it, and both legs get real encoder
PTS end-to-end — recording fixed, stream video/audio share one clock.

**Done when**: baseline PASSES L0 assertions with MpegTs on both legs AND
RTMP targets receive bytes (multistream smoke), or the failure is
root-caused as unfixable-in-one-process with the finding written down here.

### L2 — Execute LVF2–LVF4 if L1 dead-ends (the architectural fix)

The already-designed shape in `docs/live-video-freeze-incident-plan.md`:
separate recording-mux and stream-mux ffmpeg workers, per-leg audio FIFOs
fanned out from native capture with one shared `video_epoch`, and
`ActiveRecording` owning multiple children with the documented stop order.
Scope and gates live in that doc (LVF2/LVF3/LVF4 sections) — execute as
written, updating it where reality drifted.

**Done when**: LVF6's gate list passes; the L0 assertions pass on the split
baseline; local-recording failure no longer marks RTMP targets failed.

### L3 — Stream-leg audio sync proof

Whichever of L1/L2 lands: capture the stream leg in the baseline (local RTMP
sink already used by the multistream smoke), run the same skew measurement on
the FLV, and assert BOTH legs ≤ 150ms and within 50ms of EACH OTHER. The
microphone sync offset (`microphoneSyncOffsetMs`) must apply identically to
both legs.

**Done when**: per-leg skew numbers print in the baseline summary and the
assertions hold; a deliberate +500ms offset fixture moves BOTH legs equally.

### L4 — Truthful health while any degraded path remains

If any session shape still runs the wallclock path after L1/L2 (e.g. an env
override), the session must say so: reuse the LVF5 risk-classifier idea
narrowly — a health event ("Recording quality degraded while streaming")
fires when the recording leg's input FPS falls below 80% of target for 5s,
surfaced like the mic-silent warning (plan 021 F3). Never again a silent
9fps file.

**Done when**: forced-degraded baseline shows the health event mid-session;
healthy runs stay quiet.

### L5 — Gates + acceptance

- Per-slice: cargo suite + clippy + fmt, `pnpm test:scripts`, desktop tests.
- Close-out: `pnpm baseline:stream:split-output-4k-record`,
  `pnpm smoke:multistream`, `pnpm smoke:recording-studio`,
  `pnpm smoke:local-gates`.
- Owner by-eye: one real Twitch stream WITH 4K local recording — VOD audio
  sync, local file smooth at full fps, A/V aligned in both; then delete the
  "avoid 4K recording while streaming" mitigation from the incident doc.

## Non-negotiables

- No leg ever ships wallclock-stamped video PTS; encoder timestamps flow to
  every muxer or the shape refuses to start.
- The L0 analyzer assertions stay in the permanent gate set — this class of
  bug (fine in record-only, broken in record+stream) must be structurally
  unshippable.
- Local recording failure never fails the stream, and vice versa (LVF4 rule).

## Open decisions (kickoff)

1. If L1 succeeds quickly, still schedule LVF2–LVF4 later? (Recommended: yes
   — separate processes also isolate stalls; keep as follow-up plan, don't
   block this fix on it.)
2. Skew thresholds (150ms absolute / 50ms inter-leg) — tighten after the
   first measured baseline if the numbers support it.
