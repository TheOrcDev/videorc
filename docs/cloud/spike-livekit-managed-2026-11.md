# Phase 0: LiveKit managed media (2026-11-13)

Plan 234, Phase 0. Throwaway: nothing here ships. The question is whether
Videorc Cloud can run on LiveKit Cloud's managed Ingress and Egress with
Neon for storage, measured before anything is built.

Everything ran against the production LiveKit project (empty, no users,
every room named `p234-…`), one Neon spike branch, and one Mac. The dev app
was not run. An FFmpeg push shaped like the desktop's stream leg stood in
for it, an x264 re-encode stood in for the node path, and a LiveKit RTMP
ingress in a second room stood in for a platform. Nothing was sent to a
real platform, and every stream key was made up.

**The project holds two ingress objects.** Creating a third answered
`resource_exhausted: total ingress object limit exceeded, delete an
existing ingress first`, which matches LiveKit's published limits for its
free Build plan (2 ingresses, 2 egresses). Cloud runs stopped there once.
The runs that were owed were then done in a second session with at most two
ingress objects each: S0.3 in an adapted form, S0.6 on Cloud, more samples
for S0.2, and the silent-feed limit. What is still not run is at the end.

## Verdict

Four kill questions first.

| Slice | Question | Result | Verdict |
| --- | --- | --- | --- |
| S0.1 | Picture quality at 1080p30, within 3 VMAF points of the node path | As the plan wrote it (the matching egress preset): 8.6 and 8.9 under. With two settings changed (below): 2.2 to 3.0 under, four runs; 2.7 and 2.8 under with keyframes matched to the node path's | **Fails as planned. Passes narrowly with both levers** |
| S0.1 | 1080p60, at most 1 frame in 100 dropped or repeated | 1.3 and 2.0 per 100 over a whole run; 0.6 and 1.0 once the first seconds are past | **Fails. D12's 1080p30 cap stands** |
| S0.2 | Card within 3 s of the picture stopping | 2.72 to 2.87 s, seven holds on Cloud | Pass |
| S0.2 | Picture back within 5 s of a re-push | 4.80, 4.97 and 6.17 s; 3.5 to 4.8 s of each is the ingress restarting | **At the bar: two of three inside it** |
| S0.2 | Destinations stay connected through a hold | The sink's stream stayed active with no retry; the egress output has no timestamp gap | Pass on what could be measured; the 100 ms receiver bar could not be measured |
| S0.2 | The room outlives the feed for `departure_timeout`, then ends the egress | 124 s at a 120 s timeout and 307 s at 300 s, egress `COMPLETE`, recording finalised | Pass at 120 and 300 s; 30 and 60 minutes not run |
| S0.4 | Only the redacted key anywhere we can see | True for all six platform shapes. Four custom shapes leak (below) | **Pass, if the web refuses those shapes**; written answer owed |
| S0.5 | Segments land on a Neon show branch, and the remux plays | 20 recordings, no segment missing, every remux decodes; a write-only credential works | **Pass**; the 3 h 10 min run is not run |
| S0.3 | Destinations: add, remove, kill one, kill the last, 16 URLs | Adapted to two sinks. Add 1.5 s, remove 1.6 s. A killed destination is retried 23 times and marked failed after 31 s; the other carried on. 17 entries accepted. **With its last destination killed the egress did not fail**, twice | Pass for add, remove and kill-one. **The plan's assumption about the last output is wrong** |
| S0.6 | The talk-show page | Local: every probe passes. Cloud: room metadata and the host's byte stream reach LiveKit's recorder; all four layouts are right. Lip sync 113 ms (100 without the limiter), bar 80 | Pass, **except lip sync: fails as measured**, with a synthetic guest; cause not separated |
| S0.7 | The meter | Ledger written to the private file | Done |
| S0.8 | Go Live to on air | About 5 to 7 s after the feed starts. 3.1 s from `StartEgress` to a destination's first frame when the feed is already in the room | Measured; slower than today's 5 s |
| S0.9 | A WHIP feed with no ingress transcode | Works with FFmpeg 8.1.1. Same quality as the tuned RTMP path, far less even frame delivery | No-go as tested; worth a later look |

What changes the picture, in order of weight:

1. **The plan's settings fail the quality bar; two changes bring it to the
   bar.** The ingress layer at 12 Mbps (not 8), and the egress on advanced
   options at the node path's own settings (H.264 High, 6 Mbps), not the
   preset (Main, 4.4 Mbps measured).
