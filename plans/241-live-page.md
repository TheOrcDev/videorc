# Plan 241: videorc.com/live says what your stream is doing

> **Executor instructions**: read `AGENTS.md`, the `videorc-design` skill
> (desktop rows) and this whole plan first. Web work: your own worktree of
> `~/projects/videorcweb` from `origin/main`, follow its
> `.agents/skills/shadcn` rules, never read its `.env`. Desktop work: your own
> worktree from `origin/main`. Write and commit every slice of a phase first,
> then run the gates once at the end (owner feedback "Gates at the end").
> Deploy the web before any desktop PR that talks to it. No test, smoke or dev
> run may post to the real videorc.com: tests use fakes, smokes keep
> `VIDEORC_LIVE_STATUS=0` (C4) the way they keep `VIDEORC_STREAM_REPORT_EMAIL=0`.

**Drift check** (run before any slice; a non-empty diff means re-read the
"What exists" facts for the files that moved):

```sh
git -C ~/projects/videorc fetch -q origin && git -C ~/projects/videorc diff --stat c179d81b5 origin/main -- \
  crates/videorc-backend/src/stream_report_email.rs crates/videorc-backend/src/stream_report.rs \
  crates/videorc-backend/src/watchdog/push.rs crates/videorc-backend/src/watchdog/alerts.rs \
  crates/videorc-backend/src/streaming.rs crates/videorc-backend/src/videorc_api.rs \
  apps/desktop/src/renderer/src/components/streaming/stream-report-email-section.tsx \
  scripts/lib/app-launcher.mjs
git -C ~/projects/videorcweb fetch -q origin && git -C ~/projects/videorcweb diff --stat 1703c4cc origin/main -- \
  app/live components/live lib/stream-report lib/cloud/shows.ts lib/cloud/media/state.ts \
  db/schema.ts app/privacy/page.tsx vercel.json
```

## Status

