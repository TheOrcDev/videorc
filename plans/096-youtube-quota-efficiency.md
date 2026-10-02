# Plan 096: Make YouTube quota last longer without slowing live chat

> **Executor instructions:** Read this whole plan before starting. Work from
> current `origin/main` in an isolated worktree, not the shared checkout. Ship
> independently verified slices; keep live-provider evidence separate from
> fake-server evidence. Update the slice table and `plans/README.md` as work
> lands. This is an implementation plan, not evidence that the work passed.

## Status and scope of approval

- **Status:** PARTIALLY IMPLEMENTED / IN REVIEW; authorized 2026-10-02.
  Accounting and independent statistics are implemented with local/fake-provider
  verification complete for this candidate. The full plan remains
  BLOCKED on live protocol/billing and release acceptance; ingest reuse is
  deferred and disabled. No production transport flag changed, Google protocol
  probe or release ran.
  See [candidate evidence](../docs/acceptance/2026-10-02-youtube-efficiency.md).
- **Priority:** P0 for accounting and chat efficiency; P1 for ingest reuse.
- **Effort:** L, approximately 5–8 engineering days plus live observation and
  release gates. Estimates are not a deadline; provider measurement may block
  streaming-chat rollout independently of the other slices.
- **Risk:** MED overall; HIGH for chat transport and ingest ownership until
  their live checks pass.
- **Category:** correctness, performance, operational visibility.
- **Desktop baseline:** `aac79ab42ec7b459ab3448494f8436941a719be6`
  (`origin/main`, version 0.9.128). Shared checkout HEAD at planning time:
  `15206746ac1d6fcc231e881c077b8781e3fb32d6`, branch
  `feat/windows-owner-waiver`, with unrelated local files.
- **Web contract baseline:** `784d024d8fbad9ac1cb0e33abdecc78a9f7d605b`
  in `/Users/orcdev/projects/videorcweb`, PR #67. Rebase on current web main;
  the later public privacy correction in PR #68 must remain intact.
- **Depends on:** merged desktop PR #535 and web PR #67. No dependency on
  Google approving additional quota for local/fake-server work.
- **Supersedes:** [Plan 094](094-youtube-quota-exhaustion.md)'s unimplemented
  S5, the reuse portion of S8, and
  its outstanding quota measurement/monitoring work. Preserves its shipped
  outage handling. The auto-stop shortcut from S8 is explicitly deferred.

Drift check in the implementation worktree:

```sh
git diff --stat aac79ab42ec7b459ab3448494f8436941a719be6..HEAD -- crates/videorc-backend apps/desktop/src/shared/backend.ts apps/desktop/src/renderer/src/lib/youtube-quota.ts scripts/lib/fake-youtube-api.mjs scripts/smoke-youtube-quota-app.mjs scripts/smoke-scheduled-streams-app.mjs docs/youtube-service-flags.md package.json Cargo.lock
```

Compare changed symbols with the evidence below. Incorporate already-shipped
equivalent work; do not reintroduce an older implementation. Material contract
changes require revising this plan before proceeding. When transferring the
plan from the old checkout, apply only these planning additions to main's
newer index and Plan 094; do not replace those files wholesale.

## Outcome and constraints

Videorc currently shares a 10,000-unit daily YouTube project quota across all
installations. An application for **1,000,000 total units/day** was submitted
and its success page verified on 2026-10-02. Approval is pending. There are
500+ registered product users; **50–150 daily YouTube streamers is the owner's
forecast**, not measured usage.

The hotfix makes outages survivable. This work reduces normal consumption,
closes gaps in its accounting, and measures the savings before broader use.
The same improvements remain useful after a quota increase.

Required behavior:

1. A running video/audio stream and recording continue through any YouTube
   API error. Preserve the existing stream-key fallback at Go Live.
2. Chat remains timely, ordered and durable through reconnects, token expiry,
   pause/resume and opening additional UI windows. One reader owns each
   current broadcast chat; windows consume that reader's events.
3. Count every attempted Data API request once, including scheduling,
   confirmation reads, retries and cleanup. Requests refused locally count
   as zero attempts. Estimates are clearly distinguished from Google's usage.
4. Keep sending explicit and user-driven. Preserve current delivery receipts
   and duplicate-send protection; never automatically replay a chat send with
   an ambiguous network outcome.
5. YouTube savings must not slow Twitch, Kick or X, or misrepresent stale
   statistics as newly observed values.
6. Keep credentials on the device and Google calls direct. No new cloud chat
   relay, token upload, customer telemetry service, or new OAuth scopes.

**Capacity boundary:** `liveChatMessages.insert` costs 50 units. Twenty sends
cost 1,000; 50 streamers doing that need 50,000 units for sends alone. No read
optimization makes 10,000 units/day support the forecast at that activity.
Do not expand the capacity promise until the approved quota and observed
consumption support it. The 2,500-unit local soft budget is neither a hard
per-install cap nor a project-wide admission controller.

## Reconciliation with Plan 094

| Earlier work | Verified state at this baseline | Action here |
| --- | --- | --- |
| S1–S4: slower polling, quota breaker, resume, calm UI, outage smoke | Merged in #535 | Preserve; expand regression coverage |
| S5: streaming chat | Not implemented; reader explicitly selects `List` | Replaces S5 with protocol/billing trial, then implementation |
| S6: daily budget | Implemented soft shedding; essential calls and chat reads continue past 2,500 | Correct its description; meter all request paths |
| S7: remote controls | Desktop and web code merged; old clients do not understand them | Verify production document and use a compatible rollout |
| S8: reuse ingest / omit complete | Neither implemented | Reuse compatible idle ingests; retain explicit completion |
| S0: larger quota | Application submitted | Await review; do not resubmit or promise approval |
| S0: project alerts / live cost evidence | Not verified by this planning pass | Obtain actual evidence in P0/P5 |