2. **The program page costs frames however it is written.** Rendering in a
   browser and capturing the screen drops and repeats about 1.3 frames in
   100 at 30 fps at best (LiveKit's own template: 1.4). The node path
   drops none. Recording the 30 fps feed at 60 fps cuts the frames that
   never reach the stream from 3.0 to 0.7 in 100 (one run).
3. **The project holds two ingress objects.** One solo show with both
   orientations uses both.
4. **`roomRecord` is project-wide**, as the plan assumed, and a few URL
   shapes leak the key through LiveKit's redaction.
5. **An egress whose only destination dies does not fail.** It stays
   active and reports that stream as active with `retries: 1`. A show with
   one destination gets no failure to act on.
6. **Lip sync is not settled for talk shows.** The recording put the sound
   100 to 113 ms behind the picture with a synthetic guest. The solo chain
   measured 36 ms.

## What was built (all in the spike's scratch directory)

| Piece | What it is |
| --- | --- |
| `pages/solo.html` | The solo program page: the feed full-frame, `START_RECORDING` on the first decoded frame, the hold (1.5 s, 1 s freeze, 300 ms fade, back after 1 s of steady frames), a debug mode that draws the page's state and its event order into the picture |
| `pages/talk.html` | The talk-show program page: tiles from `protocol-fixtures/talk-show-layout.json`, stage state from room metadata, an overlay as a byte stream from the host only, a look-ahead limiter |
| `pages/pub.html`, `pages/watch.html` | A stand-in host or guest (a colour, a tone, a screen share, a flash with a beep) and a subscriber that reports frame gaps |
| `local-solo.mjs`, `local-talk.mjs` | The two pages against `livekit-server --dev` in headless Chrome, driven over the DevTools protocol (`cdp.mjs`) |
| `chain.mjs`, `hold.mjs`, `dest2.mjs`, `stall.mjs`, `talk-cloud.mjs` | The Cloud runs: the whole chain, the hold and the return, destinations with two sinks, the silent-connection limit, the talk show. `dest.mjs`, the three-sink version, has not run |
| `rtmp-proxy.mjs`, `whip-relay.mjs` | Local relays. FFmpeg pushes to localhost with a placeholder; the relay adds the real key inside TLS, so no key is ever on a command line. The RTMP one can also stall or cut the connection |
| `barcode.mjs`, `analyze.mjs`, `frames60.mjs`, `timeline.mjs`, `lipsync.mjs` | A frame counter a machine can read after three encodes, VMAF with every frame paired by that counter, frames counted per source frame, the hold and the return read from a recording, lip sync from a flash and a beep |
| `neon.mjs`, `lib.mjs` | The Neon spike branch and the LiveKit clients, the ledger, and clean-up |

## Setup

- Apple M4, 32 GB, macOS 26.5. Other sessions were compiling Rust all day:
  load average 7 to 86, swap nearly full. Every run records the load. Local
  real-time readings taken above a load of about 30 are marked as
  unreliable; everything a verdict rests on is read from the recorded
  output. The second session ran at a load of 4 to 9.
- LiveKit: server SDK 2.19.2, `livekit-client` 2.23.0, CLI 2.19.0, and
  `livekit-server` 1.13.10 for the local tests. FFmpeg 8.1.1 (Homebrew),
  Chrome 157.
- **The feed (for the dev app):** H.264 High from VideoToolbox,
  `-b:v 6M -maxrate 6M -bufsize 12M`, keyframes every 2 s, no B-frames,
  AAC 160 kbps at 48 kHz, FLV. It averages 4.2 Mbps at 30 fps and 6.2 at
  60. Encoded once, then pushed with `-re -c copy`.
- **The node path (the baseline):** that feed through x264 `veryfast`,
  High, CBR 6 Mbps, 2 s GOP.
- **Two clips,** 84 s each. Clip A: an 800 px/s pan over a detailed still,
  a moving inset, temporal grain. Clip B: the same without grain. Both are
  hard: the feed itself scores 72 (A) and 77 (B) against its source at
  30 fps, and 40 at 60 fps. Absolute scores are low for everything; the
  bar is a difference, and it is measured on the same frames.
- **VMAF:** model v0.6.1, about 400 frame pairs a run. Every output frame
  is paired with the source frame named by a barcode burned into the
  picture, so a dropped or repeated frame cannot shift the comparison.
- **Frames:** the same barcode, read from every output frame. A repeat is
  an output frame that shows the previous source frame again; a drop is a
  source frame that never appears.
- **The hold:** read from the recording. The page's debug mode draws a
  64 px block whose colour is its state.
- **A destination:** a LiveKit RTMP ingress in a second `p234-` room.
- **Storage:** one Neon branch from the empty parent, a `public_read`
  bucket for the pages and a private one for segments.

## S0.1 Picture quality and frame rate

### 1080p30

Managed means feed → RTMPS ingress → room → the program page in LiveKit's
recorder → egress → segments. "Diff" is managed minus node path. Frames are
per 100, after the first 5 s.

| Clip | Ingress layer | Egress | Output | Feed | Node | Managed | Diff | Dropped / repeated |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| A | 1080p, 8 Mbps | preset | Main 4.4 Mbps | 72.7 | 69.9 | 61.4 | −8.6 | 7.1 / 7.1 ¹ |
| B | 1080p, 8 Mbps | preset | Main 4.3 Mbps | 77.4 | 74.1 | 65.2 | −8.9 | 7.9 / 7.9 ¹ |
| A | 1080p, 8 Mbps | High 6 Mbps | High 5.7 Mbps | 72.4 | 69.6 | 65.0 | −4.6 | 2.0 / 2.0 ¹ |
| B | 1080p, 8 Mbps | High 6 Mbps | High 5.8 Mbps | 77.2 | 73.9 | 68.2 | −5.7 | 9.4 / 9.4 ¹ |
| B | 1080p, 8 Mbps | High 6 Mbps | High 5.8 Mbps | | 73.7 | 69.2 | −4.5 | 2.7 / 2.7 ² |
| B | 1080p, 12 Mbps | High 6 Mbps | High 5.8 Mbps | | 73.9 | 71.4 | **−2.5** | 4.7 / 4.7 ² |
| B | 1080p, 12 Mbps | High 6 Mbps | High 5.8 Mbps | | 73.9 | 71.7 | **−2.2** | 4.7 / 4.7 ² |
| A | 1080p, 12 Mbps | High 6 Mbps | High 5.9 Mbps | | 70.1 | 67.1 | **−3.0** | 4.8 / 4.8 ² |
| A | 1080p, 12 Mbps | High 6 Mbps | High 5.8 Mbps | | 70.1 | 67.5 | **−2.6** | 4.3 / 4.3 ² |
| B | WHIP, no transcode | High 6 Mbps | High 5.7 Mbps | | 73.9 | 71.6 | −2.3 | 13.6 / 12.2 ² |
| B | 1080p, 12 Mbps | High 6 Mbps, 2 s keyframes | High 5.6 Mbps | | 73.7 | 71.0 | **−2.7** | 3.0 / 3.0 ³ |
| A | 1080p, 12 Mbps | High 6 Mbps, 2 s keyframes | High 5.8 Mbps | | 69.8 | 67.0 | **−2.8** | 4.2 / 4.2 ³ |
| B | 1080p, 12 Mbps | High 6 Mbps, 2 s keyframes, recorded at 60 fps | High 5.8 Mbps | | 73.5 | 70.9 | **−2.6** | 0.7 never shown ³ |

¹ The page piped frames through a processor and a generator. ² The page
copied the picture to a canvas every 100 ms. Both cost frames; see "What
the program page must do". ³ The final page, 2 s segments, load 5 to 10;
run by the orchestrator after the note was first written.

- **The egress preset is the larger loss.** `H264_1080P_30` encodes Main
  profile at 4.4 Mbps with 44.1 kHz audio. Advanced options at the node
  path's settings give High at 5.8 Mbps and 48 kHz audio, and 3 to 4
  points.
- **The ingress layer's bitrate is the other lever.** 8 → 12 Mbps is worth
  about 2 points. At 12 Mbps the ingress transcode costs almost nothing:
  a WHIP feed with no transcode at all scores the same.
- What is left, about 2.4 points, is the browser-and-egress generation.
  No setting found here removes it.
- **Keyframes.** The first runs have a keyframe every 4 s, the segment
  length, though 2 s was asked; the node path has 2 s. That favoured the
  managed encode. With 2 s segments the output has 2 s keyframes, and the
  difference is 2.7 (B) and 2.8 (A): about 0.3 worse than at 4 s, and
  still inside the bar. A stream-only egress, which is what a solo show
  uses, was not inspected.
- Limits met while looking for levers: `H264_HIGH` as the ingress layer's
  codec is refused ("invalid video parameters: video codec unsupported").
  A 16 Mbps layer is accepted by `CreateIngress`, then the ingress never
  starts: the RTMP publish goes unanswered and no error is reported.

### Frames at 30 fps

| Page | Dropped / repeated per 100 |
| --- | --- |
| Frames piped through a processor and generator | 2.0 to 9.4 |
| A canvas copy of the picture every 100 ms | 2.7 to 4.8 (six runs) |
| A canvas copy every 200 ms | 0.9 (one run) |
| No copy at all | 1.3 (one run) |
| LiveKit's own default template | 1.4 (one run) |

- Drops and repeats come in pairs and in bursts of a few seconds, the
  pattern of two clocks at nearly the same rate drifting past each other:
  the feed's frames and the recorder's capture.
- Every run also loses about four frames a second for its first 5 to 10 s.
- The upload from this Mac never paused for more than 180 ms in any run, so
  the pushes were not starved.

### A 30 fps feed recorded at 60 fps

One run: clip B, the final page, the egress's frame rate set to 60. Each
source frame should then fill two output frames. Counted per source frame,
after the first 6 s, against the 30 fps run beside it in the table.

| Per 100 source frames | Recorded at 30 fps | Recorded at 60 fps |
| --- | ---: | ---: |
| Never reach the stream | 3.0 | **0.7** |
| Held on screen for 67 ms or longer | 2.8 | 0.5 |
| Shown 17 ms short or long | none (a frame is 33 ms) | 10.7 |
| Shown for exactly their 33 ms | 94.2 | 88.1 |

- At 60 fps the recorder's clock slips by half a source frame at a time,
  so most slips show as 17 ms of unevenness, not as a lost or doubled
  frame.
- VMAF is unchanged: 2.6 under the node path.
- The output is a 1080p60 stream at 6 Mbps that carries a 30 fps picture.
  How a platform treats that against a 1080p30 stream was not looked at.
- One run. A second sample is owed.

### 1080p60

Two runs, clip A, without the frame pipe.

| Run | Whole run | After the first 5 s |
| --- | --- | --- |
| First (copy every 200 ms, preset) | 0.69 dropped + 0.62 repeated | 0.32 + 0.30 |
| Second (copy every 500 ms, ingress 12 Mbps, High 6 Mbps) | 0.88 + 1.07 | 0.50 + 0.53 |

Against "no more than 1 in 100 dropped or repeated": 1.3 and 2.0 over the
whole run, 0.6 and 1.0 in steady state. It fails as written and sits at the
bar otherwise. D12's cap stands.

Quality at 60 fps was scored once, with the preset and the frame pipe: feed
39.6, node 33.1, managed 30.0. At 6 Mbps this clip is too hard at 60 fps
for the number to mean much.

## S0.2 The hold

### Locally (the page's own clock)

`livekit-server --dev`, headless Chrome, a CLI publisher as the feed.
7 cuts and 6 returns, load 11 to 24.

| Step | Design | Measured |
| --- | ---: | --- |
| Freeze after the last frame | 1500 ms | 1500 to 1517 ms |
| Freeze held | 1000 ms | 1000 to 1017 ms |
| Fade to the card | 300 ms | 300 to 316 ms |
| Card after the last frame | 2800 ms | 2817 to 2833 ms |
| Steady frames before the return | 1000 ms | 1000 to 1017 ms |
| Fade back | 300 ms | 300 to 316 ms |

- A 1.0 s pause changes nothing. A 2.0 s pause freezes and resumes with no
  card. Frames for 0.4 s while the card is up do not bring the picture
  back. `START_RECORDING` is logged once, never before the first frame.
  A closed room logs `END_RECORDING` within 139 ms.
- Both ways of losing the feed were cut: frames stop and the participant
  stays (SIGKILL), and a clean leave (SIGINT).

### On Cloud (read from the recording)

The first run: 247 s, an RTMP sink attached, `departure_timeout` 120 s,
recorded at 30 fps. Later: a run of two cuts and returns recorded at
60 fps, a run with a 300 s timeout, and a silent feed with no egress.

- **Card:** freeze marked at 1533 ms, fade at 2533 ms, card at 2833 ms
  after the last new frame, in both holds of the first run; 2800 and
  2867 ms in two shorter runs; 2717, 2783 and 2800 ms in the 60 fps run.
- **The chain is about 2.3 s behind the feed.** Measured from the cut on
  the wire, the card came 5.2 s later: viewers see 2.3 s more picture, then
  the 2.8 s freeze and fade.
- **Re-push on the same ingress, URL and key.** Accepted every time.

  | Sample | Load | First frame at the page | Picture fully back |
  | --- | --- | ---: | ---: |
  | First run, 13.8 s into the card | 35 to 52 | 4.84 s | **6.17 s** |
  | 60 fps run, first return | 5 to 7 | 3.48 s | **4.80 s** |
  | 60 fps run, second return | 5 to 7 | 3.65 s | **4.97 s** |

  Times are from the start of the push. The page's part is fixed at 1.3 s
  (1.0 s of steady frames, 0.3 s of fade); the rest is LiveKit's ingress
  restarting.
- **Timestamp continuity:** every one of 7,419 frame steps is 33.33 ms.
  None is over 50 ms, through both holds, the re-push and the wait. The
  60 fps run: 4,501 frames, every step 16.67 ms.
- **A cut and a dead network differ.** A closed connection is seen by the
  ingress in 1.3 s and the participant leaves. A network that goes silent
  with its sockets open kept the participant in the room for **100 s**
  (one run, ingress only). Then the ingress went to an error state
  ("source encoder not ready") and the participant left; LiveKit did not
  close the connection first. The page's hold does not depend on it: the
  card came at 2833 ms either way. But `departure_timeout` only starts
  counting once the participant is gone.
- **The room.** With only the recorder left, the egress ended `COMPLETE`
  ("End reason: Source closed") 124.1 s after the feed's participant left
  at a 120 s timeout, and 306.7 s after at 300 s. Each recording was
  finalised with its end marker. The egress alone does not keep a room
  open.
- **The sink.** Its stream read active with no retry from start to the
  room's end; its ingress stayed PUBLISHING; its participant never left.
- **The watcher's gaps are not in the egress output.** A headless Chrome
  subscribed to the sink room, on this Mac at load 35 to 52, saw a largest
  gap of 300 ms while the picture moved (5 of 52 seconds over 100 ms) and
  of 2,067 ms while it was still. The worst gaps come 3 to 5 s after the
  picture turns into the card, twice. They are downstream of the RTMP
  output, inside the stand-in sink's own transcode and WebRTC leg or on
  this Mac. LiveKit has no live figure to settle it: a sink ingress's
  state read 60.0 fps and 0 kbps throughout, and its `updatedAt` never
  moved. The watcher overstates: in the S0.3 run, at a load of 7, it saw
  gaps over 100 ms in 4 of 42 seconds while a recording of the same sink
  room showed no freeze of 200 ms or more. A still picture through a sink
  was not measured again.

### Black frames at a clean end

- LiveKit's recorder gets a **stream of 2×2 black frames** when the feed's
  track ends, one per frame interval, while the track still reads live and
  unmuted. `mute` comes 137 ms later. A page that stretches the video shows
  a black screen until its script reacts: 5 frames at 60 fps in one run,
  and 2.5 s if it never reacts.
- When an RTMP feed **ended cleanly** at 60 fps, one run showed 233 ms of
  black, and its fade began 2.68 s after the last picture frame, not
  2.50 s. That timing says the page was given about 180 ms of full-size
  black frames, which it has to treat as picture. Inferred, not confirmed
  with the on-picture diagnostic. A cut with no clean end showed no black
  frame, in five holds.

## S0.3 Destinations

Adapted to the project's two ingress objects. The feed was a direct
publisher (the `lk` CLI, a 720p30 clip with the frame counter), so both
ingress objects could be RTMP sinks, A and B. The main egress was
stream-only on the solo page at 1080p60, High, 6 Mbps. A second egress
recorded sink A's room to segments, to see what A received. Load 7.

| Step | Result |
| --- | --- |
| Start with A, the feed already in the room | Egress active 3.0 s after `StartEgress`; A's stream started at 3.1 s by LiveKit's own timestamp; A publishing at 4.8 s. A second run: 3.2, 3.2 and 4.9 s |
| Add B live | B publishing 1.5 s after the `UpdateStream` call, which took 52 ms |
| Remove B | `FINISHED` in the direct answer; B gone 1.6 s after the call |
| Add B again, the same URL | Accepted; publishing after 1.9 s. The results then hold **two entries with the same redacted URL**, one `FINISHED` and one `ACTIVE` |
| 14 more URLs that cannot resolve, in one call | Accepted: 17 entries. `ACTIVE` in the direct answer, `FAILED` in `ListEgress` 1.7 s later. Both sinks kept publishing |
| Kill B (its ingress deleted) | `retries: 1` after 1.7 s; 23 retries, the last at 29.8 s; `FAILED` at 31.1 s by LiveKit's timestamp, in `ListEgress` at 32.4 s. The egress stayed active and A kept publishing with no retry |
| Kill A, the last output | **The egress did not fail.** A's stream read `ACTIVE` with `retries: 1` within 2 s and never changed. The egress stayed `ACTIVE`, no error, for the 90 s watched, and ended only on `StopEgress`. A second run: the same for 75 s |

- **A while B was failing,** from the recording of A's room (6,347
  frames, every timestamp step 33.3 ms): no freeze of 200 ms or more in
  the 45 s before the kill, two of 200 ms in the 40 s after it. A small
  hiccup; A never disconnected.
