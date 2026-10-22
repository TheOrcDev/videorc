# Plan 188: Polls across every chat

> **Executor instructions**: Follow this plan slice by slice. Run every "Done
> when" check before moving on. If anything in "STOP conditions" happens, stop
> and report; do not improvise. When done, update this plan's row in
> `plans/README.md` and fill in "As built". Gates run once at the end
> (owner rule): write and commit S1–S9 first, then run S10.
>
> **Drift check (run first)**:
> `git diff --stat a53d8837..origin/main -- crates/videorc-backend/src/live_chat.rs crates/videorc-backend/src/cohost.rs crates/videorc-backend/src/cohost_command.rs crates/videorc-backend/src/captions.rs crates/videorc-backend/src/buddy_overlay.rs crates/videorc-backend/src/comment_highlight.rs crates/videorc-backend/src/compositor.rs crates/videorc-backend/src/metal_compositor.rs crates/videorc-backend/src/overlay_layout.rs crates/videorc-backend/src/windows_d3d11_session.rs crates/videorc-backend/src/recording.rs crates/videorc-backend/src/state.rs crates/videorc-backend/src/storage.rs crates/videorc-backend/src/main.rs crates/videorc-backend/src/remote_control.rs apps/desktop/src/shared/backend.ts apps/desktop/src/shared/backend-rpc-contract.ts apps/desktop/src/shared/session-markers.ts apps/desktop/src/shared/electron-ipc-contract.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/hooks/use-studio.tsx apps/desktop/src/renderer/src/components/stream-manager apps/desktop/src/renderer/comments/main.tsx`
> If an anchor quoted below has moved, re-find it by the symbol name. If a
> _behaviour_ changed (not just a line number), that is a STOP condition.

## Status

- **Priority**: P2. It came from a brainstorm on 2026-10-22 about features
  like [#634](https://github.com/TheOrcDev/videorc/issues/634) (Discord
  go-live posts). The owner picked this idea ("I love it") and settled the
  product shape the same day (D2–D9 below).
- **Effort**: L. There are 10 slices:
  - Phase 1 is S1–S7: engine, contracts, compositor slot, card, Stream
    Manager, Scene page, smoke and docs.
  - Phase 2 is S8–S9: Buddy voice, ⌘K and the remotes. It goes in the same
    PR (D9).
  - S10 is the gates.
- **Risk**: MEDIUM. Two hot paths:
  - **The chat delivery funnel.** Votes are counted inside
    `live_chat::try_deliver_messages`, which every platform's chat passes
    through under a persistence fence. The hook must be in-memory, O(1) per
    message, and never `await` network or disk.
  - **The compositor.** The card is a fourth live overlay slot. It draws on
    Metal, CPU and D3D11 and on both stream legs. That means the
    parity/upload tests and the recording-studio gates.
  - There is also a quiet trap in `OverlayLayout`: a stored layout without
    the new `poll` field must still load. Otherwise every user's highlight,
    captions and Buddy placement silently reset to defaults.
- **Depends on**: nothing. Coordinate with the open work listed in "In-flight
  work".
- **Category**: feature (live, community)
- **Planned at**: commit `a53d8837` (origin/main), 2026-10-22
- **Route**: Implementation, fit 8. The product shape is settled and the
  acceptance is clear. Model lanes per slice:
  - `fable-5`: S1 (the vote engine on the chat funnel) and S3 (the
    compositor slot on three render paths). Both are release-critical and
    timing-subtle.
  - `opus-4.8`: S4 (the card's look), S5 (the Stream Manager popover and
    folding) and S6 (Scene page). This is taste work. Load
    `.claude/skills/videorc-design/SKILL.md` and the shadcn skill first, and
    check light **and** dark.
  - `gpt-5.5`: S2 (contracts and relay), S7 (smoke and docs), S8 (voice
    grammar) and S9 (⌘K and the remotes). These are mechanical with clear
    acceptance and follow existing recipes.
  - Escalate to `fable-5` without asking if a by-eye pass or a parity test
    comes back below the bar.

## Goal

A streamer who is live on YouTube, Twitch, Kick and X types one question
and two to five answers in the Stream Manager, or runs
`/poll Tabs or spaces? Tabs | Spaces`. From then on:
- every chat gets "Poll: Tabs or spaces? Type 1 for Tabs, 2 for Spaces.",
  posted as the streamer;
- a poll card appears on the stream with live bars and a countdown;
- viewers vote by typing `1` or `2` in **any** platform's chat, and their
  votes go into **one** tally;
- the streamer sees the tally per platform in the Stream Manager, and vote
  messages don't flood their chat list;
- when the timer runs out, the card says "Counting last votes…" for 15
  seconds, so YouTube's delayed viewers still count. Then it shows the
  winner for 15 seconds and disappears, and every chat gets the result.

The platforms' own polls only see their own viewers, so only a multistream
app can do this.

## What exists today (verified at `a53d8837`)

Paths are under `crates/videorc-backend/src/` (backend) or `apps/desktop/src/`
(desktop) unless stated. There is no poll feature: plans 033 (:441) and 055
(:648) list native platform polls as out of scope. Viewers have no `!` or
number commands anywhere.

### One funnel sees every chat message

- Every connector delivers through `live_chat::try_deliver_messages`
  (`live_chat.rs:3264`): YouTube (:1362), Twitch (:1848), Kick (:934), X
  (:501) and the fake connector (:3620).
  - Deliveries are serialized under `live_chat_persistence.begin_delivery()`
    (:3275).
  - After persisting, it emits `liveChat.message` for each authoritative
    message (:3426-3436) and `liveChat.totals` (:3440).
  - It then calls `cohost::note_messages_under_lifecycle_fence` (:3443), and
    returns.
  - **The vote hook is a sibling call right after :3443**, on
    `authoritative_messages` (already de-duplicated, tombstones applied).
- `LiveChatMessage` (`live_chat.rs:387-432`) fields a vote needs:
  - `id` (`{session}:{platform}:{target}:{providerId}`, the de-dup key);
  - `platform`, `session_id`, `author_id: Option<String>`, `author_name`;
  - `author_roles: Vec<String>`, which includes `"owner"` for the streamer
    on every platform: YouTube `isChatOwner` (`youtube_chat.rs:824`), the
    Twitch/Kick broadcaster badge (`twitch_chat.rs:515`, `kick_chat.rs:1366`),
    and X when the author is the host (`x_chat.rs:807`);
  - `published_at`, `received_at` (RFC 3339), `message_text`, `event_type`
    (`Message|Paid|…`, :84) and `is_deleted`.
