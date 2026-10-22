# Polls

A poll asks your viewers one question with two to five answers. They vote
by typing the answer's number in **any** chat Videorc reads (YouTube,
Twitch, Kick and X), and every vote lands in one tally (plan 188). The
platforms' own polls only see their own viewers. Polls are free for
everyone.

## Using it

- **Start** while you're live: Stream Manager's **Poll** button (bottom
  bar, after Banners) opens a small form: the question (up to 60
  characters), two to five answers (up to 25 each), a duration (1 min,
  2 min, 5 min or No timer) and **Post in chat**. Or type
  `/poll Tabs or spaces? Tabs | Spaces` in the chat composer: the question
  ends at the first `?` and the answers are split on `|`. `/poll` alone
  opens the form; `/poll end` and `/poll cancel` act on the running poll.
  Videorc remembers your last duration and Post in chat setting.
- **Voting**: a message that is only a number (`1`, `2`, …, or the keycap
  emoji `1️⃣`) counts as a vote while the poll is open. Anything else is
  chat. Each viewer gets one vote per platform and their **last** vote
  counts, so typing a different number moves it. Deleting a vote message
  takes the vote back. Your own messages never count. Someone watching on
  two platforms can vote once on each.
- **Your chat stays readable**: messages that are only a vote are folded
  into the poll instead of filling the Stream Manager chat list. Super
  Chats and other paid messages always show (and still count). The
  Library keeps every message.
- **In chat**: with **Post in chat** on, Videorc posts the poll in every
  chat as you ("Poll: Tabs or spaces? Type 1 for Tabs, 2 for Spaces.") and
  the result when it ends ("Poll result: Tabs wins with 62% of 84 votes.").
  A cancelled poll or one with no votes posts no result. On YouTube each
  post uses 50 units of the daily quota.
- **On stream**: the poll card shows on the picture as soon as the poll
  opens, with a bar per answer that updates once a second and the time
  left. Move it on the Scene page (it starts top left; top centre on a
  vertical stream). It draws over captions and the Buddy and under a chat
  message you put on stream. Its **Appears in** switches (Stream,
  Recording) work like the other on-stream items
  ([overlays.md](overlays.md)).
- **The end**: when the time runs out (or you press **End now**), the card
  says "Counting last votes…" for 15 seconds. YouTube viewers see your
  stream 10–20 seconds late, so their last-second votes still count. The
  winner then shows for 15 seconds and the card disappears. **Show result
  again** brings it back for another 15 seconds. **Cancel poll** discards
  the votes and shows nothing.
- **Stream Manager** shows the live tally, the votes per platform and,
  only when something is wrong, why: a platform whose chat is paused (for
  example YouTube waiting on its quota), a post that couldn't reach a chat,
  vertical viewers who can't vote yet (Videorc doesn't read the vertical
  YouTube broadcast's chat), or a 4K 60 fps stream that can't draw the card
  (the poll still runs in chat).
- **Hands-free** (Phase 2): "Buddy, start a poll: tabs or spaces",
  "Buddy, end the poll", "Buddy, cancel the poll" and "Buddy, show the poll
  result" (Premium, like every Buddy voice command); ⌘K's Poll group; a
  Stream Deck **End poll** / **Show result again** key; and the phone
  remote.
- One poll at a time. A new poll can start once the last one has ended.

## For developers

### Engine and wire

- `crates/videorc-backend/src/polls.rs` owns the state machine
  (`open → counting → final`, or `cancelled`), the ballots, the poll task
  (timers, coalesced `polls.status` events, checkpoints, chat posts) and the
  wire types. The wire shape is pinned by the `poll` key of
  `protocol-fixtures/high-risk-contracts.json`; optional fields are
  omitted, never `null` (`polls.status`'s `poll: null` is the one
  deliberate null).
- **Vote grammar**: `classify_vote` and its TS twin `shared/poll-votes.ts`
  both run `protocol-fixtures/poll-votes.json`. The Stream Manager uses the
  twin to fold votes; the backend's tally is the only count.
- **The hook**: `live_chat::try_deliver_messages`, right after the cohost
  call, hands every authoritative message to `polls::note_messages`. It is
  in-memory under a std mutex with no `.await`, DB or network; with no
  poll open it costs one atomic load.
- **Ballots**: keyed by `(platform, author_id)` (the display name when
  YouTube omits the id); the latest `published_at` wins; a tombstone
  removes the voter's current ballot; `owner` rows never count; only
  Message and Paid events count. A vote counts when it arrived after the
  poll opened, its platform time is no earlier than 10 s before the open
  (YouTube backlog pages and pre-poll "1"s are ignored), and no later than
  `acceptUntil` (`endedAt` + 15 s).
- **Timings**: late-vote grace 15 s, final 25 s after the end, result
  shown 15 s, events coalesced to 1/s, checkpoints every 5 s. A session
  end finalizes at once with no result post. A poll that was open or
  counting when Videorc quit is marked interrupted at the next launch.
- **RPCs** (general lane): `polls.start`, `polls.end`, `polls.cancel`,
  `polls.reshow`, `polls.current`, and `polls.overlay.set` /
  `polls.overlay.clear` for the card.
- **Storage**: the `polls` table (question, options, timings, status and
  the last tally as JSON). Ballots live in memory only.

### The card

- The Studio renderer paints it (`renderer/src/lib/poll-card.ts`) at a
  pixel size fixed for the whole poll and pushes it per output target
  through `polls.overlay.set { pollId, pngBase64, target, rect }`, like the
  Buddy bubble. The backend owns visibility: it refuses a push for a card
  that isn't showing and clears `AppState.poll_overlay` itself when the
  card hides, the poll is cancelled or the session ends.
- Placement is the `poll` item of the overlay layout (`OverlayItem::Poll`);
  a stored layout without it loads with its other placements intact.
- See [overlays.md](overlays.md) for the z order, the Metal namespace and
  the paths that can't draw it.

### Stream Manager

- The Poll button and popover live in `components/stream-manager/`; the
  window reaches the backend through the `comments-window:poll*` relay
  (window → main → Studio), like banners.
- `/poll` is `shared/poll-commands.ts`, wired into `classifyComposerDraft`.

### Tests

- Rust: `cargo test -p videorc-backend polls`, plus `overlay_layout` and
  the compositor parity tests.
- TypeScript: `poll-votes.test.ts`, `protocol-contract-fixtures.test.ts`,
  and the poll card, popover and command tests.
- App: `pnpm smoke:polls` (fake YouTube, Twitch, Kick and X chat; tally,
  posts and card pixels on the recording and both stream legs).
