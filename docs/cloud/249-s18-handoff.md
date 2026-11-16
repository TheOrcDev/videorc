# Plan 249 S18: chat and Sidekick follow the cloud show

Status: implementation complete at source level; **no test of it was executed**
beyond the lightweight checks below (the owner deferred smoke, heavy suites,
builds and Rust compilation until all merges land on main). No real provider
credential, message, broadcast or paid call was used.

## Branch

- Desktop: `/Users/orcdev/projects/videorc-wt-249-s18`,
  `feat/249-s18-cloud-parity` on the S16 tip
  `5b340c09c` (`feat/249-s16-cloud-parity`, desktop PR #1442; it contains S4
  `6a142e936` and S3 `a93168fc4`). Uncommitted; the coordinator commits.
- Web: no change. `/Users/orcdev/projects/videorcweb` was not touched.

## S16 integration

S18 allocates no id. It reads S16's typed `CloudStatus::live_interval`
(`cloud_services::canonical_live_interval`): an interval is ended only when
`endedAt` is set; `endRequestedAt` alone is pending. An older server's absent
field stays unknown. A Go Live that still sees the previous, ended interval
records it as `supersededIntervalId`, never as its own. Close forgets the saved
identity only when S16 reports the End confirmed (phase not `ending`); a pending
End keeps it armed until the confirmation arrives as cloud state. S16's
provider settlement, scheduled ownership and S4's avatar admission are untouched.

## Behaviour

- **Identity:** a room's Go Live stores one backend-private `app_settings` row,
  `cloud.showServices`: show, canonical/superseded interval, this computer's
  cloud device id, first-attach time, and per enabled destination only target id,
  platform, auth mode, account id, broadcast id (YouTube at Go Live; X when
  `liveChat.x.start` names it), orientation and label. No URL, key, secret ref or
  token; no migration. `storage.rs` gains only a read-only query (below).
- **Resume / owner replacement:** after `cloud.room.resume`, `plan_reattach`
  skips (no talk show, owned elsewhere, off air, ended interval), keeps the
  running readers (one reader set), or attaches: YouTube/Twitch/Kick through
  `live_chat::resume_live_chat`, X through the existing `start_x_live_chat`
  path with the recorded broadcast (the connector reads this computer's X
  account and Videorc sign-in at runtime and parks visibly without them). A
  resume answered before the runner reports legs waits at most 20 × 500 ms.
- **History, duplicates, replies:** a resume keeps the transcript, its
  de-duplication set, first-time chatters, first-attach time, arrivals, stream
  record and a Sidekick already running for the show; after a relaunch they are
  seeded from SQLite. In a resumed session a redelivered row the bounded
  transcript no longer holds is checked against SQLite
  (`existing_live_chat_message_ids`) before it can fire a command, greeting,
  Sidekick turn or community record. Command replies now use a deterministic
  send-operation id per (session, trigger row, destination, part); the send
  layer persists it before any provider call and returns a stored one verbatim.
- **Restart checkpoint (no lost intent):** a chat row that may fire a command
  (new, an enabled command, D11-fresh) is written to one backend-private
  `app_settings` row, `chatCommands.pendingReplies`, _before_ its batch
  persists; a checkpoint write failure keeps the batch unpersisted and
  retryable. After the gates run, a planned reply keeps its exact text and a
  declined trigger is settled; the reply task settles it once it reaches an
  outcome. Every resume (`resume_live_chat`, in process or after a relaunch)
  recovers what is left: an unplanned trigger is planned through the same
  gates against now (D11 freshness, commands as they are now); a planned
  reply is answered once under its stable operation id (consent re-checked);
  anything past D11 expires with a log line. The row is bounded (64 triggers,
  oldest unplanned first; 120 s retention), owned by the running session, and
  needs no schema change.
- **Unknown versus lost:** a reply whose send the previous process left
  `sending` is marked delivery-unknown by the existing startup reconcile
  (`interrupted-before-confirmation`); recovery reports it as
  `chatCommands.replyFailed` "Videorc closed while the reply was sending, so it
  may already be in chat; it wasn't sent again." and never re-sends. A
  provider timeout keeps its own "didn't answer in time" report. A locally
  lost intent no longer exists in the window between consuming and planning.
- **Another computer:** a leg with no identity here, or whose account is not
  connected here, is a neutral explicit row saying why and what brings it.
  Credentials are never inferred from a leg existing.
- **Remote End:** every `cloud.state` is checked against the armed services
  (`plan_terminal`): an observed show end, another show, this interval's
  confirmed End, a replacing interval, or (older server) an observed legs-end
  while this show's readers run, releases them — stopping only that show's
  readers (`stop_talk_show_chat`, session-matched) and forgetting the identity it
  armed. A stale End for a superseded interval, a hand-off/takeover (existing
  path stops readers, identity kept for take-back) and the launch gap before the
  show is restored release nothing.
- **Sidekick facts:** planner activity/clock and the spoken-stop confirmation
  read the S1 output projection (live room → `live`, End with recording →
  `recording`); automatic sends skip platforms whose cloud leg failed while the
  room owns the chat; the local rule is unchanged.

## Acceptance case (maintained, not executed)

`pnpm smoke:cloud-parity -- --case services` now runs
`scripts/lib/cloud-parity-services.mjs`: the focused fake-provider tests, then
the dev app on the managed fake web with the local fake YouTube API
(`managedHarness('talk', 1, { youtube: true })`): renderer Go Live in a room,
a command answered once, host kill + relaunch with chat and a command posted
while detached, Resume, the backlog redelivered with no duplicate reply, a failed
leg, and a web-side End (legs cleared, interval `endedAt`) that must release the
readers with no reply afterwards. `assertServicesContinuity` judges the evidence.

## Remaining runtime limits (not waived)

- **Exactly once is not promised for the provider side:** a post the
  provider received but never confirmed (process killed mid-send, or a
  timeout) is reported as unknown and never re-sent, so it is at most once
  there. The local window between consuming a command and planning or sending
  its reply is closed by the restart checkpoint.
- **Recovery needs a resume:** the checkpoint is recovered when the show's
  chat resumes (cloud room Resume, relaunch + Resume, in-process reattach). A
  local, non-cloud session has no resume after a crash; its waiting triggers
  have no session to answer in and are dropped when the next session claims
  the row.
- **A command edited during the gap:** a recovered planned reply keeps the
  text it was planned with. A trigger re-planned after its reply text changed,
  whose first part had already started, is refused by the send layer's
  operation binding and reported as "couldn't send", never posted twice.
- **Command freshness:** existing plan 226 D11 still ignores commands older than
  60 s, so a command sent during a longer detach, or recovered more than 60 s
  after it was sent, stays in the transcript but gets no reply (the expiry is
  logged).
- **Provider redelivery window:** chat the provider no longer redelivers after a
  reconnect (provider-side retention) cannot be recovered by the app.
- **Owner replacement on two live desktops, X, Sidekick sends and the
  interrupted command window** are proved only by source-level fake-provider
  tests (the window by a deterministic fixture that stops between persisting
  the row and planning); the real-page case uses one app,
  YouTube only, and no Sidekick (its AI is a paid call).
- The armed-services mirror is process-global; parallel backend tests that
  arm it can observe each other (none do today).

## Lightweight evidence

See the coordinator report for exact commands and results.