Plan 094's historical cost guesses, unfinished release notes and statements
that one installation cannot exhaust the project are not acceptance evidence.
Published `list` cost is 1 unit; `streamList` is not separately listed in the
cost table checked for this plan.

## Current implementation evidence

Paths/lines refer to the desktop baseline above, not the old working tree.

| File / symbol | Observed behavior and implication |
| --- | --- |
| `crates/videorc-backend/src/youtube_chat.rs:1098`, `run_youtube_chat_connector` | `let transport = YouTubeChatTransport::List;`; active floor 5 s, idle 10 s after six empty pages. No real streaming reader. |
| `youtube_chat.rs:887`, `fetch_chat_page` | Uses `response.json::<LiveChatMessagesResponse>()`; cannot process an indefinitely open sequence of responses. |
| `youtube_chat.rs:108`, `send_youtube_chat_message_guarded` | Checks pause/budget and counts a 50-unit send. Preserve behavior when consolidating metering. |
| `youtube_quota.rs:507`, `budget_allows` | 2,500 soft budget; 80% sheds subscribers/thumbnails, 95% viewers, 100% sends. `ChatRead` and `GoLiveEssential` always allowed by the soft budget. |
| `main.rs:2706`, `prepare_youtube_stream_target` | Pre-counts three writes before any network result; auth retries and partial failure cannot be represented accurately. |
| `main.rs:2902`, `transition_youtube_stream_target` | Pre-counts one confirmation read although `youtube.rs::confirm_youtube_lifecycle_status` can perform multiple reads. |
| `scheduled_youtube.rs:24–193`, `YouTubeEvents::{send_with_refresh,request}` | Sends requests and handles retries without the shared quota guard/counter. Includes create/update/delete, bind, transitions and thumbnail calls. |
| `scheduled_streams_service.rs:101`, `youtube_api` | Supplies state only through optional `refresh_context`; this is `None` after a proactive refresh. Quota context must not depend on refresh eligibility. |
| `viewer_stats.rs:175`, `poll_youtube_count`; `audience.rs:844`, `read_source` | Count outside the token-renewal retry; an additional HTTP attempt is missed. |
| `viewer_stats.rs:651`, `run_viewer_sampler` | Remote YouTube interval controls the shared loop's sleep, also slowing other platforms when YouTube is present. |
| `viewer_stats.rs:35`, `ViewerAggregator`; `audience.rs:29`, `run_source` | Viewer freshness is 150 s. Subscriber refresh is 120 s on every source, only while streaming. There is no evidenced all-day idle subscriber polling to fix. |
| `youtube.rs:548`, `prepare_youtube_broadcast` | Creates a new `liveStream` marked `isReusable: true` on each preparation, with profile-specific fps/resolution. |
| `service_flags.rs:31–54`, `parse_service_flags` | Public flags refresh every 30 min; `stream` is read as `list`; missing/broken config falls back to compiled defaults. |
| `live_chat.rs:852–869,1091`, coordinator lifecycle | Session generation and owned task handles already prevent stale deliveries and abort readers. Extend this ownership instead of creating a second reader in the renderer. |

Examples to preserve:

```rust
// youtube_quota.rs::budget_allows: this is a soft policy, not a hard cap.
BudgetCall::GoLiveEssential | BudgetCall::ChatRead => true,

// youtube_chat.rs: cursor advances only after durable delivery succeeds.
try_deliver_messages(&state, session_generation, page.messages).await
// ... error handling before:
page_token = page.next_page_token;

// scheduled_youtube.rs: a non-idempotent request with an unknown result
// is surfaced for reconciliation, not blindly retried.
Err(error) => return Err(error).context("YouTube response unknown"),
```

Use Rust `Result`/typed errors and pure policy helpers with deterministic
tests, as in `youtube_quota.rs`. Keep Google reason codes bounded and sanitized.
Use the existing local database settings and secret store, not ad hoc files.
Reuse `SessionToken`, live-chat persistence and existing session task ownership.

## Execution order

| Slice | Deliverable | Depends on | Effort | State |
| --- | --- | --- | --- | --- |
| P0 | Baseline, endpoint inventory and monitoring preparation | — | S | PARTIAL: inventory and monitoring; live attribution pending |
| P1a | Shared request admission/metering primitive and scheduler integration | P0 | M | IMPLEMENTED / VERIFIED locally and with fake providers |
| P1b | Complete request coverage and accounting regressions | P1a | M | IMPLEMENTED / VERIFIED locally and with fake providers |
| P2 | Independent YouTube statistics timers and conservative cadence | P1b | S–M | IMPLEMENTED / VERIFIED locally and with fake providers |
| P3a | Live streaming-protocol and quota experiment | P1b; quota available | S–M | BLOCKED: no headroom; offline preflight tooling only |
| P3b | Durable streaming-chat reader and rollback control | P3a | L | BLOCKED: protocol/billing evidence unavailable |
| P4 | Compatible ingest reuse | P1b; live proof | M | DEFERRED: reuse remains disabled |
| P5 | Release, verified alerts, controlled rollout and capacity report | Relevant slices below | M + observation | PARTIAL: alerts enabled; no release/rollout |

P0 monitoring preparation and P3a live observation need not hold up local
P1/P2 work. P4 is optional for the first efficiency release. P5 may release
P1/P2 while P3 remains blocked; label that release accurately. The full plan
is complete only when P3's evidence and rollout criteria pass, or the owner
explicitly revises the target after reviewing the experiment.

## P0 — Establish the baseline without spending quota blindly

**Files:** new `docs/acceptance/2026-10-02-youtube-efficiency.md`, existing
`docs/youtube-service-flags.md`; proposed measurement script and helper tests
under `scripts/` only when implementing P3a. This planning pass writes none
of these implementation artifacts.

1. Fetch both repositories and perform the drift check. Record exact desktop
   and web SHAs, installed release versions, actual current project limit,
   Pacific quota day, latest usage and when metrics were sampled. Project
   number is `244529927041` (`videorc`). Treat the observed 10,007/10,000 on
   application day as historical, not current availability.
