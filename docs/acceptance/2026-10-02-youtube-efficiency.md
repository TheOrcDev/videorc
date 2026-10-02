# YouTube efficiency candidate — 2026-10-02

## Scope and evidence status

Plan 096 implementation candidate on desktop baseline
`aac79ab42ec7b459ab3448494f8436941a719be6`. This is **not** evidence that the
streaming/reuse plan or its release gates are complete. Public chat remains
list polling; no ingest reuse or stream billing assumption is enabled.

The pristine baseline Node suite passed 1,712 tests and Rust format passed.
An initial quota run passed 17 tests, but its compilation overlapped edits and
is not claimed as clean baseline evidence. Candidate verification and
wire-count comparisons are recorded below after commands complete. Mock
intervals and local estimates are never reported as measured Google charges.

## Live project and operational baseline

At approximately 2026-10-02 21:33 UTC the owner project `244529927041`
(`videorc`) showed 10,007 units used against 10,000/day (100%). This is the
2026-10-02 Pacific quota day, resetting at 2026-10-03 07:00 UTC. It fails the
required 50% headroom preflight. No live protocol or ingest-reuse trial ran.
These are timestamped observations, not a claim about subsequent availability.

The production service-flags GET at 2026-10-02 21:31:05 UTC returned HTTP 200,
`{"version":1,"youtube":{}}`, with `cache-control: public, max-age=300`.
No production flags changed. The code baseline for the web contract is
`784d024d8fbad9ac1cb0e33abdecc78a9f7d605b`; later privacy publication remains
intact. No updated packaged-client effective-flags evidence is claimed.

Cloud Console's own alert template exposed `consumer_quota` daily usage:
`serviceruntime.googleapis.com/quota/rate/net_usage` summed daily in
`America/Los_Angeles`, divided by `serviceruntime.googleapis.com/quota/limit`
for `defaultPerDayPerProject` (daily minimum), rather than requests/minute.
Filters are `resource.project_id=videorc`,
`resource.service=youtube.googleapis.com`,
`metric.quota_metric=youtube.googleapis.com/default`, and
`metric.limit_name=defaultPerDayPerProject`; `usage_time_day` is the Pacific
date. The following policies were created and verified enabled, using the
owner email channel `orc@videorc.com`:

| Threshold | Policy ID | Evaluation |
| --- | --- | --- |
| 50% warning | `15187647470335662308` | Enabled |
| 80% alert | `10824168443448350982` | Enabled; incident opened 21:36:51 UTC |

Evaluation is every 30 seconds with a one-minute retest. The owner supplied a
screenshot confirming delivery of the original 80% policy's recovery email:
incident opened at 21:36 UTC and canceled 1m52s later when the policy was
renamed/edited at 21:38 UTC. This verifies notification-channel delivery for
that recovery; the initial alert-open email is not independently verified.
The recovery does **not** prove a quota reset or increased allowance. Both
policies remained enabled. The renamed 80% policy opened a new incident at
21:40:54 UTC with ratio 1.001 against threshold 0.8, confirming continued
evaluation after the edit. The private screenshot stays outside the repository.
Metric ingestion lag and method-level attribution are still unmeasured, so alert creation does not
satisfy live-trial preflight or the full monitoring acceptance gate.

## Endpoint inventory and admission boundary

