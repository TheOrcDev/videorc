# Plan 094: YouTube that keeps working for streamers

**Status:** EXECUTING 2026-10-02 on `fix/094-youtube-quota` (one PR, one
commit per slice): S1-S4, S6 and the desktop half of S7 are built; S5 and S8
are **BLOCKED** on live probes against YouTube with a real token (the
project's quota is exhausted until 09:00 CEST 2026-10-03); S0 is owner-only
and open; the wave-1 hotfix release and acceptance A1-A4 are owed. Details
under "Execution notes" at the end. **Priority:** P0. Every Videorc user shares
one Google Cloud project quota. One long stream can switch off YouTube chat,
viewer counts, subscriber counts, chat send, YouTube connect and Go Live prep
for **every** user until midnight Pacific. **Size:** L. Nine slices in three
waves, plus owner actions. **Planned against:** `origin/main` `b4bb692e`.
The shared checkout is on `feat/windows-owner-waiver` @ `15206746`
(2026-09-21), far behind main. Work in a fresh worktree off `origin/main` and
take every line number below from main. **Owner route:** Diagnose →
Implementation (fit 9). It is release critical, multi-system and depends on
an external API. **Model lanes:** S1-S6 `fable-5`; S7-S8 `gpt-5.5`; S9 `gpt-5.5`;
the hotfix release uses the `videorc-release` skill.

---

## What "working properly" means: the streamer contract

Every slice serves one of these guarantees, and the final acceptance checks
each one.

| #   | Guarantee                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **The stream never depends on the API.** Once live, video and audio keep going whatever the YouTube API does. Recording and the other platforms are never blocked by YouTube.                                                                     |
| G2  | **Chat stays live for the whole stream.** A 4-hour stream reads YouTube chat with about 5 s latency or better, using ≤ 300 recurring units per 2 hours (target table below).                                                                      |
| G3  | **Outages are calm and explained.** If the API is unavailable, the streamer sees **one** specific notice, never a storm, raw error text or endless "reconnecting". The notice says what is paused, until when (local time), and what still works. |
| G4  | **Recovery is automatic.** When the quota resets, chat, viewers and subscribers resume by themselves, even mid-stream, with no click.                                                                                                             |
| G5  | **There is always a way to go live.** If YouTube's API is out at Go Live, Videorc offers the stream-key path for YouTube instead of a dead end.                                                                                                   |
| G6  | **No single install can drain everyone.** Each install has a daily budget and sheds low-value calls first.                                                                                                                                        |
| G7  | **The owner can act without a release.** Usage is visible, there is an alert before it runs out, and a remote switch can throttle every updated client.                                                                                           |

---

## Evidence

### Symptom (owner live stream 2026-10-02)

Multistream to YouTube, Twitch, Kick and X:

- About 36 minutes in, YouTube chat stopped. The status said "YouTube
  reconnecting" until the stream ended, while the other three kept working.
- At Stop: toast **"Could not complete YouTube on YouTube."**, with Google's
  raw JSON and escaped HTML as the description, ending in
  `"domain": "youtube.quota", "reason": "quotaExceeded"`.
- The same day, another user's screen recording showed the YouTube **connect**
  flow: the same red toast "OAuth callback failed." with the raw quota HTML,
  re-appearing every few seconds and stacking three high (details under
  "Second bugs", item 7).

### Timeline (local DB + backend.log, session `05942cb5`, UTC)

| Time        | Event                                                                       |
| ----------- | --------------------------------------------------------------------------- |
| 12:55:12    | Prepare done (insert broadcast + stream + bind = 150 units)                 |
| 12:55:15    | Thumbnail uploaded (50)                                                     |
| 12:55:24    | `transition live` done (50)                                                 |
| 13:31:11    | **Last YouTube chat message received**                                      |
| ~13:31:30   | Last good `videos.list` (viewer count gone from 13:32:50)                   |
| 13:33:24    | Subscriber task says "Reconnect YouTube" (wrong: it was a quota 403)        |
| 13:36-13:40 | Three sends fail with "rate-limited or exhausted quota"                     |
| 13:41:12    | Stop; `transition complete` fails 403 quotaExceeded, and the toast is shown |

Chat publish-to-receive lag was a steady 1.4-2.4 s, which means about one
request per second (the 1 s floor).

### Root cause

**Proven:** the project's daily YouTube Data API quota ran out at about 13:31
UTC (06:31 PDT). Every later YouTube call returned 403 `quotaExceeded`.

**Strongly suspected:** the chat reader burned it.

- `crates/videorc-backend/src/youtube_chat.rs` asks for
  `liveChat/messages/stream` (streamList), but reads the response with
  `response.json()` (`:758-762`). A server-streaming body can't be read that
  way.
- Any error permanently demotes the reader to `list` (`:1005-1008`). The
  header (`:9-13`) says real streaming was "deferred past V1".
- `list` polls at `max(pollingIntervalMillis, 1000 ms)` (`:31-37`,
  `:627-630`). That is about 3,000-3,600 calls/hour per streamer.
- Everything else is under 5% of that.
- The reader has been live in shipped builds since 0.9.125 (2026-10-01,
  `7abac23a` turned YouTube sign-in on). **0.9.125 and 0.9.126 in the field
  keep polling once a second until users update.**

**Unproven:** what a `list` call actually costs.

- Google's cost table (checked 2026-10-02) says 1 unit. At 1 unit the owner
  used about 2,200 units in 36 minutes, so other users spent the rest.
- At 5 units the owner alone explains all 10,000.
- S0 settles this from Cloud Console. The fix is the same either way.

**Why it got worse:** `classify_status` (`:646-667`) treats `quotaExceeded`
as "too fast" (RateLimited). The reader backs off to 30 s and retries
forever, showing "reconnecting" until midnight Pacific. The viewer sampler
(`viewer_stats.rs`, every 30 s, no 403 backoff) keeps calling too, and
rejected calls still cost quota.

### Quota budget today, one YouTube OAuth destination, 2-hour stream

| Call                                  | Cadence                                       | Calls/h     | Units  | 2 h                   |
| ------------------------------------- | --------------------------------------------- | ----------- | ------ | --------------------- |
| `liveChatMessages.list` (chat read)   | ~1 s (floor)                                  | 3,000-3,600 | 1 (5?) | 6,000-7,200 (30-36k?) |
| `videos.list` (viewer count)          | 30 s                                          | 120         | 1      | 240                   |
| `channels.list` (subscribers)         | 120 s                                         | 30          | 1      | 60                    |
| `liveChatMessages.insert` (each send) | per send                                      | n           | 50     | 50n                   |
| Go Live + stop, one-time              | prepare 150, thumb 50, transitions 100, polls | —           | —      | ~310-370              |

That is 66-79% of the whole project's daily quota for **one** streamer at 1
unit per call.

### Second bugs found on the same path

1. **A failed `complete` blocks the next start, even a recording.**
   - The failure is retained (`retainPlatformLifecycleOwner`).
   - Every later Record or Go Live first retries it
     (`settlePreviousPlatformLifecycle`, `use-studio.tsx:11883-11907`).
   - While the quota is out, that retry always fails: "Finish cleaning up the
     previous livestream providers before starting again." This lasts until
     midnight Pacific or a relaunch.
   - None of it is needed. Prepare sets `enableAutoStop: true`
     (`youtube.rs:419-420`), so YouTube ends the broadcast about a minute
     after ingest stops.
2. **Toast copy.**
   - `use-studio.tsx:11701` builds `Could not complete ${target.label} on
YouTube.` with the default label `'YouTube'` (`lib/capture.ts:529`).
     `:11211` has the same flaw.
   - The description is the raw body from `youtube.rs:709-738`.
3. **Wrong subscriber copy.** `audience.rs:605-606` calls a quota 403
   "Reconnect YouTube to show subscribers."
4. **Wrong chat copy.** Any other 403 in chat reads "Live chat is disabled"
   (`youtube_chat.rs:658`).
5. **The real reason only shows in a tooltip.** `providerProblem` shows
   inline text only for waiting/failed (`stream-manager-status-bar.tsx:77-80`).
6. **No observability.** No per-endpoint request counts exist.
7. **Toast storm on YouTube connect.**
   - Account preparation's profile lookup (`channels.list mine=true`) hits
     the quota. `main.rs:1953-1961` marks the result `retryable: true` and
     emits `platformAccounts.oauth.callback`.
   - Each emit becomes a new `toast.error('OAuth callback failed.', …)` with
     no `id` (`lib/session-runtime-recovery.ts:248-259`, wired at
     `use-studio.tsx:6510-6512`).
   - The renderer retries every retryable result (`use-studio.tsx:10837-10840`)
     at 0.5, 1, 2, 4, 8, 10 s, then every 20 s for the 10-minute callback TTL
     (`lib/provider-oauth-retry.ts`, `shared/oauth-callback-policy.ts`).
     That is about 35 toasts and about 35 more quota-spending calls.
   - It ends with "OAuth completion is still unavailable…"
     (`use-studio.tsx:10866-10868`).
   - Only 1 of 168 renderer toast call sites has a dedupe `id`.
8. **No remote control.** No shipped build has a server-side flag or forced
   update (checked `origin/main`). The owner had no lever except waiting for
   midnight Pacific.

---

## Target budget after this plan (the headroom)

Google sells no YouTube quota. The free audit/extension (S0) grants a fixed
number based on the usage we justify, so cutting calls per stream is what
creates headroom. These are the numbers the extension form will quote. Same
stream: one YouTube OAuth destination, 2 hours, list = 1 unit (S0 confirms).

| Call                                     | Today            | After wave 1 (S1: 5 s floor, idle → 10 s, viewers 60 s) | After S5 (streamList) | After S8 (free savings) |
| ---------------------------------------- | ---------------- | ------------------------------------------------------- | --------------------- | ----------------------- |
| Chat read                                | 6,000-7,200      | ≤ 1,440                                                 | reconnects only       | reconnects only         |
| Viewer count                             | 240              | 120                                                     | 120                   | 120                     |
| Subscribers                              | 60               | 60                                                      | 60                    | 60                      |
| Go Live + stop                           | ~310-370         | ~310-370                                                | ~310-370              | ~210-270                |
| **Total (no sends)**                     | **≈6,600-7,900** | **≈1,900-2,000**                                        | **≈500-600**          | **≈400-500**            |
| 2-hour streams/day on the default 10,000 | ~1.3             | ~5                                                      | ~16-20                | ~20-25                  |

- **Chat sends cost 50 units each.** They aren't reduced, and after S5 they
  are the largest variable cost (20 sends = 1,000). The S1 counter reports
  them separately.
- **Acceptance numbers** (checked in S5 and in final acceptance):
  - recurring chat + viewer + subscriber usage ≤ 75 units per 30 minutes
    (≤ 300 per 2 hours) in the S1 counter;
  - the Cloud Console delta agrees with the counter within about 10%.
  - If streamList turns out to bill per message or per reconnect, record the
    real cost here and re-plan S5 before shipping it.

---

## Levers considered and rejected

- **Paying Google for more quota:** not possible. YouTube quota is only
  raised through the audit/extension form (S0).
- **Several Google projects to spread the load:** YouTube's API developer
  policies forbid using multiple projects to get around quota, and it would
  put the approved OAuth verification at risk.
- **Reading chat through YouTube's unofficial web endpoints:** against the
  API terms, fragile, and incompatible with the verified-app status.
- **Lowering "queries per minute per user" in Cloud Console** to throttle old
  clients: a Go Live burst (ingest polls plus up to 30 transition confirm
  polls) would hit the cap and fail Go Live. A cap high enough to be safe
  (≥ 60/min) doesn't slow 1 s polling.
- **Disabling the current OAuth client** to force old versions off: every
  installed user would lose YouTube until they update and reconnect. This is
  a break-glass action only, if Cloud metrics show old clients still
  draining quota a week after the hotfix (owner decision D5).
- **Per-user Google projects ("bring your own key"):** too hard for streamers.
  Not planned.

---

## Owner actions (S0, start now, independent of code)

1. **Cloud Console → APIs & Services → YouTube Data API v3 → Metrics.**
   Filter by method for the 2026-10-02 Pacific day. Note the calls and units
   for the liveChatMessages list method, and the total. Paste them here: this
   proves which call burned it and what `list` really costs.
2. **Quotas page:** add Cloud Monitoring alerts at 50% and 80% of the daily
   quota, emailed to the owner.
3. **Submit the "YouTube API Services - Audit and Quota Extension Form"**
   today; the docs give no timeline. The agent drafts the answers on request:
   features, the per-stream budget from the table above, user counts, and
   screenshots. Ask for enough for the expected concurrent streamers ×
   ~600 units per 2-hour stream plus sends, with margin.
4. Quota resets at **midnight Pacific = 09:00 CEST**.
5. After the hotfix ships: watch daily usage by method for a week (old
   0.9.125/0.9.126 clients fade as they update). Decide D5 if they don't.

---

## Slices

Three waves:

- **Wave 1 (S1-S4)** is the hotfix and ships as soon as it's green.
- **Wave 2 (S5-S6)** makes chat real-time and protects the shared quota.
- **Wave 3 (S7-S9)** adds owner control, free savings and the record.

### Wave 1: hotfix (G1, G3, G4, G5)

#### S1: Quota-aware YouTube backend, with automatic resume

Backend, `fable-5`. Done when a quota 403 anywhere stops every YouTube call
until the reset, shows a paused state with the resume time, resumes by itself
afterwards, and chat polls no more than every 5 s.

1. **New error kind `QuotaExhausted`.**
   - Classify `quotaExceeded`, `dailyLimitExceeded` and any `youtube.quota`
     domain as `QuotaExhausted`, in one shared classifier used by chat,
     viewers, audience, OAuth validate, prepare, transitions, thumbnails and
     send.
   - `extract_error_reason` (`youtube_chat.rs:730-739`) returns `{reason,
domain}`.
   - `rateLimitExceeded`, `userRateLimitExceeded` and 429 stay RateLimited
     (back off, keep going).
   - Other 403s get permissions copy, not "disabled".
2. **App-wide breaker** `youtube_quota_paused_until: Option<DateTime<Utc>>` in
   `AppState`.
   - It is set to the next 00:00 America/Los_Angeles (DST-aware) by any
     `QuotaExhausted`.
   - While it is set, every YouTube Data API caller skips its call: chat
     reader, viewer sampler, audience, OAuth validate, OAuth connect
     preparation (S3), prepare, thumbnails and send.
   - It emits a `youtube.quota` event `{pausedUntil}` so the renderer shows
     one shared state.
   - **Expiry probe:** at `pausedUntil` plus a random 0-120 s, one cheap
     call (`channels.list`, 1 unit) checks. Success clears the breaker; a
     second quota error re-arms it for 30 minutes rather than a full day,
     because Google's reset time is not exact.
3. **Chat reader:** on `QuotaExhausted`, use provider state `Waiting` with
   `retryAt` instead of Failed or Reconnecting.
   - The task **parks**, it does not exit. When the breaker clears it
     resumes with the last `nextPageToken` (G4).
   - Copy (rendered in the renderer from `retryAt` in local time): "YouTube
     chat is paused: Videorc's daily YouTube API limit is used up. It resumes
     at 09:00. Your stream keeps going."
4. **Viewer sampler and audience** park and resume the same way.
   - `viewer_stats.rs`: back off on 403 and move from 30 s to 60 s.
   - `audience.rs:605-606`: a quota 403 is not NeedsReconnect.
5. **Poll floor:** raise `MIN_POLLING_INTERVAL_MS` from 1,000 to **5,000**
   (D1).
   - After 6 empty pages in a row, step up to 10 s; snap back on the next
     message.
   - Keep honouring a larger `pollingIntervalMillis`.
6. **Transport:** start in `List` (the current streamList path can't parse a
   streamed body). Never flip transport on quota, rate limit, auth or
   transient errors (`:1005-1008`). S5 replaces this.
7. **Usage counter** `youtube_api_usage`: endpoint → calls and estimated units
   (Google's cost table, sends counted separately).
   - Log a summary every 10 minutes during a session and at session end.
   - Add it to session diagnostics JSON.
   - Persist a per-Pacific-day total in the DB, so S6 can budget across
     relaunches.

**Tests** (`cargo test -p videorc-backend youtube_chat viewer_stats audience
youtube_quota`):

- classifier cases: `quotaExceeded`, a `youtube.quota` domain with an unknown
  reason, `dailyLimitExceeded`, `rateLimitExceeded`, `forbidden`;
- every caller makes **zero** requests while the breaker is set (counting mock
  server);
- the reader parks with `Waiting`/`retryAt` and resumes with its page token
  after the breaker clears;
- the expiry probe re-arms for 30 minutes on a second quota error;
- midnight Pacific maths across both DST changes (fixed instants);
- the poll-floor and idle-stretch sequence (pure function);
- counter totals.

**Gates:** `cargo fmt --check --all`, `cargo clippy -p videorc-backend -- -D
warnings`, targeted `cargo test` (owner directive: targeted tests + clippy
locally), and `pnpm typecheck` for the new event and fields.

**Serde trap:** new `Option` wire fields need `skip_serializing_if =
"Option::is_none"`, or the TS contract parse can kill app load.

#### S2: Go Live and Stop never trap the streamer

Renderer + backend, `fable-5`. Done when a quota failure at Go Live, live
transition or Stop shows one human message, never blocks Record or the other
platforms, and offers the stream-key path for YouTube.

1. **Typed transition errors.** `youtube.rs:709-738` returns `{status,
reason, domain}` (reuse `scheduled_youtube.rs:8-13` `YouTubeRejection`).
   Map it to Videorc copy with the `youtube_thumbnail_failure_message`
   pattern (`youtube.rs:259-274`), and never forward Google's `message`.
2. **`complete` failing on quota, `liveBroadcastNotFound` or "already
   complete"** is _settled_, not retained.
   - YouTube auto-stops the broadcast (`enableAutoStop`).
   - Don't call `retainPlatformLifecycleOwner` for that class, so
     `settlePreviousPlatformLifecycle` never blocks the next start.
   - Network and 5xx failures keep today's retain-and-retry.
3. **`transition live` failing on quota** is a warning, not a failure:
   auto-start takes the broadcast live when ingest arrives. Say so.
4. **Go Live preflight while the breaker is set** (G5).
   - Prepare would fail on insert, so refuse YouTube **OAuth** destinations
     up front, with: "YouTube's API is paused until 09:00, so Videorc can't
     create the YouTube broadcast. Go live on YouTube with your stream key
     instead."
   - Add a button that opens the YouTube stream-key destination setup with a
     link to YouTube Studio → Go live → Stream key.
   - Twitch, Kick, X, Custom RTMP and recording proceed untouched.
5. **Toast copy** (`use-studio.tsx:11211`, `:11701`): "Couldn't start the
   YouTube broadcast." / "Couldn't end the YouTube broadcast."
   - Include the target label only when it differs from the platform name.
   - Quota description: "YouTube's daily API limit is used up. YouTube ends
     the broadcast on its own about a minute after you stop."
6. **One shared paused state in the UI.**
   - Livestream page (YouTube row), Stream Manager status bar and the
     Comments destination status all read the S1 `youtube.quota` event.
   - The text shows inline: Waiting is already an inline state at
     `stream-manager-status-bar.tsx:77-80`, so not just a tooltip.
   - It disappears by itself when the breaker clears.

**Tests:**

- lifecycle: `complete` fails with quota, then a recording-only start
  proceeds and so does a Twitch-only Go Live;
- preflight with the breaker set: YouTube OAuth refused with the fallback
  action, other destinations start;
- toast label de-duplication;
- backend transition classifier.

**Gates:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm --filter
@videorc/desktop test`, `cargo` targeted tests + clippy, and
`pnpm smoke:record-latency`. That last one applies because session start
gating changes (AGENTS.md start/stop rule).

#### S3: No toast storms

Renderer + backend OAuth path, `fable-5` (the token checkpoint is
load-bearing). Done when a quota failure during YouTube connect shows
**exactly one** readable toast and makes no further YouTube calls, and no
repeating producer anywhere can stack identical toasts.

1. **Quota during YouTube connect is not retryable.**
   - A `QuotaExhausted` profile lookup sets the breaker and returns
     `retryable: false` with reason `youtube-quota` and `retryAt`
     (`main.rs:1953-1961`).
   - Clean up the token checkpoint exactly as the existing non-retryable
     paths do. The 10-minute callback TTL can't wait for a reset hours away.
   - While the breaker is set, refuse **before** the lookup, so no quota is
     spent.
   - Copy: "Couldn't finish connecting YouTube. Videorc's daily YouTube API
     limit is used up. Try again after 09:00."
2. **One toast per incident.**
   - `showOAuthCallbackResult` uses `id: oauth-callback:${platform}`, so
     retries update it in place. The "still unavailable" exhaust toast reuses
     the id.
   - The title becomes "Couldn't finish connecting {Platform}."
3. **Keyed helper `notifyOnce(key, …)`.** The same key within 30 s updates the
   existing toast (sonner `id`).
   - Apply it to every toast that fires from a retry, timer, interval or
     backend event handler (`git grep -n "toast\." origin/main --
apps/desktop/src/renderer`, then check each caller's trigger).
   - Leave one-shot toasts that follow a click alone.
   - List the call sites you keyed in the PR body.
4. **Guard on every toast description:** strip HTML tags and escaped entities
   (`<…`), and replace JSON blobs with "Details are in diagnostics."
   Log the raw text to renderer diagnostics. This is defense in depth behind
   the S1/S2 copy.
5. Set `visibleToasts={3}` explicitly on both `<Toaster>`s (`App.tsx:43`,
   `comments/main.tsx:516`).

**Tests:**

- backend: a quota during preparation gives non-retryable, reason
  `youtube-quota`, breaker set, and zero profile requests on a second connect;
- renderer: no retry is scheduled for that result, and repeated callback
  events reuse one `id`;
- the guard, fed the exact strings from the owner's screenshot and the video:
  no `<a`, no `<`, no `{"error"`;
- `notifyOnce` unit tests.

**Gates:** as S2, plus `cargo test -p videorc-backend oauth`.

#### S4: Quota-outage drill smoke (maintained gate)

Scripts + dev-only backend override, `fable-5`. Done when `pnpm
smoke:youtube-quota` drives the dev app through a full outage against a local
fake YouTube API and proves G1, G3, G4 and G5 end to end.

1. **Dev-only env `VIDEORC_YOUTUBE_API_BASE_URL`** points every YouTube
   client (`youtube.rs`, `youtube_chat.rs`, `audience.rs`, `viewer_stats.rs`,
   `oauth.rs` validate) at one base URL.
   - Today `audience.rs:32` hard-codes the host, and the reader and sender
     treat base URLs differently (plan 084 note). Unify that.
   - Refuse the env var in packaged builds, with a test.
2. **Fake YouTube API** under `scripts/lib/` (modelled on
   `scripts/smoke-live-chat-fake-providers.mjs`). It serves prepare, bind,
   transitions, chat list, videos, channels and send, and can flip to
   `quotaExceeded` on command. It records every request.
3. **Smoke scenarios** (`scripts/smoke-youtube-quota-app.mjs`, package script
   `smoke:youtube-quota`):
   - a. Live with chat flowing, then quota flips. Expect exactly one paused
     notice, chat state Waiting with `retryAt`, other fake platforms still
     delivering, zero YouTube requests while paused, and the RTMP output
     still advancing (G1, G3).
   - b. Breaker expiry is forced (test hook). Expect chat to resume and
     messages to arrive again without user action (G4).
   - c. Stop during the outage: one toast, then Record starts immediately
     (bug 1).
   - d. Go Live with YouTube OAuth while paused: refused with the stream-key
     action, other destinations live (G5).
   - e. Connect YouTube while paused: one toast, zero profile requests
     (bug 7).
4. Add the smoke to `smoke:local-gates`. Mention it in AGENTS.md under the
   chat and provider changes rule.

**Gates:** the new smoke green twice in a row, plus `pnpm test:scripts`.

#### Hotfix release (after S1-S4)

Ship wave 1 as its own release with the `videorc-release` skill: macOS and
Windows (D2). The changelog line, in user words: "YouTube chat no longer
stops mid-stream on busy days. When YouTube's daily limit is reached,
Videorc pauses YouTube extras with a clear notice and resumes on its own."

**Before publishing, re-check live state:** main, feed, records, runs (memory
rule).

### Wave 2: real-time chat, shared-quota protection (G2, G6)

#### S5: Real streamList

Backend, `fable-5`. Done when a 30-minute private stream reads chat over held
connections with ≤ 75 recurring units (counter + Cloud delta, see the target
table) and chat latency ≤ 5 s.

1. **Probe first** (plan 084 lesson: never trust mocks). On a
   private/unlisted test broadcast with a real token, run `curl -N` against
   `GET /youtube/v3/liveChat/messages/stream?liveChatId=…&part=snippet,authorDetails`.
   Record:
   - the body framing (streamed JSON array vs newline-delimited objects);
   - how long the server holds the connection and its idle behaviour;
   - how it ends (`offlineAt`, `chatEndedEvent`);
   - error shapes, including `RESOURCE_EXHAUSTED`.

   Save a redacted fixture in `crates/videorc-backend/tests/fixtures/` (no
   tokens; only the owner's own test messages). Docs:
   <https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList>.

2. **Incremental parser** over `reqwest` `bytes_stream()` that feeds
   `normalize_item` / `try_deliver_messages` as each response arrives.
   - Reconnect with the last `nextPageToken`, with jittered backoff.
   - Fall back to `list` (5 s floor) only on a proven "unsupported" signal,
     never on quota, rate limit, auth or transient errors.
3. **Cost:** measure the Cloud Console delta, since Google's table doesn't
   list streamList. Record it in the target table.
4. Update the module header and the transport docs.

**Tests:** a chunked mock server replaying the probed fixture (split
mid-object, idle keepalives, reconnect with `pageToken`, server close,
`offlineAt`), and a fallback-only-on-unsupported test. Extend the S4 fake
API with a streaming route and re-run `smoke:youtube-quota`.

**Gates:** Rust targeted tests + clippy + fmt, `smoke:youtube-quota`, and
owner acceptance A1 (below).

#### S6: Per-install daily budget with call priorities

Backend + renderer copy, `fable-5`. Done when one install can't spend more
than its daily budget, and as it gets close it sheds the least valuable calls
first, with a quiet explanation.

1. **Budget**, default **2,500 units per Pacific day** (D3), using the S1
   persisted counter. S7 can override it remotely.
2. **Priority ladder** (highest first):
   1. Go Live essentials: prepare, bind, transitions.
   2. Chat read.
   3. Chat send.
   4. Viewer count.
   5. Subscribers.
   6. Thumbnail upload.
3. **Shedding:**
   - at 80% of the budget, stop subscribers and thumbnails, and slow viewers
     to 120 s;
   - at 95%, stop viewers;
   - at 100%, keep only Go Live essentials and chat read on the S1 floor.
     Each step shows one quiet notice through `notifyOnce` ("YouTube viewer
     count paused to save Videorc's daily YouTube limit").
4. The budget never blocks a running stream or a Stop.

**Tests:** ladder thresholds with fixed counters; a relaunch keeps the day's
total; the Pacific day rollover resets it.

**Gates:** Rust targeted tests + clippy, `pnpm typecheck`, desktop tests.

### Wave 3: owner control, free savings, record (G7)

#### S7: Remote service flags (no release needed next time)

videorc-web + desktop, `gpt-5.5`. Done when the owner can change YouTube
behaviour for every updated client by editing one JSON file, and a broken or
missing file changes nothing.

1. **videorc-web:** a public, cacheable `GET /api/desktop/service-flags`
   (static JSON, no auth, no PII, `Cache-Control: max-age=300`). It follows
   the existing `/api/ai/capabilities` style in
   `crates/videorc-backend/src/videorc_api.rs`. Keys:
   - `youtube.chatTransport`: `stream | list | off`;
   - `youtube.minPollMs`;
   - `youtube.viewerSampleMs`;
   - `youtube.dailyBudgetUnits`;
   - `youtube.pausedUntil`: an owner-set global pause.
2. **Desktop** reads it at startup and every 30 minutes.
   - It **fails open to compiled defaults** and clamps every value to safe
     bounds (e.g. `minPollMs` ≥ 5,000).
   - It logs which flags are in effect in session diagnostics.
3. Document the flags and an "incident playbook" in `docs/` (what to set
   when Cloud alerts fire).

**Tests:** parse, clamp and fail-open unit tests; the web route test in
videorc-web.

**Gates:** desktop typecheck/tests + Rust targeted. videorc-web: its own lint
and tests (memory: videorc-web typecheck has known red tests on main; report,
don't fix). **Deploy the web route before the desktop release that reads it.**

#### S8: Free savings (about 100 units per stream)

Backend, `gpt-5.5`. Done when a Go Live + Stop cycle costs about 100 units
less, with no change for the streamer.

1. **Reuse one `liveStream` per channel** instead of `liveStreams.insert` per
   Go Live (−50).
   - Persist the stream id per account. Fetch it with `liveStreams.list`
     (1 unit); insert only if it is missing or deleted.
   - **Probe first** with a real token: confirm a reused stream binds to a
     new broadcast cleanly and keeps its key.
2. **Skip the explicit `transition complete`** when the broadcast was
   prepared with `enableAutoStop` (−50).
   - The broadcast ends about a minute after ingest stops.
   - Keep the explicit call only for broadcasts where auto-stop is off.
   - **Probe first:** confirm the broadcast reaches `complete` on its own.
3. Keep `transition live`: it makes going live fast and explicit.

**Tests:** prepare reuses the stored stream; insert on a missing stream; Stop
skips `complete` with auto-stop on.

**Gates:** Rust targeted + clippy, `smoke:youtube-quota`, and owner A1.

#### S9: Docs, acceptance record, memory

`gpt-5.5`.

- Fill in S0 numbers, S5 streamList cost and the acceptance results here.
- Add rows to `plans/README.md`.
- Update `docs/` wherever YouTube chat transport and quota are described
  (`git grep -n -i "streamList\|quota" origin/main -- docs`).
- Draft the extension-form answers if not yet done.

---

## Owner decisions

| #   | Decision                                                                | Recommended                                                                                    |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| D1  | Chat poll floor for the `list` path                                     | **5 s.** Up to about 5 s chat delay until S5; S5 makes it real-time.                           |
| D2  | Ship wave 1 (S1-S4) as its own hotfix release, macOS + Windows          | **Yes**: the quota is shared by every user.                                                    |
| D3  | Per-install daily budget                                                | **2,500 units** (about four 2-hour streams with sends after S5); remotely adjustable after S7. |
| D4  | Remote service flags on videorc.com (S7)                                | **Yes**: next incident is a JSON edit, not a release.                                          |
| D5  | Break glass: disable the old OAuth client if old versions keep draining | **Only** if Cloud metrics a week after the hotfix still show 1 s polling.                      |

## Out of scope

- Chat for a second YouTube broadcast in the same session. Today
  `params.youtube` is a single Option (`main.rs:3150-3151`), and the vertical
  YouTube leg is stream-key only (plan 061). Revisit after S5 makes extra
  readers cheap.
- Per-user Google projects or API keys.
- YouTube custom emoji images.

---

## Final acceptance (owner, after wave 2 ships; record results here)

- **A1, real stream:** 2+ hours to YouTube plus at least one other platform,
  with steady chat. Pass when:
  - YouTube chat latency stays ≤ 5 s for the whole stream (G2);
  - the counter summary meets the target table (≤ 75 recurring units per
    30 minutes);
  - the Cloud Console delta matches the counter within about 10%.
- **A2, outage drill on the packaged build:** set `youtube.pausedUntil` via
  S7, or run the S4 smoke against the packaged app if S7 isn't live. Expect
  one calm notice, chat Waiting with the local resume time, Stop → Record
  immediately, Go Live offering the stream-key path, and connect showing one
  toast (G3, G5).
- **A3, resume drill:** clear the pause mid-stream. Chat, viewers and
  subscribers resume with no click (G4).
- **A4, a week of Cloud metrics after the hotfix:** daily usage by method
  trends to the target, and the 80% alert never fires.

## Handoff

- **Worktree:** `git worktree add ../videorc-wt-094 -b fix/094-youtube-quota
origin/main`. APFS-clone an idle sibling's `target` first (`cp -Rc
../videorc-wt-<idle>/target ./target`) after checking `ps` for cargo on it.
- **PRs:** wave 1 is one PR (slices as commits, push after each). Wave 2 and
  wave 3 get their own PRs; S7's videorc-web change is a separate web PR
  merged and deployed first.
- **Blockers:**
  - S5 and S8 probes need a real YouTube token and a private broadcast (owner
    session or the owner's connected dev build).
  - S0 is console-only.
  - Hotfix publishing follows the release skill's owner gates.

---

## Execution notes (2026-10-02, worktree `videorc-wt-094`, branch `fix/094-youtube-quota`)

Owner decisions taken at the recommended defaults: D1 = 5 s floor, D3 =
2,500 units per install per Pacific day, D4 = remote flags yes. D2 (hotfix
release) and D5 (break glass) are still the owner's.

| Slice        | State       | Commit      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1           | DONE        | `35b7b83a`  | Shared classifier, app-wide breaker with the expiry probe (+0-120 s jitter, 30-minute re-arm), chat parks as Waiting with `retryAt`, 5 s floor / 10 s idle, transport fixed to `list`, viewers 60 s, usage counter persisted per Pacific day (`youtubeApiUsageDaily`), `youtube.quota` event + `youtube.quota.status`.                                                                                                                                                                                                    |
| S2           | DONE        | `345006c5`  | Typed transition errors, settled `complete` on quota / not-found, live transition on quota is a warning, Go Live preflight refuses YouTube OAuth with the stream-key action, one paused state across the Livestream page, Stream Manager and Comments status.                                                                                                                                                                                                                                                             |
| S3           | DONE        | `24eaac20`  | Quota during connect is terminal (`reason: youtube-quota`, `retryAt`, checkpoint cleaned up), one toast per incident (`oauth-callback:{platform}`), `notifyOnce`, the toast guard in `lib/toast.ts`, `visibleToasts={3}`.                                                                                                                                                                                                                                                                                                 |
| S4           | DONE        | `f56eb1b0`  | Dev-only `VIDEORC_YOUTUBE_API_BASE_URL` (bare loopback only; refused in release builds, tested) through `youtube_quota::youtube_api_base_url` in every YouTube client incl. OAuth token/profile/revoke and the probe; `scripts/lib/fake-youtube-api.mjs`; `pnpm smoke:youtube-quota` (in `smoke:local-gates`, AGENTS.md); smoke RPCs `test.youtubeQuota.seedAccount` / `forceExpiry` (debug + smoke switch + override only).                                                                                              |
| S5           | **BLOCKED** | –           | Needs the real-token `curl -N` probe of `liveChat/messages/stream` on a private broadcast (body framing, idle behaviour, end markers, error shapes, Cloud Console cost). The quota is exhausted until 09:00 CEST 2026-10-03. The fake API already serves the `/stream` route with the `list` shape so S5 can extend it. Until then `chatTransport: "stream"` is read as `list`.                                                                                                                                           |
| S6           | DONE        | `f74798ba`  | Budget ladder (`budget_step`, `budget_allows`): 80% sheds subscribers + thumbnails and halves viewer polls (120 s), 95% stops viewers, 100% stops sends; Go Live essentials and chat read never shed. `youtube.quota` carries `budget {units, limit, step}`; one `notifyOnce` per step on the way up. Relaunch keeps the day total; the Pacific rollover starts at zero.                                                                                                                                                  |
| S7 (desktop) | DONE        | `83401b2f`  | `service_flags.rs`: startup + every 30 minutes, fail open, clamps, past `pausedUntil` ignored, future one feeds the breaker as a remote pause (lifted when withdrawn, never lifts a quota pause), `stream` read as `list` and noted, `off` parks the reader. Flags logged on change and to the session log (`youtube-service-flags`). `docs/youtube-service-flags.md` has the keys and the incident playbook. **Web half:** videorc-web PR #67 is open, not deployed; deploy it before the desktop release that reads it. |
| S8           | **BLOCKED** | –           | Both savings need live probes with a real token: a reused `liveStream` binding cleanly to a new broadcast, and a broadcast reaching `complete` on its own under `enableAutoStop`. Same quota block as S5.                                                                                                                                                                                                                                                                                                                 |
| S9           | DONE        | this commit | This section, `plans/README.md`, `docs/live-chat-live-smoke-checklist.md`, `docs/youtube-service-flags.md`.                                                                                                                                                                                                                                                                                                                                                                                                               |

### Deviations from the plan text

- **S4, "other fake platforms still delivering":** the drill uses the real
  session path (seeded OAuth account → stored token → `session.start` →
  connector, sampler and audience against the fake), so no second platform's
  chat is attached: Twitch/Kick chat need their own accounts and EventSub /
  relay fakes. "Other platforms unaffected" is proven as the custom RTMP
  destination's bytes advancing through the outage and a non-YouTube Go Live
  succeeding while paused; the fake-provider fan-out itself is covered by
  `smoke:live-chat-fake-providers`.
- **S4, renderer toasts in scenarios c and d:** the drill drives the backend
  RPCs (`complete` → `youtube-quota-paused`, settled; `prepare` →
  `youtube-quota-paused` with the stream-key copy) and counts renderer toasts
  only where the renderer reacts to backend events (the paused notice in a,
  the connect toast in e). The renderer's own Stop/Go Live toasts and the
  stream-key button are covered by the S2 unit and integration tests
  (`studio-provider.integration.test.ts`, `youtube-quota.test.ts`).
- **S4, token exchange:** the dev override also routes Google's OAuth token
  and revoke endpoints to the fake (`/token`, `/revoke`) so the connect
  scenario reaches the profile lookup; release builds never honour it.
- **S6, viewer slowdown:** implemented as "poll every other 60 s tick" in the
  shared sampler rather than a separate 120 s timer, so Twitch and Kick keep
  their cadence.
- **S7, `viewerSampleMs`:** applies to the shared sampler loop only while a
  YouTube sampler runs; without YouTube the 60 s default stays.

### Owed

- **S0 (owner):** Cloud Console method breakdown for 2026-10-02 (proves what
  `list` costs), the 50%/80% alerts, the quota extension form, the week of
  metrics and D5.
- **S5 and S8 probes** after 09:00 CEST 2026-10-03 with the owner's token and
  a private broadcast; then re-run `smoke:youtube-quota` with the streaming
  route.
- **Web:** merge and deploy videorc-web PR #67 before the desktop release
  that reads the flags; then set `{ "version": 1 }` live and confirm a dev
  build logs `YouTube service flags in effect (remote, …)`.
- **Hotfix release** (D2) with the `videorc-release` skill, macOS + Windows,
  after the PR merges; changelog line as written above.
- **Acceptance A1-A4** (owner).
