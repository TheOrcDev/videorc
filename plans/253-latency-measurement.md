# Plan 253: Latency you can see

The owner's ask (2026-11-19, after the day's live talk shows): "yes we
definitely need latency measuring so we can see how close we are with other
guests etc, plan it out."

Facts are read from desktop `origin/main` `4075becc2` and web `origin/main`
`84e9a695` (2026-11-19). External facts carry a link. Nothing here was run:
no app, no smoke, no product code.

## Status and scope

- **Status: PLANNED 2026-11-19.** A plan only. Eleven slices, web first.
- **In scope:** managed talk shows (web control, `nodeId === "livekit"`):
  the guest page, the program page, the web's beacon and guest heartbeat
  routes, the host's room client in the renderer, the Show stage and Guests
  rows (plan 252), the Program monitor, the Stream Manager header, the
  backend's record of a show, the stream report, the agents' MCP status, and
  a validation case in the cloud parity harness.
- **Out of scope:** node shows (D10: declared unsupported, not half built);
  solo shows (no room, no guests); the Rust UI (`videorc-rust`); lowering
  latency (this plan measures; fixes come from what it shows); a measured
  viewer delay per platform (D7: nobody gives us one).
- **Number:** 253 is the next free number after 252.

## What exists

Nothing measures latency today. Read from the code:

- **No stats are read.** No `getStats`, `currentRoundTripTime` or
  `jitterBufferDelay` anywhere in `apps/desktop/src` or the web's guest and
  program code. The one `getRTCStatsReport` call
  (`talk-show-room.ts` `cameraSenderStats`, "S13a harness only") is a smoke
  seam. The web has one sampler, in a test consumer
  (`tests/browser/cloud-alpha/consumer.ts`).
- **No request is timed.** `cloud_control_web.rs` uses `Instant` only for
  deadlines. The 2 to 7 s command-lane delays of 11-19 left no record.
- **The connection dot never lights on a managed show.** The row reads
  `quality` from `cloud.state`, and the web sends a constant:
  `quality: "good"` ("LiveKit's server does not report it",
  web `lib/cloud/media/room.ts`). The renderer does compute LiveKit's
  quality per person (`TalkShowPerson.quality`, `qualityOf`), but no UI
  reads it and it never reaches the backend.