Published REST estimates checked 2026-10-02 against Google's
[quota cost table](https://developers.google.com/youtube/v3/determine_quota_cost).
Every attempt uses mandatory process quota state independently of OAuth
refresh eligibility. Builder validation happens before admission. Admission
checks pause/policy and updates the persisted daily estimate atomically;
network I/O happens after unlocking. An already-admitted request can settle
after another caller pauses the process. No refund is inferred for an
uncertain network result or provider rejection.

| Endpoint | Estimated units/attempt | Callers / policy |
| --- | ---: | --- |
| `liveChatMessages.list` | 1 | Backend reader; chat read essential |
| `liveChatMessages.insert` | 50 | Explicit send; projected soft allowance reservation |
| `videos.list` | 1 | YouTube viewer poll and token retry; optional viewers |
| `channels.list` | 1 | OAuth connect/validate/profile/channel picker, subscribers, reset probe |
| `liveBroadcasts.list` | 1 | Chat discovery, scheduled lookup/recovery, every transition confirmation |
| `liveBroadcasts.insert` | 50 | Instant/scheduled creation; essential |
| `liveBroadcasts.update` | 50 | Scheduled metadata; essential |
| `liveBroadcasts.delete` | 50 | Cancel and failed-prepare rollback; essential |
| `liveBroadcasts.bind` | 50 | Instant/scheduled preparation; essential |
| `liveBroadcasts.transition` | 50 | Explicit live/complete; essential |
| `liveStreams.list` | 1 | Ingest status and scheduled reconciliation; essential |
| `liveStreams.insert` | 50 | Preparation; essential |
| `thumbnails.set` | 50 | Instant/scheduled upload and authorized retry; optional thumbnail |

OAuth token exchange/refresh/revocation are excluded. The reset probe is the
single-owner deadline exception to pause admission and still records its
`channels.list` attempt. Uncertain chat sends are not automatically replayed.
Read retries and the one permitted auth retry enter admission again. The
shared response boundary classifies bounded error bodies before caller retry
or rollback, retaining caller-specific typed errors and retry headers.

Locally refused scheduler creation clears its uncertainty checkpoint and can
retry after reset. A network-ambiguous create retains reconciliation state.
The allowance is **soft and per installation**: 2,500 units, with essentials
and chat reading permitted beyond it. It cannot protect a shared project by
itself. Concurrent sends cannot both reserve the last 50 units.

## Statistics candidate

YouTube viewers: 120 seconds; YouTube successful subscriber reads: 300 seconds.
Other viewer providers retain 60 seconds; Twitch/X subscriber cadence and
hidden/error backoff are unchanged. Each viewer provider owns a monotonic
deadline and bounded work; all futures belong to the sampler and cancel on
Stop. Poll completion publishes independently. Skipped reads do not restamp
cached observations, and the 150-second freshness rule remains unchanged.

At 80% local spend, YouTube viewers use at least 120 seconds rather than
another doubling. At 95%, they stop. Remote cadence changes recalculate only
the YouTube deadline without catch-up bursts. Approximate cadence-only saving:
96 units per two-hour session, excluding startup/latency/boundary effects.

## Streaming experiment preparation — incomplete P3a

The documented candidate protocol is gRPC:
[official guide and protobuf](https://developers.google.com/youtube/v3/live/streaming-live-chat),
checked 2026-10-02. No REST framing guess or fake stream response is being
substituted for that evidence. There is no published stream price established
by this work; estimated streaming units stay unknown.

`pnpm probe:youtube-efficiency --preflight <metrics.json>` is **offline
preflight only**. It sends no request, accepts no credentials, and emits only
allowlisted metrics/decisions. Exit 0 means preflight eligibility, not a passed
protocol/billing trial; exit 2 refuses invalid/insufficient evidence. Running
without `--preflight` exits 2 and states that live protocol/billing is pending.
The full transport probe is deliberately not presented as implemented.

Example shape (replace every metric with a fresh, attributable observation):

```json
{
  "dailyLimit": 10000,
  "usedUnits": 1000,
  "sampledAt": "2026-10-03T09:00:00Z",
  "measuredIngestionLagMs": 60000,
  "knownSetupAndSendsUnits": 250,
  "reservedTeardownUnits": 50,
  "paidSends": 2,
  "maximumOpens": 3,
  "maximumSeconds": 60,
  "ownerWindowConfirmed": true,
  "privateOrUnlistedBroadcastConfirmed": true,
  "attributionAvailable": true
}
```

The helper enforces the initial 60-second/3-open/2-paid-send bounds, reserves
teardown first, and refuses known exposure over 500 units. Unknown streaming
cost plus delayed metrics prevents a guaranteed hard unit ceiling. A larger
trial requires the previous window's settled evidence, not a larger command
argument. A measured billing function, durable streaming reader, reconnect
acceptance, four-hour run and packaged macOS/Windows evidence remain blocked.

## Remaining gates and capacity

P4 ingest reuse remains unimplemented and disabled pending ownership/live
proof. Explicit completion and existing stream-key ownership are preserved.
No release was published, public stream mode enabled or capacity promise
expanded. P1/P2 form the verified local candidate; packaged release acceptance remains
separate.

The 1,800-unit/session model remains a **target conditional on measured
streaming costs**, not this candidate's capacity. Active list chat still costs
approximately 1,440 reads in two hours, and 20 sends cost 1,000 units. The
requested million-unit application is pending; today's actual limit cannot
serve the 50–150 daily-streamer forecast at that sending activity.

## Candidate validation

All commands below ran on macOS with Node 24/pnpm 11. These are local and
fake-server checks, separate from the outstanding Google and packaged-platform
gates. No Windows execution or real Google billing trial is claimed.

| Gate | Result |
| --- | --- |
| `cargo fmt --check --all` | PASS |
| `cargo clippy -p videorc-backend -- -D warnings` | PASS after viewer URL correction; pristine baseline also passes |
| `cargo test -p videorc-backend viewer_stats` | PASS after URL correction: 16 tests |
| `cargo test -p videorc-backend` | PASS after viewer URL correction: 80 helper + 2,839 backend + 1 wire = 2,920 tests, with 12 ignored |
| `pnpm typecheck` / `pnpm lint` | PASS; existing `captureConfig` lint warning remains |
| `pnpm format:check` | PASS |
| `pnpm --filter @videorc/desktop test` | PASS: 2,646 tests, 1 skipped |
| `pnpm test:scripts` | PASS: 1,716 tests |
| `pnpm build` | PASS |
| `pnpm smoke:youtube-quota` | PASS after URL correction: 15 captured attempts = 162 estimated units; no calls during pause, output progression, reset/resume, Stop/Record, other destination and terminal connect |
| `pnpm smoke:scheduled-streams` | PASS after URL correction: 49 captured attempts = 735 estimated units; durable events, thumbnails, restart, recovery, cancellation, exact-ID YouTube/X starts and final media artifacts |
| `pnpm smoke:live-chat-fake-providers` | PASS: 375 messages, 4 duplicates skipped; fan-out, snapshot, activity and audience checks |
| `pnpm probe:youtube-efficiency` | Expected exit 2: refuses to imply a live protocol/billing trial |

The two pre-existing quota-copy tests failed on the pristine baseline when
the relative timestamp crossed local midnight. They now use Date-only fixed
clocks and cover both same-day and next-day copy; production copy is unchanged.
The first quota app launch timed out before readiness while another Cargo
test build held the build-directory lock. It exercised no scenario assertions;
the final app drills run sequentially after compilation. The quota drill
verifies Record can start during the outage, then stops immediately; its
FFmpeg first-media-clock diagnostic is not recording-artifact or media-quality
acceptance evidence.

The first completed scheduled drill caught 735 persisted units versus 734
captured units in the new strict comparison. The chat coordinator passed a
bare fixture origin to the viewer sampler, whose previous override handling
requested `/videos`; the wire estimator correctly excluded that malformed
API path. The viewer now normalizes bare origins and versioned roots to
`/youtube/v3`, preserving trailing-slash support. The harness sets the global
loopback override too, requires the versioned viewer path, refuses unexpected
provider roots, and retains exact usage equality. The corrected run passed with 49 captured attempts and 735 estimated units
matching exactly. No counter tolerance or malformed-path cost alias was added.

Meaningful regressions cover per-attempt retries, malformed/refused requests
with zero wire calls, scheduler uncertainty, projected send reservations,
ordered persisted counters, response error/retry-header preservation, and
stale reset-probe verdicts. Owned-loop tests hold a YouTube response while
other providers progress, verify per-provider cadence and cancellation, and
exercise the subscriber loop's five-minute success cadence.
