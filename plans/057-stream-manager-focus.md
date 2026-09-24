# Plan 057: Stream Manager, chat first (a thin stats bar and less to read)

> Executor: implement the ordered slices below in an isolated worktree of current
> main. Read AGENTS.md and `.claude/skills/videorc-design/SKILL.md` first. Keep
> each slice independently testable. Planning authorizes no merge or release.

## Status and decisions

- Status: **EXECUTED 2026-09-24** on `feat/stream-manager-focus` (PR
  pending review). S1 to S6 are done and every local gate passes; see
  "Execution notes" at the end. Owner by-eye review is pending. Planned the
  same day: the owner asked for execution and a PR before the plan was
  finished ("When you're done with planning, execute the entire plan and
  create a PR"), so every decision below takes its recommendation.
- Priority P1. Effort M: about 3 agent-days over 6 slices. Risk LOW to MEDIUM:
  renderer-only, one window, no backend, wire or IPC change. The busiest window
  of a live stream, so every slice keeps the probe green.
- Planned against `origin/main` `3f17f731` (0.9.107). Paths are relative to
  `apps/desktop/src/renderer/src/` unless they start with `scripts/`, `docs/`
  or `apps/`.
- Owner route: UI/Product Design (fit 9). Model lanes: S1 to S5 `opus-4.8`
  (scoped, cosmetic UI), S6 `fable-5` (Review route).
- Branch: `feat/stream-manager-focus`. Commits use `feat(stream-manager):` or
  `fix(stream-manager):`.
- Owner feedback, 2026-09-24, on the 0.9.104 Stream Manager (plan 055):
  - "make the stats top bar thinner, it's too big vertically with lots of empty
    space, the main focus should be the chat"
  - "main metrics I look at are how many viewers, stream health, and duration.
    Maybe those should be closer together (or rearrangeable)."
  - "Generally speaking: reduce the verbosity of text, on stream you ain't got
    time to read"

### Decisions (the recommendation is taken)

1. **Placement: the stats get their own 32 px row under the title row.** They
   do not move into the title row. The title row keeps the title only (the
   owner's 2026-09-23 rule and the probe's assertion), it stays a clean drag
   band, and hover cards and drag-to-reorder work (a drag region swallows
   pointer events). The alternative, stats inside the title row, saves another
   32 px but breaks all three.
2. **The main three, in this order: the on-air clock, viewers, stream health.**
   They sit together at the leading edge at every width and are never clipped.
3. **Rearrangeable: yes (S5).** Drag a stat to reorder it; right-click the bar
   to show or hide stats, move one, or reset. The clock and the viewer count
   always stay in the three main slots, which keeps plan 047's rule (the viewer
   count is never hidden while live) true by construction.
4. **Chat timestamps appear on hover while live,** and always in History.
5. **The words rule: quiet when fine, specific when not.** A healthy state is a
   dot or a number. Words appear only when something needs the streamer: "X
   failed", "12 dropped/min", "X receive-only". The details stay one hover
   away, so no honesty rule from plan 055 is lost.

## Problem (measured on origin/main `3f17f731` and the 0.9.104 showcase captures)

### P1. The stats strip is 128 px tall and mostly empty

- The strip is a grid of flush tiles,
  `grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))]`
  (`components/stream-manager/stats-strip.tsx:158`). A grid row is as tall as
  its tallest tile.
- The Health tile stacks a label, the value, a detail line, a row of named
  destination dots and a 24 px sparkline (`stats-strip.tsx:87-135`). That sets
  every tile to about 128 px: measured on the 1280 px capture (seven tiles)
  and the 860 px capture (four tiles). The Session tile holds one line in that
  height.
- Above the chat at Wide: the title row (40) + the strip (128) + the filter row
  (40) = 208 px of chrome.

### P2. The three numbers the owner watches are far apart

- Tile order: Session, Viewers, Followers, Supporters, Tips, Chat, Stream health
  (`lib/stream-manager-stats.ts:204-288`). Health is last: at 1280 px it sits
  about 1,100 px from the clock.
- The narrow summary shows session, viewers and followers (`stats-strip.tsx:143-148`),
  so below 640 px stream health is not on screen at all.

