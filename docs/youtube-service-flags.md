# YouTube service flags and the quota incident playbook

Plan 094 (S7). Every Videorc install shares one Google Cloud project quota
for the YouTube Data API. The remote service flags let the owner throttle or
pause YouTube on **every updated client** by editing one JSON document, with
no desktop release. The desktop fails open: a missing, broken or unreachable
document changes nothing.

## The document

- URL: `https://www.videorc.com/api/desktop/service-flags` (the `www` host is
  load-bearing: the apex redirects, and the desktop treats any non-200 as
  "fail open"). Served by videorc-web
  ([PR #67](https://github.com/TheOrcDev/videorc-web/pull/67)), public,
  cacheable (`Cache-Control: max-age=300`), no auth, no PII.
- Shape:

  ```json
  {
    "version": 1,
    "youtube": {
      "chatTransport": "list",
      "minPollMs": 5000,
      "viewerSampleMs": 120000,
      "dailyBudgetUnits": 2500,
      "pausedUntil": "2026-10-03T07:00:00Z"
    }
  }
  ```

- Every key under `youtube` is optional: a missing key means the compiled
  default. Unknown keys (and other top-level sections) are ignored.
- `version` must be the integer `1`; anything else fails open.

| Key                | Type                                                                     | Compiled default | Clamp / rule                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatTransport`    | `"list"` \| `"off"` \| `"stream"` (exact lowercase)                      | `list`           | `off` parks the YouTube chat reader as **Waiting** ("YouTube chat is switched off by Videorc for now. Your stream keeps going."). `stream` is read as `list` and logged until S5 (real streamList) ships. Anything else: `list`, logged.            |
| `minPollMs`        | integer                                                                  | `5000`           | Floor 5,000. The chat reader never polls faster than this; the idle stretch (10 s after six empty pages) never goes below it.                                                                                                                       |
| `viewerSampleMs`   | integer                                                                  | `120000`          | Floor 30,000. YouTube viewer cadence only; Twitch, Kick and X remain at 60 seconds. Existing clients before Plan 096 may still apply this to the shared loop.                                                                                                                                                                              |
| `dailyBudgetUnits` | integer                                                                  | `2500`           | Clamped to 0..=10,000. `0` switches the per-install budget (S6) off. The 80% / 95% / 100% shedding steps follow the limit.                                                                                                                          |
| `pausedUntil`      | UTC RFC 3339 with seconds and `Z` (fractional allowed; offsets honoured) | none             | In the past: ignored. In the future: every YouTube call pauses until then with the same copy as a quota pause; the expiry probe (one `channels.list`) lifts it. Withdrawing the key lifts a pause this flag set; it never lifts a real quota pause. |

## What the desktop does

- Fetches at startup and every 30 minutes (`service_flags.rs`,
  `run_service_flags_refresher`), 8 s timeout, 64 KiB cap.
- Fails open to compiled defaults on a non-200, unreadable JSON,
  `version != 1`, or a network error, and says why in the backend log
  (`[service-flags] failing open to compiled defaults: …`).
- Logs the flags in effect to the backend log when they change
  (`YouTube service flags in effect (remote, fetched …): chat list, poll floor
5000 ms, viewers every 120000 ms, daily budget 2500 units, no remote pause`)
  and to every streaming session's log as code `youtube-service-flags` (JSON).
- A remote pause shows in the app exactly like a quota pause: the Livestream
  page YouTube row, the Stream Manager status bar and the Comments destination
  status read "paused until <local time>", Go Live offers the stream key, and
  chat, viewers and subscribers resume on their own when it lifts.
- Dev builds read the document from the local videorc-web
  (`http://localhost:3000`, or `VIDEORC_API_BASE_URL`); release builds are
  pinned to `https://www.videorc.com`.

## Incident playbook

Cloud Console → APIs & Services → YouTube Data API v3 has alerts at 50% and
80% of the daily quota (owner action S0). When one fires:

1. **Look before acting.** Metrics → filter by method for today's Pacific day.
   The chat reader (`liveChatMessages.list`) or sends
   (`liveChatMessages.insert`, 50 units each) are the usual suspects. Old
   0.9.125/0.9.126 clients still poll once a second until they update; they
   do not read flags.
2. **80% alert, hours left in the day:** lower the per-install budget and slow
   the extras for everyone:

   ```json
   {
     "version": 1,
     "youtube": { "dailyBudgetUnits": 1200, "viewerSampleMs": 120000, "minPollMs": 8000 }
   }
   ```

   Clients pick it up within 30 minutes (plus the 5-minute cache). Each
   install sheds subscribers and thumbnails at 80% of its budget, viewers at
   95%, and sends at 100%; chat read and Go Live keep working.

3. **Quota exhausted (every call answers 403 `quotaExceeded`):** clients
   already pause themselves until midnight Pacific (09:00 CEST) and resume on
   their own. Setting `pausedUntil` to the reset time stops the first failing
   call per client from being spent:

   ```json
   { "version": 1, "youtube": { "pausedUntil": "2026-10-03T07:00:00Z" } }
   ```

   Remove the key after the reset; clients that already lifted it are not
   affected.

4. **Chat is the drain and the budget is not enough:** `"chatTransport": "off"`
   parks every YouTube chat reader with a clear Waiting message. Viewers,
   subscribers, Go Live and Stop keep working. Put it back to `"list"` when
   the day resets.
5. **After the incident:** put the document back to `{ "version": 1 }` (or the
   values you want to keep), note the method breakdown and the time in the
   plan's S0 section, and check the next day's usage trends down.

Never set `minPollMs` below 5,000 or `viewerSampleMs` below 30,000 expecting
an effect: clients clamp them. Never rely on `"stream"` until S5 is shipped
and this doc says so.

## Testing

- Parse, clamp, fail-open and fetch: `cargo test -p videorc-backend service_flags`.
- Breaker and reader behaviour under the flags: `cargo test -p videorc-backend youtube_quota`
  and `cargo test -p videorc-backend youtube_chat`.
- The outage drill end to end: `pnpm smoke:youtube-quota` (plan 094, S4).


Plan 096 candidates use independent bounded provider work: a pending YouTube
request cannot delay other platforms, and Stop drops all sampler futures.
YouTube subscriber success reads use 300 seconds; hidden/error backoff is
unchanged. Skipped polls never refresh observation timestamps. At 80% of the
local soft allowance, YouTube viewer cadence is at least 120 seconds (not
another doubling); at 95% its viewer reads stop. The 2,500 allowance remains
per installation, with essential calls/chat reads allowed past it. It is not
a project-wide hard limit. Chat sends reserve all 50 estimated units atomically.

Streaming remains disabled until Plan 096's live protocol and billing evidence
passes. `streamList` has no assumed zero cost. Neither a successful mock nor a
quota increase application authorizes public activation or ingest reuse.