2. Inventory every Data API operation from the files listed above. Include
   OAuth **profile** lookup and the quota-reset probe, but exclude OAuth
   token exchange/refresh/revocation from the YouTube Data API unit counter.
   Separate attempts, estimated units, outcomes, retries and skips. Include
   `liveBroadcasts.update/delete` and rollback deletion, absent from today's
   endpoint enum. Record the published cost source/date.
3. Use the fake API to establish deterministic baseline counts for: quick
   Go Live/Stop, scheduled create/update/cancel/prepare/start/stop, failed
   preparation, 401 renewal, quota exhaustion, and an active/quiet chat.
   Keep baseline and target results in the acceptance note. Never call a
   scaled fake interval a real Google quota measurement.
4. Inspect the production `https://www.videorc.com/api/desktop/service-flags`
   response (status, schema, cache headers) and an updated packaged client's
   effective-flags log. The observed web code defaults to
   `{ "version": 1, "youtube": {} }`; verify deployed state instead of
   assuming it. Do not change production defaults during baseline capture.
5. Identify the real Google Cloud usage/limit metric and API method labels
   available for this YouTube project. Prepare 50%/80% daily usage alerts
   and the intended owner notification channel; do not assume generic Cloud
   quota metrics exist for this service. If only a console chart is exposed,
   document that limitation and a manual check procedure; do not declare
   automated monitoring complete.

**Verify:** `pnpm test:scripts`, `cargo test -p videorc-backend youtube_quota`
and `pnpm smoke:youtube-quota` pass at baseline, or record an existing failure
with scope and cause before changing code. Acceptance note contains the
endpoint inventory and actual monitoring availability, with no credentials.

## P1a/P1b — Meter the request that actually goes out

**Files:** `youtube_quota.rs`, new `youtube_api.rs` if a focused helper is
clearer, `scheduled_youtube.rs`, `scheduled_streams_service.rs`,
`scheduled_streams.rs`, `youtube.rs`,
`youtube_chat.rs`, `viewer_stats.rs`, `audience.rs`, `oauth.rs`, narrowly scoped
YouTube callers/module registration in `main.rs`; `state.rs` only for shared
admission ownership. Extend the existing fake API and quota/scheduling smokes.
Update only the YouTube call-boundary clause in `AGENTS.md` to require the new
shared `send_attempt` admission/metering API and identify its counted reset-probe
exception; do not leave future agents instructed to restore pre-counting.

1. Add one small request-admission/attempt boundary, parameterized by endpoint
   and priority. Production clients must hold quota state independently of
   token refresh state. Test constructors can inject a local quota context;
   do not make an unguarded production constructor the convenient default.
2. Validate locally first. Immediately before each HTTP attempt, atomically
   check the project-pause state and local policy, then record/reserve that
   attempt under the same admission lock. Do not hold the lock across network
   I/O. A request admitted before a pause may already be in flight; allow it
   to settle without starting new requests after the pause. Tests must state
   this boundary rather than promising cancellation of already-sent writes.
3. Retain the 2,500 soft budget and existing priority ladder. User-initiated
   scheduling/prepare/transition/cancel/cleanup are essential operations for
   this slice; thumbnails, statistics and sends keep their existing shedding
   policy. Label the allowance as soft. Admit a 50-unit send only if its
   projected spend fits the remaining local allowance; concurrent sends
   cannot both consume the last reservation. Never let a soft limit block
   Stop or alter media delivery.
4. Charge each attempted REST method at its published estimate, including a
   retried request. Network failure/rejection is conservatively an attempt;
   do not refund based on an assumption that Google never received it.
   Locally skipped and invalid-before-send requests cost zero locally. This
   is an estimate, not an assertion that every rejected write is billed 50.
5. Classify each response at this boundary, including non-JSON errors and
   scheduler thumbnail errors. Preserve higher-level typed scheduling and
   thumbnail errors. A quota refusal sets the shared breaker immediately;
   all paths obey it, including rollback calls. Preserve existing one-refresh
   auth behavior and bounded read retries; no new retries for uncertain POST
   results. The reset probe is a named, single-owner exception allowed at its
   deadline, not a blanket way to bypass the pause.
   Represent a local refusal as **not attempted**, distinct from a definite
   provider rejection and an ambiguous network outcome. The scheduling
   journal sets `create_uncertain` before calling the provider today; a quota
   admission refusal must not strand a definitely-unsent operation in unknown
   creation/recovery state. Integrate this distinction into its checkpoint and
   sanitized-error handling; do not manufacture an HTTP response to clear it.
6. P1a integrates scheduled operations and their direct uploads. P1b migrates
   all remaining operations from the P0 inventory, removing their old
   pre-counts. In particular, count each actual prepare step, rollback delete,
   transition confirmation poll, renewed statistics request, account profile
   lookup and quota probe exactly once. Keep OAuth endpoint requests outside
   this unit counter. Preserve the serialized refresh discipline across
   YouTube readers/senders (`platform_token_refresh`, `SessionToken`).
7. Preserve daily persistence across relaunch and Pacific rollover, with
   ordered writes so concurrent attempts cannot overwrite a newer total with
   an older one. No new lock may be held across an `await` or cause nested
   quota-lock acquisition. Persisted old totals remain readable.

**Regression cases:** paused scheduler emits zero HTTP calls; proactive token
refresh cannot remove its quota context; create failure does not count unsent
stream/bind writes; cleanup delete is counted if attempted; quota failure
prevents cleanup traffic and leaves a recoverable orphan indication; three
confirmation reads count three; 401 plus successful retry counts two; thumbnail
quota pauses every caller; a locally rejected send counts zero; concurrent
sends at the limit are admitted deterministically; failed persistence is
diagnosed; midnight and relaunch retain correct totals; ambiguous send failure
never produces an automatic duplicate; a locally blocked scheduled create
can be retried after reset without falsely requiring recovery/adoption.

