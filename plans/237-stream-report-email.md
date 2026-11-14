# Plan 237: A stream report in your inbox after every stream

> **Executor instructions**: read `AGENTS.md`, the `videorc-design` skill and
> this whole plan first. Desktop work: your own worktree from `origin/main`.
> Web work: your own worktree of `~/projects/videorcweb` from `origin/main`;
> never read its `.env`. Write and commit every slice of a phase first, then
> run Rust tests, clippy and `pnpm build` once at the end (owner feedback
> "Gates at the end"). No test, smoke or dev run may send a real email: tests
> use a fake Resend, smokes use a fake web server. Do not ship YouTube
> numbers in the email before the owner answers D3.

**Drift check** (run before any slice; a non-empty diff means re-read the
"What exists" facts for the files that moved):

```sh
git -C ~/projects/videorc fetch -q origin && git -C ~/projects/videorc diff --stat 2ba6b232d origin/main -- \
  crates/videorc-backend/src/viewer_stats.rs crates/videorc-backend/src/usage_stats.rs \
  crates/videorc-backend/src/videorc_api.rs crates/videorc-backend/src/service_flags.rs \
  crates/videorc-backend/src/storage.rs crates/videorc-backend/src/protocol.rs \
  apps/desktop/src/shared/backend.ts apps/desktop/src/shared/backend-rpc-contract.ts \
  apps/desktop/src/renderer/src/lib/stream-manager-stats.ts \
  apps/desktop/src/renderer/src/components/streaming/go-live-panel.tsx \
  apps/desktop/src/renderer/src/components/streaming/watchdog-section.tsx
git -C ~/projects/videorcweb fetch -q origin && git -C ~/projects/videorcweb diff --stat acc7c54d origin/main -- \
  lib/email.ts db/schema.ts app/privacy/page.tsx app/api/desktop app/api/alerts
```

Plan 235 (a tidy Studio, uncommitted in `~/projects/videorc-wt-235`) moves
Studio and Go Live controls. If it lands first, re-pick the home of the one
new switch (D7) against its layout.

## Status

- **Status**: BUILT 2026-11-14 with the recommended answers (D1 free for
  every signed-in account, D2 on by default, D4 numbers only, D5 5 minutes,
  D6 3 days, D7 a section under Watchdog, D8 since the last stream, D9 no
  YouTube views, D10 `reports@videorc.com`). D3 ships its interim: the
  service flag `streamReport.youtube` is absent, so YouTube's numbers stay
  out until the owner decides. Desktop and web PRs; deploy the web first.
  - Differences from the plan, found while building: pending reports live in
    a SQLite table `stream_report_emails` (cascades with the session) instead
    of an `app_settings` queue; the switch is its own "After the stream"
    section under Watchdog on the Livestream page; while YouTube is left out,
    tips, supporters and the community counts go too, because they mix
    platforms; the web migration is `0036` (0034 and 0035 are taken on open
    branches) and a daily cron deletes send records older than 30 days.
  - Owed: the owner's by-eye pass on the email (Gmail web and phone, Apple
    Mail) and on the section in light and dark; a real stream with Send the
    last one after the web deploys.
- **Priority**: P2 (owner ask, 2026-11-14).
- **Effort**: M. Desktop: one pure summary builder, one sender task modelled
  on `usage_stats.rs`, one switch row. Web: one route, one preference, one
  unsubscribe route, one email template, privacy copy.
- **Risk**: LOW for the product, MEDIUM for privacy and YouTube terms.
  - Product: the sender is a background task after the stream. It never
    touches the recording or stream path, and a failure only means no email.
  - Privacy: for the first time, numbers about a stream leave the computer
    for videorc.com and an email provider. No chat text and no viewer names
    (D4). The privacy policy changes (B6).
  - YouTube: the v1 compliance reply told Google that session statistics
    stay on the user's computer (`docs/compliance/youtube-tos-report-v1-reply.md:63`).
    YouTube's counts in the email change that (D3).
- **Planned at**: desktop `origin/main` `2ba6b232d`, web `origin/main`
  `acc7c54d` (both fetched 2026-11-14).
