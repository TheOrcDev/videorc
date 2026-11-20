# Plan 253 latency contract

How a managed talk show measures its own delay (plan 253, slices S1 to S4), and how the host's computer remembers it (S7, section 10). Three participants each report what they measured, the web relays two of the reports to the host, and the host's renderer adds them up. This file is the only source for the shapes and the constants. The cases are `protocol-fixtures/room-latency.json`; the desktop model is `apps/desktop/src/shared/room-latency.ts` and the web's copy is `lib/cloud/program/room-latency.ts` (re-exported by `lib/cloud/latency.ts`), each held to the same fixture.

No prices, costs, keys or account ids belong here. This repo is public.

## 1. The rule: durations, never timestamps (D1)

Every reporter sends how long something took on its own monotonic clock, or how long ago it happened. Nobody sends a wall-clock time for another machine to subtract from. The machines' clocks are not synced and nothing here may assume they are.

- A `net` block holds durations only.
- The relay's `at` is the web's receive time. It is there for the record. No reader subtracts it from its own clock.
- The host ages a block from the moment it arrived, on the host's own clock.
- Where two machines' events must be compared (the stage apply time of section 6), both events are stamped by the one web server and the page contributes only an age.

The one planned exception is D5's active probe (option A), which is not built.

## 2. The `net` block

What one participant measured over one sample window. Every number is whole milliseconds, 0 to 60000. Everything but `v` and `windowMs` is optional.

```json
{
  "v": 1,
  "windowMs": 10000,
  "rttMs": 42,
  "playoutMs": 18,
  "partial": false,
  "send": { "videoMs": 21 },
  "from": [{ "identity": "host:sh_…", "audioMs": 61, "videoMs": 84 }]
}
```