- **"Exactly once" is per buffered id only.** After the 5,000-row buffer
  evicts, or after Clear view (`clear_local` :1346 clears `seen`), a replayed
  provider message is emitted again. Deletions arrive as `is_deleted`
  tombstones with the same id (:1361-1393). The tally must be idempotent by
  `message.id`.

### Who a viewer is, and when they voted

| Platform | Author key | Arrival | `published_at` |
| --- | --- | --- | --- |
| YouTube | `authorChannelId` (`youtube_chat.rs:893`), may be absent | Polled every 5 s minimum, 10 s after 6 empty pages (`:41-44`). Stops entirely while the quota breaker or `chatTransport: off` is set (`:1315`, `:1186`). | From YouTube (`:900`). `received_at` is the same for a whole page. |
| Twitch | `chatter_user_id` (`twitch_chat.rs:676`) | EventSub push, real time | From Twitch (`:357`, `:618`) |
| Kick | `sender.id` (`kick_chat.rs:1432`) | Relay long-poll, 20 s hold (`:78`) | Kick `created_at` (`:1439`) |
| X | `author.id` (`x_chat.rs:804`) | Relay long-poll | The relay's receive time (`:800-803`); X sends none |
| TikTok, Instagram, Custom | – | Not read (`live_chat.rs:687-713`) | – |

- **There is no cross-platform identity.** Author keys are
  `platform:authorId` elsewhere too (`cohost.rs:6046`, `live_chat.rs:3162`).
  When `author_id` is absent, cohost falls back to the display name
  (`cohost.rs:6052`).
- **Only one YouTube chat per session.** `LiveChatStartParams.youtube` is a
  single `Option` (`live_chat.rs:1778`; the last OAuth target wins at
  `main.rs:3409-3410`). The vertical YouTube broadcast's chat is not read
  (plan 094:638-640). Twitch and Kick are one destination each.
- **Twitch Shared Chat is not filtered**: `twitch_chat.rs` has no
  `source_broadcaster_*` handling.
- **The first YouTube page probably carries pre-session chat**, all stamped
  with one `received_at` (`youtube_chat.rs:1302`). This is unconfirmed. A
  quota pause also releases a backlog in one burst. Gate on `published_at`,
  not on arrival.
- **The streamer's own sends come back as chat** with role `"owner"`. That
  includes Buddy auto-chat and the poll's own announcement. The echo matcher
  (`cohost_ack.rs:687`) ignores texts under 6 characters, so it cannot be
  relied on for "1". Exclude `owner` rows outright.

### Sending into every chat

- RPC `liveChat.send` goes to `send_live_chat_message` (`live_chat.rs:2458`).
  `operationId` (a UUID) is the idempotency key, and the text is 1–200
  characters for everyone (:2466). With no `destinationIds`, it sends to
  every provider in parallel (:2602-2612, `join_all` :2682), and returns one
  durable operation with a per-destination phase (`liveChat.sendOperation`).
- Per platform:
  - **YouTube**: `liveChatMessages.insert`, 50 quota units per send
    (`youtube_quota.rs:383-400`), shed at 100% of the local budget
    (`BudgetCall::ChatSend` :594).
  - **Twitch**: Helix `user:write:chat`.
  - **Kick**: `chat:write`, 500 graphemes.
  - **X**: **140 characters** (`x_live.rs:1281`); needs "Authorize X Live".
- **Backend-originated precedent**: Buddy sends through
  `send_live_chat_message` with `register_buddy_operation`
  (`cohost.rs:6997`, `:7349-7350`). Poll posts copy that shape.

### On-stream overlays: the Buddy bubble is the recipe

- **Rust has no text rasterizer.** Every text card is a PNG painted by the
  Studio renderer on an `OffscreenCanvas`, encoded in a worker
  (`renderer/src/lib/canvas-png.ts:112`, 8–40 ms) and pushed over RPC.
- **The highlight card is the wrong template** (`comment_highlight.rs`):
  - it has a 10 s TTL and needs a `messageId`;
  - it is streaming-only and runs on the serial LiveControl lane under four
    locks;
  - it fires Buddy gaze and status events on every update;
  - it shares one slot with manual cards, activity auto-show and Orcle
    cards.
- **Banners are the wrong template too** (`banners.rs`, `banner_prepare.rs`).
  They are file-backed with mtime revisions and share the cap of 4 showing.
- **The Buddy bubble is the closest** (`buddy_overlay.rs`):
  - `buddy.overlay.set {pngBase64, target?, rect?}` (`SetBuddyOverlayParams`
    :399, `set_buddy_overlay` :441, RPC `main.rs:9603`) decodes off the
    runtime, then swaps into an app-wide `CaptionOverlaySlots`
    (`state.rs:1164`, struct `captions.rs:2491`);
  - it has no TTL and no streaming-only rule, and it sits on the general
    lane (`main.rs:5440`);
  - targets come from `buddyOverlayTargetPlan`
    (`renderer/src/lib/buddy-overlay-targets.ts:29`): the primary canvas plus
    the auxiliary one (the vertical leg or the split stream leg).
- **Per-frame compositing** (`compositor.rs`):
  - `publish_compositor_frame` (:8060) snapshots slots into
    `CompositorRenderInputs` (:8781), for the primary leg (:8255-8281) and
    the auxiliary leg (:8378-8452).
  - **Metal**: text cards are image quads with a content namespace
    (`push_caption_overlay_gpu_source` :6418). Push sites are at :7063,
    :7143 and :7415. Used namespaces are listed at :6822: images 1,
    captions 2, highlight 3, capture 4–5, chrome 6, pet 7, bubble 8, and
    banners 9. Textures upload once per revision
    (`metal_compositor.rs:1846-1890`).
  - **CPU**: `render_compositor_yuv420p_frame` (:8919) blends with
    `composite_caption_overlay` (:9847) every frame.
  - **D3D11**: `WindowsD3d11OverlayInput` (`windows_d3d11_session.rs:957`)
    is fixed at session start (`recording.rs:4382`). `current_overlay_frames`
    (:1957) reads the slots every tick. Overlay z is captions 10, Buddy 11/12
    and highlight 13 (:764-781). The D3D11 pump refuses simulcast
    (`recording.rs:4366`), so vertical sessions on Windows use the CPU
    compositor.
  - **Legacy FFmpeg (4K60, bridge off) and direct D3D11 recording** have no
    live text slot (`recording.rs:2113-2116`, :21423).
    `comment_highlight_available` (`comment_highlight.rs:432`) is the
    precedent for saying so.
  - **The proof surface** (Linux preview, Windows idle preview) draws no
    text overlays.