- **The failed stream's error** names the cause and no key: "Failed to
  connect: 'publish' cmd failed: … NetStream.Publish.Failed".
- **Why the last output differs is not known.** The open-source egress
  fails when its last stream fails. Here the stream never reached
  `FAILED`: after one retry nothing more was reported. Whether it fails
  later than 90 s was not watched.
- A destination that cannot resolve fails at once, with no 30 s retry: at
  the moment streaming begins, or 0.16 s after an `UpdateStream` call. The
  error names the host only.
- When a room closes, the egress reads `COMPLETE` while its still-connected
  stream reads `FAILED` ("connection closed remotely").
- **`ListEgress` answers with the deprecated fields.** Stream results are
  in `stream.info` and segment results in `result.segments`;
  `stream_results` and `segment_results` were empty in every one of 313
  polls. The direct answers of `StartEgress`, `UpdateStream` and
  `StopEgress` fill `stream_results`.
- Not covered: three or more live destinations at once, 16 live ones, and
  results by webhook (no public receiver was allowed).

## S0.4 Stream keys

Two egresses with made-up keys on hosts under `.invalid`, and one LiveKit
sink.

| URL shape | What LiveKit shows back |
| --- | --- |
| `rtmps://h/live2/abcd-efgh-ijkl-mnop-qrst` | `…/live2/{abc...rst}` |
| `rtmps://h/app/live_123456789_…` | `…/app/{liv...123}` |
| `rtmps://h/app/sk_us-west-2_…` | `…/app/{sk_...tUv}` |
| `rtmps://h:443/x/<key>` | `…:443/x/{abc...opq}` |
| `rtmps://h:443/rtmp/FB-…?s_bl=1&…&a=…` | `…/rtmp/{FB-...pZz}`: the key and its query as one piece |
| `rtmp://h/app/key`, `rtmp://h/app/inst/key`, `… live=1`, `/app/stream?token=…` | The last segment redacted |
| `rtmps://h/app/KEY/` (a trailing slash) | **`…/app/KEY/{...}`: the whole key** |
| `rtmps://user:PASS@h/app/key` | **The password** |
| A 9-character key; a 3-character key | **6 of 9 characters; 2 of 3** |
| `srt://h:9000?streamid=…&passphrase=…` | The request copy is redacted; **`stream_results[].url` is the whole URL** |
| `rtmp://h/key`, `rtmp://h/live?key=…` | Refused (HTTP 400), and the error text repeats the whole URL to the caller |

