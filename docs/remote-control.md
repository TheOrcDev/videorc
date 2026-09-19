# Remote Control

Videorc exposes a local, token-gated remote-control surface (issue #143) so a
Stream Deck — or any local integration (Companion, Loupedeck, scripts) — can
start/stop sessions, switch scenes, mute the mic, show takeovers, and bring
windows forward. **Off by default**; enable it in Settings → Remote control.

Two integration tiers:

1. **Global shortcuts (no protocol):** Settings → Global shortcuts registers
   OS-wide accelerators for record/stream/mic. Bind them to any macro tool or
   a Stream Deck Hotkey action. Works while Videorc is in the background.
2. **The remote protocol below** — richer: scenes, takeovers, windows, and
   live state for key rendering. The official plugin lives in
   `apps/streamdeck-plugin`.

## Pairing (same machine)

When Remote Control is enabled, the backend writes a discovery file next to
its database (macOS: `~/Library/Application Support/Videorc/remote-control.json`),
mode `0600`, deleted on disable and at shutdown:

```json
{ "host": "127.0.0.1", "port": 54321, "token": "…", "protocol": 1 }
```

Connect a WebSocket to `ws://<host>:<port>/ws?token=<token>`. The token is
rotatable from Settings; **regenerating closes every paired client**.

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

## Requests

`{"id":"…","method":"remote.describe"}` → `{ describe, state, protocol }`
where `describe` lists `layoutPresets`, `takeovers` (`{id, name}`), and
`windows`.

`{"id":"…","method":"remote.intent","params":{…}}` → `{ intentId, accepted,
message? }`. Accepted intents produce a `remote.ack` event
(`{intentId, ok, message?}`) after the renderer executes them.

Intent params (`kind` + fields):

| kind                                          | fields                                   | effect                                                                            |
| --------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| `recordStart` / `recordStop` / `recordToggle` | —                                        | recording session                                                                 |
| `streamStart` / `streamStop`                  | —                                        | streaming session (needs streaming configured)                                    |
| `micMute` / `micUnmute` / `micToggle`         | —                                        | microphone mute                                                                   |
| `sceneApply`                                  | `layoutPreset`                           | switch layout preset                                                              |
| `takeoverShow`                                | `assetId`                                | show a takeover image (BRB etc.)                                                  |
| `takeoverHide`                                | —                                        | hide the takeover                                                                 |
| `windowFront`                                 | `window`: `notes`\|`comments`\|`preview` | bring window forward                                                              |
| `commentHighlight`                            | `messageId`                              | put that live-chat comment on stream (explicit show, idempotent — never a toggle) |
| `commentHighlightClear`                       | —                                        | take the on-stream comment down                                                   |

## Events

- `remote.state` — the full projection on every change:
  `{ sessionState, sessionActive, recordEnabled, streamEnabled, micMuted,
layoutPreset, activeTakeoverId, windows }`. Render keys from THIS, not
  from optimistic intent.
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
every chat message, tap one to put it on stream, switch scenes, show takeovers,
mute the mic, start/stop. **Off by default**; Settings → Phone remote. Turning
it on also turns Remote control on; turning Remote control off closes it.

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
