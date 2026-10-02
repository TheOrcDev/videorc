# Plan 095: Highlight card emotes and avatars, Activity "On stream", X host

**Status:** PLANNED 2026-10-02. **Priority:** P1. All four are visible to the
owner or viewers during a live stream. **Size:** M, 5 slices. **Planned
against:** `origin/main` `b4bb692e` (same card, highlight and chat code as the
installed 0.9.126). The shared checkout is on an old branch, so work in a
fresh worktree off `origin/main`. **Owner route:** Implementation (fit 8;
every root cause is located). **Model lanes:** S1 `gpt-5.5`; S2 `opus-4.8`
with the `videorc-design` skill; S3 `gpt-5.5`; S4 `fable-5` (canvas layout
with inline images, a new IPC, and the burned-in stream output).

Owner report, 2026-10-02 stream:

1. Emotes are missing from the highlighted comment on stream.
2. Highlighting an Activity item (e.g. a follow) shows nothing in the UI to
   say it is on stream. The owner had to ask the audience.
3. Avatars are missing from the highlight card, on every platform.
4. Stream Manager sends show "Host" on YouTube, Twitch and Kick, but not on X.

Order: S1 and S2 are small and independent, so ship them first. S3 adds the
image-bytes plumbing that S4 reuses.

---

## S1: X marks the streamer's own messages as Host (item 4)

**Root cause (proven).** `crates/videorc-backend/src/x_chat.rs:785-789` sets
`author_roles` to `["member"]` when the author is a subscriber, otherwise to
empty. Nothing compares the author with the broadcaster. Every other platform
maps its broadcaster signal to the `owner` role, and `comment-row.tsx:161-181`
renders `owner` as the "Host" chip:

- YouTube: `isChatOwner`.
- Twitch: the broadcaster badge.
- Kick: the Broadcaster badge.

XAA has no host flag, but the broadcaster id is already in memory:
`credentials.user_id` (`x_chat.rs:355-360`, the OAuth 1.0a id). That same id
creates the broadcast, filters the XAA subscription and signs the send.

Local DB proof: today's owner X rows have author id `742673143`, the same as
the connected account, with `roles: []`. The same send on the other three
platforms has `owner`.

**Same fix, second bug:** Orcle's `spotlight_eligible` (`cohost.rs:2511`) and
`auto_highlight_safe` (`:3087`) exclude `owner`. Today they can put the
streamer's own X message on stream.

**Steps** (backend only; no videorc-web deploy):

1. Add `host_user_id: &str` to `relay_event_to_message`. In the chat branch,
   push `"owner"` when `non_empty(author.id) == host_user_id` (exact numeric
   id, trimmed), then `"member"` if subscriber. `owner` goes first, matching
   Twitch.
2. Pass `&credentials.user_id` at `x_chat.rs:424-425`.
3. Update the 9 test call sites (`:1344`, `:1379`, `:1402`, `:1414`, `:1423`,
   `:1645`, `:1653`, `:1660`, `:1669`).

**Tests:**

- Unit tests: same id gives `owner`; a different id gives none; a missing id
  gives none; the host as a subscriber gives `["owner","member"]`.
- Extend `bind_subscribe_read_flow_delivers_a_comment` (`:1428`) with an
  author id equal to `X_USER_ID` and assert that `owner` is persisted.
- Cheap gap fillers: YouTube `isChatOwner: true` → `owner`, and Kick
  `Broadcaster` badge → `owner` (neither has a test today).

**Done when:** the targeted tests pass and the Rust gates are clean
(`cargo fmt --check --all`, `cargo clippy -p videorc-backend -- -D warnings`,
`cargo test -p videorc-backend x_chat youtube_chat kick_chat`). Rows already
stored stay unmarked; that is cosmetic.

---

## S2: Activity shows what is on stream (item 2)