| Field             | Meaning                                                                                                         | Source (WebRTC stats)                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`               | `1`                                                                                                             |                                                                                                                                                       |
| `windowMs`        | The sample window, 1000 to 60000. Normally 10000                                                                | The sampler's own monotonic clock                                                                                                                     |
| `rttMs`           | Round trip from this participant to its LiveKit edge                                                            | `candidate-pair.currentRoundTripTime` of the selected pair; else `remote-inbound-rtp.roundTripTime` of a published track                              |
| `playoutMs`       | Audio playout after the jitter buffer, the mean over the window                                                 | Δ`totalPlayoutDelay` / Δ`totalSamplesCount` of `media-playout`. Chromium only                                                                         |
| `partial`         | `true`: sound was received and its playout is unknown, so a figure built on this block is a floor               | Set by the sampler                                                                                                                                    |
| `send.videoMs`    | This participant's camera, from a frame entering the encoder to its packets leaving, plus half a frame interval | Δ`totalEncodeTime` / Δ`framesEncoded` + Δ`totalPacketSendDelay` / Δ`packetsSent` over every `outbound-rtp` layer, + 500 / `framesPerSecond` (else 30) |
| `from[]`          | At most 8 senders this participant receives, each once                                                          |                                                                                                                                                       |
| `from[].identity` | The sender's room identity, 1 to 128 characters                                                                 | The room                                                                                                                                              |
| `from[].audioMs`  | The audio jitter buffer's mean delay for that sender's microphone                                               | Δ`jitterBufferDelay` / Δ`jitterBufferEmittedCount` of `inbound-rtp`                                                                                   |
| `from[].videoMs`  | First packet received to decoded, the mean for that sender's camera                                             | Δ`totalProcessingDelay` / Δ`framesDecoded` of `inbound-rtp`                                                                                           |

Rules for whoever makes one:

- One sample per 10 s (`LATENCY_SAMPLE_MS`), never faster, and never on a 50 ms or 1 s timer.
- Deltas over the window, never session totals. The first sample has nothing to subtract from and makes no block. A counter that did not move, or a track that appeared inside the window, gives no part. A window under a second or over a minute (the page slept) makes no block. After a reconnect the sampler forgets its last reading: the new connection's counters start again.
- One implementation does this for all three: `NetSampler` in the shared module, given the tracks of the moment and a monotonic clock.
- Camera and microphone tracks only. A shared screen is not conversation.
- The sampler reads `transport`, `candidate-pair`, `inbound-rtp`, `outbound-rtp`, `remote-inbound-rtp` and `media-playout` entries. It never reads `local-candidate` or `remote-candidate` (D12): no IP address, candidate address or device name is in a block.

Rules for whoever reads one (`parseNetBlock`):

- A key the reader does not know is left out, at every level. It is never stored or relayed.
- A known key with a bad value (a fraction, text, `null`, out of bounds, nine senders, a sender twice) refuses the whole block. The block is dropped. The heartbeat or beacon that carried it is still answered as if it had none.
- What is relayed is the block rebuilt field by field, never the sender's own object.

## 3. Who reports, and how it reaches the host (D3)

| Participant         | Makes a block from                                          | Sends it                                                        |
| ------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| Guest `g_…`         | The host's and the other guests' tracks, and its own camera | `net` beside `capability` in `POST /api/guest/:slug/media` (S2) |
| Program page `EG_…` | The tracks it draws and mixes                               | `net` in its beacon (S3)                                        |
| Host `host:<show>`  | The guests' tracks and its own camera                       | Nowhere. It is the reader                                       |

The web checks each block and relays it to `host:<show>` only, with `RoomServiceClient.sendData` (reliable) on the topic **`videorc.latency.v1`**:

```json
{
  "v": 1,
  "identity": "g_…",
  "at": 1794000000123,
  "net": { "v": 1, "windowMs": 10000, "rttMs": 42 }
}
```

- `identity` comes from the guest's session cookie or the page token's egress, never from the body.
- `at` is the web's receive time (section 1).
- One relay per sender per sample: a block is relayed only when 9 s (`LATENCY_RELAY_MIN_INTERVAL_MS`) have passed since that sender's last relayed one. It is the 10 s sample less a second, because two requests sent 10 s apart can arrive a little closer than that, and a strict 10 s would drop every other one. A block inside the 9 s is not relayed, and its request is still answered. A sender attaches each sample to one request only.
- Nothing is stored on the web. No new grant, route or table.
- A failed relay never changes the answer of the heartbeat or the beacon.

The host reads the topic only from the server: a message with a participant as its sender is ignored, as with `videorc.privacy.ack.v2`. A message over 4096 bytes is ignored. A guest's block counts only while that identity is in the room.

In a beacon, `net` is not in the change key, so it never causes a beacon: it rides whichever goes next. Over 4 KiB the beacon drops `net` first, before `shown`.

## 4. The sum (D2)

A one-way path through the room, sender S to receiver R:

`delay(S→R) = send(S) + rtt(S)/2 + sfu + rtt(R)/2 + buffer(R, S's track) + playout(R)`

| Part      | Sound                                                   | Picture               |
| --------- | ------------------------------------------------------- | --------------------- |
| `send`    | The constant `SEND_AUDIO_MS`                            | S's `send.videoMs`    |
| `rtt`     | Each end's `rttMs`                                      | The same              |
| `sfu`     | The constant `SFU_MS`                                   | The same              |
| `buffer`  | R's `from[S].audioMs`                                   | R's `from[S].videoMs` |
| `playout` | R's `playoutMs`. Absent: 0, and the figure is `partial` | None                  |

The sum is rounded once, to a whole millisecond.

| Number                        | Definition                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation delay, per guest | `delay(host→G)` and `delay(G→host)`, sound. The row's number is the larger. With one direction missing it is the other, marked `partial`. With both missing there is no number                        |
| Its picture, for the record   | The same two paths for the cameras. Kept beside the number, never on the row                                                                                                                          |
| Program delay                 | `delay(host→page)` for the picture, plus `PAGE_DRAW_MS`. No number without the picture's path (the host's camera is off, or the page decodes none). The sound's path is kept beside it for the record |
| Guest to guest                | Falls out of the same parts (each guest reports its buffer per sender). Not computed by the host's model in v1                                                                                        |

With two program pages (wide and tall, or a separate recording page) the slowest one is the program's number.

**What the sum cannot see**: a hop between LiveKit regions, an asymmetric route (`rtt/2` assumes the two ways are equal), the speaker, the room and the microphone's own hardware delay.

## 5. Constants

| Name                            | Value                | Meaning                                                                      |
| ------------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| `LATENCY_TOPIC`                 | `videorc.latency.v1` | The relay's room data topic                                                  |
| `LATENCY_SAMPLE_MS`             | 10000                | One sample per participant                                                   |
| `LATENCY_RELAY_MIN_INTERVAL_MS` | 9000                 | The least time between two relays of one sender                              |
| `LATENCY_TTL_MS`                | 25000                | A block is current this long after it arrived. Then its numbers go away      |
| `SEND_AUDIO_MS`                 | 40                   | Capture, one 20 ms Opus frame, packetizing. No stat exists. Calibrated in S5 |
| `SFU_MS`                        | 5                    | Forwarding inside one LiveKit region. Calibrated in S5                       |
| `PAGE_DRAW_MS`                  | 33                   | The page's draw: two frames at 60 fps (its double rAF). Calibrated in S5     |
| `NET_MAX_MS`                    | 60000                | The bound of every duration                                                  |
| `NET_MAX_SENDERS`               | 8                    | The length of `from`                                                         |
| `LATENCY_RELAY_MAX_BYTES`       | 4096                 | The largest relayed message the host reads                                   |

