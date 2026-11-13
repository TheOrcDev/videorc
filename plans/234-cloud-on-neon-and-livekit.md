# Plan 234: Videorc Cloud on Neon and LiveKit, with no media servers of our own

> **Executor instructions**: this plan swaps the part of Videorc Cloud that
> runs on our own Linux servers (the runner, the node agent and MediaMTX)
> for LiveKit Cloud's managed Ingress and Egress. Neon and the web control
> plane stay. Read `AGENTS.md` and `CLAUDE.md` from `origin/main`, then
> plans [184](184-videorc-cloud.md), [222](222-cloud-solo-shows-for-premium.md)
> and [224](224-guests-from-a-link.md) for the product rules this plan must
> keep.
> - **Phase 0 decides.** No product code starts before the Phase 0 report
>   and the owner's answer at gate G0.
> - Work in your own worktree, never in the shared checkout.
> - Write and commit every slice of a phase first. Run the Rust compile,
>   the tests and the smokes once, at the end of the phase.
> - Never go live on a real channel unless the owner asks in the session.
> - Never flip a launch switch. The owner does.
> - This repo is public: no prices, costs or margins here. They live in the
>   private plan 185 (web repo, `docs/plans/185-videorc-max-tier.md`).

## Status

- **Status**: PHASE 0 RUN 2026-11-13; stopped at gate G0. No product code
  exists. The next section has Phase 0's results. The owner's answer to
  Open question 9 decides whether Phase 1 starts.
- **Priority**: P1. Videorc Cloud is merged and released (0.25.0) with every
  switch off, and it can't be switched on: there is no media server and no
  account to rent one on.
- **Effort**: L to XL. Phase 0 about 1 agent-week; the web about 2 to 3;
  the desktop about 2; talk shows about 3 to 4.
- **Risk**: HIGH.
  - Picture quality: the stream is encoded three times instead of twice.
  - Cost per show-hour is metered and higher than a rented server's
    (private; D19).
  - Platform stream keys reach videorc.com and a second company (D7).
  - One vendor carries every cloud show.
- **Planned at**: desktop `origin/main` `91c06e86d` (0.25.0); web `main`
  `acc7c54d`; runner `main` `bf544f4a` (source tagged `v0.1.0`).
- **Route**: Orchestrator (fit 10, `fable-5.1`) owns Phase 0, the seam
  design, every merge and the review passes. Each phase names its own
  route and lane.

## Phase 0 results (2026-11-13)

The note is `docs/cloud/spike-livekit-managed-2026-11.md`. Phase 0 ran on
the production LiveKit project, which is empty. Nothing went to a real
platform, and every stream key was made up.

| Kill question | Bar | Measured | Verdict |
| --- | --- | --- | --- |
| S0.1 quality, 1080p30 | Within 3 VMAF points of the node path | 8.6 and 8.9 under with the settings this plan first named. 2.7 and 2.8 under with D4 as it now stands, keyframes matched, two clips | Pass, narrowly |
| S0.2 hold | Card within 3 s; picture back within 5 s | Card at 2.8 s. Back 6.2 s after a re-push (one sample) | **The return misses by 1.2 s** |
| S0.4 keys | Only the redacted key anywhere we can see | True for the six platform shapes. Four custom shapes leak | Pass with D7's guard; LiveKit's written answer is owed |
| S0.5 recording | Every segment lands; the MP4 plays | 23 recordings, no segment missing | Pass; the 3 h 10 min run is not run |

Three things the bars did not cover:

- **Frames.** The node path drops none. LiveKit's recorder captures the
  page on its own clock. Recorded at 30 fps, 1 to 5 source frames in 100
  never reach the stream, depending on the page (3.0 and 4.2 with the
  last version). Recorded at 60 fps, 0.7 in 100 are lost (one run). D4
  now records at 60 fps.
- **60 fps feeds** fail their bar: 1.3 and 2.0 frames in 100 dropped or
  repeated. D12's cap stands.
- **The LiveKit project is on the entry plan**: two ingress objects,
  which is one solo show with both orientations, and a monthly transcode
  allowance that is a hard cap (D13).

**The plan stops here for the owner** (STOP conditions). The return bar
failed, and the lost frames are a product call: Open question 9.

Still to run, in the note's "Not run" list: destinations (S0.3), the
talk-show page on LiveKit (S0.6), and the long runs.

## The owner's ask (2026-11-13)

> "plan out Neon + LiveKit managed media"

It follows three earlier calls:

- 2026-11-08: "we don't want to use hetzner", then "Neon is now the whole
  backend, they have everything". Plan 221 U8 answered with Neon plus a
  rented VM for media.
- 2026-11-12: recordings go to Neon Object Storage, not Cloudflare.
- 2026-11-13: production was provisioned up to the VM. Neon storage and the
  LiveKit project are live. The VM never came, and the owner asked what
  could replace it. A check showed Neon alone can't run live media
  (plan 221 U8), and that LiveKit's managed services could.

## What a streamer gets

The same promises as plans 222 and 224. The table lists only what differs.

| | Today's design (our server) | This plan (managed) |
| --- | --- | --- |
| The stream never drops | Be right back after 1.5 s; picture back about 1 s after the feed | Same timings, drawn by a web page instead of the runner (D5). Phase 0 must prove them |
| Upload once | One feed per orientation | Same |
| Longest show | 12 hours plus the hold | 12 hours in all (D12) |
| Highest quality | 1080p60 | 1080p30 until Phase 0 proves 60 (D12) |
| Guests from a link | Composed by the runner | Composed by the same web page (D6) |
| Program monitor | The runner's real return picture | The Show stage, drawn locally (D6) |
| Cloud recording | MP4 files | Segments on Neon; the desktop makes the MP4 (D10) |
| Go Live to on air | About 5 s | Unknown; Phase 0 measures it (S0.8) |

