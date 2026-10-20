# Plan 184: Videorc Cloud: your show lives on our servers

> **Executor instructions**: read `AGENTS.md`, the `videorc-design` skill,
> plan 185 (the Max tier and cloud hours, `docs/plans/185-videorc-max-tier.md`
> in the private `videorc-web` repo) and this whole plan first.
> - Desktop work: your own worktree from `origin/main`.
> - Web work: your own worktree of `~/projects/videorcweb` from `origin/main`.
> - The runner and the node agent: where D14 says.
> - Write and commit every slice of a phase first, then run Rust and the
>   smokes once at the end of the phase (owner feedback "Gates at the end").
> - Check every UI in light AND dark.
> - Never go live on a real channel unless the owner asks for a live test in
>   the session (`AGENTS.md`, live tests).
> - Nothing after Phase 0 starts until Phase 0's written results say go.

## Status

- **Status**: IN PROGRESS since 2026-10-16. The owner answered the four
  shaping questions (D1 to D4), then said "go all to recommended and start
  executing the entire plan and create a PR. Of course don't merge this."
  Every ⚑ below therefore takes its recommended answer (Owner decisions).
  Progress is tracked in Progress.
- **PRs**: one draft per repo, and none of them may be merged:
  - this plan and the desktop slices on `plan-184-videorc-cloud`;
  - the web on `videorc-web` `plan-185-max-and-cloud`;
  - the runner and node agent in the private `videorc-cloud` repo.
- **Priority**: P1, the owner's next big bet (2026-10-16).
- **Effort**: XXL. Phase 0 and four phases, each several weeks. Videorc's
  first always-on server product.
- **Risk**: HIGH.
  - A live stream depends on our servers for the first time. One outage
    hits every cloud user at once.
  - Every cloud hour costs money: servers, LiveKit and storage.
  - Today video never touches our servers. For cloud users it will.
- **Planned at**: desktop `origin/main` `4c798067` (0.9.143), web
  `origin/main` `957df643`.
- **Route**: Orchestrator (fit 10) owns the order.
  - Phase 0, the runner and the node agent: Implementation (fit 9) on
    `fable-5`.
  - Web routes, tables and metering: Implementation (fit 8) on `gpt-5.5`,
    with a `fable-5` security pass on every route that mints a token or takes
    a webhook.
  - Desktop UI, the guest page and the phone page: UI/Product Design (fit 9)
    on `opus-4.8`, with `videorc-design`.
  - One Review pass (fit 9) per phase before it ships.
  - Releases: Release (fit 10), with `videorc-release`.
- **Companion plan**: plan 185 (the Max tier and cloud hours). It lives in
  the **private** `videorc-web` repo at `docs/plans/185-videorc-max-tier.md`
  because it holds prices, costs and margins. Its slices T1 to T3 land
  before Phase 1 reaches anyone but the owner.
- **Replaces** the 2026-09-15 Remote Guests plan (Obsidian vault, never
  started). That plan mixed guests on the computer, so guests died with it.
  Here the cloud mixes talk shows (D6). Its LiveKit research is reused.

## The owner's ask (2026-10-16)

> "I want to start planning now for our cloud version of Videorc. … We want
> to have our live streams living on the cloud for our premium users and
> maybe we also create the new more expensive premium only for this. … We
> could have people join from a browser to join you on your live stream.
> Then for example, if our computer dies, live streaming is staying on and we
> can continue from our phone, which is going to be big. … shutting down our
> computer, taking our phone, going to the car, and the live stream is still
> working."

Then:

> "Let's plan out all four phases … Also let's plan out a new $99
> subscription that includes all this. I think that the first user would be
> me and I would rather create talk shows with guests so we can start with
> that … On the phone I would mainly want the camera from it. Actually both
> … put some cloud hours in Premium … and create a bigger tier: $99. Plan out
> this one properly."

The owner named the $99 tier **Max**.

## Owner decisions (2026-10-16, second answer)

> "Yeah you can just go all to recommended and start executing the entire
> plan and create a PR. Of course don't merge this. Everything is just being
> prepared. We are going to work on this one for a bit"

So every ⚑ takes its recommended answer:

- **D7**: the runner is the new Rust service. GStreamer is used only if S0a
  fails.
- **D8**: LiveKit Cloud (Ship) first. Self-host when the bill passes $300 a
  month, or before Max sells beyond the beta.
- **D9**: Hetzner bare metal. S0a picks AX102 with x264 or GEX45 with NVENC.
- **D12**: the hold lasts 30 minutes by default (choices: 5, 15, 30, 60).
- **D14**: the runner and node agent live in a private `videorc-cloud` repo.
  S0e passed (Progress).
- **D16**: the Show stage plus a Program monitor. S0b decides what the
  native preview window shows.
- **D17**: YouTube chat is not forwarded through our servers until the owner
  updates the compliance answer.
- **D21**: the talk-show feature table stands.
- **I4**: Grafana Cloud's free tier.
- **P2**: the phone takes over on a tap. "Take over by itself" exists and is
  off by default.
- **Open questions 1 to 4**: 30 minutes; a tap; Max goes on sale at Phase 2
  acceptance; a private repo.
- **Added by the orchestrator**: each node runs **MediaMTX** (MIT) as its
  ingest front. It takes RTMP(S) now and SRT and WHIP later, and publishing
  is authorised through the node agent. Runners read their feed from it
  locally (Wire shape).

## Progress