- **Route**: Orchestrator (fit 10, `fable-5.1`): desktop, web and a
  compliance question.
  - Phase A (summary builder, Rust, pure): Implementation, fit 8,
    `gpt-6.1-sol`.
  - Phase B (web route, preference, unsubscribe): Implementation, fit 8,
    `gpt-6.1-sol`. B4 (the email's look and copy): UI/Product Design, fit 9,
    `opus-5.5`.
  - Phase C (desktop sender and switch): C1–C2 Implementation `gpt-6.1-sol`;
    C3 (the switch row) UI/Product Design `opus-5.5` with `videorc-design`.
  - Phase E: Orchestrator. D3 and the legal read are the owner's.

## The owner's ask

2026-11-14: "plan out report email after each stream that shows how many
people we had live, biggest concurrent number, from which platforms etc".

## What a streamer gets

One email a minute or so after each live stream ends, to the email of their
Videorc account:

> **Subject:** Your stream on Sat 14 Nov: 214 people watching at the peak
>
> **Building a Rust TUI, part 3**
> Sat 14 Nov, 19:02–20:44 · 1 h 42 min · YouTube, Twitch, Kick, X
>
> | 214 | 132 | 86 |
> | --- | --- | --- |
> | watching at the peak (47 min in) | watching on average | people chatted |
>
> *Watching over time* (a bar per two minutes, peak marked)
>
> | Platform | Peak | Average | Chatted | Messages | New followers |
> | --- | ---: | ---: | ---: | ---: | ---: |
> | YouTube | 120 | 74 | 41 | 512 | +12 subscribers |
> | Twitch | 68 | 41 | 30 | 388 | +9 |
> | Kick | 22 | 14 | 11 | 97 | +2 |
> | X | 9 | 3 | 4 | 12 | – |
>
> Each platform peaked at its own moment, so the platform peaks add up to
> more than 214. Facebook doesn't report viewers.
>
> **Support:** 4,500 bits · $35.00 in tips · 2 raids (largest 234)
>
> **Your community:** 12 regulars came back · 3 first-timers · 2 back after
> a while · Kim reached 10 streams *(counts only; from plan 225, when the
> community store is on)*
>
> **Since your last stream:** peak +23 % · average −4 % · 10 more people
> chatted
>
> Counts are what each platform reported, once a minute (YouTube every two
> minutes). "Watching" counts people watching at the same moment, not
> everyone who stopped by.
>
> [Stop these emails] · Turn them off in Videorc: Go Live → After the stream

## Words we use

| Word | Meaning |
| --- | --- |
| **Watching** | A platform's concurrent viewer count. The app already says "watching", never "viewers" or "subscribers" for this (`viewer_stats.rs:6-7`). |
| **Peak** | The highest combined count over the stream: the largest `total` of one saved sample. Per platform, that platform's largest count. |
| **Average** | The mean of the saved samples' totals, as the Stream Manager's history computes it (`stream-manager-stats.ts:183-187`). The email and the app must show the same number. |
| **Chatted** | Distinct chat accounts that sent a message or paid message (`session_chat_authors`). "People" only when plan 225 links say two accounts are one person. |
| **Stream report** | This email. Not Buddy's report (`CohostSessionReport`), which stays in the app. |

"How many people we had live" can only be answered honestly with
*watching at the peak*, *watching on average* and *people who chatted*. No
platform API Videorc uses gives a count of distinct viewers (Outside facts).
The copy never says "reached", "unique viewers" or "audience size".

## What exists (facts, desktop `origin/main` `2ba6b232d`)

### Viewer counts

- **Sampling.** While a live session runs, `run_viewer_sampler`
  (`viewer_stats.rs:626`) polls each connected platform's count: Twitch,
  Kick and X every 60 s (`VIEWER_SAMPLE_INTERVAL`, `:31`), YouTube every
  120 s by default (quota, plan 096). Facebook, TikTok, Instagram and Custom
  RTMP have no count.
- **One combined total.** `ViewerAggregator` (`:299`) keeps each platform's
  latest count and drops a count older than 150 s (`VIEWER_FRESHNESS`,
  `:36`). Every emitted `ViewerSample` (`:230`: `platforms[{platform,
  count}]`, `total`, `at`) sums the fresh platforms.
- **Saved with the session.** `record_provider_sample` (`:770`) writes each
  sample as JSON into `session_logs` with code `stream-viewers` (`:32`).
  `session_viewer_history` returns up to 1,440 samples, oldest first
  (`:39`); `sessions.viewers.list` serves them.
- **The app already shows peak and average** for a finished session: the
  Stream Manager's history mode (`stream-manager-stats.ts:176-200`) takes
  `Math.max` and the rounded mean of `sample.total`.
- **X.** The chip uses `total_watching`; `total_watched` is X's cumulative
  count and is ignored on purpose (`x_live.rs`, `X_CONCURRENT_VIEWER_KEYS`).

### Chat, followers, support

- **Chat totals** per session in SQLite, independent of kept rows:
  `SessionChatTotals` (`backend.ts:5188`): `messageCount`, `chatters`,
  `platforms`, `follows`, `supporters`, `bits`, `tips[]` (by currency),
  `raids`. RPC `sessions.comments.totals`. Legacy sessions answer
  `legacy-unavailable` and have no numbers.
- **Chatters per platform** are derivable: `session_chat_authors`
  (`storage.rs:8310`) keys each author as `<platform>:<author_id>`
  (`storage.rs:9417`) with a message count.
- **Followers and subscribers.** `AudienceSnapshot` / `PlatformAudience`
  (`backend.ts:9376`, `:9438`): per platform a `baseline`, `total` and
  `delta`, or a capability that says why not (`hidden`, `needs-reconnect`,
  `delta-only` for Kick). RPC `sessions.audience.get`.
- **Community** (plan 225, built): `CohostSessionReport.community`
  (`protocol.rs:6615`, `CohostReportCommunity` `:6650`) holds regulars back,
  first-timers, comebacks and milestones, computed when the chat session
  ends. Absent when the community store is off.

### Sending things to videorc.com

- **The pattern to copy** is `usage_stats.rs`: an observer reads
  `recording.status` and `stream.targets` from the event bus, a sender task
  owns a small queue persisted in `app_settings` (`usageStats.queue`, `:38`),
  retries with backoff, and `VIDEORC_USAGE_STATS=0` (`:41`) turns it off for
  a run. It never touches the recording path.
- **Account calls** go through `videorc_api.rs` with the stored Bearer
  session token. Packaged builds are pinned to `https://www.videorc.com`;
  dev builds default to `http://localhost:3000`. `post_alert_notify`
  (`:2069`, plan 223's phone push) is the closest existing call: best effort,
  8 s timeout, never holds anything up.
- **Service flags** (`service_flags.rs:31`, `GET /api/desktop/service-flags`)
  let the web switch desktop behaviour without a release. D3's interim
  switch rides here.

### The web (`origin/main` `acc7c54d`)

- **Resend** is wired: `lib/email.ts` has `getResend()`, `fromEmail`
  (`Videorc <orc@videorc.com>` default, `AUTH_FROM_EMAIL` in env), the
  dark-card HTML style every email uses, and `sendOwnerAlertEmail` with a
  Resend idempotency key.
- **Desktop routes** live under `app/api/desktop/*` and resolve the Bearer
  session with `getCurrentSession()` (e.g. `stream-events/route.ts`).
- **No email preference and no unsubscribe** exist yet. The privacy policy
  says "We send transactional email only: login links, password resets, and
  subscription confirmations, delivered via Resend" (`app/privacy/page.tsx`,
  "Emails").

### UI homes

- The Go Live panel renders the **Watchdog** section (`go-live-panel.tsx:187`;
  `watchdog-section.tsx:172`), which already holds "tell me about my stream
  when I'm not looking" rows: System notifications and **Phone** (`:231`).
- Settings → General → **Privacy** holds "Share anonymous usage stats"
  (`settings/usage-stats-field.tsx`).

## Outside facts (to re-check in slice A0 against the platforms' docs)

These come from the code and its comments, not from a fresh read of the
docs today:

- **No distinct-viewer count while live.** Twitch Helix `Get Streams` gives
  `viewer_count` (concurrent). Kick's channel API gives
  `stream.viewer_count` (concurrent). YouTube Data API `videos.list
  liveStreamingDetails.concurrentViewers` is concurrent and disappears when
  the stream ends. X gives `total_watching` (concurrent) and `total_watched`
  (cumulative watches, not people).
- **Distinct viewers on YouTube** exist only in the YouTube Analytics API,
  behind the `yt-analytics.readonly` scope. Videorc requests only
  `youtube.force-ssl`; a new scope means a new Google verification. Out of
  scope.
- **YouTube views after the stream**: `videos.list part=statistics` gives
  `viewCount` for the broadcast's video under the current scope, for 1 quota
  unit. It counts views, not people, and keeps growing with the replay
  (D9).
- **Gmail strips inline SVG** and blocks remote images until the reader
  allows them, so the chart is built from table cells (B4).
- **One-click unsubscribe** (RFC 8058): a `List-Unsubscribe` header with an
  https URL plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Gmail
  and Yahoo ask bulk senders for it; a GET on the link must not unsubscribe,
  because mail scanners open links.

## Decisions (⚑ = owner may override)

### D1. Who gets it ⚑

Every signed-in account, free. It costs a Resend email per stream, brings
people back to the app, and needs an account (the email goes to the
account's address). Premium adds nothing in v1. Alternative: Premium only,
like phone alerts (plan 223 D5).

### D2. On by default ⚑

On for every signed-in account, because a report nobody knows exists gets
no use (owner feedback "Features work with defaults"). Every email has a
one-click "Stop these emails" link, and the first one says where the switch
is. Alternative: off, with the switch offered once after the first stream.

### D3. YouTube's numbers through videorc.com ⚑ (blocks shipping YouTube)

The email cannot be sent from the user's computer, so the numbers pass
through videorc.com and Resend. The web never stores them: it renders, sends
and forgets. Resend keeps the sent email per its own retention.

- **Recommended:** include YouTube's counts, update the privacy policy and
  the compliance doc in the same release, and tell Google in the next
  compliance report (the v2 cloud draft is open). The v1 reply's "session
  statistics stay on the user's computer" becomes untrue for accounts with
  the email on.
- **Interim, until the owner answers:** a service flag `streamReportYouTube`
  (default false). While false, the desktop leaves YouTube's numbers out of
  the payload and the email says "YouTube's numbers are in Videorc", and the
  headline peak and average are labelled as covering the other platforms.
- **Also to settle with the legal read (H4 of plan 225 is the precedent):**
  whether showing YouTube's count inside a combined total is allowed. The
  Stream Manager already shows the same sum, and the email always shows the
  per-platform rows beside it.

### D4. No viewer names in the email ⚑

Numbers only: no chat text, no names, no avatars, no handles. Viewer names
would be personal data of third parties sent to a server and an email
provider, and YouTube display names are YouTube API data. The community
block (plan 225 D15) sends counts, not names. Alternative (later, Premium):
"Kim reached 10 streams" with first names.

### D5. Which sessions get an email ⚑

A session that went live to at least one platform and stayed live 5 minutes
or more. Recording-only sessions never get one. A stream with no count at
all (Custom RTMP only) still gets one with the duration, chat and support,
and says why there is no count.

### D6. Late sends ⚑

The sender waits 60 s after the stream ends (the last viewer poll, the
final chat totals and plan 225's community block settle), then sends. If
the app quits first, the queue survives and sends on the next launch,
within 3 days; the subject already carries the date. Older reports are
dropped. A sign-out empties the queue, so one account's report never goes
to another account.

### D7. One switch, next to Phone alerts ⚑

Go Live → Watchdog gets one row under Phone: **Email me a report after each
stream**, with the account's address as its description and a **Send the
last one** button (sends the most recent live session's report now; the
owner's way to see it without streaming). Signed out: the row says "Sign in
to get a report by email" with a Sign in button. One home: the preference
lives on the web account; this switch and the email's unsubscribe link both
write it. Alternative home: Settings → General, beside Privacy.

### D8. A comparison with the last stream

The desktop reads its own history (the last live session with samples) and
sends the change in peak, average and chatters. Computed on the computer;
nothing about earlier streams is sent except these three deltas.

### D9. YouTube views after the stream ⚑

Not in v1. A `viewCount` read at send time is a moving replay number, costs
quota, and would need D3 too. Later, as "YouTube: 1,203 views so far".

### D10. Sender ⚑

`Videorc <reports@videorc.com>`, reply-to `orc@videorc.com`. The domain is
already verified for Resend; the new local part needs no DNS change.
Alternative: reuse `fromEmail`.

## Wire shape

### Desktop → web: `POST /api/desktop/stream-report` (new, Bearer session)

```jsonc
{
  "version": 1,
  "reportId": "uuid",              // random per session report; idempotency key
  "startedAt": "2026-11-14T18:02:10Z",
  "endedAt": "2026-11-14T19:44:31Z",
  "timeZone": "Europe/Belgrade",   // IANA, for the dates in the email
  "title": "Building a Rust TUI, part 3",  // optional, ≤ 140 chars, the user's own
  "platforms": ["youtube", "twitch", "kick", "x", "facebook"],  // went live to
  "viewers": {                     // absent when no platform reported a count
    "peak": { "total": 214, "atSeconds": 2820 },
    "average": 132,
    "coverage": ["youtube", "twitch", "kick", "x"],   // platforms in the totals
    "byPlatform": [ { "platform": "youtube", "peak": 120, "average": 74 } ],
    "series": [12, 40, 88]         // ≤ 48 buckets, the max total per bucket
  },
  "chat": {                        // absent for legacy-unavailable
    "messages": 1009, "chatted": 86, "people": true,
    "byPlatform": [ { "platform": "youtube", "messages": 512, "chatted": 41 } ]
  },
  "audience": [ { "platform": "youtube", "metric": "subscribers", "delta": 12 } ],
  "support": { "bits": 4500, "tips": [ { "currency": "USD", "amountMicros": 35000000 } ],
               "supporters": 7, "raids": 2, "largestRaid": 234, "follows": 23 },
  "community": { "regularsBack": 12, "firstTimers": 3, "comebacks": 2, "milestones": 1 },
  "sinceLast": { "peakPct": 23, "averagePct": -4, "chattedDelta": 10 }
}
```

- Strict zod schema on the web: unknown keys refused, every count a
  non-negative integer under a sane cap, arrays bounded, body ≤ 16 KB.
- The desktop never sends an address. The web sends only to the signed-in
  account's own email, so the route cannot be used to mail anyone else.
- Answers: `200 {status:"sent"}`, `200 {status:"already-sent"}` (same
  `reportId`), `200 {status:"disabled"}` (preference off), `401` (no
  session: drop), `400 invalid-report` (drop, log once), `429
  report-rate-limited` (at most 10 an account in 24 h: drop), `5xx` (retry).
  A `404` means an older web: drop and stop trying for this run.

### Web: `GET` / `PUT /api/account/stream-report-email` (new, cookie or Bearer)

`{ enabled: boolean, email: string }`. No row means on (D2).

### Web: `GET` / `POST /api/email/stream-report/unsubscribe?t=<token>` (new, public)

`t` is an HMAC of the user id and `stream-report` under a server secret. GET
shows a page with one button; POST (the button, or the mail client's
one-click) turns the preference off and says how to turn it back on. A bad
token is a plain 400 page.

### Web storage (Neon, additive)

- `email_preferences (user_id pk → user, stream_reports boolean default
  true, updated_at)`.
- `stream_report_sends (user_id, report_id, sent_at, status)`, unique
  `(user_id, report_id)`: dedupe and the rate limit. **No numbers, no title.**
  A daily cleanup deletes rows older than 30 days (a new cron route, or a
  step in an existing cron if one fits; check `vercel.json` in B2).

## Phase A: the summary (desktop, Rust, pure)

**A0. Re-check the outside facts** above against the four platforms' docs
and YouTube's developer policies on derived and combined metrics. Write the
result into this plan's Outside facts with links. Done when every bullet
has a source or a correction.

**A1. `stream_report.rs`: build the summary.** A pure function from the
saved samples, `SessionChatTotals`, the `AudienceSnapshot`, an optional
`CohostReportCommunity` and the session times to `StreamReport` (the wire
shape). Peak, average and per-platform numbers use the same rules as
`stream-manager-stats.ts:176-200`, so the email and the Stream Manager
agree to the viewer. A platform's average is the mean of its counts over
the samples that carry it. Series: ≤ 48 buckets, max per bucket. A
`youtube_allowed: bool` input drops YouTube from every block (D3 interim)
and from `coverage`. Done when unit tests cover: no samples, one platform,
four platforms peaking at different times (combined peak < sum of peaks),
a platform that drops out mid-stream, YouTube excluded, a legacy chat
session, a 6-hour stream (series still ≤ 48).

**A2. Chatted per platform.** A storage query grouping
`session_chat_authors` by the platform prefix of `author_key`, and, when
plan 225's store links accounts, the count of distinct people (`people:
true`). Done when a test with two linked accounts counts one person and two
accounts.

**A3. Since the last stream (D8).** The most recent earlier live session
with at least one sample; deltas for peak, average and chatted. Absent when
there is none. Done when tested with zero, one and several earlier
sessions, including a recording-only one in between (skipped).

## Phase B: the web (videorcweb)

**B1. Contract.** `docs/stream-report-email.md` (the wire shape above, the
answers, what is never stored) and `lib/stream-report/schema.ts` (zod,
strict). Done when schema tests refuse unknown keys, negative and huge
counts, and a 17 KB body.

**B2. Preference.** Migration for `email_preferences`; `GET` / `PUT
/api/account/stream-report-email`. Done when route tests cover no row (on),
off, on again, and no session (401).

**B3. The send route.** `POST /api/desktop/stream-report`: session → 401;
preference off → `disabled`; schema → 400; dedupe row and 10-in-24-h limit;
`sendStreamReportEmail` with Resend idempotency key `stream-report/<reportId>`
and the `List-Unsubscribe` headers; the dedupe row records `sent` or the
Resend error name. Logs carry the user id and status only. Done when route
tests with a fake Resend cover every answer in the wire shape, and a test
asserts no number or title reaches the database.

**B4. The email (`opus-5.5`).** `lib/emails/stream-report.ts`: HTML and
plain text, the existing dark-card style of `lib/email.ts`, platform names
as text (no logos: the YouTube icon rules in the compliance reply make text
the safe choice), the chart as a row of table cells with heights, the
copy in "What a streamer gets". Escapes the title. Each block disappears
when its data is absent; nothing ever shows a zero nobody measured. The
"platform peaks add up to more" line shows only when they do. Done
when snapshot tests cover a full report, a Custom-RTMP-only report, a
YouTube-excluded report and a legacy-chat report, and the owner has seen it
in Gmail (web and phone) and Apple Mail, in light and dark mode.

**B5. Unsubscribe.** The token helper, the GET page (shadcn, one button)
and the POST. Done when tests cover a good token, a bad token, a repeat
POST, and that GET alone changes nothing.

**B6. Privacy.** `app/privacy/page.tsx`: "Emails" adds stream reports
(on by default, how to stop them); a new paragraph says which numbers the
app sends after a stream, that videorc.com does not keep them, and that
Resend delivers the email. Processors list unchanged (Resend is there).
Done when the owner has read the new words.

## Phase C: the desktop sender and the switch

**C1. The sender.** `stream_report_email.rs`, modelled on `usage_stats.rs`:
an observer that sees a live session end (D5 rules), waits 60 s, builds
the report (A1–A3), checks the account is signed in and the preference is
on (one `GET`), and posts it. A queue in `app_settings`
(`streamReport.queue`, at most 10, each bound to the account id at queue
time), retries with backoff, sends on next launch within 3 days (D6),
emptied on sign-out. `VIDEORC_STREAM_REPORT_EMAIL=0` turns it off for a run;
every smoke runner sets it. Reads `streamReportYouTube` from service flags
for D3. Done when tests against a mock web (axum, as in
`viewer_stats.rs` tests) cover: sent, already-sent, disabled, 401, 404,
429, a 5xx then success, a short stream (no send), a recording-only session
(no send), quit before send then relaunch, a 4-day-old queue item (dropped),
and sign-out.

**C2. RPCs.** `streamReport.settings.get` / `.set` (proxy the web
preference, cached for the panel) and `streamReport.sendLast` (D7's
button). Wire types in `backend.ts` and `backend-rpc-contract.ts` (new
fields go in the contract, or main retires its pump). Done when contract
fixtures cover all three.

**C3. The switch row (`opus-5.5`, `videorc-design`).** D7's row in the
Watchdog section, light and dark. Signed out, the row offers Sign in.
"Send the last one" shows Sending…, then Sent to <address>, or the web's
reason ("Turned off", "Too many today"). Done when a renderer test covers
signed out, on, off, sending, sent and an error, and the owner has seen it
in both themes.

## Phase E: docs, compliance, acceptance

- **E1.** `docs/stream-report-email.md` in the desktop repo: what is sent,
  when, the queue, the env switch, the service flag.
- **E2.** Update `docs/compliance/youtube-tos-report-v1-reply.md`'s
  successor (the v2 draft) per the owner's D3 answer.
- **E3.** Owner try-out: `pnpm dev` on an isolated profile with
  `VIDEORC_API_BASE_URL=https://www.videorc.com` (after the web deploys), a
  short test stream to one platform, the email read on phone and desktop.
- **E4.** Deploy order: web first (B1–B6), then the desktop release. An
  older web answers 404 and the desktop stays quiet.

## Verification gates

- Desktop, per slice: `cargo fmt --check --all`, one `cargo check`, and the
  TS gates (`pnpm typecheck`, `pnpm lint`, `pnpm format:check`).
- Desktop, once at the end: `cargo test -p videorc-backend stream_report`
  (targeted, owner directive), `cargo clippy -p videorc-backend -- -D
  warnings`, `pnpm --filter @videorc/desktop test`, `pnpm build`.
- Web: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.
- No recording-studio smoke is needed: nothing on the capture, preview or
  stream path changes. If C1 ends up touching `recording.rs`, run the
  record+stream smoke from `AGENTS.md`.

## STOP conditions

- A design that needs the web to store viewer numbers, titles or names.
- Any change to OAuth scopes (YouTube Analytics, new Twitch scopes).
- YouTube numbers in a shipped email before D3 is answered.
- The sender needing a lock or await on the recording, stream or chat
  delivery path.

## Out of scope (later)

- A weekly or monthly digest; a web page of past streams (it would need the
  web to keep numbers).
- Distinct viewers (YouTube Analytics scope), VOD and replay views (D9).
- Viewer names, top chatters, Buddy's sentences in the email (D4).
- Other recipients (a team, a manager), Discord or Slack posts.
- The Rust UI app (`videorc-rust` carries its own backend copy; port C1 there
  after it ships here).
- Cloud shows (plan 234): check whether the sampler runs for them before
  promising their numbers.

## Open questions for the owner

1. **D1**: free for every signed-in account (recommended), or Premium only?
2. **D2**: on by default with a one-click stop (recommended), or off until
   turned on?
3. **D3**: send YouTube's numbers through videorc.com and update the privacy
   policy and the Google compliance report (recommended), or keep YouTube
   out of the email?
4. **D4**: numbers only, no viewer names (recommended)?
5. **D5**: 5 minutes live as the minimum (recommended), or another floor?
6. **D7**: the switch beside Phone in Go Live → Watchdog (recommended), or
   Settings → General?

## Handoff (cold start)

Goal: one email after each live stream with peak and average watching,
people who chatted, and the per-platform breakdown. Route: Orchestrator,
`fable-5.1`; phases as in Status. Order: A0 → A1–A3 (desktop PR, draft) →
B1–B6 (web PR; deploy) → C1–C3 (same desktop PR) → E. Start with the drift
check, then A0. Owner answers for D1–D5 and D7 come before B3 and C3; D3
gates YouTube only.