- **Z order on every path** (`docs/overlays.md:201-213`): scene, takeover,
  banners, captions, Buddy pet, Buddy bubble, highlight card. Captions step
  above the card only when both hug the same edge
  (`caption_overlay_safe_inset` / `overlay_collision_inset`,
  `compositor.rs:9780/9803`). That rule is pairwise and knows only the card.
- **Placement** is one oracle for every path:
  `overlay_layout::overlay_blit_layout` (:354). It places by gravity from
  the rect centre.
- **`OverlayLayout` is a fixed three-field struct with no serde defaults**
  (`overlay_layout.rs:105-109`).
  - `load_overlay_layout` (:689-704) falls back to `default()` on any parse
    or validate failure. So adding a field naively **resets every user's
    placements**.
  - The TS side is `OVERLAY_ITEMS = ['highlight','captions','buddy']` and
    `OverlayLayout = Record<OverlayItem, …>` (`shared/backend.ts:5414-5417`).
  - Consumers: `components/scene/overlay-stage.ts`, `lib/overlay-layout.ts`
    and `components/tabs/layout-tab.tsx` (the Scene page inspector,
    `OVERLAY_ITEM_LABELS`).
- **Defaults** (`overlay_layout.rs:259-275`, sizes :190-199): highlight
  bottom left (chosen to stay "off faces and off the usual top-right",
  `comment_highlight.rs:75`), captions bottom centre, Buddy bottom right.
  Portrait safe area: 8% top, 22% bottom (`overlay_layout.rs:29-36`).
- **Card look** (`renderer/src/lib/caption-overlay.ts:750-1021`):
  - glass plate `rgba(16,16,18,0.78)`, a white sheen from 0.07 to 0, hairline
    `rgba(255,255,255,0.1)`, shadow `rgba(0,0,0,0.4)`;
  - `canvasFont` (:379);
  - metrics from `highlightMetrics` (`lib/comment-highlight.ts:75`): text =
    max(20, long edge ÷ 48).
- **Latest-wins push loop**: `LatestWinsScheduler`
  (`renderer/src/lib/captions-ui.ts:247`).

### Stream Manager, composer and relay

- **Status bar** (`renderer/src/components/stream-manager/stream-manager-status-bar.tsx:167`).
  - The right-hand actions are Hints, Pin, Highlight position, Mark clip
    (on air only), **Banners** (`DropdownMenu` :369-384) and Clear (asks
    first, `ConfirmDialog` :522).
  - Below 640 px everything folds into one ⋯ menu (:401-520; Banners is a
    submenu at :462).
  - The design skill's status-bar list (`SKILL.md:442-447`) must gain Poll.
- **Popover prior art**: `components/ui/popover.tsx` (on `glass-float`, :27)
  and `BackgroundStylePopover` (`components/tabs/assets-tab.tsx:506`).
- **Chat** (`stream-manager/chat-pane.tsx`):
  - `ChatPane` :104, filter row :410-525;
  - Composer :656, `COMPOSER_COMMANDS` :650, `submit` :797.
- **Composer grammar**: `classifyComposerDraft`
  (`shared/session-markers.ts:226`) handles `/help`, `/marker` and `/banner`.
  The `ComposerCommand` union is at :214, and the unknown-command text that
  lists the commands is at :243-247. The banner sub-grammar
  (`shared/banner-commands.ts`, `classifyBannerCommand` :69,
  `bannerCompletions` :101) is the pattern for `/poll`.
  - `/clip` is not on main; it is in open PR #694.
- **Window relay** (banners, the template). The Stream Manager never calls
  the backend:
  - **list**: Studio `pushCommentsBanners` (`use-studio.tsx:2405`) → main
    `comments-window:banners-push` (`main/index.ts:15524`, cached and
    forwarded) → window seed `comments-window:banners-get` (:15523).
  - **action**: window `runBanner` (`comments/main.tsx:154`) → main
    `comments-window:banner` (:15531, `commentsCommandBroker.request`) →
    Studio `onBannerRequest` (`use-studio.tsx:3017`) → RPC → result push
    (:15541).
  - **wiring**: `shared/electron-ipc-contract.ts` (maps :161-206 and
    :275-294, `bannerRelayCommandSchema` :1316),
    `shared/renderer-security-policy.ts:151-154`,
    `preload/index.ts:97-102`, and the tests
    `shared/electron-ipc-contract.test.ts`,
    `main/renderer-security-policy.test.ts`,
    `main/smoke-comments-contract.test.ts`.
- **RPC registration**: every new method goes in
  `websocket_method_execution_policy` (`main.rs:5393`, general lane like
  `buddy.overlay.set` :5440). It also needs a dispatch arm (beside
  `"liveChat.send"` :11517) and the strict TS contract
  (`shared/backend-rpc-contract.ts`).

### Voice, ⌘K and remotes (Phase 2 recipes)

- **Buddy voice**: caption finals go to `cohost::note_transcript_final`
  (`cohost.rs:7639`), then `detect_voice_command` (:7666), then
  `run_detected_command` (:7821).
  - It is Premium (:7705) behind the `voiceCommands` flag (:7672).
  - The banner recipe is commit `d06eaf17`: a `CommandKind` variant
    (`cohost_command.rs:461`), nouns like `BANNER_NOUNS` (:261), a parser
    called from `parse_wake` (:1086) before the highlight grammar, and a
    runner like `run_banner_command` (`cohost.rs:7911`).
- **Remotes** (plan 186 commits `3ca94825`, `35c88786`, `1d82e7fa`,
  `262db15d`):
  - `RemoteIntent` (`remote_control.rs:54`, debounce :127, validation :146);
  - `executeRemoteIntent` (`renderer/src/lib/remote-surface.ts:293`);
  - Stream Deck `apps/streamdeck-plugin/`;
  - phone `crates/videorc-backend/remote_web/` (a live push needs
    `LAN_EVENTS`, `remote_lan.rs:680`);
  - ⌘K `renderer/src/components/command-palette.tsx` (Banners group :374).

### Tests to copy

- **Fake chat**: `liveChat.start { fakes: [FakeChatConfig…] }`
  (`live_chat.rs:1820`), with `authors`, `delete`, `outOfOrder` and
  `includeDuplicate`. Text is fixed at `"Fake chat message #{seq}"` (:3960),
  so S7 adds scripted text.
- **Smokes**: `smoke:live-chat-fake-providers`, `smoke:comment-highlight-stream`
  (pixel analyzer `scripts/lib/comment-highlight-artifact.mjs`),
  `smoke:banners`, `probe:comments-window` and `smoke:buddy-commands`.