Use existing `scheduled_youtube.rs` fake HTTP tests, `youtube.rs` captured
request tests, and `youtube_quota.rs` day/breaker tests as patterns. Extend
`fake-youtube-api.mjs` with request-cost summaries and outcomes, and assert
the app's counter matches all captured Data API attempts in the smokes.

**Verify P1a:** `cargo test -p videorc-backend scheduled`,
`cargo test -p videorc-backend youtube_quota`, `pnpm smoke:scheduled-streams`.
**Verify P1b:** the complete Rust gates below, `pnpm test:scripts`,
`pnpm smoke:youtube-quota`, `pnpm smoke:scheduled-streams`. All pass; no
production Data API path in the P0 inventory bypasses admission/metering.

## P2 — Slow YouTube statistics without slowing other platforms

**Files:** `viewer_stats.rs`, `audience.rs`, `youtube_quota.rs`,
`service_flags.rs`, `docs/youtube-service-flags.md`; quota comments/copy tests
in `apps/desktop/src/shared/backend.ts` and
`apps/desktop/src/renderer/src/lib/youtube-quota.ts` only if required by the
changed cadence. No new screens or settings controls.

Execution scope clarification (2026-10-02): include the existing YouTube quota
copy tests in `apps/desktop/src/renderer/src/components/comments-header.test.ts`
and `apps/desktop/src/renderer/src/lib/session-runtime-recovery.test.ts` for
clock-independent fixtures. Both fail on unchanged baseline `aac79ab4` late
in the local day because they assume a +2/+3-hour deadline cannot be tomorrow.
Preserve production copy; test same-day and next-day wording explicitly.

1. Keep the shared viewer loop's 60-second cadence for the other platforms.
   Schedule YouTube independently using monotonic due-times, not a modulo
   counter whose meaning changes with a remote interval. A non-due YouTube
   tick issues no request and does not refresh its last-observed timestamp.
   Remote intervals below 60 seconds require the scheduler to wake at the
   earliest provider deadline; other providers still run only when due.
   Due-times alone are insufficient: use independently cancellable, bounded
   provider work so a pending YouTube request cannot hold up the other
   providers. Never overlap two polls for the same provider. Record each
   result at its own observation completion, not at the end of a shared
   batch. All child work must terminate with the owning sampler on stop.
2. New compiled default: YouTube viewers 120 seconds; other platforms keep
   their existing cadence. `viewerSampleMs` applies only to YouTube. At 80%
   of the local allowance, enforce at least 120 seconds rather than doubling
   an already-conservative interval; at 95%, stop YouTube viewer calls.
3. New YouTube subscriber success interval: 300 seconds, with an initial
   reading to establish the baseline. Keep Twitch/X success intervals and
   existing backoff, hidden-count and pause behavior. This does not require
   a new remote setting in the first release.
4. Retain truthful freshness: skipped polls never re-stamp cached counts.
   The current 150-second viewer freshness threshold supports the normal
   120-second interval. If an owner deliberately requests a longer interval
   or a poll fails, existing stale/missing behavior is acceptable; do not
   inflate the threshold or invent zeros to hide missing data. Ensure the
   aggregator expires stale YouTube counts even when other platforms report.
5. A flag update recalculates the next deadline without issuing a catch-up
   burst. Use existing task cancellation on stop. A new session gets fresh
   baseline state; it does not inherit the previous session's due-time.

**Savings:** excluding startup/boundary effects, viewers 120→60 calls per two
hours and subscribers 60→24, saving approximately **96 units/session**. This
is arithmetic from the cadence, not measured production savings.

**Verify:** paused-time Rust tests over `[0,7200)` observe 60 YouTube viewer
calls and 24 subscriber calls, with the initial call included at `t=0` in the
deterministic harness. Other platform viewer counts match baseline (120 at
60 s). Also cover flag updates, backoff, 80%/95% shedding, stale expiry and
stop. Hold a YouTube request pending past another provider's deadline and
prove that provider still polls/emits on time, with no overlapping YouTube
requests and no orphan task after stop.
Run `cargo test -p videorc-backend viewer_stats`,
`cargo test -p videorc-backend audience`,
`cargo test -p videorc-backend service_flags`, `pnpm smoke:youtube-quota`;
run desktop tests/typecheck if shared comments or frontend helpers change.

**Gate-driven scope clarification (2026-10-02):** the scheduled smoke's wire
comparison exposed a pre-existing override mismatch: chat passes a bare API
origin to the viewer sampler, which requested `/videos` instead of
`/youtube/v3/videos`. Normalize bare origins and versioned roots in the scoped
viewer client, test both forms and trailing slashes, and set the smoke's global
YouTube loopback override so every Data API path belongs to the fixture. Keep
strict persisted-versus-wire equality; do not count malformed-path aliases.

## P3a — Prove the streaming contract and actual quota cost

**Files:** proposed `scripts/probe-youtube-efficiency.mjs`, helper and tests
under `scripts/lib/`, a package script `probe:youtube-efficiency`, narrowly
scoped debug probe plumbing if necessary, and the acceptance note. The
command is new work, not an existing runnable command at this baseline.

1. Prefer the documented `streamList` protocol. Google's current guide
   supplies a **gRPC** service/protobuf and OAuth bearer authentication.
   First test that documented path. The old REST `/messages/stream` URL is
   only a candidate; do not assume its framing or availability from a mock.
   Choose one implementation after evidence. If HTTP streaming is selected,
   record its supported endpoint and actual response framing; never parse
   an unbounded body as one JSON object.
2. Run only when the project has quota and a bounded owner test window is
   available. Use an owner's private/unlisted test broadcast selected for
   this purpose. Read existing credentials inside the backend; never print
   tokens, put them in command arguments, or put real chat/keys into fixtures.
   A helper may drive existing RPCs or a narrow debug-only measurement hook;
   it must not expose credentials or bypass production quota protections.