- The same redaction holds in `StartEgress`, `UpdateStream`, `StopEgress`,
  `ListEgress` and the ended record.
- S3 credentials come back as `{access_key}` and `{secret}`.
- Ended egresses stay listable, with redacted URLs and stream errors. For
  how long is a question for LiveKit.
- **`roomRecord` is project-wide.** A token with `roomRecord` and
  `room: A` listed every egress, added a URL to room B's egress, started an
  egress in B and stopped B's. A join-only token and a `roomAdmin` token
  got 401 on every egress call.
- Not seen: webhook bodies and the dashboard.
- From the open-source code only, not run (it needs a Twitch host): a URL
  on `*.contribute.live-video.net/app/…` is rewritten to an ingest from
  Twitch's own list, so the URL in the result is not the one that was sent.

### Questions for LiveKit support (draft, not sent)

1. For an egress with an RTMP stream output, where is the full destination
   URL, with its stream key, held, and for how long after the egress ends?
2. Is the full URL written to any log, trace, analytics store or support
   tool? If so, which, and with what retention?
3. `ListEgress` returns ended egresses with redacted URLs. How long are
   those records kept, and can a project shorten that or delete one?
4. Do webhook bodies (`egress_started`, `egress_updated`, `egress_ended`)
   carry the same redacted form as the API?
