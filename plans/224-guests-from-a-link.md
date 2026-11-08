# Plan 224: guests from a link

> **Executor instructions**: read `AGENTS.md`, the `videorc-design` skill
> (`.claude/skills/videorc-design/SKILL.md`), plan 184 (`plans/184-videorc-cloud.md`,
> the cloud architecture), plan 222 (the cloud solo path and its rollout) and
> this whole plan first. Plan 185 (private, `docs/plans/185-videorc-max-tier.md`
> in `videorc-web`) holds the tiers and the money; read it before touching
> limits or metering.
> - This plan **supersedes plan 184's Phase 2 slice list (G1 to G18)**. Plan
>   184 stays the source for the overall cloud architecture, the Phase 1 wire
>   shape and the decisions D1 to D21. Where this plan and plan 184 Phase 2
>   differ, this plan wins.
> - Desktop work: your own worktree from `origin/main`, with the cloud branch
>   (`plan-184-videorc-cloud`, PR #727) rebased first (plan 222 owns that
>   rebase). Web work: a worktree of `videorc-web` from `plan-185-max-and-cloud`.
>   Runner and node agent: the private `videorc-cloud` repo, from
>   `phase-1-runner`.
> - Never merge PR #727, web #85 or `videorc-cloud` #1 (owner's standing
>   order). Open your own draft PRs on top of them.
> - Write and commit every slice of a phase first, then run the Rust compile
>   and tests and the smokes once at the end of the phase (owner rule, "Gates
>   at the end"). At most 2 or 3 Rust compiles at once on one Mac.
> - Check every UI in light AND dark.
> - Never go live on a real channel unless the owner asks in the session.
> - Nothing after Phase 0 starts until Phase 0's written results say go.
> - If anything under "STOP conditions" happens, stop and report.

**Drift check (run first)**:

```sh
git -C ~/projects/videorc fetch origin
git -C ~/projects/videorc diff --stat d00550ea1..origin/main -- \
  apps/desktop/src/renderer/src/components/tabs/studio-tab.tsx \
  apps/desktop/src/renderer/src/components/streaming \
  apps/desktop/src/renderer/src/components/workspace-nav.tsx \
  apps/desktop/src/renderer/src/lib/livestream-tabs.ts \
  apps/desktop/src/shared/backend-rpc-contract.ts \
  crates/videorc-backend/src/comment_highlight.rs \
  crates/videorc-backend/src/overlay_layout.rs \
  crates/videorc-backend/src/scene_geometry.rs
git -C ~/projects/videorc log --oneline 0e5bade39..origin/plan-184-videorc-cloud
git -C ~/projects/videorc-cloud log --oneline b0557c9..origin/phase-1-runner
```

If an anchor quoted below moved, re-find it by its symbol name. If a
behaviour changed (not a line number), that is a STOP condition.

## Status

- **Status**: PLANNED 2026-11-08. Nothing in this plan is built. Plan 184's
  Phase 1 (solo shows) is built in three draft PRs; Phase 2 was designed and
  never started.
- **Priority**: P1. One of the five features the owner picked on 2026-11-08
  to make Premium worth paying for (plan 221 is the umbrella).
- **Effort**: XXL. Four repos (desktop, web, runner, and LiveKit as a
  service), a new public web page, a new media input in the runner, a new
  Studio surface, and a new smoke with headless browsers. Phase 0 plus four
  phases, about 8 to 12 agent-weeks after plan 222 lands.
- **Risk**: HIGH.
  - Strangers join a live show from a public URL: abuse, consent and
    moderation are product problems, not only code.
  - Media from guests now flows through a vendor (LiveKit) and our runner.
    One outage ends every talk show at once.
  - The host's camera gets a second owner (the renderer) during a show.
  - A Rust SDK on a prebuilt libwebrtc decides what guests may send (D3).
- **Planned at**: desktop `origin/main` `d00550ea1` (fetched 2026-11-08);
  desktop cloud branch `origin/plan-184-videorc-cloud` `0e5bade39` (plus 7
  unpushed local commits, tag `backup/plan-184-local-2026-10-21`); web
  `plan-185-max-and-cloud` `5a75d03d`; runner `videorc-cloud`
  `phase-1-runner` `b0557c9`.
- **Route**: Orchestrator (fit 10, `fable-5.1`) owns the order and the
  cross-repo wire.
  - Phase 0 spikes (rooms, host in a room, codec): Implementation (fit 9) on
    `fable-5.1`; media, multi-system, already failed once (the lost branch).
  - Runner (room input, mix, layouts, recording): Implementation (fit 9) on
    `fable-5.1`.
  - Web routes, tokens, webhooks, metering: Implementation (fit 8) on
    `gpt-6.1-sol`, then a `fable-5.1` security pass on every route that
    mints a token, approves a join or takes a webhook.
  - The guest page, the Guests tab, the Show stage and the backstage strip:
    UI/Product Design (fit 9) on `opus-5.5`, with `videorc-design`.
  - Desktop backend (`cloud_show.rs` talk-show state, contract fields):
    Implementation (fit 8) on `gpt-6.1-sol`.
  - Smokes: Implementation (fit 8) on `gpt-6.1-sol`.
  - One Review pass (fit 9, `fable-5.1`) per phase before its kill switch
    flips.

## The owner's ask (2026-11-08)

> "plan out thoroughly first 5 things you recommended, it can go from our
> cloud branch that we already started"

Feature 4 of the five: **guests from a link**. From plan 184 (2026-10-16),
the owner's own words that shaped it:

> "We could have people join from a browser to join you on your live
> stream. … I think that the first user would be me and I would rather
> create talk shows with guests so we can start with that"

## What a streamer gets

The feature in one line: **send a link, and a guest is on your stream from
their browser, with nothing to install; the cloud builds the show, sends it
everywhere, records it, and keeps it on air if your Mac dies.**

1. **Before the show.** On Livestream → Guests you click "Open the room".
   The Studio's preview becomes the Show stage, with you alone on it. You
   copy the invite link and send it to two guests.
2. **A guest joins.** They open `videorc.com/guest/k7m2…` on a laptop or a
   phone. They type a name, see themselves, pick a camera and a mic, read
   one line: "This show goes out live on YouTube and Twitch and may be
   recorded. Your camera and voice are part of it." and click "Ask to
   join". Your Studio says "Ada wants to join" with Let in and Decline.
   You click Let in. Ada is backstage: she sees you and hears you, and
   viewers see nothing of her yet.
3. **On stage.** You click Bring on under Ada's tile. The layout becomes
   Side by side, with "Ada" under her tile. You pick "Screen + people" and
   share a window; the screen is large and the people sit in a column.
4. **Go Live.** The same Go Live… button. "Go live on 3 destinations" sends
   the show to YouTube, Twitch and Kick from the cloud. Record (the same
   button) records the program in the cloud. A click on a chat row puts
   that comment on stream, as today.
5. **Your Mac dies.** The guests keep talking. Your tile reads "Back in a
   moment" for the viewers; the show never stops. You relaunch, the Studio
   says "You're still live through Videorc Cloud." with Resume, and Resume
   puts you back on stage.
6. **A stranger has the link.** They can ask to join, and that is all. You
   see the name, click Decline, and click "New link". The old link is dead.
7. **After the show.** "Close the room" ends it. The recording appears on
   videorc.com/account under Cloud recordings, kept 30 days (Max), as one
   MP4 download.

## Words we use

New terms. Plan 184's table stands for the rest (Videorc Cloud, cloud show,
solo show, talk show, room, on stage, backstage, program, return, hold,
cloud hours, runner, media node, control plane).

| Word | Meaning |
| --- | --- |
| **Room** | The LiveKit room behind a talk show. UI copy: "Open the room", "Close the room", "Room open". |
| **Guest** | Someone who joined from an invite link. Never "participant" in copy. |
| **Invite link** | `videorc.com/guest/<slug>`. One per show; "New link" replaces it. |
| **Ask to join / Let in / Decline** | The guest's request and the host's two answers (D4). |
| **Backstage** | In the room, not on stream. The guest sees and hears the host. |
| **Bring on / Send backstage** | The host's two moves between backstage and the stage. |
| **Show stage** | The Studio's preview area during a talk show: the layout drawn from the room's tracks. |
| **Program monitor** | The small picture of the return, what the cloud really sends. |
| **Layout** (talk show) | Solo, Side by side, Screen + people, Spotlight. The same word as a scene's arrangement. |
| **Cloud recording** | The program recorded on our servers. Never "cloud VOD". |
| **Guest-hours** | Internal: guest-minutes summed, for the fair-use guard (plan 185 D4). Never in UI copy. |

## What exists (facts)

Every path is at the ref named in its line. `rec` means
`crates/videorc-backend/src/recording.rs`.

### Plan 184 Phase 1, built (desktop `origin/plan-184-videorc-cloud` `0e5bade39`)

- `crates/videorc-backend/src/cloud_show.rs` (5,300+ lines) holds the solo
  show: `CloudSettings`, `CloudPhase`, `CloudStatus` (secret-free), the web
  client (`CreateShowRequest`, `ShowIngest`, `ShowControl`), the control
  socket (`ControlFrameIn`, `WsTransport`, `RunnerState`, `RunnerLeg`), the
  hand-over (`HandoverDestination`, `SessionHandover`) and the state machine
  (`CloudShowContext`). Its module doc pins the rules: keys never reach the
  renderer; direct legs reopen only after the web confirms the show is gone;
  every YouTube API call stays on the computer; Resume never redoes platform
  setup (`cloud_show.rs:1-33`).
- The RPC surface: `cloud.status`, `cloud.settings.set`,
  `cloud.allowance.refresh`, `cloud.show.resume`, `cloud.show.end`,
  `cloud.selftest.run`, event `cloud.state`
  (`apps/desktop/src/shared/backend-rpc-contract.ts:395-403, 530-531`,
  schemas at `3912-4073`). Fallback reasons are a closed list:
  `cloud-disabled`, `cloud-full`, `cloud-hours-used-up`,
  `cloud-node-unreachable`, `cloud-show-limit` (`:3992-3996`).
- UI: the Livestream page's "Videorc Cloud" `PanelSection` with the switch
  "Stream through Videorc Cloud", the hold choices and the "Test Videorc
  Cloud" row (`components/streaming/cloud-section.tsx:72-112`); the Resume
  notice above Session (`components/studio/cloud-resume-notice.tsx`, a
  warning `Alert` with Resume and End livestream).
