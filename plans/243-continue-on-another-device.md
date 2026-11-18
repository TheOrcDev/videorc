# Plan 243: Continue a live show on another device

> **Executor instructions**: read `AGENTS.md`, this whole plan, and the
> sections of `docs/cloud/managed-media-wire.md` your slice names. UI slices
> also read `.claude/skills/videorc-design/SKILL.md` (desktop) or the web
> repo's `.agents/skills/shadcn` rules (web). Web work happens in
> `~/projects/videorcweb-wt-243*`, desktop work in `~/projects/videorc-wt-243*`,
> each on its own branch from `origin/main`. Never read the web's `.env`.
> Write and commit every slice of your lane first; heavy gates and smokes run
> once at the end (owner feedback "Gates at the end"). No test, smoke or dev
> run may call the real videorc.com or LiveKit Cloud.

**Drift check** (run before any slice; a non-empty diff means re-read the
"What exists" facts for the files that moved):

```sh
git -C ~/projects/videorc fetch -q origin && git -C ~/projects/videorc diff --stat c004c233d origin/main -- \
  crates/videorc-backend/src/cloud_show.rs crates/videorc-backend/src/cloud_control_web.rs \
  crates/videorc-backend/src/cloud_talk.rs apps/desktop/src/renderer/src/components/end-livestream-dialog.tsx \
  apps/desktop/src/renderer/src/components/studio/cloud-resume-notice.tsx apps/desktop/src/renderer/src/lib/session-stop.ts \
  apps/desktop/src/main/exit-guard.ts scripts/lib/fake-cloud-web-managed.mjs scripts/smoke-cloud-solo-managed-app.mjs
git -C ~/projects/videorcweb fetch -q origin && git -C ~/projects/videorcweb diff --stat 0d575bdf origin/main -- \
  lib/cloud/media lib/cloud/program lib/cloud/shows-route.ts lib/cloud/talk-route.ts lib/cloud/livekit.ts \
  app/live components/live app/cloud/program
```

## Status

- **Status**: PLANNED 2026-11-16 and executing. The owner answered every
  shaping question: phone **and** computer; a browser-only phone page is fine
  for v1 (the screen stays on); keys are rebuilt on the new computer, never
  stored (option a); the platform's saved video is the record. D9 to D14 are
  the orchestrator's defaults (⚑).
- **Priority**: P1 (owner ask).
- **Effort**: L. Web: one route, one token path, the program page's solo
  source, state fields, the phone page. Desktop: device identity, Hand off,
  Taken over, Continue here, reconnect from another computer, three UI
  surfaces, two smokes extended.
- **Risk**: HIGH.
  - A hand-off must never end the show, and never complete the YouTube or X
    broadcast. A wrong stop path takes every platform offline.
  - Rotating the ingress on a live show has only been measured on paper
    (Phase 0 of plan 234 never rotated one); the acceptance run covers it.
  - Any signed-in session of the account can take a live show (as End stream
    can today).
- **Planned at**: desktop `origin/main` `c004c233d` (0.28.2), web
  `origin/main` `0d575bdf`.
- **Route**: Orchestrator (fit 10): two repos, live media, a session
  lifecycle. Lanes:

| Lane | Slices | Route, fit | Model |
| --- | --- | --- | --- |
| Web server + program page | W1–W4, W6 | Implementation, 8 | `gpt-6.1-sol` xhigh |
| Phone page | W5 | UI/Product Design, 9 | `opus-5.5` xhigh |
| Desktop backend + smokes | C1–C4, C6 | Diagnose/Implementation, 9 | `fable` (5.2) high |
| Desktop UI | C5 | UI/Product Design, 9 | `opus-5.5` xhigh |
| Reviews | R1, R2 | Review, 9 | a lane that did not write the code |

## The owner's ask

2026-11-16: "I want people to be able to go and continue their live session
from whatever device they want. My use case would be: if I start live
streaming from my computer, I could close the computer and continue on my
phone or I can close the computer and continue with a different computer."

Answers the same day: "1 Lets go both phone and computer 2 yes ok for v1
3 recommended 4 enough - plan it out, execute the entire plan when done and
create a pr".

## What a streamer gets

1. **Leave without ending.** End livestream on a cloud show offers
   **Continue on another device**. The computer stops sending, viewers see
   Be right back, and every platform stays connected. The local recording
   stops and is saved, as with any Stop. Quitting while live offers **Quit
   and keep it live**.
