# Clips: the replay buffer

Plan 181, as the owner redesigned it after trying the first build (R1–R4,
2026-10-12). Videorc keeps the last N seconds of the program whenever it is
open, and one action saves them as a **clip**. The words are the glossary's
(`CONTEXT.md`): a clip is the saved video, **Clip** / **Save clip** the one
action, **Clips** the Output section and its one switch ("Keep the last
seconds"). Code keeps the older names (`replay.*` RPCs, `replay_buffer.rs`,
`RecordingStatus.replayOnly`); copy never says "replay".

## What the user sees

- **Nothing in the Studio.** The ring is not a session the streamer starts;
  it runs by default whenever Videorc is open (R2). Record and Go Live…
  stand alone under the status pill.
- **Status bar**: "Clip · 0:30" with a neutral dot while the ring holds
  frames (what a press saves right now), "Clips starting…" while it fills.
  This is the one place that shows the ring is on. A buffer-only session
  never reads "Recording" or "On air": the session words stay at Ready, and
  Record and Go Live stay available.
- **Output → Clips**: the settings and the one switch. **Keep the last
  seconds** (on by default; off, a clip can only be marked while recording),
  **Length** (15 s, 30 s, 1 min, 2 min, 5 min; 30 s by default, R1), the
  disk use at the current recording quality, the **Save a clip** shortcut
  recorder (unbound by default so a game's keys are never stolen), and
  where clips go. On a computer that encodes on its processor the switch
  shows off and the row says why (the guard below); turning it on there is
  the user's call and runs.
- **One action** (R4): the Stream Manager's **Clip** button (where Mark clip
  used to be, with the key in its hint), the `clipMark` global shortcut, ⌘K
  **Save clip**, a Stream Deck or phone `clipMark` intent, `/clip` in the
  Stream Manager's own composer, and the spoken "clip that" / "Buddy, clip
  that". Whenever the ring holds frames the press saves the last N seconds;
  while a recording runs the moment is also kept as a mark in the recording,
  for the report. With the ring off and nothing recording the press says
  which switch to turn on.
- **Toasts**: "Clip saved · Last 0:30" with Show in Finder (a still-filling
  ring says "Last 0:12, the buffer was still filling"); the Stream Manager's
  own press says "Saving the last 30 seconds as a clip" and, while
  recording, that the moment is marked too.
- **Clips** go to `<recordings folder>/Clips/Clip YYYY-MM-DD HH-MM-SS.mp4`
  and get a Library row titled "Clip" (so Reveal and Play work).

The buffer is free: it is fully local, and recording is free.

### When voice works

"Clip that" (and "clip it", "clip this", "that's a clip", "make a clip",
with or without the wake word in front) is heard by the transcript the
session already produces: live captions, or Buddy listening. So the spoken
clip works **while a recording or livestream runs with captions on or Buddy
listening on**, exactly where "clip that" marked a clip before. The idle
ring starts no transcription of its own: nothing paid runs because the
buffer does, so with Videorc open and no session the clip is the button,
the key, ⌘K, a deck key or `/clip`.

## How it works

The ring is **one more output on the session's FFmpeg child**, never a
second capture:

- A session with `replay: { seconds, auto? }` adds a `-f segment` MPEG-TS
  output beside its file and stream outputs: `-segment_time 2` on the 2 s
  keyframe cadence every encoder keeps, a `+live` CSV list of the newest
  `ceil(N/2) + 2` complete segments, AAC audio at 192 kbps with the same
  mix the file gets.
  - Behind the encoded bridges (VideoToolbox on macOS, Media Foundation on
    Windows) the ring is a stream copy of the encode the file gets.
  - On the raw paths (Linux VAAPI and OpenH264, the Windows software
    fallback) and the legacy all-in-FFmpeg path (4K60) the graph is split
    and the ring is a second encode of the same frames.
- **Buffer-only** (nothing else running): the renderer starts a session
  with no file and no stream targets as soon as the backend is up, and
  again after every session ends (the reconcile decision in
  `lib/replay-buffer-reconcile.ts`). It composes exactly like a record-only
  session (the same bridge, encoder posture and overlay plan), creates no
  Library row, remembers nothing, and reports `replayOnly` on
  `recording.status`. The Studio keeps its live controls on it (mute,
  system audio, layout, sources all reach the ring), while every surface
  that would say "Recording" treats it as idle (⌘K, the Stream Manager, the
  voice marker, the "Recording saved" toast) and main treats it as idle for
  quit, update and permission restarts.
- **The guard**: a buffer-only start the user never asked for carries
  `auto: true`. After the session's encoder decision and before anything is
  spawned, the backend refuses it with `replay-software-encoder` when that
  encoder is OpenH264, a software Media Foundation encoder or x264: the
  ring on a raw CPU encode would be a second encode on a computer that
  already struggles with one. The renderer then keeps the switch off, does
  not retry, shows the reason on the Output page, and attaches no ring to
  Record or Go Live. Turning the switch on persists `explicit: true`, the
  next start omits `auto`, and it runs. The free-space refusal
  (`4 × N × bitrate`) stays for every start.
- **Riding a session** (S7): Record or Go Live while the ring runs hands
  over inside `session.start`: the backend stops the buffer-only session
  (bounded, nothing to finalize), waits for its microphone to release, and
  starts the real session with the ring attached. The ring restarts at that
  boundary, so the first N seconds of a session hold less. When the session
  ends, the renderer re-arms a buffer-only session.