- `pnpm smoke:cloud-solo` (`scripts/smoke-cloud-solo-app.mjs`, `package.json:257`)
  runs the dev app against the runner and agent built from the sibling
  `videorc-cloud` checkout, with `scripts/lib/fake-cloud-web.mjs` standing in
  for the web.
- The branch is 485 commits behind `origin/main` (base 2026-10-16). Plan 222
  owns the rebase. This plan designs its UI against `origin/main`.

### Runner and node agent (`videorc-cloud` `phase-1-runner` `b0557c9`)

- A Rust workspace: `crates/protocol` (control frames, show token, node
  signatures), `crates/runner` (`feed.rs`, `switcher.rs`, `render.rs`,
  `encoder.rs`, `fanout.rs`, `control.rs`, `key_proxy.rs`, `usage.rs`,
  `state_file.rs`), `crates/node-agent`, `crates/devtool` (`Cargo.toml`).
  No LiveKit dependency anywhere (`grep livekit` over the tree: none).
- The intents are a closed Rust enum: `destinations.set`, `hold.image.set`,
  `hold.start`, `hold.stop`, `show.end`, `ingest.get`
  (`crates/protocol/src/control.rs:252-282`). `ShowState` has `phase`,
  `end_reason`, `hold`, `live_seconds`, `feeds`, `legs`,
  `desktop_connected`, `destinations_set`, `restarts`, `hold_image_set`
  (`control.rs:448-480`), every extra field `#[serde(default)]`.
- The renderer composes one picture: `Renderer::render(picture, feed)` with
  a hold frame per orientation (`crates/runner/src/render.rs:24-110`). The
  output group owns the clock (`engine.rs:44-82`, `ShowClock`).