The 25 s rule: a block older than `LATENCY_TTL_MS` gives no number, and neither does any block once the host's own sample is that old. A number goes away. It never goes stale on screen.

## 6. Stage applied (D8, built in S3)

How long the program page took to draw a stage the web accepted. One clock, the web's: the page contributes only an age.

- The web stores `stageSetAt` (its own time when the `PUT …/stage` request arrived) and `stageSetKey` (the stage's content key) in the show's state. They move only when the key changes: a stage sent again unchanged is not drawn again, so its time stays the first one's.
- The page's beacon gains `shown.appliedAgoMs`: how long before this beacon, on the page's monotonic clock, it first drew the stage whose key is `shown.stage`. A whole number of ms, 0 to 86400000, worked out at the send. It is sent only with `shown.stage`. It is not in the beacon's change key. A value the web cannot use is dropped and never refuses the beacon.
- The state answer gains `room.shown.applyMs` = the beacon's receive time − `appliedAgoMs` − `stageSetAt`, never below 0, and only while the page's `shown.stage` equals `stageSetKey`. Right after a new stage is accepted there is no `applyMs` until the page says it drew that stage.
- `applyMs` includes the beacon's own trip from the page to the web (the receive time is taken at the web), so it reads a little high. A later heartbeat of the same draw gives the same figure give or take that trip.
- It is not material: `materialOf` leaves it out, so it never moves `rev`.
- An older page sends no `appliedAgoMs`, and then there is no `applyMs`. The page's age itself never reaches the desktop.
- The desktop reads it since S7: Rust `CloudRoomShown.apply_ms`, a whole number of ms up to 86400000. Any other value (`null`, text, a fraction, a negative, a larger one) is dropped, and the state that carried it is read as if it had none. The renderer's strict schema holds the same bound. The backend keeps one sample per drawn stage in the record (section 10). No UI shows it.

## 7. Node shows

Not supported in v1 (D10), and nothing is drawn for them: no number, no chip, no "not available" line. The runner composes natively, sends no beacon, and its guests' reports would need its own relay. The gate is `isManagedShow()`. Do not port half of this to the runner.

## 8. Compatibility (D11)

| Pair                                    | What happens                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| New web, old desktop                    | The topic is unknown to the old room client: ignored                          |
| Old web, new desktop                    | No relays arrive: no numbers. The row's dot still reads LiveKit's own quality |
| A guest page loaded before the deploy   | No `net` from that guest: no number for them until they reload                |
| A program page loaded before the deploy | No `net`, no `appliedAgoMs`: no program number, no `applyMs`                  |
| Old web, new guest or program page      | `net` is an unknown key to the old routes: ignored                            |

## 9. Tests

- Desktop: `pnpm --filter @videorc/desktop test -- room-latency.test.ts`
- Web: `node --import tsx --test tests/room-latency.test.ts`

Both read `room-latency.json` (the web's is a byte copy in `tests/fixtures/`): the block cases, the relay cases, the sampler's arithmetic on canned stats reports, and the room cases with their missing-part, `partial` and stale variants.

The record (section 10):

- Backend: `cargo test -p videorc-backend cloud_latency` (minute folding, the report's bounds, the slow-command event, the status byte for byte without latency, the record deleted with its show) and `cargo test -p videorc-backend the_rooms_latency_report_is_renderer_only`
- Desktop: `pnpm --filter @videorc/desktop test -- room-latency-report.test.ts room-latency-host.test.ts cloud-program-health.test.ts`

## 10. The record (S7)

The renderer computes, the backend remembers (D4). Desktop only: nothing here is sent to the web, and the web stores nothing.

### The report

After each 10 s sample the host's room client hands the backend what it holds, as the RPC **`cloud.room.latency.report`** (renderer role only; main, remotes and agents are refused):

```json
{
  "showId": "sh_…",
  "hostRttMs": 30,
  "people": [
    {
      "identity": "g_…",
      "name": "Ada",
      "ms": 161,
      "partial": false,
      "toGuestMs": 160,
      "fromGuestMs": 161,
      "videoToGuestMs": 150,
      "videoFromGuestMs": 142
    }
  ],
  "program": { "ms": 112, "audioMs": 109 }
}
```

- Durations only, whole ms, 0 to 60000 (D1). A figure that was not measured is left out, never `null`. With nothing measured no report is sent.
- At most 16 people, each identity once, never `program` or `control`. `name` is the name the guest joined with, cut to 80 characters.
- Strict at both ends: the renderer's contract and the backend's parser each refuse an unknown key, a fraction or a value out of bounds, and a refused report keeps nothing.
- Once per sample, never for a relay alone. A report that fails is not sent again: the next sample is.
- The answer is `{ "kept": true }` when the show is the managed talk show this computer holds a room of. For any other show, a node show or no room it is `{ "kept": false }` and nothing is kept (section 7).
- The backend never sends it on as `cloud.state`.

### Command time and stage apply (D8)

- **Command time.** The backend times every intent it sends the web (`stage.set`, `destinations.set`, `legs.end`, `recording.start`, `recording.stop`, `hold.image.set`) on its own monotonic clock, from the send to the answer, a failure or the deadline. An intent with no route on web control sends nothing and is not timed.
- A command of 2000 ms or more (`SLOW_COMMAND_MS`) writes a `health_events` row with the code **`cloud-command-slow`**, level warn: "Videorc Cloud took 3.4 s to answer stage.set (3412 ms)." It carries the show's session once the show has a Library entry.
- `CloudStatus.commandTimes` `{ lastMs, slowestMs }` is the last and the slowest command of the show this computer holds. It is absent until a command of a managed talk show was timed, and it is the Health page's **Commands** row (Normal, or Slow when the last one took 2 s or more). It is a stopwatch on this computer's own requests, not one of the summed figures of section 4.
- **Stage apply.** `room.shown.applyMs` (section 6) is one sample per stage the page drew: a later state answer for the same stage is not counted again.

### The table

`cloud_latency_minutes` in the app's database (`storage/cloud_latency.sql`), one row per show, minute, subject and kind:

| Column                       | Meaning                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `show_id`                    | The show                                                                            |
| `minute`                     | Unix time / 60, on this computer's clock. It says when the row was written, no more |
| `subject`                    | A room identity (`g_…`, or `host:<show>`), `program` or `control`                   |
| `kind`                       | The figure, below                                                                   |
| `name`                       | The name a guest joined with. On this computer only (D12)                           |
| `p50_ms`, `p95_ms`, `max_ms` | The minute's median, 95th percentile (nearest rank) and worst                       |
| `samples`                    | How many samples the minute holds: up to six reports, or one per command            |
| `partial`                    | How many of them are a floor (a part or a direction was missing)                    |

| Subject       | Kind                                    | Figure                                                         |
| ------------- | --------------------------------------- | -------------------------------------------------------------- |
| A guest       | `conversation`                          | The conversation delay: the worse direction (the row's number) |
| A guest       | `to-guest`, `from-guest`                | Each direction of the sound                                    |
| A guest       | `video-to-guest`, `video-from-guest`    | Each direction of the picture, for the record                  |
| `host:<show>` | `rtt`                                   | The host's own round trip to the room                          |
| `program`     | `picture`, `sound`                      | The program delay, and its sound's path                        |
| `program`     | `stage-apply`                           | `room.shown.applyMs`, once per drawn stage                     |
| `control`     | The intent (`stage.set`, `legs.end`, …) | The command time                                               |

- The backend holds the open minute's samples and writes the row again at each report, so the record is never more than one sample behind. After a backend restart inside a minute, that minute's row holds only the samples since the restart.
- **Deleted with its show** (D12). A show's Library entry is the `sessions` row with the show's id, and deleting it deletes the show's minutes (a trigger, because a room measures before it is live or recording, when that row does not exist yet). A room that never went live or recorded has no Library entry: its minutes are deleted 30 days on, at the next launch.
- These numbers are the model's until S5 proves them: the constants of section 5 are not calibrated yet.

### Reading it after a show

With the app's database (macOS: `~/Library/Application Support/Videorc/videorc.sqlite3`), read only. The last show's figures, each as its typical and worst minute:

```sh
sqlite3 -readonly ~/Library/Application\ Support/Videorc/videorc.sqlite3 "
  SELECT COALESCE(name, subject) AS who, kind, COUNT(*) AS minutes,
         CAST(AVG(p50_ms) AS INTEGER) AS typical_ms, MAX(max_ms) AS worst_ms, SUM(partial) AS floor_samples
  FROM cloud_latency_minutes
  WHERE show_id = (SELECT show_id FROM cloud_latency_minutes ORDER BY minute DESC LIMIT 1)
  GROUP BY subject, kind ORDER BY subject, kind"
```

Minute by minute, replace the `SELECT` list with `time(minute * 60, 'unixepoch', 'localtime'), COALESCE(name, subject), kind, p50_ms, p95_ms, max_ms, samples, partial` and drop the `GROUP BY`. The slow commands of any show: `SELECT created_at, message FROM health_events WHERE code = 'cloud-command-slow' ORDER BY created_at`.