**Root cause (proven).** Activity highlights use the same backend slot and the
same id as chat (`ActivityItem.id === messageId`, `stream-activity.ts:212-216`).
But `stream-manager.tsx:705-714` never passes the highlight state to
`ActivityPane`, and `ActivityRow` (`activity-pane.tsx:114-222`) has nothing to
render it with.

Follows are worse off: chat filters them out (`stream-manager-chat.ts:22`), so
a highlighted follow has **no** row anywhere in the Stream Manager that could
say "On stream".

Related bugs on the same path:

- The kebab always says "Show on stream", but on a live item it *removes* the
  highlight, because requests toggle (`use-studio.tsx:2549-2571`).
- A refused or failed Activity highlight is silent.
- Orcle's "On stream" badge never lights, because `comments/main.tsx` never
  passes `highlightedId` (`stream-manager.tsx:514`, `cohost-question-row.tsx:109`).

**Steps:**

1. In `StreamManager`, derive `liveHighlightId = highlightState?.phase ===
   'live' ? highlightState.messageId ?? null : highlightedId`. Pass
   `highlightState`, `highlightApplyingId`, `highlightFailure` and
   `liveHighlightId` to `ActivityPane` → `ActivityRow`. Also pass
   `liveHighlightId` to `CohostPane` (fixes the Orcle badge).
2. In `ActivityRow`, for rows with `item.messageId`:
   - compute `commentHighlightPresentationForMessage(...)`;
   - render the **same** badge as chat. Export `HighlightStatus` from
     `comment-row.tsx:74` and reuse it: `Badge variant="success"` "On stream",
     `secondary` "Applying…", `destructive` "Failed" with the reason as
     `title`. Put it on the name line before `<time>`;
   - add `data-highlight-phase` and full-row `bg-accent` while live;
   - flip the kebab label to **"Remove from stream"** while live.
3. When Activity sits behind a tab (Medium/Narrow tiers), show a small
   success dot on the Activity tab label while an Activity-only item (a
   follow) is live (D1).
4. Copy and visuals follow `.claude/skills/videorc-design/SKILL.md`: Badge
   only, no tinted rows, no `live` variant (that one is reserved for on-air).

**Tests:** extend `activity-pane.test.ts`:

- On stream / Applying / Failed show on the matching row only.
- The label flips to "Remove from stream".
- Rows without a `messageId` never show a badge.
- A different `messageId` or `phase: 'idle'` shows idle.

Add a `StreamManager` test that Activity and the Orcle pane receive the live
id.

**Gates:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm --filter
@videorc/desktop test`, `pnpm build` (renderer budget check). Then a by-eye
check in the dev app with the fake chat provider: highlight a follow and see
"On stream" for about 10 s, then idle.

---

## S3: Avatars actually reach the card (item 3)

**Root cause (highly likely; step 1 confirms it).**

- The card has an avatar slot with a monogram fallback
  (`lib/caption-overlay.ts:562-601`).
- It loads the cached avatar with `fetch('videorc-asset://avatar/...')`
  (`:576-583`), and `catch {}` silently falls back to the monogram (`:584-586`).
- The scheme is registered without `corsEnabled` (`main/index.ts:13514-13519`),
  and the handler sends no `Access-Control-Allow-Origin` (`:13174-13205`).
- The main window is a different origin (`file://` packaged,
  `http://localhost` dev).
- Every avatar from today's chatters on all four platforms is already in
  `avatar-cache/`, so the data exists. Nothing in tests or the smoke covers
  this fetch: the smoke's fake messages have no avatar.

**Steps:**

1. **Confirm the cause.** In the dev main window DevTools, run `await
   fetch('videorc-asset://avatar/<a file in avatar-cache>')` and note the
   error. Then add a temporary `console.warn` in the catch.
