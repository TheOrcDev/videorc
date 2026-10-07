# Plan 162: Twitch bits Power-ups and channel point redemptions show in Activity

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update this plan's entry in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat cdd2f942..HEAD -- crates/videorc-backend/src/twitch_chat.rs crates/videorc-backend/src/live_chat.rs crates/videorc-backend/src/oauth.rs apps/desktop/src/shared/platform-scopes.ts apps/desktop/src/renderer/src/lib/stream-activity.ts apps/desktop/src/shared/backend.ts`
> If `twitch_chat.rs` changed around `CHAT_SUBSCRIPTION_TYPES`,
> `create_subscriptions`, `follow_scope_held` or `normalize_notification`,
> compare the "Current state" excerpts below with the live code first. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 (money and loyalty events from real viewers never reach
  the streamer. The owner noticed it live on stream.)
- **Effort**: M, 7 slices
- **Risk**: MEDIUM (an OAuth scope change makes every Twitch account
  reconnect once, plus a wire-contract addition. No recording or preview
  path is touched.)
- **Depends on**: none. Builds on plan 055 (Activity), plan 071 (Show who
  followed), plan 151 (watch streaks) and plan 156 (Activity auto-show).
- **Category**: feature gap, reported as a bug
- **Planned at**: commit `cdd2f942` (origin/main), 2026-10-07
- **Route**: Orchestrator → Implementation, fit 8, model lane `fable-5`
  (multi-system: OAuth scopes, EventSub, the wire contract, Activity UI.
  The scope change affects every Twitch user). S4 UI copy and layout follow
  `.claude/skills/videorc-design/SKILL.md`.

## Incident (2026-10-07, session `cf52b54a`)

During tonight's Twitch stream, a viewer spent bits and someone redeemed
channel points ("gold" is read here as the channel's points currency; see
Open questions). Neither showed in the Stream Manager's Activity.

Evidence from the local database (`videorc.sqlite3`, `live_chat_messages`,
read-only):

| Twitch `raw_provider_type` since 10-01 | Rows |
| --- | ---: |
| `channel.chat.message` | 655 |
| `channel.follow` | 13 |
| `channel.chat.notification:sub_gift` | 12 |
| `channel.chat.notification:sub` | 5 |
| `channel.chat.notification:community_sub_gift` | 3 |
| `channel.chat.notification:raid` | 2 |

There are **zero** rows with cheer or redemption details. At 20:17 to 20:18 UTC, chat
was talking about it ("the bits are money", "100 bits = 1 dolar i think",
"bits are tips"), and at 20:24 someone wrote "that fire's fire". That matches
an on-screen **Celebration** Power-up, which never posts a chat message.

The Twitch account holds these scopes:
`channel:manage:broadcast channel:read:stream_key channel:read:subscriptions moderator:manage:chat_messages moderator:read:followers user:read:chat user:write:chat`.
It has neither `bits:read` nor `channel:read:redemptions`.

## Root cause

Videorc reads Twitch through one EventSub WebSocket subscribed to the five
chat types plus optional `channel.follow`
(`CHAT_SUBSCRIPTION_TYPES`, `twitch_chat.rs:40`). Bits and points reach that
socket only when they happen to produce a chat message:

| What the viewer did | Arrives today as | Activity today |
| --- | --- | --- |
| Cheer (bits typed in chat, `Cheer100 …`) | `channel.chat.message` with `cheer.bits` | ✅ "Cheered N bits" (`normalize_chat_message`) |
| Power-up: **Celebration** (on-screen effect) | nothing | ❌ invisible |
| Power-up: **Gigantify an emote** | `channel.chat.message`, `message_type: power_ups_gigantified_emote`, **no bits field** | ❌ plain chat row |
| Power-up: **Message effect** | `channel.chat.message`, `message_type: power_ups_message_effect`, no bits field | ❌ plain chat row |
| Channel points: **custom reward** without text input | nothing | ❌ invisible |
| Channel points: custom reward with text input | plain `channel.chat.message` | ❌ plain chat row |
| Channel points: **automatic** rewards (highlight message, unlock or modify emote, sub-only bypass) | sometimes a chat row (`channel_points_highlighted`, `channel_points_sub_only`), sometimes nothing | ❌ |

`message_type` is read only for `user_intro` (`twitch_chat.rs`, `normalize_chat_message`).
Nothing else is stored, so the chat rows above cannot be told apart from
ordinary messages after the fact.