3. Before the first unknown-cost trial, record a preflight decision: remaining
   project headroom must be at least 50% of the actual daily allowance;
   protect at least 20% of that allowance for other users. Preflight metrics
   must have a sample no older than 10 minutes, with ingestion lag measured;
   otherwise defer the live trial. Limit known setup/teardown plus API-send
   estimates to 500 units and at most two paid test sends for the initial
   trial. Track this allowance in the probe, reserving teardown cost first.
   The first held connection lasts at most 60 seconds with at most three
   opens. Stop on quota/rate refusal, loss of attribution, headroom entering
   the protected reserve, or metrics becoming too stale to judge headroom.
   An unknown streaming charge and delayed metrics mean **this initial trial
   cannot guarantee a hard unit ceiling**; time and known-call bounds only
   limit exposure. Do not extend it until settled metrics justify doing so.
4. Measure quiet and active chat, graceful server close, idle behavior,
   reconnect using the last durable `nextPageToken`, stream end and token
   renewal. Progress from the initial probe to a 10-minute bounded trial,
   then a 30-minute one, only when the prior window's settled usage and
   attribution justify the next duration. Before the four-hour run, require
   a conservative predicted test cost plus teardown to fit entirely above
   the protected reserve; otherwise defer or choose a later quota day.
   Record connection opens, responses, message count, time connected, reads,
   sends and reconnect reasons. Owner-authored test messages can be entered
   in YouTube Studio; never simulate a busy chat with hundreds of paid API
   sends. Real send acceptance needs only a small explicitly counted sample.
5. Capture Cloud usage before/after, allow for its observed reporting delay,
   and separate setup/writes from reading. Use method-level attribution if
   exposed. Record concurrent production traffic and measurement uncertainty.
   Compare multiple quiet/active windows; do not infer a per-connection price
   from a single aggregate difference. Do not round an unresolved delta down
   to zero or describe the stream as free.
6. Select and document a conservative measured estimate, its scope and error
   bounds before enabling production streaming. Track connection/response/
   duration counters separately from estimated units. An unknown streaming
   cost stays unknown in diagnostics; it must not silently become a zero-
   unit endpoint in the existing integer cost enum. Keep streaming disabled
   publicly until an evidence-backed estimate and quota target are available.
7. Probe deliverables: protocol choice, sanitized/synthetic framing fixture,
   incremental parser/gRPC mapping requirements, error mapping, idle policy,
   cost model, measured lag and a go/no-go decision. If aggregate project
   traffic makes billing attribution impossible, request clarification from
   Google's application/support thread through the owner; continue P1/P2/P4
   and leave P3 rollout blocked. Do not create projects to evade the limit.

**Verify:** the proposed `pnpm probe:youtube-efficiency` must terminate within
its configured duration, emit a redacted result with observed counters and
measurement status, and exit nonzero for protocol/measurement failures. Its
helper tests run under `pnpm test:scripts`. Published acceptance evidence must
be attributable and reproducible; a green fake test is not the live go-ahead.

## P3b — Implement streaming chat with safe reconnects

**Files:** `youtube_chat.rs`, proposed focused streaming transport module,
`youtube_quota.rs`, `service_flags.rs`, `session_token.rs` only as needed,
`live_chat.rs` for owned cancellation only, `main.rs` module/probe wiring,
fixtures/tests and quota smoke. `crates/videorc-backend/Cargo.toml`, workspace
`Cargo.lock`, and scoped protobuf/build files only if the selected transport
needs them. Current reqwest lacks its streaming feature; there is no current
tonic/prost dependency. Resolve compatible maintained versions during
implementation rather than copying an unverified version from this plan.

1. Keep one reader in the backend, keyed by existing session ownership and
   broadcast chat. Preserve the send chat ID and the current normalization
   pipeline for text, deletions, moderation, Super Chats, memberships, gifts,
   polls and stream-end events. A gRPC implementation needs explicit enum/
   presence/oneof mapping; do not silently drop events supported by REST.
2. Deliver incremental responses immediately. Advance the cursor only after
   durable persistence succeeds. Reconnect with the last committed cursor;
   reuse existing message-ID deduplication. On invalid cursor, discard it
   once, recover available history, and report any unrecoverable gap.
3. Bound buffered response size and queues. For HTTP use a real incremental
   parser tolerant of arbitrary byte boundaries/UTF-8 splits and supported
   keepalives; for gRPC use its message framing and a bounded decode size.
   Backpressure and persistence failure must not accumulate unbounded RAM or
   acknowledge messages that were not stored.
4. Transient failures reconnect with jittered exponential backoff, capped at
   60 seconds; honor a longer provider cooldown. Quiet chat is not a stalled
   connection. Base transport liveness/timeouts on the P3a protocol evidence,
   not on how long it has been since somebody typed a message.
5. Keep `SessionToken` renewal available on a held connection. Do not rely on
   calling `ensure_fresh` only after a message arrives. Use a bounded token
   maintenance check; reopen with the cursor when a changed token requires
   it. A refusal allows one coordinated renewal before a reconnect-needed
   state. Repeated auth failures must not become a reconnect storm.
6. Map daily quota, rate limit, auth, permission, missing/ended chat and
   transient failure separately. gRPC `RESOURCE_EXHAUSTED` alone is ambiguous:
   inspect structured details, and if absent back off conservatively; do not
   assume either midnight pause or permission to hammer the endpoint.
   If needed, a single guarded REST diagnostic request can disambiguate;
   count it, and never start a parallel polling loop as diagnosis.
7. Watch pause/transport-change state while awaiting a quiet stream. Close
   the held connection on quota/remote pause, `off`, explicit switch to list,
   session stop, disconnect or session replacement. No stale generation may
   deliver or reconnect. Quota recovery resumes from the durable cursor.
