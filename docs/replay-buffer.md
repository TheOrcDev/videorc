# Replay buffer

Plan 181. Videorc keeps the last N seconds of the program ready, and one
key saves them as a replay. The words are the glossary's (`CONTEXT.md`):
**Replay buffer** is the feature and its switch, **Save replay** the
action, a **replay** the saved file. A replay is never a "clip": a clip is a
clip mark.

## What the user sees

- **Studio**: a row right under Record and Go Live…: the switch, the ring's
  state ("0:12 / 0:30", "Starting…", "Starts after this session", "Off"),
  and **Save replay** with its key once the ring holds frames. While the key
  is unbound the row offers "Set shortcut" (Settings → Shortcuts). The
  switch has no other home.
- **Output**: the settings. Length (15 s, 30 s, 1 min, 2 min, 5 min; 30 s
  by default), "Turn on when Videorc opens" (off by default: arming is
  explicit, because the screen and microphone are being written to disk
  while it is on), the disk use at the current recording quality, the Save
  replay shortcut recorder, and where replays go.
- **Status bar**: "Replay · 0:30" with a neutral dot while the ring holds
  frames. A buffer-only session never reads "Recording" or "On air": the
  session words stay at Ready, and Record and Go Live stay available.
- **Save replay** from the Studio button, the global key (unbound by
  default so a game's keys are never stolen), ⌘K, a Stream Deck or phone
  intent (`replaySave`), and, with recording off, a clip mark (the button,
  its key, or the voice "clip that"). The toast says "Replay saved · Last
  0:30" with Show in Finder; a still-filling ring says so ("Last 0:12, the
  buffer was still filling").
- **Replays** go to `<recordings folder>/Replays/Replay YYYY-MM-DD HH-MM-SS.mp4`
  and get a Library row titled "Replay" (so Reveal and Play work).

The buffer is free: it is fully local, and recording is free.

## How it works

The ring is **one more output on the session's FFmpeg child**, never a
second encoder or a second capture:

- A session with `replay: { seconds }` adds a `-f segment` MPEG-TS output
  beside its file and stream outputs: `-segment_time 2` on the 2 s keyframe
  cadence every encoder keeps, a `+live` CSV list of the newest
  `ceil(N/2) + 2` complete segments, AAC audio at 192 kbps with the same
  mix the file gets.
  - Behind the encoded bridges (VideoToolbox on macOS, Media Foundation on
    Windows) the ring is a stream copy of the encode the file gets.
  - On the raw paths (Linux VAAPI and OpenH264, the Windows software
    fallback) and the legacy all-in-FFmpeg path (4K60) the graph is split
    and the ring is a second encode of the same frames. That costs a second
    encoder while a recording or stream runs with the buffer on.
- **Buffer-only** (the switch on, nothing else running): the session has no
  file and no stream targets. It composes exactly like a record-only
  session (the same bridge, encoder posture and overlay plan), creates no
  Library row, remembers nothing, and reports `replayOnly` on
  `recording.status`. The Studio keeps its live controls on it (mute,
  system audio, layout, sources all reach the ring), while every surface
  that would say "Recording" treats it as idle and main treats it as idle
  for quit, update and permission restarts.
- **Riding a session** (Phase B, S7): Record or Go Live while the switch is
  on hands over inside `session.start`: the backend stops the buffer-only
  session (bounded, nothing to finalize), waits for its microphone to
  release, and starts the real session with the ring attached. The ring
  restarts at that boundary, so the first N seconds of a session hold less.
  When the session ends, the renderer re-arms a buffer-only session.
  Arming during a session attaches at the next start.
- **Save replay** answers at once; the save runs on its own task: it waits
  for the segment that holds the press to close (4 s at most), hard-links
  the newest segments that cover N seconds into a staging folder, concat
  stream-copies them into a `.partial` MP4 with faststart, probes H.264 +
  AAC and the length (N to N + 2.5 s, keyframe-aligned at the start, D3),
  renames it, inserts the Library row and emits `replay.saved`. Any
  failure removes the staging and the partial and emits
  `replay.saveFailed` with a stable reason. A press during a save queues
  one more; a third press joins the queued one.
- **Lifecycle**: the ring lives under the backend's app data beside the
  database (`replay-buffer/<session>`, mode 0700). Arming is refused under
  `4 × N × bitrate` of free space. A task prunes it once a second to the
  list; the ring never holds more than `ceil(N/2) + 3` segment files. It is
  deleted when the session ends, when the app quits, and swept at the next
  launch after a crash.

### Wire

- `session.start` takes `replay?: { seconds }` (5 to 600).
- `recording.status` carries `replayOnly: true` on a buffer-only session.
- `replay.state` (`off | starting | on | error`, `seconds`,
  `bufferedSeconds`, `replayOnly`, `reason`, `segmentFiles`) is emitted on
  every change and once a second while on; `replay.status` answers it.
- `replay.save` → `{ saveId, sessionId, queued }`; then `replay.saved` or
  `replay.saveFailed`. Refusals: `replay-off`, `replay-starting`.
- `clip.mark` with recording off and the ring on answers
  `reason: "replay-saved"` and emits no `clip.marked`.

## Cost

- Disk: about `(ceil(N/2) + 3) × 2 s × (bitrate + 192 kbps)`: 120 MB for
  30 s at 8 Mbps, however long the buffer runs. The Output page shows the
  number.
- CPU and GPU: behind the encoded bridges, the muxer work of one more
  output (a copy). On the raw and legacy paths, a second encode while a
  session runs with the buffer on.
- A save: one short FFmpeg concat (stream copy) and one ffprobe, serialized.

## Platform notes

- **macOS** is the proven platform: the smokes below ran here.
- **Windows**: the same FFmpeg muxing path; the package preflight refuses a
  bundled FFmpeg without the `segment` muxer, the `concat` demuxer or
  `aac_adtstoasc`. Exclusive-fullscreen games may capture black through
  DXGI duplication: recommend borderless windowed. Game audio needs System
  audio on in Sources.
- **Linux**: the same path on the raw encoders (a second encode while a
  session runs with the buffer on); the fetch and release validators
  refuse a build without the three components. Runtime is unproven: the
  named Linux box has not run the replay smoke.

## Proof

- `cargo test -p videorc-backend replay`: the pure ring logic, the ring on
  every FFmpeg arg builder (buffer-only and ride-along, copy and split),
  the registry, pruning, and the real-FFmpeg save test (ignored; run with
  `--include-ignored` and `VIDEORC_BUNDLED_FFMPEG_PATH`).
- `pnpm smoke:replay-buffer`: the real dev app arms the ring, holds the
  disk bound over 3 × N, saves from the Studio button, a remote intent and
  a clip mark, records while armed (the handover, the ride-along, a save
  mid-recording, the recording's own gates, the re-arm), and turns it off.
  Every replay passes ffprobe and the recording analyzer (H.264 + AAC, the
  length window, no audio gap, the 2 s keyframe cadence, BT.709 tags) and
  has its Library row.
- `VIDEORC_SMOKE_REPLAY_SECONDS=15 pnpm smoke:multistream`: the ring rides a
  record + stream session to local RTMP listeners; a replay saves
  mid-stream and the stream legs and the recording stay unchanged.
- `pnpm smoke:record-latency:gate --replay-buffer`: every Record hands over
  from a buffer-only session; the budgets hold or the report says by how
  much they do not.
- `pnpm smoke:remote-control`: `replaySave` admission, relay and refusal.

The dev binary has no microphone or Screen Recording grant, so the smokes'
audio is the session's silent bus: they prove the AAC stream's continuity
and the stop tail, not an audible offset. The ring copies the packets the
recording gets, on the same clock; the real-game acceptance checks the
offset by ear.
