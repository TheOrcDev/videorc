# Plan 204: Chat in the Studio

> **Executor instructions**: read `AGENTS.md`, the `videorc-design` skill and
> this whole plan first. Work in your own worktree from `origin/main`, never
> from `feat/windows-owner-waiver` (the main checkout's branch, hundreds of
> commits behind). This is one desktop PR. Write and commit every slice
> first, then run the gates once at the end (owner feedback "Gates at the
> end"). Check every UI in light AND dark, in the default look AND Retro LCD.
> Stop and report on any STOP condition instead of improvising. When the PR
> lands, update the Status table and the row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git log --oneline 11e1ab9a..origin/main -- apps/desktop/src/renderer/src/components/tabs/studio-tab.tsx apps/desktop/src/renderer/src/lib/studio-layout.ts apps/desktop/src/renderer/src/components/comment-row.tsx apps/desktop/src/renderer/src/components/stream-manager/chat-pane.tsx apps/desktop/src/renderer/src/hooks/use-chat-follow.ts apps/desktop/src/renderer/src/components/studio/retro-lcd-studio.tsx apps/desktop/src/renderer/src/components/settings/general-settings.tsx scripts/check-renderer-asset-budget.mjs scripts/smoke-comment-highlight-stream-app.mjs`.
> Line numbers were read at `origin/main` `11e1ab9a`. If an anchor moved,
> find it again by symbol. If the _behaviour_ changed, stop and report.
> Plan 205 (preview source of truth) was started the same day in
> `~/projects/videorc-wt-205`; if it has landed, re-read `use-dock-slot.tsx`
> and the Studio preview panel before S3.

## Status

| Slice | What                                                  | State   |
| ----- | ----------------------------------------------------- | ------- |
| S0    | Drift check and the eager bundle baseline             | BUILT   |
| S1    | The setting and when the section shows (pure, tested) | BUILT   |
| S2    | The chat list and its rows (lazy chunk)               | BUILT   |
| S3    | The Chat section in the Studio inspector, both looks  | BUILT   |
| S4    | The switch: Settings → General and ⌘K                 | BUILT   |
| S5    | Words and docs: glossary, design skill, release note  | BUILT   |
| S6    | `smoke:studio-chat` and the gates                     | BUILT   |

- **Status**: BUILT 2026-10-27 on `plan-204-studio-chat`, one desktop PR.
  The owner answered all four questions the same day (see Owner answers)
  and said "execute the entire plan and create a PR". What was measured and
  what is still owed is in As built, at the end.
- **Priority**: P1 (owner request, 2026-10-27).
- **Effort**: M. Renderer only: one lazy component, one setting, one ⌘K
  item, one Settings row, one smoke mode. No backend, wire or IPC change.
- **Risk**: LOW to MEDIUM.
  - It changes the Studio page around the docked native preview. It touches
    no preview code, and the section sits in the inspector column, so the
    preview slot never moves (D1). One `probe:preview-lifecycle` run proves
    it.
  - The eager renderer bundle has about 5 KB of gzip headroom (405,000
    ceiling, raised 2026-10-27), and its note says net-new UI must be split
    out. The section is its own chunk (D12).
  - It reuses a binding owner call: a click on a chat row puts the message
    on stream (D6). The Studio rows must keep that contract exactly.
- **Depends on**: nothing. Plans 197 (Retro LCD) and 201 (Studio Audio) are
  on main; this plan adds a section next to theirs and changes neither.
- **Route**: Orchestrator owns it (fit 10).
  - S1 to S5: UI/Product Design (fit 9) on `opus-5.5`, with the
    `videorc-design` skill. Scoped, user-facing ergonomics and copy.
  - S6: the smoke mode reads the section's own DOM hooks, so the same owner
    route writes it in the same PR (one route owns the work).
  - The owner runs the by-eye acceptance on a real stream.

## The owner's ask (2026-10-27)

> "We need to have also live chat visible inside of our studio in some small
> window. It can be optional with a switch. And it can also have highlight
> on click and things like that, but not as detailed as inside of the stream
> manager. So it should be just a small window where we have comments and
> things like username and which platform. Plan it out properly."

## What a streamer gets

1. **Turn it on, then go live.** With **Chat in Studio** on (Settings →
   General → Chat, or ⌘K), the Studio's inspector gains a **Chat** section
   right under Session while on air. It shows the livestream's chat from
   every platform, newest at the bottom: each message is a small avatar, one
   name, its words, and the platform's mark on the right.
2. **A message worth showing.** The streamer clicks Ada's "Ship it!". The
   highlight card goes on stream, and the row reads "On stream". A second
   click takes it off. Enter and Space do the same on a focused row.
3. **With the Stream Manager open too.** The same message is lit in both:
   one highlight, two views of it. Buddy's auto-highlights and Activity's
   auto-show light the Studio row as well.
4. **Reading back.** The streamer scrolls up. The list stops following and
   a chip says "4 new". The chip, or scrolling to the bottom, follows again.
5. **More than the Studio shows.** "Open Stream Manager" in the section's
   header opens the full chat: filters, search, the composer, replies,
   removals and Buddy.
6. **Not wanted mid-stream.** The hide button takes the section away at
   once, with an Undo toast that says where to turn it back on.
7. **Not live.** Idle, recording only, or Clips only, the Studio looks
   exactly as it does today. The section appears only while on air.

## History: the Studio had chat once

- June 2026, UX/IA slice 6 (`e1ab81767`): a live-only chat rail, a 320 px
  third column toggled with ⌘J, which auto-opened when chat attached
  (`components/live-chat-rail.tsx`, `lib/live-chat-surface.ts`). While the
  Comments window was open, the rail showed a "bring back" placeholder (one
  live feed at a time).
- 2026-08-19, #222 (`f82ee55f1`): "Comments leave the Studio: the in-studio
  chat rail is removed; comments live only in the separate window (like
  Notes)." ⌘J began showing the window. `docs/ux-ia-refactor-plan.md:35`
  records that "the live chat rail became the Stream Manager window". No
  other reason is written down.
- What is different now: it is optional, on only while on air, compact, and
  inside the inspector instead of a third column. The Stream Manager stays
  the full chat, and both can show at once.

## What exists (facts, `origin/main` `11e1ab9a`)

### The Studio page

- **The grid** (`lib/studio-layout.ts`). From 720 px of content, the
  preview column (`STUDIO_PREVIEW_COLUMN`, spans both rows) sits beside a
  20rem column: the transport on row 1 and the inspector
  (`STUDIO_INSPECTOR`) on row 2. Narrower, it is one column: transport
  (pinned), preview, Scenes, then the inspector. The whole page scrolls in
  `PaneBody`; the inspector has no scroll of its own.
- **The inspector** (`components/tabs/studio-tab.tsx:232-255`): Session
  (`SessionPanel` or `RetroSessionPanel`), then Audio (lazy, plan 201),
  then Sources and Captions (`QuickSettings`), then Takeover. Each has a
  Retro LCD twin picked by `studio.settings.retroLcdStudio`.
- **Session while live** (`components/studio/session-panel.tsx:326`):
  Livestream and Output rows, a row per destination, stream health, and
  Buddy's row, then any notices.
- **Sizes.** The main window opens at 1180×780 and its minimum is 960×660
  (`main/index.ts:2234-2237`). The sidebar is 208 px (`w-52`,
  `components/sidebar.tsx:256`). At the default size the content is about
  970 px wide: the preview column is about 650 px and the inspector 320 px.
  The pane is about 714 px tall under the 40 px toolbar and over the 26 px
  status bar.
- **The docked preview is a native surface glued over its slot**
  (`hooks/use-dock-slot.tsx`). The renderer reports the slot's in-window
  rect on layout and scroll changes. Any popper that overlaps the slot hides
  the surface, so nothing can float over the preview.
- **Space** (`lib/studio-space-shortcut.ts`): Record, Stop recording, or the
  End livestream question. It yields to any focused button or element with
  a tab index, so Space on a focused chat row presses the row.

### The chat the main window already holds

- **The main renderer owns live chat.** `liveChatSnapshot` is built from
  `liveChat.*` events in the provider (`hooks/use-studio.tsx:2670`) and
  pushed to the Stream Manager window as a mirror. It lives on its own
  context, so only subscribers re-render on a message:
  `StudioChatContextValue` (1713) and `useStudioChat()` (2270).
- **The snapshot.** `LiveChatSnapshot` has `sessionId`, `providers`,
  `messages` (capped at `MAX_LIVE_CHAT_VIEW_MESSAGES` = 2000,
  `lib/live-chat-view.ts:25`) and `delivery`. A terminal session clears it
  (`clearLiveChatForTerminalSession`, `use-studio.tsx:2717`).
- **The highlight lives in the main renderer too.** Core context
  (`use-studio.tsx:1277-1282`): `highlightedCommentId`,
  `commentHighlightState`, `commentHighlightApplyingId`,
  `commentHighlightFailure` (cleared after 5 s) and
  `toggleCommentHighlight(message)` (3396). The Stream Manager's clicks
  arrive over IPC (`onCommentHighlightRequest`, 3464) and run the same
  `applyCommentHighlight`. Buddy's auto-highlight and Activity's auto-show
  use it too. An intent counter orders racing requests, and the result is
  published to the window (`publishCommentHighlightState`, 3391). A second
  click on the live message takes it off; only automatic paths pass
  `alwaysSet`.

### The Stream Manager's chat

- **`ChatPane`** (`components/stream-manager/chat-pane.tsx:130`): filters,
  search, a `@tanstack/react-virtual` list of `CommentRow`s at
  `density="comfortable"`, the follow (`hooks/use-chat-follow.ts`), the
  unread count (`chatDeliveryProgress`), the jump chip ("12 new", "New
  chat", "Latest", 643-660), the composer, and `OffAir` (1254) with
  `liveChatEmptyMessage` (`lib/live-chat-view.ts:435`).
- **What it lists**: `chatPaneMessages` (`lib/stream-manager-chat.ts:16`)
  drops activity-only events and applies the filters.
- **`CommentRow`** (`components/comment-row.tsx:932`): one `Button` per
  highlightable row, named by author, platform and text through
  `aria-labelledby`, with `aria-pressed` while on stream and
  `commentRowDescription` (824) as its description. A drag that selects text
  is not a click (`clickSelectsText`, 1062). It always renders a `KebabMenu`.
  Its `compact` density (32 px avatar, 12 px text) was the June rail's and is
  unused now.
- **Exported pieces to reuse**: `HighlightStatus` (189), `highlightProblem`
  (135), `commentHighlightPresentationForMessage` (74),
  `commentRowDescription`, `ChatPlatformIcon` and `CHAT_PLATFORM_LABELS`
  (`components/chat-platform-icon.tsx`), `commentCanHighlight` and
  `commentRowTint` (`lib/live-chat-view.ts:521`, 551), and the keyboard model
  in `lib/chat-list-keys.ts` (`chatRowKeyCommand`, `chatRowAfterMove`).
  `MessageBody` (635), the text with emotes, GIFs and inert links, is not
  exported yet.

### Settings, ⌘K and shortcuts

- **Studio display settings are renderer-local.** `SettingsState`
  (`lib/capture.ts:39`) is saved in `localStorage` through `loadJson`, which
  spreads the saved object over defaults. `retroLcdStudio?: boolean` (63) is
  the model: optional, read as `=== true`. Older apps ignore new keys.
- **Settings → General** (`components/settings/general-settings.tsx`):
  Appearance (Theme, Retro LCD at 74, a row pointing at Scene), then the
  "Stream Manager" section (121-140), shown only while
  `runtimeInfo.commentsWindowEnabled !== false` (`VIDEORC_COMMENTS_WINDOW`),
  holding "Open Stream Manager when you go live" and the emote fields.
- **⌘K** (`components/command-palette.tsx`): Windows (313) toggles
  Preview, Notes, Stream Manager and Captions reader. Appearance (523) marks
  the look in use with a check (plan 174 A-9).
- **Keys** (`lib/shortcuts.ts:73-87`): ⇧⌘J opens the Stream Manager and
  plain ⌘J shows it from the main window (inside it, ⌘J focuses Buddy).

### Gates that already exist

- **The eager bundle budget** (`scripts/check-renderer-asset-budget.mjs`,
  `pnpm check:renderer-assets`): gzip ceiling 405,000 since 2026-10-27, main
  at about 400,072. "Keep re-splitting the answer for net-new UI."
- **`smoke:comment-highlight-stream`**
  (`scripts/smoke-comment-highlight-stream-app.mjs`): goes live to a local
  RTMP listener with a fake chat provider, clicks a message in the Stream
  Manager (`comments-window-click-message`, `main/index.ts:11491`), and
  proves the card, its avatar and its emote in the stream output. The
  main window takes scripts through the `eval-js` smoke command
  (`main/index.ts:12992`).

## Decisions

### Where and when

- **D1. A Chat section in the inspector, directly under Session.**
  - Order while live: transport, Session, **Chat**, Audio, Sources and
    Captions, Takeover. On air, chat is what the streamer glances at most,
    and Session above it says the stream is healthy.
  - The inspector column keeps its 20rem width, and the preview column spans
    both grid rows, so a taller inspector never moves or resizes the docked
    preview's slot. In the narrow one-column layout, the inspector follows
    the preview, so the slot doesn't move there either.
  - Rejected: **a third column** (the June rail). At 1180 px it would cut
    the preview column from about 650 px to about 350 px, and every show or
    hide would resize the docked native preview.
  - Rejected: **under the preview, above Scenes.** Wide rows read well, but
    Scenes (used mid-stream) would fall below the fold, and session things
    would be split across both columns.
  - Rejected: **floating over the preview.** The docked preview is a native
    surface no DOM can draw over, and `use-dock-slot.tsx` hides it under any
    overlapping popper. The design skill also forbids floating panels inside
    a window.
- **D2. It shows only while on air.**
  - Shows: the setting is on and `sessionIsLive(recording)`.
  - Never while idle, recording only or Clips only. Chat exists only for a
    livestream, and the people who only record see no change.
  - After End livestream the section goes away with the snapshot. The
    Stream Manager's History keeps the transcript; the June rail's
    "retained after stop" isn't brought back.
  - On air with no destination that has chat (custom RTMP only): one quiet
    line, "No destination on this livestream has chat." No list area.
  - On air with chat attached: the full list area from the start, with
    "Chat is connected. New messages appear here." until the first message.
    The section never grows when the first message lands, so nothing below
    it jumps mid-stream.
- **D3. Off by default, for new and existing installs (owner answer 2).**
  Nothing changes in anyone's Studio until they turn it on. The release
  notes say where the switch is (S5), and ⌘K finds it by "chat".
  - The setting is `settings.studioChat`, read as `=== true`, so an absent
    key is off, like `retroLcdStudio`.
  - The recommendation was on by default; the owner chose off.

### The switch

- **D4. One home: Settings → General, in a section renamed "Chat".**
  - The section's description becomes "Your livestream's chat, in the
    Studio and in the Stream Manager." It holds:
    - **Chat in Studio** (new, first): "While you're on air, the Studio shows
      your chat under Session. Click a message to show it on stream."
    - "Open Stream Manager when you go live" (unchanged, still only while the
      Stream Manager is enabled).
    - The emote fields (unchanged; the Studio's rows follow them too).
  - The section now always renders. Only the Stream Manager row keeps the
    `commentsWindowEnabled` gate.
  - Mirrors that edit the same setting: ⌘K **Chat in Studio** in the
    Appearance group, with the check while on (A-9), keywords chat,
    comments, messages, studio; and the section's hide button (D9).
  - No new key. ⌘J and ⇧⌘J belong to the Stream Manager. A key can come
    later if the owner wants one.
  - Rejected: Appearance ("How Videorc looks"). This is about what the
    Studio shows, and the chat settings already have a section.
  - Rejected: a switch in the Studio. Studio's top holds only Record and Go
    Live (owner feedback 2026-10-12: no switches beside them).

### The rows

- **D5. A row is a small avatar, the name, the words and the platform.
  Nothing else (owner answer 4: avatars too).**
  - Layout: a 24 px avatar (`Avatar size="sm"`, initials until the cached
    picture loads, `useCachedAvatar`), then the name (14 px / 600, primary)
    and the message on one line that wraps, Twitch-chat style, then the
    platform mark closing the row on the far right at 20 px with YouTube's
    official icon (owner call, plan 165).
  - The message: `MessageBody` at `compact` density. Emotes are images, a GIF
    follows the chat GIF setting, and links are text inert to a left click
    (plan 151), exactly as in the Stream Manager. The text is selectable.
  - Kept, because they cost nothing and mean money or loyalty: a paid
    message's tint and its amount, and a member's tint (`commentRowTint`,
    the one function for both windows). A deleted message is struck
    through and can't be clicked. A notice reads in secondary italics.
  - Left out (the owner's "not as detailed"): the time, role, verified,
    member, "First chat" and "@you" chips, the reply line, Buddy's marks and
    flags, removal chips, and the ⋯ menu.
  - What is listed: `chatPaneMessages` with an empty filter, the same set as
    the Stream Manager's unfiltered chat.
- **D6. A click puts the message on stream (owner call D10, plans 055 and
  151).**
  - A click on a row shows the message on stream, and a click on the live
    row takes it off. Enter and Space on a focused row do the same. A drag
    that selects text is not a click. Rows that can't go on stream
    (`commentCanHighlight` false) are plain, not buttons.
  - It calls the provider's `toggleCommentHighlight`, so there is one
    highlight across the Studio, the Stream Manager, Buddy and Activity, and
    a row lit in one is lit in all.
  - States, from the shared `HighlightStatus`: the pressed fill and "On
    stream" while live, "Applying…" while the card renders (the row is
    disabled), and "Failed" with its reason line for 5 s.
  - The row's name is "Ada on YouTube: Ship it!" and its description is
    `commentRowDescription` ("Shows it on stream" or "Takes it off the
    stream").
  - Keys: one tab stop with roving focus. ↑, ↓, Home and End move, and C
    copies the message. R, ⇧⌫ and Esc mean nothing here (no composer, no
    removal).
  - After a mouse click the row keeps focus, like every Studio button, so
    Space then presses the row (it takes the message off) and never reaches
    Record, Stop or End livestream. A test pins it (S3).
- **D7. The list stays on the newest message (owner call, 2026-10-21).**
  `useChatFollow`, the unread count from `chatDeliveryProgress`, and the
  same jump chip. Nothing the app does moves the list.
- **D8. A small, fixed size.** The list area is 16rem (256 px), about seven
  one-line messages. The whole section must be in view without scrolling at
  1180×780 with two destinations live. If it isn't, use 14rem; never shrink
  text below the tokens. No resize handle in this plan.

### The section

- **D9. The header: "Chat", Open Stream Manager, and hide.**
  - The title is "Chat" (an h2, like every inspector section).
  - The action is the ghost button **Open Stream Manager**, with ⇧⌘J on its
    tooltip (`ShortcutTooltip`), like "Open Sources" and "Open Assets".
  - Beside it, an `icon-xs` ghost button named **Hide chat in Studio**. It
    turns the setting off at once, and one info toast says "Chat hidden in
    Studio", with "Turn it back on in Settings → General." and **Undo**,
    for 8 s. The interface doesn't show where it went, so this toast is
    news, not a confirmation.
  - Quiet when fine, specific when not: while a destination's chat needs the
    streamer (reconnecting, waiting on quota, signed out), one secondary
    line under the header gives that provider's message, the one
    `liveChatEmptyMessage` would pick. Healthy, there is no line.
  - No message count: the Stream Manager's chat has none either, and a
    rising number is noise mid-stream.
- **D10. No Retro LCD screen in the first version (owner answer 3).** With
  Retro LCD on, the section still shows, in its default look, between the
  LCD Session and Audio screens, like Scenes and the soundboard pads keep
  their look (plan 197). An LCD screen for chat is under Later.
- **D11. The Stream Manager doesn't change, and both can show at once.**
  There is no "one live feed" placeholder like the June rail: the main
  renderer already feeds both, and a streamer with two screens can hide the
  Studio's. The Stream Manager stays the one full chat: filters, search,
  composer, slash commands, ⋯ actions, removals and Buddy.

### Cost

- **D12. Its own lazy chunk, and the Studio doesn't re-render per message.**
  - `studio-tab.tsx` keeps only the gate (the setting and `sessionIsLive`)
    and a `Suspense` boundary whose fallback is the section's own height,
    so the inspector never jumps when the chunk arrives. Everything else is
    in `components/studio/studio-chat.tsx`, loaded with `lazy()` like
    `AudioSection`.
  - Only the chunk subscribes to `useStudioChat()`, so a message re-renders
    the section, not the Studio tab.
  - The list is virtualized like the Stream Manager's (2,000 messages at
    most).
  - Eager growth target: under 400 bytes gzip.
- **D13. No backend, wire, IPC or stored-settings change.** The main
  renderer already holds the chat and the highlight. The setting lives in
  `localStorage` like `retroLcdStudio`, which older apps ignore. There is no
  serde, no protocol field and no main-process change.

## The design

Default look, wide Studio, on air (sketch, not to scale):

```
┌ Preview ─────────────────────────────┬ ● On air 12:04    [■ End livestream] ┐
│ ┌──────────────────────────────────┐ │ Session                              │
│ │                                  │ │  Livestream            YouTube, Twitch│
│ │            (preview)             │ │  Output                       1080p30 │
│ │                                  │ │  YouTube ●  Twitch ●   Healthy        │
│ └──────────────────────────────────┘ ├──────────────────────────────────────┤
│ Scenes                               │ Chat            Open Stream Manager ✕│
│ [  ] [  ] [  ] [  ]                  │  Ada Ship it!                     [▶]│
│                                      │  bo_k what font is that in the    [T]│
│                                      │  editor?                             │
│                                      │  Kim $5.00 love the stream        [▶]│ ← paid tint
│                                      │ ▌Ada Ship it!   On stream         [▶]│ ← pressed
│                                      │              ( 4 new ↓ )             │
│                                      ├──────────────────────────────────────┤
│                                      │ Audio                                │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

- Rows: `px-2 py-1`, `rounded-row`, a full-row hover (`bg-accent`), the
  pressed fill while on stream. Hairlines only between sections, not rows,
  like the Stream Manager's chat.
- Text: 14 px body, the name 600. No text below 11 px. No `text-subtle` on
  anything the streamer needs.
- Colour: only the platform marks, the paid and member tints, and the
  status badges.
- Light and dark from the same tokens.

## Slices

### S0 Drift check and baseline

1. Run the drift check at the top.
2. On a clean build of `origin/main`, run `pnpm build` and
   `pnpm check:renderer-assets`. Write the eager gzip total in the PR body
   as the baseline.
3. **Done when**: the drift check shows no behaviour change, and the
   baseline is recorded.

### S1 The setting and when the section shows

1. `lib/capture.ts`: add `studioChat?: boolean` to `SettingsState`, with a
   comment in the style of `retroLcdStudio` (plan 204, on by default, absent
   reads as on).
2. New `lib/studio-chat.ts`, pure, with no React:
   - `studioChatOn(settings)`: `settings.studioChat !== false`.
   - `studioChatShows({ settings, recording })`: on, and
     `sessionIsLive(recording)`.
   - `studioChatBody(snapshot)`: `'no-chat'` when no provider is attached,
     else `'list'`.
   - `studioChatNotice(providers)`: the message of the provider that needs
     the streamer, or null. Reuse `liveChatEmptyMessage`'s choice (export
     `providerNeedsAction`, `lib/live-chat-view.ts:404`, if needed); don't
     copy its rules.
   - `studioChatMessages(messages)`: `chatPaneMessages` with the empty
     filter.
