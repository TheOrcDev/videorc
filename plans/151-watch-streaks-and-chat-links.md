# Plan 151: Watch streaks in Activity, and chat links you can open or copy

> Executor: implement the slices below in order, in one isolated worktree of
> current `origin/main`, on one branch, with one PR. Read `AGENTS.md`,
> `CLAUDE.md` and `.claude/skills/videorc-design/SKILL.md` first.
>
> Commit and push per slice. Run the gates once at the end, per the owner's
> rule. Planning authorizes no merge or release.

## Status and decisions

- **Status: EXECUTED, in review, 2026-10-05.** The owner said: "execute
  the entire plan and create a pr". D1, D3 and D13 stand as written.
  - **Built differently from the slices below, on purpose:**
    - D5: no flame glyph. An Activity row about a person always shows their
      avatar, and a streak always is about one viewer, so the glyph would
      never be drawn. `KIND_ICONS['watch-streak']` is `null`, no licence
      count is spent, and `docs/icon-set.md` is unchanged.
    - S1: when Twitch sends a notice's `message.text` without fragments,
      the backend keeps the words as one text fragment. Without that, D3
      would depend on Twitch always sending fragments.
    - S3: `noticeViewerWords` lives in its own `lib/chat-notice.ts`, not in
      `lib/live-chat-view.ts`, so `stream-activity` does not pull the chat
      view module into more chunks.
    - S4: `ActivityItem` gains `streak`, so "Thank in chat" says the
      length without parsing `short`.
    - S6: the URL rule is one shared function, `openableChatLink` in
      `shared/chat-link.ts`. The renderer, the `chatLinkUrl` contract schema
      and main all use it. The channel answers `true` when it opened.
    - S7: the native menu cannot stack on the link menu, and the probe
      proves it (see S8). No guard in `installContextMenu` was needed.
    - S8: no link in the fake connector's messages. The fake cohost smoke
      matches `Fake chat message #N` exactly, so the probe seeds its own
      link row instead. The fake Twitch provider does send a watch streak,
      so fake activity counts 14 rows (13 before).
      `comments-window-context-click-link` right-clicks with real input
      events and reports whether Electron's `context-menu` also fired.
