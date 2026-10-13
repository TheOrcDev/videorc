# Anonymous usage stats

Videorc sends one small event to videorc.com when a recording or livestream
starts and one when it stops, so we can count how many installs actually
stream each week, signed in or not. It is on by default. Settings → General →
Privacy → "Share anonymous usage stats" turns it off.

## What is sent

`POST https://www.videorc.com/api/desktop/stream-events`, JSON:

| Field               | Value                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| `eventId`           | A new UUID per event, so a retried event is stored once.              |
| `installId`         | A random UUID made on first launch (`app_settings` `usageStats.installId`). |
| `event`             | `stream_start` or `stream_stop`.                                      |
| `mode`              | `live` (any destination; it may also record) or `recording` (file only). |
| `appVersion`        | The desktop version (`VIDEORC_APP_VERSION`).                          |
| `os`                | `macos`, `windows` or `linux`.                                        |
| `destinationsCount` | How many destinations the session started with.                       |
| `platforms`         | Their kinds, each once: `youtube`, `twitch`, `kick`, `x`, `tiktok`, `instagram`, `custom`. |
| `durationSeconds`   | On `stream_stop` only.                                                |

Never stream keys, URLs, titles, chat, channel names or recording content.
A signed-in desktop adds `Authorization: Bearer <session token>` and the web
fills `user_id` from it; the desktop never names a user id. The web
contract, table and weekly query live in videorc-web
`docs/stream-telemetry.md`; the privacy policy describes it to users.

## How it works

`crates/videorc-backend/src/usage_stats.rs`. It never touches the recording
path:

- An observer task reads the event bus. A running `recording.status` opens
  a session (a recording-only one is sent at once); a live one waits up to
  15 s for its `stream.targets`; the terminal status (idle or failed) sends
  the stop. A refused start never reached running and is never counted, and
  a performance check's benchmark sessions are skipped like the WebSocket
  relay skips them.
- A sender task keeps undelivered events in `app_settings`
  (`usageStats.queue`): at most 50, none older than 7 days. It sends 30 s
  after launch and right after each new event, and backs off from 30 s to
  30 min (or the web's `Retry-After`) on 408, 429, 5xx or no answer. Any
  other 4xx drops the event.
- `usageStats.get` / `usageStats.set` back the Settings switch. Off is
  saved, stops new events and empties the queue before `set` answers. A
  session started while it was off is never shared, not even its stop.

## Turning it off for a run

`VIDEORC_USAGE_STATS=0` forces sharing off for that launch, whatever the
setting says, and the Settings switch shows it locked. Nothing turns it on.
`smokeAppEnv` (`scripts/lib/app-launcher.mjs`) sets it for every smoke
unless the run sets it itself, and the live lab sets it in its launch env:
each of those runs is a fresh profile, so it would count as a new install.

Debug builds post to `VIDEORC_API_BASE_URL` (default `http://localhost:3000`),
so a local videorc-web receives the events while you test.
