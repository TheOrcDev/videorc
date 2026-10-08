# Plan 163: Redemptions say the channel's own points name and auto-show; Custom Power-ups keep their names

> **Executor instructions**: This plan was executed in the same session that
> wrote it (branch `plan-163-channel-points-name`). Its "Verification"
> section lists what ran. When done, update this plan's entry in
> `plans/README.md`.

## Status

- **Priority**: P2 (owner follow-up to plan 162, 2026-10-08)
- **Effort**: S
- **Risk**: LOW for product behavior (every failure falls back to
  "points"), MEDIUM for platform terms (see D1)
- **Depends on**: plan 162 (#636, `7d2a36fe`)
- **Route**: Implementation, fit 8

## The owner's ask

> "Orc Gold is my channel's name for points … that should be dynamic,
> whatever people have on their Twitch channel … someone else could call it
> Diamonds, we need to pull that info … redemptions should be auto shown if
> we have that auto switch in Activity turned on."

Plan 162 wrote "Redeemed Hydrate · 500 points" and kept redemptions out of
auto-show. Both change here.

## Research (2026-10-08)

- **Helix has no field for it.** The Channel Points endpoints (Create, Delete,
  Get, Update Custom Reward; Get and Update Redemption) return reward data
  only: `title`, `cost`, `image`, cooldowns. Nothing carries the currency name
  or icon ([Helix reference](https://dev.twitch.tv/docs/api/reference/#get-custom-reward)).
  EventSub redemption payloads don't either.
- **No official chat text carries it.** The local database shows the name
  only in viewers' own messages ("i redemed somthing with my orc gold and it
  dont even show there", 2026-10-05).
- **Channel points can't be bought.** Viewers earn them by watching. The
  "buying" is redeeming a reward, which is what Activity lists.
- **Twitch's own GQL has it.** twitch.tv's pages read
  `user(id) { channel { communityPointsSettings { name image } } }` from
  `https://gql.twitch.tv/gql`, unauthenticated, with twitch.tv's public web
  client id. Probed on 2026-10-08:
  - `1298584691` (OrcDev) returns `"Orc Gold"`, plus three icon URLs on
    `static-cdn.jtvnw.net/channel-points-icons/…`.
  - `twitchdev` and `shroud`, with default points, return `name: null` and
    `image: null`.
  - Lookup by user id and GraphQL variables both work.

## Decisions

- **D1. Read the name from Twitch's GQL; fail soft.** It is the only source.
  It is unofficial: Twitch can change or block it, and its developer forum
  discourages using it. So:
  - one request per stream, made on the first redemption, never at Go Live;
  - only the channel's public id is sent, never a Videorc token;
  - 5 s timeout;
  - any failure logs one `warn` and the rows say "points".
- **D2. Stamp the name on the row** (`pointsName` in the redemption details).
  History, the highlight card and Copy keep the name the stream had, with no
  second lookup.
- **D3. Redemptions read like tips.** The line is "Redeemed Hydrate · 500 Orc
  Gold" and the short fact "Hydrate · 500 Orc Gold". Twitch's default name
  (`null`) reads "500 points". Redemptions are still never summed (plan 162,
  D3).
- **D4. Auto-show includes redemptions** when the Activity switch is on.
  `AUTO_SHOW_MAX_PENDING` (3) already keeps a run of them to a rolling
  sample.
- **D5. Custom Power-ups keep their own name.** In the owner's screenshot
  (2026-10-08), a big cat image titled "Meow, Mao" was drawn over a stream.
  That is a Custom Power-up: Twitch launched them in May 2026
  ([blog](https://blog.twitch.tv/en/2026/05/19/new-ways-to-turn-your-community-s-participation-into-earnings/)).
  The streamer sets the title, icon and bits price, and viewers buy it with
  bits. They arrive on `channel.bits.use` as `type: custom_power_up` with
  `custom_power_up { title, reward_id }`. Plan 162 already made the row, but
  dropped the title ("Used a Power-up · 500 bits"). The title now rides as
  `PowerUp.title`: "Used Meow, Mao · 500 bits". EventSub sends no icon, so
  Activity shows the viewer's avatar as for every Power-up.
- **Not now: the points icon.** GQL returns it, but drawing it needs the
  avatar/emote image cache path. That is a cheap follow-up if wanted.

## Changes

- `live_chat.rs`: `Redemption.points_name: Option<String>`, skipped when
  absent. The fake Twitch redemption says "Diamonds".
- `twitch_chat.rs`:
  - `fetch_channel_points_name` / `parse_channel_points_name`;
  - the `ChannelPointsName` per-stream cache;
  - `stamp_points_name` on every redemption before delivery.
  Tests point the read at the mock (`api_base_url`), so no test reaches
  Twitch.
- `shared/backend.ts`: `pointsName?: string`. The contract fixture's
  redemption carries `"Orc Gold"`.
- `stream-activity.ts`: `redemptionPoints` / `redemptionShort`.
- `twitch_chat.rs` `normalize_bits_use`: keeps `custom_power_up.title`;
  `stream-activity.ts` names a Custom Power-up by it.
- `activity-auto-highlight.ts`: `'redemption'` joins the auto-show kinds.
  The switch's tooltip says "rewards".

## Verification

- `cargo test -p videorc-backend -- twitch_chat live_chat storage protocol`
- `cargo clippy -p videorc-backend -- -D warnings`, `cargo fmt --check --all`
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm --filter @videorc/desktop test`, `pnpm test:scripts`

## Owner acceptance

On the next Twitch stream with Auto-show on, a redemption appears in
Activity as "Hydrate · 500 Orc Gold" and pops onto the stream as the
highlight card. With Auto-show off it only lists.
