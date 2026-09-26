# Plan 066: Kick chat never connects, and the Stream Manager should show all of Kick

> Executor: this is a diagnosis handoff plus an implementation plan. Read
> `AGENTS.md` first. Desktop work goes in a dedicated worktree off current
> main (`f0e57b32` or later; this plan was written in
> `../videorc-wt-kick-chat` on `feat/kick-chat-live`). Web work goes in
> `~/projects/videorcweb` on its own branch off `main` (`904289c2` or later).
> Never read `videorcweb/.env`: a permission rule denies it, and production
> database commands are run by the owner in their own shell.

## Status and decisions

- Status: PLANNED 2026-09-26. Diagnosed from the owner's two Kick streams
  that day (sessions `63ede4bb…` at 13:55Z on 0.9.114, `f2758d7d…` at 20:40Z
  on 0.9.115) and from the videorc-web production request logs.
- **S0 alone fixes Kick chat for every 0.9.113+ user without a desktop
  release.** The desktop connector is correct. It never got past its first
  step because the relay's tables do not exist in production.
- The rest of the plan makes the failure impossible to miss next time (S1,
  S2) and makes Kick a full Stream Manager citizen: viewers, chat, follows,
  subs, gifted subs, KICKs, reward redemptions and bans (S3 to S6).
- Owner decisions (2026-09-26): (1) run migrations automatically on
  production deploys, recorded in a ledger; (2) leave reward redemptions
  out for now (`channel.reward.redemption.updated` is not relayed or
  subscribed); (3) list each KICKs gift in Activity, no stats-bar total.
  `livestream.metadata.updated` is also left out: nothing shows it yet.
- S0 done by the owner 2026-09-26 (~21:00Z): 0015 applied, webhook URL set to
  www. Execution 2026-09-26: desktop on `feat/kick-chat-live` (this
  worktree), web on `feat/kick-relay-all-events`
  (`../videorcweb-wt-kick-events`). S6's live checklist is owed.
- Execution notes (desktop): the five new events are optional. If Kick
  refuses one (a per-event error, or a 4xx on a batch that holds one), chat
  still connects with the core three and the refusal is logged once
  (`KickSubscriptions::skipped`). Kick has no sub tiers, so Activity says
  "Subscribed" and "Gifted a sub", never "at a sub". A single-giftee gift is a
  `sub-gift` with the recipient; more is a `community-sub-gift`. A ban with an
  end time reads "timed out". The fake Kick provider emits a KICKs gift, so
  `smoke:live-chat-fake-providers` covers the new variant end to end.

## Findings

### A. The production database never got migration 0015 (root cause)

- Every relay call fails with `relation "kick_chat_bindings" does not exist`
  (Postgres `42P01`), from the videorc-web production logs:
  - `POST /api/desktop/kick-chat/bind`: 500 eleven times, 13:55:41Z to
    13:57:16Z, and eight times, 20:40:50Z to 20:41:25Z (the connector's
    backoff: 0.5 s, 1 s, 2 s … 30 s).
  - `DELETE /api/desktop/kick-chat/bind`: 500 at 13:57:39Z and 20:41:47Z
    (the session-end cleanup).
  - `GET /api/kick-chat/maintenance`: 500 **every hour** since the relay was
    deployed (`delete from "kick_chat_events" …`). No alert fired.
- The X relay's hourly maintenance answers 200, so 0014 was applied and
  only 0015 was missed. Migrations are applied by hand; `docs/kick-chat.md`
  step 1 says "Apply 0015" and nothing checks that anyone did.
- Desktop evidence (local app data): health event `kick-live-chat-failed`
  at 13:56:45Z: "Kick live chat has failed 8 consecutive connection attempts
  and keeps retrying: Kick chat relay answered HTTP 500 Internal Server Error
  (unknown): request failed". `backend.log` has "Could not remove the Kick chat
  relay binding: … HTTP 500" at both session ends.