5. What does the dashboard's egress page show for a stream URL, and to
   which project roles?
6. A URL ending in a slash, or with user info, or with a short key, is
   shown in full or in part (examples above). Is that intended?
7. For the EU data region: are egress records and logs held in the EU?
8. Is an egress that never leaves `STARTING`, and is aborted, billed?

## S0.5 Segments on Neon

- A branch credential with only `storage:write` **is write-only** on Neon:
  PUT 200, DELETE 204; GET, HEAD and list 403. Neon's docs say write
  includes read. A read-only credential lists and cannot write. A branch's
  credential is refused on the parent.
- LiveKit uploaded with that write-only credential: path-style, the
  branch's endpoint, region `eu-central-1`.
- 20 recordings, 21 to 247 s: every segment in the playlist is in the
  bucket, none empty; the playlist ends with `#EXT-X-ENDLIST` and carries
  `#EXT-X-PROGRAM-DATE-TIME` per segment; a manifest `EG_<id>.json` lists
  the objects and holds no credential.
- The desktop's remux: `ffmpeg -i index.m3u8 -c copy` to MP4, then a full
  decode with errors fatal. Exit 0 every time.
- The egress forces a keyframe at every segment boundary. With 4 s
  segments the whole encode has 4 s keyframes.
- A `public_read` bucket serves the program page as
  `text/html; charset=utf-8`, ignores the egress's query string, and the
  recorder loads it. `custom_base_url` may carry its own query.