8. Enable `chatTransport: "stream"` in new clients. Keep compiled default
   `list` for the first candidate and on malformed/unavailable config. Older
   clients already interpret `stream` as `list`, so schema version 1 remains
   compatible. Only an explicit unsupported transport signal may cause a
   bounded fallback to list; quota, auth, rate limit and transient errors
   must not silently switch transports. Log actual transport and reason.
   Switching modes closes the old reader before opening the next one.
9. Apply P3a's measured streaming billing function to the **same persisted
   daily allowance** used by REST and sends. Admission guards every stream
   open, including gRPC; subsequent response/time-based estimated accrual
   uses the shared ordered persistence path and triggers budget-step changes.
   If cost accrues by duration, checkpoint at most every 60 seconds and split
   accrual across Pacific midnight; if by response, use durable sequence
   accounting. Define rounding once (retain fractional remainder if needed)
   and prevent double charging on reconnect, retry or restored checkpoints.
   Connection counters are not substitutes for unit accrual. Unknown cost is
   visible and forbids public activation, not a zero-valued cost entry.
10. Extend the local fake to speak the selected streaming protocol. Its
   current `/stream` response is just a finite list-shaped object, so old
   tests cannot prove streaming behavior. If gRPC is chosen, add an owned
   loopback test server with readiness/shutdown signals. Do not leak a
   production credential through a dev URL override.

**Tests:** incremental delivery before close; arbitrary framing splits;
quiet connection; reconnect/cursor/dedup; persistence failure and bounded
buffering; auth renewal while idle; every error class; ended/disabled chat;
explicit unsupported fallback; streaming-to-list-to-off transitions; shared
quota pause from a scheduler request closes the reader; stop/restart and
opening Comments/Stream Manager produce at most one active reader per chat.
Also prove measured stream-unit accrual reaches the daily soft-budget ladder,
held-connection midnight rollover, reconnect without duplicate accrual,
rounding, ordered persistence/relaunch and unknown-cost diagnostics.

**Verify:** `cargo test -p videorc-backend youtube_chat`,
`cargo test -p videorc-backend session_token`,
`cargo test -p videorc-backend service_flags`, the full Rust gates,
`pnpm smoke:youtube-quota`, `pnpm smoke:live-chat-fake-providers` and dependency
advisory checks if dependencies change. The packaged live acceptance below
must pass before public activation. Cross-platform compilation is mandatory.

## P4 — Reuse an idle compatible ingest stream

**Files:** `youtube.rs`, `scheduled_youtube.rs`, `scheduled_streams_service.rs`,
`storage.rs`, `state.rs` only for a preparation lock, narrowly scoped YouTube
callers in `main.rs`, and tests. This is separate from changing media sessions.

1. Add a versioned local cache keyed by channel/account and the exact YouTube
   ingestion type, frame-rate, resolution and output role. Store stream IDs
   and compatibility metadata in SQLite; stream keys remain in the existing
   secret store. Existing instant-stream secret references are account/target
   based, while scheduled references are event/target based. Give each cached
   provider stream an unambiguous secret reference (or always fetch/rewrite the
   exact selected key under the owning reservation); two cached profiles must
   not overwrite a secret still referenced by another preparation. Preserve
   deletion/revocation semantics for all references on account disconnect.
   One stream per channel is insufficient for concurrent or
   incompatible outputs. Do not introduce a new vertical OAuth destination.
2. Before reuse, call `liveStreams.list` for the cached ID (1 unit). Verify
   ownership, `isReusable`, profile and provider idle state. **Idle is not
   unreserved.** Check both local scheduled `preparation` and `retained_ingest`
   records, active preparation leases, and the relevant provider broadcast
   `contentDetails.boundStreamId` bindings before treating it as reusable.
   Include active/upcoming broadcasts that could reserve that stream; if
   complete binding information cannot be obtained, do not reuse it. Count
   every extra binding read. Multiple installations cannot coordinate through
   the local cache:
   do not discover/adopt another install's ingests just to save a creation.
3. Serialize allocation and persist an ownership record before binding so
   simultaneous preparations cannot share an ingest inadvertently. Record the
   owning operation/broadcast and reservation state. Define transitions for
   prepare, confirmed bind, bind failure, cancellation, completed broadcast,
   failed completion and crash/relaunch. Reconcile uncertain ownership with
   provider state after restart; never release it merely because ingest is
   idle or a timer expired. Only confirmed teardown/unbinding/terminal state
   clears a reservation. Preserve scheduler ownership/lease rules. Missing,
   deleted or incompatible cached stream: invalidate and create once. Auth,
   quota and transient lookup failures must not trigger blind recreation.
4. Persist after creation succeeds; bind to the fresh broadcast as before.
   Recover deleted/rotated keys from the authoritative response and the secret
   store. Clear applicable cache on account disconnect. Do not delete reused
   provider streams during failed-broadcast rollback or cancellation.
5. Keep explicit `transition complete`, scheduled `enableAutoStop: false`
   behavior and Stop confirmation. Removing completion saves only 50 units
   and changes user-visible end timing; it is not part of this plan.

**Expected saving:** up to 49 units for each compatible reuse (50-unit
creation replaced by a 1-unit stream validation), **less any additional
broadcast-binding checks**. Record the net saving from captured requests.
If safe reconciliation costs as much as creation, defer reuse rather than
omit checks. First use and incompatible/active ingests have no reuse saving.

**Verify:** fake tests for warm reuse, first use, missing stream, incompatible
fps/resolution, upcoming-broadcast reservation, `retained_ingest`, simultaneous
preparation, crash/relaunch at each ownership transition, failed completion,
channel switch/disconnect, multiple cached-profile secrets, rotated key and
failed bind rollback. Run
`cargo test -p videorc-backend youtube`,
`cargo test -p videorc-backend scheduled`,
`pnpm smoke:scheduled-streams`, `pnpm smoke:youtube-quota`. Live acceptance:
two sequential broadcasts reuse the same ingest ID, both stream and reach
complete correctly, and a conflicting preparation never hijacks it.

## P5 — Operate and release with evidence