2. **Taint-proof bytes path.** Add an IPC `avatars:read(localUrl) →
   Uint8Array`, reusing `resolveManagedAvatarFile` and the 2 MB cap. Allow it
   for the main and comments windows only.
   - Update preload, the IPC contract and the renderer security-policy tests.
   - In the card, use `createImageBitmap(new Blob([bytes]))`. Never
     `drawImage` a `videorc-asset:` `<img>`, because that taints the canvas
     and `convertToBlob` would throw.
3. **Decode once per highlight.** `renderCommentHighlightCards` should decode
   each image once and share it between the landscape and portrait cards.
   Today each card fetches separately.
4. **Log fallbacks.** Log the monogram fallback once per highlight, with the
   reason (`console.warn` plus the existing renderer diagnostics path),
   instead of `catch {}`.
5. **Sharper avatars:**
   - X `_normal` (48 px) → `_400x400` in `x_chat.rs`, normalized at ingest.
   - YouTube: ask for `profileImageSize=88` or larger if the card slot (60 px
     × device scale) needs it.
   - Twitch Helix (300 px) and Kick are fine.
6. **Small ingest gaps:**
   - Allowlist `abs.twimg.com` (X default avatars) in `main/avatar-cache.ts`.
   - Twitch caches a failed Helix lookup as `None` for the whole session
     (`twitch_chat.rs:302-305, 342`). Retry it after 5 minutes instead.

**Tests:**

- An IPC handler test: managed file only, path traversal refused, size cap.
- A card-render unit test with an injected image loader (avatar present →
  `drawImage` called; loader throws → monogram + one warning).
- Extend `smoke:comment-highlight-stream`:
  - the fake provider message carries an avatar served from a smoke-only
    local host;
  - the artifact analyzer checks that the avatar circle is not the flat
    monogram colour.

