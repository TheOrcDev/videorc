# Plan 225: Know your viewers across platforms

> **Executor instructions**: read `AGENTS.md`, the `videorc-design` skill,
> plan 183 (`plans/183-buddy-remembers-your-regulars.md`, the parked
> starting point this plan replaces where it says so) and this whole plan
> first. Desktop work: your own worktree from `origin/main`. Web work: your
> own worktree of `~/projects/videorcweb` from `origin/main`; never read its
> `.env`. Write and commit every slice of a phase first, then run Rust and
> the smokes once at the end of the phase (owner feedback "Gates at the
> end"). Check every UI in light AND dark. Buddy never posts to chat on its
> own: nothing in this plan sends a chat message. Never go live on a real
> channel unless the owner asks for it in the session. Do not start Phase F
> or G before the owner has answered Open questions 3 and 10.

**Drift check** (run before any slice; a non-empty diff means re-read the
"What exists" facts for the files that moved):

```sh
git -C ~/projects/videorc fetch -q origin && git -C ~/projects/videorc diff --stat d00550ea1 origin/main -- \
  crates/videorc-backend/src/live_chat.rs crates/videorc-backend/src/storage.rs \
  crates/videorc-backend/src/cohost.rs crates/videorc-backend/src/cohost_ack.rs \
  crates/videorc-backend/src/cohost_greetings.rs crates/videorc-backend/src/cohost_auto_chat.rs \
  crates/videorc-backend/src/cohost_throttle.rs crates/videorc-backend/src/protocol.rs \
  apps/desktop/src/shared/backend.ts apps/desktop/src/shared/backend-rpc-contract.ts \
  apps/desktop/src/renderer/src/components/comment-row.tsx \
  apps/desktop/src/renderer/src/components/cohost-pane.tsx \
  apps/desktop/src/renderer/src/components/tabs/buddy-tab.tsx \
  apps/desktop/src/renderer/src/lib/buddy-tabs.ts \
  apps/desktop/src/renderer/src/components/buddy-report-card.tsx \
  apps/desktop/src/renderer/src/lib/buddy-report-view.ts
```

## Status

- **Status**: PLANNED 2026-11-08. Nothing is built. Plan 183 was parked on
  2026-10-16 with 9 open questions; this plan answers them (Open questions)
  and adds what 183 lacked: one person across platforms, where the data may
  live, and the free/Premium split for a Premium worth paying for.
- **Priority**: P1 (owner, 2026-11-08: "plan out thoroughly first 5 things
  you recommended"; this is thing 5).
- **Effort**: XL. Desktop: a local community store with linking, chat-row
  facts, four UI surfaces, the report. Web: one memory route, two additive
  schema changes, one opaque sync store.
- **Risk**: MEDIUM-HIGH.
  - Product risk: low. Everything is additive, and every off path stays as
    it is. Chat delivery never waits on the new store (D14).
  - Terms and privacy risk: real. This keeps data about viewers over time
    and, for the first time, links one person's accounts. The rules per
    platform are in Outside facts, and the design follows them (D3, D5,
    D6). A legal read (H4) happens before release.
- **Planned at**:
  - desktop `origin/main` `d00550ea1` (fetched 2026-11-08);
  - web `origin/main` `3c8d1593` (2026-11-05), where the greet route and
    tick v4 live; the plan 185 branch `plan-185-max-and-cloud` `5a75d03d`
    for the tier wire;
  - plan 183 at `3d16f3dc` (2026-10-15), refreshed here.
- **Route**: Orchestrator (fit 10, `fable-5.1`).
  - Phases A, B, F and G: Implementation (fit 8) on `fable-5.1`. They are
    multi-system, privacy-sensitive, and touch chat delivery.
  - Phases C, D and E: UI/Product Design (fit 9) on `opus-5.5` with the
    `videorc-design` skill.
  - Phase H: Orchestrator; H4 is the owner's.
  - Mechanical fixture and docs slices (A6, H3): `gpt-6.1-sol`.

## The owner's ask

2026-10-15 (plan 183): "Our AI buddy is able to know who was on previous
live streams and to remember some things so we can make some special
gestures for our old live streamers that are here often." Then: "Yes plan it
out properly. We can make this one really exciting for our users".

2026-11-08: the owner picked "Know your viewers across platforms" as the
fifth of five features that make Premium worth paying for, and asked for a
thorough plan. The orchestrator's brief adds: one profile per person across
YouTube, Twitch, Kick and X; it shows the moment they chat ("first time
here", "back after 3 weeks", "regular, 14 streams", "asked about Rust
lifetimes last stream", the platforms they're linked on); a history and a
post-stream view ("12 regulars came back, 3 first-timers stayed 40+
minutes"); a free layer and a Premium layer.

## What a streamer gets

In one line: **Videorc knows who is in your chat, whatever platform they
came from, and Buddy (Premium) remembers what they told it.**

1. **Ada says "hi!!" on Twitch.** Her row carries one quiet chip,
   "Regular · 14". Buddy waves on stream and its bubble says "Welcome back,
   Ada!". The Stream Manager's Buddy pane lists her under "Welcome back".
2. **The streamer opens Ada's card** from the row's ⋯ ("About Ada") or a
   right-click. It says: "14 streams · since March 2026 · 5 in a row · 812
   messages", "Twitch · YouTube" (her two linked accounts), "4,500 bits",
   and under "Buddy remembers" (Premium): "Learning Rust; asked about
   lifetimes last stream".
3. **Ada chats on YouTube next week as `ada_dev`.** Because she linked the
   two accounts herself (she typed `!link pixel42` in both chats, 20 seconds
   apart, last month), the row still says "Regular · 15", not "First chat".
4. **Bo comes back after three weeks.** His chip says "Back · 3 wk", and the
   bubble says "Look who's back! Good to see you, Bo." With Premium, Buddy's
   AI welcome can say "Welcome back, Bo! Did the borrow checker win?".
5. **Kim's 10th stream.** Buddy's excited reaction, "Kim's 10th stream with
   us! Thank you!", and a milestone card the streamer can put on stream.
6. **"Might be the same person."** Community shows `MaxPlays` on Kick and
   `maxplays` on Twitch side by side with "Same person" and "Not the same".
   Videorc never merges on its own.
7. **A wrong merge costs a click.** "Not the same person" splits them, and
   every count comes back from the per-account history.
8. **Viewers stay in control.** `!forgetme` deletes them on the spot;
   `!rememberme` undoes it; `!unlink` undoes a link.
9. **After the stream**, Reports adds a Community block: "12 regulars came
   back · 3 first-timers stayed 40+ min · 2 comebacks · Kim reached 10
   streams". Premium adds two sentences Buddy wrote about the audience.
10. **Premium: sync.** The same community on the streamer's laptop and
    desktop, through an encrypted backup Videorc's servers cannot read
    (D5, ⚑; YouTube accounts stay out until the compliance promise says
    otherwise).

## Words we use

| Word | Meaning |
| --- | --- |
| **Account** | One identity on one platform: `<platform>:<author_id>`. What plan 183 called a viewer. |
| **Person** | One or more accounts that belong to the same human. Every account belongs to exactly one person; most people have one account. |
| **Link** | Joining two accounts into one person. By the viewer (`!link`), by the streamer ("Same person as…"), never by Videorc alone. |
| **Suggestion** | "Might be the same person": two accounts with the same name on different platforms, waiting for the streamer. |
| **Arrival** | A person's first chat message of a stream. The only row that carries a chip. |
| **First chat** | The existing marker (plan 055): an account no earlier session saw. Unchanged. |
| **Regular** | A person who chatted in 3 or more streams in the last 90 days (D7). |
| **Back** | A person whose last chat was 30 or more days ago (D7). UI: "Back · 3 wk". |
| **Milestone** | Their 5th, 10th, 25th… stream, N in a row, or a yearly anniversary (D8). |
| **Memory** | A short fact Buddy learned from what the person said in public chat (Premium, D10). |
| **Note** | The streamer's own text about a person. Never AI, never overwritten. |
| **Community** | The Buddy page's tab that lists people, settings and the retention text (D12). |
| **Sync** | The Premium encrypted backup of the community store across the streamer's computers (D5). |

Copy never says "viewer profile", "database" or "tracking". It says
"community", "regulars", "people".

## What exists (facts, desktop `origin/main` `d00550ea1`)

### Chat and identity

- **Chat sources with identity** are YouTube, Twitch, Kick and X. Facebook,
  TikTok, Instagram and Custom RTMP report chat as `Unsupported`
  (`live_chat.rs:754-797`; Facebook's reason copy at `live_chat.rs:882`).
  `StreamPlatform` lists all eight (`streaming.rs:18-27`).
- **Every platform gives an author id**: Twitch `chatter_user_id`
  (`twitch_chat.rs:677`), YouTube `authorChannelId`
  (`youtube_chat.rs:893`), Kick `payload.sender.id` (`kick_chat.rs:1484`),
  X `author.id` (`x_chat.rs:911-928`). System rows have none
  (`twitch_chat.rs:630`, `kick_chat.rs:1448`).
- **Kick and X chat arrive through the videorc.com relay** and the desktop
  long-polls it (`kick_chat.rs:3-12`, `x_chat.rs:4-13`). The relay keeps no
  tokens; identity is proven once per bind. YouTube and Twitch are read
  from the computer.
- **Every chat message of every stream is kept on the computer** in
  `live_chat_messages` (`storage.rs:8094-8114`: session, platform,
  `author_id`, name, avatar URL, badges, roles, text, event type). Rows
  cascade with their session. `session_chat_authors` (`storage.rs:8128`)
  counts messages per author per session. Nothing prunes either table; the
  compliance reply says so (`docs/compliance/youtube-tos-report-v1-reply.md:72-73`).
- **First chat and first-in-session.** `mark_first_time_chatters`
  (`live_chat.rs:3580-3660`) runs before ingest, outside every delivery
  fence: one indexed query per batch of fresh authors in `spawn_blocking`
  (`live_chat_returning_authors`, `storage.rs:4268`, chunks of 400). It sets
  `first_message` (first ever) and, since plan 192 S1.2, `first_in_session`
  (`live_chat.rs:440-445`, `#[serde(skip)]`, never on the wire). A database
  error marks nothing. Twitch's own `user_intro` is kept (`twitch_chat.rs:701`).
- **The streamer is excluded** per session by an owner or broadcaster role
  or by the echo of their own send (`cohost_ack.rs:614-640`). Connected
  accounts live in `platform_accounts` (`storage.rs:8228-8243`, one row per
  platform, `account_id`).
- **Bots.** `KNOWN_BOTS` has 9 lowercased names (`cohost_greetings.rs:34-44`:
  nightbot, streamelements, streamlabs, moobot, fossabot, sery_bot, wizebot,
  botrixoficial, kickbot), used by `welcome_facts`
  (`cohost_greetings.rs:406`).
- **No chat bang-commands exist.** Nothing in the backend parses a leading
  `!`. Plan 152's `/marker`, `/sound` and the rest are the streamer's
  composer commands, not viewer commands.

### Buddy

- **Welcomes already exist** (plan 192, built): `CohostWelcomes { first_time,
  returning }` (`cohost.rs:844-851`), both on by default, built-in lines "Hi
  {name}, welcome to the stream!" and "Welcome back, {name}!"
  (`cohost_greetings.rs:137-142`). `welcome_facts` returns facts for
  `first_message` (first-time) or `first_in_session && !first_message`
  (returning), skipping the streamer, bots, deleted rows and names with a
  URL (`cohost_greetings.rs:403-410`). The two welcome kinds live in
  `greetings.welcomes`, **never in `templates[]`**, because an older app
  that meets an unknown template kind loads defaults and then saves them
  over the persona (plan 192 S1.1). The same trap applies to every kind this
  plan adds.
- **Buddy talks: Off · Bubble · Suggest** (`CohostTalkMode`,
  `cohost.rs:641-647`; plan 211). Bubble is the default. Nothing automatic
  reaches chat; Suggest makes a card the streamer clicks to post as
  themself; Off says nothing. Auto is gone. Bubble lines are queued (at
  most 3 waiting, 20 s drop, 0.5 s gap) and trimmed to 200 characters
  (plan 211 D7).
- **AI greetings use their own route**, not the tick: `POST
  /api/ai/cohost/greet` (web `origin/main` `3c8d1593`,
  `lib/ai/cohost-greet.ts`; kinds `first-time`, `returning` and the
  Activity kinds; `fallbackLine`, `firstMessageText` ≤200 chars, 3 s
  budget, usage kind `cohost-greet`). Capabilities report `greet: 1` when a
  user may call it (`lib/ai/cohost-capabilities.ts:30-32, 103`). The tick is
  v4 (`cohost-capabilities.ts:116`); the tick's `firstMessage` prompt still
  says "the author's first message on this stream" (`lib/ai/cohost.ts:195,
  936`), which is the plan 183 E2 wording bug, still open.
- **Say hi.** `cohost.state.sayHi` lists first-timers nobody greeted for
  15 minutes, at most 5 (`SAY_HI_WINDOW`, `SAY_HI_MAX`,
  `cohost_ack.rs:21-22`; TS `CohostSayHi` `backend.ts:7113-7119`;
  `cohost.author.greeted` takes `CohostAuthorParams`). The pane shows it as
  a "Say hi" list with a Greeted button (`cohost-pane.tsx:1022-1075`).
- **Reports.** `CohostSessionReport` (`protocol.rs:6288-6328`) has
  `greetings: CohostReportGreetings` with `first_timers`,
  `first_timers_greeted`, `by_voice`, `by_chat` (`protocol.rs:6069-6079`),
  `posts[]` and `said[]`. The card is `buddy-report-card.tsx` (a "Stream
  report" `PanelSection`, `ReportStats`, "Said on stream" `ListRow`s) and
  the stats come from `buddy-report-view.ts:392-413` ("First-timers
  greeted" `of` first-timers). Reports are kept in `cohost_reports`
  (`storage.rs:8341-8346`), deleted with the session, never uploaded
  (`docs/buddy.md:415-452`).
- **The Buddy page tabs** are Profile (`live`), Chat, Voice, Reports and
  Clean cut (`buddy-tabs.ts:26-32`); `buddy-tab.tsx:144-180` renders one
  `TabsContent` each, Chat as `BuddyChatTab` with a `BuddyUnlockAlert` when
  Premium is missing (`buddy-tab.tsx:237-255`). Buddy is the second sidebar
  row, id `ai`, in the stage zone (`workspace-nav.tsx:57-58`).
- **Free and Premium today** (`docs/buddy.md:219-237`): greetings and
  welcomes with built-in or own lines are free; AI greetings, Answers,
  Banter and the rest of Buddy Live need Premium plus Cloud AI consent.
- **The tier on the wire** is `tier: 'basic' | 'premium' | 'developer'`
  (`backend.ts:85`) and `isPremium` (`backend.ts:4132`). Capabilities carry
  a `cohost` block with `tick?`, `avatar?`, `pet?` (`backend.ts:4102-4115`).
  Plan 185 D2 keeps Max users at `tier: "premium"` and adds `plan` and
  `cloud` blocks. Shipped desktops read only `premium` and `isPremium`.

### Stream Manager and Studio chat

- **A click on a chat row puts it on stream**; the row is one `Button`
  (`comment-row.tsx:1083-1105`, owner call D10), with the avatar, name,
  badges and text inside it (`comment-row.tsx:759-800`). A nested button
  would be invalid HTML, so the avatar cannot be its own control inside the
  row. The ⋯ `KebabMenu` reveals on hover (`comment-row.tsx:1113`) and holds
  Show on stream, Reply, the link items, Copy and Remove from chat
  (`commentRowMenu`, `comment-row.tsx:911-962`). A `ContextMenu` exists
  only on links inside the text (`comment-row.tsx:595-620`).
- **"First chat"** is an outline `Badge` with `SparkleIcon`
  (`comment-row.tsx:782-786`); `@you` is a `Badge` in a `ChipHint`
  (`comment-row.tsx:121`). A row paints at most one background (design
  skill, Stream Manager).
- **The Studio's Chat section** (plan 204) is `StudioChatSection`,
  `StudioChatList`, `StudioChatRow` (`studio/studio-chat.tsx:66, 176, 298`),
  with avatar, name, words and platform mark, nothing else.
- **History** in the Stream Manager window is capped at 2,000 messages or
  8 MB (`comments-history-cache.ts:21-22`).
- **The Stream Manager tiers** are Wide ≥1,040 px, Medium 640 to 1,039,
  Narrow <640 (320 minimum), by container query; the Buddy pane's header,
  "{name} talks" segmented control and footer are described in the design
  skill ("Stream Manager"). `pnpm probe:comments-window` sweeps 320 to 1280.

### UI primitives on main

`ui/` has `badge`, `hover-card`, `popover`, `context-menu`, `dropdown-menu`,
`dialog`, `alert-dialog`, `command`, `tabs`, `toggle-group`, `avatar`,
`scroll-area`, `empty`, `switch`, `select` and `progress`. **There is no
`sheet`**, so plan 183's "Sheet at Narrow" is replaced by a `Dialog` (D11).
`KebabMenuItem` has `id, label, icon?, destructive?, disabled?,
disabledReason?, group?` (`kebab-menu.tsx:20-32`).

### What plan 183 designed and what changed since `3d16f3dc`

| 183 section | Status in 225 |
| --- | --- |
| D1 who Buddy remembers (account key, chat and paid only, streamer excluded, bots) | **Kept**, with the bot list unified on `KNOWN_BOTS` (D1). "Linking is Later" is replaced by D4. |
| D2 what is kept per viewer | **Kept** per account (D2); the person adds a note and links. |
| D3 retention per platform | **Kept**, plus X's 24-hour deletion rule and the sync rules (D3, D5). |
| D4 backfill | **Kept** (D6). |
| D5 regulars, D6 milestones | **Kept** (D7, D8). |
| D7 gestures, D8 greeting kinds | **Replaced**: plan 211 removed Auto and plan 192 moved welcomes out of `templates[]`. New kinds go into `welcomes`, bubble-only in Bubble mode (D9). |
| D9 paced arrival waves | **Kept**, now on plan 211's bubble queue (D9). |
| D10 Stream Manager chips and card | **Replaced** by D11 (card from ⋯ and right-click, Popover/Dialog, linked platforms). |
| D11 Community tab | **Kept** with new sections for links and suggestions (D12). |
| D12 `!forgetme` | **Kept**; Buddy's reply is bubble-only, never chat (D13). |
| D13, D14 Buddy remembers, memory rules | **Kept** (D10); memories attach to the person and record their source account. |
| D15 tick v5 | **Replaced**: AI welcomes ride the greet route, not the tick; the tick gets `viewers` for answers and banter (D10, Wire shape). |
| D16 voice | **Kept** (B5). |
| D17 report | **Replaced** by D15 (adds "stayed", linked platforms, the Premium summary). |
| D18 telling people | **Kept**, extended for links and sync (H2). |
| D19 free and Premium | **Replaced** by D6. |
| D20 pull requests | **Replaced** by D16 (#79 merged long ago). |
| D21 never slow chat down | **Kept** (D14). |
| Wire shape | **Replaced** below. |
| Phases A to F | **Replaced** by Phases A to H below. 225 stands alone. |

Also changed on main since 183: watch streaks (plan 151) and Activity reward
rows (plans 156, 162, 163, 177) exist as Activity kinds and never count as
attendance; plan 189's soundboard added `/sound` to the Stream Manager;
plan 188 (polls) is not on main; plan 182's takeovers are built as a draft
PR; plan 215 G (chat on stream) is planned, not built.

## Outside facts (checked 2026-11-08)

These shape the design. They are not legal advice; H4 asks for a legal read
before release.

- **YouTube API Services Developer Policies**
  (<https://developers.google.com/youtube/terms/developer-policies>),
  section III.E.4: (c) "all other types of Authorized Data" may be stored
  "for no longer than 30 calendar days", after which "the API Client must
  either delete or refresh the stored data"; (d) Non-Authorized Data the
  same, "not longer than 30 calendar days"; (g) "must provide a way for a
  user to request that you delete stored data related to that user" and
  then "within 7 calendar days"; (h) must not "access or use API Data to
  create new or derived data or metrics", and non-YouTube metrics shown
  beside API Data need "a clear and prominent disclosure" that they are not
  from YouTube. III.E.2.a: aggregate only "YouTube channels under the same
  content owner", viewable only by that owner. III.L (new, from 2026-06-01):
  audited developers may apply for permission "to create additional
  metrics, store statistical data, or both".
- **Videorc's own compliance reply**
  (`docs/compliance/youtube-tos-report-v1-reply.md:44-45`): "All YouTube
  API calls go directly from the user's computer to Google. No Videorc
  server proxies them." Chat "stay[s] on the user's computer". Any sync of
  YouTube-derived rows to videorc.com contradicts this until the owner
  updates the reply (D5).
- **Twitch Developer Services Agreement**
  (<https://legal.twitch.com/en/legal/developer-agreement/>). The page body
  did not render in two fetches, so this is **UNVERIFIED first-hand**; the
  wording comes from the search index of the page: "You must only retain
  chat logs as long as necessary for the operation of Your Services or to
  improve Your Services; do not do so for the purpose of creating public
  databases or websites, or, in general, to collect information about
  Twitch's end users." and "You must enable, and process, all requests by
  end users to block, discontinue, delete, or otherwise opt-out of any
  retention of chat logs for Your Services." Section F: delete all Twitch
  Data "upon termination of this Agreement, revocation, or reduction in
  scope of end user authorization, or upon Twitch's or the end user's
  request". H4 reads it first-hand in a browser.
- **Kick Developer Services Agreement**
  (<https://dev.kick.com/terms-of-service>), Schedule 1 §D.2, word for word
  the Twitch clause: "You must only retain chat logs as long as necessary
  for the operation of Your Services or to improve Your Services", not "to
  collect information about Kick's end users", and you must process "all
  requests by end users to block, discontinue, delete, or otherwise opt-out
  of any retention of chat logs". §5: Kick Data "including any insights
  derived from that data" may not be shared with third parties; delete it
  "upon termination of this Agreement, revocation, or reduction in scope of
  end user authorization" or "upon Kick's or the end user's request".
  Schedule 1 §C: "follow end user controls, consent, and permissions when
  deciding whether to store an end user's data"; profile data cached from
  the API "for only a twenty-four hour time period". No last-modified date
  is shown.
- **X Developer Policy** (<https://docs.x.com/developer-terms/policy>; the
  page returned HTTP 402 to this tool, so the quotes come from the search
  index and
  <https://docs.x.com/developer-terms/restricted-use-cases>, **UNVERIFIED
  first-hand**). "Off-X matching" means "associating X Content, including
  an X @handle or user ID, with a person, household, device, browser, or
  other off-X identifier"; without "express, opt-in consent" of the person
  it may rest only on information they "would reasonably expect to be used
  for that purpose", and: "If a user would be surprised to learn that you
  are using information they provided to link their X account to an
  identity off of X, don't do it." Content stored offline must be deleted
  or modified when it is on X "within 24 hours after receiving a request"
  from X or the account owner (Developer Guidelines table). **Design
  consequence (D4):** an X account is linked only by the viewer's own
  `!link`; the streamer's manual merge and Videorc's suggestions never
  touch X accounts.
- **GDPR** (<https://gdpr-info.eu/art-17-gdpr/>,
  <https://gdpr-info.eu/art-21-gdpr/>). Article 17(1): the controller
  "shall have the obligation to erase personal data without undue delay"
  when, among others, "the personal data are no longer necessary" (a) or
  the person objects (c). Article 21(1): "the right to object … at any
  time" to processing based on legitimate interest, after which "the
  controller shall no longer process the personal data" unless it shows
  "compelling legitimate grounds". The streamer is the controller of their
  community data; Videorc is the tool (and, for sync, a processor that
  cannot read the data, D5). What follows: a stated purpose, minimal data,
  a retention limit, deletion on request (`!forgetme`, within the session),
  and telling viewers (H2).

## Decisions (⚑ = owner may override)

### D1. Accounts and people

- **An account** is `<platform>:<author_id>`, as `chatter_key` builds it
  (`live_chat.rs:3565`). A row without an author id is never counted;
  neither are Custom RTMP rows, system rows, or Activity rows.
- **A person** owns one or more accounts. Every account belongs to exactly
  one person; a new account gets a new person. Counts shown anywhere
  (streams, messages, in a row, regular, back, milestones) are the
  **person's**, computed over the union of its accounts' attendance.
- **Only chat and paid messages count** as attendance
  (`counts_as_chatter`, `live_chat.rs:3573-3578`). Follows, subs, tips,
  raids, watch streaks, Power-ups and redemptions add to the person's
  support totals and never to attendance.
- **The streamer is never a person**: the `account_id` of each
  `platform_accounts` row, owner or broadcaster roles, and the echo of
  their own send (`cohost_ack.rs:614-640`).
- **Bots.** One list, `KNOWN_BOTS` (`cohost_greetings.rs:34-44`), extended
  with botisimo, phantombot, kofistreambot, soundalerts and
  pokemoncommunitygame from plan 183. A bot account's person has status
  `bot`; the streamer can mark or unmark any person.

### D2. What is kept, on this computer, without AI

Per **account**: platform, author id, the latest display name and avatar
URL (**never a name history**: Twitch Legal named caching username
changes), first and last chat time, status. Per **person**: the accounts,
streams chatted in, messages, in a row and best in a row, support totals
(bits, KICKs, gifted subs, sub months, tips by currency), milestones
celebrated, the streamer's note (≤300 characters), status (normal, bot,
forgotten), and (Premium) memories. Each stream is `(session id, start
time, platforms reached)`, so "in a row" counts only streams that reached
one of the person's platforms.

### D3. How long it is kept, per platform ⚑

- **YouTube accounts: 30 days, rolling.** Attendance, counts, milestones
  and memories derived from a YouTube account older than 30 days are
  deleted or recomputed daily and at app start (III.E.4.c, d). "First
  seen" never reaches back more than 30 days and YouTube gets no
  anniversary. Memories learned from YouTube messages are **off** until
  H4 clears derived data (III.E.4.h). The UI says: "YouTube viewers are
  remembered for 30 days after they chat (YouTube's rules)."
- **Twitch, Kick and X accounts:** everything is forgotten 12 months after
  the account's last chat. This is "as long as necessary" for greeting
  regulars; the number is the owner's.
- **A linked person** keeps each account's own clock. When Ada's YouTube
  account passes 30 days, its attendance leaves the union and her Twitch
  attendance stays. Her person survives while any account does.
- **X deletions.** A message X later deletes is already handled for chat
  (plan 167); a person's memory never quotes a message, so nothing more is
  stored per message. `!forgetme` from an X account completes within the
  session, well inside 24 hours.
- **Recordings.** Community data outlives recordings: deleting a recording
  frees disk space and never deletes community data, which has its own
  controls (D13). The privacy page says so (H2).

### D4. Linking one person across platforms

Platforms never share identity, so three ways exist, in this order of
trust:

- **(b) The viewer links themself: `!link <word>`.** The viewer types
  `!link` followed by one word they choose (4 to 24 letters, digits, `-`
  or `_`), in the chat of platform A, then the same `!link <word>` in the
  chat of platform B, **within 10 minutes**. Videorc, on the computer, joins
  the two accounts into one person. Rules:
  - Exactly two accounts on **two different platforms** with the same word
    inside the window link. A third account typing the same word, or two
    accounts on the same platform, cancels the word: nothing links, and
    Community lists the attempt under "Links that need you" for the
    streamer to settle by hand.
  - Nothing is posted to chat. In Bubble mode Buddy's bubble says "Linked:
    Ada on Twitch and YouTube." (talk mode permitting, through the plan 211
    queue); in Suggest or Off nothing is said. The Stream Manager shows a
    `BuddyCard` "Linked Ada (Twitch) and ada_dev (YouTube)" with **Undo**
    for 15 minutes.
  - The word is public in both chats, so a hijack is possible for the
    seconds between the two messages. The cost is a wrong, reversible
    merge (below), and the real viewer's `!unlink` or the streamer's "Not
    the same person" undoes it. A word is single-use: once linked or
    cancelled it is gone. Pending words live in memory only and die with
    the session.
  - `!link` needs no Videorc post, no videorc.com page and no viewer
    account. **This is the only way an X account is ever linked** (Outside
    facts, X off-X matching: the viewer's own two messages are their
    express, opt-in consent).
  - Why not a code shown on stream: every viewer sees the same code, so it
    identifies nobody. Why not a videorc.com page where the viewer signs in
    with both platforms: it needs viewer-facing OAuth on our servers and a
    web product for viewers; it is "Later".
- **(a) The streamer merges by hand.** "Same person as…" on a person's
  card and in Community opens a `Command` search over people (name,
  platform); picking one and confirming ("Treat MaxPlays (Kick) and
  maxplays (Twitch) as one person?" with **Same person** and Cancel) links
  them. X accounts are not offered and show "X viewers link themselves with
  !link" as the disabled reason.
- **(c) Videorc suggests, never merges.** Two accounts on different
  platforms whose names are equal after lowercasing and dropping spaces,
  `_`, `.` and `-` get an open suggestion ("Might be the same person").
  Suggestions never involve X accounts, never show on a chat row, and
  never change a count. The streamer sees them in Community and on the
  card ("Might be the same as maxplays on Twitch · Same person · Not the
  same"). "Not the same" dismisses the pair for good. Avatar matching is
  "Later": avatars come from different CDNs, a perceptual hash is work the
  first cut does not need, and a name match already covers the common
  case.
- **Unlinking.** "Not the same person" on the card (or `!unlink` from the
  viewer, which splits their own account off) moves the account into a new
  person. Attendance and support are per account, so every count comes
  back exactly. **What a wrong merge costs**: while merged, the chip, the
  welcome and the milestone used the union (a "Regular · 15" that should
  have been two people); milestones celebrated during the merge are not
  un-celebrated; memories go back to the account whose message taught them
  (each memory records its source account); the streamer's note stays with
  the person that keeps the older account, and the split-off person starts
  with an empty note. The link history (`community_link_events`) keeps who
  linked what and when, so the streamer can see it.

### D5. Where the data lives ⚑

- **The computer is the truth.** The store is local SQLite, as in plan 183.
  Nothing about a viewer reaches videorc.com except the Premium memory pass
  (D10), the tick and greet context (D10), and sync below.
- **Premium: Community sync, end-to-end encrypted** (Phase G).
  - The desktop encrypts an export of the store (people, accounts,
    attendance, memories, notes, link events) with a key kept in the OS
    keychain and uploads it as one opaque blob (≤8 MB) to
    `PUT /api/desktop/community-sync`. Videorc's servers store bytes they
    cannot read: no viewer name, no account id, nothing searchable.
  - A second computer gets the key through a one-time pairing code shown
    in Community → Settings (6 words, 10 minutes), the same shape plan 184
    uses for the phone. Without the key the blob is useless, which is the
    point.
  - Merge: account and person rows last-writer-wins by `updated_at`;
    attendance rows are a union; a `forgotten` tombstone wins over
    everything and propagates, so a `!forgetme` on one computer forgets on
    all.
  - **YouTube accounts stay out of the blob** until the owner updates the
    compliance reply, which today promises that chat "stay[s] on the
    user's computer". They are excluded at export, and the UI says
    "YouTube viewers are not synced (YouTube's rules)." ⚑
  - Twitch, Kick and X rows are retention-limited (D3) and deletable on
    request (D13), and the server cannot read them, so the Twitch and Kick
    chat-log clauses and X's deletion rule are met by the desktop alone.
    GDPR: the streamer stays the controller; Videorc is a processor of
    ciphertext, and the privacy page says so (H2).
  - Why not server-side readable sync: it would make Videorc a holder of
    viewer data at rest across every platform, add a data processing
    agreement per streamer, and conflict with the YouTube promise for no
    product gain. Why not a free export file instead of sync: a free
    `Export…`/`Import…` in Community → Settings **is** included (D-5), so
    the free tier can move computers by hand; sync is the server-backed
    convenience Premium sells.
- Recommended: yes to sync as above, shipped last (Phase G), and cut
  without harm if the owner says no.

### D6. Free and Premium ⚑

Premium sells only server-backed and AI features (owner rule). Name
matching is local, so suggestions are free, not Premium.

- **Free:** the store, backfill, first-timer, "Back" and "Regular" chips,
  in a row, milestones and milestone cards, the welcome bubbles (regular,
  comeback, milestone), the person card, Community (list, search, filters,
  settings, retention text), manual merge, `!link`, suggestions, `!forgetme`
  and `!unlink`, the note, the report's Community counts ("12 regulars came
  back · 3 first-timers stayed 40+ min"), and Export/Import.
- **Premium (Buddy Live + Cloud AI consent):** "Buddy remembers" (the memory
  pass and the memories on the card: "asked about Rust lifetimes last
  stream"), AI welcomes and Buddy's drafts that use memory (greet route and
  tick context), the report's written audience summary (two sentences from
  the memory pass), and Community sync (D5).
- Why: the free layer is the hook every streamer feels next stream, as in
  183 D19; the Premium layer is exactly what needs a server or a model.

### D7. Regulars and Back ⚑

- A **regular** chatted in at least **3** different streams in the last
  **90** days (YouTube accounts: 30 days). The streamer can set 2 to 10 in
  Community → Settings.
- **Back**: the person's last chat was **30** or more days ago. Never on a
  YouTube-only person (its data is at most 30 days old). Copy: chip
  "Back · 3 wk" (weeks under 8, then months: "Back · 3 mo"); card "Back
  after 3 weeks".
- "First time here" is the existing First chat (unchanged); for a linked
  person it shows only if **no** account was seen before.

### D8. Milestones ⚑

- **Streams:** 5, 10, 25, 50, 100, 250, 500. **In a row:** 3, 5, 10, 20
  ("in a row", never "streak", which is Twitch's own word). **Anniversary:**
  one year since the first chat, within 7 days after the date, once a year,
  never on a YouTube-only person.
- Each milestone is celebrated once per person. When two land together the
  biggest wins. A merge never re-celebrates one already celebrated by
  either side.

### D9. Gestures on stream, re-fitted to plans 192 and 211

- **Three new welcome lines** in `greetings.welcomes` (never in
  `templates[]`, plan 192 S1.1): `regular`, `comeback`, `milestone`, each a
  `WelcomeLine { enabled, text?, state?, reaction? }` with serde defaults.
  Built-in lines:

  | Kind | When | Built-in line |
  | --- | --- | --- |
  | `regular` | a regular's arrival | "Welcome back, {name}!" |
  | `comeback` | arrival after 30+ days | "Look who's back! Good to see you, {name}." |
  | `milestone` | the Nth stream, N in a row, anniversary | "{name}'s {nth} stream with us! Thank you!" / "{name} has chatted in {row} streams in a row!" / "One year since {name}'s first chat here!" |

  New fields: `{nth}` ("10th"), `{streams}`, `{row}`, `{away}` ("3 weeks"),
  `{since}` ("March 2026"). The existing `returning` welcome keeps firing
  for a returning non-regular; a regular's arrival fires `regular` instead
  (one welcome per person per stream, the most specific kind wins:
  milestone > comeback > regular > returning).
- **Reactions**: new triggers `regular` (default wave), `comeback` (default
  excited), `milestone` (excited, then proud), editable in Profile →
  reactions, `none` turns one off. Reactions never depend on talk mode.
- **Where the words go** follows `CohostTalkMode` exactly: Bubble speaks
  them in the bubble through the plan 211 queue; Suggest makes a card the
  streamer may post; Off says nothing. Nothing here can post to chat.
- **Pacing**: arrivals of one kind within 20 s collapse into one line
  ("Welcome back, Ada, Bo and Kim!" with the existing `{names}`/`{others}`
  collapse, `COLLAPSE_NAMED_MAX` 3); milestones never collapse and keep a
  15 s gap; a row older than 10 minutes is a replay and triggers nothing;
  one arrival gesture per person per stream.
- **The milestone card** is the highlight card's renderer-rasterized
  variant (avatar, name, "10th stream", the persona's mark), never the
  message text. The backend path is unchanged: it highlights the arrival
  message id, so eligibility and the 10 s lifetime stay authoritative. It
  goes on stream when the streamer clicks Show on stream on the milestone's
  `BuddyCard`; "Show milestone cards automatically" is opt-in, default OFF.

### D10. Buddy remembers (AI, Premium, default OFF) ⚑

- **Offered once**, after the first stream where regulars came: a card on
  Reports and Community, "Let Buddy remember what your regulars tell it?"
  with Turn on and Not now. Needs Buddy Live (Premium), Cloud AI consent
  and the master switch.
- **One memory pass at the end of each stream** (`POST
  /api/ai/cohost/memory`, Wire shape): people with ≥2 messages that stream,
  not bots, not forgotten, no YouTube-sourced messages (D3), at most 15 by
  message count, each with their newest 20 messages (≤200 characters) and
  what Buddy already knows. Queued and retried for 7 days if the app quits
  first; dropped if its session was deleted. The pass also returns a
  two-sentence **audience summary** for the report (D15).
- **What a memory may hold** (plan 183 D14, kept): short facts a person said
  about themselves in public chat, ≤100 characters, ≤8 per person, ≤2 new
  per stream; update over add; remove what the person contradicted. Never
  health, religion, politics, sexuality, ethnicity, money, age,
  relationships, location finer than a country, real names, contacts,
  links, hearsay, insults, or instructions ("always call me King"). The
  server strips emails, phone numbers and URLs after the model. Memories are
  untrusted text wherever they travel. The streamer sees, edits and deletes
  every memory; notes are never overwritten by Buddy.
- **Each memory records its source account** (`account_key`) and session,
  so a split (D4) returns it to the right side.
- **How Buddy uses memory.**
  - **AI welcomes** ride the **greet route**, not the tick (plan 192 D4):
    the request's item gains `memories?: string[]` (≤3) and `arrival?`
    (regular, streams, awayDays). The model may use at most one memory,
    only when it fits, never verbatim. The fallback line is the template.
    Latency stays the greet route's 3 s budget.
  - **Answers and banter** get `viewers` in the tick (v5, additive): the
    authors of this batch only (≤10), each with name, platform, regular,
    streams, ≤3 memories and the note (read-only context). Banter may carry
    ≤5 regulars who chatted in the last 10 minutes.
  - **Suggest mode drafts** use the same context; the streamer still clicks
    to post. Buddy never posts on its own.

### D11. Chat rows and the person card

- **One chip per arrival row**, after the role tags and "First chat", in
  this order of priority: the milestone ("10th stream"), then "Back · 3 wk",
  then "Regular · 14". Later rows stay quiet. The chip is an outline
  `Badge` with a monochrome icon from `@/components/icons`, like "First
  chat"; hover opens a `HoverCard` with one line: "14 streams · since March
  2026 · Twitch · YouTube". It is pure render from `message.arrival`; no
  hook, no fetch per row.
- **No linked-platforms mark on the row.** The platforms live on the card
  and in the hover line. Chat stays quiet.
- **The person card opens from the ⋯ menu ("About Ada") and from a
  right-click on the row** (a row-level `ContextMenu` with About, Same
  person as…, Mark as bot). The avatar stays inside the row's button
  (nested buttons are invalid; the row click is on-stream, owner call) ⚑.
  Enter on the row stays on-stream; ⇧Enter is not added.
- **The card** is a `Popover` on `glass-float` at Wide and Medium and a
  `Dialog size="sm"` under 640 px. Content, top to bottom: avatar, name,
  the linked accounts as platform marks with handles ("Twitch · ada" /
  "YouTube · ada_dev"); the stats line "14 streams · since March 2026 · 5
  in a row · 812 messages"; the support line "4,500 bits · 3 gifted subs";
  "Buddy remembers" with its memories (Premium; behind a `LockAlert`
  otherwise, never hidden); the note (inline editable); "Might be the same
  as maxplays on Twitch" with Same person / Not the same when a suggestion
  is open; a retention line for YouTube accounts. Actions: **Wave**
  (bubble-only, the `regular` reaction), **Same person as…**, **Not the
  same person** (when linked), **Mark as bot**, and **Forget Ada…**
  (`ConfirmDialog`). Loaded on open by `cohost.community.person`.
- **The Studio's Chat section** (plan 204) gets the chip only (its rows have
  no ⋯), nothing else.
- **The Buddy pane** gets "Welcome back" under "Say hi": the same row shape
  and 15-minute stay, with the chip and a **Wave** button; a row leaves when
  the person was waved at or welcomed by the bubble.

### D12. Buddy → Community ⚑

- **A new tab, Community, after Chat**: Profile · Chat · Community · Voice ·
  Reports · Clean cut (`BUDDY_TABS`, id `community`). The Buddy page stays
  second in the sidebar and keeps every feature (owner call); Community is
  Buddy's because regulars, welcomes and memory are Buddy's. ⌘K gains
  "Community". No sidebar row is added.
- **Header**: "Videorc knows 312 people from your 41 streams on this
  computer. 18 are regulars." (or "Videorc starts remembering your chat
  from your next stream."), plus backfill progress while it runs.
- **Links that need you** (`PanelSection`, shown only when non-empty):
  open suggestions and cancelled `!link` attempts, each a `ListRow` with the
  two accounts and **Same person** / **Not the same**.
- **People** (`GroupedList`): search (`Input`), filter chips
  (`ToggleGroup`: Regulars, Everyone, Linked, Bots), sort (`Select`:
  Streams, Last chat, Name). Each `ListRow`: avatar, name, the platform
  marks, "14 streams · last Friday". Virtualized over 200 rows. A row opens
  the person card as a `Dialog size="md"` with the D11 content at full size
  and the link history.
- **Settings** (`FieldGroup variant="grouped"`): Remember my community
  (master, default ON); Welcome regulars on stream (default ON); Show
  milestone cards automatically (default OFF); Regular after N streams
  (2–10, default 3); Buddy remembers (Premium, D10); Community sync
  (Premium, D5, with "Pair another computer…"); the retention text;
  Export… / Import…; "Forget everyone…" (`ConfirmDialog`); the disclosure
  line with Copy (H2).
- **Preview**: plays a sample welcome and a milestone on the Buddy preview
  without going live.

### D13. Viewers can opt out, and the streamer can forget

- `!forgetme` (exact, any case, trimmed, any platform): deletes the
  account's attendance and support, and if it was the person's last
  account, the person's note, memories and milestones; keeps a tombstone
  (`account_key`, status `forgotten`) so the account is never learned
  again; in Bubble mode the bubble says "Done, {name}. I've forgotten you."
  Nothing is posted to chat. `!rememberme` lifts the tombstone. `!unlink`
  splits the sender's account off its person (D4).
- These commands cannot be turned off (they are the deletion path GDPR,
  YouTube III.E.4.g and the Kick and Twitch clauses ask for). ⚑
- The streamer's "Forget Ada…" and "Forget everyone…" do the same. The
  report counts opt-outs, never names them. A forget propagates through
  sync (D5).

### D14. Never slow chat down

- The arrival lookup rides the **same** `spawn_blocking` as
  `mark_first_time_chatters`: one extra indexed read per batch of fresh
  authors (`community_accounts` by key → person → counts), one write
  transaction per batch after delivery, never inside a delivery fence. A
  store error leaves rows without `arrival` and logs once per session.
- The `!` parser is a prefix check on trimmed text; no allocation unless
  the row starts with `!`.
- The renderer adds no hook per row; the chip is a `Badge` from
  `message.arrival`. The card fetches on open. The history cache
  (2,000 messages, 8 MB) is unchanged.
- **Deliberately unchanged**: `first_message`, its query and its tests.
- **Budget**: `smoke:live-chat-fake-providers` and `smoke:cohost-fake` keep
  passing with the store on; a 400-author batch adds at most one query of
  the existing chunk size.

### D15. The report

`CohostSessionReport` gains `community` (omitted while empty): regulars who
came (count and the top 10 names with their linked platforms), new
regulars, comebacks, first-timers, **first-timers who stayed 40+ minutes**
(first to last message of the stream ≥40 min, a local count), milestones
celebrated (name, milestone), links made (count), memories learned (count),
opt-outs (count), and `summary?: string` (≤280 characters, Premium, from
the memory pass). Reports shows a Community block under "Stream report":
one `ReportStats` row ("12 regulars back", "3 first-timers stayed 40+
min", "2 comebacks", "1 milestone") and `ListRow`s for the names. The
summary reads as a quiet paragraph under the stats, or a `LockAlert` line
without Premium.

**Known drift (review 2026-11-09, F13).** The report's first-timers come
from the community store, whose YouTube attendance is 30 days deep (D3);
the chat row's "First chat" mark comes from plan 055's query over the chat
history, which keeps YouTube chat for ever (Open question 2). So a YouTube
viewer who last chatted more than 30 days ago is a first-timer in the
report but gets no "First chat" mark on the row. The two agree once the
YouTube chat prune of Open question 2 lands; until then the drift stays,
and the report's number is the one that respects YouTube's rule.

### D16. Pull requests ⚑

- **Superseded by the owner, 2026-11-08:** "execute the entire plan and put
  all to that pr we have". So:
  - every desktop slice lands on `plan-184-videorc-cloud` (#727);
  - every web slice lands on `plan-185-max-and-cloud` (#85);
  - each executor branches from that branch's head, not from `main`;
  - the order below still holds as the order of work;
  - the "Your own worktree from `origin/main`" line in the executor
    instructions means a worktree from the integration branch (plan 221
    U1).
- The original split, kept as the order of work:
- **Desktop PR 1** from `main`: Phases A to E. Ships alone; no web
  dependency.
- **Web PR 1** from web `origin/main`: F1 (memory route), F2 (greet and
  tick additions), H2 (privacy). Deployed before Desktop PR 2.
- **Desktop PR 2**: F3 to F5 (memory job, greet and tick context, card
  memories).
- **Web PR 2 + Desktop PR 3**: Phase G (sync), only after Open question 10.
- Each PR is reviewed before it is marked ready. Gates run once at the end
  of each phase.

## Wire shape (additive)

### Desktop store (SQLite, `CREATE TABLE IF NOT EXISTS`, no foreign keys to `sessions`)

```sql
CREATE TABLE IF NOT EXISTS community_people (
  id TEXT PRIMARY KEY,                    -- ULID
  name TEXT NOT NULL,                     -- the newest account's name
  avatar_url TEXT,
  streams INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  in_a_row INTEGER NOT NULL DEFAULT 0,
  best_in_a_row INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT,
  last_seen_at TEXT,
  support_json TEXT NOT NULL DEFAULT '{}',
  milestones_json TEXT NOT NULL DEFAULT '[]',  -- "streams-10", "row-5", "year-2027"
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'normal',       -- normal | bot | forgotten
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_accounts (
  account_key TEXT PRIMARY KEY,           -- "<platform>:<author_id>"
  platform TEXT NOT NULL,
  author_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  name TEXT NOT NULL,                     -- latest only, never a history
  handle TEXT,
  avatar_url TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'normal',  -- normal | forgotten
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_streams (
  session_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  platforms_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_attendance (
  account_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  first_message_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL,          -- for "stayed 40+ min"
  messages INTEGER NOT NULL,
  PRIMARY KEY (account_key, session_id)
);
CREATE TABLE IF NOT EXISTS community_link_events (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  account_key TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- self | manual | split | suggestion-accepted
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_suggestions (
  account_a TEXT NOT NULL,
  account_b TEXT NOT NULL,
  reason TEXT NOT NULL,                   -- name | link-cancelled
  state TEXT NOT NULL DEFAULT 'open',     -- open | dismissed
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_a, account_b)
);
CREATE TABLE IF NOT EXISTS community_memories (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  account_key TEXT NOT NULL,              -- the account whose words taught it
  text TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_memory_jobs (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
```

- Indexes: `community_accounts(person_id)`,
  `community_accounts(platform, last_seen_at)`,
  `community_attendance(session_id)`, `community_memories(person_id)`,
  `community_suggestions(state)`.
- A forgotten account keeps only `account_key`, `platform`, `author_id`,
  `status`, `updated_at`, with `name` empty. A person with no live account
  left is deleted with its memories and note.
- Pending `!link` words live in memory on the live-chat coordinator,
  keyed by word, with the first account and its time.

### Chat rows

`LiveChatMessage` gains `arrival`, set only on a returning person's
arrival row. Optional and never null:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub arrival: Option<ViewerArrival>,

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerArrival {
    pub streams: u32,                       // including this stream
    pub regular: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away_days: Option<u32>,             // only for Back (D7)
    pub in_a_row: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone: Option<ViewerMilestone>, // { kind: streams | row | anniversary, value: u32 }
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub platforms: Vec<StreamPlatform>,     // only when the person has ≥2 accounts
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,              // "2026-03" for the hover line
}
```

- Stored in a new `live_chat_messages.arrival_json` column through
  `ensure_column` (`storage.rs:10025`), so History shows it.
- `apps/desktop/src/shared/backend-rpc-contract.ts` gets the strict schema;
  `protocol-fixtures/` gets a row with and without `arrival`; the remote and
  LAN projections pass it through or drop it explicitly, and their gates
  run either way.

### RPCs and events (all under `cohost.community.*`)

| Method | Params | Result |
| --- | --- | --- |
| `cohost.community.summary` | none | `{ people, regulars, streams, newRegularsThisWeek, linksPending, backfill: { state: idle\|running\|done, done, total } }` |
| `cohost.community.list` | `{ query?, filter: regulars\|everyone\|linked\|bots, sort: streams\|recent\|name, cursor?, limit≤100 }` | `{ people: CommunityPersonRow[], nextCursor? }` |
| `cohost.community.person` | `{ personId }` or `{ platform, authorId }` | `CommunityPerson` (accounts, stats, support, milestones, note, memories, status, suggestions, linkEvents) |
| `cohost.community.update` | `{ personId, note?, status?: normal\|bot }` | `CommunityPerson` |
| `cohost.community.link` | `{ personId, otherPersonId }` | `CommunityPerson` (refused with `x-self-link-only` when either side is an X account) |
| `cohost.community.unlink` | `{ accountKey }` | `{ personId }` (the new person) |
| `cohost.community.suggestion.dismiss` | `{ accountA, accountB }` | `{ accepted: true }` |
| `cohost.community.forget` | `{ personId }` | `{ accepted: true }` |
| `cohost.community.forgetAll` | none | `{ accepted: true }` |
| `cohost.community.memory.delete` | `{ id }` | `{ accepted: true }` |
| `cohost.community.wave` | `{ personId }` | `{ accepted: true }` |
| `cohost.community.export` | `{ path }` | `{ people, bytes }` |
| `cohost.community.import` | `{ path }` | `{ people, merged }` |
| `cohost.community.sync.status` | none | `{ enabled, lastSyncAt?, paired, state }` (Phase G) |
| `cohost.community.sync.pair.start` / `.pair.join` | none / `{ code }` | `{ code, expiresAt }` / `{ accepted }` (Phase G) |

- One event, `cohost.community.changed`, carries the summary.
- `cohost.state` gains `welcomeBack?: CohostWelcomeBack[]`, like `sayHi`,
  with `{ personId, authorKey, name, platform, arrival, firstSeenAt }`,
  absent while empty; and `linkMade?: { personId, names: [string, string],
  platforms: [StreamPlatform, StreamPlatform], at }[]` for the Undo card,
  absent while empty.
- `cohostSettings.community`: `{ enabled: true, regularStreams: 3,
  welcomeOnStream: true, milestoneCards: false, remember: false, sync:
  false }`, every field with a serde default.
- `greetings.welcomes` gains `regular`, `comeback`, `milestone`
  (`WelcomeLine`, serde defaults). Older apps ignore them (no
  `deny_unknown_fields`; a test parses the new JSON through the old shape).
- Every new `Option` carries `skip_serializing_if`. Every new status or
  event field goes in `backend-rpc-contract.ts` first.

### Web: `POST /api/ai/cohost/memory` (new, Premium, cookie or bearer)

```jsonc
// request
{
  "promptVersion": 1,
  "clientVersion": "0.21.0",
  "sessionClientId": "…",
  "consentToProcessChat": true,
  "persona": { "name": "Buddy" },
  "streamTitle": "…",
  "people": [{
    "ref": "p1",
    "name": "Bo",
    "platforms": ["twitch", "kick"],
    "regular": true,
    "streams": 9,
    "messages": [{ "text": "…", "at": "…", "platform": "twitch" }],  // ≤ 20, each ≤ 200
    "memories": [{ "id": "m1", "text": "…" }],                       // ≤ 8, each ≤ 100
    "note": "…"                                                      // ≤ 300, read-only
  }],                                                                // ≤ 15
  "counts": { "regularsBack": 12, "firstTimers": 5, "firstTimersStayed": 3, "comebacks": 2 }
}
// 200
{
  "people": [{
    "ref": "p1",
    "add": [{ "text": "…", "platform": "twitch" }],                  // ≤ 2
    "update": [{ "id": "m1", "text": "…" }],
    "remove": ["m1"]
  }],
  "summary": "…",                                                    // ≤ 280
  "model": "…",
  "usage": { … }
}
```

- Errors use `{ error: { code, message } }` with `private, no-store`. The
  body is never stored. Usage kind `cohost-memory`, 8 passes a day. The
  route copies the greet route's gating order (premium-required,
  cohost-disabled, ai-user-disabled, quota-exhausted). Capability
  `cohost.memory: 1`.

### Web: greet route, additive

The item schema gains `memories?: string[]` (≤3, each ≤100) and
`arrival?: { regular, streams, awayDays? }`. A request without them is
byte-identical to today's. The prompt rule: use at most one memory, only
when natural, never verbatim, never a note.

### Web: tick v5 (additive over v4)

- Per message, `arrival?` as above; `viewers?: [{ name, platform, regular,
  streams, memories: string[] (≤3), note? }]` (≤10); banter `viewers` ≤5.
- The response is unchanged (welcomes do not ride the tick; plan 192 D4).
- `cohost.tick: 5`; the ladder becomes `[5, 4, 3, 2, 1]`; a v4 body stays
  byte-identical. Fix the v3 wording: `firstMessage` is the author's first
  message in the channel, ever.

### Web: Community sync (Phase G, Premium)

- `PUT /api/desktop/community-sync` (bearer): body ≤8 MB opaque bytes,
  headers `x-videorc-sync-version` (monotonic from the desktop) and
  `x-videorc-sync-kdf` (the key id; never the key). 409 when the server
  holds a newer version. `GET` returns the blob and version. `DELETE`
  removes it. One row per user in a new migration (the next free number
  after plan 185's `0023_add_plans_and_cloud_hours.sql`):
  `community_sync(user_id PK, version, kdf_id, blob BYTEA, updated_at)`.
  Capability `community.sync: 1` when Premium.
- The server never parses the blob, never logs its size beyond a bucket,
  and deletes the row when the account is deleted.

## Phase A: the community store and linking (desktop, Rust)

- **A1. `community.rs`**: tables, the D1 rules (streamer keys from
  `platform_accounts` plus owner rows; `KNOWN_BOTS` extended), the D2
  fields, and D7/D8 as pure functions over a store trait.
  **Done when**: unit tests cover arrival facts, regular, back, in a row
  over platform-filtered streams, each milestone exactly once, the
  anniversary window, D9's precedence, and a two-account person whose
  counts are the union.
- **A2. Linking engine**: `link(person, other)`, `unlink(account)`, the
  suggestion builder (name normalization), the `!link` word matcher (10
  minutes, two platforms, cancel on a third or same-platform claim), and
  the X rules (manual link and suggestions refuse X; `!link` allows it).
  **Done when**: tests cover a clean self-link, a hijack attempt (third
  account cancels), same-platform cancel, expiry at 10 minutes, a manual
  link refused for X with `x-self-link-only`, a split that restores both
  sides' counts exactly, memory ownership after a split, and that no
  suggestion is ever created for an X account.
- **A3. Backfill** (D6 of 183, kept): resumable, off-runtime, in time
  order, YouTube limited to 30 days, progress through
  `cohost.community.changed`, marked done in `app_settings`.
  **Done when**: a fixture database with 4 platforms and 6 sessions gives
  the expected counts; a resumed run equals an uninterrupted one; a second
  run changes nothing.
- **A4. Retention and forgetting** (D3, D13): the daily and at-start prune
  per account clock; `!forgetme`, `!rememberme`, `!unlink`, forget and
  forget-all, tombstones.
  **Done when**: nothing about a YouTube account older than 30 days
  survives a prune (person counts recomputed), a Twitch account survives
  the same prune, a forgotten account is never re-created by later chat, a
  linked person outlives one account's expiry, `!rememberme` restores
  learning.
- **A5. RPCs, events, settings block** (Wire shape), including
  `cohost.community.person` by `{ platform, authorId }`.
  **Done when**: handler tests pass; `person` for an unknown account returns
  a one-account person with zero counts rather than an error.
- **A6. Strict TypeScript schemas and fixtures** (`backend-rpc-contract.ts`,
  `backend.ts`, `protocol-fixtures/`), `gpt-6.1-sol`.
  **Done when**: the contract tests pass on both sides and a fixture test
  proves no new optional field serializes as `null`.

**Phase A gates**: `cargo fmt --check --all`; `cargo clippy -p
videorc-backend --all-targets -- -D warnings`; `cargo test -p
videorc-backend community`, `live_chat`, `storage`, `cohost`; `pnpm
typecheck`; `pnpm --filter @videorc/desktop test`.

## Phase B: live arrivals, commands and gestures (desktop, Rust)

- **B1. Live arrivals** (D14): the lookup in the same `spawn_blocking` as
  `mark_first_time_chatters`, `arrival` on the arrival row, `arrival_json`
  persisted, `community_streams` at session start, in-a-row closed at
  session end, support totals from Activity rows.
  **Done when**: one arrival per person per stream, none for first-timers,
  bots or the streamer; a two-account person gets one arrival whichever
  account chats first; delivery with a blocked store still delivers (the
  existing blocked-persistence pattern); `first_message` tests pass
  untouched.
- **B2. The `!` commands** (`!link`, `!unlink`, `!forgetme`, `!rememberme`),
  parsed off the fence, results into `cohost.state.linkMade` and
  `cohost.community.changed`; bubble confirmations through the plan 211
  queue in Bubble mode only.
  **Done when**: tests prove nothing is ever sent to chat in any talk mode,
  Off says nothing, Bubble says one line, and a `!link` from the streamer's
  own account does nothing.
- **B3. Welcome kinds and reactions** (D9): `regular`, `comeback`,
  `milestone` in `welcomes`; the new fields; triggers and default
  reactions; precedence over `returning`.
  **Done when**: the old-shape parse test passes (an app before this plan
  reads the new JSON and keeps its persona); engine tests cover a regular
  welcomed once with the regular line (not returning), Off silent, Suggest a
  card, Bubble one bubble.
- **B4. Pacing** in `cohost_throttle.rs`: 20 s arrival collapse, 15 s
  milestone gap, the fresh window.
  **Done when**: clock-injected tests cover a 30-regular start (one wave,
  one collapsed bubble) and two milestones 15 s apart.
- **B5. Wave and voice**: `cohost.community.wave`, "Buddy, wave at {name}",
  "Buddy, say hi to {name}", "Buddy, remember that {name} {fact}" (to the
  note, after a confirm card).
  **Done when**: detector tests cover the grammar, "thanks buddy" still does
  nothing, and `smoke:buddy-commands` covers wave.
- **B6. The milestone card** (renderer variant of the highlight card, both
  canvases), Show on stream from the `BuddyCard`, opt-in automatic cards.
  **Done when**: a rasterizer test passes, an artifact frame shows the card
  on both legs, and the card never contains message text.

**Phase B gates**: Phase A's; `pnpm smoke:buddy-pet`; `pnpm
smoke:buddy-commands`; `pnpm smoke:cohost-fake` extended to two fake
sessions so session 2 shows the arrival, the welcome and the milestone;
`pnpm smoke:live-chat-fake-providers`.

## Phase C: the Stream Manager (desktop UI, `opus-5.5`)

- **C1. Arrival chips** on `CommentRow` (D11), priority order, `HoverCard`
  line, and the chip only in `StudioChatRow`.
- **C2. The person card**: "About {name}" in `commentRowMenu`, a row-level
  `ContextMenu`, `Popover` at Wide and Medium, `Dialog size="sm"` under
  640 px, with Wave, Same person as… (`Command` picker, X disabled with its
  reason), Not the same person, Mark as bot, Forget…, the note, the
  suggestion row, and the Premium lock for memories.
- **C3. "Welcome back"** in the Buddy pane under "Say hi", and the
  "Linked … Undo" `BuddyCard`.
- **C4. Proof**: extend `pnpm probe:comments-window` for chips, the card
  and the Welcome back list at 320, 480, 640, 800, 1040 and 1280 px.
  **Done when**: no overflow, every control reachable, the row click still
  puts the message on stream at every width, and the screenshots in light
  and dark have been read.

## Phase D: Buddy → Community (desktop UI, `opus-5.5`)

- **D-1.** The tab (D12), header, backfill progress, ⌘K entry.
- **D-2.** Links that need you.
- **D-3.** People: search, filters, sort, virtualized; the person dialog
  with link history.
- **D-4.** Settings: switches, threshold, retention text, Export…/Import…,
  Forget everyone…, the disclosure line with Copy, and the locked Buddy
  remembers and Community sync rows (`LockAlert`, never hidden).
- **D-5.** Preview on the Buddy preview, offline.
  **Done when**: component tests cover empty, warming up, a full list, a
  linked person, an open suggestion, a cancelled `!link`, a forgotten
  person and a YouTube retention line; screenshots of every state in light
  and dark have been read.

**Phase C and D gates**: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm --filter @videorc/desktop test`, `pnpm build` (the eager gzip ceiling
holds; Community is a lazy chunk), `pnpm probe:comments-window`.

## Phase E: the report (desktop)

- **E1.** `community` on `CohostSessionReport` (D15), computed at session
  end from attendance (`last_message_at` gives "stayed").
- **E2.** The Community block in `buddy-report-card.tsx` and
  `buddy-report-view.ts`; the Library row's "Buddy report" still opens it.
  **Done when**: an older report JSON without `community` renders
  unchanged; a report with it shows the stats row and names; the summary
  row shows the lock without Premium.

**Phase E gates**: Phase A's Rust set for `cohost` and `protocol`; the
TypeScript set.

## Phase F: Buddy remembers (Premium; web first, then desktop)

- **F1 (web).** `POST /api/ai/cohost/memory`: zod schemas, the D10 prompt,
  the sanitizer (email, phone, URL; caps), `cohost-memory` usage kind and
  quota, `cohost.memory: 1`, the `summary`, route tests, and an eval set of
  at least 40 cases judged with `typesafe-ai/jev` (self-facts kept, hearsay
  dropped, sensitive dropped, injections dropped, updates merged,
  contradictions removed).
  **Done when**: ≥95 % labelled right, zero sensitive or injection cases
  stored.
- **F2 (web).** Greet route `memories` and `arrival`; tick v5 `arrival`
  and `viewers`; the `firstMessage` wording fix; capability bumps.
  **Done when**: the v4 and greet golden bodies are unchanged, the v5 parse
  tests pass, the eval fixtures still pass.
- **F3 (desktop).** The memory job: queue at session end, retry 7 days,
  apply add/update/remove with `account_key`, never send YouTube-sourced
  messages, store `summary` on the report.
  **Done when**: tests cover retry, a deleted session, a malformed answer
  (nothing applied), and a split after a memory pass.
- **F4 (desktop).** Greet and tick context wiring; the 183 D15 "hold the
  template welcome for the AI one" is **not** needed (the greet route's 3 s
  fallback already does it).
  **Done when**: tests prove never two welcomes for one arrival and v4
  sessions unchanged.
- **F5 (desktop UI).** Memories on the card and in Community (each with a
  delete), the D10 offer card, the Premium lock copy.

**Phase F gates**: web `pnpm typecheck`, `pnpm lint`, tests, `pnpm build`,
the eval report; desktop Phase A's and D's gates plus `pnpm
smoke:cohost-fake`.

## Phase G: Community sync (Premium; web, then desktop) ⚑

- **G1 (web).** The migration, `PUT/GET/DELETE /api/desktop/community-sync`,
  `community.sync: 1`, size and version checks, account-deletion hook,
  route tests.
- **G2 (desktop).** Export → encrypt (XChaCha20-Poly1305 or the crate the
  backend already uses for secrets; key in the OS keychain) → upload on
  session end and at app start; download → decrypt → merge (D5 rules);
  YouTube accounts excluded; pairing codes; `cohost.community.sync.*`.
  **Done when**: two fixture stores merge to the same result in either
  order; a tombstone wins; a blob from a wrong key is refused with one
  clear error; no YouTube row is ever in a blob (a test greps the
  plaintext before encryption).
- **G3 (desktop UI).** Community → Settings: the sync row, "Pair another
  computer…", status line.

**Phase G gates**: Phase A's Rust set for `community`; the TypeScript set;
web tests; `pnpm smoke:account-auth`.

## Phase H: privacy, docs, acceptance

- **H1.** `docs/buddy.md` (a Community section, the free/Premium table),
  `docs/ui-copy.md` and `docs/buddy-onboarding-copy.md` (D9 lines),
  `docs/buddy-commands.md` (B5, the `!` commands), the design skill (chips,
  the person card, the Community tab, the Buddy tab list in "Where things
  live", "Stream Manager").
- **H2 (web).** The privacy page: a paragraph "Your community" (what stays
  on the computer; what the Premium memory pass sends and that it is not
  kept; retention per platform; `!link`, `!unlink`, `!forgetme`; sync as
  ciphertext Videorc cannot read; the streamer's controls). The disclosure
  line for the channel description, with Copy in Community → Settings:
  "Videorc remembers regulars so Buddy can greet you. Type !forgetme in
  chat anytime and it forgets you. Type !link word in two of my chats to
  be one person."
- **H3.** `plans/README.md` entry; `CHANGELOG` lines when a release cuts.
- **H4. Platform terms, first-hand.** Read the Twitch Developer Services
  Agreement and the X Developer Policy in a browser (this tool could not
  render them), record the quotes in this plan, and get the owner's legal
  read on D3, D4, D5 and D10. **STOP before release without it.**
- **H5. Acceptance**: `pnpm smoke:local-gates`; `pnpm smoke:recording-studio`
  (the milestone card frame); `pnpm probe:comments-window`; by eye in light
  and dark; two streams on the live lab (plans 176 and 178) **only when the
  owner asks**, with a second account chatting on two platforms: stream 2
  shows "Regular", the wave, a forced milestone (threshold 2), a `!link`
  across Twitch and YouTube, `!unlink`, and `!forgetme`.

## Verification gates

Scripts, all present in `package.json` on `origin/main`:

- TypeScript: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm
  --filter @videorc/desktop test`, `pnpm build`.
- Rust: `cargo fmt --check --all`, `cargo clippy -p videorc-backend
  --all-targets -- -D warnings`, targeted `cargo test -p videorc-backend
  community live_chat storage cohost protocol` (the owner directive: no
  full suite by default).
- Chat and Buddy smokes: `pnpm smoke:live-chat-fake-providers`, `pnpm
  smoke:cohost-fake`, `pnpm smoke:buddy-commands`, `pnpm smoke:buddy-pet`,
  `pnpm smoke:studio-chat`, `pnpm smoke:comment-highlight-stream`.
- UI proof: `pnpm probe:comments-window`.
- Bundle: `pnpm smoke:local-gates`, `pnpm test:scripts`.
- Web: that repo's `pnpm typecheck`, `pnpm lint`, tests and `pnpm build`.

Gates run once at the end of each phase, after every slice is written and
committed. Verification stays proportionate: Phases C, D and E need the
TypeScript set and the probe, not the recording smokes.

## STOP conditions

- The first-chat marker changes for any existing row or test.
- Chat delivery waits on the community store, or `smoke:live-chat-fake-
  providers` regresses.
- Anything in this plan sends a chat message on its own, in any talk mode.
- A YouTube account's data older than 30 days survives a prune, or a
  YouTube row reaches a sync blob.
- Two accounts are linked without a viewer's `!link` or the streamer's
  click, or an X account is linked any way but `!link`.
- A memory or note reaches the stream or chat outside the greet and tick
  context and the streamer's talk mode.
- Community data leaves the computer outside the Premium memory pass, the
  greet and tick context, and the encrypted sync blob.
- A name history is kept anywhere.
- A new optional field serializes as `null`.
- A new value lands in `captions.reasonCode` or `preferredTransport`, or a
  shipped desktop is asked to read anything but `tier: "premium"` /
  `isPremium`.
- The Buddy page moves, loses a feature, or Community leaves it.
- The eager renderer bundle passes its ceiling (`pnpm build` fails).

## Out of scope (later)

1. Avatar-based suggestions (perceptual hash).
2. A videorc.com page where viewers link accounts by signing in.
3. Lurkers through Twitch's chatters API.
4. Viewer-facing readouts (`!buddy` saying what it remembers),
   leaderboards, an end-of-stream "thanks, regulars" card.
5. Changing plan 055's chat retention (Open question 2 stays separate).
6. Importing history from other bots.
7. Facebook, TikTok and Instagram: no chat identity on main.
8. Plan 184 D17's chat forwarding to the cloud runner carries no
   `arrival` yet; it passes rows through as today.

## Open questions for the owner

Plan 183's nine, refreshed, then the new ones.

1. **Platform terms**: YouTube accounts 30 days, Twitch, Kick and X 12
   months after the last chat, memories off for YouTube-sourced messages,
   X accounts linked only by the viewer, a legal read before release.
   *Recommended: yes.*
2. **YouTube chat today** is kept forever on the computer (plan 055; the
   compliance reply says so at lines 72-73). Fix it in a small separate
   plan that prunes YouTube chat after 30 days? *Recommended: yes,
   separately.* Until then the report's first-timers and the row's "First
   chat" differ for YouTube people after 30 days (D15, review F13).
3. **Free versus Premium** as D6: store, flags, chips, card, Community,
   linking (all three ways) and the report counts are free; memory, AI
   welcomes and drafts with memory, the audience summary and sync are
   Premium. *Recommended: yes.*
4. **"Buddy remembers" starts OFF**, offered once after the first stream
   with regulars. *Recommended: yes.*
5. **Gestures on by default**: the wave and the "Welcome back" bubble in
   Bubble mode; nothing in chat. *Recommended: yes (plan 192 already
   welcomes returning chatters by default).*
6. **The tab is Community, after Chat, inside Buddy.** *Recommended: yes.*
7. **`!forgetme`, `!rememberme`, `!unlink` and `!link` are always on.**
   *Recommended: yes.*
8. **Numbers**: regular = 3 streams in 90 days; Back = 30 days;
   milestones 5, 10, 25, 50, 100, 250, 500 streams, 3, 5, 10, 20 in a
   row, yearly. *Recommended: yes.*
9. **Pull requests** as D16: Desktop PR 1 (A to E), Web PR 1 (F1, F2, H2),
   Desktop PR 2 (F3 to F5), then sync. *Recommended: yes.*
10. **Sync** (D5): Premium, end-to-end encrypted, YouTube accounts excluded
    until you update the compliance reply, shipped last. *Recommended: yes,
    and cut it if the legal read says no.*
11. **Self-link by `!link <word>`** with a 10-minute window and a public
    word (D4), accepting the small hijack risk because it is reversible.
    *Recommended: yes.*
12. **The card opens from ⋯ and right-click, not the avatar** (the row is
    one button). *Recommended: yes.*
13. **Chip copy**: "Regular · 14", "Back · 3 wk", "10th stream".
    *Recommended: yes.*
14. **"Stayed 40+ min"** as the report's measure of first-timers who stayed
    (first to last message). *Recommended: yes.*

## Handoff (cold start)

- **Goal**: one person across YouTube, Twitch, Kick and X, shown the moment
  they chat, with a history, a post-stream view, viewer-controlled linking
  and forgetting, and a Premium layer (memory, AI drafts, sync) within the
  platform rules above.
- **State**: nothing is built. Desktop base `origin/main` `d00550ea1`; web
  base `origin/main` `3c8d1593`. Plan 183 is superseded by this plan where
  the table in "What exists" says so; read it for history only.
- **Route**: Orchestrator (fit 10, `fable-5.1`). A, B, F, G on
  `fable-5.1`; C, D, E on `opus-5.5` with the design skill; A6 and H3 on
  `gpt-6.1-sol`.
- **Order**: A, B, C, D, E (Desktop PR 1) → F1, F2, H2 (Web PR 1, deploy)
  → F3 to F5 (Desktop PR 2) → G after Open question 10 → H1, H3, H4, H5.
- **Read first**: `live_chat.rs:3560-3660` (keys, `counts_as_chatter`,
  `mark_first_time_chatters`); `storage.rs:4268-4310, 8094-8135,
  8228-8243, 10025` (returning authors, chat tables, platform accounts,
  `ensure_column`); `cohost_greetings.rs:25-145, 400-430` (bots,
  built-ins, `welcome_facts`); `cohost.rs:636-660, 835-870` (talk mode,
  welcomes); `cohost_ack.rs:21-22, 605-640` (Say hi, the streamer);
  `protocol.rs:6069-6110, 6288-6328` (report structs);
  `comment-row.tsx:121, 595-620, 740-800, 905-1120`; `cohost-pane.tsx:
  1020-1075`; `buddy-tab.tsx:140-180, 237-255`; `buddy-tabs.ts:26-32`;
  `buddy-report-card.tsx`, `buddy-report-view.ts:385-415`;
  `workspace-nav.tsx:32-74`; web `lib/ai/cohost-greet.ts`,
  `lib/ai/cohost-greet-route.ts`, `lib/ai/cohost.ts:40-90, 190-200`,
  `lib/ai/cohost-capabilities.ts`.
- **Verification**: the phase gates above, then H5.
- **Blockers**: Open questions 3 and 10 before Phases F and G; H4 before
  release; the Web PR 1 deploy before Desktop PR 2; the live-lab streams
  only when the owner asks.