3. Tests (`lib/studio-chat.test.ts`): an absent key is on; `false` is off;
   idle, recording, Clips only and starting never show; on air shows;
   no-chat versus list; the notice picks the same provider the Stream
   Manager's empty state would; activity-only events are dropped.
4. **Done when**: the tests pass and nothing renders yet.

### S2 The chat list and its rows

1. `components/comment-row.tsx`: export `MessageBody` as
   `CommentMessageBody`. No behaviour change, and the existing comment-row
   tests stay green.
2. New `components/studio/studio-chat.tsx` (the lazy chunk):
   - `StudioChatRow` (D5, D6): a `Button` with `variant` ghost or
     secondary, `aria-pressed`, `aria-labelledby` (name, a hidden "on
     {Platform}:", text), `aria-description` from `commentRowDescription`,
     the drag-select guard, disabled while applying. A plain `div` for rows
     that can't go on stream. `HighlightStatus` and `highlightProblem` for
     the states. `commentRowTint` for the paid and member tints, with the
     amount shown for a paid message.
   - `StudioChatList`: `ScrollArea` at the D8 height, the virtualizer
     (estimate about 32 px, overscan 10, keyed by message id),
     `useChatFollow`, the unread count from `chatDeliveryProgress`, the jump
     chip (copy `ChatPane`'s three strings and its `aria-label`), and the
     keyboard model from `chatRowKeyCommand` and `chatRowAfterMove`
     (moves and copy only). `aria-label="Chat messages"` on the `ol`, and
     `data-message-id` and `data-highlight-phase` on each row, as the
     Stream Manager has them (the smoke reads them).
   - `StudioChatSection` (default look): `PanelSection` "Chat" with the D9
     header and notice line, the D2 bodies, and the list. It reads
     `useStudioChat()` and the core context's highlight fields and
     `toggleCommentHighlight`.
3. If the virtualizer, follow and jump-chip wiring would be a copy of more
   than about 60 lines of `ChatPane`, lift the shared part into a hook
   (`hooks/use-chat-list.ts`) and use it from both, in this slice, with
   `chat-pane` behaviour unchanged. Otherwise keep `ChatPane` untouched.
4. Tests (happy-dom, like `comment-row-click.test.ts`): the name, words and
   platform name are in the row's accessible name; a click calls the
   toggle once; a click that ends a text selection doesn't; a deleted
   message and a plain notice aren't buttons; the live row is pressed and
   says "On stream"; applying disables the row; ↑ and ↓ move the one tab
   stop; C copies; the jump chip appears when scrolled up and follows on
   click.
5. **Done when**: the tests pass and the component renders in a test
   harness with a fake snapshot.

### S3 The Chat section in the Studio, both looks

1. `components/tabs/studio-tab.tsx`: under `InspectorSession`, render the
   section only when `studioChatShows(...)`, inside `Suspense` with a
   fallback of the same height (`PanelSection` "Chat" with a 16rem
   `Skeleton`). Lazy-import it like `AudioSection`. It is the same section
   in both looks (D10).
2. Hide: `setSettings((current) => ({ ...current, studioChat: false }))`,
   then the D9 toast through `lib/toast.ts` with one id
   (`studio-chat-hidden`) and Undo that sets it back to true.
3. Measure at 1180×780, dark and light, default and Retro LCD, on air with
   two fake destinations: the whole section is in view without scrolling
   (D8). Measure that the docked preview's slot report doesn't change when
   the section mounts or unmounts at the wide layout (read the dock slot
   report before and after through the smoke's `eval-js`, or the existing
   dock diagnostics).
4. Test: Space with a chat row focused presses the row and never calls the
   stop path (`spaceShortcutBlocked` returns true for the row's button).
5. **Done when**: the section appears on going live and goes on ending,
   hides and comes back with Undo, and it reads well in both looks and both
   themes. STOP if the docked slot moves when the section mounts.

### S4 The switch

1. `general-settings.tsx`: the section becomes "Chat" (D4), always
   rendered, with "Chat in Studio" first (`Switch` with
   `id="studio-chat"`) and the Stream Manager row still behind
   `commentsWindowEnabled`. Grep tests and `scripts/` smokes for "Stream
   Manager" section strings before renaming (design skill: grep before
   changing a string) and update what reads them.
2. `command-palette.tsx`: "Chat in Studio" in Appearance with
   `data-checked`, toggling the setting.
3. Settings → Shortcuts needs nothing (no key).
4. Tests: the row toggles the setting; the palette item's check follows it;
   the copy and style guards pass (`renderer-copy-guards`,
   `renderer-style-guards`, `renderer-shortcut-guard`).
5. **Done when**: all three ways (Settings, ⌘K, hide) flip one setting, and
   the guards pass.

### S5 Words and docs

1. `CONTEXT.md`, **Chat**: "The viewers' messages, in the Stream Manager
   and, while on air, the Studio's Chat section." Keep "Avoid: comments".
2. The design skill, "Where things live": a **Chat** line. The Stream
   Manager is the full chat, and the Studio's Chat section mirrors it while
   on air, with show on stream only. After the owner approves the look, add
   an Owner call ("Chat shows in the Studio, under Session, while on air",
   2026-10-27, plan 204; off by default; no LCD screen yet).
3. `docs/ux-ia-refactor-plan.md:35`: one dated line saying the Studio has a
   Chat section again since plan 204.
4. The PR body carries the release-notes line: "While you're on air, the
   Studio shows your chat under Session. Click a message to show it on
   stream. Turn it on in Settings → General → Chat in Studio."
5. `plans/README.md`: update this plan's row.
6. **Done when**: the docs say the same thing the app does.

### S6 `smoke:studio-chat` and the gates

1. Extend `scripts/smoke-comment-highlight-stream-app.mjs` with a Studio
   surface (`VIDEORC_COMMENT_HIGHLIGHT_SURFACE=studio`), and add
   `"smoke:studio-chat"` to `package.json` with that variable set. With the
   Studio surface it:
   - goes live with the fake provider exactly as today;
   - waits for the Studio's Chat section and the fake message's row
     (`data-message-id`), and checks that its text holds the author and the
     words and that its accessible name holds the platform label;
   - clicks the row through `eval-js` (the main window), then waits for
     `comments.highlight.status` to be live for that message, the row's
     `data-highlight-phase` to be `live`, and the card in the RTMP output
     (the existing analyzer, avatar and emote included);
   - clicks again and waits for idle, with the card gone from later frames;
   - presses the hide button and checks the section is gone while still on
     air, and that the setting reads `false`;
   - presses Undo and checks the section is back;
   - ends the livestream and checks the section is gone.
     It never opens the Stream Manager window. The default surface's run
     stays as it is.
2. Run once, at the end:
   - `pnpm typecheck`, `pnpm lint`, `pnpm format:check`;
   - `pnpm --filter @videorc/desktop test`;
   - `pnpm build`, then `pnpm check:renderer-assets` (eager gzip growth
     under 400 bytes against the S0 baseline);
   - `pnpm smoke:studio-chat` and `pnpm smoke:comment-highlight-stream`
     (the Stream Manager path unchanged);
   - `pnpm probe:preview-lifecycle`, once, because the Studio page changed
     around the docked slot.
     Use `env -u ELECTRON_RUN_AS_NODE` for the dev-app smokes in T3 shells.
     No Rust gates: no Rust changes.
3. **Done when**: every gate above is green and the PR body has the S0
   baseline, the measured growth, and the S3 measurements.

## Owner answers (2026-10-27)

> "1. yes put under session 2. off for everyone by default 3. no need for
> retro in first version 4. yes --- execute the entire plan and create a pr"

1. **Where** (D1): under Session in the inspector, as recommended.
2. **Default** (D3): off for everyone.
3. **Retro LCD** (D10): no LCD screen in the first version; the section
   keeps its default look under Retro LCD.
4. **Rows** (D5): "yes" to "or with small avatars too?", read as avatars
   on. If the owner meant the recommendation (no avatars), dropping the
   `Avatar` from `StudioChatRow` is the whole change.

## STOP conditions

- The docked preview's slot moves or resizes when the section mounts or
  unmounts at the wide layout.
- The section can't be fully in view at 1180×780 with two destinations,
  even at 14rem. Report with a screenshot and the measured heights.
- Eager gzip grows by more than 1 KB. Re-split before anything else; never
  raise the ceiling for this plan.
- Reusing `toggleCommentHighlight` from the Studio changes what the Stream
  Manager's clicks do, or a Studio click and a Stream Manager click on the
  same message disagree about which one is live.

## Not in this plan

- A send box or slash commands in the Studio. They stay in the Stream
  Manager.
- Activity rows (follows, subs, raids), filters, search, Buddy's marks, and
  the ⋯ actions (Reply, Remove from chat, Copy link).
- Times and chips on the rows.
- A resize handle, a keyboard shortcut, and the chat after the stream ends.
- Later: the chat on its own Retro LCD screen (owner answer 3).
- The phone remote and Stream Deck: they already show and hide highlights
  through their own paths.

## Owner acceptance

On a real stream with YouTube and Twitch chat, in both themes and both looks:

1. Off by default: going live changes nothing. With Chat in Studio on,
   the section appears on going live, under Session, and disappears on
   ending. Idle and recording only, the Studio is unchanged.
2. A click shows the message on stream, and a second click takes it off.
   With the Stream Manager open, the same row is lit in both.
3. Scrolling up shows the chip; the chip comes back to the newest.
4. Hide, then Undo; hide, then Settings → General → Chat in Studio brings it
   back.
5. At the default window size the whole section is in view, and the
   preview doesn't move when it appears.

## As built (2026-10-27)

- **Where the code is.**
  - `lib/studio-chat.ts` is the eager gate (`studioChatOn`,
    `studioChatShows`). It imports only `sessionIsLive`.
  - `lib/studio-chat-view.ts` holds what the section lists and says.
  - `components/studio/studio-chat.tsx` is the lazy chunk:
    `StudioChatSection`, `StudioChatList` and `StudioChatRow`.
  - `studio-tab.tsx` renders the section under Session behind the gate,
    with a fallback of the same height.
- **S2.3 took the hook.** The list mechanics were about 110 lines, so they
  moved out of `ChatPane` unchanged into `hooks/use-chat-list.ts`, and the
  jump chip into `components/chat-jump-chip.tsx`. Both lists use them.
  - `ChatPane` passes its filter as a memoized `countsAsArrival` with the
    old effect's dependencies.
  - The Stream Manager's chat tests (147, including the arrival and follow
    integration test) and the default `smoke:comment-highlight-stream`
    (four scenarios) pass on the refactor.
- **Small exports.** `liveChatProviderNotice` (the empty chat and the
  Studio notice share it), `CommentMessageBody` and
  `COMMENT_ROW_TINT_CLASS`.
- **The switch.** Settings → General's section is now called "Chat", and
  it always renders: Chat in Studio first, then the Stream Manager row,
  which keeps its `commentsWindowEnabled` gate, then the emote rows. ⌘K
  "Chat in Studio" sits in Appearance with the check.
- **Bundle (S0 against S6).**
  - Eager JS went from 1,990,647 raw / 400,516 gzip to 1,990,947 raw /
    400,604 gzip: +300 raw, +88 gzip, under the 400-byte target. The entry
    grew +160 raw / +56 gzip.
  - The section's chunk is about 15 KB raw.
- **Layout (S3, from `smoke:studio-chat` at 1180×780, one destination).**
  - The preview card did not move or resize when the section appeared.
  - The section's bottom sat at 697 of the pane's 754 px, unscrolled, so it
    was fully in view.
  - Screenshots in dark, light and Retro LCD are in the smoke's evidence
    folder (not committed).
  - The first build's rows ran 8 px past the section's edges (a negative
    margin) and were fixed to line up with the Session list.
- **Gates run.**
  - `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm build`.
  - `pnpm --filter @videorc/desktop test`: 5,679 passed. One unrelated
    timing test, "bounds a hung X END…" in
    `studio-provider.integration.test.ts`, timed out at 5.16 s against its
    5 s limit while the Rust backend built beside it. It passes alone in
    4.3 s.
  - `pnpm check:renderer-assets`, `pnpm smoke:studio-chat`,
    `pnpm smoke:comment-highlight-stream` and `pnpm probe:preview-lifecycle`.
  - No Rust gates: no Rust changed.
- **Owed (owner).**
  - The by-eye on a real stream with real YouTube and Twitch chat (Owner
    acceptance), in both themes.
  - With two destinations live, checking that the section still fits at
    1180×780. The smoke has one.
  - Whether "4. yes" meant avatars. They are on (Owner answers, 4).