**Gates:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm --filter
@videorc/desktop test`, `pnpm build`, `pnpm smoke:comment-highlight-stream`,
plus Rust targeted tests + clippy for the `x_chat.rs` / `twitch_chat.rs`
edits.

---

## S4: Emotes on the card (item 1)

**Root cause (proven).** Emote drawing was never built. Plans 085 and 089
listed "emote images on the highlight card" as out of scope.

- The card only gets `message.messageText` (`caption-overlay.ts:466-470, 487`)
  and paints it with `fillText` (`:683-685`).
- On the card, Twitch and Kick emotes show as their names, and 7TV as the
  original word.
- YouTube custom emoji are `:shortcode:` text everywhere (no data; out of
  scope). Unicode emoji should already draw through the font fallback; verify
  it in step 6.

**Steps:**

1. **Pass fragments.** `renderCommentHighlightPng` takes `fragments` (and
   still `text` for activity prefixes and for messages without fragments).
   Group them with the existing `groupEmoteOverlays` (`lib/chat-emotes.ts`) so
   7TV zero-width emotes stack.
2. **Mixed-token layout** in the pure `lib/comment-highlight.ts`:
   - tokens are words or emotes;
   - an emote box is about 1.2× the font size high, with its width from the
     decoded aspect ratio and a cap for wide 7TV emotes;
   - keep the 3-line wrap, the ellipsis rule and the 0.6 / 0.78 width caps;
   - the card width measurement includes emote boxes.
   This is the part that needs care; unit-test it thoroughly.
3. **Load emotes** with S3's path: `cacheChatAvatar(url)` (the chat list has
   usually cached it already), then `avatars:read`, then `createImageBitmap`.
   - Cap at 20 distinct emotes per card and load them in parallel.
   - Everything must fit the 4 s `avatarFetchMs` slice and Orcle's 8 s apply
     timeout.
   - A failed emote falls back to its name as text.
4. **Paint** with `drawImage` at the laid-out boxes. Zero-width overlays go in
   the same box as their base emote.
5. **Sharpness.** For the card only, ask for Twitch emotes at `/3.0` instead
   of `/1.0` (28 px is blurry at about 48 px on a 1080p card). Kick `fullsize`
   and 7TV `2x` are fine.
6. **Animated emotes:** the card is one static PNG, so it shows the first
   frame (D2). Check by eye that a few common animated 7TV emotes
   (`catJAM`-like) don't have a blank first frame. If many do, decode a
   middle frame with WebCodecs `ImageDecoder`.

**Tests:**

- Layout unit tests: emote-only message, mixed wrap across lines, a wide emote
  at the cap, zero-width stack, 3-line overflow with an emote at the cut, and
  emote load failure → name text.
- Extend the smoke's fake message with one emote fragment (smoke-only local
  host) and check its pixels in the RTMP output and the recording.

**Gates:** as S3, plus the renderer budget check: all new card code must live
in the lazy `caption-overlay` chunk. The eager bundle had only about 37 B of
headroom in late September; do not touch `chat-avatar.tsx` in the eager path.
Owner by-eye check on a live stream (see Acceptance).

---

## S5: Go Live says "Streaming", and the session clock ticks (owner report, same day)

Owner: "When I click Go Live, the confirmation message says Recording
instead of Streaming. The timer does not work." Both causes are proven on
origin/main `b4bb692e`. The fix is renderer only. **Model lane:** `opus-4.8`
with the `videorc-design` skill.

**Bug 1, the label: Go Live is a record+stream session, and the app
reports record+stream as "Recording".**

- The inspector **Stream** button (`session-panel.tsx:103-113` →
  `studio-tab.tsx:131-142` `handleLiveStream`) sets `streamEnabled: true` and
  leaves `recordEnabled`, which defaults to true (`lib/capture.ts:1246`).
- The backend reports `state: 'streaming'` only for stream-only sessions
  (`recording.rs:5310-5316`, `running_state()` `:2443-2450`,
  `main.rs:11774-11782`).
- So the pill next to the clock reads **"Recording"** in red
  (`studio-tab.tsx:159-173` → `studio-session-view.ts:107-145`), and the stop
  button says "Stop recording" (`studio-tab.tsx:148-154`).
- The same mapping causes three more bugs:
  - The Stream Manager shows a "Recording" chip instead of ON AIR and hides
    stream health and the viewers row (`shared/live-dashboard.ts:110-116`,
    `stream-manager-stats.ts:189-193, 277`).
  - **"Open Stream Manager when I go live" never fires**
    (`use-studio.tsx:6052-6059`).
  - The X manual-RTMP "start the Broadcast" reminder never fires
    (`use-studio.tsx:5428-5450`).
- It isn't a regression. It became prominent when plan 050 (`09568cc5`,
  0.9.102) put the pill at the top of the inspector.

**Bug 2, the timer: the inspector clock has shown a frozen 0:00 since
0.9.102.**

- `SessionClock` (`session-panel.tsx:121-131`) renders
  `sessionClockLabel(recording.durationMs)`.
- The backend sends `duration_ms: None` in every *running* status
  (`recording.rs:2438`, `main.rs:11797`); only the terminal status has it.
- Nothing re-renders the clock on an interval.
- The Library live row has the same bug (`LiveSessionDuration`,
  `library-tab.tsx:604-611`, shows "-").
- The Stream Manager clock works (it ticks from `startedAt`,
  `stream-manager.tsx:269-276`).

**Steps:**

1. **Live predicate.** Add a pure predicate in `studio-session-view.ts`:
   `sessionIsLive({ state, streamUrl }) = state === 'streaming' ||
   (state === 'recording' && Boolean(streamUrl))`. `streamUrl` is already in
   the running status and the contract (`backend-rpc-contract.ts:448-461`),
   so no backend or contract change is needed. Expose `streamUrl` (or a
   derived `live`) on the slim recording-state context
   (`use-studio.tsx:1347-1349`, `14391-14394`).
2. **Use the predicate everywhere listed above:**
   - Pill: **"Streaming"** in the live tone. When the session also records,
     add a quiet secondary Badge "Rec" beside it (follow the design skill;
     the `live` variant is right here because this *is* on air).
   - Stop button: **"End livestream"**, with tooltip "Also stops the
     recording" when recording.
   - `sessionStateOf` in `live-dashboard.ts`, so the Stream Manager shows
     ON AIR, health and viewers.
   - The `openStreamManagerOnLive` trigger.
   - The X reminder.
   - Account-menu dot label and the Library live row label.
3. **Do NOT change the backend to report Streaming for record+stream.**
   `lastSessionActivityRef` (`use-studio.tsx:4354-4357`) would become
   `'live-stream'`, and `showSessionFinished` returns early unless the
   activity is `'recording'` (`session-runtime-recovery.ts:284-300`). That
   would silently drop the "Recording saved" toast after a record+stream
   session. Add a test that pins the toast for record+stream.
4. **Ticking clock.**
   - Add a pure `sessionElapsedMs(startedAt, nowMs)`: invalid or missing
     input gives `undefined`, negative values clamp to 0.
   - `SessionClock` keeps its own `nowMs` state with a 1 s `setInterval`
     keyed on `recording.startedAt`. Keep it local to the component so the
     provider partition (`use-studio.tsx:1911-1915`) doesn't re-render the
     tree every second.
   - Do the same for `LiveSessionDuration`.
   - Fix the docstring at `studio-session-view.ts:80-83`.

**Tests:**

- `studio-session-view.test.ts`: predicate, label and tone for record-only,
  stream-only and record+stream; the elapsed helper.
- `live-dashboard.test.ts`: `{ state: 'recording', streamUrl }` → `'live'`.
- `stream-manager-stats.test.ts`: record+stream gives ON AIR plus the health
  stat.
- A happy-dom component test (`// @vitest-environment happy-dom`): render
  `SessionTransport` with `startedAt`, use fake timers, advance 61 s, and
  expect "1:01".