- **Clip** (`clip.mark`): whenever the ring holds frames the backend asks it
  to save (the save answers at once and runs on its own task: it waits for
  the segment that holds the press to close, 4 s at most, hard-links the
  newest segments that cover N seconds into a staging folder, concat
  stream-copies them into a `.partial` MP4 with faststart, probes H.264 +
  AAC and the length (N to N + 2.5 s, keyframe-aligned at the start),
  renames it, inserts the Library row and emits `replay.saved`); while a
  recording runs it also stores the mark. The reply says `reason:
  "clip-saved"` and `saved` (the mark); no `clip.marked` event follows, so
  each window shows one toast. With the ring off the old behaviour stands:
  a mark while recording, else `recording-off`. Any save failure removes
  the staging and the partial and emits `replay.saveFailed` with a stable
  reason. A press during a save queues one more; a third joins the queued
  one.
- **Lifecycle**: the ring lives under the backend's app data beside the
  database (`replay-buffer/<session>`, mode 0700). A task prunes it once a
  second to the list; the ring never holds more than `ceil(N/2) + 3`
  segment files. It is deleted when the session ends, when the app quits,
  and swept at the next launch after a crash.

### Wire

- `session.start` takes `replay?: { seconds, auto? }` (5 to 600 s; `auto`
  only on a default start). Refusal: `replay-software-encoder`.
- `recording.status` carries `replayOnly: true` on a buffer-only session.
- `replay.state` (`off | starting | on | error`, `seconds`,
  `bufferedSeconds`, `replayOnly`, `reason`, `segmentFiles`) is emitted on
  every change and once a second while on; `replay.status` answers it.
- `clip.mark` → `{ saved, reason? }`: `reason: "clip-saved"` when the ring
  took the press (then `replay.saved` or `replay.saveFailed` follows),
  `recording-off` when nothing kept it.
- `replay.save` → `{ saveId, sessionId, queued }` is the save alone
  (internal; `clip.mark` is the product's action).
- The remote intent is `clipMark`; `replaySave` is gone.
- The Stream Manager learns the ring's state through the marker context
  (`clip: { available, seconds, shortcutLabel, reason }`) the main window
  pushes.

## Cost

- Disk: about `(ceil(N/2) + 3) × 2 s × (bitrate + 192 kbps)`: 28 MB for
  30 s at 6 Mbps, however long the ring runs. The Output page shows the
  number.
- CPU and GPU: with the ring on by default, a buffer-only session runs
  whenever Videorc is open: the compositor, the hardware encoder and one
  FFmpeg child muxing segments. The plan's As built records the idle cost
  measured on the owner's Mac (ring on against ring off). Behind the
  encoded bridges a session with the ring pays the muxer work of one more
  output (a copy); on the raw paths a second encode, which is why the
  guard keeps the default off there.
- A clip: one short FFmpeg concat (stream copy) and one ffprobe, serialized.

## Platform notes

- **macOS** is the proven platform: the smokes below ran here.
- **Windows**: the same FFmpeg muxing path; the package preflight refuses a
  bundled FFmpeg without the `segment` muxer, the `concat` demuxer or
  `aac_adtstoasc`. A weak PC on the OpenH264 or software Media Foundation
  path keeps the default off (the guard). Exclusive-fullscreen games may
  capture black through DXGI duplication: recommend borderless windowed.
  Game audio needs System audio on in Sources.
- **Linux**: the same path on the raw encoders (VAAPI runs the default;
  OpenH264 keeps it off); the fetch and release validators refuse a build
  without the three components. Runtime is unproven: the named Linux box
  has not run the clip smoke.

## Proof

- `cargo test -p videorc-backend replay` and `… clip_marks`: the pure ring
  logic, the ring on every FFmpeg arg builder (buffer-only and ride-along,
  copy and split), the registry, pruning, the clip routing (ring alone,
  ring plus mark, ring off) and the real-FFmpeg save test (ignored; run
  with `--include-ignored` and `VIDEORC_BUNDLED_FFMPEG_PATH`).
- `pnpm smoke:replay-buffer`: the real dev app arms the ring by itself at
  launch, turns the switch off and on, holds the disk bound over 3 × N,
  saves a clip through `clip.mark` and through a remote `clipMark`, records
  while armed (the handover, the ride-along, one press mid-recording that
  saves a clip and keeps the mark, the recording's own gates, the re-arm),
  and turns it off. Every clip passes ffprobe and the recording analyzer
  (H.264 + AAC, the length window, no audio gap, the 2 s keyframe cadence,
  BT.709 tags) and has its Library row titled Clip.
- `VIDEORC_SMOKE_REPLAY_SECONDS=15 pnpm smoke:multistream`: the ring rides a
  record + stream session to local RTMP listeners; a clip saves mid-stream
  and the stream legs and the recording stay unchanged.
- `pnpm smoke:record-latency:gate`: with the ring on by default every
  Record hands over from a buffer-only session; `--no-replay-buffer` is the
  bare baseline. The budgets hold or the report says by how much they do
  not.
- `pnpm smoke:remote-control`: `clipMark` admitted with the ring on, refused
  with its reason once the switch is off.
- The whole smoke bundle (`pnpm smoke:recording-studio`, the matrix, the
  preview probes) now launches with the ring running; the plan's As built
  lists what that changed.

The dev binary has no microphone or Screen Recording grant, so the smokes'
audio is the session's silent bus: they prove the AAC stream's continuity
and the stop tail, not an audible offset. The ring copies the packets the
recording gets, on the same clock; the real-game acceptance checks the
offset by ear.