- **LiveKit's quality is not latency anyway.** It is scored from packet
  loss, bitrate and missing video layers; jitter and round-trip time are
  switched off in the scorer
  ([LiveKit KB](https://kb.livekit.io/articles/2455399507-how-is-connection-quality-determined)).
  A guest 600 ms away with no loss reads Excellent.
- **Clocks are not synced, and nothing may assume they are.** There is no
  server-time endpoint or offset estimate. The beacon's `at` is the page's
  `Date.now()` and the server stores its own receive time instead.
  `output-health.ts` says it outright: "the page's clock and the egress's
  are unrelated". The Mac's NTP offset was 0.12 s on 11-19, which is the
  size of the thing we want to measure.
- **Who may send what in the room:**

  | Participant | `canPublishData` | Reports to the web |
  | --- | --- | --- |
  | Host `host:<show>` | yes | `cloud.*` RPCs through the backend |
  | Guest `g_…` | **no** (and no own metadata) | `POST /api/guest/:slug/media` every 10 s (capability heartbeat) |
  | Program page `EG_…` | never publishes (token is LiveKit's) | the beacon: on change, at most 1 a second, else every 10 s |

- **A relay to the host already exists.** The web checks a page's or a
  guest's capability and sends it to `host:<show>` with
  `RoomServiceClient.sendData` on `videorc.media-capability.v2`, stamped
  with server time (`room-media-relay.ts`). Screen privacy acks go the same
  way. The host treats a receipt as current for 25 s.
- **How a stage change is confirmed:** `PUT /api/cloud/shows/:id/stage`
  writes LiveKit room metadata; the page draws it and puts the stage's
  content key in its beacon (`shown.stage`); the state answer carries it
  back as `room.shown.stageKey` with `room.shown.at` (server receive time);
  the renderer compares keys (`programPreviewStage`) and shows Confirmed.
  Graphics, avatar and scenes go host to page as LiveKit byte streams and
  come back as `applied {publisherSid, revision}` in the relayed receipt.
- **Strictness, per reader:**

  | Reader | A field it does not know |
  | --- | --- |
  | Web `parseBeacon` | ignored, never stored (pinned by a test) |
  | Web stream report schema (`z.strictObject`) | **the whole report is refused** |
  | Rust `RunnerState`, `CloudOutputHealth`, `CloudRoomShown` | ignored |
  | Renderer `backend-rpc-contract.ts` (`allowUnknown: false`) | **the whole status or event is dropped** |
  | Host room client `DataReceived` | a topic it does not know is ignored |

- **Egress.** A room-composite egress on our page (`TemplateSource`,
  H.264 High, 60 fps, 6000 kbps, 2 s keyframes). No latency option is set,
  and `EgressInfo` reports none.
- **The "Show stage runs 150 to 300 ms behind the room" note** is in
  neither repo. This plan replaces the note with a number.

## The numbers

Five numbers. Each is a duration. The parts each is built from are in D2.

| # | Name | Definition | Known how |
| --- | --- | --- | --- |
| N1 | **Conversation delay**, per guest, per direction | From a sound entering one person's microphone to it leaving the other's speaker (mouth to ear), through the room | Measured: both ends' stats, summed (D2) |
| N2 | **Program delay** | From the host's camera or microphone to the program page having it ready to draw or mix | Measured: host's stats plus the page's |
| N3 | **Output delay** | From the page's picture to the bytes leaving the egress for the platform | **Calibrated, not live**: measured in the harness, shown as "about N s" (D6) |
| N4 | **Viewer delay** | From platform ingest to a viewer's screen | **Not known.** The mode is shown, the number is the platform's (D7) |
| N5 | **Control delay** | From the host's click to the program page having drawn it; and how long each command to the web took | Measured: one clock per figure (D8) |

The headline the owner asked for is N1: one number per guest, the worse of
the two directions (Owner check O1).

## Decisions

### D1. Durations on the wire, never timestamps

Every reporter sends how long something took on its own monotonic clock
(`performance.now()`), or how long ago it happened ("age"). Nobody sends a
wall-clock time for another machine to subtract from. Then no clock offset
can leak into a number, and no sync protocol is needed for N1, N2 and N5.

Where two machines' events must be compared (N5's stage apply), both
events are stamped by the one web server and the page contributes only an
age.

### D2. N1 and N2 are passive: WebRTC stats at both ends, summed

A one-way path through the room, sender S to receiver R:

`delay(S→R) = send(S) + rtt(S)/2 + sfu + rtt(R)/2 + buffer(R, S's track) + playout(R)`

| Part | Source | Notes |
| --- | --- | --- |
| `rtt` | `candidate-pair.currentRoundTripTime` of the selected pair; fallback `remote-inbound-rtp.roundTripTime` of a published track | Client to its LiveKit edge, from STUN consent checks or RTCP RR ([webrtc-stats](https://www.w3.org/TR/webrtc-stats/#dom-rtcicecandidatepairstats-currentroundtriptime)) |
| `buffer` (audio) | Δ`jitterBufferDelay` / Δ`jitterBufferEmittedCount` on the inbound audio track | The spec's own recipe for the mean ([webrtc-stats](https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-jitterbufferdelay)). Deltas over the sample window, never session totals |
| `buffer` (video) | Δ`totalProcessingDelay` / Δ`framesDecoded` | First packet received to decoded ([webrtc-stats](https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-totalprocessingdelay)) |
| `playout` (audio) | Δ`totalPlayoutDelay` / Δ`totalSamplesCount` from `media-playout` | Chromium only, and at risk in the spec. Absent: the part is 0 and the figure is marked `partial` |
| `send` (audio) | constant `SEND_AUDIO_MS = 40` | Capture, one 20 ms Opus frame, packetizing. No stat exists for capture to encode. Calibrated in S5 |
| `send` (video) | Δ`totalEncodeTime`/Δ`framesEncoded` + Δ`totalPacketSendDelay`/Δ`packetsSent` + half a frame interval | Sender's `outbound-rtp` |
| `sfu` | constant `SFU_MS = 5` | Forwarding inside one LiveKit region |

- **N1** for a guest G: `delay(host→G)` and `delay(G→host)`, audio. The row
  shows the larger. Video delay is kept in the record, not on the row.
- **N2**: `delay(host→page)`, video and audio, plus `PAGE_DRAW_MS = 33`
  (two frames at 60 fps: the page's own "applied" rule is a double rAF).
- **Guest to guest** falls out of the same parts (each guest reports its
  buffer per sender). It goes in the record and the report; no row shows it.
- All through livekit-client 2.23.0's `track.getRTCStatsReport()`
  ([reference](https://docs.livekit.io/reference/client-sdk-js/classes/Track.html)):
  a receiver's report holds its `inbound-rtp`, the transport's selected
  candidate pair and the playout object.

**What this cannot see**, and the plan says so in the UI's tooltip:

- A hop between LiveKit regions (a guest on another continent joins their
  nearest edge; the relay between edges is in nobody's `rtt`).
- An asymmetric route (`rtt/2` assumes the two ways are equal).
- The speaker and room acoustics, the microphone's own hardware delay.

S5 measures how large the gap is against ground truth. Only if it fails
there does the probe of D5 get built.

**Why not the alternatives:**

- `requestVideoFrameCallback`'s `captureTime` on a remote frame is "based
  on the RTP timestamp of the frame and estimated using clock
  synchronization" from RTCP sender reports
  ([spec](https://wicg.github.io/video-rvfc/)). Through an SFU the sender
  reports are the SFU's, so it would report SFU to guest at best. Used
  nowhere in production; S5 uses rVFC only to read the harness's marker.
- LiveKit's `connectionQuality`: not latency (see above).
- A visible or audible watermark in production: the stream is the product.
  Markers live in the harness only (D9).

### D3. How the numbers reach the host: the relay that already exists

Guests cannot publish data and the page never does. Both already talk to
the web, and the web already relays to the host. So:

- The guest page adds a `net` block to its capability heartbeat
  (`POST /api/guest/:slug/media`, every 10 s).
- The program page adds a `net` block to its beacon.
- The web validates each block, and relays it to `host:<show>` with
  `sendData` on a new topic, `videorc.latency.v1`, adding server time `at`
  and the sender's identity (taken from the session or the page token,
  never from the body). At most one relay per sender per 10 s.
- The host's room client samples its own stats, joins the three, and holds
  the result in its snapshot. Current for 25 s (`CAPABILITY_TTL_MS`'s rule),
  then the number goes away rather than going stale.

The block (all optional but `v` and `window`; numbers are whole
milliseconds, 0 to 60000):

```json
{ "v": 1, "windowMs": 10000, "rttMs": 42, "playoutMs": 18, "partial": false,
  "send": { "videoMs": 21 },
  "from": [ { "identity": "host:sh_…", "audioMs": 61, "videoMs": 84 } ] }
```

`from` holds at most 8 senders. The page's block rides whatever beacon
goes next: `net` is **not** in the beacon's change key, so it never causes
a beacon. Over 4 KiB the beacon drops `net` first, before `shown`.

No new grant, no new route, no new table on the web. Nothing is stored
there: the relay is the whole path. The cost is one LiveKit `sendData` per
guest and per page per 10 s.

Why not `cloud.state`: everything in `room` is material and bumps `rev`,
so a number that changes every 10 s per person would wake every long poll;
and the renderer needs its own stats in the sum anyway.

### D4. The renderer computes, the backend remembers

- The model is one pure module, `shared/room-latency.ts` (no LiveKit
  import), held to a fixture the web copies:
  `protocol-fixtures/room-latency.json` (blocks in, numbers out, including
  the missing-part and `partial` cases).
- The sampler lives in `talk-show-room.ts`'s lazy chunk, so the eager
  renderer bundle does not grow (the budget is an owner STOP).
- Every 10 s the renderer hands the backend a summary over a new RPC,
  `cloud.room.latency.report` (renderer role only, as
  `cloud.presentation.accepted`). The backend keeps the latest, folds
  minutes into SQLite, and serves the record, the report, the watchdog and
  the agents. It never re-emits it as `cloud.state`.
- **The dot tells the truth.** On a managed show the row's connection dot
  reads the renderer's own LiveKit quality (today's dead
  `TalkShowPerson.quality`) instead of the web's constant. Same slice,
  since it is the same row and the same sentence in the tooltip.

### D5. An active probe only if the passive sum fails validation

Kept as a design, not a slice that must ship. If S5 or the real show finds
the sum off by more than the tolerance:

- The host sends a lossy data message every 2 s on
  `videorc.latency.probe.v1` with a sequence number.
- **Option A (no new grant, recommended):** one-way time needs a clock
  both ends share, so the web becomes that clock. The heartbeat's and the
  beacon's answers gain `serverNow`; each side keeps the offset from its
  fastest round trip; the host stamps each probe in server time and each
  receiver reports, in its `net` block, how long the probes took. Accuracy
  is about ±40 ms (two offsets). This is the one place a timestamp crosses
  the wire, and the contract names it as the exception to D1.
- **Option B (a grant):** guests get `canPublishData` and echo the probe
  with their hold time. NTP's four-timestamp method then gives the round
  trip to a few ms with no clock at all. It widens what a guest's token may
  do in the room. Owner check O4.

### D6. Output delay is a calibrated constant

The egress is Chrome into a GStreamer pipeline: compositor, mixer, x264,
the FLV muxer. Its buffering is seconds, not milliseconds (LiveKit's own
PR discusses about 4 to 6 s inside the pipeline:
[egress #1442](https://github.com/livekit/egress/pull/1442)), and neither
the page nor the API can observe it. So:

- S10 measures it once per LiveKit egress version with the harness's
  marker and a local RTMP sink, and writes the number down
  (`protocol-fixtures/room-latency.json` `outputDelayMs`, with the date and
  version).
- The app shows it as "about 4 s", never as a measurement.
- If the harness cannot run a real egress, the constant comes from the
  real-show acceptance (a stopwatch on camera against a private RTMP sink).

### D7. Viewer delay: say what we know

| Platform | What exists | What we show |
| --- | --- | --- |
| YouTube | The broadcast's `contentDetails.latencyPreference` (`normal`, `low`, `ultraLow`) ([API](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts)). No measured latency in the API | The mode, when the desktop created the broadcast and knows it |
| Twitch | "Latency to Broadcaster" exists only in the player: Video Stats, or `getPlaybackStats().hlsLatencyBroadcaster` in the embed ([embed docs](https://dev.twitch.tv/docs/embed/video-and-clips/), [help](https://help.twitch.tv/s/article/low-latency-video)). No Helix endpoint | "Twitch shows this in its player: Settings, Advanced, Video Stats" |
| Kick | No public API for it | Nothing |

No platform delay is added into any total. The Stream Manager's tooltip
ends "plus the platform's own delay, which only the platform knows". A
measured Twitch figure (a muted embed on the `/live` page reading
`hlsLatencyBroadcaster`) is Owner check O5, default no.

### D8. Control delay: three figures, one clock each

| Figure | Start | End | Clock |
| --- | --- | --- | --- |
| **Command time** | the backend sends a web intent (`send_web_intent_until`: stage, destinations, recording, legs) | the web's answer | backend `Instant` |
| **Stage applied** | the web accepted the stage (it stores `stageSetAt`, server time, beside `stageSet`) | the page drew it: the beacon's receive time minus the page's `shown.appliedAgoMs` | web server (the page gives an age) |
| **Seen by the host** | the click (`performance.now()` in the renderer) | the Program chip turns Confirmed, or the receipt for that graphics/scene revision arrives | renderer |

- "Stage applied" travels as `room.shown.applyMs` in the state answer.
  It is the honest figure; "Seen by the host" also contains the beacon's
  1 s floor, the long poll's 1 s check and the 250 ms rest, and is what the
  host actually waits.
- Command time is the 11-19 problem. A command slower than 2 s writes a
  `health_events` row (`cloud-command-slow`, with the command and the
  milliseconds), so the next overloaded show leaves evidence.

### D9. Validation: injected delay must come back out

Two proofs in the cloud parity harness (`pnpm smoke:cloud-parity`, a real
dev app as host, two real guest pages, the real program page, local
`livekit-server --dev`), as a new `--case latency`:

1. **Injected delay.** Delay the LiveKit UDP port on loopback with
   dummynet, reusing `scripts/live-lab/lib/net-fault.mjs` (`dnctl`/`pfctl`;
   needs sudo, and SKIPs naming the missing grant). A delay of D on every
   client-to-server leg adds 2D to each one-way path. At D = 0, 50, 150 and
   300 ms: reported N1 and N2 must rise by 2D within the larger of 30 ms
   and 15 %, and each `rttMs` by 2D.
   The existing thin-uplink smoke is not the tool: it throttles one RTMPS
   feed of a solo node show through a TCP proxy.
2. **Ground truth.** Everything runs on one Mac, so one clock. The host's
   harness camera shows a frame counter the guest and page read with
   `requestVideoFrameCallback`; the host plays a tone burst the guest
   detects in an `AudioWorklet`. Marker time against the model's figure:
   within the larger of 40 ms and 20 %. This calibrates `SEND_AUDIO_MS`,
   `SFU_MS` and `PAGE_DRAW_MS`.
3. **Cost.** The sampler's own time is counted in the same run: under 2 ms
   per sample on the host, one sample per 10 s. Sampling never runs faster
   than that, and never on the 50 ms or 1 s timers.

Then a real show (S11): two networks, a phone's stopwatch on the host's
camera, a photo of the stopwatch and the guest's screen together, five
times; the row's number within 60 ms of the photo's mean. Twitch's
"Latency to Broadcaster" is read off the player for the record.

### D10. Node shows

Not supported in v1, and nothing is drawn: no number, no chip, no "not
available" line (a missing number is not a problem to report). The runner
composes natively, sends no beacon, and its guests' reports would need its
own relay. The gate is the existing `isManagedShow()`. The contract doc
says so, so nobody ports half of it.

### D11. Compatibility

| Pair | What happens |
| --- | --- |
| New web, old desktop | The relay's topic is unknown to the old room client: ignored. `room.shown.applyMs` is dropped by old Rust. Nothing changes |
| Old web, new desktop | No relays arrive: no numbers, no chip, no warning. The dot still gains its truth (it is renderer-only) |
| A guest page loaded before the deploy | No `net` from that guest: their row has no number until they reload |
| A program page loaded before the deploy | No `net`, no `appliedAgoMs`: no Program chip, no "Stage applied" |
| A new desktop's stream report to an old web | **Refused whole** (strict schema). So the web learns the field first (S8 before S9), as with the watchdog's push ids |
| The runner | Untouched |

The two known traps, closed the usual way:

- **Strict renderer contract.** `room.shown.applyMs`, the dashboard's
  `room` block, the new RPC's params and the new watchdog check each land
  in `backend-rpc-contract.ts` (and `shared/live-dashboard.ts`) in the same
  commit as the Rust field.
- **`null` on the wire.** Every new Rust field is
  `#[serde(default, skip_serializing_if = "Option::is_none")]` (or
  `Vec::is_empty`). A test pins that a status with no latency serializes
  byte for byte as before.

### D12. Privacy and cost

- No extra media leaves the room, and nothing is added to the stream.
- The reports are numbers. No IP address, no candidate address, no device
  name: the sampler reads `currentRoundTripTime` and never the candidates.
- A guest's numbers go to the host only (the relay targets `host:<show>`).
- Local record: minutes of numbers per show, keyed by the show, deleted
  with it. Guests appear by the name they joined with, on this Mac only.
  The email carries no guest name (O6).
- Agents get counts and milliseconds, never identities.

## Where it shows

Rules from the design skill: numbers are monochrome and tabular; the tone
rides on a dot or a chip, never on a word; a notice Videorc raises on its
own is an entry behind the bell, never a toast.

### Live

- **A person's row** (`components/guests/room-person.tsx`, both pages).
  In the "what is wrong" slot, after the connection dot: the delay as plain
  tabular text, "180 ms" (Owner check O3: always, or only when wrong).
  - Under 400 ms: the number alone.
  - 400 to 799 ms for 10 s: an amber `StatusDot` before it.
  - 800 ms and up for 10 s: a red one.
  - No report yet, or older than 25 s: nothing.
  - Tooltip, always: "Ada hears you after 210 ms. You hear Ada after
    180 ms. Measured between your computers and the room." When amber:
    "Ada is 600 ms behind. Expect to talk over each other: leave a longer
    pause." When `partial`: "…Ada's browser reports only part of it."
  - The host's own row: no number; the tooltip of its dot gains "45 ms to
    the room".
- **The Program monitor** (`show-stage.tsx` `ProgramMonitor`): a third
  chip under the picture beside "Avatar on" and "Graphics off": "0.3 s
  behind" (neutral `Badge`). Tooltip: "The program is drawn 0.3 s after
  your camera. Viewers get it about 4 s later, plus the platform's own
  delay." Amber from 1 s.
- **The Stream Manager header** (`stats-bar.tsx`, `stream-manager-stats.ts`):
  a new stat, **Room delay**: the worst guest's number, "–" with no guest.
  Tooltip: each guest's number, the program's, and the last stage change
  ("Applied in 0.4 s"). It arrives through `live-dashboard-relay.ts`
  (`LiveDashboardState.cloud` gains an optional block), not the backend.
  It takes a main slot only while the room has a guest (Owner check O8).
- **The Health page** (`cloud-program-health.tsx`): one row, "Commands",
  with the last and the slowest command time of the show.
- **Behind the bell**: one notice-level entry per guest after 30 s at
  800 ms or more, subject `cloud-status`: "Ada is 0.9 s behind. Expect to
  talk over each other." It clears itself after 30 s under 600 ms. No phone
  push (O7).

### After the show

- **The session record**: `storage/cloud_latency.sql`, table
  `cloud_latency_minutes (show_id, minute, subject, kind, p50_ms, p95_ms,
  max_ms, samples)`; `subject` is an identity, `program` or `control`.
  Rows die with the show's session.
- **The stream report** (`stream_report.rs`, the web's strict schema): an
  optional `room` block: guests, typical and worst conversation delay,
  program delay, slowest command. The email gets one line: "Room delay:
  usually 180 ms, at worst 620 ms."
- **Agents**: `get_status` gains `outputSession.latency`
  `{ guests, worstDelayMs, programDelayMs, slowestCommandMs }`, in the
  allowlisted projection, with the leak argument in `docs/agents-mcp.md`
  (numbers only). No new tool.

## Slices

Web first. Each slice is one PR and leaves both repos green.

| # | Repo | Slice | Depends on | Route · lane · fit | Done when |
| --- | --- | --- | --- | --- | --- |
| S1 | desktop + web | **The contract and the model.** `docs/cloud/253-latency-contract.md` (the `net` block, the topic, D1's rule, the constants, node shows unsupported), the paragraph in `managed-media-wire.md`, `protocol-fixtures/room-latency.json`, and the pure `shared/room-latency.ts` with tests; the web's copy in `lib/cloud/latency.ts` held to the same fixture | none | Implementation · `gpt-6.1-sol` · 8 | `pnpm --filter @videorc/desktop test` and the web's `pnpm test` pass on the shared fixture, including the missing-part, `partial` and stale cases |
| S2 | web | **The guest reports.** A sampler in `components/guest/` (10 s, deltas, never reads candidates), `net` on the capability heartbeat, validation in `handleGuestMediaCapability`, the relay on `videorc.latency.v1` (identity from the session, one per 10 s) | S1 | Implementation · `gpt-6.1-sol` · 8 | Unit tests: a valid block is relayed once with the server's `at`; a malformed one is dropped and the heartbeat still answers 200; a second inside 10 s is not relayed. `pnpm smoke:guest-call` passes |
| S3 | web | **The page reports.** A sampler module (added to `PROGRAM_CLIENT_MODULES`), `net` in the beacon outside the change key, dropped first over 4 KiB; `shown.appliedAgoMs`; `stageSetAt`; `room.shown.applyMs` in the state answer (not material); the same relay | S1 | Implementation · `fable-5.1` · 9 (the page is on air) | `cloud-program-beacon`, `cloud-managed-beacon` and the bundle pin tests pass with new cases: `net` never triggers a beacon; `applyMs` is the receive time minus the age minus `stageSetAt`; an old page's beacon gives no `applyMs`. `run-stage-livekit.mjs` passes |
| S4 | desktop | **The host measures.** The sampler in `talk-show-room.ts`, the `videorc.latency.v1` reader (server-relayed only, as the privacy ack), the join into the snapshot (`latency` per person, `program`), the 25 s rule; the row's dot reads the renderer's LiveKit quality on managed shows | S1 (S2, S3 for numbers) | Implementation · `fable-5.1` · 9 | Unit tests with a fake stats report: numbers match the fixture; no report means no number; a stale one disappears; the dot goes amber on `poor`. `pnpm check:renderer-assets` unchanged. `pnpm smoke:cloud-talk-show-managed` passes |
| S5 | desktop | **Prove the numbers.** `--case latency` in the parity harness: dummynet on the LiveKit port, the frame-counter and tone markers, the sampler's cost; the calibrated constants written back into the fixture | S2, S3, S4 | Diagnose · `fable-5.1` · 9 | D9's three checks pass at the four delays, or the case SKIPs naming the missing sudo grant; `docs/cloud/cloud-parity-harness.md` lists the case. A failure here opens D5, it does not loosen the tolerance |
| S6 | desktop | **Show it live.** The row's number, dot and tooltips; the Program chip; the Stream Manager's Room delay through the dashboard relay; copy in `lib/state-labels.ts`' family; no new primitive or icon | S4 | UI/Product Design · `opus-5.5` · 9 | Component tests for each threshold and the 10 s hold; `pnpm ui:check` and the status colour guard pass; light and dark by eye on the Show stage, Guests and the Stream Manager |
| S7 | desktop | **Remember it.** `cloud.room.latency.report` (contract, Rust, renderer role only), `cloud_latency_minutes`, command timing in `cloud_control_web.rs` with `cloud-command-slow`, `room.shown.applyMs` through Rust and the strict schema, the Health row | S3, S4 | Implementation · `gpt-6.1-sol` · 8 | Targeted `cargo test -p videorc-backend` (minute folding, the slow-command event, byte-for-byte status without latency), clippy, the contract tests; `pnpm smoke:cloud-talk-show-managed` passes |
| S8 | web | **The report learns the block.** The optional `room` block in `lib/stream-report/schema.ts`, the one line in the email, `docs/stream-report-email.md`; the new push check id is known (and not pushed) | S1 | Implementation · `opus-5.5` · 7 (email copy) | Schema tests: with and without `room`; an unknown key inside it is still refused. The email renders the line in the static render check |
| S9 | desktop | **After the show.** The report's `room` block from `cloud_latency_minutes`; `outputSession.latency` in `get_status` with its projection and leak argument | S7, S8 deployed | Implementation · `gpt-6.1-sol` · 8 | `cargo test` for the report builder and the projection; `protocol-fixtures/agent-tools.json` and `docs/agents-mcp.md` updated; `pnpm test:scripts` passes |
| S10 | desktop | **Say it when it is bad, and the output constant.** The watchdog check `conversation-delay` (all seven places the S26 commit `b164a7582` touched), its bell entry and clear; the egress calibration run and `outputDelayMs` | S7; S5's harness | Implementation · `gpt-6.1-sol` · 8 | Watchdog unit tests (raise after 30 s, clear after 30 s under 600 ms, never a push); the calibration's number, date and egress version are in the fixture, or D6's fallback is recorded as owed |
| S11 | both | **A real show.** The stopwatch acceptance on two networks, one guest on a phone; Twitch's player figure noted; `docs/acceptance/2026-11-latency.md`; this plan's "As built" and the README row | all | Orchestrator · `fable-5.1` · 10 | The row's number is within 60 ms of the photos' mean on both directions, and the doc holds the photos' numbers |

Order: S1, then S2 and S3 together, **deploy the web**, S4, S5, then S6
and S7 together, S8, **deploy the web**, S9, S10, S11. S5 sits before the
UI on purpose: no number reaches the owner's eyes before it is proven.

## Tests per layer

| Layer | Proof |
| --- | --- |
| The model | One fixture, two repos (S1) |
| Guest page, program page | Unit tests on the sampler with canned stats; the existing browser suites still green |
| Web routes | Relay once, drop malformed, never refuse the heartbeat or the beacon for a bad `net` |
| Renderer | Fake stats, the TTL, thresholds with their 10 s hold |
| Backend | Minute folding, slow-command event, serialization pin |
| End to end | `--case latency` (S5); the managed talk-show smoke after S4 and S7 |
| By eye | Both themes (S6) |
| The world | S11 |

Cosmetic slices get no heavy smoke (S6, S8): TS gates, unit tests and CI.

## Owner checks

None blocks a slice; each has the default the plan builds.

- **O1. The headline number.** Default: the worse of the two one-way
  delays, per guest ("Ada 210 ms"). Alternative: the full turn (there and
  back), about twice as large and closer to what talking over each other
  feels like.
- **O2. Thresholds.** Default: amber at 400 ms, red at 800 ms, each after
  10 s. 400 ms is the top of what ITU-T G.114 calls acceptable for a
  conversation, and 150 ms is where nobody notices
  ([G.114](https://www.itu.int/rec/T-REC-G.114)).
- **O3. The number on the row.** Default: always shown, quiet (it is the
  ask). Alternative: plan 252's rule to the letter, only when it is amber
  or red, with the number in the tooltip otherwise.
- **O4. Guests' data grant.** Default: unchanged (`canPublishData: false`);
  the passive sum and, if needed, D5's option A. Alternative: allow it, for
  an exact echo probe.
- **O5. A measured Twitch viewer delay.** Default: no; point to Twitch's
  own Video Stats. Alternative: a muted embed on `/live` reading
  `hlsLatencyBroadcaster`.
- **O6. The email.** Default: one line, no guest names. Alternative: none,
  or a per-guest table.
- **O7. The bell.** Default: one notice per guest after 30 s at 800 ms, no
  phone push. Alternative: the row only.
- **O8. The Stream Manager stat.** Default: available, and placed in the
  main slots only while a room has a guest. Alternative: always there, or
  only in the customise list.
- **O9. Does a guest see their own delay?** Default: no; the guest page
  keeps its weak-connection banner. Alternative: a small number on their
  own tile.
- **O10. Node shows.** Default: unsupported in v1 (D10).
- **O11. Output delay as "about N s".** Default: the calibrated constant
  (D6). Alternative: say nothing about it until it can be measured live.

## Owed

- Everything: this is a plan.
- The `media-playout` stat is Chromium's and at risk in the spec; a Safari
  or Firefox guest reports `partial`. S11 should include one Safari guest
  to see how far off `partial` is.
- The cross-region gap of D2 is unmeasured until a guest on another
  continent joins a real show.
- The egress constant must be re-measured when LiveKit's egress version
  changes.

## After

- Node shows: the runner relays the guests' blocks and reports its own.
- Lowering the numbers: `setPlayoutDelay`, the egress's encoder tuning, a
  region pin. Each is its own plan, with this one as its gauge.
- The Rust UI port of the row and the chip.