## Words we use

- **Managed media**: LiveKit Cloud's rooms, Ingress and Egress. We call
  their API; we run no process of our own.
- **Ingress**: the address the desktop's feed goes up to. One per
  orientation.
- **Egress**: LiveKit's export job. It opens a web page in Chrome, encodes
  what the page shows, and sends it to the platforms. One per orientation.
- **Program page**: our web page that the egress opens. What it draws is
  what viewers see. It replaces the runner's compositor.
- **Feed**, **destination** (a **leg**), **hold**, **Be right back**: as in
  plans 184 and 222.
- **Node path**: today's design, with the runner on our own server.

## How it works

```
Solo show
  desktop ──RTMPS feed──► Ingress ──► room <showId> ──► Egress (program page) ──RTMP(S)──► YouTube, Twitch, …
     │                                                        │
     └──HTTPS: create, destinations, state, end──► videorc.com ◄──webhooks── LiveKit
                                                       │      ◄──beacons──── program page
                                                     Neon (Postgres, Object Storage)

Talk show
  host (desktop renderer) ─┐
  guests (browser)        ─┴─► room <showId> ──► Egress (program page) ──► platforms
                                                        └──segments──► Neon Object Storage
```

- The desktop no longer opens a control socket to a server of ours. It
  asks videorc.com over HTTPS, and videorc.com calls LiveKit.
- The program page shows the host's feed full-frame in a solo show, and
  draws the stage in a talk show. When the feed stops it shows Be right
  back, and the egress keeps every platform connected.
- LiveKit tells videorc.com what happens through webhooks. The program
  page tells it what viewers see through small signed posts ("beacons").

## What exists (facts)

### Production on 2026-11-13

- Desktop #727, web #85 and runner #1 are merged. 0.25.0 ships the cloud
  code. `VIDEORC_CLOUD_DISABLED`, `VIDEORC_CLOUD_TALK_SHOWS_DISABLED` and
  `VIDEORC_CLOUD_PUBLIC` are off or unset, so no user reaches any of it.
- **Neon**: the recordings project exists, with an empty storage parent and
  one private bucket per show on a child branch. Upload, download, access
  isolation and clean-up passed with a small real MP4.
- **LiveKit Cloud**: one production project, EU data region, server and
  webhook keys set in Vercel. The webhook reaches
  `/api/cloud/livekit/webhook` and is filtered to four events:
  `participant_joined`, `participant_left`,
  `participant_connection_aborted`, `room_finished`.
- **No media server exists**: no VM, no DNS record, no certificate.

### What our server does today (runner `v0.1.0`)

| Job | How |
| --- | --- |
| Take the feed | MediaMTX, RTMPS (SRT built, unused by the desktop), one path per orientation, an auth hook |
| Hold | A constant output clock. No frame for 1.5 s: freeze 1 s, fade 300 ms to the card. Back after 1 s of steady feed. Ends at the hold limit (default 30 min) |
| Encode | x264 CBR once per orientation, 2 s keyframes, AAC |
| Send | One FFmpeg remux per destination; backoff 1 to 30 s; `failed` after 20 tries; keys in memory, kept out of process arguments |
| Talk shows | Joins the room as `runner:<showId>`, draws four layouts, name plates, the away plate, PNG overlays, a limiter; publishes a return picture only the host may see |
| Record | Talk shows only. Fragmented MP4 per orientation, new file before 10 GiB, S3 multipart to the show's Neon branch |
| Report | `state` on a WSS control socket at least every 2 s: phase, hold, feeds, legs, the program checks (silent, black, frozen, A/V skew), room, recording |
| Count | Live and hold seconds per show, posted every 60 s |
| Survive | Runner crashes resume in hold; agent restarts adopt running shows |

### What assumes that server

- **Web** (`lib/cloud/`): the node registry and placement, HMAC node
  signatures, `agent-client.ts`, the heartbeat and usage routes, the `vcs1`
  show token (it names a node), the reaper's health probes, the `lost`
  probe, `cloud_shows.node_id NOT NULL`, the runner's LiveKit grant, the
  recording-finished route, the cost inputs and the owner's node panel.
- **Desktop**: the control socket client in `cloud_show.rs` (`hello`,
  `welcome`, `state`, `ack`, intents), `ingest.get` on Resume, the PNG
  intents in `cloud_talk.rs`, the `runner:` filters and the return
  subscription in `talk-show-room.ts`, and both smokes, which start the
  real runner.
- **What does not assume it**: the feed itself (an RTMPS FLV leg per
  orientation with certificate checking), `CloudStatus`, every RPC name,
  the watchdog's inputs, and every UI surface.
- `CloudStatus.show.nodeId` is a required string in
  `backend-rpc-contract.ts`. A managed show must still send one.

## Outside facts (checked 2026-11-13)

Sources: LiveKit's docs (ingress, egress, custom templates, outputs, API
reference, quotas and limits, EU data residency, region pinning, pricing)
and the open-source `livekit/egress` and `livekit/protocol` code. LiveKit
Cloud may differ from the open-source code; Phase 0 checks every item
marked ◇.

### Ingress

- Takes RTMP or RTMPS pushes and WHIP. SRT is pull-only, so the SRT path
  (C1b) has no place here.
- RTMP input is always transcoded. WHIP is forwarded untouched by default.
- An RTMP ingress is reusable: after a disconnect it stays valid and takes
  the same stream key again. `ListIngress` returns its URL, key and state.
  Phase 0: a re-push reaches the room about 4.8 s after it starts.
- Phase 0: a closed connection is seen in about 1 s. A network that goes
  silent keeps the feed's participant in the room for at least 59 s.