### B. Because bind fails, Kick was never asked to send anything

`run_kick_chat_session` (`kick_chat.rs`) goes bind → create the event
subscriptions → long-poll. Bind failed, so no Kick event subscription was
ever created. That matches the logs: zero `POST /api/webhooks/kick`
requests in 30 hours.

### C. The Kick webhook URL points at a redirect

Plan 063 set the Kick app's webhook URL to
`https://videorc.com/api/webhooks/kick`. That URL answers **307 →
`https://www.videorc.com/api/webhooks/kick`**; the www URL answers 400 to an
unsigned POST, as it should. It is unproven whether Kick's delivery client
re-POSTs through a 307 with the same body and signature headers. Point the
app straight at the www URL and stop relying on it.

### D. The UI said "Reconnecting" and hid the reason

- The relay handlers do not catch storage errors, so the desktop gets a bare
  500 with no error code and prints "(unknown): request failed".
- The connector treats every non-401 relay error as retryable, so the
  provider sits in `reconnecting` for the whole stream. The reason exists
  only in the Stream Manager status bar's hover title
  (`providerCapabilityTitle`) and, after 8 attempts, in a health event.
  Nothing lands in `backend.log` per attempt, so support bundles are blind
  too.

### E. Viewer counts exist but are unproven, and "0" is ambiguous

- `viewer_stats.rs` polls `GET /public/v1/channels` every 30 s and feeds the
  Stream Manager viewer total (plan 055 aggregator, 75 s freshness).
- Both Kick sessions logged only `{"platform":"kick","count":0}`.
  `parse_kick_viewer_count` returns `Some(0)` whenever `stream.is_live` is
  false, so "Kick has not marked the channel live yet" looks exactly like
  "nobody is watching". The 20:40Z stream lasted 58 s, so both samples may
  have been taken before Kick flipped `is_live`.
- No Kick session has ever shown a count above 0. That needs a live check
  with a second viewer.

### F. We relay 3 of Kick's 10 webhook events

Kick documents (docs.kick.com/events/event-types, checked 2026-09-26):
`chat.message.sent`, `channel.followed`, `channel.subscription.new`,
`channel.subscription.renewal`, `channel.subscription.gifts`,
`channel.reward.redemption.updated`, `livestream.status.updated`,
`livestream.metadata.updated`, `moderation.banned` and `kicks.gifted`.
We subscribe to the first, second and seventh only. Every one is covered by
`events:subscribe`, which the Kick connection already grants, so **no user
has to reconnect Kick**. `ensure_kick_subscriptions` already creates only
the missing events, so a longer list heals existing users on their next
stream. The Activity pane and status bar still say Kick "doesn't share tips";
`kicks.gifted` makes that false.

### G. Out of scope, but seen