## S0.6 The talk-show page

### Locally

A host (H.264, with a screen share) and five guests (VP8), each a colour
and a tone, in headless Chrome. Load 16 to 29.

- **Layouts:** 9 stage cases, 35 tile probes, all right. Solo with 6 and
  with 1, side-by-side with 2, 3 and 6, screen-people with 3 and 6 plus
  the host's screen, spotlight with 4 and 6. Rectangles, plates and corner
  radii come from the fixture; its placeholder identities are slots.
  Landscape only.
- **Stage as room metadata:** there when the page joined, followed on every
  change, and recovered by a second page that joined later.
- **Overlay as a byte stream:** a guest's was refused and not shown; the
  host's was shown.
- **Limiter:** a `DynamicsCompressorNode` let six −6 dBFS tones out at
  −0.3 dBFS. An AudioWorklet with a 5 ms look-ahead holds −1.0 dBFS.
- **The audio path adds delay to every voice:** the look-ahead (5 ms) and
  the audio context's own latency (27 ms output, 5 ms base in this Chrome).
  That comes out of the 80 ms lip-sync budget.
- Chrome only feeds a remote track into Web Audio while a media element
  also plays it.
- A VP8 guest's pure green comes back about 48 RGB units off.
- Not built: the 300 ms crossfade, the host's circle, plate design.

### On Cloud

Two runs of about 70 s. A host (H.264 camera, Opus, an H.264 screen share)
and two guests (VP8) published from headless Chrome on this Mac; LiveKit's
recorder opened the page from the Neon bucket and wrote segments, 1080p30,
High, 6 Mbps. No ingress. Load 8.

- **Room metadata reaches the recorder.** The stage was set before the
  recorder joined; the page started on it (egress active 4.3 s after
  `StartEgress`), and each later change of metadata changed the picture.
- **All four layouts are right in the recording,** in both runs:
  side-by-side with three, solo with the host alone, screen-people with
  the host's screen and three people, spotlight on a guest. 11 tile probes
  a run, each the median of nine frames.
- **Byte streams reach the recorder.** The host's overlay was shown; a
  guest's was refused and the picture did not change. Both runs.
- **Lip sync misses the bar.** The host's tile flashes white and beeps at
  the same instant once a second. In the recording the beep comes after
  the flash:

  | Run | Audio after video, median | Range | Flashes |
  | --- | ---: | --- | ---: |
  | Voices through the limiter | **113 ms** | 89 to 135 ms | 21 |
  | Voices on plain audio elements | **100 ms** | 34 to 169 ms | 20 |
  | For comparison: the solo chain, an RTMP feed with the same flash and beep | 52 ms (the feed itself reads 16) | 30 to 52 ms | 21 |