### P3. Too many words for a glance

Inventory from the 1280 px capture:

- **Strip:** seven labels, plus six caption lines ("Peak 2.1k", "+83 this
  stream", "1,284 subs · 1,591 pts", "This stream", "25 chatters", "60 fps · No
  drops") and three named destination dots.
- **Title row:** a green "Live" badge (`components/stream-manager/stream-manager.tsx:478-483`)
  that repeats the strip's red "On air" chip, in a different colour.
- **Activity header:** "This stream: 4 follows · 8 subs · 600 bits · $20.00 · 1
  raid" (`activity-pane.tsx:183-185`) repeats the Supporters and Tips tiles.
  Below it are six filter words and a second row of platform icons.
- **Activity rows:** a sentence on its own line under each name ("Resubscribed
  for 14 months at Tier 1", "Raided with 142 viewers"; `lib/stream-activity.ts:99-232`).
- **Chat rows:** a clock time on every row ("02:06 PM"), "↳ Replying to @name:",
  and a "Mentions you" chip (`components/comment-row.tsx:258-289`).
- **Composer:**
  - "Sends to YouTube, Twitch + X" repeats "To: All".
  - "Orcle: listening · 2 q" repeats the Orcle segment's dot and count.
  - Every send leaves "You · <text> · sent" plus one "Platform · Sent" chip
    per destination (`chat-pane.tsx:661-723`).
- **Status bar:** "YouTube read · send" three times when everything works,
  plus the "Keep on top", "Highlight", "Clear view" and "Open Preview" labels
  (`stream-manager-status-bar.tsx:102-176`).

### P4. Two known chat defects, still on main (0.9.105 notes)

- **The newest message can hide.** `chat-pane.tsx:205-214` re-pins to the
  newest row only when the row count changes. A resize, or a row that grows
  once its emotes load, leaves the newest message out of view with no paused
  chip. This plan changes the composer's height (exception lines come and go),
  which would make that more frequent.
- **The wrong shortcut on Windows.** `lib/cohost-view.ts:627` hard-codes "⌘J"
  in Orcle's question toast. On Windows the shortcut is Ctrl+J.

## Design

### D1. One thin stats bar

One row, 32 px, at every tier. It replaces both the tile grid and the narrow
summary with one component (`StatsBar`, `data-slot="stats-bar"`).

- **The main three** sit at the leading edge, together, never clipped:
  - the On air chip and the clock;
  - the viewer glyph and the count;
  - stream health: a status dot and one value.
- **The rest** follow after a hairline, as a number and a short muted unit,
  separated by `·`: followers (+delta), subs, tips, chat pace.
  - They sit in a fixed-height, `overflow-hidden`, wrapping row. A stat that
    does not fit wraps to a hidden second line and drops off the end whole.
  - No JS resize state, so plan 055's container-query rule holds. A zero-width
    lead item lets even the first stat wrap instead of half-showing.
- **Mini sparklines** (48 × 16) beside viewers and health, at Wide only.
- **Details are one hover away.** Each stat keeps a `HoverCard`: the
  per-platform split, peak and average, fps, drops, each destination's state,
  the sub total and points, chatters. Each stat also carries a full sentence
  for screen readers.
- **Type.** Main values 15 px semibold tabular; the rest 13 px, the number in
  the primary tier and the unit in the secondary tier.

```text
Wide (1280 px). ♟ = viewer glyph, ● = status dot, ∿ = mini sparkline
┌ ● ● ●  Stream Manager ──────────────────────────────────────────────────────────────┐ 40
│ [On air] 1:42:26  ♟ 1.8k ∿  ● 6,012 kbps ∿ │ 89,860 followers +83 · 8 subs · $20 ·… │ 32
├──────────────────────────────────────────────────────┬─────────────────────────────┤
│ All ▢ ▢ ▢  Questions  Mentions  [ Search         ⌘F] │ [ Activity | ● Orcle 2 ]    │ 40
│ (chat: about 96 px taller than today)                │ sarzdotmd · 500 bits    now │
│                                                      │ tinkerpaws · Follow     now │
│ [To: All ▾] Send a message…                     ↵ ➤  │ PixelForge · Raid · 142  3m │
├──────────────────────────────────────────────────────┴─────────────────────────────┤
│ ▶● ▣● X●                                                        📌  ⊡  👁  Clear    │ 26
└────────────────────────────────────────────────────────────────────────────────────┘

Medium (860 px): the same bar; sparklines go, the rest drops from the end
│ [On air] 1:42:25  ♟ 1.8k  ● 6,012 kbps │ 89,860 followers +83 · 8 subs · $20 · 600 bits │

Narrow (380 px): the main three only. Health is now visible here too.
│ [On air] 1:42:25  ♟ 1.8k  ● 6,012 kbps │

Trouble: the health value turns into the problem
│ [On air] 1:42:26  ♟ 1.8k  ● X failed │ …
```

**Health, quiet when fine.** The dot's tone and the value come from one
priority list:

| State                     | Dot   | Value                  |
| ------------------------- | ----- | ---------------------- |
| A destination failed      | error | "X failed", "2 failed" |
| Frames dropped last min   | warn  | "12 dropped/min"       |
| Bitrate under 70% typical | warn  | "Low bitrate"          |
| A destination connecting  | warn  | "Connecting"           |
| Healthy                   | good  | "6,012 kbps"           |

The destination dots move from the bar into the health hover card, one row
per destination with its state and message.

**Other states.**

- History: `[History] Sep 24`, then viewers as "2.1k peak" (no health tile, as
  today).
- Recording only: `[Recording] 0:12:03`.
- Off air: "Off air".
- An unreadable count: "– followers", with the reason in the hover card. Never
  an unmeasured zero (plan 055, D8).

**The title row carries the title only.** Its mode badge goes: the bar's chip
says On air, and History has its own bar.

### D2. Rearrange and hide (decision 3)

- **Model:** `{ v: 1, order: StatId[], hidden: StatId[] }` in `localStorage`
  under `videorc.streamManager.statsBar`, per machine. The comments window
  already keeps renderer-local preferences there (the Orcle nudge,
  sensitivity). Every read and write is wrapped, and a bad value falls back to
  the default.
- **Main slots.** The first three positions of `order` are the main slots,
  whatever is hidden or unavailable in a session. A pure normalizer drops
  unknown ids, appends missing ones in default order, keeps `session` and
  `viewers` inside the first three, and never hides them. A move that would
  push either out is refused.
- **Drag.** Drag a stat onto another to move it there: native HTML5 drag and
  drop, the pattern in `components/takeover-screens-section.tsx`. No new
  dependency.
- **Right-click the bar** (shadcn `context-menu`, added with the CLI;
  `radix-ui` is already a dependency):
  - a checkbox per stat that can be hidden (health, followers, subs, tips,
    chat pace);
  - "Move left" and "Move right" for the stat under the pointer;
  - "Reset stats".
- Keyboard: the bar is focusable, so the context-menu key opens the same menu.
  Moving by keyboard is a follow-up.

### D3. Words: quiet when fine, specific when not

| Where        | Today                                                                        | After                                                    |
| ------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| Title row    | Stream Manager [Live]                                                        | Stream Manager                                           |
| Stats        | Session / On air 1:42:26                                                     | [On air] 1:42:26                                         |
| Stats        | Viewers / 1.8k / Peak 2.1k                                                   | ♟ 1.8k (peak on hover)                                   |
| Stats        | Stream health / 6,012 kbps / 60 fps · No drops / ● YouTube ● Twitch ● X      | ● 6,012 kbps (the rest on hover)                         |
| Stats        | Followers / 89,860 / +83 this stream                                         | 89,860 followers +83                                     |
| Stats        | Supporters / 8 / 1,284 subs · 1,591 pts                                      | 8 subs (total and points on hover)                       |
| Stats        | Tips / 600 bits · $20.00 / This stream                                       | $20 · 600 bits                                           |
| Stats        | Chat / 22/min / 25 chatters                                                  | 22 msg/min (chatters on hover)                           |
| Chat row     | 02:06 PM on every row                                                        | on hover while live; always in History                   |
| Chat row     | ↳ Replying to @nova_codes: is this rust or go?                               | ↳ @nova_codes: is this rust or go?                       |
| Chat row     | Mentions you                                                                 | @you                                                     |
| Chat         | Chat paused · 12 new ↓                                                       | 12 new ↓                                                 |
| Composer     | Sends to YouTube, Twitch + X                                                 | nothing                                                  |
| Composer     | Sends to YouTube + Twitch · X receive-only                                   | X receive-only                                           |
| Composer     | Orcle: listening · 2 q                                                       | nothing (the Orcle segment has the dot and count)        |
| Composer     | Replying to a question Orcle found. Edit freely, nothing sends until you do. | Orcle's draft. ↵ sends it.                               |
| After a send | You · hi chat · sent, then YouTube · Sent, Twitch · Sent, X · Sent           | nothing (the message shows up in chat)                   |
| After a send | You · hi · partial, then YouTube · Sent, Twitch · Failed, X · Receive-only   | Twitch failed, X receive-only                            |
| Activity     | This stream: 4 follows · 8 subs · 600 bits · $20.00 · 1 raid                 | gone; counts sit on the filters (Follows 4, Subs 8)      |
| Activity     | Resubscribed for 14 months at Tier 1                                         | Resub · 14 months                                        |
| Activity     | Subscribed with Prime / Subscribed at Tier 2                                 | Prime sub / New sub · Tier 2                             |
| Activity     | Cheered 500 bits / Super Chat · $20.00                                       | 500 bits / $20.00 Super Chat                             |
| Activity     | Raided with 142 viewers / Followed                                           | Raid · 142 viewers / Follow                              |
| Activity     | Joined as Orc Clan / Member for 6 months                                     | Member · Orc Clan / Member · 6 months                    |
| Status bar   | YouTube read · send (each platform)                                          | icon and dot; words only for "read-only", "failed", etc. |
| Status bar   | Keep on top, Highlight, Open Preview labels                                  | icons with tooltips at every width                       |
| Status bar   | Clear view                                                                   | Clear                                                    |
| Orcle toast  | … · ⌘J (also on Windows)                                                     | ⌘J on macOS, Ctrl+J on Windows                           |

Rules for the activity lines:

- The short line is for the pane only. `ActivityItem.line` keeps today's
  sentence for the on-stream highlight card (`commentHighlightCardText`),
  Copy, and the row's tooltip. Viewers read the card; the streamer glances at
  the pane.
- An activity row puts the name and the short fact on one line, with the time
  on the right and the viewer's own words below.
- A filter chip shows its count and hides at zero. "Destinations" appears only
  once a destination event exists.

### D4. The chat keeps the space

- The bar gives the panes about 96 px at Wide and Medium.
- The composer drops its summary line whenever every destination sends,
  another 20 px or so.
- While pinned, the chat re-pins when its viewport or its list resizes (P4),
  so a composer that grows or an emote that loads never hides the newest
  message.

## Slices

Each slice lists its model lane, size and a done-when check. Run them in order.

### S1. The stats bar (`opus-4.8`, M)

- `lib/stream-manager-stats.ts`: the tile models become bar items (`statItems`):
  - value, unit, delta, tone, badge;
  - the spark;
  - hover detail rows;
  - a screen-reader sentence;
  - the health priority list from D1.
    The supporters unit follows the session's platforms: "subs" with Twitch
    only, "members" with YouTube only, "supporters" with both.
- `components/stream-manager/stats-bar.tsx` replaces `stats-strip.tsx`: the
  main group, then the wrapping rest group, with hover cards. Mini sparklines
  at Wide only.
- `stream-manager.tsx`: render the bar, and remove the title row's mode badge.
- `ViewersIcon`, the one new glyph, goes in the window-scoped registry
  (`components/stream-manager/activity-icons.tsx`), never in
  `components/icons.tsx` (eager-chunk trap). Update the count in
  `docs/icon-set.md`.
- `main/index.ts` (`comments-window-layout-metrics`) and
  `scripts/comments-window-probe.mjs`: measure `stats-bar` instead of the strip
  and the summary.
- Done when:
  - `lib/stream-manager-stats.test.ts` covers: live and healthy; dropping; low
    bitrate; a failed destination; connecting; stale viewers; History;
    recording only; off air; a missing source hides its stat; and the
    supporters unit.
  - At every sweep width (320 to 1280 px), `pnpm probe:comments-window`
    asserts:
    - the bar is at most 32 px plus its hairline;
    - the clock, viewers and health are visible, first, and adjacent;
    - no stat straddles the bar's edge;
    - the viewer count is visible.

### S2. Chat and composer (`opus-4.8`, S)

- `comment-row.tsx`:
  - the time shows on hover or focus while live, and always in History;
  - reply context reads "↳ @name: text";
  - "Mentions you" becomes "@you", with the full words as its label.
- `chat-pane.tsx`:
  - the paused chip reads "N new ↓";
  - the Orcle draft note is shortened;
  - `DeliveryStatus` shows "Sending…" while sending, nothing on success, and
    only the destinations that did not get the message otherwise;
  - the ResizeObserver re-pin (P4).
- `comments-destination-status.tsx`: the composer line lists exceptions only,
  and the Orcle chip leaves the composer.
- `lib/cohost-view.ts`: the question toast names Ctrl+J on Windows (P4).
- Done when:
  - `comments-destination-status.test.ts` and `cohost-view.test.ts` cover the
    new words;
  - the probe's send cases assert exceptions only: the partial send names
    "Twitch failed" and "X receive-only", and never "Sends to";
  - a unit test proves the re-pin decision (pinned + resize scrolls to the
    end; unpinned does not).

### S3. Activity (`opus-4.8`, S)

- `lib/stream-activity.ts`: add `short` to `ActivityItem` for every kind (D3).
  `line` stays as it is.
- `activity-pane.tsx`:
  - the name and the short fact share one line;
  - the summary sentence goes;
  - filter chips carry counts and hide at zero;
  - Destinations appears only when it has rows;
  - the platform filter stays on the same row.
- Done when `lib/stream-activity.test.ts` covers the short line of every kind,
  plus the chip counts under a platform filter. A test pins
  `commentHighlightCardText` to its current output, so the on-stream card is
  unchanged.

### S4. Status bar and title row (`opus-4.8`, S)

- `stream-manager-status-bar.tsx`:
  - a provider shows its icon and dot, and a word only for an exception
    (read-only, reconnect to send, failed, ended, off, connecting);
  - the full capability sentence moves into the tooltip;
  - Keep on top, Highlight and Open Preview are icon-only at every width, with
    their accessible names;
  - "Clear view" reads "Clear".
- Done when:
  - the probe's control checks still pass by accessible name at every tier;
  - a unit test covers `providerCapabilityLabel` returning nothing for read
    and send, and the exception words otherwise.

### S5. Rearrange and hide (`opus-4.8`, M)

- `lib/stream-manager-stats-layout.ts`: pure `normalizeStatsLayout`,
  `moveStat`, `setStatHidden`, the default layout, and the storage key.
- `components/ui/context-menu.tsx` through the shadcn CLI. Check the
  `package.json` diff afterwards: `shadcn@rc` once added a bogus `cn` package.
- `stats-bar.tsx`: render the stats in layout order, with drag to reorder and
  the right-click menu (D2).
- Done when:
  - `lib/stream-manager-stats-layout.test.ts` covers: unknown and missing
    ids; locked stats kept in the main slots; a refused move; hide and show;
    reset; garbage storage;
  - a component-level check renders a custom order;
  - the probe still finds the viewer count at 320 px with the default layout.

### S6. Proof, docs and the owner's look (`fable-5`, Review route, S)

- Run the Verification list.
- Capture before and after screenshots at 1280, 860 and 380 px, in dark and
  light (the Stream Manager has followed light mode since #412), into
  `~/Desktop/Stream Manager screenshots/`. Do not commit them.
- Rewrite the design skill's Stream Manager section: the thin bar, the main
  three, the words rule, and customization. Also fix its stale "dark-always"
  line (only Preview is pinned dark since #412).
- Update `plans/README.md` and this plan's status. Draft the changelog line in
  the PR body; the release owns `changelog/`.
- Done when the gates pass and the PR is open with the screenshots described.

## Verification

- `pnpm typecheck`, `pnpm lint` (after `git add -N` on new files, for the
  em-dash gate), `pnpm format:check`, and `pnpm --filter @videorc/desktop test`.
- `pnpm build`, then `pnpm check:renderer-assets`. Compare the main window's
  eager delta against `origin/main` on the same machine: a Mac reads about
  1.6 KB above CI, and CI is the gate. Only `lib/cohost-view.ts` is shared with
  the main window's eager chunk, so the delta should be tens of bytes.
- `pnpm probe:comments-window`, including the width sweep and captures.
- `pnpm smoke:cohost-fake` (Orcle toast and pane untouched in behaviour).
- `pnpm smoke:comment-highlight-stream` only if `commentHighlightCardText`
  changes (it must not).

## Risks

- **Hiding by wrapping.** A clipped stat is still in the accessibility tree.
  That is acceptable, since a screen reader should hear every stat. The probe
  asserts nothing straddles the edge.
- **Fewer words, same truth.** Every removed caption survives in a hover card
  or a tooltip, and problems still speak in words. The "never an unmeasured
  zero" rule is unchanged.
- **Customization can hide what matters.** The clock and the viewer count
  cannot be hidden or moved out of the main slots. Health can be hidden, which
  the owner can undo with Reset.
- **Muscle memory.** The owner used the 0.9.104 layout for one day. The main
  three move closer; nothing moves out of the window.

## Out of scope

- The chat row density decision (plan 055, decision 5: big-text rows stay).
- The Orcle pane's own copy; its long sentences are tooltips already.
- Moving stats by keyboard (the menu's Move items cover the pointer case).
- Stats in the title row (decision 1).
- New stats or data sources.

## Handoff

- Goal: the chat gets the space. The on-air clock, viewers and health sit
  together in one thin bar, and the window reads at a glance.
- Current state: see P1 to P4. The window lives in
  `components/stream-manager/*`, the models in `lib/stream-manager-*.ts` and
  `lib/stream-activity.ts`, and the probe in
  `scripts/comments-window-probe.mjs` plus main's
  `comments-window-layout-metrics` command.
- Route and lanes: UI/Product Design; per slice as listed.
- Order: S1 → S2 → S3 → S4 → S5 → S6.
- Verification: the list above, per slice.
- Blockers: none. No real accounts are needed; the probe seeds fake data.

## Execution notes (2026-09-24)

What shipped differs from the plan in these places, each for the stated
reason:

- **S1, stats while the relay is late.** The session stat reads the relayed
  dashboard, so a window that has chat but no dashboard yet (the first
  second of a session, or the probe's early phases) says "Off air" until the
  relay arrives. The probe's idle checks read that instead of the removed
  title badge.
- **S1, the viewer and health stats hold their places while live.** They show
  "–" until the first sample, rather than appearing a few seconds in: the main
  three never jump. Viewers show only when a destination has a viewer API.
- **S1, zero is shown when it was measured.** "0 subs · 0 tips · 0 msg/min"
  stay, dimmed, because chat is read on those platforms; a platform without
  the data still shows nothing.
- **S2, delivery.** The composer's "Sending…" is the only delivery word. The
  send-failure badges (with their reasons) and the notes line already named
  every exception, so the per-destination "Sent" chips went too.
- **S5, the context menu.** The shadcn CLI (`radix-rhea`) again added the
  unrelated `cn` npm package and imported icons straight from the icon
  package; both were fixed by hand, and the component was brought to the
  dropdown menu's desktop scale.
- **S6, the main window's eager bytes.** Importing `lib/platform.ts` from the
  Stream Manager made Rollup move it into the chunk both windows load (+190
  bytes gzip for the main window). The window now reads the host OS from the
  user agent itself. The remaining delta against `origin/main` on the same
  Mac is +95 bytes gzip (386,086 vs 385,991): the toast's shortcut parameter,
  and the Radix menu parts the context menu reuses from the shared chunk. CI
  reads about 1.6 KB lower than a Mac.
