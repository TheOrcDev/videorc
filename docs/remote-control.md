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
  events. No tokens, file paths, or URLs cross the remote socket.
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

| kind | fields | effect |
| --- | --- | --- |
| `recordStart` / `recordStop` / `recordToggle` | — | recording session |
| `streamStart` / `streamStop` | — | streaming session (needs streaming configured) |
| `micMute` / `micUnmute` / `micToggle` | — | microphone mute |
| `sceneApply` | `layoutPreset` | switch layout preset |
| `takeoverShow` | `assetId` | show a takeover image (BRB etc.) |
| `takeoverHide` | — | hide the takeover |
| `windowFront` | `window`: `notes`\|`comments`\|`preview` | bring window forward |

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

`pnpm smoke:remote-control` (part of `smoke:local-gates`) drives the real
app: discovery-file contract (0600, port/token match), allowlist enforcement,
filter-lock enforcement, micToggle + sceneApply round trips against
backend-confirmed state, debounce, and regenerate-cuts-clients.