2. **Pick it up on a phone.** On the phone, videorc.com/live shows **Continue
   on this phone**. The phone shows its camera first; **Go on air** puts it
   on stream. If the computer is still sending, viewers go straight from the
   computer to the phone without a Be right back card. The computer stops by
   itself and says "Your show continues on iPhone."
3. **Pick it up on another computer.** Videorc on the other computer, signed
   into the same account, says "Your show is live from MacBook Pro" with
   **Continue here**. That computer's Studio goes on air. Its own saved keys
   reconnect a platform that drops (when they match the live stream), and
   YouTube chat connects.
4. **And back.** Any device can take the show back the same way. A browser
   on a laptop works like a phone.
5. **Talk shows.** The host seat moves the same way: the guests stay on, the
   stage keeps its layout, and the host's tile shows the new device.

## Words we use

| Word | Meaning |
| --- | --- |
| **Device** | A computer running Videorc, or a browser on videorc.com/live/continue. Each has a stable id and a name ("MacBook Pro", "iPhone") |
| **On air** | The one device whose picture and sound viewers get. A show has at most one |
| **Hand off** | The on-air device stops sending on purpose. The show waits (Be right back) until a device continues or the hold limit ends it |
| **Waiting** | Nobody is on air after a hand-off. The hold runs |
| **Continue here** | A device takes the show. "Take over" in code |
| **Taken over** | What the previous device sees when another device continues |
| **Prepare / go** | The two steps of taking over: get ready (an ingest address or a room token), then switch viewers to this device |
| **Rotate** | Replace the show's ingress with a new one (a new key), so the previous computer's key stops working |

## What exists (facts, desktop `c004c233d`, web `0d575bdf`)

### The show lives without the computer (plan 234)

- A managed solo show is: desktop RTMPS feed → LiveKit ingress (participant
  `feed-h` / `feed-v`) → room `<showId>` → egress rendering the program page
  → platforms. The egress holds every platform; nothing on the computer does.
- The program page holds on its own: no frame for 1.5 s → freeze → 300 ms
  fade → card (W `lib/cloud/program/hold.ts`, timings `wire.ts:177-188`).
- The hold limit is the room's `departure_timeout` (`holdMaxSeconds`, default
  1800 s), plus the reaper (W `lib/cloud/media/reconcile.ts:390-484`).
- `GET /api/cloud/shows/current` re-reads the ingest from LiveKit on every
  call and gives it to any session of the owner (W `livekit.ts:343-382`).

### What is missing

- **The solo page draws only the feed.** `query.ts:61` fixes
  `feedIdentity` by `layout`; `source.ts:248-358` subscribes only that
  identity with `autoSubscribe: false`; the solo source never reads room
  metadata. A swap of video track while live is already handled
  (`solo.ts:299-315`: the old picture covers until the new first frame).
  Portrait in landscape is already contained on black (`picture.ts:111-118`).
- **No solo show has a browser publisher.** `room/token` is talk-only
  (`talk-route.ts:158-225`). Solo webhooks ignore participants
  (`media/webhook.ts:198-200`). Solo rooms set no `maxParticipants`.
- **Nothing knows which device is on air.** `client_json` holds `{app,
  version}` only (`shows.ts:440-453`); `desktop_seen_at` is stamped by any
  state poll (`sync.ts:88-96`).
- **No destination metadata survives the computer.** Legs keep id, label,
  platform, orientation, an HMAC `ref`, never a URL and never a YouTube
  broadcast id (W `schema.ts:578-601`).
- **The desktop cannot leave without ending.** Stop runs
  `on_session_stopped` → `end_current_show` → `POST …/end`
  (D `cloud_show.rs:3942-4015`). Only a killed process leaves the show
  holding. The renderer's stop also completes YouTube and ends X broadcasts
  (D `use-studio.tsx:17382-17468`, `completePreparedPlatformBroadcasts`
  `:15601`).
- **The quit question** offers only "End livestream and quit" or "Keep
  streaming" (D `apps/desktop/src/main/exit-guard.ts`, `index.ts:17860-18053`).
- **A second computer finds a show only at launch.** `launch_check_due`
  (D `cloud_show.rs:1929-1935`) runs once; `hold_current_show`
  (`:4086-4256`) holds the show resumable and opens control (the state
  poll). Nothing re-asks `current` later.