- Encoding is a preset or custom layers (size, frame rate, bitrate).
  Phase 0: `H264_HIGH` as a layer's codec is refused, and a 16 Mbps layer
  is accepted and then never starts.
- Webhooks: `ingress_started`, `ingress_ended`.

### Egress

- `StartEgress` with a `TemplateSource` opens a web page of ours
  (`custom_base_url`) in headless Chrome, as a hidden participant that only
  subscribes. The page gets `url`, `token` and `layout` in its query and
  logs `START_RECORDING` and `END_RECORDING`.
- It ends by itself when the room closes.
- One egress encodes once and can carry one stream output (many URLs), one
  segments output, one file output and image outputs.
- `UpdateStream` adds and removes URLs on a running egress, if it was
  started with a stream output (the URL list may start empty).
- Presets: 720p and 1080p, 30 and 60 fps, landscape and portrait.
  Phase 0: the 1080p30 preset encodes H.264 Main at about 4.4 Mbps with
  44.1 kHz audio. Advanced options take High, a bitrate and 48 kHz.
- **Limits**: a file output ends after 3 hours; segments and RTMP after 12
  hours. A hit limit ends the egress with `LIMIT_REACHED`.
- **A failing destination** (open-source code ◇): the egress retries a
  stalled stream for 30 s, then marks it `FAILED` and removes it. Other
  outputs carry on. If it was the last output, the whole egress fails.
  Phase 0: a destination that cannot resolve fails at once, with no
  retry, and the others carry on.
- **Stream keys** (open-source code ◇): every stored or returned
  `EgressInfo` has its stream URLs redacted to `{abc...xyz}`, the first and
  last three characters of the key. S3 credentials are replaced whole.
  Phase 0: true for the six platform shapes. A URL with one path segment,
  or with the key in a query value, is refused, and the error repeats
  the URL. Four shapes are accepted and leak the key (D7).
- Webhooks: `egress_started`, `egress_updated`, `egress_ended`.
- Egress API calls need a `roomRecord` token. That grant is project-wide,
  not per room (Phase 0), so it must never reach a desktop.

### Rooms

- `empty_timeout` (default 300 s) closes a room nobody joined.
  `departure_timeout` (default 20 s) closes it after the last participant
  leaves. Egress participants don't keep a room open (Phase 0).
- Room metadata is shared with every participant, including late joiners.

### Regions and data

- The EU data region covers analytics and logs. Media takes the shortest
  path and "can transit servers outside the EU without being stored
  there". Pinning media to a region needs the Scale plan.
- Egress routes to a server near the RTMP endpoints.

### Pricing shape (figures in plan 185)

- Ingress and egress are billed per transcode minute. A solo show uses two
  per orientation (in and out); a talk show uses one per orientation.
- An import that isn't transcoded (WHIP) is free.
- Whether RTMP output counts as metered data transfer is not stated ◇.
- Plans cap concurrent imports and exports. The entry plan allows two of
  each, and its monthly transcode allowance is a hard cap: requests fail
  once it is used.

### Neon Object Storage

- S3-compatible: SigV4, path-style, multipart. LiveKit's S3 fields match
  (`endpoint`, `bucket`, `access_key`, `secret`, `region`,
  `force_path_style`). Phase 0: LiveKit uploads to a Neon branch with a
  write-only credential.
- 10 GiB per object. Bucket lifecycle rules are accepted and not enforced,
  so our own clean-up stays.

### FFmpeg

- The macOS build (8.1.1, OpenSSL) carries the WHIP muxer, and LiveKit
  takes H.264 High from it (Phase 0). The build has no libopus, which a
  WHIP feed needs. The Windows and Linux prebuilts are unchecked.

## What gets simpler, and what we give up

**Simpler**

- No server to rent, patch, monitor, update or scale. No DNS, certificate,
  firewall, SSH key, Prometheus or self-update.
- No capacity planning: a show never competes with another for a CPU.
- No echo risk: the egress publishes nothing into the room.
- Guests could publish H.264; Chrome decodes it.
- Cloud costs follow use. A month with no shows costs the base plan only.

**Given up or weaker**

| What | Why | Answer |
| --- | --- | --- |
| One more encode | Feed → ingress → page → egress | 2.7 to 2.8 VMAF points (S0.1); D4 |
| Every frame | The recorder captures the page on its own clock | D4 records at 60 fps; about 0.7 in 100 are still lost |
| A fast return | LiveKit takes about 5 s to restart the ingress | D5 |
| Go Live in 5 s | The chain takes 5 to 7 s and runs 2.3 s behind the feed | S0.8 |
| "The key never reaches videorc.com" | Only our server may call the Egress API | D7, owner |
| "A Videorc media server in the EU" | LiveKit is the processor; media isn't pinned | D14, owner |
| The real return picture | The egress publishes nothing | D6 |
| A/V skew check | The page can't measure it | D15 |
| SRT feed (C1b) | Ingress can't take an SRT push | Dropped |
| Per-destination retry for minutes | LiveKit gives up after 30 s | D9 |
| Shows past 12 hours with holds | Egress limit | D12 |
| Cheap hours | Metered per minute | D19, owner |

## Decisions (⚑ = owner may override)

### D1. Managed media replaces the VM in plan 221 U8, if Phase 0 passes

- Media runs on LiveKit Cloud. Data, storage and the control plane stay on
  Neon and videorc.com. That is the whole stack.
- This plan doesn't touch the product rules of plans 184, 222, 223 and 224.
  Where it can't keep one, it says so and asks.

### D2. A seam, not a rewrite ⚑