- The "Recording saved" toast still fires after a record+stream session.
- Update the partition test that assumes `durationMs` updates
  (`use-studio-context-partition.test.ts:175-263`).
- Re-check `scripts/smoke-captions-live-app.mjs:620-632`: it expects the pill
  to read "Recording". Update it if that session streams.

**Gates:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm --filter
@videorc/desktop test`, `pnpm build` (renderer budget). This touches the
session-start triggers, so also run `pnpm smoke:record-latency`. By-eye in the
dev app: Go Live (record+stream) shows "Streaming" + Rec, the clock ticks,
and Stream Manager opens if the setting is on and shows ON AIR.

---

## Out of scope

- YouTube custom emoji images (the backend doesn't fetch YouTube's emoji data).
- Animated cards.
- Badges or role chips on the card.
- The verified checkmark on X.

## Owner decisions

- **D1:** a success dot on the Activity tab while a follow is on stream and
  the Activity pane is hidden behind a tab. **Recommended: yes.**
- **D2:** animated emotes show their first frame on the card (a static image).
  **Recommended: accept.**

## Acceptance (owner, next live stream after release)

1. Highlight one message from each platform with an avatar. Each card shows
   the real avatar.
2. Highlight a Twitch message with a Twitch emote and a 7TV emote, and a Kick
   message with an emote. Each emote shows on the card.
3. Highlight a follow from Activity. The row shows "On stream", the menu says
   "Remove from stream", and the state clears after about 10 s.
4. Send from Stream Manager. The X echo shows "Host".
5. Go Live (record+stream). The inspector says "Streaming" with Rec, the
   clock ticks, Stream Manager shows ON AIR and opens automatically if that
   setting is on.

## Handoff

- Worktree: `git worktree add ../videorc-wt-095 -b fix/095-highlight-card-host
  origin/main`.
- One PR; commit and push each slice.
- S3 step 1 needs a dev app with chat history (the fake chat provider is
  enough).
- No videorc-web change is needed.
