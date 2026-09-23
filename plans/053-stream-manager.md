# Plan 053: Stream Manager, a live dashboard that replaces the Chat window

> Executor: implement the ordered slices below in an isolated worktree of current
> main. Read AGENTS.md and `.claude/skills/videorc-design/SKILL.md` first. Keep
> each slice independently testable. Planning authorizes no merge or release.

## Status and decisions

- Status: PLANNED 2026-09-24. Not started. Priority P1 (owner: "create some
  kind of live stream studio where we can see the entire chat, how many users
  are currently live, followers, and all the things like that … completely
  replace our chat window"). Effort L: about 12–16 agent-days over 14 slices.
  Risk MEDIUM: new provider calls, an optional scope change, a new relay channel,
  and the busiest window of a live session.
- Planned against `origin/main` `a3ababf9` (0.9.103). Evidence below comes from
  that tree; paths are relative to `crates/videorc-backend/src/` for Rust and
  `apps/desktop/src/` for the app.
- Owner route: Orchestrator (fit 10) for the plan as a whole. Per-slice model
  lanes are listed on each slice: data slices `gpt-5.5`, relay and reliability
  slices `fable-5`, window and UI slices `opus-4.8`, and acceptance `fable-5`
  (Review route).
- Branch: `feat/stream-manager`. Commits use `feat(stream-manager):`,
  `fix(chat):` or `fix(viewers):` as fits.
- **The rename is user-facing only.** The window keeps its code name
  `comments`: entry `renderer/comments.html`, IPC `comments-window:*`,
  `userData/comments-window.json`, and `probe:comments-window`. This is the
  same approach as `cohost` staying under "Orcle".
- Reference: the Twitch Stream Manager screenshot the owner shared on
  2026-09-24. It has:
  - a stats strip: session clock, viewers, followers, bitrate sparkline,
    subscribers, sub points, pre-roll timer, output resolution;
  - chat on the left, with first-time-chat cards, reply context, mentions and a
    "Chat paused due to scroll" pill;
  - an Activity Feed on the right: resubs, gifted subs, cheers with messages,
    hype train, each row with a `⋯` menu and filters;
  - a camera preview.

  Videorc streams to up to five platforms at once, so every one of these must
  be multi-platform, and honest where a platform has no API.

### Owner decisions needed (recommendations in bold)

1. **Name: "Stream Manager".** It is what streamers already call this surface,
   and it does not collide with Videorc's Studio. Alternatives: "Live Desk",
   "Control Room" (YouTube's name), "Live Studio" (collides with Studio).
2. **Twitch permissions: ship without new scopes first.** Follow events need
   `moderator:read:followers`, and the subscriber count needs
   `channel:read:subscriptions`. Either makes every Twitch user reconnect once.
   The follower total (if S0 confirms it needs no new scope), subs, gifts,
   raids and cheers already work with today's scopes. Follow alerts and the sub
   count become an opt-in "Reconnect Twitch" upgrade (S6).
3. **Moderation (delete, timeout, ban): Phase 2** (S13), with its own scopes.
   v1 ships read, send, show-on-stream and Orcle.
4. **Live video preview inside the window: no.** The Preview window already
   floats and docks. A second native preview surface (CAMetalLayer / D3D11)
   costs a GPU path, and the window is visible in display capture. The status
   bar gets an "Open Preview" action instead.
5. **Density: keep the big-text chat rows at every width.** The 2026-06-24
   decision made the Chat window "a purpose-built big-text reader, not the
   dense in-app panel". The dashboard's density comes from the stats strip and
   the Activity pane, not from smaller chat text. Alternative: a Compact chat
   option.
6. **Opening: remember the last state, as today.** Settings adds "Open Stream
   Manager when I go live" (default off).
7. **Premium: free, like chat today.** Orcle stays Premium inside it.
8. **Dependencies: add `@tanstack/react-virtual` and the shadcn `chart`
   primitive (Recharts),** both in the Stream Manager bundle only.
   - The virtualizer is headless (about 5 kB gzip). It lifts the 500-message
     cap to 2,000 without jank, and is not a component library, so the
     shadcn-only rule holds.
   - The chart is what the design skill prescribes instead of a hand-rolled
     sparkline.
   - Neither touches the main window's eager renderer budget
     (`check:renderer-assets` measures `index.html` only).

## Problem (measured from source, origin/main a3ababf9)

### P1. The Chat window is only a chat reader

`renderer/comments/main.tsx` (`CommentsWindowApp`) renders `WindowFrame` →
`CommentsReader` (`renderer/src/components/comments-reader.tsx:68-494`).

It has:

- a unified YouTube / Twitch / X feed, capped at 500 messages
  (`shared/comments-snapshot-delta.ts:8`), all rendered with no virtualization;
- send-to-all to every provider with `write === 'ready'` (200-character cap;
  `lib/chat-send.ts:13-40`);
- click-to-show on stream (10 s card, corner picker, default `bottom-left`);
- keep on top, Clear view, and a viewer chip with the per-platform split only
  in its tooltip (`components/comments-header.tsx:43`);
- Orcle presence and pane;
- History mode (Library "Open Chat");
- the plan 047 width tiers.

It has no stats beyond the viewer chip, no activity feed, no filters or
search, no moderation, and no stream health. Emotes, badges and roles arrive
(`fragments`, `authorBadges`, `authorRoles`) but are never rendered
(`components/comment-row.tsx`). `filterMessagesByPlatform` and `visibleMessages`
in `lib/live-chat-view.ts` exist and are unused.

### P2. The data a dashboard needs mostly exists, flattened or unused

- **Twitch.** EventSub (`twitch_chat.rs`, five subscriptions, `user:read:chat`)
  already delivers:
  - through `channel.chat.notification`: subs, resubs, gifted and community
    subs, prime and gift upgrades, pay-it-forward, raids and announcements;
  - through `channel.chat.message.cheer`: cheers
    (`twitch_chat.rs:379-455`).
- **YouTube.** Polling (`youtube_chat.rs:309-432`) already parses Super Chats,
  Super Stickers, new members, milestones and gifted memberships.
- **All of it is flattened.** Each event becomes a `LiveChatMessage`
  (`live_chat.rs:117-146`) with only `amountText`, `messageText` and
  `rawProviderType`. There is no amount in micros, currency, tier, months,
  gift count or raid size. Raids and announcements arrive as generic `system`
  rows.
- **Viewer history is written but never read.** Samples are saved to the
  session log with code `stream-viewers`. Nothing reads them back, so there is
  no history or peak.
- **Stream health never reaches the Chat window.**
  - `stream.health` covers the whole output: bitrate, fps, dropped frames, at
    most every 2 s (`protocol.rs:1357-1371`).
  - `stream.targets` has a state per destination (`streaming.rs:421-441`).
  - Both reach the main renderer only.

### P3. What does not exist

- **Follower and subscriber counts.** Not implemented anywhere. Profile lookups
  fetch only names and avatars (`oauth.rs:2786`, `:2804`, `:2823`).
- **Follow events.** Twitch `channel.follow` v2 needs `moderator:read:followers`.
  YouTube and X have no follow-event API.
- **Moderation.** There are no delete, timeout or ban calls. Orcle's
  hide/timeout/ban flags are labels only (`cohost.rs:177-187`).
- **Per-destination bitrate and dropped frames.** The fields exist but are
  never filled (`streaming.rs:74-86`).

### P4. Bugs a dashboard would expose

- **B1. The viewer total flips.** Two samplers run: YouTube + Twitch start from
  `liveChat.start` (`live_chat.rs:1439-1470`), and X from `liveChat.x.start`
  (`:1570-1579`). Each emits its own partial `total`. Main keeps only the latest
  (`main/index.ts:524`, `:2642`). So with X plus Twitch or YouTube live, the
  count alternates between two wrong totals.
- **B2. Tokens expire mid-stream.**
  - YouTube and Twitch tokens are captured once at session start: YouTube is
    refreshed once if near expiry (`main.rs:2844`), and Twitch is read raw
    (`main.rs:2869-2873`).
  - A long stream outlives a Twitch user token. A mid-session 401 stops YouTube
    chat and silences its viewer count.
  - A window meant to run all stream long makes this visible.
- **B3. A stale comment.** `main/index.ts:2399-2403` calls the Chat window
  content-protected. It is not: only Notes is (owner call, 2026-08-19).

### P5. Platform reality (what can be shown per platform)

|                | Twitch                                                   | YouTube                                                                              | X                                                                                          | TikTok / Instagram / custom |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------- |
| Chat read      | yes (EventSub)                                           | code exists; **off in public builds** until Google approves OAuth (`oauth.rs:38-59`) | yes via the web relay; needs "Authorize X Live" + Videorc sign-in; OAuth destinations only | no API                      |
| Chat send      | yes (`user:write:chat`)                                  | yes (off)                                                                            | yes, 140 characters                                                                        | no                          |
| Viewers        | yes, Helix `streams`, every 30 s                         | yes, `concurrentViewers` (off)                                                       | yes, `/2/broadcasts/{id}`                                                                  | no                          |
| Followers      | not yet: Helix `channels/followers` `total` (S0: scope?) | not yet: `channels.list statistics.subscriberCount` (off)                            | not yet: `users/me` `public_metrics.followers_count` (`users.read` already granted)        | no                          |
| Subs / members | events yes; count needs `channel:read:subscriptions`     | events yes (off); no count API                                                       | no                                                                                         | no                          |
| Tips           | cheers (bits)                                            | Super Chat / Sticker (off)                                                           | no                                                                                         | no                          |
| Raids          | yes, as `system` rows without size                       | n/a                                                                                  | n/a                                                                                        | no                          |
| Follow events  | needs `moderator:read:followers`                         | no API                                                                               | no API                                                                                     | no                          |
| Moderation     | needs new scopes                                         | allowed by `force-ssl` (off)                                                         | unknown (S0)                                                                               | no                          |

The window must say which of these apply to the current session, and why a
tile is empty. It must never show a zero it did not measure.

## Design

### D1. One window, three widths

The Stream Manager is the Chat window grown up. It keeps the same entry,
relay, persistence, keep-on-top, History mode, highlight and Orcle. Layout
switches with container queries on the window body, not JS resize state (the
plan 047 approach).

- **Wide (body ≥ 1040 px).** The stats strip, then Chat (flexible) beside a
  right pane clamped to 340–440 px. The right pane has a segmented control:
  Activity · Orcle (Orcle only when available).
- **Medium (640–1039 px).** A compact stats strip, then one pane with a
  segmented control: Chat · Activity · Orcle, with unseen counts on the
  segments.
- **Narrow (under 640 px, minimum 320 px).** A one-line summary (on-air dot,
  clock, viewers) above the same segmented control. The viewer count is never
  hidden while live (owner, plan 047). Chat keeps the plan 047 tiers.

Default size: 1120 × 720 (was 420 × 640); the minimum stays 320 × 360.
`comments-window.json` gains `layoutVersion: 2`. A saved frame that equals the
old default moves to the new default once; any frame the user sized is kept.

```text
┌ (traffic lights)  Stream Manager ─────────────────────────────────────────────┐
│ ● ON AIR 0:30:40 │ Viewers 529 ▁▂▃▅▆ │ Followers 61,930 +12 │ Supporters +5 │  │
│ Tips 1,500 bits · $42 │ Chat 38/min · 211 chatters │ 6,012 kbps ▅▆▆ 0.1% ● ● ●  │
├────────────────────────────────────────────┬─────────────────────────────────┤
│ Chat   [All ▾] [Questions] [Mentions] ⌘F   │ [ Activity | Orcle ]            │
│ ▣ maria_rocks  me and julius have …        │ This stream: 12 follows · 5 subs│
│ ✦ First time  Nacroni_  can anyone ask …   │ [Follows][Subs][Tips][Raids]    │
│ ↳ Replying to @ph4se_on3 …                 │ ★ morgaesis  Resub · 3 months   │
│            ⏸ Chat paused · 12 new ↓        │ ◆ sarzdotmd  Cheered 1,500 bits │
│ [Send to: All ▾] Send a message…      ⌘↵   │ ⇢ raider42   Raided · 234       │
├────────────────────────────────────────────┴─────────────────────────────────┤
│ Twitch ● read · send   X ● read-only        Keep on top · Highlight ▾ · Clear │
└──────────────────────────────────────────────────────────────────────────────┘
```

### D2. The stats strip

Each tile renders only when its source exists for this session. Values are
never faked; this follows `viewer_stats.rs`, which sends no sample when no
platform reported. The tiles:

1. **Session.** A tinted ON AIR chip plus the clock, from
   `RecordingStatus.startedAt`. It reads "Recording" when record-only. Off air
   it reads "Off air", plus the last session's summary.
2. **Viewers.** The total, with the per-platform split in a HoverCard. It also
   shows the peak this stream and a 60-minute sparkline. It goes stale after
   75 s, as today (`lib/viewer-count-view.ts`).
3. **Followers.** The sum across the platforms that report, plus "+N this
   stream". The HoverCard splits it: Twitch followers, X followers, YouTube
   subscribers.
4. **Supporters this stream.** The count of new subs, members and gifted subs,
   from activity events. It needs no new scope. With decision 2's scope, it
   adds the Twitch sub total and points.
5. **Tips this stream.** Bits plus Super Chat and Super Sticker totals, per
   currency, from the structured details (S2).
6. **Chat.** Messages per minute and unique chatters this stream.
7. **Health.**
   - Bitrate with a sparkline, the dropped-frame percentage, and fps.
   - The tone turns to warning above 1% dropped, or below 70% of the target
     bitrate.
   - Destinations appear as platform dots (live / failed), with the message
     on hover.

Numbers use `tabular-nums` and the compact format of `viewer-count-view.ts`
(1.2k). Tiles are flush cells split by hairlines; the design skill allows no
cards inside a window. Tone lives only in dots and chips. Sparklines use the
shadcn `chart` primitive (decision 8).

History mode shows the session's summary: peak viewers from the saved
`stream-viewers` log (S4 adds the read RPC), follower change, and activity
totals.

### D3. The chat pane

It keeps:

- the big-text rows and click-to-show on stream;
- pin-to-bottom, with the "N new comments ↓" chip reworded to "Chat paused ·
  N new ↓";
- the composer, Orcle drafts, and History mode.

It adds:

- **Emotes** from `fragments`, fetched through the `avatars:cache` path, which
  is allowlisted per CDN host (the Twitch emote CDN is added).
- **Role badges** (owner, moderator, VIP, member) as glass tag chips.
- **Reply context** ("Replying to @name …") from Twitch `reply` (S2), and
  mentions of the streamer highlighted.
- **A first-time marker.** Twitch `message_type: user_intro`, or any author
  never seen in the user's earlier sessions (read from `live_chat_messages`,
  S2).
- **Filter chips** (platform, Questions from Orcle, Mentions) and ⌘F search,
  wiring the unused `visibleMessages`.
- **A `⋯` on each row:** Show on stream, Reply (prefills `@name`), Copy.
- **A destination picker** in the composer ("Send to: All ▾", with a checkbox
  per `write === 'ready'` provider). The cap is the strictest among the
  selected providers (140 with X).
- **A virtualized list** with the cap raised to 2,000 (decision 8).

### D4. The activity pane

Structured events, never chat text:

- follows, when available;
- subs, resubs, gifted subs, community gifts, prime and gift upgrades,
  cheers, raids and announcements (Twitch);
- Super Chats and Stickers, new members, milestones and gifted memberships
  (YouTube);
- Videorc's own destination changes: a destination failed or recovered, from
  `stream.targets` transitions.

Row anatomy: the platform tile carries the event icon, then the name, then one
line ("Resubscribed for 8 months at Tier 1", "Gifted 5 subs", "Raided with 234
viewers", "Super Chat · $5.00"), the viewer's message if any, and the relative
time. Rows are a `GroupedList`. Each row has a `KebabMenu`:

- **Show on stream:** the highlight card, in an event variant.
- **Thank in chat:** prefills the composer; with Orcle on, it asks Orcle for a
  draft.
- **Copy.**

The pane header shows "This stream: 12 follows · 5 subs · 1,500 bits · $42",
filter chips (Follows, Subs & members, Tips, Raids, Destinations) and a
platform filter. The segment shows an unseen count. The empty state is honest
per platform: "X doesn't share follows or tips through its API."

Chat keeps showing paid and membership rows inline, as today. Follows never
appear in chat.

### D5. The Orcle pane

`CohostPane` moves into the right pane (wide) or its segment (medium and
narrow). Its behaviour is unchanged: questions, flags, alerts, mood, ⌘J focus,
and the ↑/↓ R/H/A/⌫ keys. `CohostStatus` presence moves from the header to the
segment label (a dot) and the Session tile. `CohostNudge` stays in the
composer.

### D6. Chrome and controls

- **The title row carries the title only** (owner call, 2026-09-23: no buttons
  in the top-right corner).
- **Controls move to a bottom status bar** (`StatusBar`), replacing the
  header's `ChatHeaderActions` and its `⋯` fold:
  - on the left, each provider's chat state (Twitch ● read · send, X ●
    read-only, and so on);
  - on the right, quiet clickable hints: Keep on top (pressed state),
    Highlight corner (menu), Clear view, Open Preview (decision 4).
- **Unchanged:**
  - The glass: dark-always `chat` role, per plan 050.
  - Capture protection: none, per the 2026-08-19 owner call. B3 fixes the
    stale comment.
  - Studio's rule that closes an unprotected Chat window during a recording
    (`use-studio.tsx:8860-8880`).
- **Labels renamed** to "Stream Manager": the status-bar hint (`⇧⌘J`), the
  command palette entry, the Studio Orcle row, the Stream Deck and phone
  "open window" actions. Library's "Open Chat" becomes "Open in Stream
  Manager".

### D7. Data and relay

**The locked relay stays.** Only the main renderer holds the backend
WebSocket, and the window gets everything through main (2026-06-24 decision).

**One consolidated push is added, `LiveDashboardState`:**

- Built in the main renderer from `recording.status`, `stream.viewers`,
  `stream.audience` (new), `stream.health` and `stream.targets`.
- Coalesced to at most 1 Hz and cached in main, like `latestViewerSample`.
- Sent on `comments-window:dashboard-push`, delivered as event `dashboard`, and
  seeded with `dashboard-get`.
- Role gates: push is `MAIN_ONLY`; get and the event are `MAIN_AND_COMMENTS`.
- The preload allow-list gains `onDashboard` / `getDashboard`.
- The probe proves the window cannot forge it, as it already does for viewers.

```ts
interface LiveDashboardState {
  sessionId: string | null
  session: { state: 'off-air' | 'recording' | 'live'; startedAt: string | null }
  viewers: { latest: ViewerSample | null; peak: number | null; history: ViewerHistoryPoint[] }
  audience: AudienceSnapshot | null // S3
  health: { latest: StreamHealth | null; bitrateHistory: number[] } | null
  targets: StreamTargetsSnapshot | null
}
```

**Activity is a projection, not a second stream.** It is computed in the
window from the existing chat snapshot and deltas, plus `follow` rows. Totals
come from one pure module (`lib/stream-activity.ts`), shared with History mode.

**Backend changes:**

- `LiveChatMessage.details: Option<LiveChatEventDetails>`, with
  `skip_serializing_if = "Option::is_none"`. A serialized `null` has broken app
  load three times (memory: serde null trap). The TypeScript field is optional,
  and the contract fixtures are updated.
- A new `LiveChatEventType::Follow` (`follow`).
- A single viewer aggregator per session (B1).
- `audience.rs`, a follower and subscriber poller (S3).
- Connector token refresh (B2).

```rust
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LiveChatEventDetails {
    SuperChat { amount_micros: u64, currency: String, amount_display: String, tier: Option<u32> },
    SuperSticker { amount_micros: u64, currency: String, amount_display: String, alt_text: Option<String> },
    Membership { kind: MembershipKind, level_name: Option<String>, months: Option<u32>, gift_count: Option<u32>, recipient: Option<String> },
    Subscription { kind: TwitchSubKind, tier: String /* 1000|2000|3000|prime */, months: Option<u32>, streak_months: Option<u32>, gift_count: Option<u32>, recipient: Option<String> },
    Cheer { bits: u64 },
    Raid { from_name: String, viewer_count: u64 },
    Announcement { color: Option<String> },
    Follow,
}
```

### D8. Honest capability states

- **A capability line per platform.** For every platform in the session, the
  window derives one line from `LiveChatProviderState` plus the audience
  capability (S3). The status bar shows it, and empty tiles say why:
  - "YouTube: public builds connect YouTube after Google approves Videorc."
  - "TikTok has no public live API."
  - "X Live isn't authorized."
- **Unreported tiles stay hidden.** A tile with no source anywhere in the
  session is hidden, not zeroed.

## Slices

Each slice lists its model lane, size (S/M/L) and a done-when check. Slices in
a phase can run in parallel unless noted.

### Phase 0: facts

**S0. Provider facts spike** (`fable-5`, S; owner-assisted for real accounts).

Verify on the owner's accounts, and save sanitized response fixtures under
`scripts/fixtures/stream-manager/`:

1. Does Helix `GET /helix/channels/followers?broadcaster_id=…` return `total`
   with today's Twitch token (no `moderator:read:followers`)?
2. Real `channel.chat.notification` payloads for sub, resub, sub_gift,
   community_sub_gift, raid and announcement. Use the Twitch CLI mock
   (`twitch event trigger`) where a real event is impractical.
3. `channel.chat.message` fields `reply`, `message_type` (`user_intro`) and
   `cheer`.
4. X `GET /2/users/me?user.fields=public_metrics`, with the OAuth 2.0 token and
   with the X Live OAuth 1.0a token.
5. YouTube `superChatDetails`, `superStickerDetails`, `newSponsorDetails`,
   `memberMilestoneChatDetails` and `membershipGiftingDetails` shapes, from the
   docs plus one verification-build stream if available.
6. Whether X broadcast chat exposes any moderation or delete API.

Done when `docs/specs/stream-manager-provider-facts.md` marks every "not yet"
cell of the P5 table as verified or refuted, with evidence, and the fixtures
exist.

### Phase 1: data (backend)

**S1. One viewer total, with peak and history** (`gpt-5.5`, S). Fixes B1.

- Replace the two partial samplers' totals with a per-session aggregator. It is
  keyed by platform and keeps each platform's latest count and time. The total
  is the sum of fresh platforms (fresh = at most 75 s old).
- `stream.viewers` always carries every live platform.
- Add `sessions.viewers.list {sessionId}`, which reads `stream-viewers`
  session-log samples for History and for sparklines after a reopen.
- Done when a Rust test runs both samplers and never emits a partial total, and
  `sessions.viewers.list` returns the samples of a finished session.

**S2. Structured event details** (`gpt-5.5`, M). Depends on S0 fixtures.

- Add `LiveChatEventDetails` and `LiveChatEventType::Follow`.
- Parse the YouTube detail objects and the Twitch notification sub-objects.
  Raids and announcements get details instead of plain `system`.
- Add `reply` and `firstMessage` (from `user_intro`) to `LiveChatMessage`.
- Add `sessions.chat.authorsSeen {platform, authorIds[]}` → set, which backs
  the "first time" marker from `live_chat_messages` history.
- Update the TypeScript types, contract validators and fixtures.
- Done when Rust tests replay the S0 fixtures into the exact details. An old
  row without `details` still deserializes, and the renderer loads a snapshot
  with and without the field.

**S3. Audience poller** (`gpt-5.5`, M).

- New module `audience.rs`. Per session, for each connected account on a live
  destination, it polls every 120 s with jitter:
  - Twitch followers `total`;
  - X `followers_count`;
  - YouTube `subscriberCount`, only when YouTube OAuth is enabled.
- It keeps each platform's first reading as the baseline for "+N this stream".
- It emits `stream.audience` (`AudienceSnapshot`: a capability, total and delta
  per platform) and answers `stream.audience.snapshot`.
- Failures back off to 10 minutes and never block chat.
- Done when mock-server tests cover success, a scope error (capability
  `needs-reconnect`), a hidden subscriber count and backoff, and a fake session
  emits a baseline and a delta.

**S4. Tokens that outlive the stream** (`fable-5`, M). Fixes B2.

- The Twitch and YouTube connectors, the viewer sampler and the audience
  poller refresh the access token when it is near expiry. On a 401 they
  refresh once, then reconnect.
- The EventSub socket re-creates its subscriptions after the refresh.
- Done when a test with a token that expires mid-session keeps chat and
  viewers flowing (fake EventSub and YouTube servers), and a revoked refresh
  token produces a clear `failed` provider state rather than silence.

**S5. Destination events for Activity** (`gpt-5.5`, S).

- Record `stream.targets` state transitions (live → failed and back) as
  timestamped entries the renderer can project into Activity.
- Done when a fake target failure produces one "destination failed" entry and
  one "recovered" entry in the relayed state.

**S6. Opt-in Twitch scopes** (`gpt-5.5`, M). Only if decision 2 is accepted.

- Add `moderator:read:followers` and `channel:read:subscriptions` as an
  optional scope set.
- "Reconnect Twitch for follow alerts and sub count" appears in the Stream
  Manager capability line and in Livestream → Setup.
- With the scopes: subscribe to `channel.follow` v2 (→ `follow` rows) and poll
  `/helix/subscriptions` `total` and `points`.
- Done when a connection without the scopes behaves exactly as before, and one
  with them produces follow rows and a sub total in a fake EventSub run.

### Phase 2: relay

**S7. `LiveDashboardState` relay** (`fable-5`, M).

- Build the state in the main renderer (`use-studio.tsx`), coalesced to 1 Hz.
- Add the IPC channels, main cache, role gates and preload API (D7).
- Keep a 60-minute viewer history (120 points) and a 10-minute bitrate history
  in the main-process cache, so a window opened mid-stream starts full.
- Done when:
  - `main/*.test.ts` covers the role gates and the cache;
  - `probe:comments-window` proves the window cannot push dashboard state;
  - a mid-stream reopen shows full history in a fake session.

### Phase 3: the window

**S8. Window shell** (`opus-4.8`, M).

- User-facing rename and new default size, with the one-time `layoutVersion`
  migration.
- The three width tiers (D1), and segmented panes with unseen counts.
- The bottom status bar with the controls moved out of the header (D6).
- Fix B3's stale comment.
- Done when `probe:comments-window` passes the width sweep, extended to
  320/480/640/800/1040/1280 px:
  - no overflow at any width;
  - the viewer count is visible at every width while live;
  - the title row has no buttons;
  - every control is reachable at each tier;
  - a saved 420 × 640 frame migrates once, and a custom frame is kept.

**S9. Stats strip** (`opus-4.8`, M). Depends on S1, S3 and S7.

- The tiles from D2, with HoverCard splits and sparklines (shadcn `chart`).
- Capability-aware empty states, and the History-mode summary.
- Done when:
  - component tests render each tile from fixtures, and a missing source hides
    the tile rather than zeroing it;
  - the probe captures the strip at each tier in both a live and a
    record-only session.

**S10. Chat pane** (`opus-4.8`, L). Depends on S2.

- Everything in D3.
- The emote allowlist extends the avatar cache's host policy; it adds a test
  that a non-allowlisted host is refused.
- Virtualization keeps pin-to-bottom, the paused chip and keyboard focus.
- Done when:
  - unit tests cover filters, search, the first-time marker, reply rendering and
    the destination picker's strictest cap;
  - `smoke:live-chat-fake-providers` drives 2,000 messages at 50/s without
    dropped frames in the window (measured with the probe's frame counter);
  - highlight still works from a filtered view.

**S11. Activity pane** (`opus-4.8`, M). Depends on S2, S5 and S7.

- Everything in D4. The event variant of the highlight card extends
  `renderCommentHighlightPng`.
- "Thank in chat" prefills, and asks Orcle when it is on.
- Done when:
  - `lib/stream-activity.ts` unit tests turn S0 fixtures into rows and totals;
  - the fake-provider smoke emits every event kind and the pane lists them with
    the right text;
  - an event's "Show on stream" passes `smoke:comment-highlight-stream`'s card
    analyzer.

**S12. Orcle pane** (`opus-4.8`, S).

- The move and presence changes from D5.
- Done when `smoke:cohost-fake` passes unchanged, and the keys and ⌘J focus
  work in the right pane and in the medium and narrow segments.

### Phase 4: moderation (decision 3)

**S13. Moderation** (`gpt-5.5` backend, `opus-4.8` UI; M). Phase 2 by default.

- Twitch delete, timeout and ban, via `moderator:manage:chat_messages` and
  `moderator:manage:banned_users` (a reconnect prompt, like S6).
- YouTube `liveChatMessages.delete` and `liveChatBans.insert` (`force-ssl`, for
  verification builds). X per S0.
- The row `⋯` gains the actions where supported. Orcle's flag actions become
  real buttons.
- Done when fake-server tests cover each call, and the UI hides actions a
  platform or scope cannot perform.

### Phase 5: acceptance

**S14. Gates, docs and live acceptance** (`fable-5`, Review route, M).

- Run the Verification list below.
- Write `docs/acceptance/<date>-stream-manager.md`.
- Add a "Stream Manager" section to the design skill.
- Draft the changelog entry (macOS Beta, plus the Windows Alpha carry-forward).
- The owner does live acceptance on a real Twitch stream plus X (and YouTube
  in a verification build). They check stats against each platform's own
  dashboard, the activity rows against Twitch's Activity Feed, and chat under
  load.
- Done when the gates pass and the owner signs off.

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:scripts`, and
  `pnpm --filter @videorc/desktop test`.
- `cargo fmt --check --all`, `cargo clippy -p videorc-backend -- -D warnings`,
  targeted `cargo test -p videorc-backend` for `live_chat`, `twitch_chat`,
  `youtube_chat`, `x_chat`, `viewer_stats` and `audience`, and
  **`cargo check --release -p videorc-backend`**. Release-only breakage is
  invisible to debug gates (memory: release-build cfg gap; #394 shipped one).
- `pnpm probe:comments-window`, extended by S7, S8 and S9.
- `pnpm smoke:live-chat-fake-providers`, extended with event fixtures,
  audience values and load.
- `pnpm smoke:comment-highlight-stream` and `pnpm smoke:cohost-fake`.
- `pnpm probe:ui-glass --gate`. The chat role must keep its pinned-dark glass.
- `pnpm smoke:remote-lan`. The phone's chat projection is unchanged.
- The owner's live acceptance (S14).

## Risks

- **YouTube is dark in public builds.** Until Google approves, a YouTube-only
  streamer sees only health and destination tiles. The capability line must
  say so plainly, or the window looks broken.
- **API quotas.** One YouTube `channels.list` call per 2 minutes is about
  30 units an hour. Twitch Helix calls are about 60 an hour per poller. S3
  backs off on errors and never polls without a live destination.
- **Chat volume.** Big Twitch channels reach 50+ messages a second. S10
  virtualizes and caps at 2,000. The relay already coalesces deltas; watch
  main-process IPC load in the S10 smoke.
- **The one-time scope bump (S6, S13)** makes Twitch users reconnect. It stays
  opt-in and says what it unlocks.
- **Relay dependency.** The window still pauses if the main renderer stalls.
  That is accepted by the locked 2026-06-24 decision; closing the main window
  closes the Stream Manager anyway.
- **Contract drift.** Every new optional field needs the TypeScript contract,
  validators and fixtures updated together. The renderer RPC contract rejects
  unknown fields in places (memory: scheduled mutation schema).

## Out of scope

- A live video preview inside the window (decision 4).
- Per-destination bitrate and dropped frames. It needs per-leg FFmpeg stats;
  the fields stay empty.
- Channel points, predictions, polls, hype-train progress, ads and pre-roll,
  raids and shoutouts as actions, and editing the title or category live.
- TikTok and Instagram chat, viewers or activity (no public APIs).
- Stats on the phone remote. It is a natural follow-up once `LiveDashboardState`
  exists.

## Handoff

- Goal: replace the Chat window with a Stream Manager that shows the whole
  chat, live viewers, followers, supporters, tips, activity and stream health
  across every streaming destination, honestly per platform.
- Current state: see Problem (P1–P5). The window lives in `comments.html` and
  `components/comments-reader.tsx`. Data is relayed by `main/index.ts` from
  `hooks/use-studio.tsx`. The backend sources are `live_chat.rs`,
  `twitch_chat.rs`, `youtube_chat.rs`, `x_chat.rs` and `viewer_stats.rs`.
- Route and lanes: Orchestrator overall; per slice as listed.
- Order: S0 → Phase 1 (S1–S6 in parallel after S0) → S7 → Phase 3 (S8 first,
  then S9–S12) → S13 if accepted → S14.
- Verification: the list above, per slice.
- Blockers:
  - S0 and S14 need the owner's real Twitch and X accounts.
  - YouTube needs a verification build.
  - S6 and S13 need the owner's decisions 2 and 3.
