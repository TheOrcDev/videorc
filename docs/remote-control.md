# Remote Control

Videorc exposes a local, token-gated remote-control surface (issue #143) so a
Stream Deck — or any local integration (Companion, Loupedeck, scripts) — can
start/stop sessions, switch scenes, mute the mic, show takeovers and banners,
and bring windows forward. **Off by default**; enable it in Settings → Remote → Remote control.

Two integration tiers:

1. **Global shortcuts (no protocol):** Settings → Shortcuts → Global shortcuts registers
   OS-wide accelerators for record/stream/mic/system audio. Bind them to any
   macro tool or a Stream Deck Hotkey action. Works while Videorc is in the
   background. While live, a stop needs a second press within 2 s ("Press
   again to end the livestream", plan 174 D2).
2. **The remote protocol below** — richer: scenes, takeovers, banners, windows,
   and live state for key rendering. The official plugin lives in
   `apps/streamdeck-plugin`.

**AI agents** (Claude, Cursor, Codex and other MCP apps on this computer)
use a separate door, Videorc MCP: Settings → Remote → Agents, its own
loopback listener, role, per-agent tokens and tool catalog
([`docs/agents-mcp.md`](agents-mcp.md), plan 209). It reuses the same Studio
action executor as the intents below, so a tool and a key run the same
handler, but it changes nothing here: the remote and Phone remote
allowlists, `RemoteIntent`, `LAN_EVENTS` and the Stream Deck's Go Live
behaviour are exactly as this page describes (D19).

## Pairing (same machine)

When Remote Control is enabled, the backend writes a discovery file next to
its database (macOS: `~/Library/Application Support/Videorc/remote-control.json`),
mode `0600`, deleted on disable and at shutdown:

```json
{ "host": "127.0.0.1", "port": 54321, "token": "…", "protocol": 1 }
```

Connect a WebSocket to `ws://<host>:<port>/ws?token=<token>`. Settings →
Remote → Remote control → Regenerate rotates the token after a confirmation
("Regenerate the pairing token?"); **regenerating closes every paired
client**. Turning Remote control off asks first too, because it closes
Phone remote and every Stream Deck with it.

## Security model

- The remote token maps to a dedicated backend role whose method admission is
  a hard allowlist: `remote.describe` and `remote.intent`. Everything else
  answers `forbidden-method` — including the event-filter mutation commands,
  so a remote socket can only ever receive `remote.state` and `remote.ack`
  events. No tokens, file paths, or URLs cross the remote socket — including
  `backend.ready`, which carries the renderer credential and is never sent to
  a remote socket.
- Intents are validated and debounced (150ms per intent family) by the
  backend, then RELAYED to the renderer, which executes them through the
  same code paths as the on-screen buttons — validation and confirmation
  logic included. There is no way to start a session the UI would refuse.
  The three banner intents are one family of their own, so a banner key
  never swallows the takeover key beside it.
- A banner intent names its banner by id. One the list no longer has acks
  `ok: false` with "That banner isn't available anymore."; a refusal acks
  the desktop's own sentence ("Four banners are showing. Hide one first.");
  any other failure "Couldn't show the banner.", "Couldn't hide the banner."
  or "Couldn't hide the banners.".
- The two sound intents (plan 189) are a family of their own too, debounced
  at 80 ms instead of 150 ms so a fast drummer still gets every press, and
  per sound: two different sound keys pressed together both play, while one
  key bouncing is refused (`soundStop` with a `soundId` shares that sound's
  window; stop-all has its own). One
  whose sound is gone acks "That sound isn't available anymore."; a refusal
  acks the desktop's sentence; any other failure "Couldn't play the sound.",
  "Couldn't stop the sound." or "Couldn't stop the sounds.". The renderer
  runs sound intents in order among themselves but never behind another kind
  of intent (a slow scene switch can't hold an airhorn back); a sound intent
  that still waited over a second acks "That sound was pressed too long ago,
  so it didn't play." instead of playing late.

## Requests

`{"id":"…","method":"remote.describe"}` → `{ describe, state, protocol }`
where `describe` lists `layoutPresets`, `layoutLabels` (each preset id's
name as the desktop shows it, `{ "screen-camera": "Screen + camera" }`,
since plan 174 S2.3a; absent from older apps), `takeovers` (`{id, name}`),
`banners` (`{id, name, shown}` in Assets order, since plan 186; absent from
older apps), `sounds` (`{id, name, playing}` in board order, since plan 189;
absent from older apps), and `windows`.

`describe` changes too: a banner shown or hidden flips its `shown` there, and
a sound starting or ending flips its `playing`, not in `remote.state`. Every change the desktop publishes arrives as a
`remote.state` event, so a client that renders banners re-reads
`remote.describe` after each one (one read at a time). The official Stream
Deck plugin and the phone page both do.

`{"id":"…","method":"remote.intent","params":{…}}` → `{ intentId, accepted,
message? }`. Accepted intents produce a `remote.ack` event
(`{intentId, ok, message?}`) after the renderer executes them.

Intent params (`kind` + fields):

| kind                                                     | fields                                   | effect                                                                                                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordStart` / `recordStop` / `recordToggle`            | —                                        | start or stop recording (see [Starting and stopping](#starting-and-stopping))                                                                                                           |
| `streamStart` / `streamStop`                             | —                                        | go live or end the livestream; `streamStart` needs a ready destination                                                                                                                  |
| `micMute` / `micUnmute` / `micToggle`                    | —                                        | microphone mute                                                                                                                                                                         |
| `systemAudioOn` / `systemAudioOff` / `systemAudioToggle` | —                                        | system audio on/off (plan 069); refused while the device cannot run                                                                                                                     |
| `sceneApply`                                             | `sceneId?`, `screenId?`, `layoutPreset?` | switch saved scene by id, or a built-in layout (at least one target required; `sceneId` takes precedence)                                                                               |
| `takeoverShow`                                           | `assetId`                                | show a takeover image (BRB etc.)                                                                                                                                                        |
| `takeoverHide`                                           | —                                        | hide the takeover                                                                                                                                                                       |
| `bannerShow`                                             | `bannerId`                               | show that banner (plan 186; explicit, idempotent)                                                                                                                                       |
| `bannerHide`                                             | `bannerId?`                              | hide that banner; without `bannerId`, hide every banner                                                                                                                                 |
| `bannerToggle`                                           | `bannerId`                               | show or hide that banner, from its `shown` in `describe` (for one deck key)                                                                                                             |
| `soundPlay`                                              | `soundId`                                | press that sound (plan 189): the sound's own mode decides, like its key in Studio                                                                                                       |
| `soundStop`                                              | `soundId?`                               | stop that sound; without `soundId`, stop every sound                                                                                                                                    |
| `windowFront`                                            | `window`: `notes`\|`comments`\|`preview` | bring window forward (`comments` is the Stream Manager)                                                                                                                                 |
| `commentHighlight`                                       | `messageId`                              | put that live-chat comment on stream (explicit show, idempotent — never a toggle)                                                                                                       |
| `commentHighlightClear`                                  | —                                        | take the on-stream comment down                                                                                                                                                         |
| `clipMark`                                               | `seconds?`: `30`\|`60`                   | save a clip: the last 30 seconds (no `seconds`) or the last minute (`60`) whenever the ring holds frames, and a mark while recording; any other length is refused (plans 068, 181, 199) |

### Starting and stopping

Plan 174 S3.1 made every start explicit. `recordStart` records and
`streamStart` goes live, whatever output mode the Studio saved last, and both
run the Studio's own starts, so a remote can never start what the Studio
would refuse. The failed ack carries the reason, so a deck key can say why.

- `recordStart` refused: the Studio's reason ("Pick a screen or a camera
  first."), or "You're already recording or live." while one runs.
- `streamStart` needs a ready destination. Without one the ack is
  `ok: false` with the Studio's reason ("Set up a destination to go live.").
  With one it opens the Go Live dialog on the computer, where the streamer
  confirms; the ack is `ok: false` with "The livestream didn't start. Finish
  going live on your computer." Go Live records too only when Output's
  recording is on (D19).
- `recordStop` and `streamStop` stop the running recording or livestream at
  once. Unlike an in-app stop, there is no End livestream confirmation: a
  Stream Deck key and the phone's hold-to-stop are deliberate device actions
  (plan 174 D2). `recordToggle` stops whatever runs.

## Events

- `remote.state` — the full projection on every change:
  `{ sessionState, sessionActive, recordEnabled, streamEnabled, micMuted,
layoutPreset, activeTakeoverId, windows, systemAudioOn, systemAudioAvailable, savedScenes, activeSavedSceneId }`.
  Render keys from THIS, not from optimistic intent. `systemAudioOn` is what
  the session mixes (the request while idle, or until the session reports
  it) and is always `false` while `systemAudioAvailable` is `false`. An app
  that predates plan 069 omits both.
- `remote.ack` — `{ intentId, ok, message? }` after the renderer executed
  (or refused) an accepted intent.

Renderer/admin sockets (never remote sockets — their event filter is locked
to the two events above) additionally receive `remote.control.status` —
`{ enabled, token, port, connectedClients, discoveryPath }` — on every
enable/disable/regenerate and on each remote client connect/disconnect, so
UI surfaces track the remote-control state without polling.

## Gates

`pnpm smoke:record-latency` pairs a fake client the same way and drives real
`recordStart` / `recordStop` intents through the renderer to measure Record
button latency; `pnpm smoke:record-latency:gate` enforces the calibrated OBS-parity
budgets (`docs/acceptance/2026-09-16-record-latency-calibration.md`).

`pnpm smoke:remote-control` (part of `smoke:local-gates`) drives the real
app: discovery-file contract (0600, port/token match), allowlist enforcement,
filter-lock enforcement, micToggle + sceneApply round trips against
backend-confirmed state, debounce, and regenerate-cuts-clients.

---

# Protocol 2 — Phone remote (LAN)

A phone on the same Wi-Fi as a **live comment monitor + Stream Deck**: read
every chat message, tap one to put it on stream, switch scenes, show takeovers
and banners, mute the mic, start/stop. **Off by default**; Settings → Remote → Phone remote. Turning
it on also turns Remote control on; turning Remote control off closes it (the
confirmation names how many paired phones it disconnects).

The backend serves its own client at `http://<lan-ip>:<port>/` — a static page
(`crates/videorc-backend/remote_web/`). `remote-client.js` in that folder is
the **reference client**: zero dependencies, runs in a browser and in node, and
is what the smoke and the unit tests drive. A native mobile app is a port of
that one file; everything it needs is specified here.

Protocol 1 (loopback, discovery file, token in the URL) is unchanged.

## Listener

- A **separate listener and a separate router** on `0.0.0.0:7420` (falls back
  through 7421–7429; the chosen port is persisted so bookmarks survive
  restarts; all busy ⇒ an explicit error in Settings, never a random port).
  It exists only while Phone remote is enabled.
- It serves the page assets and `/ws`, nothing else. The main backend router
  (preview frames, session posters, compositor status, OAuth callback) stays on
  `127.0.0.1` and is structurally unreachable here.
- `Host` must be an IPv4 literal (DNS-rebinding guard → `421`). A websocket
  `Origin`, when present, must equal the listener's own origin (→ `403`).
  Native clients send no `Origin`.
- Every response: strict CSP (`default-src 'self'`, no third-party requests,
  `frame-ancestors 'none'`), `Cache-Control: no-store`, `nosniff`,
  `Referrer-Policy: no-referrer`.
- Renderer and admin tokens **do not authenticate** on this listener; its
  handler never consults them. Every LAN socket is `BackendRole::Remote`.
- Limits: 5 s to authenticate, 1 KB pre-auth frame, 16 KB frames, 8 sockets,
  16 paired devices, 5 credential failures per minute per address (→ `429`).

## Why not TLS

A self-signed certificate is unusable for a page on a phone: iOS Safari refuses
`wss://` to an untrusted cert outright, and both platforms put a full-screen
warning in front of the page. So the transport is plain HTTP/WS (the same
trade OBS WebSocket makes) and the security is in the application layer:

- **No secret ever crosses the wire.** The QR code carries a single-use,
  5-minute pairing ticket in the URL _fragment_, which browsers never send.
  Both sides _derive_ the long-lived device key from it.
- **Mutual challenge-response** on every connection.
- **Every client frame is MAC'd** with a strictly increasing sequence number:
  a passive sniffer learns nothing reusable; an on-path attacker cannot inject
  or replay an intent. Any frame that fails verification closes the socket.

**Residual risk (accepted for the web page only):** an _active_ attacker on the
user's own LAN could tamper with the page's JavaScript while it is being
served. A native app does not have this hole (its code is not delivered over
the network), and a pinned-TLS upgrade stays possible — the QR can carry a
certificate fingerprint.

Browsers treat `http://` LAN origins as insecure contexts, so `crypto.subtle`
and `navigator.wakeLock` do not exist there. The page ships a pure-JS
HMAC-SHA256 (`hmac.js`, vector-tested against `node:crypto`).

## Pairing URL

```
http://<lan-ip>:<port>/#p=<pairingId>.<pairingSecret>      from the QR code
http://<lan-ip>:<port>/#d=<deviceId>.<deviceKey>           after pairing
```

Secrets and keys are 32 bytes, **base64url without padding**. After pairing the
page rewrites its own URL to the `#d=` form (and stores it in `localStorage`):
the origin is an IP address, so if DHCP moves the computer the storage is gone
but a bookmark or home-screen icon still carries the credential. If the address
changed, scan a new code.

## Handshake

`MAC(key, a, b, c)` = `HMAC-SHA256(key, a + "\n" + b + "\n" + c)`, base64url.

```
S→C  {"t":"hello","protocol":2,"serverNonce":"<b64url 32B>"}

C→S  {"t":"pair","pairingId":"…","clientNonce":"<b64url 32B>","deviceName":"iPhone · Safari",
      "mac": MAC(pairingSecret, "pair", serverNonce, clientNonce)}          first time
C→S  {"t":"auth","deviceId":"…","clientNonce":"…",
      "mac": MAC(deviceKey, "auth", serverNonce, clientNonce)}              afterwards

S→C  {"t":"ready","protocol":2,"deviceId":"…","deviceName":"…",
      "mac": MAC(deviceKey, "ready", clientNonce, serverNonce)}
S→C  {"t":"error","code":"…","message":"…"}   then close
```

- `deviceKey  = HMAC(pairingSecret, "device\n"  + serverNonce + "\n" + clientNonce)` (pair path; raw 32 bytes)
- `sessionKey = HMAC(deviceKey,     "session\n" + serverNonce + "\n" + clientNonce)`
- The client **must verify `ready.mac`** before trusting anything — it proves
  the desktop holds the key too.
- The ticket is consumed only by a successful `pair`; a forged attempt cannot
  burn the owner's code. One live ticket at a time.
- Error codes: `malformed`, `rate-limited`, `unknown-device`, `bad-mac`,
  `pairing-expired`, `too-many-devices`. The last four are permanent for those
  credentials — stop reconnecting and ask for a new scan.

## Signed frames (client → server)

```
{"seq": n, "mac": MAC(sessionKey, "frame", String(n), body), "body": "<JSON string>"}
```

`seq` starts at 1 and strictly increases per connection (gaps are fine).
`body` is the ordinary `{"id","method","params"}` command **as a string**; the
MAC covers that exact string, so there is no JSON canonicalisation to get
wrong. Server → client frames are unsigned in v1: a spoofed comment cannot
reach the stream because `commentHighlight` targets are looked up by id in the
desktop's own store.

## Methods

The Remote allowlist: `remote.describe`, `remote.intent` (both as in protocol
1, including the two comment intents above) and:

`remote.chat.snapshot` → `{ chatSeq, messages: RemoteChatMessage[≤200], highlight }`

### System audio on the phone (plan 069 leak argument)

The phone gets a System audio key only while `systemAudioAvailable` is true.
What crosses the LAN socket is two booleans in `remote.state`
(`systemAudioOn`, `systemAudioAvailable`) and what a paired phone can do is
send `systemAudioOn` / `systemAudioOff` / `systemAudioToggle`. No audio,
level, device id or name, permission detail, or app list ever reaches a
remote socket: the renderer builds the projection from the device status and
the confirmed mix, and `LAN_EVENTS` and the router are unchanged. The worst a
paired device can do is what it could already do with the mic: switch the
computer's sound into, or out of, the recording and the stream. Turning it on
is the privacy-relevant direction, so it runs through the same renderer path
as the Studio switch, and the Studio shows the change.

### Layout names on the phone (plan 174 S2.3a leak argument)

The phone names its scene keys the way the desktop does ("Screen + camera",
"Vertical split") instead of title-casing preset ids ("Side By Side"). What
crosses the LAN socket is one more field in the existing `remote.describe`
answer: `layoutLabels`, a map from the built-in layout preset ids already
listed in `layoutPresets` to their fixed English names from
`lib/layout-labels.ts`. The names are compiled into the app, the same for
every user: no scene a streamer named, no device, path, account, token or
setting. No route, method or event is added, `LAN_EVENTS` and the router are
unchanged, and the backend stores `describe` as an opaque value as before. A
paired phone learns nothing it could not already derive from the ids, and
can do nothing new.

### Banners on the phone (plan 186 leak argument)

The phone lists the streamer's banners by name under Controls → Banners, and
each key shows or hides one. What crosses the LAN socket is one more field
in the existing `remote.describe` answer, `banners: [{id, name, shown}]`,
and what a paired phone can do is send `bannerShow`, `bannerHide` or
`bannerToggle` through the existing `remote.intent`:

- Ids are opaque UUIDs.
- Names are labels the streamer typed for graphics they show viewers.
- No file paths and no image bytes cross the LAN. The phone shows names
  only: the renderer whitelists the three fields when it builds `describe`.
- No route is added to the LAN router and nothing is added to `LAN_EVENTS`.
  The intents ride the existing `remote.intent` and `remote.describe`.

The worst a paired device can do is what the Studio's Show and Hide do:
put one of the streamer's own banners on the picture, or take it off. A
show past the four-at-once cap is refused with the desktop's sentence.

### Sounds on the phone (plan 189 leak argument)

The phone lists the soundboard's sounds by name under Controls → Sounds;
each key presses one, and "Stop all sounds" stops them. What crosses the LAN
socket is one more field in `remote.describe`, `sounds: [{id, name,
playing}]`, and what a paired phone can do is send `soundPlay` or
`soundStop` through the existing `remote.intent`:

- Ids are opaque UUIDs.
- Names are labels the streamer typed for sounds they play to viewers.
- No file paths and no audio bytes cross the LAN.
- No route is added to the LAN router and nothing is added to `LAN_EVENTS`.

The worst a paired device can do is what a pad in Studio does: play one of
the streamer's own sounds into the stream, or stop it. A While held sound
pressed from a remote plays to its end: `describe` carries no mode, so a
remote has no release to send.

The phone's other words now match the desktop too, with no protocol change:
the tabs read Chat and Controls, the header reads ON AIR while a livestream
runs, the on-stream badge reads "On stream", the clear key reads "Take off
stream", and the stop key reads "End livestream".

## Events (LAN sockets only)

Loopback protocol-1 sockets keep their original two-event filter.

| event                        | payload                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `remote.state`, `remote.ack` | as protocol 1                                                                                              |
| `remote.chat.message`        | `{ chatSeq, message }` — also how deletions arrive (`isDeleted: true`, same `id`)                          |
| `remote.chat.reset`          | `{ chatSeq, messages }` — session swap or local clear; replace the list                                    |
| `remote.highlight`           | `{ messageId?, phase: "idle"\|"live"\|"failed", expiresAt?, reason? }` — render "on stream" from THIS only |

`chatSeq` increases by one per chat event. A gap means events were dropped
(slow link): call `remote.chat.snapshot` and replace the list. Chat is
projected only while at least one phone is connected.

`RemoteChatMessage` is built by **whitelist**: `id`, `platform`, `authorName`,
`authorBadges`, `authorRoles`, `publishedAt`, `messageText`, `eventType`,
`amountText?`, `isDeleted`, `fragments[{type,text}]`. Author ids, avatar URLs,
target/session ids, provider ids, and every URL are excluded by construction.
Chat text is attacker-controlled — render it as text, never as markup.

## Desktop RPCs (renderer/admin only)

`remote.lan.status | enable | disable`, `remote.lan.pairing.begin {address?}` →
`{ url, address, addresses, expiresAt }`, `remote.lan.pairing.cancel`,
`remote.lan.devices.revoke {id}`, `remote.lan.devices.rename {id,name}`.
Pushed: `remote.lan.status` `{ enabled, port?, addresses, devices[{id,name,
createdAt,lastSeenAt?,connected}], bindError?, pairingExpiresAt? }` (never any
key material) and `remote.lan.paired {deviceId, deviceName}` (the renderer
toasts it — a new device on the control surface is never silent).

Revoking a device closes that device's sockets only. `addresses` are private
IPv4 addresses on physical interfaces; VPN tunnels, bridges and virtual
adapters are excluded so the QR never encodes an address a phone cannot reach.

## Known limits

- Same network only. Guest/office Wi-Fi with client isolation cannot work.
- macOS with the firewall on asks once to allow incoming connections for the
  backend; Windows Defender asks on first bind.
- No wake lock on an `http://` page — disable auto-lock on the phone while
  streaming. (A native app solves this.)
- IPv4 only; no mDNS discovery; no sending chat from the phone.

## Gates

`pnpm smoke:remote-lan` (part of `smoke:local-gates`) drives the real app and
the reference client **over the machine's LAN address**: stable port + master
switch, page CSP and router isolation (main-router paths 404, the loopback port
is not reachable on the LAN address), backend tokens refused, pairing and
single-use ticket, re-auth, a signed intent against confirmed state, chat
snapshot, highlight refusal, the allowlist, no `backend.ready` on any remote
socket, revoke-cuts-one-device, and disable-closes-the-port. It skips with an
explicit reason on a machine with no LAN interface.

Unit coverage: `cargo test -p videorc-backend remote_` (handshake, replay,
limiter, projection leak test, router isolation over a real socket) and
`scripts/lib/remote-lan-client.test.mjs` in `pnpm test:scripts` (pure-JS HMAC
vs `node:crypto`, and the client against an independent node-crypto desktop).

### Saved scene names on the phone (plan 210)

`remote.state` includes `savedScenes: { id, name }[]` in library order and
`activeSavedSceneId: string | null`. Only opaque ids and typed display names
cross the socket; scene sources, app identities, paths, window titles and
scene snapshots stay on the desktop. Takeover names are the precedent: typed
names already reach a paired phone. Names may contain personal text the owner
chose, so paired phones can now read those scene labels. A paired device can
apply a saved scene through `sceneApply { sceneId }` (non-empty, at most 128
characters), with the same orientation and app-availability refusals as Studio.
No new route, method or event is added; `LAN_EVENTS` and the router are unchanged.