The data exists in three EventSub types that Videorc never subscribes to
(verified against the [EventSub subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)
and the [EventSub reference](https://dev.twitch.tv/docs/eventsub/eventsub-reference/), 2026-10-07):

| Type | Version | Scope | Condition | Payload we need |
| --- | --- | --- | --- | --- |
| `channel.bits.use` | 1 | `bits:read` | `broadcaster_user_id` | `user_id/login/name`, `bits`, `type` (`cheer` \| `power_up` \| `custom_power_up`), `power_up {type: message_effect \| celebration \| gigantify_an_emote, emote {id,name}, message_effect_id}`, `message {text, fragments}` |
| `channel.channel_points_custom_reward_redemption.add` | 1 | `channel:read:redemptions` (or `channel:manage:redemptions`) | `broadcaster_user_id` (+ optional `reward_id`) | `id`, `user_*`, `user_input`, `status`, `reward {id,title,cost,prompt}`, `redeemed_at` |
| `channel.channel_points_automatic_reward_redemption.add` | **2** | `channel:read:redemptions` | `broadcaster_user_id` | `id`, `user_*`, `reward {type: single_message_bypass_sub_mode \| send_highlighted_message \| random_sub_emote_unlock \| chosen_sub_emote_unlock \| chosen_modified_sub_emote_unlock, channel_points, emote?}`, `message?`, `redeemed_at` |

`channel.bits.use` does not fire when the streamer uses a Power-up in their
own channel for free, and it excludes Extension bits. That is fine.

## Current state (excerpts, origin/main `cdd2f942`)

- `twitch_chat.rs:40` `CHAT_SUBSCRIPTION_TYPES`: five chat types, all v1
  with the `broadcaster_user_id + user_id` condition.
- `twitch_chat.rs` `create_subscriptions`: chat types must succeed. Follow
  is "extra: a refusal here never costs the chat itself" (`create_follow_subscription`).
- `twitch_chat.rs` `follow_scope_held` + `FOLLOW_SCOPE_RECHECK` (30 s):
  re-reads the stored account so a reconnect that grants the scope
  mid-stream starts follows on the open socket (plan 071, S2).
- `twitch_chat.rs` `normalize_follow`: the model for an **Activity-only**
  row. It is a `LiveChatMessage` with `event_type: Follow`, id `follow:{metadata message_id}`
  and structured `details`, and it is persisted like any chat row.
- `main.rs:3211` `twitch_chat_config`: `follow_events` comes from the
  account's scopes.
- `oauth.rs:113-142`: `TWITCH_FOLLOWERS_SCOPE`, `TWITCH_SUBSCRIPTIONS_SCOPE`,
  `TWITCH_MODERATION_SCOPE`, `optional_scopes_for(Twitch)`.
  `shared/platform-scopes.ts` mirrors it (`TWITCH_OPTIONAL_SCOPES`), and
  `platform-scopes.test.ts` fails on drift. Every Twitch Connect/Reconnect
  asks for all optional scopes. `retained_optional_scopes` keeps grants.
- `live_chat.rs:84` `LiveChatEventType` and `:150` `LiveChatEventDetails`.
  Every optional field uses `skip_serializing_if` because a serialized `null`
  has broken app load three times (memory: serde null → contract trap).
- `storage.rs:7856`: an unknown stored `event_type` loads as `Message`, and
  unreadable `details` degrade to a plain row. An older build that reads a
  new row shows it as a chat message and never fails.
- Renderer: Activity is a pure projection of chat rows with `details`
  (`stream-activity.ts`, `itemFromMessage`). Follow rows are kept out of
  the chat list in three places by `eventType !== 'follow'`:
  `stream-manager.tsx:514` and `:543`, `live-chat-view.ts:514`, and
  `stream-manager-chat.ts:24`. Other consumers are `shared/chat-delivery.ts`
  (`chatDeliveryActivityMatches`, the compact delivery `activity` flag),
  `activity-auto-highlight.ts` (`AUTO_SHOW_ACTIVITY_KINDS`), the activity
  pane's "Show who followed" action (`activity-pane.tsx:186`) and
  `activityTotals` (`bits`).

## Decisions

- **D1. Activity-only rows, like follows.** Power-ups and redemptions become
  persisted `LiveChatMessage` rows with new event types that never appear in
  the chat list. The gigantified-emote or highlighted chat message that
  Twitch also sends stays an ordinary chat row, so nothing is double-listed
  in either pane.
- **D2. Cheers keep their chat path.** A cheer always posts a chat message,
  which already makes the Cheer row with a real message id. `channel.bits.use`
  events with `type: cheer` are **dropped** in the connector. There is no
  shared id to de-duplicate on, so dropping them is the only safe choice.
- **D3. Power-ups count as bits; points do not count as money.** Power-up
  bits add to `ActivityTotals.bits` and sit under the **Tips** chip.
  Redemptions are listed under a new **Rewards** chip and are never summed,
  the same treatment watch streaks get (plan 151, D4).
- **D4. Optional scopes, Twitch-wide.** Add `bits:read` and
  `channel:read:redemptions` to `optional_scopes_for(Twitch)`. New connects
  get them automatically. Existing accounts see one Activity hint that
  reconnects (generalizing "Show who followed"). No base-scope change.
  Choose `channel:read:redemptions`, not `manage`: Videorc only reads.
- **D5. Extra subscriptions never cost chat.** A refusal on bits or
  redemptions (for example, a non-affiliate channel without points) is
  logged once at `warn` and treated like a follow refusal. Chat stays up.
- **D6. Stable ids.** Redemptions use `redemption:{event.id}` (Twitch's
  redemption id survives redelivery). Power-ups use
  `bits:{metadata.message_id}`. Both pass through the existing de-duplication.

## Wire shape (S2)

```rust
// LiveChatEventType: two new Activity-only kinds
PowerUp,     // "power-up"
Redemption,  // "redemption"

// LiveChatEventDetails
#[serde(rename_all = "camelCase")]
PowerUp {
    bits: u64,
    /// "celebration" | "gigantify-an-emote" | "message-effect" | "custom"
    power_up: PowerUpKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    emote_name: Option<String>,
},
#[serde(rename_all = "camelCase")]
Redemption {
    /// Custom reward title, or a fixed label for automatic rewards.
    title: String,
    channel_points: u64,
    /// "custom" | "highlighted-message" | "sub-only-message" |
    /// "random-emote-unlock" | "chosen-emote-unlock" | "modified-emote-unlock"
    reward: RedemptionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    emote_name: Option<String>,
},
```

The viewer's words (`user_input`, `message.text`, or a Power-up message)
go in `message_text` + `fragments`, as on other notices.

## Slices

### S1: Scopes (backend + shared)

1. `oauth.rs`: add `TWITCH_BITS_SCOPE = "bits:read"` and
   `TWITCH_REDEMPTIONS_SCOPE = "channel:read:redemptions"`. Add both to
   `optional_scopes_for(Twitch)` and to a renamed
   `TWITCH_ACTIVITY_SCOPES` (followers, subscriptions, bits, redemptions).
   Keep `TWITCH_AUDIENCE_SCOPES` as an alias only if callers need it.
2. `shared/platform-scopes.ts`: mirror the new scopes in
   `TWITCH_OPTIONAL_SCOPES`.
3. `twitch_chat.rs` `TwitchChatConfig`: add `bits_events: bool` and
   `redemption_events: bool` (`#[serde(default)]`). Set them in
   `main.rs` `twitch_chat_config` from the account's scopes, like `follow_events`.

**Done when**: `pnpm --filter @videorc/desktop test platform-scopes` and
`cargo test -p videorc-backend oauth` pass, and the drift test sees both
new scopes.

### S2: Wire contract

1. `live_chat.rs`: add the types and details above, with the
   `PowerUpKind` and `RedemptionKind` enums (kebab-case).
2. `shared/backend.ts`: add the `LiveChatEventType` union members and the
   `LiveChatEventDetails` variants. Add both to
   `protocol-contract-fixtures.test.ts`.
3. `storage.rs`: round-trip test. Write and read a row of each new kind.
   An unknown future kind still loads as `Message`.
4. Add the new types to the exclusion lists that already name `Follow`:
   moderation eligibility (`live_chat_moderation.rs` `eligibility`), 7TV
   decoration (`seventv.rs`), and first-time-chatter marking (find with
   `git grep -n "LiveChatEventType::Follow" crates/`).

**Done when**: `cargo test -p videorc-backend -- live_chat storage protocol seventv live_chat_moderation`
passes, along with `pnpm typecheck` and the contract fixtures test. No new
field serializes `null` (the existing null-scan test covers fixtures. Extend
it with the new kinds).

### S3: Connector subscribes and normalizes

1. Generalize `follow_scope_held` / `FOLLOW_SCOPE_RECHECK` to an
   `ExtraEvents { follows, bits, redemptions }` set read from the stored
   account. The open socket creates whatever became newly held, as follows
   do today.
2. Add subscription bodies:
   `channel.bits.use` v1, `channel.channel_points_custom_reward_redemption.add` v1,
   `channel.channel_points_automatic_reward_redemption.add` **v2**, each
   with condition `{ broadcaster_user_id }`. Create them after the chat
   types in `create_subscriptions`, best-effort (D5). Treat 409 as held.
3. `normalize_notification`: add
   - `normalize_bits_use`: return `None` for `type == "cheer"` (D2). Map
     `power_up.type` / `custom_power_up` to `PowerUpKind`, take `bits`, and
     take `emote.name`. The text reads "{name} used a Celebration",
     "{name} gigantified {emote}", "{name} sent a message effect" or
     "{name} used a Power-up".
   - `normalize_custom_redemption`: title, cost, `user_input` as the words.
   - `normalize_automatic_redemption` (v2 field names: `channel_points`,
     `emote`, `message.fragments`).
   Anonymous or missing user falls back to "Someone", as `normalize_follow` does.
4. Tests in the existing mock EventSub harness (`mock_eventsub_ws`):
   payload fixtures copied from the EventSub reference examples. Cover:
   subscribes only with each scope; a refused bits subscription keeps chat
   live; a bits `cheer` event produces no row; one row per redemption across
   a redelivery; a scope gained mid-stream starts the subscription.

**Done when**: `cargo test -p videorc-backend twitch_chat` passes, with a
test per bullet in step 4.

### S4: Activity shows them (UI, `videorc-design` skill)

1. Add one helper `isActivityOnlyEvent(eventType)` in `shared/` (follow,
   power-up, redemption). Replace the three `eventType !== 'follow'` chat
   exclusions and the `activityOnStream` check (`stream-manager.tsx:543`)
   with it. Make sure the compact delivery `activity` flag (find where
   `ChatDeliveryMessage.activity` is computed) treats the new kinds as
   activity and not chat.
2. `stream-activity.ts`:
   - Kinds `'power-up'` (filter `tips`) and `'redemption'` (filter
     `rewards`). Add the `rewards` chip: label "Rewards", title "Channel
     point redemptions". Update the Tips title to "Bits, Power-ups, KICKs,
     Super Chats and Super Stickers".
   - Lines: "Used a Celebration · 300 bits" / short "Celebration · 300 bits".
     Also "Gigantified orcdevBONK · 50 bits" and "Sent a message effect · 100 bits".
     Redemptions: "Redeemed Hydrate · 500 points" / short "Hydrate". Use
     automatic-reward labels: "Highlighted their message", "Unlocked an emote",
     "Unlocked {emote}", "Sent a message in sub-only mode".
   - `activityTotals`: Power-up bits add to `bits`. Redemptions are not summed.
3. `activity-auto-highlight.ts`: add `'power-up'` to
   `AUTO_SHOW_ACTIVITY_KINDS`. Leave `'redemption'` **out** by default,
   because hydrate-style redemptions are frequent. Owner call, see Open questions.
4. Row glyphs: reuse the existing bits glyph for Power-ups and a points
   glyph from the project's icon set (Nucleo licence cap: check
   the count before adding an icon). "Show on stream" and "Thank in chat"
   work as they do for follows ("Thanks for the Celebration, @name!",
   "Thanks for redeeming Hydrate, @name!").

**Done when**: `pnpm --filter @videorc/desktop test stream-activity activity-pane chat-delivery activity-auto-highlight stream-manager-stats`
passes with new cases. These cases must include: a Power-up row counts in
bits; a redemption is listed but not summed; neither kind appears in the
chat list. Then `pnpm typecheck`, `pnpm lint` and `pnpm format:check` pass.

### S5: The reconnect hint

1. Generalize the plan 071 "Show who followed" path into "Show bits and
   channel points". Activity shows one muted row or banner while the Twitch
   account lacks `bits:read` or `channel:read:redemptions`: "Reconnect Twitch
   to see Power-ups and channel point redemptions." It uses the same IPC
   (`main/index.ts:9214`, `:14621`; `preload/api-policy.ts:36`) and
   `permissionReconnectScopes('twitch')`, which already returns every
   optional scope.
2. The hint disappears once the scopes are held. The S3 recheck then starts
   the subscriptions on the live socket without a chat restart.

**Done when**: an activity-pane test shows the hint only without the scopes,
and its action calls the existing reconnect with all optional Twitch scopes.

### S6: Fake providers and probes

The fake Twitch activity fixture becomes 16 rows (14 + one Power-up +
one redemption). Update every hard-coded count (memory, plan 151):
`scripts/lib/comments-totals-probe*.mjs`, the two `live_chat.rs` tests, and
the rollover total in `smoke-live-chat-fake-providers.mjs`. Add one bits
`cheer` event to the fake socket and check that it produces **no** row (D2).

**Done when**: `pnpm test:scripts` and the fake-providers smoke pass.

### S7: Gates and owner acceptance

Per the owner's "gates at the end" rule: commit S1–S6 first, then run:

```
cargo fmt --check --all
cargo clippy -p videorc-backend -- -D warnings
cargo test -p videorc-backend -- twitch_chat live_chat storage protocol oauth seventv live_chat_moderation
cargo build --release -p videorc-backend   # cfg/serde gap guard
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter @videorc/desktop test
pnpm test:scripts
pnpm build
```

Owner acceptance (packaged or dev app, real Twitch):

1. Reconnect Twitch from the Activity hint. The device grant lists "View Bits
   information" and "View Channel Points custom reward redemptions".
2. Go live (unlisted test, or with a helper viewer). Have someone:
   redeem a custom reward without text, redeem one with text, use a
   Celebration, gigantify an emote, and cheer 1 bit.
3. Expect five Activity rows: two Rewards and three Tips. The cheer appears once,
   not twice. The bits total equals the cheer plus the two Power-ups. Chat shows
   the gigantified message and the text redemption as normal messages only.
4. Show on stream works on a Power-up row.

Optional no-viewer check: the Twitch CLI (`twitch event trigger
channel.channel_points_custom_reward_redemption.add --transport=websocket`)
against its mock WebSocket server, with `eventsub_ws_url` pointed at it.

## STOP conditions

- The Twitch device-code grant refuses `bits:read` or
  `channel:read:redemptions` for Videorc's client id. Stop: the whole
  plan depends on the scopes.
- A real `channel.bits.use` payload differs from the reference field names
  (log the raw event at `debug` during acceptance and compare).
- Adding the scopes changes the **base** scope set or forces a reconnect for
  users who never open Activity. It must stay optional (D4).
- A Celebration or redemption still does not arrive after the scopes are held
  and the subscriptions return 202. Stop and inspect
  `GET /helix/eventsub/subscriptions` for the socket before changing code.

## Out of scope

- Hype Trains (`channel.hype_train.*`, `channel:read:hype_train`). This is a
  good follow-up because the same pattern applies.
- Charity donations (`channel.chat.notification:charity_donation`) and
  `bits_badge_tier` notices. These already reach the socket and only need a
  details mapping. This is a cheap follow-up.
- Fulfilling or refunding redemptions (`channel:manage:redemptions`).
- Showing a "Gigantified" or "Highlighted" chip on the chat row itself.
- Kick, YouTube and X equivalents.

## Open questions for the owner

1. "Gold": is that your channel-points name, or something else (for example
   a Hype Train's golden Kappa)? The plan assumes channel points.
2. Should redemptions auto-show on stream when Activity auto-show is on?
   The default in this plan is no.

## Execution notes (2026-10-07, branch `plan-162-twitch-bits-points`)

S1 to S6 are built. S7 gates that passed locally: `cargo fmt --check`,
clippy with `-D warnings`, the targeted `cargo test -- …` filters (476 tests),
typecheck, lint, format, the desktop unit suite, `test:scripts`, `pnpm build`
and the renderer asset budget. Not run locally: `cargo build --release` (no
`cfg` edits; CI builds release) and the fake-providers app smoke. Owner
acceptance on a live Twitch stream is still owed. Deviations from the plan
text:

- `Redemption.title` is optional: custom rewards carry it, automatic rewards
  have none, and the window names them. `RedemptionKind` gained `other` for
  automatic rewards Twitch adds after this build.
- The reconnect hint is a one-line bar above the Activity rows, not only in
  the empty state, because Power-ups and redemptions have no row to carry the
  ask. The destination card's permission row and the status-bar tooltip name
  Power-ups and channel points too.
- A refused Power-up or redemption subscription is not retried on the same
  socket, so a channel without bits or points does not hit Helix every 30 s.
  Follows keep retrying as before.
- The mid-stream scope recheck runs after every EventSub frame (at most every
  30 s), not only on keepalives: Twitch sends keepalives only while a socket
  is quiet, so a busy chat would never have rechecked (CodeRabbit on #636).
- Thank in chat: Power-ups use the tip line ("Thank you so much, @name!"),
  and redemptions use "Thanks for redeeming, @name!".
- The fake cheer-through-`channel.bits.use` check lives in the Rust unit test
  (`bits_use_power_ups_become_activity_rows_and_cheers_are_skipped`). The fake
  provider emits normalized rows, not EventSub frames.