- **Parity tests**: `cpu_and_metal_blit_the_same_overlay_rect`
  (`compositor.rs:16736`), `metal_uploads_a_banner_once_across_120_ticks`
  (:19619), and
  `windows_overlay_frames_stack_the_buddy_between_captions_and_the_card`
  (`windows_d3d11_session.rs:3473`).

## Owner decisions

Each decision has a recommendation, and the slices below assume it. ⚑
marks the ones the owner answered.

**Answered 2026-10-22, in two rounds:** the owner took every recommendation
(D2–D9). D1 and D10–D14 were not raised separately, so their
recommendations stand. Ask before building if any of them should change.

| #     | Question | Decision |
| ----- | -------- | -------- |
| D1    | What is it called? | **Poll**, everywhere in copy, with a `CONTEXT.md` entry. Not "vote", "prediction" (Twitch's betting feature) or "survey". |
| D2 ⚑  | How do viewers vote? | **Just the number.** A message that is only `1`…`5` (keycap emoji `1️⃣` too) counts while a poll is open. Anything else is chat. |
| D3 ⚑  | Can a viewer change their vote? | **Their last vote counts.** One vote per viewer per platform. A different number moves the vote. |
| D4 ⚑  | Free or Premium? | **Free.** The Buddy voice phrase (Phase 2) is Premium, like every voice command. |
| D5 ⚑  | What happens to vote messages in the chat list? | **They fold into the poll.** A message that is only a vote is left out of the Stream Manager chat list while it counts, and the poll panel shows the tally. Paid messages (Super Chat and similar) always show, and still count. The Library history keeps everything. |
| D6 ⚑  | Post the poll in chat? | **Start and result**, as the streamer, in every chat. A **Post in chat** switch in the form is on by default and remembered. A poll with zero votes or a cancelled poll posts no result. |
| D7 ⚑  | How does it show on stream? | **Automatically.** The card appears when the poll opens, updates live, shows the winner for 15 s after it ends, then disappears. **Show result again** brings it back for 15 s. The Scene page places it. |
| D8 ⚑  | Late votes | **15 s grace.** When the timer ends (or on **End now**), the card says "Counting last votes…". A vote counts if its platform time is at most 15 s after the end. The result is final 25 s after the end, which leaves 10 s for YouTube's polling. |
| D9 ⚑  | Voice and remotes | **Phase 2, in the same PR**: Buddy voice (Premium), ⌘K, Stream Deck and phone. They are built after Phase 1 works. Gates run once at the end. |
| D10   | Limits | 2–5 options. Question up to 60 characters, each option up to 25 (Twitch's own poll limits). Duration: **1 min** (default), 2 min, 5 min or **No timer** (ends on **End now**). The last-used duration is remembered. One poll at a time. |
| D11   | Who can vote? | Everyone except the streamer's own accounts (role `owner`). Moderators, members and VIPs can vote. A **deleted** vote message takes that vote back. Votes are keyed by `(platform, author_id)`, falling back to the display name when YouTube omits the id. One person on two platforms gets two votes; there is no cross-platform identity. |
| D12   | Where it draws | **Between the Buddy and the highlight card**: banners → captions → Buddy → **poll** → highlight card. A clicked chat message is still the most urgent thing. Captions yield to the poll as they do to the card. Default place: **top left** on landscape (the one free corner: highlight is bottom left, Buddy bottom right, top right is usually the camera), and top centre inside the safe area on portrait. "Appears in: Stream" and "Recording" are both on. |
| D13   | Which legs show it | The primary canvas always draws it. The auxiliary (vertical) leg draws it **only if one of its destinations has a chat Videorc counts**. The vertical YouTube broadcast's chat isn't read (plan 094), so a "type 1" card there would collect votes that never count. The popover says "Vertical viewers can't vote yet" when that applies. |
| D14   | Where the card can't draw | 4K60 on the legacy FFmpeg path and direct D3D11 recording have no live text slot. **The poll still runs** in chat and the Stream Manager, and the popover says "The poll card can't show on this stream (4K 60 fps). Votes still count." The Go Live sheet gets the overlay notice sentence with the label "polls". |

## Design

### What a poll is

A backend-owned state machine. There is one poll at a time per live
session, and the clock is injectable for tests:

```
           start                     timer ends / End now          +25 s
  (none) ────────▶ open ────────────────────────────────▶ counting ─────▶ final
                    │  │                                      │             │
                    │  └── Cancel ──▶ cancelled ◀── Cancel ───┘             │ +15 s
                    │                                                       ▼
                    └── session ends ──▶ final (no grace)          card hidden
```

- **open**: votes count, and the card shows a countdown (or no countdown
  with No timer).
- **counting**: the timer ended. Votes stamped up to `endedAt + 15 s` still
  count. The card says "Counting last votes…".
- **final**: the tally is frozen. The card shows the winner for 15 s
  (`RESULT_HOLD`). A tie shows "Tie". The result post goes out.
- **cancelled**: the card clears at once. There is no result and no post.
- **Session end**: the poll finalizes at once, because chat stops. Stopping
  the session never waits on a poll.
- **Relaunch after a crash**: an `open` or `counting` row becomes
  `interrupted` with its last checkpointed tally, and it is not resumed.
- A new poll may start while the previous one is `final`; it replaces it.
  A new poll while one is `open` or `counting` is refused: "End the current
  poll first."

Constants (in `polls.rs`, each one covered by a unit test):
- `LATE_VOTE_GRACE = 15 s`;
- `FINALIZE_AFTER = 25 s` (from the end);
- `RESULT_HOLD = 15 s`;
- `OPEN_SKEW = 10 s`;
- `STATUS_COALESCE = 1 s`;
- `CHECKPOINT_EVERY = 5 s`.

### The vote rule

The pure function `classify_vote(text, option_count) -> Option<u8>`:
1. Trim the text.
2. Accept exactly one ASCII digit `1..=option_count`, or that digit's keycap
   emoji (`1️⃣`: digit, U+FE0F optional, U+20E3).
3. Reject everything else, including `#1`, `1!`, `@user 1` and `11`.

`protocol-fixtures/poll-votes.json` pins the cases. Rust and TS both run
the fixture (the TS copy drives folding, see below).

A message counts as a ballot when all of these hold:
- `event_type` is `Message` or `Paid`;
- `is_deleted` is false;
- `author_roles` has no `owner`;
- the text classifies;
- `received_at` ≥ `openedAt`, and `published_at` ≥ `openedAt − OPEN_SKEW`.
  This stops YouTube backlog pages and pre-poll "1"s from counting;
- `published_at` ≤ `endedAt + LATE_VOTE_GRACE` (once ended);
- the poll is not `final` or `cancelled`.

If `published_at` doesn't parse, use `received_at`.

The ballot is keyed by voter = `(platform, author_id or "name:" + author_name)`
and stored as `{option, published_at, message_id}`. A ballot replaces the
voter's current one only if its `published_at` is later (ties: the later
arrival). That makes out-of-order delivery and replays harmless. A
tombstone whose `id` equals the voter's current ballot's `message_id`
removes the ballot; the voter does not fall back to an older ballot. The
tally is `option → count` and `platform → count`, derived from the ballot
map. Replays by `message.id` cannot double-count, because there is one
ballot per voter.

The hook is `polls::note_messages(state, &authoritative_messages)`, called
right after `cohost::note_messages_under_lifecycle_fence`
(`live_chat.rs:3443`):
- It takes a `std::sync::Mutex` on the poll state, does map work, and
  marks the poll dirty.
- **It does not await, touch the DB, or send.**
- A separate task (spawned at poll start, ended at final or cancel) owns
  the timers, coalesced `polls.status` emits, checkpoints and chat posts.

### Chat posts

Sent by the poll task through `send_live_chat_message` with no
`destinationIds`, using a poll-owned operation (the `register_buddy_operation`
shape). They are never sent on the delivery path. One text goes to every
chat, so it must fit X's 140 characters:
- **Start**: `Poll: {question} Type 1 for {A}, 2 for {B}.` (options continue the
  same way). If that is over 140 characters, it becomes `Poll: {question}
  Vote 1–{N} in chat, options are on stream.`, with the question shortened
  with `…` to fit.
- **Result**: `Poll result: {winner} wins with {pct}% of {total} votes.`, or for
  a tie, `Poll result: tie between {A} and {B} ({total} votes).`, fitted the
  same way.
- **No post** when Post in chat is off, for zero votes, or for a cancelled
  poll.
- A shed or failed destination (YouTube quota, X not authorized) shows as
  one quiet line in the popover ("Couldn't post to YouTube chat"). It never
  raises a toast and never blocks the poll.
- The echoes come back as `owner` rows. They never count, and they show in
  chat as the streamer's own messages.

### Wire shape

All new methods go on the general lane in `websocket_method_execution_policy`.

| Method / event | Params → result |
| --- | --- |
| `polls.start` | `{ question, options: string[], durationSeconds: number \| null, postInChat: boolean }` → `PollStatus`. Refusals: not live, no chat read, already open, invalid lengths. |
| `polls.end` | `{ pollId }` → `PollStatus` (enters `counting`) |
| `polls.cancel` | `{ pollId }` → `PollStatus` |
| `polls.reshow` | `{ pollId }` → `PollStatus` (final only; card shown again for `RESULT_HOLD`) |
| `polls.current` | `{}` → `PollStatus \| null` (hydrate on reconnect) |
| `polls.overlay.set` | `{ target, pngBase64, rect? }` → targets info (copy of `buddy.overlay.set`) |
| `polls.overlay.clear` | `{ target? }` |
| event `polls.status` | `{ poll: PollStatus \| null }`, sent at most once a second for tally changes and immediately on state changes |

`PollStatus` contains:
- `pollId`, `sessionId`, `question`, `options: [{ label, votes }]`,
  `totalVotes`;
- `byPlatform: [{ platform, votes }]`;
- `state: 'open'|'counting'|'final'|'cancelled'`, `openedAt`,
  `closesAt?`, `endedAt?`, `finalAt?`;
- `card: 'shown'|'hidden'`, `cardLegs: { primary: true, auxiliary: boolean }`
  (D13), `cardAvailable: boolean` (D14);
- `winners: number[]`;
- `countingPlatforms: Platform[]` and `pausedPlatforms: Platform[]` (a chat
  that is connected but not reading, like YouTube under the quota breaker);
- `posts: { start?, result? }`, each a per-destination phase summary.

**Serde trap** (3 past outages): every `Option` on this wire gets
`#[serde(skip_serializing_if = "Option::is_none")]` and is optional, not
nullable, in the strict TS schema. `poll: null` on the event is the one
deliberate null. Declare it nullable explicitly and pin it in a contract
test.

**The backend owns the card's visibility.** It flips `card` to `hidden`
after `RESULT_HOLD` and on cancel, and it also clears `AppState.poll_overlay`
itself then and at session end. A renderer that died mid-poll therefore
can't leave a card stuck on stream.

### The card on the picture

- **Raster** (renderer, `lib/poll-card.ts`, new): `renderPollCardPng(status,
  canvas, rect, nowMs)` on an `OffscreenCanvas`, encoded with
  `canvasToBase64Png`.
  - It uses the highlight card's glass recipe, through a local
    `paintGlassPlate` helper in the new module. The existing card and
    caption code stay untouched.
  - It uses `canvasFont`, with text = max(18, long edge ÷ 60). That is
    smaller than the highlight card's ÷48, because the poll has up to 7
    rows.
- **Layout**, top to bottom:
  1. The question, weight 600, at most 2 lines, ellipsis.
  2. One row per option: a `1` key chip, the label (1 line, ellipsis) and a
     right-aligned `62%` in tabular numbers. A fill bar sits behind the
     row: white at 0.16 alpha, or 0.32 for the leader or winner.
  3. A footer: `Type 1–3 in any chat` with `0:42` on the right. During
     counting it reads `Counting last votes…`, and when final it reads
     `Tabs wins · 84 votes` (or `Tie · 84 votes`).
  - The card is monochrome on the glass plate. It has no platform logos
    (brand kits differ, and X's kit rules from plan 167 would apply).
- **Fixed pixel size for the whole poll.** The width is the placed rect's
  width, and the height is fixed by the option count and the question's
  line count, computed once at open. The size never changes when bars move.
  That avoids gravity jitter, and Metal and D3D11 reuse one texture size.
- **Driver** (Studio renderer, `use-studio.tsx`):
  - It subscribes to `polls.status`.
  - While `card === 'shown'`, it paints each target in `pollOverlayTargetPlan`
    (a copy of `buddyOverlayTargetPlan` that also honours
    `cardLegs.auxiliary`) through a `LatestWinsScheduler`.
  - It repaints on every status and on a 1 s `setInterval` for the countdown.
    Never use `requestAnimationFrame`, because painting throttles behind a
    game.
  - When the card is `hidden`, or the poll is `null`, it calls
    `polls.overlay.clear`.
- **Slot** (backend): `AppState.poll_overlay: CaptionOverlaySlots`, with
  placement fallback `OverlayItem::Poll` and snap `TopLeft`.
  - It is carried in `CompositorRenderInputs` for both legs, under the
    `poll` flags in `OverlayLegFlags`.
  - **Metal**: a new content namespace **10**, pushed at all three push
    sites after the Buddy and before the card. Update the namespace comment
    at `compositor.rs:6822`.
  - **CPU**: `composite_caption_overlay` after the Buddy, before the card.
  - **D3D11**: new source ids and a z between the Buddy (12) and the card,
    so the card moves up one. The slot is wired into
    `WindowsD3d11OverlayInput` at session start, always, so a poll started
    mid-session shows.
  - **Legacy FFmpeg, direct D3D11 recording and the proof surface**: not
    drawn. `poll_card_available` mirrors `comment_highlight_available`
    (D14).
- **Collisions**: generalize the caption inset so captions yield to the
  card **and** the poll when they hug the same edge. The Buddy's gaze keeps
  ignoring the poll (out of scope).
- **Motion**: v1 is an instant cut, and the bars step once a second. A fade
  can come later through the existing per-path opacity, with no extra
  uploads.

### `OverlayLayout` gains `poll`, without resetting anyone

- **Rust**: add `poll: OverlayItemLayout` with
  `#[serde(default = "default_poll_item")]`. Add `OverlayItem::Poll` (label
  `"polls"`) to `ALL` and to every exhaustive match, plus default sizes
  (landscape `0.30 × 0.40`, portrait `0.78 × 0.30`) and the snap rects.
- **TS**: `OVERLAY_ITEMS` gains `'poll'`. The layout loader, contract
  schema and `overlay-stage` fill a missing `poll` from the default, so
  they read an old stored layout and an old backend reply alike. Write a
  contract test for "old stored layout without `poll` loads with the user's
  three placements intact" in **both** Rust and TS.
- **Scene page**: the Poll item shows in the canvas and inspector through
  `OVERLAY_ITEM_LABELS` ("Poll"). Its stand-in is a sample card ("Tabs or
  spaces?", 2 options). It gets the same "Appears in" switches as the other
  items.

### Stream Manager

- **Button**: a word-only `StatusBarAction` **Poll** after Banners, with
  the hint "Start a poll (or type /poll)". While a poll is open or counting,
  it gains a small live dot. It is a `Popover` trigger, because the form
  needs inputs. Below 640 px it becomes a ⋯ menu item that opens the same
  popover. The control size inside is `xs`, on `glass-float`.
- **Popover, create form**:
  - Question (`Input`, 60) and options 2–5 (`Input`, 25 each, **Add
    option** up to 5, remove ✕ above 2).
  - **Duration** `SegmentedControl` (1 min · 2 min · 5 min · No timer).
  - **Post in chat** `Switch`.
  - **Start poll** button. Field labels name their controls.
  - Disabled reasons (`DisabledReason`): "Go live to start a poll", "No chat
    is connected", "End the current poll first".
  - The last question and options are prefilled from window `localStorage`
    (try/catch, a convenience only).
- **Popover, live tally**:
  - The question, then one row per option with `Progress`, `62%` and an
    outline `Badge` count (tabular).
  - A per-platform line of outline Badges with platform dots: "YouTube 31 ·
    Twitch 22 · Kick 9".
  - The countdown, or "Counting last votes…".
  - **End now** (button) and **Cancel poll** (ghost, through
    `ConfirmDialog`: "Cancel this poll? Votes are discarded and no result is
    shown.").
  - Quiet diagnostic lines, only when true: "YouTube chat is paused, so
    YouTube votes aren't counting", "Vertical viewers can't vote yet"
    (D13), "The poll card can't show on this stream (4K 60 fps). Votes still
    count." (D14), "Couldn't post to YouTube chat".
- **Popover, final**: winner and bars, **Show result again**, **New poll**.
- **Folding** (D5):
  - The chat list hides a message when all of these hold: a poll's window
    covers it (`openedAt − OPEN_SKEW` ≤ `published_at` ≤
    `endedAt + LATE_VOTE_GRACE`, or no end yet), it is not `owner`, its
    `event_type` is `Message`, and the TS `classifyVote` (same fixture)
    accepts it for that poll's option count.
  - The rule is time-based and stable, so folded votes stay folded after the
    poll ends. Counters, unread markers and `arrivalKey` don't count folded
    rows.
  - Search still finds them.
  - The Library chat history is unchanged.
- **`/poll`** (`shared/poll-commands.ts`, new, wired into
  `classifyComposerDraft`). It never posts to chat:
  - `/poll`: opens the popover.
  - `/poll Tabs or spaces? Tabs | Spaces`: the question is everything up to
    and including the first `?`, and the options are split on `|`. It
    starts at once with the remembered duration and Post in chat setting.
  - `/poll end` and `/poll cancel` (cancel asks first, through the same
    dialog).
  - Errors are inline in the composer, for example "Use /poll Question?
    Option | Option (2–5 options)."
  - Update the completions, the `/help` notice (`chat-pane.tsx:805`) and
    the unknown-command text (`session-markers.ts:243-247`).
- **Relay**: `comments-window:poll` (window → Studio, through the command
  broker) and `comments-window:poll-state` / `-get` (Studio → window, cached
  in main). This copies the banner relay one for one, including the security
  allowlist and preload.

### Phase 2

- **Buddy voice** (Premium, `voiceCommands` flag):
  - "Buddy, start a poll: tabs or spaces": the question becomes "Tabs or
    spaces?", and the options split on `,` and a final ` or `, 2–5 of them.
    It uses the remembered duration.
  - Also: "Buddy, end the poll", "Buddy, cancel the poll" and "Buddy, show
    the poll result".
  - A new `CommandKind` family and parser go before the highlight grammar,
    following the banner recipe.
  - Ambiguous speech (one option, or more than five) gets Buddy's usual
    "didn't catch that" acknowledgement and starts nothing.
- **⌘K**: a Poll group with New poll… (opens the Stream Manager with the
  popover open), End poll, Cancel poll and Show result again.
- **Stream Deck**: End poll and Show result again actions.
- **Phone**: End poll and a read-only live tally card.
  - It needs a `polls.status` entry in `LAN_EVENTS`. The leak argument for
    `docs/remote-control.md`: the question, options and counts are already
    public on stream. No voter identities cross the wire, and `byPlatform`
    is counts only.

## Slices: Phase 1

### S1: Poll engine (backend), `fable-5`

- Add `polls.rs`, with tests in `polls_tests.rs`:
  - `classify_vote`, the ballot map, the state machine and the constants
    above;
  - `polls::note_messages`, hooked at `live_chat.rs:3443`;
  - the poll task (timers, coalesced `polls.status`, checkpoints, final,
    `RESULT_HOLD`, card hide, slot clear);
  - chat posts with the 140-character fitting;
  - the session-end finalize, hooked where the session stops live chat
    (`stop_live_chat_for_session`, `live_chat.rs:3009`, or its caller);
    whichever runs once per session end.
- Add a `polls` table migration in `storage.rs`: `id`, `session_id`,
  `question`, `options_json`, `duration_seconds`, `opened_at`, `ended_at`,
  `final_at`, `status`, `results_json`, `post_in_chat`. Tidy `open` and
  `counting` rows to `interrupted` at launch.
- Add the RPCs in `main.rs`: the policy entries, the dispatch arms, and
  `polls.overlay.set/clear` copied from `buddy.overlay.*` (the slot itself
  lands in S3; this slice can add `AppState.poll_overlay` with no
  compositor reader yet).
- Add `protocol-fixtures/poll-votes.json` and its Rust test.
- **Done when**: the code compiles in your head and you have re-read the
  hook for `await`. Rust tests are written for:
  - every fixture case;
  - the last vote wins, and out-of-order delivery;
  - a replayed id;
  - a tombstone removing the current ballot only;
  - owner rows ignored;
  - the `OPEN_SKEW` backlog;
  - grace in and out at exactly ±1 s;
  - `FINALIZE_AFTER`, `RESULT_HOLD`, cancel and session end;
  - crash tidy;
  - a 10,000-message tally taking under 5 ms;
  - post fitting at 139/140/141 characters.

  They run in S10 (owner rule). Commit.

### S2: Contracts, relay and Studio wiring, `gpt-5.5`

- `shared/backend.ts`: `PollStatus` and the friends listed above.
- `shared/backend-rpc-contract.ts`: strict schemas for every method and
  the event, with the deliberate `poll: null` pinned.
- `shared/poll-votes.ts`: `classifyVote`, plus a test driven by
  `protocol-fixtures/poll-votes.json`.
- Electron: `comments-window:poll`, `comments-window:poll-state`/`-get` in
  `electron-ipc-contract.ts`, `renderer-security-policy.ts`, preload and
  `main/index.ts`, with the contract tests updated.
- `use-studio.tsx`: subscribe to `polls.status`, hydrate with
  `polls.current` on (re)connect, push to the Stream Manager, and handle
  the poll relay requests through `polls.start/end/cancel/reshow`.
- **Done when**: `pnpm --filter @videorc/desktop test -- poll
  electron-ipc-contract renderer-security-policy smoke-comments-contract`
  passes, and so does `pnpm typecheck`. Commit.

### S3: Overlay layout and the compositor slot, `fable-5`

- `OverlayLayout.poll` with `serde(default)`, `OverlayItem::Poll`
  everywhere, default sizes and snaps (D12), validation, and the label
  `"polls"` in the overlay start notices (D14).
- TS: `OVERLAY_ITEMS` gains `'poll'`, with default fill-in when loading an
  old layout.
- The poll slot in `CompositorRenderInputs` on both legs, plus
  `OverlayLegFlags` and the start params:
  - Metal namespace 10 at the three push sites;
  - CPU after the Buddy;
  - D3D11 source ids and z (the card moves up one), carried in
    `WindowsD3d11OverlayInput`;
  - `poll_card_available` beside `comment_highlight_available`;
  - captions yield to the poll.
- Tests:
  - a copy of `cpu_and_metal_blit_the_same_overlay_rect` with the poll
    between the Buddy and the card (the card wins an overlap);
  - "Metal uploads a poll card once per revision across 120 ticks";
  - the D3D11 stacking fixture extended to captions < Buddy < poll < card;
  - `overlay_layout` tests: an old stored layout keeps its three
    placements, and the poll gets the defaults;
  - the TS `overlay-layout.test.ts` mirror.
- **Done when**: the TS tests pass, and the Rust tests are written (they run
  in S10). Commit.

### S4: The card raster and driver, `opus-4.8`

- `lib/poll-card.ts`:
  - `renderPollCardPng`, `pollCardSize` (fixed for a poll) and
    `paintGlassPlate`;
  - `pollOverlayTargetPlan` (D13), in `lib/poll-overlay-targets.ts`.
- Add the driver in `use-studio.tsx` (scheduler, 1 s interval, clear on
  hidden).
- Unit tests:
  - the size is stable across tallies, and depends only on the option count
    and question lines;
  - ellipsis on 25-character options;
  - 0 votes shows `0%` with empty bars, and never `NaN`;
  - a tie;
  - the footer text per state;
  - the countdown never goes negative;
  - the portrait size stays inside the safe area.
- **Done when**: the tests pass, and you have looked at PNGs of the card,
  rendered by a throwaway script in the scratchpad (not committed): 2 and 5
  options, open, counting and final, landscape and portrait, on a light and
  a dark background frame. Commit.

### S5: Stream Manager (button, popover, folding, `/poll`), `opus-4.8`

- Read `.claude/skills/videorc-design/SKILL.md` in full first.
- Build the Poll `StatusBarAction`, the popover in its three states, the ⋯
  mirror below 640 px, folding in the chat list, and `shared/poll-commands.ts`
  wired into `classifyComposerDraft`, the completions, `/help` and the
  unknown-command text.
- Add Poll to the design skill's status-bar list.
- Tests:
  - the `/poll` grammar (question split, `|` options, 1 or 6 options
    refused, `end`/`cancel`, `//poll` escapes);
  - the folding predicate (window edges, owner, paid, wrong option count);
  - the popover's state view model.
- **Done when**: the tests pass and `probe:comments-window` passes at 320–1280
  px (UI-only, it may run here). Look at the popover by eye in **light and
  dark**. Commit.

### S6: Scene page, `opus-4.8`

- Make sure the Poll item shows in the Scene canvas and inspector, with the
  sample stand-in card and the "Appears in" switches.
- Update `layout-tab` copy for the new item, and update the Go Live sheet's
  overlay notice sentence where it lists items.
- **Done when**: the tests in `components/scene/overlay-stage.test.ts`, the
  layout tab and the go-live-dialog labels pass. By eye in both themes. Commit.

### S7: Fake chat scripted text, `smoke:polls` and docs, `gpt-5.5`

- `FakeChatConfig` gains `texts: Option<Vec<String>>`, cycled per message,
  and `fake_message_for` (`live_chat.rs:3960`) uses it when set. This is
  test-only behaviour and the default text is unchanged.
- `scripts/smoke-polls-app.mjs` + `package.json` `smoke:polls`, modelled on
  `smoke:comment-highlight-stream` and `smoke:banners`:
  1. Go live with fake YouTube, Twitch, Kick and X lanes.
  2. Start a poll through the relay.
  3. Script the chat: votes from all four platforms, a re-vote, an owner
     `1`, a deleted vote, a pre-open `1` (backlog), a vote inside the grace,
     a vote after the grace, a paid vote, and `1 lol` (not a vote).
  4. Assert the final tally and `byPlatform`, the start and result send
     operations, the card pixels on the recording and on the horizontal and
     vertical receivers (the vertical one only when its leg has a counted
     chat; add one run without), and the card cleared after `RESULT_HOLD`.
- Add `smoke:polls` to `scripts/lib/recording-studio-gates.mjs`.
- Docs:
  - `docs/polls.md` (new, `docs/banners.md` shape: "Using it", then "For
    developers");
  - `docs/overlays.md` (the item, z order, legs, availability);
  - `docs/session-markers.md` (the composer commands list);
  - `docs/ui-copy.md` (the new strings);
  - the `CONTEXT.md` glossary entry **Poll**.
- **Done when**: `node --check` passes on the smoke and the docs are
  re-read. The smoke runs in S10. Commit.

## Slices: Phase 2 (same PR, after Phase 1 is written)

### S8: Buddy voice, `gpt-5.5`

- Follow the banner voice recipe (`d06eaf17`): `CommandKind` variants,
  vocabulary, the parser before the highlight grammar, runners calling the
  same poll engine functions as the RPCs, the TS `CohostCommandKind` and
  the Buddy tab help.
- Add to the docs: `docs/buddy-commands.md` and
  `docs/buddy-commands-contract.md`.
- Add parser tests: two options, three options with commas, "or" inside a
  phrase, one option refused, six refused, end/cancel/show.
- **Done when**: the TS tests pass and the Rust parser tests are written.
  `smoke:buddy-commands` gains a poll case and runs in S10. Commit.

### S9: ⌘K, Stream Deck and phone, `gpt-5.5`

- Add `RemoteIntent` variants (`pollEnd`, `pollReshow`) with their own
  debounce bucket, `executeRemoteIntent` cases, the ⌘K Poll group, Stream
  Deck actions plus `manifest.json`, the phone button plus the read-only
  tally, and the `LAN_EVENTS` entry with the leak argument in
  `docs/remote-control.md`.
- **Done when**: the TS tests pass. `smoke:remote-control` and
  `smoke:remote-lan` run in S10. Commit.

## S10: Gates (once, at the end)

1. `pnpm typecheck`, `pnpm lint`, `pnpm format:check`.
2. `pnpm --filter @videorc/desktop test` and `pnpm test:scripts`.
3. `cargo fmt --check --all`, `cargo clippy -p videorc-backend -- -D warnings`
   and `cargo test -p videorc-backend`. If the owner's targeted-tests
   directive applies, use `polls overlay_layout compositor captions
   cohost_command live_chat remote_control` instead of the full suite.
4. Run `cargo build --release -p videorc-backend` (cfg gaps).
5. `pnpm smoke:polls`, `pnpm smoke:comment-highlight-stream`,
   `pnpm smoke:banners`, `pnpm smoke:live-chat-fake-providers`,
   `pnpm smoke:buddy-commands`, `pnpm smoke:remote-control`,
   `pnpm smoke:remote-lan`, `pnpm probe:comments-window` and
   `pnpm probe:preview-lifecycle`. Then `pnpm smoke:recording-studio` on a
   quiet host. If heavy smokes run back to back, re-run a
   `probe:preview-lifecycle` failure before calling it real; it is a known
   flake after heavy smokes.
6. Windows CI: the D3D11 stacking fixture and the Windows source gates.
7. Leave the PR in draft. Hand over by-eye checks for the owner: a real
   multistream poll in both themes, plus the vertical leg.

## Out of scope

- The platforms' native polls (Twitch Polls API, YouTube polls) and Twitch
  predictions. Votes are chat numbers only.
- Cross-platform identity: one person on two platforms gets two votes (D11).
- Reading the vertical YouTube broadcast's chat (D13; plan 094).
- Filtering Twitch Shared Chat partners: their chatters count today.
- Several polls at once, weighted votes, or votes by bits, points or tips.
- Poll history in the Library, an Activity row, and a stream recap (a later
  idea).
- Chat from TikTok, Instagram and custom destinations.
- A fade or animated bars; the card on the proof surface; the Buddy's gaze
  toward the poll.

## STOP conditions

- The drift check shows a behaviour change in `try_deliver_messages`, the
  overlay slots, `buddy_overlay.rs` or the compositor's push sites.
- The vote hook seems to need an `await`, a DB write or a network call
  inside the delivery fence.
- Adding `poll` to `OverlayLayout` cannot be done without a stored-layout
  reset, on either side.
- Metal and CPU parity is worse than ±2 per channel, or a poll card uploads
  more than once per revision.
- D3D11 needs a new shader or pipeline stage, not just a layer.
- Anything requires changing `LiveChatMessage`'s wire shape or the
  `live_chat_messages` table.
- A smoke shows a backlog or pre-open `1` being counted.
- Any step would put a control beside Record/Go Live in Studio, or change a
  chat row's click (it puts the message on stream).

## Performance budget

| Thing | Budget |
| --- | --- |
| Vote hook per delivery | O(messages), under a std mutex, no I/O; 10k messages < 5 ms (unit test) |
| `polls.status` events | ≤ 1/s for tallies, plus state changes |
| Card raster | ≤ 1 paint + encode per target per second (2 targets → ≤ 2 worker encodes/s) |
| Backend decode | ≤ 2 `spawn_blocking` decodes/s |
| GPU | ≤ 1 Metal/D3D11 upload per revision per leg; texture size constant for a poll |
| Chat posts | 2 sends per poll; YouTube 100 quota units |
| DB | 1 `polls` row write at open, then a checkpoint ≤ every 5 s, then final |

## In-flight work on these files

- **PR #694** (clips, open): it touches the Stream Manager status bar
  (Clip), the composer (`/clip`) and voice. Whichever merges second rebases;
  the conflicts are list entries.
- **Plan 187** (Discord, branch `plan-187-discord-go-live`): it touches
  `main.rs` (the RPC registry and dispatch), `storage.rs` migrations and
  the session-start hooks. Expect conflicts in the method lists and the
  migration numbers, and renumber on rebase.
- **Desktop #727** (cloud version): never merged, so ignore it.

## Model lane note

- S1 and S3 are `fable-5`, because they are the two places where a subtle
  bug costs a live stream: a stalled chat funnel, or a broken picture.
- Card, popover and Scene work is `opus-4.8` with the design skill loaded.
- The rest is `gpt-5.5`.
- Never Haiku.

## As built

_(empty until executed)_
