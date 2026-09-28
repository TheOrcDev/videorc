# Plan 071: Activity names each new follower, with their avatar

Status: **IMPLEMENTED 2026-09-28** (S1 to S5 code) on
`plan/071-named-followers`, with web PRs videorc-web #56 (Kick) and #57 (X).
See [Implementation record](#implementation-record-2026-09-28). Owed: S0's X
follow check and S5's acceptance stream on the owner's accounts. Planned
against `origin/main` `4d36bd76` (0.9.120).
Priority P1. Size M-L. There are 6 slices, S0 to S5. Two repos are involved:
`videorc` (desktop) and `videorc-web` (`~/projects/videorcweb`: the Kick relay
in S3 and the X relay in S4).

## Where and how to run it

- Work in the worktree `~/projects/videorc-follower-plan`, on branch
  `plan/071-named-followers`. Other sessions switch branches in the main
  checkout, so don't work there. Rebase onto `origin/main` before starting.
- Open one desktop PR for the whole plan, plus one web PR each for S3 and S4.
- Order: S0 → S1 → S2 → S3 → S4 → S5.
  - Only S4 waits on S0's X answers. S1–S3 can start at once.
  - Each slice leaves the app working and ends with its own commit.
- Don't read `videorcweb/.env`. When a step needs X or database credentials,
  the owner runs it in their own shell.

## Goal

When someone follows during a live stream, the Stream Manager's Activity row
should show **that person's avatar and name**, so the streamer can say
"Thank you, @name" out loud or in chat. A row that can only say "New follower"
is a fallback for what a platform refuses to tell us. It should not be the
normal case.

## What the owner saw

Screenshot from 2026-09-28: Activity → Follows 2, with two rows. Each row shows
a generic person-plus glyph with a platform badge, the title **"New
follower"**, and "2m". One row has the X badge and the other has the Twitch
badge.

Both rows are **unnamed follower gains**, not follow events. The code path
works like this:

1. `crates/videorc-backend/src/audience.rs` polls each platform's follower
   total every 120 s. When a read goes above the session's highest total, it
   appends a `FollowerGain { at, count }`.
2. `apps/desktop/src/renderer/src/lib/stream-activity.ts`
   `itemsFromFollowerGains` turns each gain into an `ActivityItem` with
   `name: 'New follower'` and `unnamed: true`. This happens for X always, and
   for Twitch when `audienceScopes === false`.
3. `apps/desktop/src/renderer/src/components/stream-manager/activity-pane.tsx`
   `ActivityRow` **always** renders the kind glyph (`KIND_ICONS[item.kind]`)
   in the 28 px tile. `item.authorAvatarUrl` is never rendered. This applies
   even to named rows.

## Per-platform truth (checked 2026-09-28)

| Platform | Who followed                                                                                                                                                                                                                                                                                                                    | Avatar                                                                                                                                                                         | Today in Videorc                                                                                                                                                                                         | Gap                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Twitch   | EventSub `channel.follow` v2 has `user_id`, `user_login`, `user_name`, `followed_at`. It needs the **opt-in** `moderator:read:followers` scope.                                                                                                                                                                                 | Not in the event. Helix `GET /users` returns `profile_image_url`. `TwitchAvatarCache` in `twitch_chat.rs` already backfills it for every EventSub row that has an `author_id`. | Named rows arrive only after the user pressed the opt-in reconnect in Livestream → Setup (`streaming-tab.tsx:1191`). The owner's account had not done this, so it produced a count-only row.             | The scope is hard to find. The row doesn't render the avatar.                                                                                         |
| Kick     | The `channel.followed` webhook body has `follower { user_id, username, profile_picture, … }`.                                                                                                                                                                                                                                   | `profile_picture` is in the webhook.                                                                                                                                           | Named rows exist. The relay (`videorc-web lib/kick-chat/webhook.ts` ~l.475) forwards only `followerId` and `followerUsername`. Desktop `RelayFollowPayload` (`kick_chat.rs:201`) has no avatar.          | The relay drops the avatar. The row doesn't render it anyway.                                                                                         |
| X        | The **X Activity API (XAA)** has a `follow.follow` event. Its `direction: inbound` filter means "someone followed this user". The payload's `source.data` is the follower: `id`, `username`, `name`, `profile_image_url`. This is the same XAA that the Livestream API uses for `broadcast.chat`, which Videorc already relays. | `profile_image_url` is in the event (`pbs.twimg.com` is already in the avatar allowlist).                                                                                      | Count only: `GET /2/users/me` `public_metrics.followers_count`. `docs/specs/stream-manager-provider-facts.md` says "X doesn't share who followed". That is out of date, because XAA added follow events. | Subscribe to `follow.follow` (inbound) next to `broadcast.chat`, and relay it the same way. S0 confirms the auth and the tier on the owner's account. |
| YouTube  | No follow or subscribe events. `subscriptions.list myRecentSubscribers` lists only public subscriptions, and YouTube OAuth is off in public builds.                                                                                                                                                                             | n/a                                                                                                                                                                            | Subscribers total only, with no gains (`follower_gains_count_only_new_highs_and_never_youtube`).                                                                                                         | **Out of scope.**                                                                                                                                     |

Existing pieces this plan reuses:

- The avatar cache and host allowlist in `apps/desktop/src/main/avatar-cache.ts`.
- `useCachedAvatar` and `AvatarCircle` in `apps/desktop/src/renderer/src/lib/chat-avatar.tsx`.
- `thankYouDraft` in `stream-activity.ts`: `Thanks for the follow, @name!`.
- Orcle's follow thanks (`cohost_ack.rs`). Named follow rows reach Orcle with
  no extra work.

## Routing

- Owner route: **Implementation**, orchestrated per slice. Fit 8. The work is
  cross-system (Rust, renderer, two web relays, the X Activity API), but every
  slice has a clear target.
- Model lanes:
  - S1 (row design): `opus-4.8`, cosmetic.
  - S2, S3, S5: `gpt-5.5`.
  - S4 (X follows over XAA, across web and desktop): `fable-5`, because it
    spans two repos, a public webhook and an external API.
- Read `.claude/skills/videorc-design/SKILL.md` before S1 and S2.

## Out of scope

- YouTube subscriber names.
- Showing follower avatars **on the stream** (the highlight card or overlay).
  Show on stream stays text-only for follows. This can come in a later plan.
- Retroactively naming follows from before this plan ships.
- Twitch Helix follower-list reconcile for follows EventSub missed during a
  reconnect. Add it only if S5 acceptance shows missed rows.
- Changing Twitch's _base_ scopes. That would force every existing connection
  to reconnect.

## Slices

### S0: Facts on the owner's accounts (read-only, no code)

Answer these questions and record the answers in
`docs/specs/stream-manager-provider-facts.md` under X and Twitch:

1. **X follow subscription, app-bearer probe.** The owner runs a throwaway
   script from the scratchpad, never committed, in their own shell with
   `X_BEARER_TOKEN` exported. The script does four things:

   - `POST /2/activity/subscriptions` with **no** `webhook_id`, so events go to
     the persistent stream and not to production:

     ```json
     {
       "event_type": "follow.follow",
       "filter": { "user_id": "<owner id>", "qualifiers": { "direction": "inbound" } },
       "tag": "videorc follow probe",
       "expires_at": "<now + 1 h>"
     }
     ```

   - holds `GET /2/activity/stream` open;
   - prints each event's `event_type`, `source.data.id`, `username`, `name`,
     `profile_image_url` and `target.data.id`, and nothing else;
   - deletes the subscription on exit.

   Then the owner follows from a test account. After that, they unfollow and
   re-follow once, to see whether X fires a second event.

   Record four things:

   - whether the create call was accepted;
   - the delivery delay;
   - that `target.data.id` is the owner;
   - whether the re-follow fired a second event.

   Background:

   - The docs accept app bearer, OAuth 1.0a user and OAuth 2.0 user auth
     (`tweet.read` covers `follow.*`).
   - `follow.follow` isn't in the docs' public or private event lists, so the
     answer has to come from trying it.

2. **If app bearer is refused as a private event:** this doesn't stop S4. The
   user-context subscription (OAuth 1.0a, which is how `broadcast.chat` is
   subscribed today) is proven by S4's first step, the gate described there.
3. **Access and cost.** Record from the owner's developer console whether the
   app's tier includes `follow.follow`, and any per-event price. Record the app's
   subscription cap (self-serve is 1,500 app-wide). Each live X streamer would
   now hold 2 subscriptions instead of 1, so the cap allows about 750
   concurrent X streamers.
4. **Twitch scope state.** Record which `account.scopes` the owner's Twitch
   connection holds. We expect `moderator:read:followers` to be missing, which
   explains the screenshot.

Done when: the facts doc has the answers. If step 1 fails with every auth, X
stays count-only, S4 is cancelled, and the X note keeps saying so.

### S1: The Activity row shows the person (renderer only)

Files:

- `components/stream-manager/activity-pane.tsx` (`ActivityRow`)
- `lib/chat-avatar.tsx`
- `activity-pane.test.ts`

Changes:

- When `item.authorAvatarUrl` is present and `!item.unnamed`, the 28 px tile
  renders the viewer's avatar with the platform badge kept bottom-right. Use
  `useCachedAvatar` and shadcn `Avatar` from `components/ui/avatar.tsx`, or
  extend `AvatarCircle` with a `size-7` class. Pick one; don't write a third
  avatar.
- The kind glyph moves to a small secondary position, or is dropped for
  follows. The name already says "Followed". Follow the design skill; no
  toolbar-corner additions.
- A named row with no avatar URL, or a failed cache, falls back to the
  **monogram** (`monogramInitials`), not the kind glyph. The streamer can then
  still see it's a person.
- Unnamed rows keep today's glyph, and their title stays "New follower" or
  "N new followers".
- This applies to every named kind (sub, cheer, raid, KICKs), not only
  follows. They already carry `authorAvatarUrl`.

Tests: named row with an avatar renders the `img`. Named row without an avatar
renders the monogram. Unnamed row renders the glyph and no `img`.

Done when: `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and
`pnpm --filter @videorc/desktop test` pass. `pnpm probe:comments-window` still
passes, because the Activity pane lives in that window. A dev-build screenshot
of a seeded named Twitch follow shows the avatar.

### S2: Twitch names followers without a hunt

Files:

- `lib/stream-activity.ts`
- `components/stream-manager/activity-pane.tsx`
- `components/tabs/streaming-tab.tsx`
- `hooks/use-studio.tsx` (connect call)
- `twitch_chat.rs` (tests only)

Changes:

- **In place fix.** An unnamed Twitch follower-gain row gets a row action,
  **"Show who followed"**. The Activity capability note gets the same action.
  Both run the existing opt-in connect:
  `onConnect('twitch', { optionalScopes: TWITCH_AUDIENCE_SCOPES })`. This
  replaces the text-only "Reconnect Twitch in Livestream → Setup". Keep
  Livestream → Setup as it is.
- **New connections opt in by default.** Every _fresh_ Twitch connect (no
  existing account) requests `TWITCH_AUDIENCE_SCOPES` as optional scopes.
  Existing connections are not forced to reconnect. The comment in
  `platform-scopes.ts` still holds, because the base set doesn't change.
- **Verify the avatar path.** Add a `twitch_chat.rs` test. A `channel.follow`
  notification goes through the same `TwitchAvatarCache.lookup` branch as chat
  (the `author_avatar_url.is_none() && author_id` block, ~l.997). The delivered
  message must carry the Helix `profile_image_url` (use a mock Helix).
- **Handle the stream in progress.** After the reconnect, the running
  `twitch_chat` session must subscribe to `channel.follow` without a new Go
  Live. If it doesn't today, the note must say "from your next stream". Don't
  claim what the code doesn't do. Check how `apply_audience_scopes` and the
  chat session react to a scope change.

Done when: the new Rust test passes
(`cargo test -p videorc-backend twitch_chat`). Clippy is clean. The renderer
tests cover the new action. On the owner's account, one reconnect makes the
next follow a named row with an avatar. This check is part of S5.

### S3: Kick keeps the follower's avatar (web first, then desktop)

The web deploy must go first. The desktop parser tolerates the field being
absent, so the order is safe either way.

- **videorc-web**, `lib/kick-chat/webhook.ts`:
  - `KickFollowRelayPayload` adds `followerAvatarUrl: string | null`, set from
    `httpsUrl(follower.profile_picture)`. This is the same helper `relayUser`
    uses.
  - Update the `channel.followed` case, the `scripts/kick-webhook.mjs` fixture,
    `docs/kick-chat.md`, and the relay tests.
  - Open its own PR and deploy before the desktop release.
- **Desktop**, `kick_chat.rs`:
  - `RelayFollowPayload` adds `#[serde(default)] follower_avatar_url:
Option<String>`.
  - The `"follow"` arm sets `author_avatar_url` through the same
    `https://`-only filter that `apply_relay_author` uses.
  - Tests cover three payloads: with an avatar, without one, and with an
    `http://` avatar (which must be dropped).

Done when: both PRs pass their gates (`cargo test -p videorc-backend
kick_chat`, clippy, and the web repo's test/lint). A replayed `channel.followed`
webhook against a dev relay produces a Kick follow row with the avatar.

### S4: X follows through the X Activity API (web first, then desktop)

**Gate, done first.** Build the desktop `ensure_follow_subscription` (see
below) and run a dev Go Live to X on the owner's account.

- If X accepts the subscription, continue with the rest of S4.
- If X refuses it with every auth, stop S4. X stays count-only, and the facts
  doc records the refusal.

X follows use the relay that already carries X live chat (web
`docs/x-chat.md`, desktop `x_chat.rs`):

`viewer follows → XAA follow.follow → POST /api/webhooks/x → x_chat_events → desktop long-poll`

There is no polling, no follower-list diffing and no guessing. Each follow is
one event that names one person.

**videorc-web** (its own PR, deployed before the desktop release):

- `lib/x-chat/webhook.ts` rejects every `event_type` except `broadcast.chat`
  (~l.91). Make it also accept `follow.follow`.
- **Schema.** `x_chat_events.broadcast_id` is `NOT NULL`, and reads filter by
  it (`store.ts` `listXChatEventsAfter`), but a follow has no broadcast. Add a
  migration that does two things:
  - adds `kind text not null default 'chat'`;
  - makes `broadcast_id` nullable.

  Follows are stored with `kind = 'follow'` and no broadcast id. After deploy,
  confirm that production applied it (Kick's 0015 once didn't; see
  `videorc-kick-chat-relay-migration-missing`).

- **Old-desktop safety.** Today's desktop parses each event with a **required**
  `text` (`x_chat.rs` `RelayEvent`). A follow row in its page would fail the
  whole page and break X chat. So the read route returns follows **only**
  when the desktop asks with `include=follows`. It then returns chat for the
  broadcast plus this user's follows, with the query
  `(kind = 'chat' AND broadcast_id = ?) OR kind = 'follow'`.
  - Follows serialize as `{ kind: "follow", id, messageId, receivedAt,
author }`.
  - Chat rows keep their exact current shape.
  - Without the parameter, the response is byte-identical to today.
  - Add a test for that.
- Key the event by `filter.user_id`. Keep a follow only when
  `payload.target.data.id` equals that bound user. That way an outbound
  follow can never show up.
- Normalize the follow into a relay event of kind `follow` carrying:
  - `followerId`, `followerUsername`, `followerName`
  - `followerAvatarUrl` (https only, like chat authors)
  - `event_uuid` as the message id, which makes it idempotent
- Store it in `x_chat_events` under the same 24 h prune, and extend the
  migration's kind column if it needs to.
- Add a fixture `tests/fixtures/x-follow-event.json` built from the documented
  payload, plus tests for these cases:
  - an inbound follow is stored;
  - an outbound follow (target ≠ bound user) is dropped;
  - a missing `source` is dropped;
  - an `http://` avatar is dropped.
- Update `docs/x-chat.md` (routes table, data section) and the privacy note:
  the relay now keeps a follower's handle, name and avatar for up to 24 h,
  the same as a chat author.

**Desktop:**

- **Subscribe.** Add `ensure_follow_subscription` and
  `delete_follow_subscriptions` in `x_live.rs`, copying
  `ensure_broadcast_chat_subscription` and its delete. Use the same
  credentials, webhook id and lifecycle. Create it at Go Live next to chat
  (`x_chat.rs` ~l.341) and delete it at stream end and disconnect (~l.545).
  - The "ensure" step reuses a subscription that matches, and replaces one
    that points at a stale webhook, exactly as the chat tests at ~l.1180–1270
    cover.
  - A failed follow subscription must never fail chat or the stream. It logs,
    and X stays count-only for that session.
- **Read.** The long-poll sends `include=follows`. `RelayEvent` gains
  `#[serde(default)] kind: Option<String>`, and `text` becomes
  `#[serde(default)]`. A chat row with empty text is still dropped as today.
- **Parse.** In the `x_chat.rs` long-poll, a `follow` relay event becomes a
  `LiveChatMessage` with:
  - `event_type: Follow` and `details: Follow`
  - `author_id`, `author_name`, `author_avatar_url`
  - `raw_provider_type: "x.follow"`
  - `message_text: "{name} followed"`
  - `provider_message_id` from `event_uuid`

  Unknown kinds are skipped, not treated as errors, so a later relay kind
  can't break this desktop either.

- **One follower is counted once.** Keep a per-session set of X follower ids,
  so an unfollow followed by a refollow isn't a second row.
- **No double counting with the count poll.** While the follow subscription is
  live, the X entry in `stream.audience` reports `audience_scopes: Some(true)`
  (the same flag Twitch uses). That makes `itemsFromFollowerGains` skip X
  gains. The follower total and "+N this stream" stay on the 120 s count poll.
  If the subscription failed, gains come back as unnamed rows.
- **Renderer.** Delete the blanket "X doesn't share who followed" in
  `itemsFromFollowerGains` and `activityCapabilityNote`. Only when X follow
  events are unavailable should the note say "X follows show as a count this
  stream."
- **Facts doc.** Update the X row in
  `docs/specs/stream-manager-provider-facts.md` with the S0 results.

Tests:

- The subscription tests (create, reuse, replace stale, delete) against the
  mock X in `x_chat.rs`.
- Relay follow parsing, with and without an avatar.
- Dedupe by follower id.
- A failed subscription leaves chat running and gains unnamed.
- The wire JSON keeps optional fields `skip_serializing_if` (see the
  serde-null trap).

Done when:

- The web PR passes its tests and lint, and is deployed.
- The targeted `cargo test -p videorc-backend x_chat x_live audience` passes,
  and clippy is clean.
- `pnpm typecheck` and the desktop tests pass.
- A real follow from a test account during an owner test stream shows a named
  X row with the avatar within seconds.

### S5: Thank by handle, then owner acceptance

**Handle.** `thankYouDraft` builds `@{display name}`. For X, Twitch (`user_login`)
and Kick (`username`), the mention must use the **handle**. A Twitch display
name can be CJK or differently cased, and then `@` won't mention anyone.

- Add `author_handle: Option<String>` (`skip_serializing_if =
"Option::is_none"`) to `LiveChatMessage`, and mirror it in `shared/backend.ts`
  and `backend-rpc-contract.ts`.
- Fill it for follow rows on all three platforms.
- `thankYouDraft` prefers `@handle` and falls back to today's name.
- The row keeps showing the display name.

**Acceptance on a packaged candidate.** The owner streams to Twitch, Kick and X
together. Three test accounts follow during the stream.

- Each row shows the right avatar and name within seconds on all three
  platforms. Only the follower _total_ waits for the 120 s count poll.
- "Thank in chat" prefills `Thanks for the follow, @handle!`.
- The Follows count equals the number of distinct followers.
- A follow from before the stream never appears.

Record the result in `docs/acceptance/` with the date.

Done when: the contract tests and the desktop tests pass, and the acceptance
record is written.

## Verification summary

- Renderer: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm --filter @videorc/desktop test`, `pnpm probe:comments-window`.
- Rust: targeted `cargo test -p videorc-backend {twitch_chat,kick_chat,x_chat,x_live,audience,live_chat}`,
  plus `cargo clippy -p videorc-backend -- -D warnings` and
  `cargo fmt --check --all`. Don't run the full suite (owner directive).
  After any `cfg` edit, also run `cargo build --release`.
- Web (S3, S4): the videorc-web test and lint scripts. Deploy before the desktop
  release.
- No recording or native-preview code is touched, so no recording-studio
  smokes are needed.

## Risks

- **X follow events.** `follow.follow` isn't in the docs' public or private
  lists, so S0 must prove that our auth can subscribe to it and that the tier
  includes it. If it can't, X stays honest and count-only, and S1–S3 still fix
  the Twitch and Kick half of the screenshot.
- **Subscription cap.** 2 XAA subscriptions per live X streamer halves the
  headroom under the app-wide cap. They are deleted at stream end, so only
  concurrent streamers count. Log a clear error when X refuses for the cap.
- **Wrong direction or duplicate rows.** Check the target id on the relay and
  dedupe by follower id on the desktop. When unsure, stay unnamed.
- **Contract drift.** New optional fields must skip nulls, or the app fails to
  load (`videorc-serde-null-contract-trap`).

## Implementation record (2026-09-28)

Desktop branch `plan/071-named-followers`, one commit per slice. Web:
videorc-web #56 (Kick avatar) and #57 (X follows, migration 0017). Deploy
both web PRs before the desktop release.

What shipped, and where it differs from the plan above:

- **S1.** Named rows show `AvatarCircle` (initials until the cached image
  loads). This covers follows, subs, gifts, tips and raids. Unnamed counts,
  announcements and destinations keep the glyph. The design skill's Activity
  rule was updated.
- **S2, a bug found while building it.** Activity hid Twitch follower gains as
  soon as the account held the audience scopes, but the chat session only
  subscribes to `channel.follow` at Go Live. A mid-stream grant would have
  hidden every Twitch follow for the rest of the stream. The fix:
  - the connector now reports when its follow subscription is live;
  - `stream.audience` carries `namedFollowsSince` and `namedFollowsUntil`,
    and Activity skips only gains read inside that window;
  - an open EventSub socket adds `channel.follow` on a keepalive within about
    30 s of the grant, with no new Go Live needed.

  "Show who followed" is a row action and an empty-state button, relayed from
  the Stream Manager to the main window (`comments-window:follow-names`). A
  first Twitch connection requests the audience scopes by default. A
  reconnect keeps them when the account already had them, where before a
  plain reconnect silently dropped them.

- **S3.** As planned: relay `followerAvatarUrl`, https only on both sides.
- **S4, differences from the plan:**
  - The X chat subscription is _not_ deleted at stream end: it persists
    across streams and is deleted on X disconnect. A follow subscription
    can't copy that, because follows happen off stream too. It is created
    with `expires_at` two hours ahead and re-posted every 30 minutes while
    the connector runs (XAA treats a re-post as a refresh). It is also
    deleted on X disconnect.
  - Instead of reusing `audience_scopes`, X reports the same
    `namedFollowsSince` window as Twitch.
  - The relay returns follows only for `include=follows`, with the XAA
    `event_uuid` as `messageId`.
- **S5, a difference from the plan.** The handle lives on
  `LiveChatEventDetails::Follow { handle }`, not on a new `LiveChatMessage`
  field. It is only needed for follows, details already persist as JSON, and
  `{"kind":"follow"}` rows stored earlier still load.

Not done here, and needs the owner:

- **S0:** the X app-bearer probe, and the owner's Twitch scopes.
- **S4 gate:** a dev Go Live to X, to confirm that X accepts the OAuth 1.0a
  `follow.follow` subscription. If X refuses it, the connector logs "X
  follows will show as a count" and X stays count-only. Chat is unaffected.
- **S5:** the three-platform acceptance stream, recorded in `docs/acceptance/`.