- **Web**: `lib/cloud/media/` gets one interface with two providers, `node`
  (today's code, moved) and `livekit`. `VIDEORC_CLOUD_MEDIA` picks the
  provider for new shows (`livekit` or `node`; unset means `node`). Each
  show stores its provider.
- **Desktop**: `cloud_show.rs` gets a control transport with two kinds: the
  node socket (today) and web control (new). The create answer says which.
- The node path stays compiled and keeps its smokes until the owner retires
  it in a later plan. It costs little to keep, and it is the way back if
  the hours outgrow the meter (D19).

### D3. Phase 0 answers eight questions before anything is built

Each has a pass bar in Phase 0. A fail on S0.1, S0.2, S0.4 or S0.5 stops
the plan, or sends it back to the owner with the measured gap.

### D4. Solo shows: feed → ingress → room → egress

- **Create**: the web makes room `<showId>` (`empty_timeout` 120 s,
  `departure_timeout` = the hold limit), and one RTMPS ingress per
  orientation, identity `feed-h` or `feed-v`, transcoded to a single
  1080p layer at 12 Mbps and the feed's frame rate, codec left to LiveKit.
  At 8 Mbps the picture loses 2 VMAF points (S0.1).
- **Hand-over**: the desktop sends its destinations. The web starts one
  egress per orientation: a `TemplateSource` on the program page with
  `layout` `h` or `v`, advanced encoding options, and the destination
  URLs.
- **Encoding**: H.264 High, 6 Mbps, 60 fps, a keyframe every 2 s, AAC at
  48 kHz. Not the preset, which costs 3 to 4 VMAF points (S0.1).
- **Why 60 fps for a 30 fps feed**: the recorder captures the page on its
  own clock. Recorded at 30 fps, 1 to 5 source frames in 100 never reach
  the stream. Recorded at 60 fps, 0.7 in 100 are lost and 88 in 100 are
  shown exactly twice (one run). Quality is the same.
- **On air**: the page logs `START_RECORDING` at the feed's first decoded
  frame, so no platform ever sees a card before the show. A platform gets
  its first frame 5 to 7 s after the feed starts, and the stream runs
  about 2.3 s behind the feed (S0.8).
- The desktop's feed is the leg it already has: RTMPS, FLV, certificate
  checked. Only the address and key change.

### D5. The hold is drawn by the program page

- The page copies the switcher's timings: no new frame for 1.5 s, freeze
  for 1 s, fade 300 ms to the card, silence. Back after 1 s of steady
  frames, with a 300 ms fade.
- **Measured**: the card is up 2.8 s after the last frame. The picture is
  back 6.2 s after a re-push, against about 2 s on the node path. LiveKit
  takes 4.8 s to restart the ingress; the page's wait and fade are the
  other 1.3 s (one sample; Open question 9).
- The card is HTML: "Be right back" in Noto Sans 500 on `#0D0D0F`, per
  plan 184's card. A custom image replaces it (W6).
- **The hold limit is the room's `departure_timeout`.** When the feed's
  participant has been gone that long, LiveKit closes the room and the
  egress ends cleanly (measured: 124 s at a 120 s timeout).
- The timeout only starts when the participant has left. A closed
  connection is seen in about 1 s, but a network that goes silent keeps
  the participant for at least 59 s. So the reaper also ends a show whose
  feed is present and silent past the hold limit.
- The reaper still ends a show that never got a feed (60 s) and one past
  its limit.

### D6. Talk shows: the program page is the compositor ⚑

- No ingress and no `runner:` participant. Host and guests join as today.
- The page draws the four layouts (`solo`, `side-by-side`,
  `screen-people`, `spotlight`) from `protocol-fixtures/talk-show-layout.json`,
  with name plates, the host's circle, the away plate, and the 300 ms
  crossfade. Audio goes through a limiter at −1 dBFS: an AudioWorklet
  with a 5 ms look-ahead, because a compressor node lets peaks through
  (S0.6). Its path adds about 37 ms to every voice, out of the 80 ms
  lip-sync budget.
- **Stage state is room metadata**, set by the web when the desktop calls
  `PUT …/stage`. It survives the host leaving and a page reload, and no
  guest can forge it. Guests read the same metadata.
- **Overlays** (comment cards, takeovers, the host's hold image) go from
  the host's renderer to the page as LiveKit byte streams. Nothing is
  stored. The page accepts them only from `host:<showId>`.
- **No return picture.** The Program monitor shows the Show stage, which
  draws the same geometry locally. `cloud.return.set` answers "not
  available" on a managed show.
- The egress starts when the host goes live or records, not when the room
  opens.

### D7. Stream keys: through videorc.com in memory, then to LiveKit ⚑ OWNER

- The desktop sends destination URLs to videorc.com over TLS. The web
  passes them to `StartEgress` or `UpdateStream` in the same request and
  forgets them. It never writes one to the database or a log.
- **A URL LiveKit wouldn't redact is refused** before it is sent. The web
  carries the same pattern LiveKit uses, with a test per platform
  (YouTube, Twitch, Kick, X, Facebook, custom).
- **The guard is stricter than LiveKit's pattern** (S0.4). It also refuses
  a trailing slash (LiveKit shows the whole key), user info (the
  password), a key so short that the six characters LiveKit shows are
  most of it, any scheme but `rtmp` and `rtmps`, and any URL LiveKit
  itself would refuse, because its error repeats the URL.
- To match LiveKit's results to our destinations, the web stores an HMAC
  of each redacted URL, keyed with a server secret. It stores no part of a
  key.
- **What changes**: today the key goes from the desktop to our media
  server and "never reaches videorc.com". Here it passes through
  videorc.com's memory, and LiveKit holds it for the show. LiveKit's
  records keep the first and last three characters.
- This touches plan 184 D15, plan 222 Y2, the legal copy and the YouTube
  answer. **It is a STOP until the owner says yes** (Open question 1).

### D8. The control socket becomes HTTPS, and `state` keeps its shape

- New routes replace the intents (Wire shape). `GET …/state?since=<rev>`
  is a 25 s long-poll, like the guests list.
- The web builds the same `state` the runner sent, so `CloudStatus`, the
  strict contract, the watchdog and every UI surface stay as they are:

| Field | Source |
| --- | --- |
| `phase`, `hold` | The page's beacons; `ingress_ended` as the fallback after 5 s |
| `feeds[]` | `ingress_started` / `ingress_ended`; `kbps` from `ListIngress`, cached 2 s |
| `legs[]` | `stream_results` in `egress_updated` and `egress_ended`, matched by the HMAC. `ListEgress` fills only the older `stream.info` and `result.segments`, so the reconcile reads both |
| `liveSeconds` | Since the first on-air beacon |
| `desktopConnected` | A state poll in the last 15 s |
| `destinationsSet`, `restarts` | Whether an egress is active; how many were started |
| `program` | The page's beacons (D15) |
| `room`, `recording` | Webhooks, room metadata, egress segment results |

- `show.nodeId` is sent as `"livekit"`.
- A stream that reads `FAILED` because its room closed is not a dead
  destination (S0.3).

### D9. Failures: who recovers what

- **A destination drops**: LiveKit reports it failed. That is at once if
  the address cannot resolve, and after LiveKit's own retries if a live
  connection dies (30 s in the open-source code; S0.3 measures it). The
  watchdog's Reconnect re-sends that URL, and the web adds it back with
  `UpdateStream`.
- **The last destination fails, or the egress dies**: the egress is gone.
  `state` shows no legs and `destinationsSet: false`, and the desktop
  re-sends its destinations, as it does today after a runner restart. The
  web starts a new egress.
- **The same, with the desktop gone**: the show ends. Nobody holds the
  keys. Today's design ends the same way when the agent and runner both
  die.
- **`lost`**: the desktop still posts it after 20 s without feed or
  state. The web asks LiveKit whether the egress is alive. Alive: keep
  trying. Gone: end the show `media-lost`, and the desktop may go direct.
- **videorc.com is unreachable mid-show**: the feed and the egress carry
  on; the desktop shows stale state and can't change destinations.

### D10. Recording: segments to Neon, and the desktop makes the MP4 ⚑

- Talk shows only, as today.
- The egress writes HLS segments (12-hour limit) to the show's Neon
  branch. **Never a file output on a streaming egress**: its 3-hour limit
  would end the show.
- Record before or at Go Live: one egress carries stream and segments.
  Record pressed after Go Live: a second, segments-only egress starts,
  because a running egress can't gain an output.
- The credential handed to LiveKit is the show branch's, write-only
  (S0.5: Neon's `storage:write` scope alone can't read or list), expiring
  with the show.
- Segments are 2 s long when the egress also streams. The egress puts a
  keyframe at every segment boundary, so 4 s segments give the platforms
  4 s keyframes.
- Download: the desktop fetches the playlist and segments with presigned
  URLs and remuxes to MP4 with its own FFmpeg (`-c copy`). The account
  page lists recordings and points to the desktop for the file.
- No object comes near Neon's 10 GiB cap.

### D11. The meter counts egress time ⚑

- A show's cloud seconds are the wall-clock seconds while any of its
  egresses is active. Holds count, as today.
- The every-minute reaper writes the `(show_id, seq)` rows the node used
  to post; `egress_ended` closes the count.
- A talk show with the room open and nobody on air or recording no longer
  counts. It costs us participant minutes only (Open question 5).

### D12. Limits

- **Show length**: the reaper ends a show at 11 h 55 min, before LiveKit's
  12-hour stop. The hold no longer adds to it.
- **Quality**: a 1080p30 feed per orientation. S0.1 failed 60 fps feeds
  (1.3 and 2.0 frames in 100 dropped or repeated), so a 60 fps stream
  goes direct with the existing `cloud-quality` notice ⚑. The platforms
  get a 1080p60 stream that carries the 30 fps picture (D4).
- **Destinations**: 16, as today, if S0.3 finds no lower limit.

### D13. Capacity is a number, not a placement

- `VIDEORC_CLOUD_MAX_SHOWS` caps open managed shows below the plan's
  concurrent import and export quota. Over it: 503 `cloud-full`.
- The node registry, heartbeats and drain don't apply to managed shows.
- **The production project is on LiveKit's entry plan** (Phase 0 hit its
  limit of two ingress objects). That is one solo show with both
  orientations, and the plan's monthly transcode allowance is a hard cap.
  A paid plan comes before any cohort (Only the owner 2).

### D14. Region and privacy ⚑ OWNER

- LiveKit becomes a named processor for solo shows too (today only guests'
  media).
- "A Videorc media server in the EU" is no longer true. The honest line:
  media is processed by LiveKit, records are kept in the EU, and media
  isn't stored.
- Agents draft the new legal copy, FAQ lines and the YouTube answer (v3).
  The owner reads and sends them.

### D15. The watchdog's cloud checks come from the page

- The page samples its own output once a second: average luma on a 64×36
  grid (`blackSeconds`), frame change (`frozenSeconds`), and RMS from the
  limiter (`audioRmsDb`, `audioSilentSeconds`).
- `avSkewMs` is omitted. The watchdog's `av-drift` check never fires on a
  managed show.

### D16. Test cloud uses an ingress only

- A `test` show makes one ingress and no egress. The desktop pushes its
  10 s pattern; the web reads the ingress state and bitrate; the verdict
  rules stay.

### D17. Desktops before this plan never see a managed show

- 0.25.0 knows only the node socket. When `VIDEORC_CLOUD_MEDIA=livekit`,
  the web reports cloud as not available to any client older than the
  first build with web control. Those desktops stream directly and say
  nothing, as an unentitled account does.

### D18. Smokes run on a local LiveKit stack

- A compose file starts `livekit-server`, Redis, `livekit/ingress` and
  `livekit/egress` in Docker. The fake web calls them with the real
  server SDK and serves the program page.
- The node smokes stay as they are.
- Phase 0's measurements ran on the production LiveKit project, which is
  empty, because no dev project exists.
- This Mac has no Docker. Until it does, the pages are tested against
  `livekit-server --dev` and headless Chrome, which covers the page and
  none of the egress (Only the owner 3).

### D19. The cost gate ⚑ OWNER

- Managed hours are billed per minute, per transcode. The figures, the
  worst case per plan and the break-even against a rented server are in
  plan 185 (private), filled in by S0.7.
- The owner decides at G0 whether the hour allowances stand, and when the
  node path comes back.
- A later saving: a WHIP feed skips the ingress transcode (S0.9).

### D20. The program page lives in the web repo

- Route `/cloud/program/v1`: static, no cookies, no account data,
  `noindex`, a strict content security policy.
- It is versioned in its path. A deploy never changes the page under a
  running show; a breaking change is `v2`.
- `custom_base_url` carries a per-show token that authorises only that
  show's beacons and its hold image.
- The page follows the rules Phase 0 found (the note's "What the program
  page must do"): own the video element's stream, never stretch the
  video, keep a rarely refreshed copy of the picture beneath it, never
  pipe frames through script, and time the hold on a clock.

## Wire shape

### Desktop → web (new; bearer auth, as the other cloud routes)

| Route | Replaces | Notes |
| --- | --- | --- |
| `POST /api/cloud/shows` | — | Answer gains `control: { kind: "web" }`; `ingest[]` holds LiveKit's URL and key; `show.nodeId` is `"livekit"` |
| `GET /api/cloud/shows/current` | `ingest.get` | Returns `ingest[]` again, read from `ListIngress` |
| `PUT …/:id/destinations` | `destinations.set` | `{ destinations[], replace? }`; same fields, same limits |
| `POST …/:id/legs/end` | `legs.end` | Talk shows; removes every URL, keeps the room |
| `GET …/:id/state?since=` | `welcome`, `state` | 25 s long-poll; today's `state` shape plus `rev` |
| `PUT …/:id/hold-image` | `hold.image.set` | Solo shows; ≤ 2 MiB after the desktop resizes it |
| `PUT …/:id/stage` | `stage.set` | Talk shows; written to room metadata |
| `POST …/:id/recording` | `recording.start` / `stop` | `{ on }` |
| `POST …/:id/end`, `…/lost` | unchanged | `lost` asks LiveKit, not a node |

- Every new field is additive. Every Rust `Option` carries
  `skip_serializing_if`.
- `control.kind` is new, not a new value of a closed enum: a create answer
  without it means the node socket.

### Program page → web

- `POST /api/cloud/program/beacon`, signed with the page token:
  `{ show, o, phase, hold?, program?, shown? }`. On change, at most once a
  second, and every 10 s.
- `GET /api/cloud/program/hold-image?…`: the solo show's custom card.

### LiveKit → web

- The webhook filter gains `ingress_started`, `ingress_ended`,
  `egress_started`, `egress_updated`, `egress_ended`.

### Database (web, next free migration)

- `cloud_shows`: `media` (`node` | `livekit`), `node_id` nullable.
- `cloud_show_media`: per show and orientation, the ingress id, egress
  ids, leg refs (the HMACs), `rev`, and the last `state` built.
- `cloud_show_assets`: the solo hold image, deleted when the show ends.
- `cloud_show_usage.node_id` nullable.

### Desktop RPCs and events

- No new RPC or event. `CloudStatus` is unchanged.

## Phases and slices

### Phase 0: prove it (about 1 agent-week; scratch code only)

Route: Diagnose (fit 9, `fable-5.1`). Runs on the LiveKit Cloud dev
project with local RTMP receivers. No real channel. Output: the note
`docs/cloud/spike-livekit-managed-2026-11.md` (no costs) and the private
figures in plan 185.

| Slice | Question | Pass |
| --- | --- | --- |
| S0.1 | Picture quality and frame rate through the whole chain, 1080p30 and 1080p60, a high-motion clip, the desktop's real feed settings | VMAF within 3 points of the node path at 1080p30. 60 fps passes only with no more than 1 in 100 frames dropped or repeated; else D12's cap stands |
| S0.2 | The hold: card after a cut, picture back, receivers stay connected, the room closes at a 30 and a 60 minute `departure_timeout`, a relaunched desktop resumes on the same ingress | Card within 3 s; back within 5 s; largest receiver gap ≤ 100 ms; the room outlives the feed for the full timeout and then ends the egress cleanly |
| S0.3 | Destinations: three at once, one killed, one added and removed live, the last one killed, 16 URLs | Others never stall; results arrive by webhook within 5 s |
| S0.4 | Keys: what `EgressInfo`, webhooks, `ListEgress` and the dashboard show for each platform's URL shape; whether `roomRecord` is per room; LiveKit's written answer on what it keeps and for how long | Only the redacted form anywhere we can see; the written answer in hand |
| S0.5 | Segments to a Neon show branch: path-style, a branch credential, write-only scope, a 3 h 10 min run, the desktop's remux | Every segment lands; the MP4 plays end to end; no file output needed |
| S0.6 | The talk-show page: six tiles, VP8 guests, a screen share, each layout, byte-stream overlays, metadata reaching the recorder, the limiter, lip sync | Pixel and tone probes pass as in `smoke:cloud-talk-show`; lip sync within 80 ms |
| S0.7 | The meter: one hour of each show kind against the bill (transcode minutes, data transfer, participant minutes) | Figures written to plan 185 |
| S0.8 | Go Live to on air | Measured; reported against today's 5 s |
| S0.9 | (Optional) An FFmpeg WHIP feed with no transcode, on each OS build | Go or no-go for a later plan |

- **S0.10, a 12-hour soak**, runs once, alone, after S0.2.
- **Gate G0**: the owner reads the note and plan 185's figures and answers
  Open questions 1 to 5 and 9. Nothing in Phase 1 starts before it.
- **Run 2026-11-13**: see "Phase 0 results". S0.10 and the 3 h 10 min,
  30 minute and 60 minute runs are not run: they need a paid LiveKit plan
  and the owner's word.

### Phase 1: web (`videorc-web`)

Route: Implementation (fit 8). W2, W3 and W6 are `fable-5.1` (keys and
lifecycle); the rest `gpt-6.1-sol`.

- **W1. The seam.** Move today's node calls behind `lib/cloud/media/`,
  add the migration, store `media` per show. No behaviour change.
  *Done when* every existing cloud test passes with `VIDEORC_CLOUD_MEDIA`
  unset.
- **W2. The LiveKit provider.** Create (room, ingresses), destinations
  (`StartEgress`, `UpdateStream`, the redaction guard, leg refs), legs end,
  end, current. *Done when* provider tests cover each call against a fake
  LiveKit API, and a test proves no URL reaches the store or a log line.
- **W3. Webhooks and state.** The five new events, `rev`, the `state`
  builder (D8), the long-poll route. *Done when* a recorded webhook
  sequence for go live, hold, resume, one leg down and end builds the
  expected states.
- **W4. Reaper and reconcile.** No-feed, the 11 h 55 min limit, and a
  repair pass that reads `ListEgress`, `ListIngress` and `ListRooms` for
  open shows. `lost` asks LiveKit. *Done when* a show whose webhooks were
  dropped is still ended and counted right.
- **W5. The meter** (D11). *Done when* the reconcile totals match the
  egress times in a replayed month.
- **W6. The program page, solo.** The hold (D5), the card, the custom
  image route, beacons, the program checks (D15). Card visuals:
  UI/Product Design (fit 9, `opus-5.5`). *Done when* a browser test cuts
  and restores a fake track and the timings hold within 100 ms.
- **W7. Test shows** (D16) and the capacity cap (D13).
- **W8. The old-client rule** (D17). The desktop sends its version as
  `client_version` on AI routes and as `client` on a create; use whichever
  the capabilities route can see. *Done when* a 0.25.0 build against a
  managed fake web streams directly with no toast.
- **W9. Cost inputs and the owner page**: ingress and egress minutes
  replace node rent for managed shows (private figures).
- **W10. Docs and drafts**: `docs/cloud.md`, the legal copy, the FAQ
  lines, for the owner to read (D14).

Gate: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### Phase 2: desktop (`videorc`)

Route: Implementation (fit 9, `fable-5.1`): it changes live-stream
behaviour.

- **C1. The control transport.** `cloud_show.rs` splits its socket client
  behind one transport type; the node socket is the first kind. No
  behaviour change. *Done when* `smoke:cloud-solo` passes unchanged.
- **C2. Web control.** The second kind: the routes above in
  `videorc_api.rs`, the state long-poll with backoff, intents as HTTPS
  calls. *Done when* unit tests replay create, hand-over, a hold, a leg
  down, Reconnect, Stop.
- **C3. Resume and relaunch** through `current`; no destinations re-sent
  while an egress is alive; re-sent when `destinationsSet` is false (D9).
- **C4. The feed address.** `ingest_url_problem` accepts LiveKit's RTMPS
  host; `tls_verify` and the roots file stay. The hold image is resized
  and uploaded.
- **C5. Test cloud** against an ingress (D16).
- **C6. `smoke:cloud-solo-managed`** on the local stack (D18): feed and
  legs, a cut and the card, auto-return, SIGKILL then Resume, Stop, one
  leg killed then Reconnect, the egress killed then recovery, the key leak
  scan. *Done when* it passes 10 times in a row.
- **C7. Copy check.** No UI change is expected. Read every cloud surface in
  light and dark with a managed show; fix only wrong words.

Gate: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test:scripts`, `pnpm --filter @videorc/desktop test`,
`cargo fmt --check --all`, targeted `cargo test -p videorc-backend`,
`cargo clippy -p videorc-backend -- -D warnings`, `pnpm build` (eager gzip
≤ 485,000), then `smoke:cloud-solo`, `smoke:cloud-solo-managed`,
`smoke:multistream`, `smoke:stream-leg-eof`, `smoke:streaming-secrets`,
`smoke:stream-watchdog`.

### Phase 3: talk shows (web, then desktop)

- **T1. The program page, stage** (web; `fable-5.1` for geometry and
  audio, `opus-5.5` for name plates and the away plate): layouts from the
  shared fixture, overlays, the limiter. *Done when* its tiles match the
  fixture's rectangles to the pixel in both orientations.
- **T2. Web**: talk create with no runner token; egress on Go Live or
  Record (D10); stage metadata; recordings from segment results; the
  `runner` role leaves the grants, the webhook and the minutes table for
  managed shows.
- **T3. Desktop** (UI/Product Design for the monitor, fit 9, `opus-5.5`;
  Implementation for the rest): stage through `PUT …/stage`, overlays as
  byte streams from the renderer, the Program monitor on the Show stage,
  recording download and remux.
- **T4. `smoke:cloud-talk-show-managed`**: the checks of
  `smoke:cloud-talk-show`, minus the return.

Gate: Phase 2's, plus `pnpm probe:preview-lifecycle` (the Preview hides
while a room is open) and both talk-show smokes.

### Phase 4: acceptance and cut-over

- **A1.** One review pass per phase (Review, fit 9, `fable-5.1`), findings
  first.
- **A2.** `VIDEORC_CLOUD_MEDIA=livekit` with `VIDEORC_CLOUD_USERS` naming
  the owner only. The owner's live test, on request: a solo show with a
  pulled cable, then a talk show with two guests.
- **A3.** The owner sends the legal copy and the YouTube answer.
- **A4.** The beta cohort (plan 222 Q8), then the switches.
- **A5.** After the cohort: the owner's call on the node path, with the
  measured hours and plan 185's break-even.

## When things break

| What fails | Viewers see | The app |
| --- | --- | --- |
| The computer or its internet | Be right back within 3 s, until the hold limit | Resume on the same ingress |
| One platform | Nothing on the others | Watchdog: destination down, Reconnect |
| The egress | The stream stops on every platform | Destinations re-sent; a new egress; platforms reconnect |
| The egress, with the desktop gone | The stream ends | The show is ended on the next look |
| LiveKit as a whole | The stream ends | `lost`; Go Live streams directly, with one toast |
| videorc.com | Nothing | Stale state; no destination changes until it returns |
| A webhook is lost | Nothing | The reconcile pass repairs state within a minute |

## STOP conditions

Stop and ask the owner when:

- a Phase 0 kill question fails (S0.1, S0.2, S0.4, S0.5);
- the owner hasn't answered Open question 1 and a slice would send a real
  stream key anywhere;
- any path would write a destination URL, or any part of a key, to a
  database, a log or an error report;
- LiveKit's written answer says a full stream URL is kept anywhere;
- plan 185's figures put a plan's full allowance above its price and the
  owner hasn't chosen (D19);
- the eager gzip budget would pass 485,000;
- a change would put a control beside Record or Go Live;
- a platform's terms forbid the relay or a long hold.

## Out of scope

- Deleting the runner, the node agent or the node path (A5, a later plan).
- A WebRTC or WHIP feed from the desktop (S0.9 only measures).
- 4K, and more than 1080p60.
- Recording solo shows in the cloud.
- The phone as camera and remote (plan 184 Phase 3).
- Other managed relays. Some restream services take one RTMP feed, send it
  to many platforms without re-encoding, and show a slate when the feed
  drops. That could suit solo shows at a lower cost. Unchecked; worth one
  look if S0.7's figures are the only thing wrong.
- Self-hosting LiveKit's ingress and egress: that is a media server again.

## Open questions for the owner

1. **Keys.** Stream keys would pass through videorc.com's memory, and
   LiveKit would hold them for the show and keep a record with the first
   and last three characters. Acceptable? *Recommended: yes, with the
   legal copy and the YouTube answer changed first. A no ends this plan.*
2. **Hours.** Do Premium's and Max's cloud hours stand on a per-minute
   meter? *Recommended: decide at G0 on S0.7's figures; run the cohort on
   managed media either way.*
3. **60 fps.** If S0.1 fails 1080p60, do 60 fps streams go direct?
   *Recommended: yes.*
4. **The Program monitor** without the real return. *Recommended: accept;
   the platform's own preview is the proof.*
5. **Talk-show hours** count only on air or recording. *Recommended: yes.*
6. **The node path** stays in the code until the cohort ends.
   *Recommended: yes.*
7. **Recording downloads** come from the desktop. *Recommended: yes for
   v1.*
8. **The LiveKit plan**: the project is on the entry plan, which carries
   one show. Move to Ship before the cohort; move to Scale when region
   pinning or volume asks for it. *Recommended: yes.*
9. **The measured gaps** (Phase 0 results). After a reconnect the picture
   is back in about 6 s, not 2. About 0.7 frames in 100 are lost; the
   node path loses none. Go Live takes 5 to 7 s. Quality is 2.7 to 2.8
   VMAF points under the node path. Good enough for the cohort?
   *Recommended: yes, with the return bar moved to 7 s, once a second
   60 fps run confirms the frame figure. They are the price of having no
   server.*

## Only the owner can do

1. Answer gate G0 (Open questions 1 to 5 and 9).
2. Move the LiveKit project to a paid plan, or make a dev project on one.
   The entry plan carries one show and can't run Phase 0's long runs.
3. Start Docker Desktop on this Mac for the managed smokes.
4. Send LiveKit's support the retention questions (agents draft them), or
   say agents may.
5. Read and send the legal copy and the YouTube answer.
6. Set `VIDEORC_CLOUD_MEDIA`, `VIDEORC_CLOUD_MAX_SHOWS` and the webhook
   filter in production, and flip every launch switch.
7. Live tests on real channels.

## Handoff (cold start)

- **Goal**: Videorc Cloud running with no server of ours: Neon for data
  and storage, LiveKit Cloud for media.
- **Current state**: Phase 0 has run; its note is
  `docs/cloud/spike-livekit-managed-2026-11.md`. No product code. Gate G0
  is open on Open question 9. The node path is merged and off. Production
  has Neon storage and a LiveKit project on the entry plan, and no VM.
- **Route**: Orchestrator, fit 10, `fable-5.1`.
- **Start with** the owner's answer to Open question 9. Then the runs the
  note lists as not run, then Phase 1.
- **Where things are**:
  - the runner: `TheOrcDev/videorc-cloud`, `docs/wire-notes.md`;
  - the web control plane: `TheOrcDev/videorc-web`, `lib/cloud/`,
    `docs/cloud.md`;
  - the desktop seam: `crates/videorc-backend/src/cloud_show.rs`,
    `cloud_talk.rs`, `recording.rs` (`prepare_cloud_stream_targets`);
  - the layout geometry: `protocol-fixtures/talk-show-layout.json`.
- **Out of scope**: see above.
- **Never**: send a real stream key before Open question 1 is answered,
  go live unasked, flip a switch, or print a cost in this repo.