**Files:** `docs/youtube-service-flags.md`, acceptance note and release notes;
web `lib/desktop-service-flags.ts`, `app/api/desktop/service-flags/route.ts`,
`tests/desktop-service-flags.test.ts` only for an approved rollout document.
Follow the release skill for coordinated macOS/Windows packaging/publication;
do not modify signing, update feeds or release workflows as quota optimization.

### Project monitoring

- Configure verified 50%/80% alerts using the project's actual daily quota
  unit series and a verified owner notification channel. Record metric names,
  labels, alignment/reset semantics, policy IDs and notification test evidence.
  Separate units/day from requests/minute. Google Cloud Monitoring is the
  project-wide source of truth; local counters are estimates from one device.
- Report projected exhaustion from recent burn and remaining time to the
  Pacific reset, with the metric sampling delay visible. At 50%, inspect the
  method breakdown. At 80%, use the documented controls to shed optional work
  and, if necessary, slow list fallback. A 10-second floor halves active-chat
  polling requests relative to 5 seconds but adds chat delay; it does not
  improve a reader already polling at 10 seconds while idle.
- Existing controls can take about 35 minutes to reach an online client
  (30-minute refresh plus 5-minute cache). Old 0.9.125/0.9.126 clients ignore
  them entirely. These controls and delayed metrics are not a hard global
  spending guarantee. Do not add an automatic project shutdown or disable
  credentials as part of this plan.
- Prepare update/release guidance explaining the fixed quota behavior. Use
  existing consented release diagnostics/support evidence to establish tested
  client versions; do not infer upgrade adoption from download totals or add
  hidden device telemetry. Communication to users is a separate owner action.

### Candidate, enablement and rollback

1. P1/P2 can ship with list chat. Retain the 5-second active and 10-second idle
   floor. The new 120-second viewer default applies only to YouTube; avoid
   relying on a global remote viewer interval to fix old mixed-platform clients.
2. P3 candidate defaults to list. Exercise stream mode locally in an isolated
   debug candidate, then in a locally installed release-build candidate with
   a build-time stream default for owner acceptance (no credential-routing
   override). Public release artifacts retain list as the compiled default.
   This proves the packaged protocol/dependency stack before broad activation.
3. Only after live gates pass, deploy `chatTransport: "stream"` to enable
   capable public clients. The existing route has no percentage-cohort
   targeting: do not call this a 5% rollout. Old clients keep list. Observe a
   full Pacific day before expanding the capacity claim; require a week of
   aggregate usage for the revised capacity report.
4. Rollback is `chatTransport: "list"`; `off` is an explicit emergency chat
   pause. Verify a held reader reacts once the new flags are fetched, preserves
   the cursor where supported, and never runs both modes. Flag delivery is
   delayed; the per-client breaker remains the immediate local protection.
5. After Google actually grants additional quota, update the denominator in
   monitoring and recalculate the local allowance from measured workloads.
   Keep 2,500 while the project is limited to 10,000. A 4-hour/40-send session
   already costs 2,000 for sends, so the old allowance may shed sends even
   after reading is efficient. A candidate allowance of 6,000 can be evaluated
   after a 1,000,000-unit grant, but must not be raised automatically merely
   because an application was submitted. It still is not a hard guarantee.

### Numerical acceptance and capacity model

Use one broadcast, one reader, two hours, 20 explicit sends, and a **500-unit
setup/teardown allowance** for comparison with the application. The allowance
is deliberately conservative, not a measured fixed charge.

| Component | Existing model | Target after this plan |
| --- | ---: | ---: |
| Active list chat at 5 s | 1,440 | Streaming cost measured; target ≤144 |
| Viewer statistics | 120 | 60 |
| Subscriber statistics | 60 | 24 |
| Recurring reads incl. reconnect/lookup allowance | 1,620 before overhead | ≤300 total |
| Twenty chat sends | 1,000 | 1,000 |
| Setup/teardown allowance | 500 | 500 retained until measured |
| Total model | 3,120 | ≤1,800 if the measured read target passes |

The streaming chat target is at least 90% below continuously active 5-second
list polling, or 80% below steady 10-second idle polling. These are **targets**,
not claims about Google's undocumented streaming bill. If billing prevents
the target, record the real result and revise the plan before declaring success.
Do not subtract the 49-unit reuse saving again from an unchanged 500 allowance.

At the target, 50–150 such daily sessions model 90,000–270,000 units/day,
before product-wide idle/setup activity and reserve. For a conservative
planning limit use `floor(0.8 * approved_daily_units / observed_p95_session_units)`
with an explicit allowance for non-session traffic; do not divide by registered
users. Mixed workloads, repeated streams and heavy sending need their own
distribution. No capacity claim is based solely on the average or this model.

**Live acceptance matrix:**

- One 30-minute quiet and one 30-minute active trial with attributable Cloud
  usage; a continuous four-hour trial crosses token expiry, includes a forced
  connection interruption and clean stop. Capture observed statistics and
  stream cost separately. Do not burn quota solely to fill a graph.
- During connected active periods, chat publish-to-durable-delivery p95
  ≤5 seconds; clocks must be synchronized and initial historical messages
  excluded. Report reconnect gap separately. Every known test message that
  remains available to Google's cursor appears once; report any provider
  history loss rather than hiding it.
- Normal four-hour run has no unexplained reconnect storm, duplicate reader,
  unbounded memory growth or effect on RTMP/recording. Provider-forced closes
  and planned auth renewal are separately counted.
- Fake two-hour accounting matches captured attempts exactly; real estimated
  vs Cloud units are compared after metric delay, with uncertainty documented.
- Quota refusal, remote off, restart and fallback pass the maintained outage
  smoke; real macOS and Windows candidates can read/send/stop successfully.
- Warm ingest reuse passes its separate live test before P4 is enabled.

## Verification gates and repository boundaries

Commands verified from current package scripts/CI; success means exit 0 and
all relevant assertions pass. Run focused gates per slice, then broader gates
for the final candidate. The implementation evidence is recorded in the
linked candidate acceptance document; planned gates are not passed gates.