- **Status**: BUILT 2026-11-16 (owner: "execute the entire plan and push to
  main after each small commit"). The owner answered D1 to D9; D10 to D16
  shipped as the orchestrator's defaults (⚑), still open to override. Web
  commits went straight to videorc-web `main` and each Vercel deploy
  succeeded; desktop slices merged as PRs #1397 to #1404. Owed: the owner's
  acceptance (E3), by-eye of the After the stream row (#1404) in both themes,
  the legal read for D14, and sending the YouTube compliance update (E2).
  - Differences from the plan, found while building: `reason` has four
    values (`refused` dropped: the desktop can't tell it apart); the history
    switch lives in `email_preferences.stream_history` (migration 0039) and
    the live status table is 0038; the not-live page shows the history only
    when not live or quiet; After the stream also gained a "Your streams"
    row that opens videorc.com/live (D2's link). No `smoke:multistream` run:
    the launcher turns the sender off in every smoke, so it would prove
    nothing about this change (owner feedback "Proportionate
    verification").
- **Priority**: P2 (owner ask, 2026-11-16).
- **Effort**: M to L. Web: one live-status route and table, one history
  table, one maintenance pass, the rebuilt `/live`, one stream page. Desktop:
  one status sender modelled on `stream_report_email.rs`, one switch row, one
  call after YouTube Disconnect.
- **Risk**: LOW for the product, MEDIUM for privacy and YouTube terms.
  - Product: both desktop senders are background tasks. They never touch the
    recording or stream path; a failure only means a staler page.
  - Privacy: for the first time videorc.com _keeps_ numbers about a stream
    (90 days), and sees a direct stream while it runs. The privacy policy
    changes in the same deploy (A7).
  - YouTube: stored YouTube statistics fall under the YouTube API Services
    Developer Policies III.E.4 (Outside facts). D9 keeps them 30 days, and
    the next compliance report must say so (E2).
- **Planned at**: desktop `origin/main` `c179d81b5`, web `origin/main`
  `1703c4cc` (both fetched 2026-11-16).
- **Route**: Orchestrator (fit 10, `fable-5.1`): two repos, privacy and a
  YouTube policy question.
  - Web routes, tables, maintenance (A1, A2, A6, B1 to B4): Implementation,
    fit 8, `gpt-6.1-sol`.
  - The page's look and copy (A3 to A5, B5, B6): UI/Product Design, fit 9,
    `opus-5.5`.
  - Desktop sender (C1 to C4, D1, D3): Implementation, fit 8, `gpt-6.1-sol`.
    The switch row (D2): UI/Product Design, `opus-5.5` with `videorc-design`.
  - Phase E: Orchestrator. The legal read is the owner's.

## The owner's ask

2026-11-16: "https://www.videorc.com/live lets make this page richer, we are
not saying anything here just live or not live."

## What a streamer gets

**While live** (signed-in desktop, any stream, cloud or direct):

> ● **You're live** · 1:42:10 · Recording
> _Building a Rust TUI, part 3_
> On YouTube, Twitch and Kick · last update 6 s ago
>
> **Health**
> ⚠ Your microphone is muted · Muted for 0:42 on the livestream. · since 19:44
> _(or)_ Videorc sees no problems right now.
>
> **Platforms**
> YouTube · Live · since 19:02
> Twitch · Reconnecting · since 19:43 · "Connection lost, retrying"
> Kick · Live · since 19:02
>
> **Guests** _(cloud talk shows)_ Kim and Ana on stage · 1 waiting ·
> invite link [Copy]
> **Recording** _(cloud talk shows)_ Recording in the cloud · 1:40:02
>
> **Videorc Cloud** _(cloud shows)_ today's block: Be right back countdown,
> End stream
> **Cloud hours** and **Alerts on your phone** as today

**When the computer goes quiet** (no update for 45 s):

> **Your computer stopped reporting** · last heard 2 min ago
> If the Videorc app closed, your stream has likely stopped too.
> _(cloud show)_ Videorc Cloud is keeping your stream going. _(then the cloud
> block and the platforms the cloud knows)_

**When not live:**

> **You're not live** · Go live from the Videorc app and this page follows
> your stream.
>
> **Last stream** · Sat 14 Nov, 19:02 to 20:44 · 1 h 42 min
> _Building a Rust TUI, part 3_ · YouTube, Twitch, Kick
> 214 watching at the peak · 132 on average · 86 people chatted
> [See the full report]
>
> **History** _(Premium)_: one row per stream for 90 days: date, title,
> length, platforms, peak watching. Each row opens its stream page.
> _(Basic)_ Your stream history comes with Premium. 12 streams are saved.
>
> **Save my streams on videorc.com** [switch] · Delete history

**The stream page**, `/live/streams/<id>`: the stream report email's content
on the web (watching over time, the platform table, support, community, since
the last stream), with Delete this stream. The email gains a "See it on
videorc.com" link.

## Words we use

| Word                                 | Meaning                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Live status**                      | What the desktop tells the web while a stream runs: platforms, open watchdog alerts, recording on or off. Kept only while the stream runs. |
| **Stream history**                   | The saved stream reports, 90 days. Built from the plan 237 report, never from the live status.                                             |
| **Watching, Peak, Average, Chatted** | As plan 237 "Words we use". The page and the email show the same numbers.                                                                  |
| **Quiet**                            | A live status with no update for 45 s. The page never says "offline" or "crashed": it can't know.                                          |

## What exists (facts, desktop `c179d81b5`, web `1703c4cc`)

### The web page today

- `app/live/page.tsx`: `requireSession("/live")`, `loadLiveData` reads the
  open cloud show (`dbCloudStore.shows.findOpenByUser`), the plan, the
  month's cloud usage and the push devices. Test shows are left out
  (`isTestShow`). A failed read renders "Videorc Cloud isn't reachable".
  `robots: { index: false }`, `dynamic = "force-dynamic"`.
- `components/live/live-show-status.tsx`: `describeShow` maps the cloud
  show's status to one headline (Not live, Live, Be right back, Ending,
  Ended, Connecting), plus Started / Last update and Cloud hours. Its own
  comment: "destinations and chat never reach the web, so this page does not
  pretend to know them".
- `components/live/live-refresher.tsx`: `router.refresh()` every 10 s while
  visible, mounted only while a cloud show is open.
- `components/live/end-stream-button.tsx`: `window.confirm`, then
  `POST /api/cloud/shows/:id/end`.
- `components/live/phone-alerts*.tsx`: the plan 223 D1 panel (Premium).
- Nothing links to `/live` except the phone push (`lib/alerts/push.ts:374`).

### What the web already knows about a cloud show

- `cloud_shows` (0024, 0034): status, kind (`solo`, `talk`, `test`),
  `media` (`node` or `livekit`), `started_at`, `phase_since_at`,
  `last_seen_at`, `hold_max_seconds`.
- Managed shows (plan 234, `media = 'livekit'`): `cloud_show_media`
  (0035) and `buildManagedState` (`lib/cloud/media/state.ts`) give `legs`
  (platform, label, state, error from the closed `LEG_ERRORS` list, since),
  `hold`, `program` (silent, black, frozen seconds) and, for talk shows,
  `room` and `recording`.
- Talk shows: `cloud_rooms`, `cloud_invites`, `cloud_guest_requests` (0028:
  names, state `waiting`/`let-in`/…), `cloud_recordings` (0030).
- Node shows (`media = 'node'`) have no legs on the web: the runner keeps
  them.

### What the web knows about a direct stream

Nothing until it ends. `stream_events` (0022) is anonymous telemetry. The
stream report (`POST /api/desktop/stream-report`, plan 237) arrives a minute
after a live stream of 5 minutes or more and is rendered, emailed and
forgotten (`lib/stream-report/route.ts`). `email_preferences` (0036) holds
`stream_reports` (no row = on). The preference body is
`z.strictObject({ enabled: z.boolean() })` (`route.ts:240`). The answer's
`status` is `disabled`, `sending` or `already-sent`; the desktop's
`classify_post` reads it.

### The desktop

- `stream_report_email.rs`: `LiveTracker` (`:150-262`) follows
  `recording.status` and `stream.targets` from the event bus and knows when
  a live session starts and ends; `web_access` gives the signed-in base URL
  and token; `deliver` reads the preference and posts only when the email is
  on (`:677`). `VIDEORC_STREAM_REPORT_EMAIL=0` turns it off; smokes set it
  (`scripts/lib/app-launcher.mjs:210`).
- `stream_report.rs`: `StreamReport` v1 (the wire) and `report_title`
  (trimmed, 140 characters).
- `streaming.rs:440` `StreamTargetRuntime`: `target_id`, `platform`,
  `label`, `state` (`StreamTargetState` `:64`: connecting, live, warning,
  reconnecting, failed, …), `message`, `redacted_url`, uplink overflows. No
  "since".
- `watchdog/alerts.rs:170` `WatchdogAlert` and `watchdog/push.rs`
  `push_words`: the alert's title and body without chat text, with a
  host-shaped destination label replaced by the platform's name (L7). The
  phone push is the precedent for sending alert words to the web.
- `videorc_api.rs:2160` `post_alert_notify`: the Bearer POST pattern.
- `main.rs:13772`: YouTube Disconnect revokes the token
  (`oauth::revoke_youtube_token`).
- YouTube's watching count is read with the user's OAuth token
  (`viewer_stats.rs:409`, `videos.list part=liveStreamingDetails`): it is
  **Authorized Data** in YouTube's terms.
- `stream-report-email-section.tsx`: the "After the stream" section under
  Watchdog on the Livestream page.

## Outside facts (checked 2026-11-16)

YouTube API Services Developer Policies
([developer-policies](https://developers.google.com/youtube/terms/developer-policies)):

- **III.E.4.b**: authorized statistics (view counts and the like) have no
  fixed cap, but the client must "ensure every 30 days that it is still
  authorized by the user to access that data". Only the desktop holds the
  token, so the web can't do that check (D9).
- **III.E.4.c**: other Authorized Data: "for no longer than 30 calendar
  days", then delete or refresh.
- **III.E.4.g**: users must have a way to ask for deletion (a button);
  delete "as soon as possible and within 7 calendar days", and the option
  says it doesn't delete what YouTube keeps.
- **III.E.4.h**: no new metrics built from API Data; any non-YouTube figure
  shown beside API Data needs a clear note that it comes from the client
  (D14).
- **III.D.2.c**: a revocation through the client's own mechanism means
  deleting Authorized Data within 7 days (D9, D3 slice).
- Phone browsers throttle background tabs; the page only refreshes while
  visible (today's `LiveRefresher`).

## Decisions (⚑ = owner may override)

### D1. Every stream: DECIDED

Owner, 2026-11-16: the page shows every live stream, direct or cloud. While a
signed-in desktop streams, it sends a **live status** (Wire shape) every 15 s
and on every change. The web keeps one row per account and deletes it when
the stream ends.

### D2. The live view: DECIDED

Owner: platforms, stream health, guests and recording. **Not** viewers or
chat: the live status carries no viewer counts and no chat, which also keeps
YouTube's statistics out of it. Health is the desktop watchdog's open
alerts (plan 223), in the phone push's words.

### D3. Not live: DECIDED

Owner: the last stream's recap and a stream history. Cloud recordings stay on
`/account`; no "ready to go" checks.

### D4. Show only: DECIDED

Owner: End stream (cloud) stays the only stream control. Phone controls are
plan 184 Phase 3. The page adds only history buttons (delete).

### D5. History kept 90 days: DECIDED

A daily pass deletes rows 90 days after the stream ended. YouTube's part goes
sooner (D9).

### D6. Tiers: DECIDED, plus one default ⚑

Owner: the live view and the last stream's recap are free; the history list
is Premium. Default ⚑: the web saves every account's streams (when the
switch is on), shows Basic the latest only, and an upgrade shows the rest
right away ("12 streams are saved"). The latest stream's page is free; older
ones need Premium. Alternative: keep only the latest row for Basic.

### D7. Its own switch, on by default: DECIDED

"Save my streams on videorc.com". It lives in `email_preferences` as
`stream_history` (no row = on), shows on `/live` and in the app's After the
stream section. Email off with history on still saves; both off sends
nothing. A desktop older than D1 only posts when the email is on, so with
the email off it saves nothing until it updates.

### D8. A page per stream: DECIDED

`/live/streams/<id>`, the email's content on the web, owner-only (404 for
anyone else, `robots: noindex`). The email links to it when the stream was
saved.

### D9. YouTube's numbers for 30 days: DECIDED

Owner: other platforms keep 90 days; YouTube's numbers go after 30.

- **What goes on day 30** (`stripYouTube`, pure): YouTube's rows in
  `viewers.byPlatform`, `chat.byPlatform` and `audience`; every combined
  number that YouTube was part of: `viewers` peak, average, series,
  `peakAtSeconds`, `sinceLast`, chat `people`, and `support` and
  `community` (they don't split by platform). Chat `chatters` and `messages`
  become the sum of the rows left. The platform list keeps "YouTube": where
  you streamed is your own setting, not YouTube's data.
- The maintenance pass strips rows that ended 29 days ago or more (a daily
  pass, a day's slack). The page also strips on read, so a missed pass never
  shows old YouTube numbers.
- **Disconnect**: when YouTube Disconnect succeeds in the app, the desktop
  calls the web, which strips YouTube from every row of the account at once
  (III.D.2.c's 7 days).
- **Delete**: Delete this stream and Delete history remove rows at once, and
  the confirm says it doesn't delete anything YouTube or other platforms keep
  (III.E.4.g).
- The stream page says: "YouTube's numbers, and the totals they were part of,
  are removed after 30 days, as YouTube's rules ask."

### D10. The live status has no switch ⚑

On for every signed-in desktop while it streams. It holds no numbers, keeps
nothing after the stream, and only the account sees it (owner feedback
"Features work with defaults", "Simple actions, not Studio switches"). The
privacy page says so. Alternative: put it under the D7 switch.

### D11. Freshness ⚑

- The desktop sends every 15 s and on a change (a platform's state, an alert
  opening or clearing, recording on or off), never more often than every 3 s.
- The page refreshes every 10 s while visible, as today.
- No update for 45 s (three missed beats) is **quiet**. A row with no update
  for 10 minutes is dropped on read and by the daily pass.
- A newer `seq` for the same session wins; an older one is ignored.

### D12. Desktop and cloud together ⚑

- A fresh live status is the page's truth for platforms and health.
- An open cloud show adds the Videorc Cloud block (phase, Be right back
  countdown, End stream), as today.
- Quiet desktop with an open **managed** cloud show: the platforms come from
  `buildManagedState`'s legs and health from its `program` (silent, black,
  frozen) in the same words.
- Quiet desktop with a **node** show: the cloud block only; the page says
  the platform states come back with the computer.
- Talk shows: guests and recording always come from the web's own tables.

### D13. Which streams are saved ⚑

The same as the email (plan 237 D5): live sessions of 5 minutes or more.
Recording-only sessions never.

### D14. Combined numbers are labelled ⚑

Under every combined number: "Videorc adds up each platform's own count."
The page shows the platform rows next to it, like the email. This carries
plan 237's open legal question (combined totals with YouTube) to the web.

### D15. Where `/live` is found ⚑

The account menu and account nav gain "Live". The desktop's menu gains
nothing (owner feedback "No toolbar-corner buttons").

### D16. History rate cap ⚑

At most 30 saved streams per account per day, apart from the email's 10. A
stream past the email's limit is still saved.

## Wire shape

Change it here first, then in both repos. Every optional is
`skip_serializing_if` on the desktop (owner memory "serde null → contract
trap").

### Desktop → web: `PUT /api/desktop/live-status` (new, Bearer)

```json
{
  "version": 1,
  "sessionId": "b0f6…",
  "seq": 42,
  "startedAt": "2026-11-16T18:02:10Z",
  "title": "Building a Rust TUI, part 3",
  "recording": true,
  "cloud": false,
  "destinations": [
    { "platform": "youtube", "label": "YouTube", "state": "live", "since": "2026-11-16T18:02:14Z" },
    {
      "platform": "twitch",
      "label": "Twitch",
      "state": "reconnecting",
      "since": "2026-11-16T18:43:01Z",
      "reason": "reconnecting"
    }
  ],
  "alerts": [
    {
      "check": "mic-muted",
      "severity": "critical",
      "title": "Your microphone is muted",
      "body": "Muted for 0:42 on the livestream.",
      "since": "2026-11-16T18:44:02Z"
    }
  ],
  "app": { "version": "0.29.0", "os": "macos" }
}
```

- Strict schema, at most 8 KB. `title` passes `report_title` (140
  characters). `destinations` at most 16; `state` is `connecting`, `live`,
  `reconnecting`, `not-receiving` (the desktop's `warning`) or `failed`;
  `reason` is a closed list (`reconnecting`, `not-receiving`, `refused`,
  `connect`, `uplink`), never the desktop's free-text `message` (it may hold
  an address). `label` is the target's label unless it is host-shaped, then
  the platform's name (`push.rs` L7 rule). `since` is when the desktop saw
  that state begin.
- `alerts` at most 12: `push_words` titles and bodies, `severity`
  `critical` or `warning` (no notices, no `still-there`), the same refusals
  as `/api/alerts/notify` (no URL, no address, no chat text).
- Answers: `200 { ok: true }`; `200 { ok: true, ignored: "stale-seq" }`;
  `400`; `401`; `429` (more than 1 per second per account).
- The web stores the body (minus `version`) as one row and never logs it.

### `DELETE /api/desktop/live-status` (new, Bearer)

Body `{ sessionId }`. Deletes the account's row if it is that session.

### `POST /api/desktop/stream-report` (changed)

- After validation the web saves the report when `stream_history` is on
  (idempotent on account and `reportId`), whatever the email does, and
  answers `history: "saved" | "off" | "limit"` plus `historyId` next to
  today's `status`. `status` keeps its meaning, so today's desktop reads the
  answer as before.
- The email gains "See it on videorc.com" when `history` is `saved`.

### `GET` / `PUT /api/account/stream-report-email` (changed)

The answer gains `history: boolean`. The PUT takes
`{ enabled?: boolean, history?: boolean }` with at least one key; today's
desktop still sends `{ enabled }`.

### `POST /api/desktop/stream-history/youtube-revoked` (new, Bearer)

No body. Strips YouTube from every saved stream of the account (D9).
Answers `{ ok: true, stripped: <count> }`.

### Web storage (Neon, additive, migration 0038 or the next free number)

```sql
CREATE TABLE IF NOT EXISTS "live_status" (
  "user_id" text PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  "session_id" text NOT NULL,
  "seq" integer NOT NULL,
  "started_at" timestamptz NOT NULL,
  "status_json" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "live_status_updated_at_idx" ON "live_status" ("updated_at");

CREATE TABLE IF NOT EXISTS "stream_history" (
  "id" text PRIMARY KEY,                       -- st_ + 22 base62
  "user_id" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "report_id" text NOT NULL,
  "started_at" timestamptz NOT NULL,
  "ended_at" timestamptz NOT NULL,
  "title" text,
  "platforms" text[] NOT NULL DEFAULT '{}',
  "report_json" jsonb NOT NULL,                -- the validated v1 report
  "youtube_stripped_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "stream_history_user_report_idx" ON "stream_history" ("user_id", "report_id");
CREATE INDEX IF NOT EXISTS "stream_history_user_started_idx" ON "stream_history" ("user_id", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "stream_history_ended_idx" ON "stream_history" ("ended_at");

ALTER TABLE "email_preferences" ADD COLUMN IF NOT EXISTS "stream_history" boolean NOT NULL DEFAULT true;
```

## Phase A: the live view (web)

Deploys alone: with no desktop sending, it shows cloud shows as today, in
the new layout.

- **A1. Live status store and route.** Migration (above, `live_status`
  only); `lib/live-status/schema.ts` (strict zod, the closed lists);
  `lib/live-status/route.ts` with injected store, session and clock, like
  `lib/stream-report/route.ts`; `app/api/desktop/live-status/route.ts` (PUT,
  DELETE). Done when: tests cover a valid beat, an older `seq`, a refused
  URL in an alert body, a refused unknown key, 401, 429, DELETE of another
  session's id (no-op).
- **A2. `buildLiveView` (pure).** Inputs: the live status row, the open
  cloud show, its managed state, the talk room, `now`. Output: one view model
  with `mode` (`live`, `quiet`, `cloud-only`, `not-live`), headline, clock
  start, chips, platforms, health, guests, recording. D11 and D12 live
  here. Done when: fixture tests cover every row of D12, quiet at 45 s, drop
  at 10 min, a node show while quiet, a test show (never shown).
- **A3. The live layout.** Rebuild `app/live/page.tsx` around the view
  model: headline card (dot, "You're live", running clock, Recording and
  Cloud chips, title, "On YouTube, Twitch and Kick", last update), Health,
  Platforms, Guests and Recording (talk), the existing Videorc Cloud block
  and End stream, Cloud hours, Phone alerts. A small client clock ticks the
  running time each second. Keep `LiveRefresher`, mounted for every mode
  but `not-live`. shadcn only (`Badge`, `Card`/`AccountPanel`, `Item`-style
  rows). Done when: each mode renders from a fixture in light and dark at
  390 px and 1280 px.
- **A4. Guests and recording.** For an open talk show: who is on stage, how
  many wait, the invite link with Copy (the live slug only), and the
  recording's state and running time. Reads only (D4). Done when: fixture
  tests for no guests, two on stage and one waiting, recording off.
- **A5. Copy.** Every string in one `LIVE_COPY` object like
  `PHONE_ALERTS_COPY`, exact as "What a streamer gets" and the D9/D14
  notes. The words "offline", "crashed", "viewers" never appear.
- **A6. Cleanup.** The daily `/api/stream-report/maintenance` cron also
  deletes `live_status` rows older than a day.
- **A7. Privacy and nav.** Privacy page: a line for the live status (D10)
  next to the stream report line (`app/privacy/page.tsx:64`). "Live" in the
  account menu and nav (D15). `docs/live-status.md`: the wire, limits,
  retention.

## Phase B: stream history (web)

Deploys alone: today's desktops already post reports for accounts with the
email on, so history starts filling the day B ships.

- **B1. Storage and preference.** `stream_history` and the
  `email_preferences.stream_history` column; the preference GET/PUT
  change. Done when: tests for no row (on), `{ history: false }`,
  `{ enabled: true }` from today's desktop, an empty body (400).
- **B2. Save on report.** `handleStreamReport` saves when history is on,
  before and apart from the email; D16's cap; `history` and `historyId` in
  the answer; the email's link. Done when: tests for email off and history
  on (saved, no email), a duplicate `reportId` (one row), the email's limit
  reached (still saved), history off (nothing kept, as today).
- **B3. `stripYouTube` (pure) and the YouTube rules.** D9's rule; the
  maintenance pass strips rows ended 29 days ago or more and deletes rows
  ended 90 days ago or more; the read path strips too; the
  `youtube-revoked` route. Done when: tests on the plan 237 fixture report:
  every YouTube number gone, the others intact, chat sums right, a report
  without YouTube untouched, stripping twice changes nothing.
- **B4. Delete.** `DELETE /api/live/streams/:id` and
  `DELETE /api/live/streams` (cookie session, own rows only). Done when:
  tests for another account's id (404) and delete all.
- **B5. Not-live layout.** "You're not live", the last stream's recap
  card, the history list (Premium; Basic sees the locked panel with the
  saved count and "See Premium"), the switch and Delete history (shadcn
  `Switch`, `AlertDialog` for the confirm, not `window.confirm`). Done when:
  fixtures for no history, Basic with 12 saved, Premium with 30, switch
  off, a stripped stream, in both themes at 390 px and 1280 px.
- **B6. The stream page.** `/live/streams/[id]`: headline numbers,
  watching over time (`components/charts`), the platform table, support,
  community, since the last stream, the D9 and D14 notes, Delete this
  stream. Premium unless it is the latest. Done when: fixtures for a full
  report, a stripped one, a Basic account on an older stream (the locked
  panel), another account's id (404).
- **B7. Privacy and docs.** The stream report paragraph says what is now
  kept, for how long, and YouTube's 30 days; the YouTube API Services
  section's retention line; `docs/stream-report-email.md` and
  `docs/live-status.md`.

## Phase C: the desktop sends the live status

Needs Phase A deployed.

- **C1. `live_status.rs` (pure builder).** From the bus's latest
  `recording.status`, `stream.targets`, `watchdog.alerts` (the full list;
  open ones only) and `cloud.state` (only whether the show runs through
  the cloud): the wire body. Maps `warning` to
  `not-receiving`, the closed `reason` list, the L7 label rule, alert words
  through `push_words`, `since` from a per-target state clock. Done when:
  unit tests for each target state, a host-shaped custom label, a notice
  (left out), a free-text message (never sent), a 200-character title.
- **C2. The sender.** One task spawned like `stream_report_email::spawn`:
  follows the bus with the same `LiveTracker` rules, sends on change
  (debounced 3 s) and every 15 s, sends DELETE at the end, drops a beat it
  can't send (no queue: a stale beat is worthless), backs off on 429 and
  stops on 401 until the next session. Only while signed in. Done when:
  tests with a fake web for start, a change, the end, a sign-out mid-stream
  (stops), 401, 429.
- **C3. Contract fixture.** One JSON fixture round-trips the Rust struct and
  the web's zod schema (as the cloud contracts do).
- **C4. Off switch for runs.** `VIDEORC_LIVE_STATUS=0` turns it off;
  `scripts/lib/app-launcher.mjs` sets it to `0` like
  `VIDEORC_STREAM_REPORT_EMAIL`, with its test.

## Phase D: the desktop's history switch and YouTube

Needs Phase B deployed.

- **D1. Post when either is on.** The preference read carries `history`;
  `deliver` posts when `enabled || history`; `classify_post` reads the new
  fields and ignores them when absent (an older web).
- **D2. The switch row.** "Save my streams on videorc.com" under the email
  row in After the stream, description "Keeps each stream's numbers on
  videorc.com for 90 days (YouTube's for 30). Never chat messages or
  viewers' names." with a link to videorc.com/live. Same read and write path
  as the email switch. Done when: the section's test covers both switches
  and the error state; by eye in light and dark.
- **D3. YouTube Disconnect.** After `revoke_youtube_token` succeeds
  (`main.rs:13772`), post `youtube-revoked`. If it fails, keep a flag in
  `app_settings` and retry at the next launch while signed in into the same
  account. Done when: tests for success, failure then retry, a different
  account at relaunch (dropped).

## Phase E: docs, compliance, acceptance

- **E1.** `docs/` in both repos name the new routes and retention.
- **E2. YouTube compliance (owed).** The next report to Google (the v2
  draft, `docs/compliance/youtube-tos-report-v2-cloud-draft.md`) adds:
  YouTube statistics from the stream report are now kept on videorc.com for
  30 days when "Save my streams" is on, then removed; removed at once on
  Disconnect; deletable by the user at any time; combined totals are
  labelled as Videorc's sums.
- **E3. Owner acceptance.** A real direct stream to two platforms: `/live`
  on a phone shows Live, the platforms, then a muted-mic alert within 20 s
  of muting; quit the app and the page goes quiet within a minute; after
  the stream the recap and the stream page match the email. Then a cloud
  talk show with a guest. By eye in both themes (owner feedback "Check both
  themes").

## Verification gates

- Web: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`,
  `pnpm build` (runs the migration check).
- Desktop: `cargo fmt --check --all`, targeted
  `cargo test -p videorc-backend live_status stream_report` and clippy
  (owner memory "Skip Rust suite"), `pnpm typecheck`, `pnpm lint`,
  `pnpm --filter @videorc/desktop test` (the section's test),
  `pnpm test:scripts` (the launcher env).
- No heavy smokes: nothing here touches recording, capture or the native
  preview (owner feedback "Proportionate verification"). One
  `pnpm smoke:multistream` run with `VIDEORC_LIVE_STATUS=0` proves the
  sender stays out of the way.

## When things break

| What breaks                           | What the streamer sees                                    | Recovery                                 |
| ------------------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| The desktop can't reach videorc.com   | The page goes quiet after 45 s                            | Beats resume when it can; nothing queued |
| The web is down                       | Nothing in the app; the stream is untouched               | —                                        |
| A beat arrives after the end's DELETE | An older `seq` or a deleted session is ignored            | —                                        |
| The daily pass fails                  | The read path still strips YouTube and hides expired rows | The next pass catches up                 |
| The `youtube-revoked` call fails      | YouTube numbers stay up to the next launch                | D3's retry; day 30 at the latest         |
| An older desktop, email off           | No history saved                                          | Update the app                           |

## STOP conditions

- The legal read says combined totals with YouTube can't be shown (D14):
  stop B5 and B6 and ask whether to show per-platform rows only.
- A live status field would need chat text, a viewer name, a key or a URL.
- Any slice would change the recording or stream path.
- The migration number clashes with an open branch: take the next free one
  and say so in Progress.

## Out of scope (later)

- Phone controls, camera takeover, chat, Drive mode (plan 184 Phase 3).
- Viewer counts and chat counts while live (not chosen in D2).
- Cloud recordings on `/live` (they stay on `/account`).
- Ready-to-go checks (app version, cloud on, alerts on).
- Trends across the history (charts of peak over 90 days).
- A public, shareable stream page.

## Open questions for the owner

1. D6: save Basic accounts' full history (shown after upgrade) or only the
   latest stream?
2. D10: the live status without a switch, or under "Save my streams"?
3. D14: who does the legal read on combined totals with YouTube, and before
   B6 ships or after?

## Handoff (cold start)

- Goal: `/live` shows any live stream (platforms, health, guests,
  recording) and, when not live, the last stream and a 90-day history with a
  page per stream.
- Current state: nothing built. This plan; desktop `c179d81b5`, web
  `1703c4cc`.
- Owner route and model: Orchestrator, fit 10, `fable-5.1`; slices as in
  Status.
- Order: A (web) → deploy → C (desktop); B (web) → deploy → D (desktop).
  A and B can run in parallel worktrees; C and D are one desktop PR or two.
- Out of scope: as above.
- Verify: as in Verification gates; E3 is the owner's.
- Blockers: web deploy before desktop PRs; the legal read for D14.

## Progress

| Slice                                             | State                     | Where                                                                 |
| ------------------------------------------------- | ------------------------- | --------------------------------------------------------------------- |
| Plan                                              | Done 2026-11-16           | #1396                                                                 |
| A1 live status route and table (and A6's cleanup) | Done                      | web `028081b5`                                                        |
| A2 `buildLiveView`                                | Done                      | web `828d7a33`                                                        |
| A3, A5 live layout and copy                       | Done                      | web `80f9ff2d`                                                        |
| A4 guests and recording                           | Done                      | web `9445e0f7`                                                        |
| A7 privacy (live status) and the Live link        | Done                      | web `6eacc769`                                                        |
| B1 history storage and the switch's preference    | Done                      | web `e0989c12`                                                        |
| B2 save on report, privacy (history)              | Done                      | web `eb35a1ce`                                                        |
| B3, B4 YouTube 30 days, Disconnect, delete routes | Done                      | web `0d575bdf`                                                        |
| B5, B6 not-live page, stream page, email link     | Done                      | web `c1eedc39`                                                        |
| A7, B7 docs                                       | Done                      | web `1a7e150a` (`docs/live-status.md`, `docs/stream-report-email.md`) |
| C1 builder and shared fixture (C3)                | Done                      | #1397                                                                 |
| C2 sender                                         | Done                      | #1398, retry fix #1403                                                |
| C4 smoke launcher off switch                      | Done                      | #1400                                                                 |
| D1 history preference, post when either is on     | Done                      | #1401                                                                 |
| D2 Save my streams row                            | Done; by-eye owed         | #1404                                                                 |
| D3 YouTube Disconnect strips the history          | Done                      | #1402                                                                 |
| E1 docs                                           | Done                      | web docs above                                                        |
| E2 YouTube compliance draft                       | Written, not sent (owner) | this PR                                                               |
| E3 owner acceptance                               | Owed                      |                                                                       |

Gates: web `tsc`, eslint, prettier and the full suite (2192 passed) on every
commit; desktop `cargo fmt`, `cargo check --all-targets` per slice, then
`cargo test -p videorc-backend live_status stream_report_email watchdog::push`
(31 passed) and `cargo clippy -p videorc-backend --all-targets -- -D warnings`
(clean), `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test:scripts` and the desktop tests. Production after the deploys:
`/live` and `/live/streams/<id>` send a signed-out visitor to sign in;
`PUT /api/desktop/live-status`, `DELETE /api/live/streams` and
`POST /api/desktop/stream-history/youtube-revoked` answer 401 without a
session; the privacy page carries the Live status and Stream history
paragraphs.