- **What that says.** The reading's resolution is half a frame, 17 ms. The
  limiter's path is about 13 ms of it. The recorder and a program page
  account for about 36 ms, as the solo chain shows. The rest of the
  talk-show figure is in the synthetic guest (a canvas and a Web Audio
  tone in headless Chrome) or its WebRTC leg from this Mac; which is not
  separated. A guest with a real camera and microphone, or a host tile fed
  through an ingress, would settle it. Not run: S0.6 was held to two
  attempts.
- The solo chain's 36 ms is inside the bar.

## S0.8 Go Live to on air

API polled every 0.5 s; 19 runs.

| Step | Measured |
| --- | --- |
| `StartEgress` answers | 0.77 to 1.06 s |
| Feed starts → ingress PUBLISHING | 1.9 to 4.4 s |
| Feed starts → egress active, the egress already waiting | 4.3 to 6.8 s |
| `StartEgress` → active, media already in the room | 4.1 s (720p, LiveKit's template); 3.0 and 3.2 s (1080p60, the solo page) |
| `StartEgress` → the destination's stream started, media already in the room | 3.1 and 3.2 s, by LiveKit's own timestamp |
| `StartEgress` → the sink publishing, media already in the room | 4.8 and 4.9 s (a LiveKit ingress as the sink takes its own time to start) |
| Egress active → the sink publishing | Within one poll, 0.2 s (once) |

So a platform gets its first frame about 5 to 7 s after the desktop starts
its feed, or about 3 s after `StartEgress` if the feed is already in the
room, and the picture it gets is 2.3 s behind the feed.

## S0.9 WHIP

- FFmpeg 8.1.1's `whip` muxer, video copied (H.264 High), audio through
  libopus, into a WHIP ingress with transcoding off. LiveKit accepted the
  High profile; the room gets the feed's own H.264 and Opus.
- Quality equals the tuned RTMP path (table above).
- **Frames were far less even:** 13.6 dropped and 12.2 repeated per 100.
  One run; the cause is not isolated. FFmpeg sends a copied file with no
  pacing inside a frame and cannot answer a keyframe request.
- **FFmpeg takes one ICE candidate.** With LiveKit's answer as sent it
  picked an IPv6 address and failed on a network with no IPv6 route. The
  relay kept IPv4 UDP candidates only.
- **The builds:** macOS builds FFmpeg 8.1.1 from source with OpenSSL and
  no muxer list, so `whip` is in; it has no libopus, only FFmpeg's
  experimental Opus encoder. Windows and Linux pin BtbN n8.1.2 LGPL
  builds; they were not run.

## Assumptions the plan marked ◇

| Assumption | What Cloud does |
| --- | --- |
| A stalled stream is retried for 30 s, then removed; others carry on | Yes, when it is not the last: 23 retries, failed after 31 s, the other carried on. A destination that cannot resolve fails at once |
| If the last output fails, the egress fails | **No.** With its only destination gone the egress stayed active and the stream read active with `retries: 1`, for the 75 and 90 s watched |
| Stream URLs are redacted to the first and last three characters | Yes |
| A URL the pattern does not match is not redacted | It is refused. The leaks are shapes the pattern does match |
| S3 credentials are replaced whole | Yes |
| `roomRecord` is project-wide | Yes |
| Egress participants do not keep a room open | Yes. But the egress is listed as a participant and counted in `numParticipants` |
| LiveKit's S3 fields work against Neon | Yes, path-style, with a write-only credential |
| RTMP output as metered data transfer | Not visible from the API |
| The macOS FFmpeg carries the WHIP muxer | Yes; High profile works; no libopus |

## Pass bars that had to be adapted

- **Receiver gap ≤ 100 ms.** A LiveKit ingress used as a sink shows its
  state, not arrival times, and no receiver with a public address was
  allowed. Measured: the egress's own output timestamps and the stream's
  retry count.
- **Results by webhook within 5 s.** No public receiver. Read from
  LiveKit's own timestamps in the egress record.
- **30 and 60 minute timeouts.** Run at 120 and 300 s.
- **Destinations.** Two sinks, not three, with a direct publisher as the
  feed; 14 of the 17 URLs could not resolve.
- **Lip sync.** Measured with a synthetic guest, not a camera and a
  microphone.
- **Card within 3 s.** Counted from the last frame shown, as the node
  path's switcher counts it, not from the cut on the wire.
- **The 60 fps bar** is given both ways: over the whole run and after the
  first 5 s.
- **The dashboard** was not looked at.

## What the program page must do

For W6 and T1. All of it is in `pages/solo.html`.

1. **Own the element's stream.** `livekit-client`'s `attach()` clears the
   element when the track goes away.
2. **Never stretch the video.** Draw it at its own size
   (`object-fit: none`, scaled as a box). The 2×2 end frames are then a
   two-pixel dot over whatever lies beneath. Seven of eight runs showed no
   black frame; one showed two.
3. **Keep a copy of the picture beneath, and copy rarely.** Each canvas
   copy costs the recorder frames. Twice a second was used last; the right
   rate is open.
4. **Do not pipe frames through script.** It keeps the last frame exactly
   and costs up to 9 frames in 100.
5. **The element's `resize` event is the earliest sign** that the track has
   ended, 16 ms before the frame callback and 137 ms before `mute`.
6. **Decide the hold on a clock, not on work.** The first version started
   its fade 450 ms late because a canvas read took that long.
7. **Count decoded frames as well as frame callbacks** while the video is
   covered.
8. **Ask for the font.** LiveKit's recorder happened to have Noto Sans.
9. **A limiter is an AudioWorklet,** not a compressor node.

## Not run, and the commands

All from the scratch directory, after `. /tmp/plan-234/lkenv.sh`. The
branch is deleted; `node neon.mjs setup && node neon.mjs put-pages`
makes a new one. The minutes each needs are in the private file.

Still owed:

```
# S0.3 with three sinks and 16 live destinations: needs a project that
# holds four or more ingress objects
node dest.mjs main extra=14

# a second sample of a 30 fps feed recorded at 60 fps
node chain.mjs q30b-e60b 30 seconds=78 tail=6 page=v=final egress=advanced \
  egressKbps=6000 egressFps=60 ingressKbps=12000 segment=2 \
  feed=/tmp/plan-234/phase0/media/feed-30b.flv
```

Owed with no script yet:

- Talk-show lip sync with a guest on a real camera and microphone, or with
  the host's tile fed through an ingress.
- Whether an egress whose last destination died ever fails after 90 s.
- A still picture (the card) through a sink, watched at a low load.

Never meant to run in Phase 0 without the owner's word:

```
# S0.10, the 12-hour soak (with a sink; LiveKit should end it at 12 h)
node chain.mjs soak 30 loop=1 seconds=43500 tail=30 sink=1 download=0 \
  page=debug=1 egress=advanced egressKbps=6000 ingressKbps=12000 \
  feed=/tmp/plan-234/phase0/media/feed-30b.flv

# S0.5, 3 h 10 min of segments (past the 3-hour file limit)
node chain.mjs rec3h10 30 loop=1 seconds=11400 tail=10 download=0 \
  page=v=final egress=advanced egressKbps=6000 ingressKbps=12000 \
  feed=/tmp/plan-234/phase0/media/feed-30b.flv

# S0.2, the real hold limits
node hold.mjs d1800 1800 timeout
node hold.mjs d3600 3600 timeout
```

Not measurable from here: the dashboard's view of a stream URL, webhook
bodies, LiveKit's bill for the day, and arrival times at a real RTMP
receiver.

## What the plan should change

1. **D4, the egress encoding.** Not "the matching preset". Advanced
   options: H.264 High, 6 Mbps, 48 kHz audio, and 60 fps for a 30 fps
   feed.
2. **D4, the ingress.** One 1080p layer at 12 Mbps, codec left to LiveKit.
   High is refused; 16 Mbps never starts.
3. **D12, 60 fps.** Stays capped at 1080p30.
4. **D5, the return.** "Back about 1 s after the feed" is 4.8 to 6.2 s
   here. Either the bar moves or the steady wait shrinks; the ingress's
   3.5 to 4.8 s cannot.
5. **D5, the hold limit.** It is `departure_timeout` plus however long the
   ingress keeps a silent feed (100 s in one run). The reaper has to end a
   show whose feed is silent but present.
6. **D7, the guard.** Refuse a trailing slash, user info, any scheme but
   `rtmp` and `rtmps`, and any URL LiveKit would refuse (its error repeats
   the URL). Set a shortest key: LiveKit shows six characters of any key
   of nine or more, and most of a shorter one.
7. **D8 and W4.** Read `stream.info` and `result.segments` from
   `ListEgress` as well as the `_results` fields. Do not take a stream's
   `FAILED` at a room-closed end for a dead destination. A URL that was
   removed and added again has two entries with the same redacted URL, so
   an HMAC of that URL does not name one entry: take the newest.
8. **D10, recording.** Segments of 2 s if the same egress streams, or the
   stream gets 4 s keyframes. The credential can be write-only.
9. **D13, capacity.** The project holds two ingress objects: one show with
   both orientations. The plan tier has to be settled before any cap is
   chosen.
10. **D6, lip sync.** Not settled. The recording was 100 to 113 ms off with
    a synthetic guest, and the limiter is about 13 ms of that. T1 needs a
    lip-sync test with a real camera and microphone before the 80 ms bar
    is called either way. The solo chain measured 36 ms.
11. **D20, the page.** The nine points above; and frames: about 1.3 in 100
    at 30 fps is the floor of this design.
12. **D18, smokes.** No Docker on this Mac; the pages were tested against
    `livekit-server --dev` and headless Chrome alone, which covers the page
    and none of the egress.
13. **D9, the last destination.** "The egress is gone" does not happen: the
    egress stays active with a dead stream that reads `ACTIVE`,
    `retries: 1`. The web has to notice `retries` rise on a show's only
    stream and act itself (remove and add the URL, which takes about 1.5 s
    when the destination is back, or stop and start the egress). `retries`
    never clears, so it cannot say that a stream recovered. D11's meter
    keeps counting such an egress.
14. **D9, one of several.** A destination that dies is retried for 30 s
    and marked failed at 31 s, as assumed. Reconnect is then a plain
    `UpdateStream` add.