| Gate | Commands |
| --- | --- |
| Rust | `cargo fmt --check --all`; `cargo test -p videorc-backend`; `cargo clippy -p videorc-backend -- -D warnings` |
| Desktop/shared contract | `pnpm typecheck`; `pnpm lint`; `pnpm format:check`; `pnpm --filter @videorc/desktop test`; `pnpm build` |
| Scripts and quota scenarios | `pnpm test:scripts`; `pnpm smoke:youtube-quota`; `pnpm smoke:scheduled-streams`; `pnpm smoke:live-chat-fake-providers` |
| Dependency changes | `pnpm audit:deps` (Rust audit needs cargo-audit installed); maintained macOS, Windows and Linux compile/CI lanes |
| Web flag change | In web repo: `node --import tsx --test tests/desktop-service-flags.test.ts`; `pnpm test`; `pnpm typecheck`; scoped ESLint/Prettier checks on changed files; verify deployed response |
| Session lifecycle touched | `pnpm smoke:recording-studio` and, for session start/stop/monitor changes, `pnpm smoke:record-latency` per AGENTS.md |

Existing unrelated failures must be reproduced on the baseline and described;
never hide them or fix unrelated media/UI code to make this slice look green.
Run `smoke:recording-studio` if implementation touches recording/session params,
capture, preview, audio or encoding, not merely because the quota smoke streams
to a fake sink. For new Windows async/process tests, obey AGENTS.md's readiness
handshakes, owned-PID cleanup, 25 affected-filter repetitions and three full
Windows Rust-suite runs from PowerShell 7. No fixed sleeps as handshakes and
no `pgrep -f` cleanup. Do not use the untracked `dev-youtube-reviewer.sh` as a
test harness.

**Out of scope:** changing encoding/preview/audio; redesigning Comments or
Stream Manager; new public/admin dashboards; buying/sharding API projects;
scraping YouTube chat or automating its webpage as a product fallback;
customer-supplied API keys as the default onboarding path; cloud custody of
Google credentials; paid-send batching or speculative retry semantics;
skipping explicit Stop; new vertical OAuth streaming; extending other
providers; submitting another Google application.

Use branches such as `fix/096-youtube-request-accounting`,
`feat/096-youtube-streaming-chat`, and `perf/096-youtube-ingest-reuse` off fresh
main. One coherent slice per PR, with behavior and validation in its body.
Do not commit user-local files or real tokens/keys/chat recordings. Release
publication uses `videorc-release`; this planning request does not publish.

## Completion checklist and stop conditions

- [ ] P0 inventory, method-level baseline and real project limit recorded.
- [x] Every Data API request path is guarded/metered; fake counts agree,
  including scheduling, retry, cleanup and quota probe exceptions.
- [x] YouTube statistics use independent cadence; other platforms unchanged.
- [ ] Streaming protocol and cost are evidenced; no unknown cost treated as 0.
- [ ] Four-hour reader acceptance, cursor durability, renewal and rollback pass.
- [x] Ingest reuse either passes P4 or remains clearly disabled/deferred for
  the first release; no silent substitution of the auto-stop shortcut.
- [ ] Relevant platform, regression and release gates pass, with baseline
  limitations and remaining provider acceptance explicitly listed.
- [x] Project alerts are tested, or monitoring is explicitly still incomplete.
  Alerts evaluate and a recovery email was delivered; metric lag and attribution
  remain unmeasured, so full monitoring acceptance is still incomplete.
- [ ] Capacity report uses approved quota and observed traffic, not forecasts
  described as facts. Old-client limitations remain visible.
- [x] Update this slice table, Plan 094 reconciliation and `plans/README.md`
  without deleting their historical evidence.

Pause only the dependent slice and report concrete evidence if the transport
is inaccessible with the existing authorized scope, Google cost cannot be
attributed, the reuse probe changes ownership/stop semantics, or any claimed
quota target fails. Continue independent accounting/statistics work. Revise
the scope before touching unrelated systems or inventing a different provider
protocol. Do not silently declare partial work the full quota solution.

Maintenance: every new YouTube endpoint must enter the cost/admission inventory;
new transports need their own billing evidence; remote schema changes must
stay backward compatible; scheduling ownership and account disconnect must
remain part of reuse tests. Keep empirical stream-cost assumptions dated and
recheck them when Google's behavior or pricing documentation changes.

## Planning review

Reviewed against the baseline source and given a separate cold review on
2026-10-02. Incorporated explicit streaming-unit accrual, durable ingest and
secret ownership, isolation from slow provider requests, bounded live-trial
preflight, and scheduler not-attempted outcomes. Markdown links, fences,
whitespace and tracked diff checks passed. No application tests or live
provider tests were run during planning. This review covered YouTube quota
paths and their direct consumers, not a general audit of the media engine,
release infrastructure, website or other providers.

## Primary references (checked 2026-10-02)

- [Quota cost table](https://developers.google.com/youtube/v3/determine_quota_cost)
  — list reads 1, chat sends and relevant writes 50; `streamList` cost absent.
- [Streaming chat method](https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList)
  — held connection and continuation cursor.
- [Official gRPC guide and protobuf](https://developers.google.com/youtube/v3/live/streaming-live-chat)
  — protocol/authentication reference for the experiment.
- [List chat method](https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list)
  — server polling interval and recommendation to use streaming.
- [Broadcasts and streams](https://developers.google.com/youtube/v3/live/broadcasts-and-streams)
  and [liveStream resource](https://developers.google.com/youtube/v3/live/docs/liveStreams)
  — reuse is supported; ownership/profile checks remain our responsibility.
- [Cloud quota alerts](https://docs.cloud.google.com/docs/quotas/set-up-quota-alerts)
  and [quota metrics](https://docs.cloud.google.com/monitoring/alerts/using-quota-metrics)
  — discover supported metrics and configure actual alert policies.