The 20:40Z session also logged `mic-silent` ("MacBook Pro Microphone
captured only silence"), so that stream probably went out without audio.
The previously selected mic (CoreAudio device 108) was missing at launch.
That is a separate issue.

## Design decisions

1. **Fix production first, then make the class of bug loud.** S0 is owner
   actions only, with no code or release. S1 makes a missing table show as a
   named 503 and a failed readiness check instead of a silent hourly 500.
2. **The relay answers structured errors only.** Storage failures become
   `503 { error: { code: "kick-chat-relay-unavailable" } }`. The desktop keeps
   retrying (the relay can heal mid-stream) but says so in plain words.
3. **"Reconnecting" means a recent success.** After 3 failed attempts in a
   row with no successful read, the provider moves to a new visible
   `unavailable`-style message ("Kick chat can't connect: Videorc's chat
   relay is down. Retrying every 30 s."). It keeps retrying, stays `warn` toned
   (not `failed`, which is terminal), and shows the reason inline in the
   Stream Manager, not only on hover. Reuse the existing `waiting` state and
   message instead of adding a new wire state, so there is no contract change.
4. **Kick events map onto the existing Stream Manager vocabulary.** Subs,
   renewals and gifted subs use `LiveChatEventDetails::Subscription` (the
   Twitch shape). KICKs get one new detail variant (`Kicks`) with
   `event_type = Paid`. A reward redemption gets one new variant
   (`Redemption`). A ban uses `event_type = Moderation`. No new window,
   pane or tab.
5. **Viewer count: never show a fake 0.** While Kick says `is_live: false`,
   the Kick count is `None` (unknown), not `Some(0)`. The status bar shows
   "Kick: waiting for Kick to go live" in its hover title until the first
   live read or the `livestream.status.updated` event.
6. **Per the serde null trap** ([videorc-serde-null-contract-trap]), every
   new `Option` field on a wire struct gets
   `skip_serializing_if = "Option::is_none"` and a matching optional
   field in `backend-rpc-contract.ts`.

## Slices

### S0. Owner: make the relay exist (no code, about 10 minutes)

1. Apply migration 0015 to production Neon, from the owner's shell (the SQL
   is idempotent, `IF NOT EXISTS` throughout):

   ```sh
   cd ~/projects/videorcweb
   # only if .env's DATABASE_URL is the production database;
   # otherwise paste the file into the Neon console SQL editor
   set -a; . ./.env; set +a
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0015_add_kick_chat_relay.sql
   psql "$DATABASE_URL" -c "select to_regclass('kick_chat_bindings'), to_regclass('kick_chat_events');"
   ```

2. In the Kick developer app settings, change the webhook URL to
   `https://www.videorc.com/api/webhooks/kick`, and leave "enable webhooks"
   on.
3. Go live on Kick from 0.9.115 for 3 minutes. From another Kick account,
   send a chat message and follow the channel.

Done when: the chat message appears in the Stream Manager within about 5 s;
the follow appears in Activity; the Kick provider shows connected (green
dot); the production logs show `POST /api/desktop/kick-chat/bind` 200 and
`POST /api/webhooks/kick` 200; the next `:47` maintenance run answers 200;
the session end logs no "Could not remove the Kick chat relay binding".

### S1. Web: storage failures are named, and readiness is checked

- `lib/kick-chat/relay.ts`: wrap binding and event storage calls; on any
  storage error return `jsonError("kick-chat-relay-unavailable", "Kick chat
  is temporarily unavailable.", 503)` and log the Postgres code (never the
  params). Do the same in the X relay handlers if they share the gap.
- `app/api/kick-chat/maintenance/route.ts` (and the X one): check both
  tables with `to_regclass` first, and answer
  `503 { error: "relay-tables-missing", tables: [...] }` so the Vercel log
  names the cause.
- Decision 1 = runner: add a `schema_migrations(name, applied_at)` ledger
  and `scripts/db-migrate.mjs`, which applies `db/migrations/*.sql` in order,
  each in a transaction, and skips names already recorded. Seed the ledger
  with 0000 to 0015 after S0. Run it from `vercel-build` only when
  `VERCEL_ENV === "production"`. Preview builds must never touch the
  production database.
- `docs/kick-chat.md`: the www webhook URL, the runner (or the manual step
  and readiness check), and a "verify after deploy" line.
- Tests: `tests/kick-chat-relay.test.ts` covers a throwing `saveBinding`,
  `getBinding`, `listEventsAfter` and `deleteBinding`, each giving 503 plus
  the code. Add a runner unit test (ordering, skip, rollback on failure)
  against an in-memory fake.

Done when: `pnpm lint`, `pnpm typecheck` and `pnpm test` are green in
videorcweb; a local run against a database without 0015 returns 503
`kick-chat-relay-unavailable`, not a bare 500.

### S2. Desktop: say why Kick chat is not connecting

- `kick_chat.rs` `run_kick_chat_connector`: keep retrying, but after 3
  failed attempts in a row with no successful read, emit
  `LiveChatProviderConnectionState::Waiting` with a plain message mapped
  from the error:
  - `kick-chat-relay-unavailable` or any 5xx: "Kick chat can't connect:
    Videorc's chat relay is down. Retrying every 30 s."
  - network error: "Kick chat can't reach Videorc. Retrying every 30 s."
  - otherwise the relay's own message.

  Back to `Reconnecting` only after the connection was ready once. Log every
  distinct error to `backend.log` once per session (`emit_log("warn", …)`),
  not per attempt.
- `RelayClient::parse`: when the body has no JSON error code, say
  `HTTP 500` without "(unknown): request failed".
- `stream-manager-status-bar.tsx`: when a provider is `waiting` or
  `failed`, show its message inline, truncated, next to the platform chip,
  with the full text on hover. Everything else stays quiet (plan 057 D3).
  UI work follows `.claude/skills/videorc-design/SKILL.md`.
- Tests: extend the `kick_chat.rs` mock relay with a `ServerError(n)` mode.
  Assert `Waiting` plus the relay-down message after 3 attempts, then
  `Connected` once the mock recovers, with no terminal state. Add renderer
  unit tests for the inline message.

Done when: `cargo test -p videorc-backend kick_chat`, clippy and
`pnpm --filter @videorc/desktop test` pass, and
`scripts/smoke-live-chat-fake-providers.mjs` still passes.

### S3. Web: relay every Kick event

- `lib/kick-chat/webhook.ts`: normalize the 7 missing events into compact
  rows keyed by `broadcaster.user_id`. New kinds: `subscription` (new,
  renewal: subscriber, duration months), `gift` (gifter, giftees usernames,
  count), `kicks` (sender, amount, gift name, tier, message), `reward`
  (redeemer, reward title, cost, user input, status), `ban` (banned user,
  moderator, reason, expires_at) and `metadata` (title, category). Drop
  anything not needed for a row, the same as chat today.
- `db/migrations/0016_widen_kick_chat_kinds.sql`: replace the `kind` CHECK
  constraint with the widened list (drop and add; idempotent guard). Apply
  it through the S1 runner, or by hand before deploy if decision 1 said no.
- Tests: add signed fixtures per event from Kick's documented payload
  examples in `tests/fixtures/`; add webhook tests (stored rows, dedupe on
  message id, unknown event still answers 200).

Done when: the videorc-web gates are green; the table accepts every new
kind after 0016; deployed to production **before** S4 ships.

### S4. Desktop: subscribe to them and show them in the Stream Manager

- `KICK_SUBSCRIPTION_EVENTS`: add all 7 new events (version 1). Existing
  users get them on the next session through `ensure_kick_subscriptions`.
- `relay_event_to_message`, one arm per new kind:
  - `subscription`: `Membership` event with
    `LiveChatEventDetails::Subscription { Sub | Resub, months }`.
  - `gift`: `Subscription { CommunitySubGift, gift_count }`, one row per
    gift (not per giftee).
  - `kicks`: new `LiveChatEventDetails::Kicks { amount, gift_name, tier }`,
    `event_type = Paid`, with the gift message as the text.
  - `reward`: not built (decision 2).
  - `ban`: `event_type = Moderation`, system row "<moderator> banned
    <user>".
  - `metadata`: no row; update the dashboard's broadcast title if one is
    shown.
  - `status` `is_live: true`: mark Kick live for viewer freshness (S5).
- Contract: `backend-rpc-contract.ts` and `shared/backend.ts` gain the two
  detail variants (bounded strings, optional fields), and
  `backend-rpc-contract.test.ts` covers them.
- Renderer: `stream-activity.ts` and `activity-pane.tsx` render Kick subs,
  gifts, KICKs and redemptions with the same rows Twitch uses; the Kick
  follow row is unchanged. Decision 3: KICKs are not summed anywhere. Remove "doesn't share tips" from `activity-pane.tsx` and
  the status bar title. Window-only glyphs go in
  `components/stream-manager/activity-icons.tsx`, never the shared icon
  registry (eager-chunk trap, plan 055).
- `crates/videorc-backend/src/audience.rs`: count subs and gifts into the
  Kick audience delta the way Twitch subs are counted, if that path exists
  for Twitch. Otherwise Activity rows only.
- Tests: a mapping unit test per kind with the S3 fixtures' relay shape;
  the mock relay delivers one of each and asserts the persisted rows; add
  renderer tests for the Activity rows and the KICKs total.

Done when: backend tests, clippy, desktop tests, `pnpm typecheck`,
`pnpm lint` and the renderer eager budget are green (CI is the budget gate;
Mac reads about 1.6 KB high).

### S5. Desktop: an honest Kick viewer count

- `parse_kick_viewer_count`: return `None` while `is_live` is false
  (unknown), and keep `Some(n)` once live. Update the
  `parses_kick_viewer_count` test: offline gives `None`.
- `audience`/`viewer_stats`: while Kick has not been seen live this session,
  the status bar hover title says "Kick: waiting for Kick to show the stream
  as live". It clears on the first live read or the `status` relay event.
- Keep the 30 s cadence (the same as every platform).

Done when: unit tests pass, and in the S6 live run a second viewer shows up
as Kick ≥ 1 within 60 s of Kick showing the stream live.

### S6. Gates and live acceptance

Local gates: `cargo fmt --check --all`, targeted
`cargo test -p videorc-backend kick` and `viewer_stats`, `cargo clippy -p
videorc-backend -- -D warnings`, `cargo build --release -p videorc-backend`
(the release-build cfg trap), `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm --filter @videorc/desktop test`, `pnpm build`,
and `node scripts/smoke-live-chat-fake-providers.mjs`.

Owner live checklist, one Kick stream of about 10 minutes, with a second
Kick account on a phone:

- [ ] Chat both ways: phone to Stream Manager within about 5 s, and a
      Stream Manager send appears on kick.com.
- [ ] Follow: a named Activity row appears.
- [ ] Viewer count: ≥ 1 within 60 s of kick.com showing live, and it drops
      after the phone leaves.
- [ ] KICKs gift (smallest amount): Activity row plus the stats total.
- [ ] Sub or gifted sub (optional, costs money): Activity row.
- [ ] Wi-Fi off for 20 s, then on: the state shows reconnecting, then
      connected, and no message is lost or duplicated.
- [ ] Stop: no unbind warning in `backend.log`; the production log shows
      the Kick subscriptions deleted.

Windows and Linux use the same relay, but do not claim Kick chat there
before an on-box run (plan 063 rule).

## Out of scope

- The silent-microphone session (finding G).
- Kick moderation actions from Videorc (`moderation:ban`,
  `moderation:chat_message:manage` need new scopes and a reconnect).
- Kick chat history before the stream starts (the relay reads "from now").
- A follower total for Kick (the API has none).

## Routing

- S0: owner.
- S1, S3 (web) and S2 (desktop plumbing): Implementation, `gpt-5.5`.
- S4 and S5 cross the backend, the contract and the Stream Manager UI:
  Implementation with the videorc-design skill, `fable-5` (multi-system,
  user-facing). Use an `opus-4.8` pass for the Activity row copy.
- Order: S0, then S1 and S2 in parallel, then S3 (web deploy), then S4 and
  S5, then S6.

## Verification commands

```sh
# desktop
cargo fmt --check --all
cargo test -p videorc-backend kick
cargo test -p videorc-backend viewer_stats
cargo clippy -p videorc-backend -- -D warnings
cargo build --release -p videorc-backend
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter @videorc/desktop test
pnpm build
node scripts/smoke-live-chat-fake-providers.mjs

# web (~/projects/videorcweb)
pnpm lint && pnpm typecheck && pnpm test

# production relay health (owner or agent)
npx vercel@latest logs --environment production --since 2h --query "kick"
```
