# Plan 054: Show the live X viewer count in the Chat window

> Executor: this is a diagnosis handoff plus a small implementation plan. Read
> `AGENTS.md` first. Work in a dedicated worktree off current main. No provider
> writes are needed; the only real-account step is watching one live X session.

## Status and decisions

- Status: **EXECUTED 2026-09-24** in the Stream Manager PR
  (`feat/stream-manager`, plan 055) at the owner's request. S1 and S2 are
  done; S3 (one live X session) is pending the owner. See "Execution notes"
  at the end. Diagnosed 2026-09-24 against main `97000ead`.
- Priority P1 (owner-reported since 2026-08-19: "cannot see how many watchers
  there are from X"); effort S; risk LOW.
- Outcome wanted: the "watching" chip in the Chat window header includes X
  concurrent viewers, summed with YouTube and Twitch, and the per-platform
  split in the chip tooltip lists X.
- Owner route: Diagnose then Implementation; model lane `gpt-5.5` is enough
  (clear target, focused tests). Escalate only if the first live session after
  the fix still shows no X count.

## Findings

### The X API exposes the count

- Endpoint: `GET /2/broadcasts/{id}` (the documented "while live" call in the
  [typical workflow](https://docs.x.com/livestream-api/typical-workflow):
  "viewer counts, thumbnails, and state").
- Fields on the `Broadcast` object (official OpenAPI,
  `https://api.x.com/2/openapi.json`, parsed 2026-09-23):
  `total_watching` (current concurrent viewers) and `total_watched`
  (cumulative). Both are **strings**.
- Envelope: the OpenAPI `GetBroadcastResponse` is `{ "data": <Broadcast>,
  "errors": [...] }`.
- Auth: `OAuth2UserToken` with `broadcast.read`, or `UserToken` (OAuth 1.0a
  user context). Videorc's existing "Authorize X Live" token is the latter, so
  no new scope or flow is needed.
- No poll cadence or rate limit is documented for this route.

### Videorc already polls it, and it has never produced a number

- `crates/videorc-backend/src/viewer_stats.rs:161` `fetch_x_count` calls
  `x_live::fetch_broadcast_viewer_count` (`x_live.rs:1154`) every
  `VIEWER_SAMPLE_INTERVAL` (30 s), signed with the stored OAuth 1.0a token.
- `x_live.rs:1169` `parse_x_broadcast_viewer_count` reads
  `body.get("broadcast").unwrap_or(body)` and then tries the keys
  `viewer_count`, `total_watching`, `concurrent_viewers`, `num_watching`,
  `watching_count`, accepting numbers or numeric strings.
- **It never unwraps a `data` envelope.** With the documented response shape
  the lookup lands on the top-level object, finds no key, and returns `None`.
  `fetch_x_count` also turns every HTTP or auth failure into `None` with
  `.ok()?`, and `merge_viewer_sample` drops `None` platforms silently, so a
  4xx and an envelope mismatch look identical: no log, no sample.
- The scheduler adapter added in Plan 049 (`scheduled_x.rs::payload`) already
  handles both `data` and `broadcast` envelopes for the same route. The
  viewer parser predates it and was never aligned.

### Evidence from the owner's real database (read-only query, 2026-09-24)

`~/Library/Application Support/Videorc/videorc.sqlite3`, table
`session_logs`, code `stream-viewers`:

| Fact | Value |
| --- | --- |
| Viewer samples recorded | 1,102 |
| X broadcasts published since the sampler shipped (`x-broadcast-published`) | 19 |
| Samples whose `platforms` array contains an X entry | 0 |

The last session makes it concrete: at 2026-09-23T16:05:34Z the sample was
`{"platforms":[{"platform":"twitch","count":1}],"total":1}` while the X
broadcast was live; `x-broadcast-ended` was logged at 16:05:46Z. Every X poll
in 19 broadcasts returned nothing.

### A second defect sits behind the first (bug B1 from Plan 055 notes)

- `live_chat.rs:1460` starts one sampler for YouTube + Twitch when their chat
  connectors attach; `live_chat.rs:1570` starts a **separate** sampler for X
  when the X chat connector attaches.
- Each sampler emits its own `stream.viewers` event with its own `total`.
  The renderer (`use-studio.tsx:5842`) keeps the latest event, so once X
  counts arrive the chip would flip between "Twitch only" and "X only"
  totals every few seconds instead of summing.

## Fix

### S1 — Parse the documented envelope and stop failing silently

1. In `x_live::parse_x_broadcast_viewer_count`, unwrap `data` as well as
   `broadcast` (reuse `scheduled_x::payload`). Keep the key list; keep string
   parsing. Prefer `total_watching`; never fall back to `total_watched`
   (cumulative, would inflate the chip).
2. In `fetch_broadcast_viewer_count`, return a small typed outcome instead of
   `Option<u64>`: `Ok(count)`, `NoField { keys }`, `Http { status }`,
   `Transport`. `fetch_x_count` logs the non-count outcomes once per distinct
   reason per session through the existing session log
   (`HealthLevel::Warn`, code `stream-viewers-x`), with keys and status only,
   never the body or the URL.
3. Unit tests: `{"data":{"total_watching":"12"}}` → 12; `{"broadcast":
   {"total_watching":12}}` → 12; `{"data":{"total_watched":"500"}}` → no
   count; a 401 → `Http{401}`.

### S2 — One sampler per session

1. Make the session own a single `run_viewer_sampler` task whose platform
   configs can be added when a connector attaches (YouTube/Twitch at
   `live_chat.rs:1460`, X at `live_chat.rs:1570`) and removed when it detaches.
   Simplest shape: an `Arc<Mutex<ViewerSamplerConfigs>>` read at the top of
   each loop iteration; the first attach spawns the task, later attaches only
   update the configs.
2. `merge_viewer_sample` is unchanged: one call per tick with every platform.
3. Test: attach Twitch then X in one session; every emitted sample lists both
   platforms and `total` is their sum; detaching X removes it from the next
   sample without restarting the task.

### S3 — Prove it on one live X session

Run one real X broadcast from Videorc with the owner's account, open the Chat
window, and confirm the chip shows the X count within 60 s and the tooltip
lists `x: N`. Record the `stream-viewers` sample line in
`docs/acceptance/2026-09-XX-x-viewer-count.md`. If the count is still absent,
the new `stream-viewers-x` log line says which case it is (envelope, key name,
HTTP status); attach it to the record.

## Scope

Allowed paths: `crates/videorc-backend/src/viewer_stats.rs`, `x_live.rs`
(parser and fetch helper only), `live_chat.rs` (sampler ownership only),
their tests; `docs/acceptance/`. No renderer change is required; the chip
already renders the per-platform split.

Out of scope: chat relay, Stream Manager layout (Plan 055), YouTube/Twitch
polling logic, X scheduling.

## Verification

- `cargo test -p videorc-backend viewer_stats`,
  `cargo test -p videorc-backend x_live`,
  `cargo test -p videorc-backend live_chat`,
  `cargo clippy -p videorc-backend -- -D warnings`, `cargo fmt --check --all`.
- `pnpm typecheck` (no TS change expected; run anyway).
- S3 live check as above. This feature is not done until one real X sample
  with a non-zero count exists in the acceptance record.

## Known blockers

- No fixture or agent can call the real X API from this machine (the
  auto-mode classifier refuses live provider calls), so the envelope shape is
  verified from the OpenAPI only. S1 handles both shapes precisely so the live
  session is the proof, not a precondition.

## Execution notes

- **S1, done as written.** `x_live::x_broadcast_viewer_outcome` unwraps
  `data` or `broadcast` through `scheduled_x::payload`, prefers
  `total_watching` and never reads `total_watched`.
  `fetch_broadcast_viewer_count` returns `XViewerCountOutcome` (`Count`,
  `NoField { keys }`, `Http { status }`, `Transport`), and `fetch_x_count`
  logs each non-count reason once per session (`stream-viewers-x`,
  `HealthLevel::Warn`, keys or status only). `parse_x_broadcast_viewer_count`
  is gone. Tests: `the_documented_data_envelope_carries_the_viewer_count`,
  `a_refused_viewer_lookup_reports_its_status`,
  `broadcast_viewer_count_parses_defensively_across_field_lineages` (x_live)
  and `an_x_poll_without_a_count_is_reported_once_per_reason` (viewer_stats).
- **S2, done another way.** Plan 055's B1 fix already needed one total per
  session, so both samplers stay and feed one per-session `ViewerAggregator`.
  Every sample it emits sums each platform whose last count is younger than
  75 s. Tests: `both_samplers_feed_one_total_and_never_a_partial_one` and
  `a_silent_platform_leaves_the_total_after_the_freshness_window`. The
  difference from the plan: a detached X leaves the total after that 75 s
  window, not on the next tick.
- **S3, pending the owner.** The live check is in the Stream Manager
  acceptance record (`docs/acceptance/2026-09-24-stream-manager.md`), not a
  separate file: X shows a count within 60 s and the Viewers tile's split
  lists X.