| Slice | State | Where |
| --- | --- | --- |
| S0e code ownership | **Done** 2026-10-16. `scene_geometry.rs`, `overlay_layout.rs`, `buddy_animator.rs` and `buddy_overlay.rs` have only the owner as author. `compositor.rs` and `recording.rs` have five outside authors, so never copy them into the private runner. | this plan |
| S0a runner spike | **Done on macOS** 2026-10-17 (Apple M4, MediaMTX, 2 local receivers): viewers see Be right back 1.5 s after the feed drops, and the picture is back about 1 s after the feed's first frame (4.6 s end to end, most of it the publisher's own start). The receivers never disconnected; the largest gap was one frame. 1080p60 x264 at 12 to 6 Mbps used 87% of a core on average (VideoToolbox 32%). x264 vs NVENC per box waits for a Hetzner box. `docs/spike-runner-2026-10.md` | `videorc-cloud` #1 |
| S0b host app in a room | Not started (before Phase 2) | |
| S0c SRT in FFmpeg | **Done** 2026-10-18: go for C1b, on four conditions. (1) On macOS, libsrt 1.5.7 is one configure flag and 0.66 MB more `ffmpeg` (+2.5%); FFmpeg still reports "LGPL version 3 or later", and the bundle gains the MPL-2.0 text and the UDT BSD notice. (2) Windows and Linux already link libsrt, but the pinned BtbN build (2026-07-31) carries 1.5.5, older than 1.5.6's KMREQ CVE fix and 1.5.7's security release: re-pin to autobuild 2026-09-30 before C1b ships. (3) SRT sends the stream id in the clear even with a passphrase, so it never carries the ingest key: one MediaMTX path per feed, `live/<showId>-<h\|v>`, for both protocols, with the ingest key in RTMPS's query and a 32-character passphrase per feed for SRT. (4) MediaMTX checks the passphrase per path, after the auth hook, so the node adds a path per feed through MediaMTX's API. Measured on the M4 at a 40 ms RTT: MediaMTX has an SRT feed ready 0.4 s after the publisher starts (RTMPS 1.6 s), and SRT adds 7.9% to the upload (RTMPS 4.7%). A drop under 5 s keeps the connection and loses no video when shorter than SRT's latency. At 1000 ms latency, 1% and 5% random loss lost no frames, and the latency adds 1.07 s of delay. The 3 s fallback to RTMPS is decided once, at Go Live, by a probe of SRT's handshake, never inside the leg. `docs/cloud/spike-srt-2026-10.md` | this PR |
| S0d costs measured | **Blocked**: needs a Hetzner box and a LiveKit project from the owner | |
| I1 nodes, I3 deploys, I4 watching, I5 DNS and TLS | **Blocked**: needs Hetzner and DNS from the owner | |
| I2 node agent | **Done** 2026-10-17 (`6ff8d76`): signed show routes, the control proxy, the MediaMTX publish hook, runner supervision with crash restart and adoption, heartbeat, usage and drain. Dev-tested only; TLS with a real cert is untested. | `videorc-cloud` #1 |
| R1 to R6 runner | **Done** 2026-10-17: decoder, output clock, switcher (12 virtual-time tests), encoder and per-destination fan-out, control socket with `ingest.get`, usage, crash state. 82 tests plus the hold continuity test. The runner's `docs/wire-notes.md` pins 19 details this plan left open. | `videorc-cloud` #1 |
| W1 to W6 control plane | **Done** 2026-10-17 (`796aab43`). Shows, nodes, signed node calls, placement, the reaper cron and `/live`. 32 new tests; the full web suite is green (1123). | `videorc-web` |
| W7 docs and privacy | Docs **done** 2026-10-17 (`docs/cloud.md`, `docs/billing.md` in web #85). The privacy page changes only at launch. | `videorc-web` |
| C1 to C3 desktop backend | **Done** 2026-10-17. Plan 185 T4 parsing; `cloud_show.rs` (web client, control socket, state machine, RPCs `cloud.status`, `cloud.settings.set`, `cloud.allowance.refresh`, `cloud.show.resume`, `cloud.show.end`, event `cloud.state`); the `recording.rs` seam (RTMPS feed per orientation, platform rows in the leg state, `apply_cloud_leg_states`); resume through `ingest.get`. A Go Live that never expected the cloud says nothing (Basic, rollout switch off). | this PR |
| C4 to C7 desktop UI | **Done** 2026-10-17 (`7441cbd8`, `914df505`). C4: the Go Live primary reads "Connecting to Videorc Cloud…" while a cloud start runs; the cloud step runs inside the backend's start, so it shows on the `starting` phase rather than a phase of its own. C5: "You're still live through Videorc Cloud." above Session, with the hold countdown, Resume (Go Live, bound to the live show by the backend) and End livestream (asks first). C6: Livestream → Setup's Videorc Cloud section: the switch, the month's hours, the Be right back image (the card or a takeover) and the hold limit; locked with one reason for Basic (the Premium sentence) and for a paid account not on yet. C7: Stream health reads "Cloud · 6 Mbps", "Be right back · 28 min left" or "Cloud resuming", with one Videorc Cloud row on hover. Contracts round-trip a shared fixture in both languages. Owner by-eye in both themes owed. | this PR |
| C5b resume without platform prep | **Done** 2026-10-17 (`f3499590`). Resume is its own start, `cloud.show.resume`, bound to the show by the backend: no dialog, no preflight, no metadata update, no platform prepare. The saved destinations go along as rows only (a YouTube sign-in without a key included), the feeds come from the show's ingest (every orientation the show has that the session composes), the hold image goes only if the user picked one, and no `destinations.set` is sent, so the runner keeps every leg and key it holds and a YouTube broadcast's VOD stays one piece. A start that fails after binding the show makes it resumable again. Go Live while a show is resumable still hands its freshly prepared destinations over (a new broadcast by choice). After a relaunch the saved YouTube target has no broadcast id: Stop relies on `enableAutoStop` (D13), and the chat connector reports "No live chat is available for this YouTube broadcast." until the computer prepares a broadcast again (chat without the computer stays D17); the renderer's lifecycle owner is not carried over, because it settles and completes broadcasts when a session ends. Proven by `smoke:cloud-solo`: zero `destinations.set` after the Resume click, the ingest back through `ingest.get`, both receivers on one connection. | this PR |
| C1c the feed checks the node's certificate | **Done** 2026-10-17 (`5d6d7f1e`). FFmpeg's `tls_verify` defaulted to 0, so the feed published to any certificate and whoever answered for the node's name got the ingest key. Every cloud feed leg now checks, in each output shape (the per-leg fifo's `format_opts`, a tee slave's options, the plain FLV output's CLI options): with the OpenSSL backend of the macOS and Linux FFmpeg builds (8.1), `tls_verify=1` verifies the chain against `ca_file` and binds the URL's host name (`SSL_set1_host`); the Windows build's Schannel verifies both against the Windows store. The roots are Mozilla's store (webpki-root-certs, the store the control socket and the API client already trust), written beside the database as `cloud-feed-roots.pem` because OpenSSL's default paths point nowhere on a user's machine; dev builds may add one CA through `VIDEORC_CLOUD_FEED_CA_FILE`. A release build refuses an ingest address by IP, because FFmpeg skips the name check for a numeric host. Direct platform legs are unchanged. Three FFmpeg publishes in `smoke:cloud-solo` prove it: the right roots pass the handshake, a CA that did not sign the certificate fails it, a certificate for another name fails it. The web's `docs/cloud.md` says "public roots" and needs these exact facts. | this PR |
| C6b Test cloud | **Done** 2026-10-20 (`7cfc338a`, `9bdbcc08`, `8c205f6a`; web `62d4f8ea`, `0b8535b5`). Livestream → Setup's Videorc Cloud section has a "Test Videorc Cloud" row: Test (outline; "Testing…" with a spinner while it runs) calls `cloud.selftest.run` (a `.test.` segment would make the RPC smoke-only in `backend_authority`). The backend creates a `kind: "test"` show (no destinations, no cloud hours, never current, six an hour with 429 `cloud-test-limit`; to the node a solo show with `maxShowSeconds: 30`), connects the control socket, pushes 10 s of noisy `testsrc2` and a sine with the app's own FFmpeg at the stream quality's size, fps and bitrate over RTMPS with C1c's certificate check, reads the runner's feed kbps (the median of its 2 s readings) and live state, ends the show and kills its FFmpeg through its own child. One reason per result: certificate, a push that never ran, no feed, the runner ended it, too slow (under 85% of video plus audio), failed; an upload the node never measured is unmeasured, never slow. The result is the row's description, or its `FieldError` for a failure, never a toast. Test is disabled with one reason while a session runs or a show is live or resumable. Any session start stops a running test without waiting; a cloud Go Live or a Resume waits for its show to end; a 409 that names a test (a crashed desktop's) ends it and creates once more. The push lifts VideoToolbox's data-rate ceiling to 140% of the bitrate: at a stream leg's `-maxrate` equal to `-b:v` the noisy card settles near 70% (2,951 of 4,160 kbps at 720p30 on the M4), so every test would read as too slow; at 140% each 2 s window carried 94 to 102% at 720p30, 1080p60, 1440p60 and 1080x1920. `smoke:cloud-solo` passed on `8c205f6a`: Test live 4.55 s after the click with 4,130 of 4,000 kbps (plus 160 audio); a test show nobody ends ended `max-show` 29.999 s after it went live and the web closed it from a heartbeat; the C8 checks unchanged (feed cut held 1.58 s, back 3.10 s after the network; the death held 1.60 s, Resume live 5.76 s; largest gap 34 ms). Windows and Linux push with openh264, uncalibrated. Owner by-eye in both themes owed (`VIDEORC_CLOUD_SOLO_SHOTS_DIR` captures idle, running, a pass and a blocked test). | this PR |
| Cross-repo wire review | **Done** 2026-10-17: a read-only field-by-field check of desktop, web and node found 5 mismatches, all fixed. (1) The web minted base64url ingest keys the node rejects, so about 64% of creates failed as an unreachable node; keys are base62 now. (2) A runner-ended show dropped out of heartbeats, so the web kept it open up to 5 minutes and Go Live errored; the node now reports it as ended until heard, the web ends a show a fresh heartbeat leaves out, and a Go Live that meets one closes it and starts anew. (3) `welcome` could take longer than the desktop's 5 s; the node waits 15 s for a fresh runner and the desktop 20 s. (4) Usage for a show the web doesn't know was posted forever; dropped after 30 refusals. (5) Node id and secret spellings now match. Settled facts: the runner repo's `docs/wire-notes.md` and the web's `docs/cloud.md` ("Matching the node"). Not yet sent by any client: `hold.start`, `hold.stop`. | all three PRs |
| C8 smokes | **Done** 2026-10-17: `pnpm smoke:cloud-solo` (`scripts/smoke-cloud-solo-app.mjs`) is the first run of the real dev app, the node agent and the runner together. It builds the agent and runner from the sibling `videorc-cloud` checkout (`VIDEORC_CLOUD_DIR`), starts MediaMTX and the agent on free ports with a per-run state dir, stands in for the web with `scripts/lib/fake-cloud-web.mjs` (the web's routes, node signatures and `vcs1` tokens, mirrored from `videorc-web/lib/cloud`), and records 2 local RTMP receivers. Measured on the M4 (720p30, x264 on the node): Go Live to the runner live 7.7 s. The feed cut (a TCP proxy drops the RTMPS path and refuses reconnects, the acceptance test's "pull the network") held in 1.53 s and came back 5.1 s after the network returned, the desktop's own fifo leg reconnecting by itself (`stream-target-reconnecting`, then `stream-target-resumed`). The computer dying (SIGKILL of the whole app) held in 1.55 s; the relaunch saw the show resumable 3.3 s after launch, and Resume (`cloud.show.resume`, the ingest back from the node through `ingest.get`, the same destinations) was live 5.8 s after the click on the same show, with no new show on the web. Both receivers kept one connection for the whole 63 s: largest packet gap 34 ms (one frame), the Be right back card covered 99.6% of both hold windows, motion back after both resumes, h264 and aac. Stop ended the show on the web and the node in 91 ms; the runner exited, the receivers closed, the local recording finalized. One usage report (25 s live, 27 s hold), 9 signed heartbeats, no secret in the renderer events or the app log. No product bug: the three fixes the runs needed were in the harness. Not part of `smoke:local-gates` because it needs the private checkout. **Later on 2026-10-17** (C1c, C5b): the node announces itself as `localhost` and the desktop trusts the run's self-signed cert through the dev override, so the feed check stays on; the smoke gates the three FFmpeg certificate publishes and counts the runner's `destinations.set` after the Resume click (must be 0). Pass on `51b30a2a`: Go Live to live 5.5 s; the feed cut held 1.53 s and came back 4.81 s after the network; the death held 1.65 s, the relaunch saw the show resumable 2.8 s after launch, Resume was live 5.74 s after the click, 1 show, 0 `destinations.set`; both receivers one connection for 62.5 s, largest gap 34 ms, hold card 99.9%; Stop 92 ms; the node agent logged `client="desktop 0.9.143"`. Two earlier runs that day failed in the harness only: a 10-minute backend rebuild right before Go Live starved the x264 runner (75 skipped output frames, hold card 63%), and once the two listener FFmpegs never saw the publisher's EOF although the runner's legs exited 0 (they log at info now, for evidence). | this PR |
| Direct-path smokes | **Pass** on `e9d22bf0` with the cloud off: `pnpm smoke:multistream`, `pnpm smoke:stream-leg-eof` and `pnpm smoke:record-latency` (warm click to recording p50 71 ms). | this PR |
| C1b SRT | After S0c | |
| Phases 2, 3 and 4 | Not started | |

## What a streamer gets

The feature in one line: **your show runs on Videorc's servers, so it stays
on air whatever happens to your computer, and anyone can join it from a
link.**

1. **A solo stream that survives the computer (Premium and Max).**
   - You click Go Live as always. The Studio says "Live through Videorc
     Cloud". The computer uploads one stream, and the cloud sends it to
     YouTube, Twitch, Kick and X.
   - The Mac crashes. Within two seconds viewers see your Be right back
     image, and chat keeps going. The platforms never see a drop, so the
     broadcast and the VOD stay in one piece.
   - The Mac comes back, and Videorc says "You're still live through Videorc
     Cloud. Viewers see Be right back." with Resume and End stream. Click
     Resume and the picture is back.
   - Updating the app in the middle of a stream works the same way.
2. **A talk show with guests (Max).**
   - You open Guests and copy the link. Two guests open it, one on a laptop
     and one on a phone. They check camera and mic, then wait backstage.
   - You bring them on stage, in "Side by side" or "Screen + people", with
     a name under each tile. A click on a chat row puts that comment on
     stream, as today.
   - Go Live sends the show to every platform, and the cloud records it.
   - Your Mac dies mid-show. The guests keep talking, your tile says "Back
     in a moment", and the show doesn't stop.
3. **Your phone (Premium and Max).**
   - On the phone, videorc.com/live shows the live show. "Use this phone's
     camera", then "Take over", puts the phone on stream. The computer can
     take it back.
   - The same page is a Stream Manager: chat, put a comment on stream, Be
     right back, layouts, guests, and End stream.
   - Drive mode: chat is read aloud, the buttons are huge, and nothing
     needs a look. That is exactly what Twitch allows (Outside facts).
   - Serious IRL streamers point Moblin, Larix or IRL Pro at their show's
     SRT address instead.
4. **More for Max (Phase 4).**
   - Each guest recorded as their own file.
   - A producer seat for a teammate.
   - Buddy holding the show while you're away.
   - Going live from the phone alone.
   - Alerts on your phone.

## Words we use

| Word | Meaning |
| --- | --- |
| **Videorc Cloud** | The feature family. UI copy: "Live through Videorc Cloud". |
| **Cloud show** | One live session that runs on our servers, solo or with guests. |
| **Solo show** | The computer builds the picture and uploads one **feed** (Phase 1). |
| **Talk show** | The cloud builds the picture from everyone's cameras (Phase 2). |
| **Feed** | The finished picture and sound the computer uploads for a solo show. |
| **Room** | The LiveKit room where people (host, guests, phone) send camera and mic. |
| **On stage / Backstage** | On stream / connected but not on stream. |
| **Program** | The final picture and sound the platforms get. |
| **Return** | A copy of the program sent back to the host, the phone and producers. |
| **Hold** | What viewers see while the feed or the host is gone: the Be right back image. |
| **Cloud hours** | The metered time a cloud show is live or recording, hold included (plan 185). |
| **Runner** | Internal: the server program that runs one cloud show. |
| **Media node** | Internal: a rented server that hosts runners. |
| **Control plane** | Internal: the videorc.com API that creates shows, places them on nodes, mints tokens and meters hours. |

## How it works

```
                 ┌───────────── videorc.com (Vercel + Neon) ──────────────┐
                 │ control plane: shows, node placement, tokens, meter    │
                 └──────▲───────────────────▲────────────────────▲────────┘
                        │ create / status   │ heartbeats, usage  │ tokens
 Solo show              │                   │                    │
 Computer ─ the feed ─┐ │    Media node (Hetzner, EU)            │
 (Studio builds the   │ │  ┌───────────────── Runner ─────────────────┐
  picture as today;   └─┼─►│ inputs → switch / compose → encode once  │──► YouTube
  RTMPS, later SRT)     │  │   the feed            hold image         │──► Twitch
 Talk show              │  │   room tracks         overlays           │──► Kick
 Host app ──┐           │  │                       audio mix          │──► X
 Guests   ──┼──► LiveKit room ◄── hidden participant ─┘               │──► cloud recording
 Phone    ──┘   (WebRTC)   │   publishes the program back as Return   │
                           └──────────────────────────────────────────┘
```

- **The control plane stays on videorc.com.** Vercel and Neon are good at
  accounts, tokens and meters. They can't hold a video stream.
- **Media nodes are our first rented servers for video.** Bare metal with
  traffic included (D9), EU first.
- **One runner per show.** It owns the platform connections for the whole
  show. Inputs come and go, and the program never stops until the host ends
  the show or the hold runs out.
- **Inputs never take the output down.** Each input (the feed, each room
  track) is decoded by its own process or task. If one dies, the runner
  switches or holds. The encoder and the platform connections keep running.
- **LiveKit carries everything browser-shaped**: guests, the phone, and the
  host app in a talk show. The runner joins each room as a hidden
  participant, the way the 09-15 plan wanted the desktop to.
- **Stream keys pass through, they aren't stored.** The desktop prepares
  destinations as today (YouTube broadcast, keys from the keychain) and
  hands them straight to the runner over TLS. The runner keeps them in
  memory for that show only. They never touch Vercel or Neon. Phase 4's "go
  live from the phone alone" is the first feature that needs stored
  credentials, and it gets its own decision (X6).

## What exists (facts)

Desktop `origin/main` `4c798067`. `rec` means
`crates/videorc-backend/src/recording.rs`.

- **The stream output.**
  - **Destinations** are defined in `streaming.rs:93-148` (YouTube, Twitch,
    Kick, X, TikTok, Instagram, Custom), each with an orientation. Saved keys
    are secret refs (`streaming.rs:103-108`) into a 0600 JSON store
    (`secrets.rs:1-14`).
  - **This is the cloud seam:** `rec:3195` reads the keys from the store, and
    `rec:3252-3277` ends in `let stream_targets = stream_resolution.ready;`.
    - That list, `Vec<StreamTarget { url, target_id, platform, label,
      output_video, output_orientation }>` (`rec:11512-11522`), feeds every
      leg builder and monitor.
    - Swap the N targets for one cloud target (two with the vertical leg),
      and hand the originals to the runner. The keys are plain at this point.
  - **Two FFmpeg paths:**
    - The encoded bridge (VideoToolbox, Media Foundation) writes one `-f fifo
      … -attempt_recovery 1 -recover_any_error 1 -restart_with_keyframe 1`
      FLV output per target (`rec:17878-17933`).
    - The raw path (Linux, weak Windows) uses one tee with fifo legs
      `[f=flv:onfail=ignore:…:rw_timeout=8000000]` and no auto-recovery
      (`rec:14083-14095, 17999-18012`).
  - **Only RTMP(S) is accepted.** `validate_stream_publish_url` allows only
    `rtmp` and `rtmps`, and the builders are FLV-only (`rec:21715-21724`). **An
    RTMPS feed to the runner needs no FFmpeg or builder change. SRT does.**
  - **The vertical leg** is its own composed and encoded output
    (`rec:20639-20668`). The raw path refuses it (`rec:20629-20636`).
  - **Leg health:** FFmpeg logs at `level+info`, `StreamLegMonitor` reads them
    (`rec:22575-22661`), and `platform_stream_watch.rs` polls YouTube every
    60 s.
- **Platform prep runs from the renderer**, through `streamTargets.*` RPCs
  (`use-studio.tsx:13678-13782`).
  - YouTube broadcasts are created with `enableAutoStart: true,
    enableAutoStop: true` (`youtube.rs:579-590`).
  - The renderer polls the stream status and moves the broadcast to live. At
    stop it moves it to `complete` and ends the X broadcast
    (`use-studio.tsx:12390-12451, 12856-12892`).
  - X uses OAuth1 with a consumer secret built into the app
    (`x_live.rs:26-34`).
- **Our YouTube compliance promise.** The YouTube ToS reply says: "All
  YouTube API calls go directly from the user's computer to Google. No Videorc
  server proxies them." (`docs/compliance/youtube-tos-report-v1-reply.md:44-45`).
  Tokens come from a Google "Desktop app" client (`oauth.rs:25-31`).
  - The runner pushing RTMP into YouTube's ingest is not an API call.
  - A server polling YouTube chat or creating broadcasts would be.
- **FFmpeg bundles.**
  - macOS: 8.1.1 built from source, LGPLv3 with static OpenSSL 3, and no
    libsrt. The binary has the `whip` muxer and DTLS
    (`scripts/build-ffmpeg-macos.sh:4, 70-143`).
  - Windows and Linux: BtbN LGPL 8.1.2 prebuilts (`vendor/ffmpeg/*-pin.json`).
    Whether they have SRT is unverified.
- **Overlays.**
  - Renderer PNGs: the comment card, the caption bar and Buddy's speech
    bubble (`caption-overlay.ts:416,671`; `comment_highlight.rs:3-5`;
    `buddy_overlay.rs:4-7`).
  - Drawn in Rust: takeovers (the user's image files) and Buddy's sprite.
  - There is no built-in Be right back image. `overlay_layout.rs` holds
    placement rects only.
- **The backend is not a server.**
  - On Unix it aborts within about 5 s when its supervisor is gone or its
    parent is PID 1 (`main.rs:876-915`), so it can't run under systemd.
  - It has no network or media source kind: `SceneSourceKind` is Screen,
    Window, Camera and TestPattern (`protocol.rs:708-713`).
  - Smoke RPCs are compiled out of release builds.
  - It is a single binary crate: `main.rs` with modules, plus a helper
    binary.
- **Chat.**
  - YouTube polls `liveChatMessages` on a quota shared by every user
    (`youtube_chat.rs:1-17`).
  - Twitch uses EventSub (`twitch_chat.rs:1-13`).
  - Kick and X come through the web relay: webhooks → Neon → a long-poll from
    the desktop (`kick_chat.rs:1-16`, `x_chat.rs:1-20`).
  - Without the desktop, YouTube and Twitch reading stops. Kick and X events
    keep arriving at the relay.
- **Phone remote (LAN).**
  - A page served by the desktop: a pairing ticket, derived keys, and client
    frames with a MAC, over plain `ws://` (`docs/remote-control.md:129-241`;
    `remote_lan.rs:1-16`).
  - It can't be relayed as-is:
    - the page hardcodes `ws://${location.host}/ws`;
    - the server checks for an IPv4 Host and a matching Origin;
    - the failure limiter is per IP;
    - server frames are unsigned (`remote_web/app.js:642`;
      `remote_lan_server.rs:443-502`).
  - Intents run in the renderer, through the same code as the on-screen
    buttons.
- **Studio IA.**
  - The sidebar: Studio, Buddy, then Setup (Sources, Scene, Assets,
    Livestream, Captions, Output), then Library and Settings
    (`workspace-nav.tsx:56-75`).
  - Stream settings and the "Ready to go live" checklist live on the
    Livestream page (`go-live-panel.tsx`, `streaming-tab.tsx:358`). Output is
    local recording only.
  - Go Live phases: `checking`, `preparing{platform}`, `starting`
    (`go-live-dialog-view.ts:10-25`).
  - The stats bar: Clock, Viewers, Stream health, Followers, Subs, Tips, Chat
    pace (`stats-bar.tsx:34-52`).
- **Nothing cloud-shaped exists.** There is no LiveKit, WebRTC, WHIP, SRT,
  guest or media-relay code.
- **Web** (`videorcweb` `origin/main` `957df643`). Plan 185's facts cover
  tiers, billing and metering. For this plan:
  - Handlers live in `lib/` with injected dependencies.
  - Migrations end at `0022`, and crons are listed in `vercel.json`.
  - The Kick and X chat relays already run server-side and long-poll Neon.
    There is no WebSocket or SSE anywhere.
  - The multistream guide says "no cloud relay" (`multistream-guide.ts:33`),
    and the privacy page says video stays local (`app/privacy/page.tsx:26`).
  - The open-core doc says multistream is free because it "runs on the
    user's machine" (desktop `docs/distribution.md:413-424`). That stays
    true; the cloud is the paid extra.

## Outside facts (checked 2026-10-16)

### Platforms

- **YouTube allows relays.**
  - Restream and StreamYard are on its list of verified encoders
    ([help](https://support.google.com/youtube/answer/2907883)).
  - With auto-stop on, a broadcast ends "around one minute after" the video
    stops ([lifecycle](https://developers.google.com/youtube/v3/live/life-of-a-broadcast)).
  - Streams have backup ingest addresses for a second, simultaneous push
    ([liveStreams](https://developers.google.com/youtube/v3/live/docs/liveStreams)).
  - No rule against a Be right back screen was found.
- **Twitch allows simulcasting** (ToS §11, modified 2026-08-12), on three
  conditions ([ToS](https://www.twitch.tv/p/en/legal/terms-of-service/)):
  - Twitch's experience is no worse than elsewhere;
  - you don't send viewers away from Twitch;
  - you don't use third-party services that merge other platforms' activity,
    "such as chat", onto the Twitch stream.

  A "temporary 'Be right back' static image" is allowed. Static images used
  for Drop farming are not
  ([CG](https://safety.twitch.tv/s/article/Community-Guidelines)).
  Broadcasts max out at 48 h
  ([broadcast](https://help.twitch.tv/s/article/broadcasting-guidelines)).
- **Twitch and driving**
  ([CG](https://safety.twitch.tv/s/article/Community-Guidelines)).
  - Prohibited: "using a phone while driving", and "reading chat messages or
    physically touching your streaming camera or device for prolonged periods
    of time or frequency while driving".
  - Allowed: "listening to text-to-speech chat messages and responding
    verbally out loud", and setting up "while parked in a safe location prior
    to driving".
  - Kick bans dangerous driving and says nothing about TTS
    ([Kick CG](https://kick.com/community-guidelines)).
- **Kick recommends relays** such as Restream
  ([help](https://help.kick.com/en/articles/7135578-how-to-connect-your-kick-stream-to-restream-service)).
  - Partners who also stream to long-form platforms must turn on `/multi on`
    and earn 50% less for that session
    ([KPP](https://help.kick.com/en/articles/11091744-multistreaming-on-the-kick-partner-program)).
  - Verification rules say to avoid "blank streams"
    ([rules](https://help.kick.com/en/articles/7901645-grounds-for-revoking-or-refusing-verification-or-the-kick-partner-program)),
    one more reason for D12's hold limit.
- **X allows relays**: a third-party service may split one stream into
  Producer, as its own push to an X source. There is no length limit
  ([help](https://help.x.com/en/using-x/how-to-use-live-producer)).

### Market

- **Streamlabs Ultra** ($27/mo) has Stream Shift: move a live stream between
  desktop and phone and keep one VOD. It "relies on Streamlabs'
  infrastructure" ([page](https://streamlabs.com/stream-shift)).
- **Restream** sells fallback video for 5, 15 or 30 minutes, then ends the
  stream, on Business ($239/mo) and up
  ([help](https://support.restream.io/en/articles/13624390-set-up-stream-disconnect-protection)).
  D12's hold works the same way.
- **StreamYard** Advanced ($88.99/mo) has 10 on-screen guests and a track per
  person.
- Plan 185 has the full table.

### Infrastructure

- **LiveKit Cloud** ([pricing](https://livekit.com/pricing)).
  - Build: $0, with 5,000 participant-minutes and 50 GB.
  - **Ship: from $50/mo.** It includes 150k participant-minutes, then
    $0.0005/min, and 250 GB downstream, then $0.12/GB.
  - Scale: from $500/mo, with 1.5M minutes and 3 TB, then $0.0004/min and
    $0.10/GB.
  - Billing is per second, with a 10 s minimum
    ([billing](https://docs.livekit.io/deploy/admin/billing/)).
  - `hidden` is a token grant. Assume the hidden runner is billed like
    anyone else.
  - For a talk show, bandwidth costs more than minutes (plan 185, Costs).
- **Self-hosted LiveKit.**
  - Ports: 7880 (the API, behind TLS), 7881 (ICE/TCP), and UDP 50000–60000
    or one mux port.
  - TURN on 3478/UDP, and TURN/TLS on 5349 (or 443), with its own domain and
    a CA certificate.
  - A room must fit on one node, and the server is bound by CPU and bandwidth
    ([ports](https://docs.livekit.io/transport/self-hosting/ports-firewall),
    [deployment](https://docs.livekit.io/transport/self-hosting/deployment),
    [benchmark](https://docs.livekit.io/transport/self-hosting/benchmark)).
- **Hetzner** (prices from 2026-06-15, before VAT,
  [adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)).
  - AX42 (8 cores, 64 GB): €97.30/mo + €49 setup.
  - AX102 (16 cores, 128 GB): €257.30/mo + €129 setup.
  - **GEX45**: an i5-13500 and an RTX PRO 4000 Blackwell with 2 NVENC
    engines and no session limit. €212.30/mo + €209 setup, Helsinki only
    ([GEX45](https://www.hetzner.com/dedicated-rootserver/gex45/),
    [NVIDIA](https://developer.nvidia.com/video-encode-decode-support-matrix)).
  - Dedicated servers have **unlimited traffic on the 1 Gbit/s port**
    ([traffic](https://docs.hetzner.com/robot/general/traffic/)). They exist
    in Falkenstein, Nuremberg and Helsinki.
  - The US locations are cloud servers only, with 1 to 8 TB included and €1
    per TB after that
    ([locations](https://docs.hetzner.com/cloud/general/locations/)).
- **GStreamer.** 1.28.8 is current.
  - `fallbacksrc` and `fallbackswitch` (gst-plugins-rs, MPL-2.0) switch to a
    fallback after a timeout (5 s by default) and retry.
  - `livekitwebrtcsrc` has existed since 1.24. To stay hidden, pass our own
    `hidden: true` token as `signaller::auth-token`.
  - `srtsrc` has `keep-listening` and `auto-reconnect`, and `rtmp2sink`
    speaks RTMPS.
  - Daily and ShareChat composite with GStreamer in production. LiveKit
    composes in Chrome, and called GStreamer compositing "rigid, verbose and
    difficult to debug"
    ([fallbacksrc](https://gstreamer.freedesktop.org/documentation/fallbackswitch/fallbacksrc.html),
    [livekitwebrtcsrc](https://gstreamer.freedesktop.org/documentation/rswebrtc/livekitwebrtcsrc.html),
    [LiveKit](https://livekit.com/blog/livekit-universal-egress-launch)).
- **FFmpeg and SRT.**
  - libsrt (MPL-2.0) is on FFmpeg's unrestricted list, so `--enable-libsrt`
    keeps an LGPL build LGPL.
  - It needs a crypto library only for encryption. Our macOS build already
    has OpenSSL
    ([configure](https://github.com/FFmpeg/FFmpeg/blob/master/configure),
    [srt](https://github.com/Haivision/srt/blob/master/docs/build/build-options.md)).
  - FFmpeg's WHIP muxer (8.0+) is experimental and takes H.264 baseline only,
    so it won't carry the feed.
- **Phone browsers.**
  - iOS Safari mutes the camera and mic while the page is hidden (another
    app, or the screen locked), and resumes when it's visible again
    ([WebKit](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/Document.cpp),
    [forum](https://developer.apple.com/forums/thread/774239)).
  - Chrome on Android stops the camera in the background
    ([Chromium](https://github.com/chromium/chromium/blob/main/content/browser/renderer_host/media/video_capture_manager.cc)).
  - No verified web workaround exists. A native app is the reliable path for
    long IRL streams.
- **IRL apps.**
  - Moblin (iOS, MIT) pushes RTMP(S), SRT, SRTLA, RIST and WHIP to any server
    ([repo](https://github.com/eerimoq/moblin)).
  - IRL Pro (Android) pushes RTMP or SRT, with SRTLA bonding
    ([site](https://irlpro.app/)).
  - Larix (both) pushes SRT and RTMP(S). SRTLA isn't listed
    ([Larix](https://softvelum.com/larix/)).

## Decisions (⚑ = owner may override)

### D1. Talk shows come before the phone (owner)

"The first user would be me and I would rather create talk shows with
guests." Phase 1 (the cloud holds the stream) still comes first, because a
talk show built in the cloud needs a runner that owns the platform
connections. Guests are Phase 2, the phone is Phase 3.

### D2. The phone is a camera and a remote (owner)

"Mainly the camera … Actually both." Phase 3 ships both, camera first.

### D3. Who gets what (owner; the numbers live in plan 185)

- **Basic**: no cloud.
- **Premium ($39)**: 10 cloud hours a month. Solo shows and the phone. No
  guests.
- **Max ($99)**: 100 cloud hours a month and everything else: talk shows
  with guests, cloud recording, and Phase 4.
- Both tiers meter hours. A live show is never ended because of the meter
  (D18).

### D4. The tier is called Max (owner)

Basic · Premium · Max. The code id is `max`.

### D5. Solo shows: the computer builds the picture, the cloud carries it

- The Studio works exactly as today: scenes, Buddy, captions, cards, masks,
  and the vertical leg. Only the output changes. Instead of one leg per
  platform, FFmpeg sends one feed per orientation to the runner.
- The runner always re-encodes and never passes the feed through. That is
  what makes the switch to the hold image seamless: the platforms see one
  continuous stream with fixed settings.
- The cost is one extra encode on our side and a small quality loss. S0a
  measures it.
- Why not pass-through: splicing a hold image into someone else's H.264
  stream needs identical encoder settings and keyframe-exact switches, and
  platforms handle a mid-stream change badly.

### D6. Talk shows: the cloud builds the picture

Everyone in a talk show, the host included, sends camera and mic into the
room. The runner composes the program from the room.

Why the cloud and not the computer (the 09-15 plan's design):
1. The show survives the host. If the Mac dies, the guests stay on stage and
   the runner keeps composing.
2. A host with a weak upload only sends a camera (2 to 4 Mbps), not a
   program feed plus a camera.
3. The phone, producers and guests all see the same program (the return).
4. The desktop needs no libwebrtc (the 09-15 plan's 264 MB build risk), no
   N-source compositor and no guest decoder.

What this choice costs (accepted):
- Some Studio features don't exist in a talk show at first (D21).
- The host's local recording doesn't contain the guests. The cloud records
  the program instead (Phase 2). The desktop can still record the host's own
  camera and screen as separate files, once plan 157 ships.
- The program the host sees comes back from the cloud. The Show stage view
  draws a local copy from the same layout for instant feedback (D16).

### D7. The runner: Phase 0 decides how it's built ⚑

- **The desktop backend can't simply run on a server** (What exists): it
  aborts without its supervisor, has no network sources, and is one binary
  crate. The runner is new code either way.
- **Default: a new Rust service.**
  - FFmpeg child processes decode each input, encode once, and push each
    leg.
  - The LiveKit Rust SDK brings in room tracks as decoded frames and PCM.
  - Our code switches, composes (simple tiles and image overlays) and fans
    out.
  - It reuses the desktop's pure modules (scene geometry, overlay placement,
    and later `buddy_animator.rs`) once they move into a small shared crate.
  - It carries the plan 161 leg lessons over.
- **Fallback: GStreamer** (`gstreamer-rs` with `fallbackswitch`,
  `compositor`, `audiomixer` and the LiveKit WebRTC source). Use it if S0a
  shows our pipeline can't take inputs appearing and vanishing without
  glitches or A/V drift.
- **Rejected:**
  - LiveKit Egress as the compositor: per-GB pricing on every platform leg,
    Chrome compositing cost at 1080p60, and our core product on a vendor's
    page renderer.
  - OBS in the cloud: one heavy process per show, driven from outside.
- The runner may use x264 (GPL) and NVENC. We run it and don't distribute
  it, so the desktop's LGPL-only rule doesn't apply.

### D8. LiveKit Cloud for WebRTC, self-host later ⚑

- v1 uses LiveKit Cloud: a global edge, TURN and no ops. It's the fastest
  way to good guest connections everywhere.
- Start on the Ship plan ($50/mo): 150k participant-minutes and 250 GB
  included. The owner's own shows fit inside it.
- Guests are the expensive part. LiveKit bandwidth is about $0.50 per hour
  for a 3-person show and about $1.15 for 5 people (plan 185, Costs). Plan
  185 D4 caps guest-hours until self-hosting lands.
- The open-source server speaks the same protocol, so moving to
  self-hosted LiveKit on our nodes is a URL and key change (X8). The traffic
  is then included. Move when the LiveKit bill passes $300 a month, or
  before Max goes on sale beyond the beta ⚑.

### D9. Hosting: Hetzner bare metal, EU first, no Cloudflare in front ⚑

- Bandwidth decides the margin (Outside facts): 5 platforms at 6 Mbps is
  about 13.5 GB per show-hour. Bare metal with traffic included makes that
  close to free.
- **Node type: S0a decides** between two options:
  - an AX102 with x264 (Falkenstein or Nuremberg, closest to Spain);
  - a GEX45 with NVENC (Helsinki). It costs a bit less per month and runs
    roughly three times as many shows (Outside facts).
- Start with 2 nodes, one serving and one spare: about €310 to €515 a month
  before the first customer (plan 185, Costs).
- Add a US location (X8) when US hosts need it. Hetzner has only cloud
  servers there, with metered traffic.
- Ingest hostnames point straight at node IPs (DNS only), never behind
  Cloudflare's proxy. Spain blocks Cloudflare IPs on football nights, which
  are prime streaming time ([[videorc-spain-laliga-cloudflare-block]]).

### D10. The feed goes over RTMPS first, then SRT

- **Phase 1 ships RTMPS.** Today's FFmpeg and leg builders already push
  RTMPS (What exists), so the feed is just one more target pointed at the
  runner. There is no FFmpeg rebuild and no builder change.
- **SRT follows (C1b).** It re-sends lost packets inside a fixed latency
  window (default 2 s), reconnects fast, and is what IRL streamers use. It
  needs libsrt in all three FFmpeg builds plus SRT in
  `validate_stream_publish_url` and the leg builders (S0c).
- **RTMPS stays the fallback** for networks that block UDP.

### D11. No new switch next to Go Live

- Owner rule ([[feedback-simple-actions-not-studio-switches]]). For Premium
  and Max, Go Live goes through the cloud by default. The setting lives on
  the Livestream page, next to stream quality and "Ready to go live", where
  stream settings already are (What exists, Studio IA): "Stream through
  Videorc Cloud", on.
- If the cloud can't be reached, is full, or the month's hours are used up,
  Go Live streams directly from the computer like today and says why once.
- Talk shows start from the Guests page (G13), not from a new transport
  control.

### D12. Hold rules ⚑

- The feed has been gone for 1.5 s: the runner freezes the last frame for
  1 s, then fades to the hold image. The hold image is your Be right back
  takeover, or a default card with the channel name. Audio goes silent (no
  bundled music in v1, because of VOD audio rules).
- The feed is back and steady for 1 s, with a keyframe: fade back.
- A hold lasts at most 30 minutes (Livestream page: 5, 15, 30 or 60), then the
  runner ends the show cleanly. Hold time counts as cloud hours.

### D13. Platforms end cleanly without the computer

- **YouTube.** Broadcasts are already created with `enableAutoStop: true`
  (What exists). When the runner stops pushing, YouTube completes the
  broadcast by itself. While the runner holds it never stops pushing, so
  auto-stop can't fire early.
  - When the desktop is there, it still moves the broadcast to `complete`
    at stop, as today.
- **X.** The renderer ends the X broadcast with an API call today. Phase 1
  checks what X does when the RTMP stream stops without that call (part of
  the Phase 1 acceptance run).
  - If X keeps the broadcast open, the desktop hands the runner the
    session's X credentials too, memory only, and the runner ends it.
  - The consumer secret moves to the runner's environment. It's ours.
- **Twitch and Kick** end when the stream stops. There is nothing to call.
- **Every YouTube API call stays on the user's computer** (What exists,
  compliance promise). The runner only pushes video to YouTube's ingest.
  - Anything that needs a server-side YouTube API call waits for the owner
    to update that promise and the OAuth setup with Google: YouTube chat
    without the computer (D17) and going live from the phone alone (X6).

### D14. Where the code lives ⚑

- The runner and the node agent go in a new private repo, `videorc-cloud`
  (a Rust workspace). Shared engine code comes from the desktop repo as a git
  dependency on a pinned commit.
- The desktop repo is AGPL-3.0. Reusing its code in a private server is
  fine only if the owner holds the copyright to every reused file, and S0e
  checks the authors. If the owner doesn't, the runner stays AGPL in the
  public repo. The hosted service is still the product.
- The control plane lives in `videorcweb`, as usual.

### D15. Security model

- The control plane mints every credential, short-lived and scoped to one
  show:
  - an SRT passphrase and stream id per feed;
  - LiveKit tokens per participant (host, guest, phone, runner), with the
    room pinned;
  - a show token (Ed25519, like the entitlement token), which the runner
    checks on its control socket.
- Stream keys and platform tokens go from the desktop backend to the runner
  over the control socket (TLS), never through the renderer. The runner holds
  them in memory and drops them at show end. A runner test in the style of
  `smoke:streaming-secrets` proves no key reaches a log, a metric or a disk.
- **YouTube data needs the owner's word with Google first.** A YouTube
  stream key is API data, and so is YouTube chat. Our YouTube ToS reply
  describes both as staying on the user's computer
  (`docs/compliance/youtube-tos-report-v1-reply.md:44-66`).
  - Before cloud shows with YouTube reach anyone but the owner, the owner
    updates that answer with Google, and the privacy policy with it: for
    Videorc Cloud users the stream key (Phase 1) and chat (Phase 3) pass
    through our servers in memory during the show and are never stored.
- Nodes authenticate to the control plane with a per-node key. A node that
  misses heartbeats gets no new shows.
- A guest link is a random slug with a name field and a capacity limit. The
  host can remove anyone, and ending the show kills the link.

### D16. The Studio during a talk show ⚑

- While a talk show runs, the Studio's preview area becomes the **Show
  stage**: the program layout, drawn by the renderer from the room's tracks
  (instant). A small "Program" monitor shows what the cloud actually sends
  (the return, about half a second behind).
- The detached native preview window shows the return during a talk show,
  or hides. S0b decides which is simpler and smooth.
- The host app joins the room from the renderer with LiveKit's JS SDK:
  camera, mic and screen share. The backend's own camera capture pauses
  during the show, so the camera has one owner. If S0b finds screen share
  not sharp enough, X10 adds native publishing from the backend.
- Record during a talk show records in the cloud (Max). Once Separate source
  recordings ships (plan 157, PR #632 still open), the desktop can also
  record your own camera and screen as their own files.

### D17. Chat follows the show

- **While the desktop is connected** it does chat as today, and also
  forwards the merged chat stream to the runner over the control socket, so
  the phone and producers see the same chat. Nothing is stored. The runner
  keeps the last 200 messages in memory for late joiners.
  - Before YouTube chat is forwarded, the owner confirms it fits the
    compliance reply. The API calls still go from the computer. Only the
    already-fetched messages travel on, to the user's own phone. Add a privacy
    page line for it. ⚑
- **When the desktop is gone** (Phase 3):
  - **Kick and X**: they already arrive at the web relay. The phone page
    long-polls the same relay with the user's session.
  - **Twitch**: the runner reads the channel's chat anonymously, read-only.
    It needs no user token.
  - **YouTube**: the phone says "YouTube chat comes back when your computer
    reconnects." This stays until the owner updates the compliance promise
    (D13).
- **Sending chat** from the phone (Phase 3 stretch) goes through the
  desktop when it's there. Without it, only Kick and Twitch can send, with
  credentials handed over for the session, memory only.

### D18. Never end a live show because of the meter

- Hours are checked when a show starts: at least 5 minutes must be left.
- A show that runs past the allowance keeps going. The extra minutes are
  recorded and shown, not billed (plan 185 D-rules).
- Any single show ends after 12 hours, with a warning at 11 hours (runaway
  guard).

### D19. Platforms: macOS first

- Solo shows: macOS first. Windows follows once its FFmpeg build has libsrt
  and an acceptance record. Linux comes later.
- Talk shows: the host app on macOS first. Renderer WebRTC works on Windows
  too, but there the backend and the renderer can't share a camera.
- Guests and the phone: any current browser (Safari on iOS, Chrome on
  Android, and desktop Chrome, Safari, Firefox and Edge).

### D20. Order of shipping

- Web first, behind kill switches `VIDEORC_CLOUD_DISABLED` and
  `VIDEORC_CLOUD_TALK_SHOWS_DISABLED` (both default `true`).
- Then the runner on the nodes.
- Then the desktop release.
- Then the switches flip for the owner only (plan 185's allowlist), then
  for the tier.
- One PR per slice group, as usual.

### D21. What a talk show has at launch, and later ⚑

| Studio feature | Solo show | Talk show, Phase 2 | Talk show, Phase 4 |
| --- | --- | --- | --- |
| Comment card on click | yes | yes (desktop renders the PNG, the runner draws it) | yes, also without the computer (X5) |
| Takeovers, Be right back | yes | yes | yes |
| Buddy on stream | yes | no | yes (X3) |
| Captions | yes | no | yes (X4) |
| Vertical leg | yes | yes (vertical layout, last slice G12) | yes |
| Recording with guests | n/a | cloud recording of the program | plus each person as their own file (X1) |
| Masks, chroma key, freeform scenes | yes | tile shapes only | not planned |

## Wire shape (Phase 1)

All three repos build against this. Change it here first, then in all three.

### Ids

- `showId`: `sh_` plus 22 base62 characters.
- `nodeId`: like `eu-hel-1`. Local development uses `local-1`.

### Show token (the web mints it, the desktop carries it, the node checks it)

- Format: `vcs1.<payload>.<signature>`. The payload is base64url JSON. The
  signature is Ed25519 over the ASCII bytes `vcs1.<payload>`, base64url. It
  has the same shape as the entitlement token (`v1.…`).
- Payload: `{ "v": 1, "sub": "<userId>", "show": "<showId>", "node":
  "<nodeId>", "role": "host", "iat": <s>, "exp": <s> }`.
- TTL: the longest show plus the hold limit, 12.5 h.
- Web env: `VIDEORC_CLOUD_SHOW_SIGNING_KEY` (an Ed25519 private key, encoded
  like `VIDEORC_ENTITLEMENT_SIGNING_KEY`).
- Node env: `VIDEORC_CLOUD_SHOW_PUBLIC_KEY` (32 raw bytes, base64url).

### Node signatures (web ↔ node agent, both directions)

- Headers:
  - `X-Videorc-Node: <nodeId>`
  - `X-Videorc-Timestamp: <unix ms>`
  - `X-Videorc-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`
- Reject a timestamp more than 300 s off, and compare in constant time.
- One secret per node:
  - web env `VIDEORC_CLOUD_NODE_SECRETS`: JSON `{ "<nodeId>": "<base64url 32
    bytes>" }`;
  - node env `VIDEORC_NODE_SECRET`.
- Web env `VIDEORC_CLOUD_NODES` lists the nodes: a JSON array of `{ "id",
  "region", "agentUrl", "publicHost", "rtmpsPort", "rtmpPort" }`. The
  `cloud_nodes` table holds their live state.

### Desktop → web

All of these use the bearer, `private, no-store`, and the `{ error: { code,
message } }` envelope.

`POST /api/cloud/shows`:

```json
{ "kind": "solo",
  "outputs": [{ "orientation": "horizontal", "width": 1920, "height": 1080, "fps": 60, "videoKbps": 6000, "audioKbps": 160 }],
  "holdMaxSeconds": 1800,
  "client": { "app": "desktop", "version": "0.9.144" } }
```

answers 201:

```json
{ "show": { "id": "sh_…", "status": "ready", "nodeId": "eu-hel-1", "createdAt": "…", "expiresAt": "…" },
  "ingest": [{ "orientation": "horizontal", "serverUrl": "rtmps://eu-hel-1.live.videorc.com:1936/live", "streamKey": "sh_…-h.<ingestKey>" }],
  "control": { "url": "wss://eu-hel-1.live.videorc.com:9443/v1/shows/sh_…/control", "token": "vcs1.…" },
  "allowance": { "secondsPerMonth": 36000, "secondsUsed": 1200, "overageSeconds": 0, "resetAt": "…" } }
```

- **Errors:**
  - 401;
  - 403 `cloud-not-entitled`;
  - 409 `cloud-show-live`, whose body carries the live show, its `kind`
    included;
  - 429 `cloud-hours-used-up`, with `resetAt`;
  - 429 `cloud-test-limit`, with `resetAt` (a test, below);
  - 503 `cloud-disabled`, `cloud-full` or `cloud-node-unreachable`.
- **`kind: "test"`** (C6b, added 2026-10-17): Test cloud's show. It has no
  destinations, costs no cloud hours (a used-up month may still test), is
  limited to six an hour per account, and reaches the node as `kind: "solo"`
  with `maxShowSeconds: 30`. It is never current. A 409 that names a test
  (one a crashed desktop left open) is ended by the desktop, which then
  creates again, once.
- `GET /api/cloud/shows/current` (bearer or cookie) → `{ "show": {…} | null,
  "control"?: { "url", "token" } }`, with a fresh token, for resume.
- `POST /api/cloud/shows/:id/end` (bearer or cookie) → `{ "ok": true }`.
- `GET /api/cloud/allowance` → plan 185's `cloud` block.
- The ingest pair has the shape of any platform destination, so the
  desktop's cloud target is a plain `{server}/{key}` RTMPS target (C3).

### Web → node agent (node-signed)

- `POST {agentUrl}/v1/shows` with `{ "showId", "userId", "kind": "solo",
  "outputs": [ …as above… ], "holdMaxSeconds", "maxShowSeconds", "ingestKey" }`.
  - 200: `{ "ingest": [{ "orientation", "serverUrl", "streamKey" }],
    "controlUrl" }`.
  - 409 when the show exists; 503 `node-full`.
- `POST {agentUrl}/v1/shows/:id/end` → `{ "ok": true }`.
- `GET {agentUrl}/v1/health` → `{ "ok", "version", "capacity": { "slots",
  "used" } }`.

### Node agent → web (node-signed)

- `POST /api/cloud/nodes/heartbeat`, every 10 s:
  - body `{ "nodeId", "version", "capacity": { "slots", "used" }, "shows": [{
    "showId", "phase", "startedAt" }], "at" }`;
  - answer `{ "ok": true, "endShows": ["sh_…"], "drain": false }`.
- `POST /api/cloud/usage`, every 60 s:
  - body `{ "nodeId", "reports": [{ "showId", "seq", "liveSeconds",
    "holdSeconds", "at" }] }`;
  - answer `{ "ok": true, "accepted": [{ "showId", "seq" }] }`.
  - Idempotent on (`showId`, `seq`). The seconds are per report, not running
    totals.

### Ingest on the node

- MediaMTX listens for RTMPS on 1936, and for RTMP on 1935 in local
  development only.
- Publishing is authorised by the node agent. It accepts
  `live/<showId>-<h|v>.<ingestKey>` only while that show is live.
- The runner reads its feed locally from MediaMTX.

### Control socket (desktop ↔ node agent ↔ runner, over WSS)

- **Connecting.** Open `control.url` and send `{ "t": "hello", "token":
  "vcs1.…", "client": { "app": "desktop", "version": "…" } }` as the first
  frame.
  - The agent checks the signature, `exp`, `show` and `node`.
  - It answers `{ "t": "welcome", "state": { … } }`, or closes with 4401 (bad
    token) or 4404 (no such show).
- **Client → runner:**
  - `{ "t": "intent", "id": "<uuid>", "kind": "destinations.set",
    "destinations": [{ "id", "platform", "label", "orientation", "url" }] }`.
    `url` carries the key, so it lives in memory only and is never logged.
    Each `id` is the desktop's target id, so leg state maps back onto the
    desktop's own per-destination UI.
  - `{ "t": "intent", "id", "kind": "hold.image.set", "pngBase64": "…" }`.
    Without one, the runner draws a default card.
  - `{ "t": "intent", "id", "kind": "hold.start" }`, and the same with
    `hold.stop` and `show.end`.
  - `{ "t": "intent", "id", "kind": "ingest.get" }`. The ack carries
    `"result": { "ingest": [{ "orientation", "serverUrl", "streamKey" }] }`,
    the same pairs the create response had (added 2026-10-17).
    - Resume after a relaunch needs it. The web never stores ingest keys
      (W2), and the desktop never persists them, so only the node, which
      already holds the show's ingest key, can hand it back.
    - It answers only on a socket whose `hello` carried a valid show token.
  - `{ "t": "ping" }` every 5 s. Three missed pings mark the desktop as gone.
    That changes the state only, not the feed logic.
- **Runner → client:**
  - `{ "t": "state", "state": { "phase": "starting|live|hold|ending|ended",
    "endReason"?, "hold": { "active", "since", "reason": "feed-lost|manual",
    "remainingSeconds" }, "liveSeconds", "feeds": [{ "orientation",
    "connected", "kbps" }], "legs": [{ "id", "platform", "label",
    "orientation", "state": "connecting|live|reconnecting|failed|ended",
    "since", "error"? }] } }`. Sent on every change, and at least every 2 s.
  - `{ "t": "ack", "id", "ok", "error"?, "result"? }` and `{ "t": "pong" }`.
    Only `ingest.get` acks carry a `result`.
- **Runner phases:**
  - `starting`: waiting for the first feed. After 60 s without one, the show
    ends with `no-feed`.
  - `live`, `hold`, `ending`, `ended`.
  - The platforms start only when the first feed frame arrives.

## Phase 0: prove the hard parts (about 1 to 2 weeks, throwaway)

Each spike ends with a dated note in `docs/cloud/` with the numbers and a go
or no-go. Nothing ships.

- **S0a. Runner spike.** On one rented Hetzner box (the Linux lab box is
  fine for the first runs):
  - FFmpeg pushes a synthetic 1080p60 feed with A/V test signals at 8 and 12
    Mbps, over RTMPS (Phase 1) and over SRT (C1b). The runner decodes it, runs the hold switch, re-encodes
    with x264 and fans out to 3 local RTMP receivers, plus one leg through
    induced packet loss (`tc netem`, already in the live lab helpers).
  - Kill the feed for 10 s, 60 s and 5 min, then restore it. Measure: time to
    hold, time to resume, gaps on the receivers (ffprobe pts continuity), A/V
    sync on the receivers (the analyzers in `scripts/lib/`), CPU per show,
    and the quality loss against the feed (VMAF or PSNR, 8 and 12 Mbps in, 6
    Mbps out).
  - Build it twice: as D7's default Rust service and as a GStreamer pipeline
    (`fallbacksrc`). Record the build effort and how each handles a vanishing
    input.
  - Run it on both node types: x264 on an AX102, and NVENC on a GEX45.
    Compare shows per box and quality per bitrate.
  - Add 4 room participants (browser tabs publishing test patterns through
    LiveKit Cloud) and compose a 2×2 grid. Measure CPU and glass-to-glass
    latency.
  - **Done when** `docs/cloud/spike-runner-2026-10.md` picks D7's path and
    gives CPU per solo show and per 4-person talk show.
- **S0b. The host app in a room.** The Electron renderer joins a LiveKit room
  with camera (1080p30), mic and screen share (Electron's capturer).
  - Measure screen-text legibility at 1080p (4, 6 and 8 Mbps; H.264 and VP9;
    `contentHint: 'detail'`) and CPU.
  - Check whether the backend and the renderer can share the camera on
    macOS.
  - Compare the return in a `<video>` element with the native preview.
  - **Done when** `docs/cloud/spike-host-room-2026-10.md` says whether
    renderer publishing is good enough, or names what fails.
- **S0c. SRT in our FFmpeg.** Build the macOS FFmpeg with libsrt, keeping the
  current license mode (Outside facts). Push SRT from the dev app to the S0a
  runner by changing the tee by hand. Measure the upload overhead and the
  reconnect after a Wi-Fi drop. Read the Windows and Linux build scripts for
  the same change.
  - **Done when** the note lists the configure changes, the binary size delta
    and the license check.
- **S0d. Costs measured, not guessed.** From S0a and S0b, compute CPU per
  show, LiveKit minutes and GB for a 3-person, 1-hour room, and recording GB
  per hour.
  - **Done when** plan 185's cost table carries the measured numbers.
- **S0e. Code ownership check (D14).** Run `git log --format='%an %ae' --
  <files the runner would reuse>` on the desktop repo and list any author who
  isn't the owner or the owner's agents.
  - **Done when** the note says whether D14's private repo is allowed.

## Phase 1: the cloud holds your stream (solo shows)

Goal: Premium and Max users go live through the cloud, and the stream
survives the computer.

### Infra (`videorc-cloud`)

- **I1. Nodes.** Provision 2 Hetzner dedicated servers (sizes from S0d) from
  a script in `videorc-cloud/ops/`: firewall (SRT UDP range, RTMPS, control
  socket, SSH from an allowlist), time sync, security updates only while
  drained, and a pinned GPL FFmpeg with x264.
  - **Done when** a fresh box comes up from the script and passes
    `ops/check-node`.
- **I2. Node agent.** A small Rust daemon on each node:
  - it registers with the control plane (node key) and reports capacity
    every 10 s;
  - it starts and stops runner processes on request and hands out ports;
  - it ships logs;
  - it drains (no new shows, waits for live ones to end) before any update
    or reboot, and never restarts a node with a live show.
  - **Done when** unit tests cover placement, drain and ports, and a staging
    node starts and stops 20 runners in a loop with no leaked process or
    port.
- **I3. Deploys.** CI builds `videorc-runner` and `videorc-node-agent` for
  Linux x64 and uploads them to a private bucket. The agent updates itself
  only while drained.
- **I4. Watching.** Per-show metrics (input bitrate, hold state, per-leg
  state, encoder fps and drops, CPU) and logs go to a hosted backend ⚑
  (default: Grafana Cloud's free tier). Alerts go to the owner's phone: node
  down, a leg dead for 60 s, a runner crash, capacity above 70%.
- **I5. DNS and TLS.** `<node>.live.videorc.com` as DNS-only records,
  certificates by ACME on each node.

### Runner (`videorc-cloud`)

- **R1. Feed input.**
  - First an RTMPS listener with a port per show and a per-show key in the
    stream path. Then, with C1b, an SRT listener with a passphrase and a
    stream id check.
  - A child FFmpeg decodes to raw frames and PCM, and restarts on any error
    without touching the output.
- **R2. Output.**
  - One encoder (x264 or NVENC, from S0a) at the show's settings.
  - An in-process fan-out to one remux process per destination. Each has its
    own bounded queue, reconnects with backoff, and reports why it died (the
    plan 161 lessons, now on our side).
  - The vertical leg is a second feed into a second output group.
- **R3. Switcher and hold.** The state machine `starting → live ⇄ hold →
  ending → ended`, with D12's timings, the hold image, freeze then fade, and
  silence. Pure and unit-tested.
- **R4. Control socket.** A WebSocket over TLS, checked with the show token.
  - Events: `show.state` (hold, legs, bitrate, timers).
  - Intents: `destinations.set`, `hold.image.set`, `hold.start`,
    `hold.stop`, `show.end`, and the desktop's heartbeat.
  - The naming follows `docs/remote-control.md`.
- **R5. Usage.** Every 60 s the runner sends a signed usage report to the
  control plane: show id, sequence number, seconds live and seconds on hold.
  It retries with the same sequence and keeps it on disk, so a restart never
  double-counts.
- **R6. Crash safety.** The agent restarts a crashed runner from its last
  state. Destinations and tokens come back when the desktop reconnects (they
  are never on disk). The platforms see a short drop, and the desktop says
  so.
- **Tests:** unit tests for R3 and R5. An integration test runs the runner
  against local RTMP receivers and checks continuity with ffprobe across feed
  drops (the S0a harness, kept and maintained).

### Control plane (`videorcweb`)

- **W1. Entitlements**, from plan 185 T1: the `cloud` feature and the
  `cloudHoursPerMonth` limit (Premium 10, Max 100).
- **W2. Tables** (next free migration numbers):
  - `cloud_nodes`: id, region, host, public key, capacity, last heartbeat,
    state;
  - `cloud_shows`: id, user, node, kind (`solo` or `talk`), status, created,
    started, ended, end reason;
  - `cloud_show_usage`: show, sequence, seconds, unique on (show, sequence);
  - the monthly usage rows from plan 185 T2.
- **W3. Routes.** Each handler lives in `lib/cloud/` with injected
  dependencies; routes use `runtime = "nodejs"` and `private, no-store`, and
  check the kill switch first.
  - `POST /api/cloud/shows` (bearer; entitlement; at least 5 minutes left;
    one live show per user). It places the show on a node and returns
    `{ showId, ingest: { srtUrl, rtmpsUrl, passphrase }, control: { url,
    token }, expiresAt }`.
  - `GET /api/cloud/shows/current` (bearer or cookie): the live show, for
    resume and the Live page.
  - `POST /api/cloud/shows/:id/end` (bearer or cookie): tells the runner to
    end the show.
  - `POST /api/cloud/nodes/heartbeat` and `POST /api/cloud/usage` (node key,
    signed body).
- **W4. Placement.** The least-loaded healthy node with room. If none has
  room, return 503 `cloud-full`: the desktop streams directly and the owner
  gets an alert.
- **W5. Reaper** (cron). A show whose runner has been silent for 5 minutes
  ends. A node silent for 30 s gets no new shows.
- **W6. The Live page**, `videorc.com/live` (signed in): "Live through
  Videorc Cloud · Be right back for 3 min · YouTube ✓ Twitch ✓", with End
  stream. You open it when the computer is gone. It grows into the phone
  page in Phase 3.
- **W7. Docs and privacy.**
  - `docs/cloud.md`: env, kill switches, rollback.
  - The privacy page: what passes through our servers, what's kept, and
    where. Today's line that video stays local (`app/privacy/page.tsx:26`)
    gets a cloud exception.
  - The terms: acceptable use.
  - The owner updates the YouTube compliance answer (D15) before the cohort
    grows past the owner.

### Desktop (`videorc`)

- **C1. The feed over RTMPS (first).** The cloud target is a normal RTMPS
  target pointed at the runner, so neither FFmpeg path changes (D10).
- **C1b. The feed over SRT (after S0c).**
  - libsrt in the macOS FFmpeg build, then Windows and Linux.
  - `srt://` in `validate_stream_publish_url`, and an MPEG-TS leg next to
    the FLV builders.
  - RTMPS stays the fallback when SRT can't connect within 3 s.
  - `smoke:recording-matrix` stays green.
- **C2. `cloud_show.rs`.**
  - Creates the show through the web API and connects the control socket.
  - Keeps the state machine: `off`, `connecting`, `live`, `hold`,
    `resuming`, `ending`, `failed`.
  - Hands over destinations and maps the runner's leg state into the
    existing leg model.
  - Falls back to direct legs only after the control plane confirms the
    show is gone. A desktop that merely lost its own connection must never
    open direct legs while the runner still holds the platforms: two pushes
    to one key make the platform drop both.
- **C3. The output seam** (What exists).
  - In cloud mode, `rec:3252-3277` keeps the resolved `stream_targets`
    (keys plain) for the hand-over.
  - It replaces them with one `StreamTarget` per orientation that points at
    the runner: platform `cloud`, label "Videorc Cloud".
  - Every builder and `StreamLegMonitor` then works unchanged on that one
    leg. The hand-over goes backend → runner and never through the renderer.
  - A unit test proves the swap.
  - A test in the `smoke:streaming-secrets` style proves that no plain key
    reaches the renderer, logs or the settings file.
- **C4. Go Live through the cloud.**
  - A `cloud` phase between `preparing` and `starting` in the Go Live dialog
    (`go-live-dialog-view.ts`), shown on its button as "Connecting to Videorc
    Cloud…".
  - Platform prep (YouTube broadcast, Twitch, Kick and X keys) runs from the
    renderer exactly as today.
  - On failure, `cloud-full` or no hours left: stream directly, with one
    toast saying why.
  - Per-platform state comes from the runner.
- **C5. Resume after a relaunch.** At launch, call `GET
  /api/cloud/shows/current`. If a show is live, show a banner: "You're still
  live through Videorc Cloud. Viewers see Be right back." with Resume and End
  stream. Resume starts a new local session linked to the same show.
- **C6. Livestream page** (stream settings live there; Output is local
  recording). A "Videorc Cloud" section next to stream quality:
  - the switch (on by default when entitled);
  - hours left this month;
  - the hold image and the hold limit;
  - "Test cloud": a 10-second private test against a runner, with no
    platforms.
- **C7. Status.** The stats bar's Stream health stat says "Cloud" with its
  state. There is no new stat, so the 32 px bar stays as it is. The Stream
  Manager shows hold time and per-platform state from the runner.
  `platform_stream_watch.rs` keeps polling YouTube from the computer, as
  today.
- **C8. Smokes.**
  - New `smoke:cloud-solo`:
    - the dev app streams through a local runner (built from
      `videorc-cloud`) to 2 local RTMP receivers;
    - cutting the feed (kill the stream encoder) keeps the receivers on the
      hold image, with no gap over 2 s;
    - resuming brings the content back;
    - stopping ends the receivers;
    - ffprobe checks every artifact.
  - `smoke:multistream`, `smoke:stream-leg-eof` and `smoke:streaming-secrets`
    stay green and unchanged.

**Phase 1 acceptance (the owner):** a 2-hour stream to the owner's real
channels through the cloud, as a live test on the owner's go.
- Pull the network for 2 minutes.
- Quit the app, relaunch, and resume.
- Update the app mid-stream.

It passes when the platforms show one broadcast, the VOD is one piece, and
the hours meter is right.

## Phase 2: talk shows with guests (Max)

Goal: the owner runs a talk show with browser guests. The cloud composes it,
sends it everywhere and records it, and it survives the owner's computer.

### Web (`videorcweb`)

- **G1. Rooms.** One LiveKit room per talk show, created with the show.
  Tokens by role: `host`, `guest`, `runner` (hidden), later `phone` and
  `producer`. The room is pinned in every token.
- **G2. The guest page**, `videorc.com/guest/<slug>`:
  - noindex, no site chrome, one glass card;
  - step 1: the show's name, a name field, and a camera and mic check;
  - step 2: "You're backstage. The host will bring you on.", then on stage
    with your own tile, the return, mute, camera off and Leave;
  - states: link not valid, show full, show ended, waiting for the host;
  - one consent line: "This show is live on YouTube and Twitch and is
    recorded. Your camera and voice are part of it."
  - Works on Safari for iOS and Chrome for Android. Publishes H.264 with
    simulcast.
- **G3. LiveKit webhooks**: join and leave go into a `cloud_room_minutes`
  table for the cost guardrails (plan 185). The webhook is verified and
  idempotent on its event id.
- **G4. Limits**: up to 5 guests on stage and 10 people in the room
  (plan 185).

### Runner (`videorc-cloud`)

- **G5. Room input.** The runner joins as a hidden participant and decodes
  the tracks, each latest-wins with its own buffer (the 09-15 plan's
  frame-store rules).
- **G6. Layouts.**
  - Solo, Side by side (2 to 6 in a grid), Screen + people (the screen
    share large, people in a column), and Spotlight (one person large).
  - Names under the tiles, rounded tiles, and the host's camera shape.
  - Geometry from shared code with unit tests for 1 to 6 people (even
    pixel sizes, no overlap, inside the canvas).
- **G7. Audio mix.**
  - Everyone on stage plus screen-share audio, with gain and mute per person.
  - Guests hear each other through the room, never the program, so there is
    no echo.
  - The mix clock is the runner's clock. A late source gets silence and a
    counted underrun, and never stalls the mix.
- **G8. Overlays.** The desktop sends comment cards and takeovers as PNGs on
  the control socket, with the existing placement rules (shared overlay
  layout).
- **G9. The return.** The runner publishes the program into the room at 720p
  for the host, the phone and producers.
- **G10. Cloud recording.**
  - The program goes to segmented MP4 in object storage, then appears in the
    account as a download.
  - Kept for 30 days (plan 185).
  - Recording works without going live (Record in a talk show).
- **G11. The host is away.** If the host's tracks are gone for 5 s, their
  tile says "Back in a moment" and the show goes on. With nobody on stage,
  the hold image shows.
- **G12. Vertical.** A vertical people layout for the vertical leg. This is
  the last slice and can move to Phase 4.

### Desktop (`videorc`)

- **G13. The Guests page** in the sidebar's Setup group, after Livestream.
  Buddy stays second under Studio
  ([[feedback-buddy-page-under-studio]]). The page is where invites and
  settings live:
  - the invite link with Copy, and "New link" (the old one stops working);
  - the guest limit;
  - the list of who joined, with Remove.
  - Premium sees the Max lock: "Talk shows with guests come with Videorc
    Max."
  - Moving people on and off stage is not here. It lives on the Show stage
    (G14): one home per control.
- **G14. The Show stage.** The Studio's preview area during a talk show
  (D16):
  - the layout drawn from the room's tracks, plus a Program monitor with the
    return;
  - a backstage strip under it. Each person shows their name, connection
    quality and mic level, with Bring on, Send backstage and Mute;
  - layout chips: Solo, Side by side, Screen + people, Spotlight.
  - The controls stay Record and Go Live. Nothing joins them.
- **G15. The host joins the room** from the renderer (LiveKit JS): camera,
  mic, and screen share. The backend camera pauses during the show and
  resumes after it.
- **G16. Go Live and Record in a talk show.** The same buttons. They talk to
  the runner, and destinations are handed over as in C2.
- **G17. Comment cards in a talk show.** A click on a chat row renders the
  card as today and sends it to the runner (G8).
- **G18. Smokes.**
  - New `smoke:cloud-talk-show`: two headless browsers publish test patterns
    as guests, the dev app joins as host, and the runner composes each
    layout to a local RTMP receiver.
  - Pixel probes at the tile centres prove each layout.
  - A tone per guest proves the audio mix.
  - Killing the host proves G11.
  - The cloud recording file is checked with ffprobe.

**Phase 2 acceptance (the owner):** a 1-hour talk show with 2 guests (one on
a phone browser) to 3 or more platforms. The recording downloads. Kill the
Mac mid-show and the guests carry on; bring it back and the host is back.

## Phase 3: your phone: camera and control

Goal: the car scenario, end to end.

- **P1. The phone page** is `videorc.com/live` (W6), now a Progressive Web
  App you can add to the home screen. Signed in, it shows the live show, or
  "You're not live" with the last show.
- **P2. The phone's camera.**
  - "Use this phone's camera" joins the room as `phone`: front or back
    camera, mic, 720p or 1080p.
  - **Take over**: in a solo show the runner switches the program from the
    feed to the phone (full frame, with overlays). In a talk show the phone
    becomes the host's tile.
  - **Give back**: the computer takes the program back.
  - If the computer drops while the phone is in the room, the runner offers
    the phone instead of the hold image: one tap on the phone, or
    automatically if "Take over by itself" is on ⚑.
  - Phone browsers pause the camera and mic whenever the page isn't visible
    (Outside facts). So while the camera is on, the page holds a screen Wake
    Lock and says once: "Keep Videorc open on screen while you're on camera."
  - If the phone's tracks pause anyway, the runner treats it like a dropped
    feed: the hold image, then back when the page is visible again.
  - For long IRL streams the reliable paths are an IRL app (P6) or our own
    app (X11).
- **P3. Control.** The Stream Manager on the phone.
  - **How intents travel:** phone → runner (control socket) → desktop
    backend → the renderer's existing intent executor, the same path Stream
    Deck and Phone remote use (`docs/remote-control.md`). So the phone can't
    do anything the UI would refuse.
  - Without a desktop, the runner runs the intents it owns itself: hold,
    Take over, layouts and guests in a talk show, End stream.
  - Phone remote on the LAN stays exactly as it is.

  What the phone page offers:
  - chat from the show's chat stream (D17);
  - a click on a row puts it on stream, like the desktop
    ([[feedback-chat-row-click-shows-on-stream]]). The card is rendered on
    videorc.com in the same style and sent to the runner;
  - Be right back, layouts, guests, End stream, and per-platform state.
- **P4. Chat without the computer** (D17).
- **P5. Drive mode.** One big screen: the camera, a viewer count, and one
  huge "Be right back" button. New chat is read aloud by the phone (rate
  limited, names first). No reading, no touching (Outside facts: Twitch).
  Voice commands ("Buddy, be right back") come in X3 with cloud Buddy.
- **P6. IRL apps.** "Add an IRL camera" shows the show's SRT address and
  passphrase as a QR code for Moblin, Larix or IRL Pro. The runner treats it
  like the phone camera: Take over and Give back.
- **P7. Smokes.**
  - New `smoke:cloud-phone`: a headless mobile-sized browser joins as the
    phone, takes over a solo show, and gives back. Receivers prove the
    switch.
  - Chat projected to the phone from fake providers (`smoke:live-chat-fake-
    providers` style).

**Phase 3 acceptance (the owner), the car scenario:**
1. The Mac streams to the owner's channels through the cloud.
2. The phone opens videorc.com/live and takes over.
3. The Mac shuts down, and the owner walks to the car with the phone in Drive
   mode, as a passenger or parked.
4. The stream continues the whole time.
5. Back home, the Mac takes the show back and ends it.

## Phase 4: more for Max

Each item is its own slice group with its own short plan when it starts.

- **X1. Each person as their own file.** The runner records each person's
  track (ISO) next to the program, for editing and Clean cut.
- **X2. Producer seat.** Invite a teammate by email (2 seats). A producer can
  change layouts, manage guests, put comments on stream and use Be right
  back. Ending the stream is the host's, unless the host allows it.
- **X3. Buddy holds the show.**
  - The runner draws Buddy (shared `buddy_animator.rs`) on hold and on host
    away, and Buddy talks with chat through the existing co-host tick.
  - Voice commands from the phone's mic ("Buddy, be right back").
- **X4. Captions in talk shows.** The runner streams the program audio to
  the captions gateway (plan 175) and draws the captions.
- **X5. Cards without the computer.** videorc.com renders cards server-side
  (the OG image renderer), so the phone, a producer or Buddy can put a
  comment on stream with no desktop.
- **X6. Go live from the phone alone.** This needs stored credentials: an
  owner decision first, then server-side YouTube broadcast creation, stored
  Twitch and Kick keys (encrypted), and a re-check of the Google OAuth
  verification.
- **X7. Alerts.** Push notifications to the host's phone: a leg dropped, the
  hold started, hours at 80%.
- **X8. Scale.** Self-hosted LiveKit on our nodes, a US location, and YouTube
  backup ingest from a second node.
- **X9. A solo show becomes a talk show** mid-stream (invite a guest while
  live).
- **X10. Native publishing** of the host's camera and screen from the
  backend, if S0b found renderer screen share too soft.
- **X11. A native phone app** (iOS first) that keeps the camera running in
  the background, which no browser does (Outside facts). Moblin is
  MIT-licensed and does most of this, so check whether to build on it before
  starting from scratch.
- **X12. SRTLA bonding** (Wi-Fi plus 5G at once) for IRL apps: an SRTLA
  receiver in front of the runner's SRT listener.

## When things break

| What breaks | What viewers see | What the host sees | Recovery |
| --- | --- | --- | --- |
| The computer crashes or loses power | The hold image within 2 s | On relaunch: the Resume banner | Resume, or the hold ends the show after its limit |
| The computer's internet drops | The hold image | "Reconnecting to Videorc Cloud" | The feed reconnects (RTMPS, later SRT) and the show resumes by itself |
| The app updates mid-stream | The hold image | The Resume banner | Resume |
| One platform drops (for example a YouTube EOF) | That platform's viewers see a short gap | That leg says Reconnecting | The runner reconnects that leg only |
| The runner crashes | Every platform drops for 10 to 15 s | "Videorc Cloud restarted your show" | The agent restarts it, the desktop re-sends destinations, the legs reconnect |
| A media node dies | Every show on it drops | "Cloud show lost, streaming directly from this computer" | The desktop falls back to direct legs (C2). Without a desktop, the show ends and the owner gets an alert |
| videorc.com is down mid-show | Nothing | Nothing | The runner keeps going, and usage reports retry |
| LiveKit is down | Talk show: guests vanish, so host away or hold. Solo: nothing | "Guest connection lost" | Reconnects when LiveKit is back |
| Hours run out mid-show | Nothing (D18) | "You're 12 min past this month's hours. The show keeps going." | The next show streams directly (Premium) |
| The cloud is full at Go Live | Nothing | One toast: streaming directly | The owner gets an alert and adds a node |

## Verification gates

Use `AGENTS.md` as the source of truth. Per phase:

- **Phase 0**: the spike notes; no product gates.
- **Phase 1**:
  - `videorc-cloud`: `cargo fmt --check`, `cargo clippy -- -D warnings`,
    runner and agent unit tests, and the runner continuity harness.
  - `videorcweb`: `pnpm typecheck && pnpm test && pnpm build`.
  - `videorc`: `cargo fmt --check --all`; `cargo clippy -p videorc-backend
    -- -D warnings`; targeted `cargo test` for the cloud and recording
    modules; `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm
    --filter @videorc/desktop test`.
  - Smokes: `pnpm smoke:recording-matrix` (FFmpeg changed), `pnpm
    smoke:multistream`, `pnpm smoke:multistream:vertical`, `pnpm
    smoke:stream-leg-eof`, `pnpm smoke:streaming-secrets`, `pnpm
    smoke:youtube-quota` (Go Live prepare and transition), `pnpm
    smoke:recording-studio`, and the new `pnpm smoke:cloud-solo`.
- **Phase 2**: all of the above, plus `pnpm smoke:cloud-talk-show`, `pnpm
  smoke:comment-highlight-stream` and `pnpm smoke:live-chat-fake-providers`.
- **Phase 3**: plus `pnpm smoke:cloud-phone`, `pnpm smoke:remote-control` and
  `pnpm smoke:remote-lan` (Phone remote on the LAN must be unchanged).
- **Every phase**: a security review of the new routes and sockets before
  the kill switch flips, and the owner's acceptance run.

## STOP conditions

Stop and ask the owner when:
- Phase 0 says neither runner path is stable (D7).
- S0e finds reused files the owner doesn't own (D14).
- The measured cost per hour breaks plan 185's margins.
- Anything would store stream keys or platform tokens at rest before X6 is
  decided.
- Anything would make a YouTube API call from a server, or cloud shows with
  YouTube would reach anyone but the owner before the compliance answer is
  updated (D13, D15).
- A change would add a control next to Record or Go Live.
- A platform's rules turn out to forbid relaying or long holds.

## Out of scope (for now)

- A browser-only Videorc studio without the desktop app.
- 24/7 streams, playlists or pre-recorded "live" streams.
- Sending the full Studio scene (masks, freeform) into talk shows.
- Facebook (plan 079) and LinkedIn as cloud destinations, beyond what the
  desktop already supports.

## Open questions for the owner

1. Hold limit default: 30 minutes? (D12)
2. Should the phone take over by itself when the computer drops, or only on a
   tap? (P2)
3. When Max opens to everyone: at Phase 2 acceptance (recommended, since
   guests are its core), or earlier with "guests coming soon"? (plan 185)
4. A private `videorc-cloud` repo, if S0e allows it? (D14)

## Handoff (cold start)

- **Goal**: Videorc Cloud as above, in Phase 0 to Phase 4 order.
- **Current state**: nothing built. The research for this plan lives in the
  facts sections above. The 09-15 Remote Guests plan in the Obsidian vault
  holds the earlier LiveKit research.
- **Route and lanes**: Status above.
- **Start with** Phase 0: S0a, S0b and S0c in parallel, then S0d and S0e.
- **Blockers**: a Hetzner account and API token, a LiveKit Cloud project,
  and the owner's go for spending. Ask the owner; never invent credentials.