- **A resumed computer holds no URLs.** `reconnect_destination` refuses
  ("…can't reconnect one destination", `cloud_show.rs:4034-4040`);
  `resend_legs_that_ask` (D `cloud_control_web.rs:2042-2095`) sends
  nothing. Twitch and Kick chat need only the account; YouTube chat needs
  the broadcast id (`StreamTargetSettings.platform_broadcast_id`,
  D `streaming.rs:116`), which lives in the first computer's localStorage
  capture config.
- **Talk shows**: the host is `host:<showId>` from `room/token`
  (W `talk-route.ts:206-225`, a session cookie or the desktop's bearer). A
  second host connection triggers LiveKit's `DUPLICATE_IDENTITY`; the
  desktop treats it as terminal "Connection to the room lost."
  (D `talk-show-room.ts:516-526`). `cloud.room.resume` rejoins
  (D `cloud_talk.rs:2242-2334`).
- **Contracts**: the renderer's `cloudStatusSchema` is strict
  (D `backend-rpc-contract.ts:6230-6408`); new fields need serde
  `default` + `skip_serializing_if`, the TS schema and the fixture
  (`protocol-fixtures/high-risk-contracts.json` `cloud`). The desktop's
  `RunnerState` and `CurrentShowResponse` ignore unknown fields, so old
  desktops survive new web fields.
- **Budget**: eager renderer gzip ceiling 487,000, last measured 485,281
  (D `scripts/check-renderer-asset-budget.mjs:141-153`).

## Outside facts

- iOS Safari mutes camera and microphone while the page is hidden or the
  phone is locked, and resumes them when visible; Chrome on Android stops
  the camera in the background (plan 184, Outside facts). So on a phone the
  page must stay open; a lock shows Be right back.
- The Screen Wake Lock API keeps the screen on while the page is visible
  (the guest page already uses it, W `guest-room.tsx:368-385`).
- LiveKit disconnects the older connection when a second one joins with the
  same identity (`DUPLICATE_IDENTITY`). The program page already reads it
  (W `source.ts:93-98`).
- LiveKit's RTMP ingress serves one publisher. A silent (asleep) publisher
  can keep its participant about 100 s (plan 234 Phase 0). Whether a second
  publisher is accepted in that window is not measured, so this plan never
  relies on it: a computer that takes over gets a **rotated** ingress.

## Decisions (⚑ = owner may override)

### D1. One show, many devices, one on air: DECIDED

The web keeps `onAir` on the show: which device, which source, since when,
and whether it is waiting. Every device reads it. A device that sees another
device on air stops sending by itself. The program page draws the on-air
source named in the room's metadata.

### D2. Make before break where the media allows: DECIDED

- **To a browser** (phone or laptop): the browser publishes first, unseen;
  **Go on air** switches the page to it once it has a frame. No card.
- **From a browser to a computer**: the computer pushes its feed first; the
  switch happens once the ingress is connected. No card.
- **Computer to computer** (one ingress): break, then make. The new computer
  rotates the ingress, which cuts the old feed; viewers see the freeze and
  the card until the new feed arrives (about 6 to 8 s). Accepted for v1.
- **Talk host seat**: the new device joins as `host:<showId>`, which drops
  the old connection; the tile switches in about a second.

### D3. Keys are rebuilt on the new computer: DECIDED (owner answer 3)

videorc.com never stores a stream key. A computer that continues a show
holds its own saved targets (hydrated from its keychain) as **reconnect
candidates**. It never hands them over. When a leg must be reconnected it
sends its own URL **under that leg's id**; the web's existing rule refuses a
different `ref` (`destination-changed`, wire §2.2), so a different key can
never start a new stream. A phone cannot reconnect a platform.

### D4. The platform's video is the record: DECIDED (owner answer 4)

The local recording on the first computer stops and is saved at the
hand-off. A continuing computer follows its own "record while streaming"
setting, exactly as Resume does today (plan 184 C5b): with it on, that
computer records its part locally. Corrected 2026-11-16 during C6: the plan
first said a Resume never records, which was wrong. Solo cloud recording
stays out of scope.

### D5. The phone is a browser page: DECIDED (owner answer 2)

`videorc.com/live/continue`, signed in. It works on any browser with a
camera. It keeps the screen on with a wake lock and says that locking the
phone shows Be right back. No native app, no IRL-app address in v1.

### D6. A computer that takes over rotates the ingress: DECIDED

On a computer's prepare, when the feed last belonged to another device, the
web deletes the show's ingress per orientation and creates a new one with
the same participant identity. The old key stops working at once (a closed
or asleep laptop can never come back on air by accident, and the new
computer never waits ~100 s for a silent connection). The same computer
continuing its own show keeps its ingress.

### D7. Hand-off never ends a broadcast: DECIDED

The hand-off and taken-over stop paths skip `POST …/end`, YouTube
`complete`, X broadcast end and the renderer's lifecycle completion. The
YouTube broadcast ends by `enableAutoStop` when the show ends, as it already
does after a Resume (plan 184 C5b).

### D8. Old desktops are refused, not surprised: DECIDED

A show created by a desktop older than **0.29.0** (the first build with this
plan) cannot be taken over: 409 `cloud-handoff-update`, "Update Videorc on
{name} first, or end the stream and go live again." An old desktop would keep
feeding, and its Stop would end the show under the new device.

### D9. Who may take over ⚑

Any signed-in session of the account, after a tap on that device (Go on
air / Continue here). The previous device is told at once and names the new
one. No approval from the old device in v1 (it may be closed, which is the
point). End stream on /live already gives a session this much power.

### D10. Discovery on a computer that is already open ⚑

While signed in, idle (no session, no show held) and able to own a show, the
desktop asks `current` every 60 s and when its window gains focus (at most
once per 10 s). A held show already polls state, so `onAir` changes reach it.

### D11. Names ⚑

A computer's name is macOS's Computer Name (`scutil --get ComputerName`),
Windows' `COMPUTERNAME`, Linux's hostname; a browser's is derived from its
user agent ("iPhone", "iPad", "Android phone", "Mac", "Windows PC",
"Chromebook", "Linux computer", else "a browser"). Plain text, at most 40
characters. Names live in the show row during the show and are scrubbed at
end with the participants (wire §15).

### D12. Talk shows move the host seat only ⚑

The phone page publishes camera and microphone as the host. Stage control,
overlays, guests, comments and Sidekick stay on a computer. When the desktop
hands off it clears its overlays first, so a takeover image never stays on
air with no way to remove it.

### D13. The phone page polls without looking like a desktop ⚑

The page reads `GET …/state?since=&viewer=page`. A `viewer=page` poll never
stamps `desktop_seen_at`, so the reaper's `egress-lost` rule and
`desktopConnected` keep meaning a computer.

### D14. Picture fit ⚑

A device whose picture does not match the output (a portrait phone in a
horizontal show) is contained on the card colour `#0D0D0F`, as the solo page
already does. A blurred fill is a follow-up, measured for lost frames first.

## Wire shape

### Device

```json
{ "id": "<22 base62>", "name": "MacBook Pro", "kind": "computer" }
```

- `id`: 22 base62 characters. A desktop keeps it in `app_settings`
  `cloud.deviceId` (created on first use); a browser in localStorage
  `videorc.deviceId`. Dev builds may set `VIDEORC_CLOUD_DEVICE_ID` and
  `VIDEORC_CLOUD_DEVICE_NAME` (refused in release builds) for smokes.
- `name`: 1 to 40 characters of plain text (the stored-text rule of wire
  §2.2: no C0/C1, DEL, lone surrogate or `://`); 400 `invalid-request`
  otherwise, naming the field, never the value.
- `kind`: `computer` (Videorc), `phone`, `browser` (a browser on a computer).

### Create (`POST /api/cloud/shows`)

The body gains optional `device`. The web sets `state_json.onAir` to
`{ deviceId, name, kind, source, since: now, waiting: false }` with
`source` `feed` (solo) or `host` (talk), and `state_json.feedDeviceId` to
the device id (solo). Without `device` (old desktops) `deviceId` and `name`
are null.

### `onAir` in `GET …/state` and `GET …/current`

```json
"onAir": { "deviceId": "Ab3…", "name": "iPhone", "kind": "phone",
           "source": "camera", "since": "2026-11-16T20:01:02.000Z", "waiting": false }
```

- `source`: `feed` (a computer's RTMPS feed, solo), `camera` (a browser's
  camera and microphone in the room, solo), `host` (the talk host seat).
- In `state` beside `phase`; in `current` beside `show` (managed shows only).
- Material for `rev`: `deviceId`, `source`, `waiting`.
- `legs[]` gains optional `broadcastId` (see Destinations).

### `POST /api/cloud/shows/:id/on-air`

Owner session (cookie or bearer). Body: `{ "device": {…}, "source":
"feed"|"camera"|"host", "step": "prepare"|"go" }`. Takes the show lease
(wire §9).

Refusals, in order: 404 not the owner's or not found; 409 `cloud-show-ended`;
409 `cloud-handoff-unsupported` (node media, or a test show, or `source`
not allowed for the kind: solo takes `feed`|`camera`, talk takes `host`);
409 `cloud-handoff-update` (D8: `client_json.app` is `desktop` and its
version is below `FIRST_HANDOFF_DESKTOP_VERSION` = `0.29.0`, unless the
claimer is the creating device); 400 `invalid-request`.

| `source`, `step` | The web does | Answers |
| --- | --- | --- |
| `feed`, `prepare` | If `feedDeviceId` ≠ the claimer: rotate every ingress (D6), set `feedDeviceId`. If `onAir.source` is `feed`, or `onAir.waiting`: set `onAir` to the claimer, `feed`, not waiting (break-before-make, D2). Else (a browser is on air): leave `onAir`; store `pending: {deviceId, source}` | `{ ok, rev, onAir, ingest: [{orientation, serverUrl, streamKey}] }` |
| `feed`, `go` | If `onAir` is already the claimer's `feed`: nothing. Else every output's feed must be connected (`ingress_started` seen after the rotation, or `ListIngress` state publishing), else 409 `cloud-source-not-ready`. Then room metadata `{v:1, onAir:"feed"}` and `onAir` = claimer, `feed` | `{ ok, rev, onAir }` |
| `camera`, `prepare` | Mint a token: identity `d_<device.id>`, name = device name, `canPublish` camera + microphone only, `canSubscribe` false, `canPublishData` false, TTL 600 s. Idempotent: the page calls it again every 270 s to refresh. Solo rooms get `maxParticipants` headroom only if one is set | `{ ok, rev, onAir, room: {url, token, identity} }` |
| `camera`, `go` | The room must list `d_<device.id>` with a published camera track (`ListParticipants`, fresh read), else 409 `cloud-source-not-ready`. Room metadata `{v:1, onAir:"d_<id>"}`; `onAir` = claimer, `camera` | `{ ok, rev, onAir }` |
| `host`, `prepare` | Nothing (a desktop's own room resume mints its token) | `{ ok, rev, onAir }` |
| `host`, `go` | `onAir` = claimer, `host`, not waiting. The previous host connection drops when the new one joins (D2) | `{ ok, rev, onAir, room: {url, token, identity: "host:<showId>"} }` (the `room/token` grants) |

### `POST /api/cloud/shows/:id/hand-off`

Owner session. Body `{ "device": { "id" } }`. If `onAir.deviceId` is that
id: `onAir.waiting = true`, `rev` grows, 200 `{ ok, rev, onAir }`. Else 409
`cloud-not-on-air`. The device then stops sending; the page holds on missing
frames as today. Room metadata does not change.

### Destinations (`PUT …/destinations`)

Each destination gains optional `broadcastId`: 1 to 64 of `[A-Za-z0-9_-]`,
sent for YouTube legs from `platform_broadcast_id`. Stored on the leg,
returned as `legs[].broadcastId`. Not secret; scrubbed at end with the legs.

### The program page (solo)

- Room metadata `{ "v": 1, "onAir": "feed" | "d_<22 base62>" }`, at most
  4,096 bytes. Absent, unreadable or another shape: `feed`. `feed` means
  `feed-h` on the `h` page and `feed-v` on the `v` page; a `d_` identity
  is drawn by both pages.
- The page reads it at join and on `RoomMetadataChanged`. On a change it
  subscribes the new identity's camera and microphone, keeps drawing the old
  source until the new one's first decoded frame (at most 5 s), then
  switches with the existing cover (`solo.ts:299-315`) and a 300 ms fade,
  and unsubscribes the old one. After 5 s without a frame it switches anyway
  and the hold machine runs on the new source.
- The hold machine, the audio element and the beacons follow the on-air
  source. `START_RECORDING` is unchanged.

### State and the reaper

- `ingress_ended` starts the 5 s hold fallback only while `onAir.source` is
  `feed` and no rotation is in flight (`state_json.rotating`, 15 s) and the
  event's ingress id is the current one.
- The reaper's "silent past the hold limit" rule uses the primary page's
  hold beacon whatever the source. `egress-lost` keeps meaning a computer
  (D13); a show held by a browser ends when its egress dies (nobody holds
  the keys, wire §D9).
- A `viewer=page` state poll never stamps `desktop_seen_at` (D13).

### Desktop RPCs and events

- `cloud.show.handOff {}` (renderer only): the on-air managed show of this
  computer (solo fed by the current session, or an open talk room) is handed
  off: `POST …/hand-off`, then the session stops through the hand-off stop
  (D7). A failed POST still stops sending (the show holds either way) and
  says so.
- `cloud.show.resume` and `cloud.room.resume` gain the take-over steps
  (C4); their RPC shape is unchanged.
- `cloud.show.check {}` (renderer only): asks `current` now, at most once per
  10 s (D10).
- `CloudStatus.onAir` (optional): `{ name?: string, kind: "computer" |
  "phone" | "browser", source: "feed" | "camera" | "host", waiting: boolean,
  thisDevice: boolean, since: string }`. Device ids never reach the renderer.
- `CloudStatus.stoppedBy` (optional, one status after a stop):
  `"hand-off" | "taken-over"`, so the renderer can skip broadcast completion
  and say the right thing.

## Phases and slices

Order: W1 → W2 → W3 → W4 → W6 in the web server lane; W5 in parallel in
its own web worktree, merged into the server branch before the gates. C1 →
C2 → C3 → C4 in the desktop backend lane; C5 in parallel in its own desktop
worktree (renderer files and the TS contract only); C6 after both desktop
lanes merge. Then R1/R2, fixes, gates once, smokes once, PRs.

### Phase 1: web (`videorc-web`)

- **W1. Devices and `onAir`.** Device parse; create stores `onAir` and
  `feedDeviceId`; `onAir` in `state` (material for `rev`) and `current`;
  `POST …/hand-off`; `viewer=page` polls never stamp; `FIRST_HANDOFF_DESKTOP_VERSION`
  in `client-version.ts`; names scrubbed at end. *Done when* unit tests (the
  fake LiveKit kit) cover create with and without `device`, `rev` growth on
  each material change, hand-off by the on-air device and refusal for
  another, the version refusal, the scrub, and the page poll.
- **W2. `POST …/on-air`.** The table above, under the show lease: rotation
  (delete then create per orientation, same identity, `rotating` window,
  webhook ingress-id match), `pending`, the readiness checks, the camera
  token, the talk host token. Hold fallback gated on `onAir.source` (State
  and the reaper). *Done when* unit tests replay: computer A live → B
  prepare (rotation, `onAir` B, old ingress deleted, no hold fallback from
  the old ingress's `ingress_ended`) → B go; A live → phone prepare (no
  change) → phone go (metadata `d_…`, `onAir` phone) → A prepare (no
  rotation: the feed was A's; `onAir` stays the phone, `pending` A) → A go
  only after the feed is connected (409 before); B prepare after that
  rotates; talk host go returns the host token; every refusal code.
- **W3. The program page's solo source.** Metadata read, the switch, the
  hold and audio on the on-air source (Program page above). *Done when* the
  unit tests of the page modules cover parse and the switch state machine,
  and a new browser run on `livekit-server --dev`
  (`tests/browser/cloud-program/run-handoff-livekit.mjs`) publishes a
  coloured feed and a coloured fake camera and proves by pixels: feed →
  camera with no card frame; camera stops → card within 3 s; camera back →
  picture; metadata back to `feed` → feed with no card; garbage metadata →
  feed. Existing runs stay green.
- **W4. `broadcastId` on legs.** Parse, store, return, scrub. *Done when*
  unit tests cover it and a malformed id gives 400.
- **W5. The phone page** `/live/continue` (UI/Product Design lane). States:
  not live; not possible (node show, test show, old desktop: the 409 copy);
  ready (camera preview, flip, microphone level and mute, the show's state
  and who is on air, a sideways hint when the show is horizontal and the
  phone is upright); going on air; on air (On air from this phone, hold
  shown when it happens, Mute, Flip, **Leave** = hand-off, End stream with
  confirm); taken over ("Your show continues on {name}." with **Take it
  back**); ended. Wake lock while visible; on becoming visible again it
  re-acquires ended tracks and republishes; the note "Keep this page open.
  If you lock your phone, viewers see Be right back." Talk shows: "You'll
  join as the host. Your guests stay on." and the host token from `go`.
  Polls `state?viewer=page`; refreshes the camera token every 270 s;
  `DUPLICATE_IDENTITY` or `onAir` elsewhere = taken over. Entry: a
  **Continue on this phone** button on /live's status card while a managed
  show is open ("Continue in this browser" on a computer). *Done when* the
  view logic has unit tests (states, copy, name from user agent, retry of
  409 `cloud-source-not-ready` once a second for 10 s), and a headless
  Chrome run with the fake camera against the route handlers and
  `livekit-server --dev` reaches on air, then taken over.
- **W6. /live and docs.** /live's status card says "On air from {name}" or
  "Waiting for a device"; `docs/cloud.md` gains "Continuing on another
  device (plan 243)". *Done when* `pnpm typecheck`, `pnpm lint`, `pnpm
  format:check`, `pnpm test`, `pnpm build` and the four existing program
  browser runs plus the new one pass on the merged branch.

### Phase 2: desktop (`videorc`)

- **C1. Device identity and the new fields.** `cloud.deviceId` and the name
  (D11, dev overrides); `device` in the create; parse `onAir` (state,
  current) and `legs[].broadcastId`; `CloudStatus.onAir` (`thisDevice`
  computed, no ids) and `stoppedBy`, with Rust serde rules and the fixture
  blocks `statusOnAirElsewhere` and `statusWaiting` in
  `protocol-fixtures/high-risk-contracts.json` (the TS schema is C5's).
  Send `broadcastId` in the hand-over for YouTube legs. *Done when* Rust
  unit tests cover parse, the fixture round trip and the name sanitizer.
- **C2. Hand off.** `cloud.show.handOff`; a stop intent that never calls
  `end_current_show`, keeps the show remembered and resumable
  (`session_id: None`), finalizes the local recording as any Stop does, and
  sets `stoppedBy: hand-off`. Talk: clear overlays, disconnect the host room
  client without `close_room`. *Done when* `FakeWeb` tests prove: no `/end`,
  one `/hand-off`, the show resumable after, a POST failure still stops and
  reports, talk keeps the room open.
- **C3. Taken over.** The control loop: `onAir.deviceId` set and not this
  device while this computer feeds the show (or holds the host seat) → the
  same stop with `stoppedBy: taken-over`; feed-failure notices for that show
  are suppressed from then on. Talk: the host room's `DUPLICATE_IDENTITY`
  while (or within 3 s before) `onAir` names another device is taken over,
  not "Connection to the room lost." *Done when* `FakeWeb` tests cover solo
  and talk, and a race test (the feed fails first, `onAir` arrives second)
  ends as taken over without a failure toast.
- **C4. Continue here.** Discovery (D10, `cloud.show.check`); the solo
  resume runs `on-air prepare` (use its `ingest`), starts the session, then,
  when a browser was on air, waits for every feed `connected` (20 s) and
  calls `go` (retry 409 once a second, 20 s; on failure stop sending and
  stay resumable with `cloud-source-not-ready`); the talk resume calls
  `on-air go` (`host`) before joining. Reconnect candidates (D3) from the
  hydrated enabled targets, matched to a leg by platform and orientation (by
  label when several), sent under the leg's id, never a new id while
  resumed; `destination-changed` gets its own copy. YouTube chat takes
  `legs[].broadcastId` when this computer did not prepare the broadcast.
  *Done when* `FakeWeb` tests cover feed→feed, camera→feed (go only after
  connected), talk, a matching and a refused reconnect, the chat broadcast
  id, and discovery cadence.
- **C5. The desktop UI** (UI/Product Design lane, `videorc-design`).
  - End livestream dialog on a managed cloud show: **Continue on another
    device** beside Keep streaming and End livestream, one line saying what
    it does ("Viewers see Be right back until you continue on your phone or
    another computer.").
  - The quit question on a managed cloud show: **Quit and keep it live**.
  - The cloud notice (`cloud-resume-notice.tsx`, `cloud-show-view.ts`):
    waiting ("Your show is waiting for another device." + the countdown),
    on air elsewhere ("Your show is live from {name}."), and the actions
    **Continue here** and End livestream; a short pointer to
    videorc.com/live/continue for the phone.
  - The toast when taken over: "Your show continues on {name}." (a neutral
    toast; type colours the icon only).
  - Skip broadcast completion when `stoppedBy` is set (D7).
  - `KNOWN_CODES` and copy for `cloud-handoff-update`,
    `cloud-handoff-unsupported`, `cloud-source-not-ready`,
    `cloud-not-on-air`, `cloud-nothing-to-resume`.
  - The TS contract: `CloudStatus.onAir`, `stoppedBy`, the two RPCs,
    fixture tests.
  - No control beside Record or Go Live. Both themes.
  *Done when* renderer tests cover each notice state, the dialog and quit
  choices, the D7 skip, and the eager gzip stays under 487,000.
- **C6. Smokes.** `scripts/lib/fake-cloud-web-managed.mjs` speaks the new
  wire (on-air, hand-off, rotation as a new ingest path on the local sink,
  `broadcastId`, `viewer=page`). `smoke:cloud-solo-managed` gains: hand off
  (no `/end`, no YouTube `complete` on the fake YouTube, recording saved,
  show waiting); Continue here on the same computer; a fake phone takes over
  (the app stops within 3 s, no `/end`, the notice names it); computer B (a
  relaunch with a fresh profile and another `VIDEORC_CLOUD_DEVICE_ID`)
  finds the show, continues (rotation), reconnects a leg with a matching
  key, and is refused with a different one. `smoke:cloud-talk-show-managed`
  gains: a headless Chrome host takes the seat with `on-air go` (guests stay,
  the room stays open, the desktop says taken over), then the desktop
  continues. *Done when* both pass once at the end, with the leak scans.

### Phase 3: acceptance (the owner)

Deploy the web, release 0.29.0, then one real run: Mac live → hand off →
iPhone continues → Mac continues → a second computer continues → End.
Watch for the rotation (D6) on LiveKit Cloud: the egress must carry on and
the page must hold.

## Verification (once, at the end)

- Web: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`,
  `pnpm build`, `node tests/browser/cloud-program/run*.mjs` (five runs).
- Desktop: `cargo fmt --check --all`; `cargo clippy -p videorc-backend
  --all-targets -- -D warnings` and the release clippy; `cargo test -p
  videorc-backend` through the build slot; `pnpm typecheck`, `pnpm lint`,
  `pnpm format:check`, `pnpm --filter @videorc/desktop test`, `pnpm
  test:scripts`, `pnpm check:renderer-assets`, `pnpm build`.
- Smokes: `pnpm smoke:cloud-solo-managed`, `pnpm
  smoke:cloud-talk-show-managed`. `smoke:cloud-solo` (node path) only if
  C2–C4 touch a node-path branch.

## When things break

| What fails | Viewers see | The devices |
| --- | --- | --- |
| The on-air computer closes or sleeps | Be right back within 3 s, until the hold limit | Any device continues; a computer rotates the ingress |
| The phone locks or switches app | Be right back within 3 s | The page republishes when visible again |
| Two devices claim at once | The last `go` wins (the lease orders them) | The other sees taken over |
| The new device never sends (`go` refused) | The old source, or the card | The new device stays ready; the old one keeps going |
| A platform drops while a phone is on air | That platform stops | Reconnect from a computer, whose key must match |
| The egress dies while a phone is on air | The stream ends | The show ends (`egress-lost`); go live again |
| videorc.com is unreachable | Nothing | No hand-off or take-over until it returns; the computer's Stop still stops sending |

## STOP conditions

Stop and ask the owner when:

- a slice would store a stream key, or write a URL, a key, a device id or a
  device name to a log or an error report;
- the hand-off path would call `/end`, complete a YouTube broadcast or end
  an X broadcast;
- a change would put a control beside Record or Go Live;
- the eager gzip budget would pass 487,000;
- the web's lease, rotation or readiness rules cannot be met without a
  database transaction held across a LiveKit call (wire §9 forbids it).

## Out of scope

- A native phone app; an IRL-app address (Moblin, Larix) for the phone.
- Stage control, overlays, chat, comments or Sidekick on the phone page.
- Approval from the previous device; auto take-over.
- A blurred fill for mismatched pictures (D14).
- Node-path shows (`media = node`): refused.
- Solo cloud recording; one continuous local recording across devices.
- Carrying scenes or settings between computers.

## Only the owner can do

1. Merge the web PR and deploy it before the desktop PR.
2. Merge the desktop PR and release 0.29.0.
3. The acceptance run of Phase 3, with a real phone and a second computer.

## Handoff (cold start)

Read this plan, then `git log` on the branches
`plan-243-continue-on-another-device` (web and desktop) and the lane
branches `plan-243-phone-page` (web) and `plan-243-desktop-ui` (desktop).
Each lane commits per slice with the slice id in the subject. The
orchestrator merges the lanes, runs R1/R2, the gates and the smokes, and
opens the two PRs.