- **The owner's asks:**
  - A Twitch screenshot of a watch streak notice ("Snowy77x · Reached
    20-Stream Streak · *welcome back hands <3 hopefully everything is
    good*"), and the question "are we catching these stream streaks?".
    Then: "We need to display it in our activity."
  - "If someone sends a link, I want to be able to right-click on it and to
    have 'Copy link' and 'open'."
  - Both are for the Stream Manager.
- **Route:** UI/Product Design owns it (fit 9). It includes one small
  backend parse and one new IPC channel. Model lane: `opus-4.8` (scoped
  user-facing work with taste risk). Escalate to `fable-5` if the IPC
  security review or the by-eye check fails.
- **Branch:** `feat/151-watch-streaks-chat-links` (worktree
  `~/projects/videorc-151`, which holds this plan).

### What happens today (measured on `origin/main` `b41fd6a5`)

**Watch streaks: they arrive, but nothing reads them.**

- Twitch sends a watch streak as EventSub `channel.chat.notification` with
  `notice_type: "watch_streak"`:
  - the facts are in `watch_streak` {`streak_count`, `channel_points_awarded`};
  - the viewer's own words are in `message.text` / `message.fragments`;
  - Twitch's sentence is in `system_message`.

  ([EventSub reference](https://dev.twitch.tv/docs/eventsub/eventsub-reference/),
  Channel Chat Notification.) We already subscribe to that type
  (`twitch_chat.rs`, `CHAT_SUBSCRIPTION_TYPES`).
- `notification_details` (`crates/videorc-backend/src/twitch_chat.rs`)
  matches sub, resub, gifts, raid and announcement. `watch_streak` falls into
  `_ => None`, so the row reaches the chat as a generic `System` event with
  no `details`, and `streak_count` is dropped.
- `normalize_chat_notification` puts `system_message` in `message_text` and
  the viewer's words only in `fragments`. Then:
  - `MessageBody` (`components/comment-row.tsx`) draws `messageText` unless
    a fragment has an image.
  - So a streak (or a resub) shows Twitch's sentence when the viewer typed
    plain text, and only the viewer's words when they typed an emote.
    Without emotes, the viewer's words never show anywhere.
- `itemFromMessage` (`lib/stream-activity.ts`) returns `null` without
  `details`. So the streak is missing from:
  - the Activity pane and its chips;
  - History's activity;
  - the highlight card: `commentCanHighlight` needs `details` on a system
    row.

**Links: nothing finds them.**

- Chat text renders as plain text. No platform sends a "link" fragment:
  - Twitch fragments are text, emote, cheermote and mention;
  - YouTube, Kick and X send plain text (X links are `t.co`).
- The Stream Manager runs in the `comments` renderer role. Its only chat
  list is `stream-manager/chat-pane.tsx` → `CommentRow`.
- A highlightable row is a shadcn `Button`: a left click shows the comment
  on stream. The row's ⋯ `KebabMenu` exists only while live.
- Right-click today:
  - `main/context-menu.ts` gives the native Copy when text is selected,
    and nothing otherwise.
  - shadcn `ContextMenu` is installed (`components/ui/context-menu.tsx`)
    and used by `stream-manager/stats-bar.tsx`.
- Opening a URL in the browser:
  - `oauth:open-url` is `MAIN_ONLY` (`shared/renderer-security-policy.ts`)
    and means "OAuth".
  - The `comments` role's preload allowlist (`preload/api-policy.ts`) has no
    way to open a URL.
  - `navigator.clipboard.writeText` already works in that window: ⋯ Copy
    uses it.

### Decisions (the recommendation is taken; ⚑ = the owner may override)

**Watch streaks**

- **D1 ⚑ A "Streaks" filter chip.** Streaks get their own chip after Raids.
  The title is "Viewers who watched several streams in a row".
  - It is not Subs: nobody paid.
  - It is not "All only" like announcements: a streamer thanking loyal
    viewers wants to list them.
  - Override: `filter: null` (they show under All only).
- **D2 The row's words.** `streak_count` is `n`.

  | Field | Text |
  | --- | --- |
  | `short` | `Streak · n streams` |
  | `line` (card, tooltip, Copy) | `Reached a n-stream watch streak` |
  | Thank in chat | `Thanks for watching n streams in a row, @name!` |

  - `channel_points_awarded` is parsed and kept on the wire, but not shown:
    it is what the viewer earned, not news for the streamer.
- **D3 ⚑ The viewer's own words show, on every Twitch notice that has
  them.**
  - **Activity:** the row quotes them (`ActivityItem.message`). That gives
    the highlight card `Reached a 20-stream watch streak: welcome back hands
    <3 …`.
  - **Chat:** the row shows Twitch's sentence (muted, italic, as today),
    then the viewer's words below it (normal text, emotes drawn). That is
    how Twitch shows it in the screenshot.
  - The same rule applies to sub and resub notices, which carry a viewer
    message the same way. One helper does it, and it also fixes the
    emote-only inconsistency.
  - Override: streaks only.
- **D4 Streaks are not counted** in Supporters or in any stats-bar total.
  Activity counts them only in the Streaks chip.
- **D5 ⚑ A flame glyph.** Phosphor `Fire` becomes `StreakIcon` in
  `stream-manager/activity-icons.tsx` (the window-scoped registry).
  - It is the eighth activity slot; the count goes from 87 glyphs to 88,
    under the 100 ceiling.
  - Update `docs/icon-set.md`.
  - Override: reuse `SupporterIcon` and add no glyph.
- **D6 Card and Orcle follow the existing rules.**
  - A streak is highlightable like a raid. The card leads with `line`.
  - Orcle is unchanged: `cohost.rs` already tags every
    `channel.chat.notification*` row as a notification, and no notice's
    `raw_provider_type` changes.
  - Remove from chat is unchanged: notices are never removable
    (`chatMessageRemovable`).
- **Out:** the other unhandled notice types (`modiversary`,
  `bits_badge_tier`, `charity_donation`, `gifted_drops_summary`, every
  `shared_chat_*`). Each one stays a plain system row, as today.

**Links**

- **D7 What counts as a link.** A pure renderer helper finds three shapes in
  a message's text:
  - `http://` and `https://` URLs;
  - `www.` hosts;
  - bare `host.tld[/path]` on a short TLD allowlist: `com net org io gg tv
    dev app co me ly be fm to sh xyz live`.

  Rules:
  - Trailing `.,!?;:)]}'"` is trimmed off unless it is balanced inside the
    URL (`(...)`).
  - A bare or `www.` link opens as `https://`.
  - Any other scheme (`javascript:`, `file:`, `mailto:`, `data:`) is never a
    link.
  - Over 2,048 characters is not a link.
  - Mentions and emotes are never scanned, only text pieces.
- **D8 Where.** Every viewer-written chat row in the Stream Manager:
  `message` and `paid`, and the viewer's words on notices (D3).
  - Twitch's own system sentences, moderation rows and deleted rows are
    never linkified.
  - The highlight card on stream stays plain text.
- **D9 How a link looks.** The link text stays `text-foreground` with a
  subtle underline (`underline decoration-muted-foreground/50
  underline-offset-2`).
  - No blue: colour is information (design skill, hard rule 4).
  - The cursor stays the row's cursor, because a left click still means the
    row.
- **D10 Right-click a link → a shadcn `ContextMenu`:**
  1. a `ContextMenuLabel` with the link's host (`videorc.com`) in tertiary
     text, so the streamer sees where it goes before opening it;
  2. **Open link**, with `ExternalLinkIcon`;
  3. **Copy link**, with `CopyIcon`. It copies the normalized URL
     (`https://…`).

  - Both icons are already in `@/components/icons`; no new glyph.
  - Right-clicking anywhere else on the row behaves as today: the native
    Copy when text is selected, otherwise nothing.
- **D11 A left click on a link does what it does today.** On a highlightable
  row, that means Show on stream. A link never navigates inside the app, and
  there is no ⌘-click shortcut in this plan.
- **D12 The keyboard path.** While live, the row's ⋯ menu gains the same
  actions after Reply, before Copy:
  - with one link: "Open link" and "Copy link";
  - with two or three: one pair per link, labelled "Open videorc.com" and
    "Copy videorc.com link";
  - beyond three, only the first three.

  Hard rule 3 (keyboard-first) requires this path: the row button, not the
  link text, holds focus.
- **D13 ⚑ No confirmation before opening.** The owner asked for "open".
  The host label (D10) is the safety cue. Override: a `Dialog` "Open
  videorc.com in your browser?" (not recommended: it is friction on every
  click).
- **D14 A new, narrow IPC channel: `chat:open-link`.**
  - It is not `oauth:open-url`, which is main-only and means OAuth.
  - Allowed roles: `main` and `comments` (the Stream Manager), declared in
    `renderer-security-policy.ts`.
  - Main re-validates every call:
    - `new URL()` parses it;
    - the protocol is `http:` or `https:`;
    - it has no username or password;
    - it is ≤ 2,048 characters.

    Then main calls `shell.openExternal(parsed.toString())`.
  - A rejected URL resolves `{ ok: false, reason }`; the renderer shows a
    toast, the only toast in this plan (an error, per the design skill's
    toast rules).
  - It is never `window.open`.

## Slices

**S1: parse the streak (backend).**
- `live_chat.rs`: add the `LiveChatEventDetails::WatchStreak` variant:
  - `#[serde(rename_all = "camelCase")]`;
  - `streak_count: u32`;
  - `channel_points_awarded: Option<u64>` with `skip_serializing_if`.

  Its wire form is `{"kind":"watch-streak","streakCount":20,…}`. Never
  serialize `null` (see the serde-null contract trap that broke app load
  three times).
- `twitch_chat.rs` `notification_details`: add a `"watch_streak"` arm.
  - No `streak_count` → `None`, so a malformed notice stays a plain
    system row.
  - `notice_event_type` keeps `System` for it.
- `live_chat.rs` `fake_events`: add a Twitch watch streak, with a viewer
  message in its fragments, so the fake providers show one. Fix any test
  that counts fake events.
- Add tests in `twitch_chat.rs`, using the EventSub reference payload
  shape:
  - a streak with a viewer message → details, `System`, `raw_provider_type`
    `channel.chat.notification:watch_streak`, and fragments that hold the
    viewer's words;
  - a streak without `watch_streak` → no details;
  - serialization omits the absent points.
- *Done when:* `cargo test -p videorc-backend twitch_chat` and `cargo test
  -p videorc-backend live_chat` pass.

**S2: the wire contract (TS).**
- `shared/backend.ts`: add `| { kind: 'watch-streak'; streakCount: number;
  channelPointsAwarded?: number }` to `LiveChatEventDetails`.
- `protocol-fixtures/high-risk-contracts.json`: add a Twitch watch-streak
  message beside the resub and raid examples. Run the fixture parity tests
  on both sides.
- Fix every exhaustive `switch` on `details.kind` that the typechecker
  flags. `activityTotals` gets an explicit `case 'watch-streak': break`
  (D4).
- *Done when:* `pnpm typecheck` passes and the fixture test passes in Rust
  and TS.

**S3: the viewer's words on Twitch notices (D3).**
- Add a `noticeViewerWords(message)` helper in `lib/live-chat-view.ts`.
  - For a row whose `rawProviderType` starts with
    `channel.chat.notification`, it returns the joined text of
    `message.fragments`, trimmed, when that differs from `messageText`.
    Otherwise it returns `undefined`.
  - It returns `undefined` for announcements: an announcement's `messageText`
    already is the words.
- `stream-activity.ts` `itemFromMessage`: `viewerWords` also comes from
  `noticeViewerWords` for `subscription` and `watch-streak` details.
- `comment-row.tsx` `MessageBody`: for a notice with viewer words, show the
  system sentence (muted, italic) on one line, then the fragments (emotes
  drawn) as normal text below. Every other row renders exactly as today.
- Tests:
  - `live-chat-view` helper cases: plain text, emote-only, empty, an
    announcement, a non-notice row;
  - `stream-activity` resub and streak rows with `message`;
  - a comment-row render test for a streak with and without words.
- *Done when:* the tests pass, and a resub with plain text now shows both
  lines in chat.

**S4: the streak in Activity (D1, D2, D4, D5).**
- `stream-activity.ts`:
  - add the `'watch-streak'` `ActivityKind`;
  - add the `'streaks'` `ActivityFilter`;
  - add the `ACTIVITY_FILTERS` entry `{ id: 'streaks', label: 'Streaks',
    title: 'Viewers who watched several streams in a row' }` after Raids;
  - `itemFromMessage` case with the D2 words and `filter: 'streaks'`;
  - the `activityFilterCounts` key;
  - the `thankYouDraft` case.
- `activity-icons.tsx`: add `StreakIcon` (Phosphor `Fire`).
  `activity-pane.tsx`: add `KIND_ICONS['watch-streak']`. A streak is about a
  person, so the row shows the avatar, as it does for subs.
- `docs/icon-set.md`: change the counts in its "Today" paragraph to eight
  Stream Manager slots and 88 glyphs.
- Tests in `stream-activity.test.ts`:
  - the item's words;
  - the chip count;
  - Supporters unchanged by a streak;
  - the thank-you draft;
  - `filterActivity(…, 'streaks')`.

  Plus `commentCanHighlight` true for a streak, and the card text
  (`commentHighlightCardText`) with and without words.
- *Done when:* the tests pass. With fake chat
  (`pnpm smoke:live-chat-fake-providers` or the dev fake provider), the
  Activity pane lists the streak under All and under Streaks, and Show on
  stream puts it on the card.

**S5: find links (D7).**
- Add `lib/chat-links.ts`:
  - `splitLinks(text): Array<{ kind: 'text'; text } | { kind: 'link';
    text; href; host }>`;
  - `normalizeChatLink(raw): string | null`, which applies the D7 rules and
    returns `https://…` or `null`.

  No new dependency: the Stream Manager chunk's asset budget is tight, so it
  is a hand-written, linear scan.
- `lib/chat-links.test.ts`. Every D7 rule gets a case:
  - `https://videorc.com/download.` → trailing dot trimmed;
  - `(see videorc.com)` → parenthesis trimmed;
  - `https://en.wikipedia.org/wiki/Foo_(bar)` → balanced, kept;
  - `www.twitch.tv/x` → `https://www.twitch.tv/x`;
  - `node.js` and `file.txt` → not links;
  - `javascript:alert(1)`, `mailto:a@b.co` and `data:` → not links;
  - `user:pass@host.com` → not a link;
  - `t.co/abc` → a link;
  - a 3,000-character URL → not a link;
  - two links in one message → both found;
  - emoji and CJK around a URL.
- *Done when:* the tests pass.

**S6: open links safely (D14).**
- `shared/electron-ipc-contract.ts`: add `'chat:open-link': 'openChatLink'`
  with a new `chatLinkUrl` schema.
  - Do not reuse `boundedUrl`: it rejects `http:` for anything but
    localhost, and chat links can be plain `http://`.
  - `chatLinkUrl` accepts `http:` and `https:` only, with no username or
    password, and at most 2,048 characters.
- `shared/renderer-security-policy.ts`: allow the channel for `main` and
  `comments`.
- Add `openChatLink` to `preload/index.ts`, to the `VideorcApi` type, and to
  `AUXILIARY_API_KEYS.comments` in `preload/api-policy.ts`.
- `main/index.ts`: handle it with `secureIpcHandle`. Validation lives in a
  pure `validateChatLink` in a new `main/chat-link.ts`, so it can be tested
  without Electron.
- Tests:
  - `main/chat-link.test.ts`: every D14 rejection, plus a good URL passing
    through unchanged;
  - extend `renderer-security-policy.test.ts`: `chat:open-link` is allowed
    for `comments` and `main`, and denied for `notes` and `captions`;
  - extend the IPC contract test.
- *Done when:* the tests pass, and `oauth:open-url` stays main-only.

**S7: the right-click menu and the ⋯ items (D8–D12).**
- `comment-row.tsx`, in a new `ChatLink` component:
  - the link text is a `<span data-slot="comment-link">` styled per D9;
  - it is wrapped in `ContextMenu` / `ContextMenuTrigger asChild` with the
    D10 content. This follows `stats-bar.tsx`'s usage.
  - It is not an `<a>`: the row is a `<button>`, and an anchor inside a
    button is invalid and would navigate.
- `MessageBody`:
  - The plain-text path runs `splitLinks` over `messageText` for viewer
    rows.
  - The fragment path runs it over each text piece.
  - Notices run it only over the viewer's-words line from S3.
- Open calls `window.videorc.openChatLink(href)`. A rejection gets an error
  toast: "Couldn't open that link."
- Copy uses `navigator.clipboard.writeText(href)`. There is no success
  toast: the menu closing is the confirmation, as with ⋯ Copy today.
- `commentRowMenu`: add the D12 items, built from `splitLinks`, in the
  order Show/Take off, Reply, links, Copy, Remove.
- Tests:
  - comment-row: a link renders as `comment-link`, and the menu has the
    host label and both items;
  - Open calls the API with the normalized href;
  - Copy writes it;
  - deleted, moderation and system-sentence text stays unlinkified;
  - the ⋯ items for 0, 1, 2 and 4 links.
- Check by hand with the dev app:
  - a right-click on a link shows only the shadcn menu, never the native
    menu as well. Radix calls `preventDefault`, so Electron's
    `context-menu` should not fire.
  - If both menus appear, add a guard in `installContextMenu`: skip when the
    renderer handled it. Add a test for the guard.
- *Done when:* the tests pass. In the dev app with fake chat, a fake
  message with a link opens the browser and copies the URL, and a left click
  on the link still toggles Show on stream.

**S8: fake data, probe and docs.**
- Add a link to one fake chat message per platform (`fake_events` or the
  fake chat line set). Then dev, the comments probe and the fake-provider
  smoke show it.
- `scripts/comments-window-probe.mjs`: capture the streak in Activity and a
  link row at 420×640. If it can open a context menu headlessly, capture
  that too.
- `docs/specs/stream-manager-provider-facts.md`:
  - add the `watch_streak` row: "Delivered today" by
    `channel.chat.notification`, with its fields;
  - note that no platform sends link fragments.
- *Done when:* the probe passes with the new captures, and the docs diff
  reads correctly.

## Edge cases

- **A streak with no words:** the row has no quote. In chat, the system
  sentence alone shows, as today.
- **Streak count 1 or missing:** "1 streams" never appears, because
  `plural()` handles it ("1 stream"). A missing count gives no details
  (S1).
- **Deleted or removed notice:** it is dropped from Activity, as other
  events are (`message.isDeleted`).
- **History:** past sessions use the same `activityItems`, so streaks
  appear there with no extra work. Older stored sessions have no
  `watch-streak` details, so nothing changes for them.
- **A URL right after an emote**, like `Kappa https://x.com`: it sits in a
  text piece and is found.
- **A link inside a mention fragment:** never scanned.
- **Very long URLs:** the span wraps with `break-words` (the body already
  wraps). The menu label shows the host, not the whole URL.
- **Typosquats and phishing:** the host label is the only cue (D13).
  Moderation, such as Remove from chat, stays the streamer's tool.
- **Narrow Stream Manager (320 px):** one more chip must not overflow.
  Check the filter row at 320 px, as plan 047's probe does. If it
  overflows, the chips scroll the way they already do, with no new
  behaviour.

## Out of scope

- The other unhandled Twitch notice types (D6, "Out").
- Clickable links (left click), ⌘-click to open, link previews or unfurls.
- Links on the highlight card or in Orcle's replies.
- A link safety service or blocklist.

## Verification gates

At the end, per the owner's rule:

- Rust:
  - `cargo fmt --check --all`;
  - `cargo test -p videorc-backend twitch_chat`;
  - `cargo test -p videorc-backend live_chat`;
  - `cargo clippy -p videorc-backend -- -D warnings`.

  These are targeted tests, per the owner's skip-the-full-suite directive.
- TS:
  - `pnpm typecheck`, `pnpm lint`, `pnpm format:check`;
  - `pnpm --filter @videorc/desktop test` (arm64 node first on `PATH`).
- `pnpm build` and `pnpm check:renderer-assets`. CI Linux is the budget
  gate; local macOS gzip reads about 1.6 KB high.
- `pnpm smoke:live-chat-fake-providers` and `pnpm probe:comments-window`.
- No recording or native-preview path is touched, so no recording smokes.

## Owner actions

- By eye, on a real Twitch stream:
  - a real watch streak lands in Activity with the viewer's words;
  - Show on stream and Thank in chat read right.
- Right-click a real link from chat. Open goes to the browser, and Copy
  pastes the full URL.
- Confirm or override D1 (Streaks chip), D3 (viewer's words on every
  notice), D5 (flame glyph) and D13 (no confirmation).

## Handoff (cold start)

- **Goal:** Twitch watch streaks become Activity rows with the viewer's
  words. Chat links get a right-click menu: Open link and Copy link.
- **State:**
  - This plan is in `~/projects/videorc-151` on
    `feat/151-watch-streaks-chat-links`, based on `origin/main` `b41fd6a5`.
  - No code has been written.
- **Files:**
  - `crates/videorc-backend/src/{twitch_chat,live_chat}.rs`
  - `apps/desktop/src/shared/{backend,electron-ipc-contract,renderer-security-policy}.ts`
  - `apps/desktop/src/preload/{index,api-policy}.ts`
  - `apps/desktop/src/main/{index,chat-link}.ts`
  - `apps/desktop/src/renderer/src/lib/{stream-activity,live-chat-view,chat-links}.ts`
  - `apps/desktop/src/renderer/src/components/{comment-row.tsx,stream-manager/activity-pane.tsx,stream-manager/activity-icons.tsx}`
  - `protocol-fixtures/high-risk-contracts.json`
  - `docs/icon-set.md`
  - `docs/specs/stream-manager-provider-facts.md`
  - `scripts/comments-window-probe.mjs`
- **Order:**
  - S1 → S2 → S3 → S4 (streaks).
  - S5 → S6 → S7 (links). These are independent of S1–S4.
  - S8 last.
- **Blockers:** none known. A real watch streak can only be checked by eye
  on a live Twitch stream (an owner action).