- The show token's `role` must be `host`; the agent closes any other role
  with 4401 (`docs/wire-notes.md`, "The show token's `role` must be
  `host`"). The runner outlives its agent (`setsid`), logs to
  `runners/<showId>.log`, and a systemd unit needs `KillMode=process`
  (`docs/wire-notes.md`, "Signals and crashes").
- The spike note `docs/spike-runner-2026-10.md` covers the solo runner on the
  M4. It says the talk-show mix and LiveKit minutes are Phase 2 work
  (`:168, :182-183`).

### The S0a "rooms" spike (2026-10-18): results only, code LOST

The branch `spike/s0a-rooms` was never pushed. What survives:

- The LiveKit Rust SDK works for subscribing. It needed one fix: abort the
  track reader on `TrackUnsubscribed`, because the SDK reuses transceivers.
- A 4-person 1080p30 show cost 0.6 of an Apple M4 core with x264 and 0.2
  with hardware encoding.
- x264 `-tune zerolatency` cut the encoder's latency from 970 ms to 131 ms
  at no extra CPU.
- Open ⚑: plan 184 G2 says guests publish H.264, but the prebuilt libwebrtc
  cannot decode H.264 on a CPU-only Linux node. The spike recommended VP8,
  or a GPU node with NVDEC (D3).
- The 600 s churn run was invalid (the Mac slept). A re-run is owed (S0f).
- S0b (the host app in a room, and what the native preview shows) was not
  started.
- `livekit-server` 1.13.10 and `lk` 2.19.0 are installed on this Mac
  (`which livekit-server lk`, checked 2026-11-08).

### Web (`videorc-web` `plan-185-max-and-cloud` `5a75d03d`)

- `lib/cloud/`: `shows.ts` (`CloudShowKind = "solo" | "talk" | "test"`,
  `:128`), `shows-route.ts`, `show-token.ts` (`vcs1`, role `host` only,
  `:22-33`), `allowance.ts` (the `cloud` block with `talkShows`,
  `guestsOnStage`, `roomSize`, `recordingRetentionDays`, `:18-28`),
  `placement.ts`, `reaper.ts`, `meter.ts`, `cost-guardrails.ts`,
  `cost-inputs.ts`, `switches.ts`.
- A `kind: "talk"` create is refused today: 400 "Talk shows are not available
  yet." for a Max account, 403 `cloud-not-entitled` "Talk shows with guests
  come with Videorc Max." for anyone else (`shows-route.ts:161-172`).
- Plan allowances live in code: Premium `talkShows: false, guestsOnStage: 0,
  roomSize: 0`; Max `talkShows: true, guestsOnStage: 5, roomSize: 10,
  recordingRetentionDays: 30, producerSeats: 2`
  (`lib/entitlements/plans.ts:29-44`).
- Migrations end at `0027_add_cloud_node_heartbeat_signed_at.sql`
  (`db/migrations/`). Crons: `/api/cloud/reaper` every minute,
  `/api/cloud/reconcile` and `/api/cloud/cost-alerts` daily (`vercel.json`).
- Routes and who calls them: `docs/cloud.md:14-28`. Stored and never
  stored: `docs/cloud.md:362-375` (stream keys, ingest keys, passphrases
  and show tokens are never stored or logged).
- The Live page `app/live/page.tsx` (W6) shows the live show and End stream.
  There is no `app/guest/`, no LiveKit dependency, no WebSocket and no SSE
  (`package.json`: no `livekit`, no `playwright`). The Kick and X chat
  relays long-poll Neon.
- Tests are `node --test tests/*.test.ts` (`package.json:10`); the cloud
  tests are `tests/cloud-*.test.ts` (ten files).
- The cost guardrails page `/account/cloud-costs` has no LiveKit row and no
  LiveKit alert yet; both wait for talk shows (plan 185 T7).

### Desktop `origin/main` `d00550ea1` (the UI target)

- **Studio layout** (`components/tabs/studio-tab.tsx:180-300`): a
  `STUDIO_GRID` with the preview column (`StudioPreviewPanel`, then
  `StudioDashboardBottomRow` with the `ScenesGallery`), the transport row
  (Record and Go Live…), and the `<aside aria-label="Session inspector">`
  with `InspectorSession`, `StudioChatSection`, `AudioSection`,
  `QuickSettings` and `TakeoverSection`. `PreviewStage`
  (`components/preview-stage.tsx`, 688 lines) docks the native preview
  frame (`DockedPreviewFrame`, `useDockSlotReporter`) or shows the preview
  controls (Pop out, close).
- **Sidebar**: Studio ⌘1, Buddy ⌘9, then Setup: Sources ⌘2, Scene ⌘3,
  Assets ⌘4, Livestream ⌘5, Captions ⌘6, Output ⌘7; Library ⌘8; Settings
  ⌘,; Health has no row (`components/workspace-nav.tsx:55-100`). Every digit
  is taken.
- **Livestream page tabs**: `setup` ("Setup") and `upcoming` ("Upcoming")
  (`lib/livestream-tabs.ts:14-15`), through `PageTabs`. The Setup tab has
  the "Output quality" and "Ready to go live" sections
  (`components/streaming/go-live-panel.tsx:143, 285`).
- **Go Live phases**: `checking`, `preparing{platform}`, `starting`
  (`lib/go-live-dialog-view.ts:21-25`). Labels "Checking…", "Preparing
  YouTube…", "Starting…". Copy for the buttons lives in
  `lib/go-live-copy.ts` and `pnpm smoke:start-labels` pins it.
- **Comment cards**: the renderer renders the card to a PNG
  (`lib/caption-overlay.ts:513-524`) and the backend owns eligibility and
  the ten-second lifetime through `comments.highlight.set`,
  `comments.highlight.clear`, `comments.highlight.status`,
  `comments.highlight.canvases` (`crates/videorc-backend/src/main.rs:5608-5696`;
  `comment_highlight.rs:1-6`). Placement rects per orientation come from
  `overlay_layout.rs` (`overlays.layout.get/set`,
  `backend-rpc-contract.ts:510-512`). The layout is a normalized rect per
  orientation in canvas units (`overlay_layout.rs:1-9`).
- **Chat on stream** (plan 215 G): `chat.overlay.set/clear/canvases`
  (`backend-rpc-contract.ts:518-520`).
- **Camera**: the backend owns it (`camera_capture.rs`, 31 AVFoundation
  references; `preview_camera.rs`). The renderer touches media only for the
  mic meter (`hooks/studio-mic-meter.integration.test.ts` mocks
  `getUserMedia`). Electron main calls `desktopCapturer.getSources` once as
  a permission prime (`src/main/index.ts:11676-11710`). Nothing publishes
  WebRTC. A renderer `preview.camera.stop` while a recording needed the
  camera froze an ISO take ([[videorc-iso-take-camera-stop-freeze]]):
  camera ownership must be explicit (D6).
- **Scene sources** are `Screen`, `Window`, `Camera`, `TestPattern`
  (`protocol.rs:1005-1010`). No network source kind.
- **Aux leg**: on macOS, record+stream renders the stream from an auxiliary
  compositor output (`rec:5259-5312`, `CompositorAuxiliaryOutput`,
  `OverlayAuxLeg::Stream`). In a talk show the desktop draws nothing on the
  stream (the runner does), so no aux wiring is needed (D9).
- **Smokes that exist** (`package.json`): `smoke:multistream` (`:286`),
  `smoke:multistream:vertical` (`:287`), `smoke:stream-leg-eof` (`:290`),
  `smoke:streaming-secrets` (`:266`), `smoke:comment-highlight-stream`
  (`:274`), `smoke:live-chat-fake-providers` (`:273`),
  `smoke:remote-control` (`:167`), `smoke:recording-studio` (`:245`),
  `probe:preview-lifecycle` (`:228`), `probe:ui-glass` (`:227`). There is no
  headless browser dependency (no `playwright`, no `puppeteer`).
- **Design rules that bind this plan**: toolbar = page title only; Record
  and Go Live… atop the inspector; one home per control; Buddy stays second;
  a click on a chat row puts the comment on stream; locked means disabled
  with one `LockAlert` reason; `SegmentedControl` for 2 to 4 exclusive
  values; `GroupedList` of `ListRow`s for sets of like things; no text under
  11 px; toasts never tinted; colour is information (`SKILL.md`, "Hard
  rules", "Owner calls", "Desktop scale").

## Outside facts (checked 2026-11-08)

### LiveKit

- **Cloud plans.** Build, Ship, Scale, Enterprise. Each has included
  participant minutes, included downstream GB, concurrent connections
  (Build 100, Ship 1,000, Scale 5,000) and included transcode minutes for
  Egress. The numbers belong in plan 185, not here
  ([pricing](https://livekit.com/pricing)).
- **Egress** composes in a headless Chrome and bills transcode minutes per
  room composite. Plan 184 D7 rejected it as our compositor; nothing seen
  today changes that. We may still use **Track egress** later for per-person
  files (plan 184 X1) ([pricing](https://livekit.com/pricing)).
- **Rust SDK**: crate `livekit` 0.10.1, released 2026-11-04 (0.10.0 on
  2026-10-28, 0.9.7 on 2026-10-23)
  ([crates.io](https://crates.io/crates/livekit)). The repo tags crates as
  `livekit/v0.10.1`, `webrtc-sys/v0.3.53`, `libwebrtc/v0.4.0` (breaking:
  `OfferOptions::offer_to_receive_*` are `Option<bool>`). The 11-04 release
  falls back to VP8 when a track asks for a codec the host can't encode
  ([releases](https://github.com/livekit/rust-sdks/releases)).
- **H.264 decode on Linux.** The prebuilt libwebrtc's H.264 decoder needs an
  FFmpeg it does not ship with on Linux ("FFmpeg H.264 decoder not found",
  [#169](https://github.com/livekit/rust-sdks/issues/169)). A **pass-through
  video decoder** that hands encoded access units (H.264, H.265, VP8, VP9,
  AV1) to the application is **PR #1515, OPEN** (opened 2026-10-11, rebased
  2026-10-13, awaiting review)
  ([#1515](https://github.com/livekit/rust-sdks/pull/1515)). When it merges,
  our runner could decode H.264 with its own FFmpeg. Until then, D3.
- **Server**: `livekit-server` v1.13.11, 2026-10-25
  ([releases](https://api.github.com/repos/livekit/livekit/releases/latest)).
  This Mac has 1.13.10 and `lk` 2.19.0.
- **Codecs**: H.264, VP8, VP9 (SVC) and AV1 (SVC). Simulcast is on by
  default in every SDK; dynacast pauses layers nobody subscribes to
  ([tracks](https://docs.livekit.io/home/client/tracks/advanced/)).
- **Tokens and grants**: `roomJoin`, `room`, `roomAdmin`, `canPublish`,
  `canSubscribe`, `canPublishData`, `canPublishSources` (camera,
  microphone, screen_share, screen_share_audio), `canUpdateOwnMetadata`,
  `hidden`, `kind`. Default TTL 6 h. On LiveKit Cloud a revocation lasts 10
  minutes, so tokens for people you may remove should have a TTL of 10
  minutes or less. The identity (`sub`) appears in logs and is not redacted:
  use an opaque id, never a name
  ([grants](https://docs.livekit.io/frontends/reference/tokens-grants.md)).
- **Server API**: `RemoveParticipant` (needs `roomAdmin`; on Cloud revokes
  the token, `revoke_token_ts` closes the one-minute refresh gap),
  `MutePublishedTrack` (remote unmute is off by default),
  `UpdateParticipant` (revoking `canPublish` unpublishes at once),
  `DeleteRoom` disconnects everyone
  ([participants](https://docs.livekit.io/home/server/managing-participants/),
  [rooms](https://docs.livekit.io/home/server/managing-rooms/)).
- **Webhooks**: `room_started`, `room_finished`, `participant_joined`,
  `participant_left`, `participant_connection_aborted`, `track_published`,
  `track_unpublished`, egress and ingress events. JWT in `Authorization`
  with a SHA-256 of the body, signed by an API key you choose. Each event
  has a UUID `id` and `createdAt`. No delivery guarantee; retries, in order
  ([webhooks](https://docs.livekit.io/home/server/webhooks/)).
- **Reconnects**: a resume (ICE restart) first, a full reconnect second
  (`Reconnecting`, then `Reconnected`). A participant who vanishes without
  `disconnect()` is gone after 15 s. `Disconnected` reasons include
  `DUPLICATE_IDENTITY`, `ROOM_DELETED`, `PARTICIPANT_REMOVED`,
  `JOIN_FAILURE`, `ROOM_CLOSED`. Connection quality `Lost` fires before
  `Reconnecting` ([connect](https://docs.livekit.io/home/client/connect/)).

### Browsers

- **Screen share on phones**: `getDisplayMedia` is **not** available in
  Safari on iOS before 27.0, and not in Chrome for Android 157
  ([caniuse](https://caniuse.com/mdn-api_mediadevices_getdisplaymedia)). A
  phone guest cannot share a screen; the page never offers it there.
- **Wake Lock**: Safari on iOS 16.4+ and Chrome for Android support the
  Screen Wake Lock API ([caniuse](https://caniuse.com/wake-lock)). The guest
  page holds one while publishing.
- **Codecs in Safari**: H.264 is the codec every source agrees on. VP8 is
  supported in current Safari (vendor guides; UNVERIFIED against a WebKit
  source). VP9 and AV1 support is inconsistent across sources (one says VP9
  decode only, one says Safari 17+, one says no AV1 in WebRTC). So the
  guest page offers **VP8 or H.264 only** (D3)
  ([webrtc.ventures 2026-04](https://webrtc.ventures/2026/04/should-you-still-consider-av1-codec-in-your-webrtc-architecture/),
  [antmedia](https://antmedia.io/webrtc-browser-support/),
  [videosdk](https://www.videosdk.live/developer-hub/webrtc/webrtc-safari)).
- Phone browsers pause the camera and mic while the page is hidden (plan
  184, Outside facts). The guest page says so once, before publishing.

### Platforms

Plan 184's platform facts stand: YouTube, Twitch, Kick and X allow relays;
Twitch forbids merging other platforms' chat onto its stream; a guest's name
on screen is ours to draw. Nothing new found for guests. A recording of a
guest is personal data in the EU; the consent line (D13) and the privacy
page carry it.

## Decisions (⚑ = owner may override)

### D1. This plan replaces plan 184 Phase 2

Plan 184 G1 to G18 become the slices below (W-G, R-G, C-G, S-G). Plan 184's
architecture, Phase 1 wire shape and decisions D1 to D21 stand. Plan 184
D16 (the Show stage plus a Program monitor) and D21 (the talk-show feature
table) are refined in D7 and D8 here.

### D2. Phase 0 is redone and pushed

The S0a rooms code is gone. Redo it in the private `videorc-cloud` repo on a
pushed branch `spike/s0a-rooms`, and keep the harness as an ignored test,
like `hold_continuity`. Add S0b (never started) and S0f (the churn re-run).
Nothing in Phases 1 to 4 starts before the three notes say go.

### D3. Guests publish VP8 with simulcast; H.264 is a later upgrade ⚑

- The runner decodes room tracks on a CPU-only Linux node. The prebuilt
  libwebrtc decodes VP8 there and not H.264 (Outside facts). VP8 is decoded
  by every browser we support, Safari on iOS included.
- The guest page publishes VP8 at 720p with simulcast (three layers), and
  the host app does the same. The runner subscribes to the high layer of
  the people on stage and nothing else (dynacast pauses the rest).
- The cost: VP8 at 720p needs about 1.5 to 2 Mbps for the same look H.264
  gets at 1.2 Mbps (UNVERIFIED on our content; S0a measures it).
- Upgrade paths, in order of preference: (1) PR #1515 merges, the runner
  takes encoded H.264 and decodes it with its own FFmpeg (one dependency
  bump, no node change); (2) a GPU node with NVDEC; (3) a custom libwebrtc
  build. Re-check (1) at every Phase gate.
- Rejected: VP9 or AV1 for guests. Safari support is inconsistent and the
  CPU decode cost on the node is higher.

### D4. The host lets every guest in ⚑

- A guest who opens the link lands on "Ask to join". The host sees "Ada
  wants to join" in the Studio with Let in and Decline. Nobody enters the
  room without Let in. A declined guest reads "The host didn't let you in."
- Why: the link will leak (a guest forwards it, a chat screenshot). With
  approval, a leak costs the host one click. Without it, a stranger is
  backstage hearing the host and taking a room slot.
- A per-show switch, "Let anyone with the link in backstage", off by
  default, skips the question for a show with trusted guests ⚑. Even then
  nobody reaches the stage without Bring on.
- The invite link is **reusable** for the show and dies when the room
  closes. "New link" rotates it (D5). Rejected: one-time links, because a
  guest who reloads the page or whose phone browser reloads it would be
  locked out mid-show.

### D5. Invite links: shape, life and abuse

- `https://videorc.com/guest/<slug>`, slug 16 base62 characters (95 bits).
  One per show. Rotating makes a new slug; the old one answers "This link
  isn't valid anymore." within 1 s (the web checks the slug on every
  request, nothing is cached).
- A link made before the room opens is good for 7 days; the room opening
  binds it to the show; closing the room kills it.
- The public guest routes are rate-limited per IP and per slug (30 requests
  a minute; a join request at most 6 a minute per slug). A declined request
  from the same browser (a cookie) is not shown to the host again for 10
  minutes; the count of declined requests shows as "3 more asked".
- Room capacity: the 11th person (Max) or the 3rd (Premium, D15) reads
  "This show is full."
- The guest's **name** is typed on the page, 1 to 32 characters, trimmed,
  shown on stream as typed. The host can edit it from the strip (⋯ → Rename)
  before or after Bring on. Nothing blocks words: the host saw the name at
  Let in and sees it on the stage before Bring on.

### D6. The host joins from the renderer with LiveKit JS; the backend lends the camera

- The renderer joins the room with `livekit-client`: camera, mic, and screen
  share through Electron's `desktopCapturer` (a `chromeMediaSourceId`
  constraint on `getUserMedia`). S0b checks the look of shared text at 720p
  and 1080p, VP8 and H.264, and CPU.
- The camera has one owner at a time. When the room opens, the backend
  releases its camera (`preview_camera` stops, with a new reason
  `talk-show`, so the Preview copy says why) and the renderer opens it. When
  the room closes, the order reverses. The backend must refuse `preview
  .camera.stop` while a recording or a Clips buffer needs the camera
  ([[videorc-iso-take-camera-stop-freeze]]); in a talk show the local
  recording is off (D10), so the hand-over is safe, and a unit test proves
  the refusal paths.
- The microphone: the renderer's mic track uses the Sources page's mic. The
  backend's mic stays open for the level meter only (no mix, nothing
  recorded locally), the mute shortcut mutes both.
- Rejected for v1: native publishing from the backend (plan 184 X10). It
  needs libwebrtc in the desktop (the 264 MB build risk plan 184 D6 named)
  and a new capture path. It stays the fallback if S0b finds renderer screen
  share too soft.
- Windows: renderer WebRTC works there too, but Media Foundation's camera
  can't be shared the same way (plan 184 D19). Talk shows are macOS-first
  for the host.

### D7. What the host sees: the Show stage, a Program monitor, and the Preview hides ⚑

- **Show stage**: the Studio's preview column during a talk show. The
  renderer draws the layout from the room's tracks (`<video>` elements
  positioned by the shared geometry, D8), instant. It is the picture the
  host acts on.
- **Program monitor**: a small picture (a quarter of the stage's width,
  bottom-right of the stage) of the return (R-G5), what the cloud sends,
  about half a second behind. Muted by default; its speaker toggle plays
  the return so the host can check the mix (with their own voice delayed,
  so it is a check, not the monitor).
- **The native Preview**: the CAMetalLayer preview shows the backend
  compositor's program, which is not the show. While the room is open the
  docked preview slot and the detached Preview window **hide**, and
  `PreviewStage` shows one line: "The Show stage replaces the Preview while
  the room is open." with "Close the room". Status copy names the reason
  (`AGENTS.md`, never a silent downgrade). S0b confirms this is simpler and
  smooth; the alternative (the Preview window shows the return) costs a
  second room subscription and a second decode.
- **Audio the host hears**: the room (guests' voices) through the renderer,
  with no return, so there is no half-second echo of the host's own voice.

### D8. One geometry for the stage and the runner

- Layouts: **Solo** (one person full frame), **Side by side** (2 to 6 in a
  grid), **Screen + people** (the shared screen large, people in a column on
  the right), **Spotlight** (one person large, the rest small along the
  bottom). Tiles are 16:9, rounded (`rounded-row`'s ratio scaled to the
  canvas), with the name under each tile in a plate, and the host's camera
  shape from Sources (circle or rounded) applied to the host's tile only.
- The geometry is one pure module, `talk_show_layout.rs`, next to
  `scene_geometry.rs` in the desktop repo (owner-authored, S0e), consumed by
  the runner as a path dependency on a pinned commit and mirrored in
  TypeScript (`lib/talk-show-layout.ts`) with a shared JSON fixture that
  both test against: 1 to 6 people, each layout, horizontal and vertical,
  even pixel sizes, no overlap, inside the canvas.
- Vertical (R-G9): people stacked, the screen on top, names under tiles;
  the last slice.

### D9. Overlays travel as PNGs; nothing is drawn on the desktop

- A comment card: the renderer renders the PNG as today, the backend's
  `comments.highlight.set` keeps its eligibility and ten-second lifetime,
  and in a talk show the backend forwards the PNG and its rect to the runner
  (`overlay.set`, Wire shape) instead of the compositor. Takeovers and Be
  right back go the same way. The runner blits inside the rect per
  orientation, the same rule as `overlay_blit_layout`.
- No aux-leg wiring: the desktop composes no stream in a talk show, so the
  record+stream aux rule (What exists) does not apply. The smoke proves the
  card on the runner's output instead (S-G1).
- Buddy on stream and captions stay out of talk shows at launch (plan 184
  D21 and X3, X4).

### D10. Record in a talk show records in the cloud

- The Record button starts a cloud recording of the program (R-G6): one
  segmented MP4 per orientation in object storage, finalized at show end,
  shown on videorc.com/account under "Cloud recordings" with a download, and
  kept `recordingRetentionDays` (Max 30; Premium per D15).
- Recording works without going live, and going live without recording
  works.
- The local recording is off during a talk show: it would contain the host's
  camera only, and the camera belongs to the renderer (D6). The Output
  page's recording rows say "Recording goes to Videorc Cloud while the room
  is open." Separate-source files of the host's own camera and screen are
  later (plan 184 X1).
- The object store is the owner's choice (OQ7). The web signs a short-lived
  download URL; the runner writes with a node-scoped key.
- 2026-11-08: Neon became the whole backend (plan 184 D9), and **the
  recordings stay on R2 ⚑**.
  - Neon Object Storage keys are scoped to a whole branch. They can't be
    limited to `talk/<user>/<show>/`, and their `expires_at` isn't
    enforced.
  - Neon's presigned URLs are single PUTs, so every multipart part would
    need the web mid-show.
  - Objects stop at 10 GiB, less than a 12-hour show.
  - R2's temporary credentials do all of this, and R2 downloads are free
    (plan 184 Outside facts).
  - Revisit when Neon offers prefix-scoped, expiring credentials.

### D11. Audio mix without echo

- The runner mixes everyone on stage plus screen-share audio, with gain and
  mute per person, on its own clock; a late source gets silence and a
  counted underrun (plan 184 G7).
- Guests hear each other through the room, never the program, so there is
  no echo. The return (R-G5) is for the Program monitor, the phone (plan 184
  Phase 3) and producers; the guest page never subscribes to it.
- Backstage guests hear the stage and the host, and are heard by the host
  only (the runner does not subscribe to them). The Show stage shows their
  mic level so the host knows they work.

### D12. The host is away

- If the host's tracks are gone for 5 s, the host's tile reads "Back in a
  moment" (a plate over the frozen last frame) and the show goes on. The
  layout keeps its slot for the host for 60 s, then re-flows without them.
- With nobody on stage, the hold image shows and the hold clock runs (plan
  184 D12: 30 minutes, then the show ends).
- Guests see nothing change on their page except the host's tile.
- The runner keeps composing from the room whether or not a desktop is on
  the control socket. Who can end the show without the host: nobody in v1
  (producers are plan 184 X2); the web's reaper and the hold limit end it.

### D13. Consent and privacy

- Before "Ask to join", one line: "This show goes out live on {platforms}
  and may be recorded. Your camera and voice are part of it." The platforms
  come from the show's saved destinations at that moment; before any is
  known, "This show goes out live and may be recorded."
- No tracking on the guest page: no analytics, `noindex`, no site chrome.
- A guest's name and opaque identity live in the room while it is open and
  in the webhook rows (`cloud_room_minutes`, identity only, no name) for
  metering. The recording holds their picture and voice; the privacy page
  says so (W-G6).
- A guest can leave at any time; Leave stops their tracks before it
  disconnects.

### D14. Moderation: remove, ban, mute, and screen share ⚑

- **Mute** (host → web → `MutePublishedTrack`): the guest's mic is muted
  at the server; their page says "The host muted you." and their unmute is
  disabled while it holds. Remote unmute stays off (the default).
- **Remove**: `RemoveParticipant` with `revoke_token_ts`; their page reads
  "The host removed you from the show." The link stays valid for everyone
  else.
- **Ban**: Remove plus their request id and browser cookie blocked for the
  show, and the invite link rotates automatically, with a toast "New link.
  Share it again with your guests." (icon tinted only).
- **Screen share** ⚑: off by default per guest. The host allows it from the
  strip's ⋯ menu, "Allow screen share"; the web updates the guest's
  `canPublishSources`. Phones never see the control (Outside facts). A
  guest's screen can carry anything; the host decides per person.
- **Names**: the host can rename from the strip; a renamed guest's page
  shows the new name.

### D15. Packaging ⚑: Premium gets one guest, Max gets the full room

The orchestrator's top-5 list sells guests as a Premium headline; plan 185
makes guests Max-only. Options for the owner:

| Option | Premium | Max | What it means |
| --- | --- | --- | --- |
| A. Max-only (plan 185 as is) | no guests | 5 on stage, 10 in the room, recording 30 days | The Premium headline is "the stream never drops" only. Cheapest. |
| B. **One guest on Premium** (recommended) | 1 guest on stage, 2 in the room, inside the 10 cloud hours; cloud recording kept 7 days | 5 on stage, 10 in the room, recording 30 days | Premium can run a two-person talk; Max is the show with a panel. |
| C. A few talk shows a month on Premium | 3 talk shows a month, up to 2 guests each, inside the 10 hours | the same as A | Hard to explain and to meter; a fourth show mid-month is a refusal at Go Live. |

Recommendation: **B**. One guest is what most streamers ask for (a
co-host), it is bounded by the hours Premium already has, and it keeps a
clear step to Max (a panel, 30-day recordings). The numbers live in
`PLAN_ALLOWANCES` (`lib/entitlements/plans.ts`) and the `cloud` block the
desktop already parses (`talkShows`, `guestsOnStage`, `roomSize`,
`recordingRetentionDays`), so the choice is a constant change, not a wire
change. Cost reasoning is in the private notes to plan 185.

Whatever the owner picks, the lock copy stays plan 185 D11's: "Talk shows
with guests come with Videorc Max." for A; for B, Premium's extra lock is
"Up to 1 guest on stage with Premium. Videorc Max seats 5."

### D16. Where invites live: Livestream → Guests (a tab), not a new page ⚑

- Plan 184 G13 wanted a Guests page in Setup. Main's sidebar has every digit
  taken (⌘1 to ⌘9 and ⌘,), so a seventh Setup page would be the only page
  without a key, or would move Library's.
- The Livestream page already has tabs (Setup, Upcoming). Guests is its
  third tab: invites, the room, the limits, who joined. ⌘K lists it ("Open
  Livestream → Guests"), deep links open it (`openWorkspaceTab('live',
  'guests')`).
- One home per control: the invite link, "Open the room", "Close the room"
  and "Let anyone with the link in backstage" live here. Bring on, Send
  backstage, Mute and Remove live on the Show stage's backstage strip (C-G3).
  The Studio inspector gets one `NavigableRow`, "Guests · Room open · 2
  backstage", that opens the tab.
- Rejected: a Guests section inside Livestream → Setup. The Setup tab is
  already the longest page; a room with a live list of people is its own
  question, so its own tab.

### D17. How a talk show starts and ends

- "Open the room" on Livestream → Guests creates the show (`kind: "talk"`,
  status `ready`), creates the LiveKit room, mints the host's token and joins
  the renderer. The Studio switches to the Show stage. The status bar reads
  "Room open" with the clock from the first Go Live or Record, not before.
- Go Live… and Record are the same buttons. They talk to the runner (C-G6).
  "End livestream" ends the stream and keeps the room open; "Close the
  room" ends everything, after "Your guests leave and the recording
  finalizes." in a `ConfirmDialog` while anyone is in the room.
- A room open with nothing live or recording counts no cloud hours for its
  first 30 minutes, then counts (plan 185 D4). The Guests tab shows
  "Backstage time counts after 30 min" under the room row.
- A desktop relaunch finds the room through `GET /api/cloud/shows/current`
  and the Resume notice (plan 184 C5), and Resume rejoins the room with a
  fresh host token (C-G8).

### D18. "Invite a guest while live" (plan 184 X9): half in

- **In**: inviting a guest while a **talk show** is live works from day one.
  The room exists; a new guest asks to join, is let in, and is brought on.
  Nothing special is built.
- **Out for v1**: turning a **solo show** into a talk show mid-stream. The
  solo runner reads one feed; the talk runner reads a room; the host's
  camera would change owner mid-stream (D6) and the Studio's program would
  stop being the source. Doing it well means the solo feed itself becomes a
  room participant (the Studio program as one tile), which is a later plan.
- What the host does instead: a host who may want a guest opens the room
  before going live. Solo in the room (the host alone, Solo layout) is a
  valid talk show and costs one LiveKit participant.

### D19. The latency budget, end to end

| Hop | Budget | How we hold it |
| --- | --- | --- |
| Guest camera → LiveKit → runner | 150 to 300 ms | WebRTC; the runner's jitter buffer is LiveKit's default; simulcast keeps the high layer flowing |
| Runner compose + encode | ≤ 150 ms | latest-wins frame store per track; x264 `-tune zerolatency` (131 ms measured, S0a) or NVENC |
| Runner → platform ingest | 100 to 500 ms | RTMPS legs as in Phase 1 |
| Platform → viewers | 2 to 10 s | not ours; YouTube low latency and Twitch low latency modes |
| Return to the host (Program monitor) | 400 to 700 ms | the runner publishes the program back into the room at 720p |
| Guest ↔ guest conversation | 150 to 300 ms | through the room, not the program |
| Host sees a guest on the Show stage | 150 to 300 ms | the renderer subscribes directly |

Target: a viewer sees a guest's word within the platform's own delay plus
0.6 s. S0a measures glass-to-glass from a guest's tone to the receiver and
writes it down.

### D20. LiveKit Cloud first (plan 184 D8 stands)

One LiveKit Cloud project, two API keys (one for tokens and the server API,
one as the webhook signing key). The self-host move is plan 184 X8. The
runner's hidden participant is billed like anyone else; the metering counts
it (W-G4).

## Wire shape (additive)

Plan 184's Phase 1 shape stands. Change this section first, then all three
repos.

### Ids and tokens

- `inviteSlug`: 16 base62 characters. `guestId`: `g_` plus 22 base62.
  Identities in LiveKit are `guestId`, `host:<showId>` and
  `runner:<showId>`. Never a name.
- Show token `role`: `host` (Phase 1), `runner` (new, minted by the web for
  the node's create). The agent accepts `runner` on `/agent` only. Guests
  never see a show token.
- LiveKit tokens, minted by the web with `livekit-server-sdk`:
  - host: `roomJoin`, `room: <showId>`, `canPublish`, `canSubscribe`,
    `canPublishSources: [camera, microphone, screen_share,
    screen_share_audio]`, `roomAdmin: false` (moderation goes through the
    web), name = the account's display name, TTL 10 min;
  - guest: `roomJoin`, `canPublish`, `canSubscribe`, `canPublishSources:
    [camera, microphone]` (plus `screen_share`, `screen_share_audio` after
    "Allow screen share"), `canPublishData: false`, name = the typed name,
    TTL 10 min;
  - runner: `roomJoin`, `hidden: true`, `canSubscribe`, `canPublish`
    (the return), `canPublishSources: [camera, microphone]`, TTL the show's
    limit (12.5 h).

### Desktop → web

- `POST /api/cloud/shows` with `kind: "talk"` adds
  `"room": { "returnWidth": 1280, "returnHeight": 720 }`. The 201 answer adds:

  ```json
  { "room": { "url": "wss://<project>.livekit.cloud", "hostToken": "<jwt>", "name": "sh_…" },
    "invite": { "slug": "k7m2…", "url": "https://videorc.com/guest/k7m2…", "expiresAt": "…" },
    "limits": { "guestsOnStage": 5, "roomSize": 10, "recordingRetentionDays": 30 } }
  ```

  Errors: Phase 1's, plus 403 `cloud-not-entitled` with plan 185 D11's
  sentence, 429 `cloud-guest-hours-used-up` (the fair-use guard), 503
  `cloud-rooms-unavailable` (LiveKit unreachable).
- `POST /api/cloud/shows/:id/room/token` → `{ "hostToken" }`, a fresh
  10-minute host token (reconnects, resume).
- `POST /api/cloud/shows/:id/invite/rotate` → `{ "invite" }`.
- `PATCH /api/cloud/shows/:id/room` with `{ "openDoor": true|false }` (D4's
  switch).
- `GET /api/cloud/shows/:id/guests` → `{ "requests": [{ "requestId",
  "name", "askedAt", "device": "phone|computer" }], "guests": [{ "guestId",
  "name", "joinedAt", "muted", "screenShareAllowed" }], "declinedCount" }`.
  The desktop long-polls it (`?since=`) the way the Kick and X relays are
  polled; no WebSocket on Vercel.
- `POST /api/cloud/shows/:id/guests/requests/:requestId` with `{ "decision":
  "let-in" | "decline" }`.
- `POST /api/cloud/shows/:id/guests/:guestId` with `{ "action": "mute" |
  "unmute" | "remove" | "ban" | "rename" | "allow-screen-share" |
  "disallow-screen-share", "name"? }`. The web calls LiveKit's server API
  and answers `{ "ok": true }`.
- `GET /api/cloud/recordings` → `{ "recordings": [{ "id", "showId",
  "startedAt", "seconds", "bytes", "orientation", "expiresAt",
  "downloadUrl" }] }`, `downloadUrl` signed for 10 minutes.

### Guest page → web (public, rate-limited, no account)

- `GET /api/guest/:slug` → `{ "show": { "title", "platforms": ["youtube",
  "twitch"], "recording": true }, "state": "waiting-for-host" | "open" |
  "full" | "ended" | "invalid", "roomSize" }`.
- `POST /api/guest/:slug/join` with `{ "name", "device": "phone|computer" }`
  → `{ "requestId" }`, and sets a `vrc_guest` cookie (the request id, 24 h).
- `GET /api/guest/:slug/join/:requestId` (long-poll, 25 s) → `{ "state":
  "waiting" | "let-in" | "declined" | "expired", "room"?: { "url", "token" },
  "guestId"? }`. `let-in` carries the token once; a reload asks again and
  gets a fresh token while the guest is still allowed.
- `POST /api/guest/:slug/leave` with `{ "guestId" }`.

### LiveKit → web

- `POST /api/cloud/livekit/webhook`: `WebhookReceiver` verifies the JWT
  against the signing key; the handler is idempotent on the event `id`
  (table `cloud_livekit_events`, 48 h); `participant_joined` and
  `participant_left` write `cloud_room_minutes` rows (show, identity, role,
  joined, left); `room_finished` closes a show whose runner is gone.

### Web → node agent (node-signed)

`POST {agentUrl}/v1/shows` for `kind: "talk"` adds `"room": { "url",
"runnerToken", "name", "returnWidth", "returnHeight" }` and `"recording":
{ "bucket", "prefix", "credentials": { … } }` (memory only on the node,
like the ingest key). The agent writes them to the runner's config (0600).

### Control socket (desktop ↔ runner), new intents and state

Intents (the `IntentKind` enum grows; every new variant has `#[serde(rename)]`):

- `stage.set`: `{ "layout": "solo|side-by-side|screen-people|spotlight",
  "onStage": ["<identity>", …], "spotlight": "<identity>"?, "screen":
  "<identity>"? }`. The whole stage in one frame; the runner diffs.
- `overlay.set`: `{ "slot": "card|takeover|hold", "orientation": "h|v",
  "pngBase64", "rect": { "x", "y", "w", "h" }, "ttlSeconds"? }` and
  `overlay.clear` with `{ "slot", "orientation" }`. `hold.image.set` stays
  as the Phase 1 alias of `overlay.set` slot `hold`.
- `recording.start`, `recording.stop`.
- `return.set`: `{ "enabled": true|false }` (the host turns the return off
  when nothing needs it, to save room bandwidth).

State (`ShowState` grows; every field `#[serde(default)]`, every `Option`
with `skip_serializing_if`):

```json
"room": { "connected": true, "participants": [{ "identity", "name", "role": "host|guest",
            "onStage": true, "video": true, "audio": true, "muted": false, "screen": false,
            "quality": "excellent|good|poor|lost", "sinceMs": 1234 }],
          "layout": "side-by-side", "hostAway": false },
"recording": { "active": true, "since": "…", "seconds": 1200, "bytes": 123456789, "orientations": ["h"] }
```

### Desktop RPCs and events (`apps/desktop/src/shared/backend-rpc-contract.ts`)

- `cloud.room.open` (`{ title? }` → `CloudStatus`), `cloud.room.close`,
  `cloud.room.invite.rotate`, `cloud.room.door.set` (`{ open: boolean }`),
  `cloud.room.token.refresh` → `{ hostToken, url }` (the one RPC that carries
  a token; renderer role only, never a remote role, never logged).
- `cloud.guest.decide` (`{ requestId, decision }`), `cloud.guest.act`
  (`{ guestId, action, name? }`).
- `cloud.stage.set` (the `stage.set` body), `cloud.recording.start`,
  `cloud.recording.stop`.
- `CloudStatus` gains `room?: { phase: 'closed'|'opening'|'open'|'closing',
  inviteUrl, doorOpen, requests[], participants[], layout, hostAway,
  limits }` and `recording?`. New phases stay inside the existing
  `CloudPhase` where they fit (`live`, `hold`) and add none to the closed
  fallback-reason list; `cloud-guest-hours-used-up` and
  `cloud-rooms-unavailable` are new fallback reasons added to the schema's
  list **and** to `cloud_show.rs` in one PR with a shared fixture.
- Event `cloud.room.requests` (one per new request, for the Studio's "Ada
  wants to join" alert) in addition to `cloud.state`.
- Rust: every `Option` on the wire has `skip_serializing_if`
  ([[videorc-serde-null-contract-trap]]). Nothing is added to
  `captions.reasonCode` or `preferredTransport`.

### Database (web, next free migration numbers from `0028`)

```sql
CREATE TABLE IF NOT EXISTS cloud_invites (
  slug text PRIMARY KEY, show_id text NOT NULL REFERENCES cloud_shows(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS cloud_guest_requests (
  id text PRIMARY KEY, show_id text NOT NULL, slug text NOT NULL, name text NOT NULL,
  device text NOT NULL, state text NOT NULL, guest_id text, cookie_hash text,
  asked_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, banned boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS cloud_room_minutes (
  show_id text NOT NULL, identity text NOT NULL, role text NOT NULL,
  joined_at timestamptz NOT NULL, left_at timestamptz, PRIMARY KEY (show_id, identity, joined_at)
);
CREATE TABLE IF NOT EXISTS cloud_livekit_events (id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS cloud_recordings (
  id text PRIMARY KEY, show_id text NOT NULL, user_id text NOT NULL, orientation text NOT NULL,
  object_key text NOT NULL, started_at timestamptz NOT NULL, seconds integer NOT NULL DEFAULT 0,
  bytes bigint NOT NULL DEFAULT 0, state text NOT NULL, expires_at timestamptz NOT NULL
);
```

Names are never stored past the show: a daily cron blanks
`cloud_guest_requests.name` for ended shows.

## Phases and slices

Each slice names its repo and ends with a **Done when** check an agent can
run cold. Gates run once at the end of each phase.

### Phase 0: prove the hard parts again (about 1 week, `videorc-cloud` unless named)

- **S0a-r. Rooms, pushed.** Branch `spike/s0a-rooms`. A local
  `livekit-server --dev`, four browser tabs (Chrome with
  `--use-fake-device-for-media-stream` and a distinct y4m colour and a wav
  tone per tab) publishing VP8 with simulcast, the runner joining hidden
  with `livekit` 0.10.x, decoding four tracks latest-wins, composing a 2×2
  grid at 1080p30, encoding with x264 `-tune zerolatency`, pushing to a
  local RTMP receiver. Re-apply the TrackUnsubscribed abort. Measure CPU,
  glass-to-glass (tone to receiver), and the look of VP8 at 720p against
  H.264 at the same bitrate (the latter decoded on this Mac only).
  - **Done when** `docs/cloud/spike-rooms-2026-11.md` is pushed with the
    numbers, the harness runs as `cargo test -p videorc-runner --test rooms
    -- --ignored`, and the note picks D3's codec.
- **S0b. The host app in a room** (desktop, a scratch branch, nothing
  committed to main). An Electron renderer page joins the room with
  `livekit-client`: camera 720p30 VP8, mic, and a screen share through
  `desktopCapturer`. Measure shared text legibility at 720p and 1080p (2, 4,
  6 Mbps), CPU, and whether the backend can release and retake the camera
  without a frozen Clips buffer. Compare the return in a `<video>` with the
  native preview's picture for smoothness.
  - **Done when** `docs/cloud/spike-host-room-2026-11.md` says whether
    renderer publishing is good enough (D6) and whether hiding the Preview
    is right (D7), or names what fails.
- **S0f. The churn run, valid this time.** 600 s with a guest joining and
  leaving every 10 s and one tab flapping its network, on a Mac with sleep
  off (`caffeinate -i`). Count decoder restarts, dropped output frames, and
  memory growth.
  - **Done when** the note has the three numbers and no leak over 10% in
    600 s.
- **S0g. Browser matrix.** Safari on iOS 17 and 18, Chrome on Android 14,
  desktop Chrome, Safari, Firefox and Edge: join, publish VP8, see the host,
  hear a tone, Wake Lock, background and foreground once. A table with
  pass/fail per cell and the iOS version where a cell fails.
  - **Done when** the table is in the S0a-r note with a device list.
- **S0h. Facts refresh.** Re-check PR #1515's state, the `livekit` crate
  version, and LiveKit Cloud's limits; write any change into "Outside
  facts" above with a new date.
  - **Done when** this plan's Outside facts section carries the new date.

Go from Phase 0 means: VP8 decode of 5 tracks at 720p uses under 1.5 cores
on the Linux lab box (or under 0.8 M4 cores); glass-to-glass under 600 ms;
S0b says renderer publishing is good enough; the churn run is clean.

### Phase 1: web (`videorc-web`, from `plan-185-max-and-cloud`)

- **W-G1. Rooms and tokens.** `lib/cloud/rooms.ts`: create the LiveKit room
  with the show (`max_participants` = `roomSize` + 2 for the host and the
  runner, `empty_timeout` 600 s), mint host, guest and runner tokens by role
  (Wire shape), `POST …/room/token`. `livekit-server-sdk` added; keys from
  `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
  `LIVEKIT_WEBHOOK_KEY`. The create route accepts `kind: "talk"` when
  `allowances.talkShows` and `VIDEORC_CLOUD_TALK_SHOWS_DISABLED` is off.
  - **Done when** `tests/cloud-rooms.test.ts` proves each role's grants
    (a guest token has no `roomAdmin`, no `screen_share` by default, TTL ≤
    600 s; the runner is `hidden`), and the create answers 201 with `room`
    and `invite` for a Max fixture and 403 with D11's sentence for Basic.
- **W-G2. Invites and the door.** `cloud_invites`, rotate, expiry, the
  `openDoor` switch, `cloud_guest_requests`, the decide route, the public
  guest routes with rate limits and the cookie, the ban list.
  - **Done when** `tests/cloud-invites.test.ts` proves: a rotated slug
    answers `invalid` at once; a declined cookie is hidden for 10 minutes
    and counted; the 11th guest reads `full`; a banned request never
    reaches `let-in`; 31 requests a minute from one IP get 429.
- **W-G3. The guest page**, `app/guest/[slug]/page.tsx` (UI/Product Design,
  `opus-5.5`). No site chrome, `noindex`, one card, the web's own component
  set.
  - Step 1 "Join {title}": a name field, a camera and mic check (a live
    self-view, device pickers, a level meter), D13's consent line, the
    phone note "Keep this page open while you're on camera." on phones,
    and "Ask to join".
  - Waiting: "Asking the host…" with a spinner; the long-poll.
  - Backstage: "You're backstage. The host will bring you on." with the
    host's tile, mute, camera off, Leave.
  - On stage: "You're on stage" with the stage's people in a strip, the
    same controls, and the screen share button only where allowed and
    supported.
  - States, each one sentence: invalid ("This link isn't valid anymore."),
    waiting for host ("The host hasn't opened the room yet. Keep this page
    open."), full ("This show is full."), declined, removed, ended ("The
    show has ended. Thanks for joining."), weak network ("Your connection
    is weak. Your video may pause." from connection quality `poor`),
    reconnecting ("Reconnecting…"), lost ("Connection lost. Reload to
    rejoin."), muted by host.
  - Accessibility: every control labelled, focus order top to bottom,
    `prefers-reduced-motion` respected, 4.5:1 text, the self-view has
    `aria-hidden`, status changes announced through one live region.
  - A Wake Lock while publishing. VP8, simulcast, 720p; 360p on a `poor`
    connection; adaptive stream on.
  - **Done when** the page renders every state from a fixture
    (`tests/guest-page.test.ts`), both themes by eye on desktop Chrome,
    Safari on an iPhone and Chrome on an Android phone, and S0g's table is
    green for the cells the page supports.
- **W-G4. Webhooks, metering and limits.** `/api/cloud/livekit/webhook`,
  `cloud_room_minutes`, `cloud_livekit_events`, the guest-hours sum per
  month, the fair-use guard (plan 185 D4: 200 guest-hours on Max; Premium
  per D15) answered as 429 `cloud-guest-hours-used-up` at `let-in` time
  (guests already in stay), the LiveKit row and threshold alert on
  `/account/cloud-costs` (plan 185 T7's two missing parts). The runner's
  own join/leave log (R-G1) is the backup source when a webhook never
  arrives: the reconcile cron compares the two.
  - **Done when** `tests/cloud-livekit-webhook.test.ts` proves a bad JWT is
    401, a replayed `id` changes nothing, join+leave writes one row, and
    the guard refuses the next `let-in` at the cap while a running show is
    untouched.
- **W-G5. Cloud recordings.** `cloud_recordings`, the runner's completion
  call (node-signed `POST /api/cloud/recordings`), `GET
  /api/cloud/recordings`, the account page section "Cloud recordings" with
  Download and "Kept until {date}", the expiry cron that deletes the
  object and the row.
  - **Done when** a fixture recording downloads through a signed URL that
    dies after 10 minutes, and the cron deletes an expired one in the test.
- **W-G6. Docs, privacy and terms.** `docs/cloud.md` gains "Talk shows"
  (routes, env, LiveKit keys, the webhook, rollback:
  `VIDEORC_CLOUD_TALK_SHOWS_DISABLED=true` refuses new rooms and keeps
  moderation and End working). The privacy page: guests' camera and voice
  pass through LiveKit and our runner during a show; recordings are kept
  `recordingRetentionDays`; guest names are not kept past the show. The
  terms: acceptable use for guests (the host is responsible for who they
  let in).
  - **Done when** the pages render behind `VIDEORC_MAX_ON_SALE` /
    `VIDEORC_CLOUD_PUBLIC` as plan 185 T5 does, and the owner has the
    privacy diff to read.

### Phase 2: runner (`videorc-cloud`)

- **R-G1. Room input.** `crates/runner/src/room.rs`: join hidden with the
  runner token, subscribe to the high layer of on-stage identities only
  (plus the screen track), decode VP8 to I420 into a latest-wins store per
  track (the S0a shape), PCM per track into the mix's ring, the
  TrackUnsubscribed abort, reconnect with the SDK's resume, a join/leave
  log for W-G4. A track silent for 2 s is "away" in state.
  - **Done when** the rooms harness (S0a-r, now `tests/rooms.rs`) passes
    as an ignored test with 5 publishers and the state's `room.participants`
    matches the publishers within 1 s of each join and leave.
- **R-G2. Layouts.** `stage.set` applied through the shared
  `talk_show_layout` geometry (D8): tiles, names in plates (the runner
  rasterizes names with a bundled font; no PNG from the desktop), the
  host's camera shape, a 300 ms crossfade on a layout change, and a tile
  that reads "Back in a moment" when its track is away.
  - **Done when** unit tests for 1 to 6 people on every layout pass on the
    shared fixture and the pixel probe harness finds each tile's colour at
    its centre for every layout.
- **R-G3. Audio mix.** On-stage mics plus screen audio, gain and mute per
  identity, the runner's clock, silence and a counted underrun for a late
  source, a -1 dBFS limiter, 48 kHz stereo to the encoder.
  - **Done when** the tone-per-guest test finds each on-stage tone in the
    receiver's audio and no backstage tone, and the A/V skew between a
    guest's tone and the flash in their tile is under 80 ms.
- **R-G4. Overlays.** `overlay.set` / `overlay.clear` by slot and
  orientation, with the rect rule from `overlay_blit_layout`, the TTL, and
  `hold.image.set` as the `hold` slot alias. The agent keeps the last
  overlays like the hold image (wire notes, "cloud fix round 2") and
  re-sends after a crash.
  - **Done when** a card set with a 10 s TTL is in the receiver's frames
    for 10 ± 0.5 s and gone after, and a restarted runner shows the hold
    image again.
- **R-G5. The return.** The runner publishes the program as a camera-source
  video track (720p30 VP8, no simulcast) and an audio track into the room;
  `return.set` turns it off. Guests never subscribe to it (their token's
  page code never asks; the runner's identity is `hidden`, so they can't see
  it anyway).
  - **Done when** the host harness sees the return within 700 ms of a flash
    on a guest's tile.
- **R-G6. Cloud recording.** `recording.start/stop`: a second FFmpeg
  consumer on the program (the same encoded stream the legs get, remuxed,
  no second encode), segmented MP4 (`-movflags frag_keyframe+empty_moov` or
  a 10 s segment list stitched at the end), uploaded in parts to the object
  store with the node-scoped credentials, finalized at stop or show end,
  then the completion call to the web. A crash resumes the upload from the
  last part.
  - **Done when** `ffprobe` on the downloaded file shows one h264 and one
    aac stream, a duration within 1 s of the recorded seconds, continuous
    pts, and a SIGKILL mid-recording loses at most the last segment.
- **R-G7. The host away.** 5 s without the host's tracks: the host tile's
  plate; 60 s: re-flow; nobody on stage: the hold image and the hold clock.
  `room.hostAway` in state.
  - **Done when** the harness kills the host publisher and the receiver
    shows the plate within 5.5 s, the re-flow at 60 s, and with no guests
    the hold card within 7 s.
- **R-G8. Capacity.** A talk show's units (wire notes, "Shows are weighed by
  encode cost") add one unit per on-stage decode; the agent refuses a room
  that doesn't fit with 503 `node-full`.
  - **Done when** the agent's placement test refuses the show that would
    exceed `VIDEORC_NODE_UNITS`.
- **R-G9. Vertical.** The vertical output group composes the vertical
  layouts from the same room and takes the `v` overlays.
  - **Done when** the pixel probes pass on a 1080×1920 receiver for each
    layout with 1 to 4 people.

### Phase 3: desktop (`videorc`, on the rebased cloud branch)

- **C-G1. Contract and the talk-show state** (Implementation,
  `gpt-6.1-sol`). `backend-rpc-contract.ts` gains the RPCs, the `room` and
  `recording` blocks, the two fallback reasons and the `cloud.room.requests`
  event; `cloud_show.rs` gains the room phases, the guests long-poll, the
  intents, and the camera hand-over hooks. Shared fixtures round-trip in
  both languages.
  - **Done when** `cargo test -p videorc-backend cloud_show` and the
    contract tests pass, `pnpm smoke:streaming-secrets` style test proves no
    LiveKit token reaches the log or the settings file, and the renderer
    receives `hostToken` only through `cloud.room.token.refresh`.
- **C-G2. Livestream → Guests** (UI/Product Design, `opus-5.5`). A third
  `PageTabs` tab, `guests`. Body: a `PageStack`.
  - A `LockAlert` leads for Basic ("Talk shows with guests come with Videorc
    Max." or D15's Premium line) and for a paid account not on yet (plan
    184 C6's `CLOUD_NOT_YET_REASON`); everything under it disabled.
  - `PanelSection title="Room"`: one `Button` "Open the room" (chrome
    primary) or "Close the room" (outline); a `SettingsRow label="Let anyone
    with the link in backstage"` with a `Switch` (off); description "Backstage
    time counts after 30 min".
  - `PanelSection title="Invite link"`: the URL in a read-only `Input` with
    Copy (`Button` 28 px) and "New link" (outline, `ConfirmDialog` while
    anyone is in the room: "Everyone keeps their place. The old link stops
    working."); description "Up to 5 guests on stage, 10 people in the
    room." from `limits`.
  - `PanelSection title="Who's here"`: a `GroupedList` of `ListRow`s, one
    per person: name, a `StatusDot` for quality, a chip "On stage" or
    "Backstage", and a `KebabMenu` (Rename…, Mute, Allow screen share,
    Remove, Ban). Empty: "Nobody has joined yet. Share the link." Requests
    lead the list with Let in and Decline (`xs`).
  - **Done when** the tab renders locked, empty, a request, two guests and a
    full room from fixtures in both themes, `pnpm probe:ui-glass --gate
    --surfaces` passes, and ⌘K opens it.
- **C-G3. The Show stage and the backstage strip** (UI/Product Design,
  `opus-5.5`). `components/studio/show-stage.tsx` replaces
  `StudioPreviewPanel` while `cloud.room.phase === 'open'`:
  - the stage: a 16:9 well (`bg-inset`, `--video-ground`) with `<video>`
    tiles placed by `lib/talk-show-layout.ts`, names in plates, the host's
    tile marked "You";
  - the Program monitor (D7) with a mute toggle (`icon-xs`);
  - a `SegmentedControl` under the stage: Solo, Side by side, Screen +
    people, Spotlight (disabled with `disabledReason` "Share a screen first"
    for Screen + people with no screen);
  - the backstage strip: a horizontal `GroupedList` (compact rows, 28 px)
    of everyone in the room, each with a thumbnail (the low simulcast
    layer), name, `StatusDot` quality, a mic level sliver
    (`SessionMicSliver`'s meter), and `xs` buttons: Bring on / Send
    backstage, Mute, and a `KebabMenu` (Spotlight, Rename…, Allow screen
    share, Remove, Ban). "Ada wants to join" is a warning `Alert` above the
    strip with Let in and Decline (`xs`).
  - **Done when** the stage renders every layout for 1 to 6 fixture tracks
    (test streams from canvas elements) in both themes, the strip's actions
    call the RPCs with the right ids (unit tests), and a 1:1 screenshot
    comparison between the stage and the runner's receiver frame for the
    same `stage.set` differs only inside the tiles (geometry test).
- **C-G4. The host joins the room** (Implementation, `fable-5.1`; media).
  `lib/talk-show-room.ts`: `livekit-client`, camera from the Sources
  camera id, mic from the Sources mic, screen share through
  `desktopCapturer` (the Scene page's screen or window choice), VP8
  simulcast; the camera hand-over with the backend (D6), reconnect
  handling, token refresh through `cloud.room.token.refresh` before expiry.
  - **Done when** the backend's camera stops with reason `talk-show` within
    1 s of Open the room and restarts within 2 s of Close the room (a
    `preview.camera.status` sequence test), and the ISO-take refusal test
    from [[videorc-iso-take-camera-stop-freeze]] still passes.
- **C-G5. The Preview during a talk show** (Implementation, `gpt-6.1-sol`).
  `PreviewStage` hides the docked slot and closes the detached window with
  the one-line reason (D7) and reopens what was open when the room closes;
  the dock epoch and `useDockSlotReporter` see one unmount and one mount.
  - **Done when** `pnpm probe:preview-lifecycle` passes with a scripted
    room open and close (the probe gains the two steps), and the status copy
    names the reason.
- **C-G6. Go Live and Record in a talk show** (Implementation,
  `gpt-6.1-sol`). Go Live's prepare runs as today (YouTube broadcast from
  the computer, keys from the keychain) and hands destinations to the
  runner; no local legs; the dialog's primary says "Go live on 3
  destinations" and the pending label stays "Starting…"; End livestream ends
  the legs and keeps the room; Record calls `cloud.recording.start`, the
  button's clock is the runner's `recording.seconds`; the Output page's
  recording rows read "Recording goes to Videorc Cloud while the room is
  open."; the status bar reads "● On air 12:04" as today.
  - **Done when** `pnpm smoke:start-labels` is unchanged, a unit test proves
    no `StreamTarget` is built locally in a talk show, and the stop path
    moves the YouTube broadcast to `complete` as today.
- **C-G7. Comment cards and takeovers** (Implementation, `gpt-6.1-sol`).
  `comments.highlight.set` and the takeover path fork in the backend: in a
  talk show the PNG and rect go to `overlay.set` per orientation; the
  renderer's "On stream" state comes from the runner's state.
  - **Done when** `pnpm smoke:comment-highlight-stream` still passes on the
    solo path, and the talk-show smoke (S-G1) finds the card on the
    receiver.
- **C-G8. Resume after a relaunch.** `GET /api/cloud/shows/current` returns
  the talk show; the Resume notice reads "You're still live through Videorc
  Cloud. Your guests are still on." with Resume and End livestream; Resume
  opens the room client again with a fresh token and sends no
  `destinations.set` (plan 184 C5b).
  - **Done when** the smoke's host kill and relaunch puts the host's tile
    back within 10 s of the Resume click and the receiver never drops.

### Phase 4: smokes, acceptance and rollout

- **S-G1. `pnpm smoke:cloud-talk-show`** (`scripts/smoke-cloud-talk-show-app.mjs`,
  desktop repo). Adds `playwright-core` as a devDependency and drives the
  system Chrome (or the Electron binary's Chromium) headless with
  `--use-fake-device-for-media-stream`, a y4m of one flat colour and a wav
  tone per guest. `livekit-server --dev` on free ports, the agent and runner
  from the sibling `videorc-cloud`, `fake-cloud-web.mjs` grown to mint
  LiveKit tokens, answer the guest routes and take the webhook, two local
  RTMP receivers (one vertical when R-G9 lands).
  Steps: open the room; two guests ask; Let in both; Bring on one, then
  both; each layout with pixel probes at the tile centres; a tone per
  guest; a comment card; Record; Go Live; kill the dev app (SIGKILL); the
  receivers never gap over 2 s and the host tile reads "Back in a moment"
  (a probe on the plate's colour); relaunch and Resume; Send backstage;
  Remove one guest (their page reads removed); New link (the old slug
  invalid); End livestream; Close the room; `ffprobe` on the recording;
  a leak scan over the renderer events, the app log and the fake web's log
  for LiveKit tokens and keys. Measured and printed: time to let in,
  Bring on to the receiver, glass-to-glass tone, resume time.
  - **Done when** it passes three times in a row on this Mac and is listed
    in `AGENTS.md` under Verification Gates (not in `smoke:local-gates`,
    because it needs the private checkout, like `smoke:cloud-solo`).
- **S-G2. Direct-path smokes stay green**: `pnpm smoke:multistream`, `pnpm
  smoke:stream-leg-eof`, `pnpm smoke:streaming-secrets`, `pnpm
  smoke:comment-highlight-stream`, `pnpm smoke:live-chat-fake-providers`,
  `pnpm smoke:recording-studio`, `pnpm smoke:cloud-solo`.
- **S-G3. Owner acceptance** (a live test on the owner's go only): a 1-hour
  talk show with 2 guests, one on a phone browser, to 3 or more of the
  owner's real channels. The recording downloads and plays. Kill the Mac
  mid-show; the guests carry on; bring it back and the host is back. Both
  themes by eye on the Guests tab, the Show stage and the guest page.
- **S-G4. Rollout** (plan 184 D20): web first behind
  `VIDEORC_CLOUD_TALK_SHOWS_DISABLED`, then the runner on the nodes (plan
  222's infra), then the desktop release, then the switch flips for the
  owner's account, then for the tier the owner picked in D15.

## Verification gates

Use `AGENTS.md` as the source of truth. Per phase, once, at the end:

- **Phase 0**: the three notes; no product gates.
- **Phase 1** (`videorc-web`): `pnpm typecheck && pnpm lint && pnpm test
  && pnpm build`; `tests/db-migrate.test.ts` for `0028` onward; the guest
  page by eye on three real browsers (W-G3).
- **Phase 2** (`videorc-cloud`): `cargo fmt --check`, `cargo clippy -- -D
  warnings`, `cargo test -p videorc-runner`, `cargo test -p videorc-runner
  --test rooms -- --ignored`, `cargo test -p videorc-runner --test
  hold_continuity -- --ignored` (solo unchanged).
- **Phase 3** (`videorc`): `cargo fmt --check --all`; `cargo clippy -p
  videorc-backend --all-targets -- -D warnings`; `cargo test -p
  videorc-backend cloud_show` and the camera hand-over tests; `pnpm
  typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm --filter
  @videorc/desktop test`, `pnpm test:scripts`; `pnpm probe:ui-glass --gate
  --surfaces`; `pnpm probe:preview-lifecycle`; `pnpm smoke:start-labels`.
- **Phase 4**: `pnpm smoke:cloud-talk-show` three times, then S-G2's list,
  then `pnpm smoke:cloud-solo`.
- **Every phase**: a security review (Review, `fable-5.1`) of every new
  route, token mint, webhook and socket intent before the kill switch flips;
  a leak scan for LiveKit tokens and API keys in logs, events and settings.

## When things break

| What breaks | What viewers see | What the guest sees | What the host sees | Recovery |
| --- | --- | --- | --- | --- |
| The host's Mac dies | The host's tile reads "Back in a moment"; the guests go on | Nothing changes | On relaunch: the Resume notice | Resume rejoins the room (C-G8); the hold ends the show after its limit only if nobody is on stage |
| A guest drops | Their tile freezes, then "Back in a moment" after 5 s; re-flow after 60 s | "Reconnecting…", then back, or "Connection lost. Reload to rejoin." | Their strip row's dot turns `lost`; a Send backstage is offered | LiveKit resumes; a reload asks again and is let in without a new question (the cookie) |
| A guest on a weak network | Their tile is softer (a lower simulcast layer) | "Your connection is weak. Your video may pause." | The strip dot reads `poor` | Adaptive stream; the host may Send backstage |
| LiveKit is down | Every tile freezes, then the hold image within 7 s (nobody on stage) | "Connection lost." | "Guest connection lost. Videorc is reconnecting." on the stage | The runner's SDK reconnects; the hold clock runs; the host may End livestream |
| The runner crashes | Every platform drops for 10 to 15 s | Nothing (the room is LiveKit's) | "Videorc Cloud restarted your show" | The agent restarts it; it rejoins the room, gets destinations and overlays from the agent's memory, the desktop re-sends `stage.set` |
| The media node dies | Every show on it drops | The room stays; nothing to join to | "Cloud show lost. Streaming directly isn't possible in a talk show." | The show ends; the owner gets an alert (plan 222's watching). No direct fallback exists for a talk show |
| videorc.com is down | Nothing | New joins fail ("Try again in a moment."); people in the room stay | Moderation and new joins fail with one reason; the stream goes on | Retries; the runner never needs the web mid-show |
| The host's internet drops | As "the host's Mac dies" | Nothing | "Reconnecting to Videorc Cloud" | The renderer resumes the room; the socket reconnects |
| Guest-hours cap reached | Nothing | "This show is full." for new guests | "This month's guest limit is reached. Guests already on stay." | Resets on the 1st |
| A stranger has the link | Nothing | "Asking the host…" | "Someone wants to join" with Decline | Decline, Ban, New link |

## STOP conditions

Stop and ask the owner when:

- Phase 0 says VP8 decode of 5 tracks does not fit the node budget (D3), or
  renderer publishing is not good enough and native publishing is the only
  way (D6).
- A change would store a LiveKit API secret, a stream key or a platform
  token anywhere but the web's env and the node's memory.
- A change would make a YouTube API call from a server (plan 184 D13).
- A change would add a control next to Record or Go Live…, or move Buddy.
- A change would let a guest reach the stage without Bring on, or enter the
  room without Let in while the door is closed.
- The measured LiveKit bandwidth per guest-hour is more than 1.5× plan 185's
  estimate (the numbers are in plan 185).
- The S0e code-ownership check fails for `talk_show_layout.rs` or any file
  the runner would reuse.
- Plan 222's solo path is not merged and running on a node: guests ship on
  top of it, never beside it.

## Out of scope (for now)

- A solo show becoming a talk show mid-stream (D18).
- Buddy on stream, captions, masks, chroma key and freeform scenes in a
  talk show (plan 184 D21, X3, X4).
- Each person as their own file (plan 184 X1), producer seats (X2), the
  phone as a guest or a remote (Phase 3), going live from the phone alone
  (X6).
- Guest chat (text) inside the room; guests see the host and the stage
  only.
- Guest-side recording consent per platform rule sets; one line for all.
- Self-hosted LiveKit (X8), a US node.
- Windows and Linux hosts of talk shows (plan 184 D19).
- Backgrounds, blur or filters on guest video.

## Open questions for the owner

1. **Codec (D3)**: VP8 for guests at launch, with H.264 as an upgrade when
   PR #1515 merges or a GPU node exists? **Recommended: yes.**
2. **The door (D4)**: must the host let every guest in, with "Let anyone
   with the link in backstage" as an off-by-default switch? **Recommended:
   yes.**
3. **Packaging (D15)**: A (Max-only), B (Premium gets 1 guest and 7-day
   recordings; Max 5 guests and 30 days), or C (a few talk shows a month on
   Premium)? **Recommended: B.**
4. **Where invites live (D16)**: a Guests tab on the Livestream page, not a
   new sidebar page? **Recommended: the tab.**
5. **The Preview during a talk show (D7)**: hide it and show the Show stage,
   or keep the detached Preview window showing the return? **Recommended:
   hide, pending S0b.**
6. **Guest screen share (D14)**: off per guest until the host allows it?
   **Recommended: yes.**
7. **Object store for cloud recordings (D10)**: the R2 account the releases
   already use, or a separate bucket and account? **Recommended: a separate
   R2 bucket under the same account, with its own scoped key.** Re-checked
   2026-11-08 after Neon became the backend: still R2 (D10).
8. **Invite while live (D18)**: inviting into a running talk show is in;
   solo → talk mid-stream is out for v1? **Recommended: yes.**
9. **Consent line (D13)**: "This show goes out live on {platforms} and may
   be recorded. Your camera and voice are part of it." as the one sentence?
   **Recommended: yes.**

## Handoff (cold start)

- **Goal**: browser guests on a Videorc Cloud talk show, as above. Plan 184
  Phase 2's G1 to G18 are superseded by this plan's W-G, R-G, C-G and S-G
  slices.
- **Must exist first (plan 222)**: the solo cloud path merged from the three
  draft PRs (desktop #727 rebased onto `origin/main`, web #85, `videorc-cloud`
  #1), at least one media node provisioned with DNS and TLS (plan 184 I1,
  I5), deploys (I3), watching and alerts (I4), the rollout switches, and the
  owner's blockers answered: a VM-host account (plan 184 D9; Hetzner until
  2026-11-08), DNS, a LiveKit Cloud project, Creem
  Max products, and the YouTube compliance answer updated for stream keys
  passing through the cloud (plan 184 D15). Without a node there is nothing
  for the runner to run on; without LiveKit there is no room.
- **Related plans**: 222 (the cloud solo path, infra, rollout: this plan's
  prerequisite), 223 (the watchdog should watch talk-show legs the same as
  solo legs; nothing here changes for it), 225 (viewer identity; no
  dependency either way).
- **Current state**: nothing built. Phase 1 solo exists in the three draft
  PRs. The S0a rooms code is lost; its results are in "What exists".
- **Start with**: Phase 0 (S0a-r, S0b, S0f, S0g, S0h) in parallel, two
  agents at most on Rust compiles. Then Phase 1 and Phase 2 in parallel,
  then Phase 3, then Phase 4.
- **Route and lanes**: Status above.
- **Files to read first**: `plans/184-videorc-cloud.md` (Wire shape, D5 to
  D21), `videorc-cloud/docs/wire-notes.md`, `videorc-cloud/docs/spike-runner-2026-10.md`,
  `crates/videorc-backend/src/cloud_show.rs` (cloud branch),
  `apps/desktop/src/renderer/src/components/tabs/studio-tab.tsx` (main),
  `components/streaming/cloud-section.tsx` (cloud branch),
  `lib/cloud/shows-route.ts` and `lib/entitlements/plans.ts` (web).
- **Blockers**: a LiveKit Cloud project and keys, an object store bucket and
  key, the owner's answers to questions 1 to 9. Never invent credentials.
