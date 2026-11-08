# Plan 183: Buddy remembers your regulars

> **Executor instructions**: read `AGENTS.md`, the `videorc-design` skill and
> this whole plan first. Work in your own worktree from `origin/main`
> (desktop) and from `plan-170-golem-web` (web, until #79 merges). Write and
> commit every slice of a phase first, then run Rust and the smokes once at
> the end of the phase (owner feedback "Gates at the end"). Check every UI in
> light AND dark (owner feedback). Do not start Phase E before the owner has
> answered Open questions 1 and 3.

## Status

- **Status**: PLANNED 2026-10-15; waiting for the owner's answers (see Open
  questions).
- **Priority**: P1 (owner request, 2026-10-15).
- **Effort**: XL. Desktop: a new local store, chat-row facts, on-stream
  gestures, two UI surfaces. Web: one new AI route and tick v5.
- **Risk**: MEDIUM-HIGH.
  - The product risk is low: everything is additive, and the off paths stay
    as they are.
  - The terms and privacy risk is real: this keeps data about viewers over
    time. See Platform rules.
- **Planned at**:
  - desktop `origin/main` `3d16f3dc`, where Buddy is on main since #647;
  - web `plan-170-golem-web` `e8776912` (#79, open). Tick v4 lives only
    there, not on web main `eb56f947`.
- **Route**: Orchestrator (fit 10).
  - Phases A and E: Implementation (fit 8) on `fable-5.1`, because they are
    multi-system and privacy-sensitive.
  - Phases B, C and D: UI/Product Design (fit 9) on `opus`.
  - Phase F: Orchestrator.

## The owner's ask (2026-10-15)

> "Do we currently have some kind of memory for our Buddy right here? Our AI
> buddy is able to know who was on previous live streams and to remember some
> things so we can make some special gestures for our old live streamers that
> are here often."

Then: "Yes plan it out properly. We can make this one really exciting for
our users".

## What a streamer gets

The feature in one line: **Buddy knows who your regulars are, celebrates
them on stream, and (Premium) remembers what they told it.**

1. **Before the stream.** The new Buddy → Community tab says:
   - "Buddy knows 312 viewers from your 41 streams on this computer. 18 are
     regulars."
   - The list leads with Ada (Twitch, 24 streams, here last Friday) and Bo
     (YouTube, 9 streams).
   - Preview plays a welcome on Buddy right there.
2. **Ada says "hi!!".** Three things happen together:
   - Buddy waves on stream, and its bubble says "Welcome back, Ada!".
   - Her chat row carries a quiet chip, "Regular · 24".
   - The Stream Manager's Buddy pane lists her under "Welcome back" with a
     Wave button.
3. **Bo's 10th stream.** Buddy does its excited reaction and says "Bo's 10th
   stream with us! Thank you!". The streamer can put a milestone card on
   stream: Bo's avatar, his name, "10th stream".
4. **Kim comes back after six weeks.** Buddy says "Look who's back! Good to
   see you, Kim."
5. **Premium: Buddy remembers.** Last week Bo said he had started learning
   Rust. Today Buddy's welcome is "Welcome back, Bo! Did the borrow checker
   win this week?". When Bo asks Buddy a question, the answer can mention it.
6. **Voice.**
   - "Buddy, wave at Bo": Buddy waves at him on stream.
   - "Buddy, remember that Bo got the job": a note on Bo's card.
7. **Viewers stay in control.** A viewer who types `!forgetme` is forgotten
   on the spot, and Buddy says so. `!rememberme` undoes it.
8. **After the stream.** The report adds a Community block: "14 regulars
   came, 3 new regulars. Bo reached 10 streams. Buddy learned 6 new things."

## What exists (facts, `origin/main` `3d16f3dc`)

- **Every chat message of every stream is kept on the computer.**
  - The table is `live_chat_messages` (`storage.rs:6831`): session, platform,
    `author_id`, name, avatar, roles, text, event type and details.
  - Nothing prunes it.
  - Rows cascade with their session, so deleting a recording deletes its
    chat.
  - `session_chat_authors` (session, author key, message count) cascades the
    same way.
- **First chat.**
  - `mark_first_time_chatters` (`live_chat.rs:3178`) asks
    `live_chat_returning_authors` (`storage.rs:3594`, index
    `idx_live_chat_messages_platform_author`) whether the author chatted in
    an earlier session.
  - A new author's row gets `first_message`. The row shows "First chat", the
    Buddy pane lists them under "Say hi" for 15 minutes (`cohost_ack.rs`),
    and the report counts them.
- **Buddy forgets at every stream boundary, on purpose.**
  - `clear_transcript` (`cohost.rs:7666`) clears what was said.
  - The rolling summary (at most 600 characters) lives for one session.
  - The web is stateless: the summary round-trips through the desktop.
- **The tick.**
  - Tick v4 (#79) carries the persona and banter.
  - Messages carry `firstMessage`. The web prompt calls it "the author's
    first message on this stream", but the desktop sets it only for the
    first message in the channel, ever. That wording is a bug, fixed in E2.
- **Greetings** (plan 164).
  - Templates exist only for Activity kinds (`cohost.rs:643`): follow, sub,
    resub, gifts, membership, cheer, KICKs, Super Chat and Sticker, raid,
    watch streak, Power-up, redemption.
  - Fields are `{name}`, `{handle}`, `{months}`, `{streak}`, `{count}`,
    `{amount}`, `{reward}`, `{names}` and `{others}`
    (`cohost_greetings.rs`).
  - The throttle (`cohost_throttle.rs`): 6 sends a minute per destination, a
    5 s gap, a cooldown per kind, a collapse above 3, and one greeting per
    destination, viewer and kind per session.
  - Greetings, Say and reactions are free. Buddy Live (AI) is Premium
    (`buddy-tab-view.ts:154`).
- **Chat posting** is Off, Suggest or Auto, and Off produces nothing
  (plan 164 D4). The Say box goes bubble-only when the mode is not Auto.
- **Reactions don't depend on chat posting.**
  - Every fresh Activity row plays its trigger's reaction
    (`buddy_animator.rs:1051`).
  - The defaults are in `buddy_pet.rs:1363`, for example follow → wave.
  - The bundled pack draws annoyed, blink, calm, confused, excited, kiss,
    laugh, proud, sleep, surprised, talk, wave, wink and worried. Any other
    id plays the motion-only hop.
- **On-stream cards.** The renderer rasterizes a PNG. The backend owns
  eligibility and the 10 s lifetime (`comment_highlight.rs`).
- **The Stream Manager.**
  - A click on a row puts it on stream (owner call), and the ⋯ menu holds
    the rest (`commentRowMenu`, `comment-row.tsx:877`).
  - A row paints at most one background.
  - "First chat" is an outline `Badge`.
- **The Buddy page's tabs** are Profile, Chat, Voice, Reports and Clean cut
  (`lib/buddy-tabs.ts`).
- **Voice commands** (`cohost_command.rs`) run on the computer: highlight,
  clear, remove, confirm, cancel and marker. The wake word is "buddy" or the
  persona's name.
- **Reports.** `cohost_reports` keeps one report per session and deletes it
  with the session, which the privacy page says.
- **What doesn't exist yet:**
  - chat bang-commands;
  - a bot list;
  - any memory across streams.
- **The streamer** is excluded for one session at a time, by an owner or
  broadcaster role or by the echo of their own send (`cohost_ack.rs:614`).

## Platform rules (facts, checked 2026-10-15)

These shape the design. They are not legal advice, and the plan asks for a
legal read before release (F4).

- **YouTube API Services Developer Policies**
  (<https://developers.google.com/youtube/terms/developer-policies>):
  - III.E.4.c and d: Authorized and Non-Authorized Data are stored "for no
    longer than 30 calendar days", then deleted or refreshed.
  - III.E.4.g: users must have a way to ask for deletion, and the data goes
    within 7 days.
  - III.E.4.h: apps "must not ... use API Data to create new or derived data
    or metrics".
  - III.E.2.a: an app may aggregate only data relating to one content
    owner's channels, and only that owner may see it.
  - II.4: "Don't store user data indefinitely."
- **Twitch Developer Services Agreement.** This is quoted second-hand,
  because the legal page didn't render.
  - Chat logs may be kept only as needed to run or improve the service. They
    may not be used to create public databases or to collect information
    about Twitch users in general.
  - Twitch Legal's takedown of OverRustle Logs also named caching username
    changes.
  - A developer-forum thread asked exactly our question on 2026-09-03 (an AI
    companion with long-term viewer memory). It got no Twitch answer, only
    "consult a lawyer" and "a deletion mechanism is required for GDPR".
- **Kick and X:** not checked yet (F4).
- **GDPR.** Viewers are people. The streamer decides why their data is
  kept, and Videorc is the tool. That means a clear purpose, minimal data, a
  retention limit, a way to delete, and telling viewers.
- **Already true today, and not changed here:** Videorc keeps YouTube chat
  forever on the computer (plan 055). This plan doesn't lean on that for
  YouTube (D3). Whether to fix it is a separate owner decision (Open
  question 2).

## Decisions (⚑ = owner may override)

### D1. Who Buddy remembers

- **A viewer** is one account on one platform. The key is
  `<platform>:<author_id>`.
  - A message without an author id is never counted, and neither are custom
    RTMP rows.
  - The same person on Twitch and on YouTube is two viewers. Linking them is
    Later 1.
- **Only chat and paid messages count** toward arrivals and streams.
  Activity rows (follows, subs, tips) add to a viewer's support totals but
  never count as attendance.
- **The streamer is never a viewer:**
  - the ids of the connected accounts in `platform_accounts`;
  - rows with an owner or broadcaster role;
  - the echo of the streamer's own send.
- **Bots.** A built-in list of well-known bot logins starts as "Bot", and
  Buddy ignores them: Nightbot, StreamElements, Streamlabs, Moobot, Fossabot,
  Wizebot, Sery_Bot, Botisimo, PhantomBot, Kofistreambot, SoundAlerts and
  PokemonCommunityGame. The streamer can mark any viewer as a bot, or unmark
  one.

### D2. What Buddy keeps, on this computer only, without AI

For each viewer:

- the latest display name and avatar URL. **Never a name history**, because
  Twitch Legal named that;
- first and last chat time;
- streams chatted in, messages, streams in a row and best in a row;
- support totals from Activity on this computer: bits, KICKs, gifted subs,
  sub months, and tips by currency;
- milestones already celebrated;
- the streamer's own note, at most 300 characters;
- a status: normal, bot, or forgotten.

Each stream is kept as `(session id, start time, platforms reached)`, so
"streams in a row" only counts streams that reached the viewer's platform.

### D3. How long Buddy keeps it, per platform ⚑

- **YouTube: 30 days, rolling, for everything.**
  - Attendance rows, counts, milestones and notes older than 30 days are
    deleted or recomputed every day and at app start.
  - A YouTube viewer's "first seen" never reaches back more than 30 days,
    and YouTube gets no anniversary.
  - AI memories are **off for YouTube viewers** until the legal read (F4)
    clears derived data (III.E.4.h).
  - The UI says it plainly: "YouTube viewers are remembered for 30 days
    after they chat (YouTube's rules)."
- **Twitch, Kick and X:** a viewer and everything about them is forgotten 12
  months after their last chat.
- **Recordings.** Memory outlives recordings: deleting a recording frees
  disk space and never deletes community data. Community data has its own
  delete controls (D12), and the privacy page says so (F2).

### D4. Backfill: Buddy knows your community on day one

- The first time the store opens, it builds itself from the chat already on
  the computer, all sessions in time order. For YouTube it uses only the last
  30 days.
- It is resumable, runs off the async runtime, shows progress on the
  Community tab, and is marked done in `app_settings`.
- The warm-up line afterwards: "Buddy knows 312 viewers from your 41 streams
  on this computer."
- With no chat history: "Buddy starts remembering your chat from your next
  stream."

### D5. Regulars ⚑

- A **regular** has chatted in at least **3** different streams in the last
  **90** days (YouTube: 30 days).
- The streamer can set the number from 2 to 10, under Community → Settings.
- "Back after a while": the last chat was 30 or more days ago. This never
  applies on YouTube.

### D6. Milestones ⚑

- **Streams chatted in:** 5, 10, 25, 50, 100, 250 and 500.
- **Streams in a row:** 3, 5, 10 and 20. It says "in a row", never "streak",
  so it doesn't clash with Twitch's own watch streaks, which keep their
  greeting.
- **Anniversary:** one year since the first chat, celebrated at their first
  message of a stream within 7 days after the date, once a year. Not on
  YouTube.
- Each milestone is celebrated once per viewer, ever. When two land
  together, the biggest wins.

### D7. Gestures on stream ⚑

- **New reaction triggers:**
  - `regular` (a regular arrives), default reaction **wave**;
  - `comeback` (back after a while), default **excited**;
  - `milestone`, default **excited**, then **proud**, then the hop.
- Like every reaction, they don't depend on chat posting. They are editable
  in Profile → reactions, with `none` turning one off.
- **New switch: "Welcome regulars on stream"**, default ON. It shows the
  welcome as Buddy's bubble, bubble-only, whatever the chat posting mode.
  - Chat posting (Off, Suggest, Auto) still alone decides whether the words
    also go to chat. Off still never posts (plan 164 D4 kept).
  - It is in the Buddy pane footer (beside "{name} on stream") and in
    Community → Settings.
- **The milestone card.**
  - It is the highlight card's renderer-rasterized variant: avatar, name,
    the milestone ("10th stream") and the persona's mark. It **never shows
    the message text automatically.**
  - The backend path is unchanged: it highlights the viewer's arrival
    message id, so eligibility and the 10 s lifetime stay authoritative.
  - It goes on stream when the streamer clicks Show on stream on the
    milestone's Buddy card.
  - "Show milestone cards automatically" is opt-in, default OFF, and uses
    the auto-highlight cadence.

### D8. Greeting kinds, fields and default copy

New template kinds, added to the closed enum on both sides:

| Kind | When | Default text (template disabled until the streamer turns greetings on) |
| --- | --- | --- |
| `regular` | A regular's first message of the stream | "Welcome back, {name}!" |
| `comeback` | First message after 30+ days away | "Look who's back! Good to see you, {name}." |
| `stream-milestone` | Their Nth stream (D6) | "{name}'s {nth} stream with us! Thank you!" |
| `row-milestone` | N streams in a row | "{name} has chatted in {row} streams in a row!" |
| `anniversary` | One year since the first chat | "One year since {name}'s first chat here!" |

- **New fields:**
  - `{nth}`: the ordinal stream, "10th";
  - `{streams}`: the number;
  - `{row}`;
  - `{away}`: "6 weeks";
  - `{since}`: the month and year of the first chat.
- The existing fields keep working.
- The bubble text for "Welcome regulars on stream" comes from the same
  templates, enabled or not, so the bubble works out of the box.
- The copy lives in `docs/buddy-onboarding-copy.md` and `docs/ui-copy.md`.

### D9. Arrival waves are paced

- A stream start floods in regulars, so arrivals of one kind within 20 s
  collapse into one gesture: one wave, and the bubble "Welcome back, Ada, Bo
  and Kim!" (`{names}`, `{others}` as in D9 of plan 164).
- Milestones never collapse. Each waits its turn with a 15 s gap, so every
  milestone gets its own moment.
- An arrival older than 10 minutes when it arrives is a replay and never
  triggers anything (`ACTIVITY_FRESH_WINDOW`).
- A viewer gets one arrival gesture per stream, at most.

### D10. The Stream Manager

- **Chips.** The arrival row (the viewer's first message of this stream)
  carries at most one new chip, in this order:
  1. the milestone ("10th stream");
  2. "Back" (after a while);
  3. "Regular · 24".

  Later rows stay quiet. Chips are outline badges with an icon from
  `@/components/icons`, monochrome (colour is information), with details on
  hover. "First chat" is unchanged.
- **The viewer card.** The row's ⋯ gets "About {name}", which opens it, and
  so does a Welcome back row.
  - The stats line: "24 streams · since March 2026 · 5 in a row · 1,204
    messages".
  - The support line: "4,500 bits · 3 gifted subs".
  - "Buddy remembers", with its memories (Premium).
  - The note.
  - Actions: Wave, Greet (the template, per chat posting), Mark as bot, and
    "Forget {name}…", which uses `ConfirmDialog`.
- **The Buddy pane.** A "Welcome back" list sits under "Say hi". It has the
  same row shape and the 15-minute stay, plus the chip, Wave and Greeted. A
  row leaves when the regular was greeted, waved at, or welcomed by
  automation.

### D11. Buddy → Community ⚑

- **Its place:** a new tab, **Community**, after Chat:

  > Profile · Chat · Community · Voice · Reports · Clean cut

  The Buddy page stays where it is and keeps every feature (owner call).
- **Its contents:**
  - **The header:** the warm-up line (D4), plus "18 regulars · 3 new
    regulars this week".
  - **The list:** search, sort (streams, last chat, name) and filter chips
    (Regulars, Everyone, Bots). Each row shows avatar, name, platform mark,
    streams and last chat.
  - **The viewer sheet:** the D10 card, full size.
  - **Settings:**
    - Remember my community (master switch, default ON, local);
    - Welcome regulars on stream;
    - Milestone cards automatically;
    - the regular threshold;
    - Buddy remembers (Premium, D13);
    - the retention text (D3);
    - "Forget everyone…" (`ConfirmDialog`);
    - the disclosure line with Copy (D18).
  - **Preview:** plays a sample welcome and milestone on the Buddy preview
    without going live.

### D12. Viewers can opt out

- **The commands.** A chat message that is exactly `!forgetme` (any case,
  trimmed) on any platform does three things:
  1. it deletes that viewer's stats, attendance, memories and note;
  2. it keeps a tombstone (key and status `forgotten`, nothing else), so
     Buddy never learns them again;
  3. if chat posting allows, Buddy replies "Done, {name}. I've forgotten
     you."

  `!rememberme` lifts the tombstone.
- **Always on.** The commands can't be turned off, because they are the
  deletion path GDPR and YouTube III.E.4.g ask for. ⚑
- **The streamer's controls:** "Forget {name}" and "Forget everyone" do the
  same.
- **The report** counts opt-outs, never names.

### D13. Buddy remembers (AI, Premium, default OFF) ⚑

- **When it's offered.** After the first stream where regulars came, a
  one-time card on the Report and Community tabs offers "Let Buddy remember
  what your regulars tell it?" with Turn on and Not now.
- **What it needs:** Buddy Live (Premium), Cloud AI allowed, and the master
  switch on.
- **When Buddy learns.** One memory pass at the end of each stream (E1, E3),
  not on every tick. The pass is cheap, sees the whole stream, and can merge
  and correct what Buddy already knew.
  - Who's in it: viewers with at least 2 messages that stream; not bots,
    not forgotten, and not YouTube (D3); at most 15 viewers by message
    count; each with their newest 20 messages of at most 200 characters,
    plus what Buddy already knows about them.
  - If the app quits first, the pass is queued and retried at the next
    launch for up to 7 days. If its session was deleted, it's dropped.

### D14. What a memory may hold

- **Allowed:** short facts a viewer said about themselves in public chat,
  for example:
  - "Learning Rust; shipped a first CLI";
  - "Has a cat named Pixel";
  - "Plays bass in a band";
  - "Likes to be called Captain".
- **The shape:** at most 100 characters each, at most 8 per viewer, and at
  most 2 new per stream. Prefer updating a memory over adding one, and
  remove a memory the viewer contradicted.
- **Never:**
  - health, religion, politics, sexuality, ethnicity, money, age,
    relationships, or any location more precise than a country;
  - real names, contact details, or links;
  - what others said about them;
  - insults;
  - anything that tells Buddy to do something ("always call me King", "say
    X on stream" are instructions, not facts).
- **The server checks** every memory for emails, phone numbers and URLs
  after the model, and the eval set (E1) proves the rules.
- **Memories are untrusted text** wherever they travel, like notes.
- **The streamer sees, edits and deletes every memory.** Streamer notes are
  never overwritten by Buddy.

### D15. How Buddy uses what it knows (tick v5)

- **Arrival facts.** Tick messages gain `arrival` (D2 facts for the arrival
  row). This part is free information, but it rides on the Premium tick.
- **Viewer context.** With D13 on, the request gains `viewers` for the
  authors in this batch only (at most 10):
  - name, platform, regular, streams;
  - at most 3 memories;
  - the note.
- **The model's rules:** use at most one memory per reply, only when it fits
  naturally, never read a note out verbatim, and never mention something the
  viewer didn't say in public.
- **AI welcomes.** The response gains `welcomes`: at most 2 per tick, one
  for each arriving regular with memories, at most 120 characters, with a
  mood.
  - With D13 on, the desktop holds the template welcome of a regular with
    memories for up to 25 s, waiting for the AI welcome. Then it sends
    whichever came, never both.
  - Welcomes go through the chat posting mode and the D9 pacing like any
    greeting.
- **Banter** requests may carry up to 5 regulars who chatted in the last 10
  minutes, so dead-air banter can talk to them.

### D16. Voice

New phrases for the local detector. They need the wake word, like every
non-removal command:

- "Buddy, wave at {name}" or "Buddy, say hi to {name}": the regular wave and
  the bubble "Hey {name}!". The name is matched like highlight names, among
  this stream's chatters.
- "Buddy, remember that {name} {fact}": appends the fact to the viewer's
  note, after a confirm card ("Remember about Bo: got the job?" with Save
  and Cancel). It never goes to the AI memory list.
- `docs/buddy-commands.md` and the Voice tab list both.

### D17. The report

The report gains a Community block, saved and deleted with the session like
the rest:

- regulars who came (count, plus the top 10 names);
- new regulars;
- comebacks;
- milestones celebrated (name and milestone);
- memories learned (a count only);
- opt-outs (a count only).

### D18. Telling people

- **The privacy page (web)** gets a new paragraph, "Buddy's memory of your
  viewers". It covers:
  - what stays on the computer;
  - what the Premium memory pass sends: the stream's messages of those
    viewers and what Buddy already knew, not kept after the answer;
  - retention per platform;
  - `!forgetme`;
  - the streamer's controls.

  The "Buddy stream reports" paragraph gets the Community block.
- **The disclosure line** (Community → Settings, with a Copy button) is for
  the streamer's channel description: "Buddy remembers regulars so it can
  greet you. Type !forgetme in chat anytime and it forgets you."

### D19. Free and Premium ⚑

- **Free:** the community store, regulars, chips, the viewer card, gestures,
  greeting kinds, milestone cards, the Community tab and `!forgetme`. This
  is the hook: greetings are already free, and every streamer feels it on
  their next stream.
- **Premium:** Buddy remembers (the memory pass), AI welcomes, viewer
  context in replies and banter, and voice (which is Premium already).

### D20. Pull requests ⚑

- **Desktop:** a new PR from `main` for Phases A to D. It ships on its own,
  with no web dependency.
- **Web:** a new PR stacked on #79 for E1, E2 and F2. It is deployed after
  #75 and #79.
- **Desktop again:** a second PR for E3 to E6, merged after that web deploy.
- The owner's "add to existing pr" applied to the Buddy QA round. #647 is
  merged, and #79 is waiting to merge, so new PRs keep both clean.

### D21. Never slow chat down

- **Off the delivery fence.** The store is read and written off the
  delivery fence, the same way `mark_first_time_chatters` is:
  - one indexed query per batch of authors new to the session, in
    `spawn_blocking`;
  - one write transaction per batch.
- **Failure is quiet.** A store error leaves the rows without `arrival`
  and logs once. It never delays or drops a message.
- **Deliberately unchanged:** the first-chat marker and its query.

## Wire shape

### Desktop store (SQLite, created with `CREATE TABLE IF NOT EXISTS`, no foreign keys to `sessions`)

```sql
CREATE TABLE IF NOT EXISTS community_viewers (
  viewer_key TEXT PRIMARY KEY,          -- "<platform>:<author_id>"
  platform TEXT NOT NULL,
  author_id TEXT NOT NULL,
  name TEXT NOT NULL,                   -- latest only, never a history
  avatar_url TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  streams INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  in_a_row INTEGER NOT NULL DEFAULT 0,
  best_in_a_row INTEGER NOT NULL DEFAULT 0,
  support_json TEXT NOT NULL DEFAULT '{}',
  milestones_json TEXT NOT NULL DEFAULT '[]',  -- "streams-10", "row-5", "year-2027"
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'normal',       -- normal | bot | forgotten
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_streams (
  session_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  platforms_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_attendance (
  viewer_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  first_message_at TEXT NOT NULL,
  messages INTEGER NOT NULL,
  PRIMARY KEY (viewer_key, session_id)
);
CREATE TABLE IF NOT EXISTS community_memories (
  id TEXT PRIMARY KEY,
  viewer_key TEXT NOT NULL,
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

- Indexes on `community_viewers(platform, last_seen_at)`,
  `community_attendance(session_id)` and `community_memories(viewer_key)`.
- A forgotten viewer keeps only `viewer_key`, `platform`, `author_id`,
  `status` and `updated_at`, with the rest reset. `name` becomes empty.

### Chat rows

`LiveChatMessage` gains `arrival`. Like `first_message`, it is optional and
never null:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub arrival: Option<ViewerArrival>,

pub struct ViewerArrival {
    pub streams: u32,                 // including this stream
    pub regular: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away_days: Option<u32>,       // set only for a comeback (D5)
    pub in_a_row: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone: Option<ViewerMilestone>, // { kind: streams | row | anniversary, value: u32 }
}
```

- It is set only on a returning viewer's arrival row. A first-timer has
  `first_message` instead.
- It is stored in a new `live_chat_messages.arrival_json` column through
  `ensure_column`.
- The renderer's strict schema and the protocol fixtures change with it.
- The remote and LAN projections pass it through or drop it explicitly.
  Either way, run their gates.

### RPCs and events

| Method | Params | Result |
| --- | --- | --- |
| `cohost.community.summary` | none | `{ viewers, regulars, streams, newRegularsThisWeek, backfill: { state: idle\|running\|done, done, total } }` |
| `cohost.community.list` | `{ query?, filter: regulars\|everyone\|bots, sort: streams\|recent\|name, cursor?, limit≤100 }` | `{ viewers: CommunityViewerRow[], nextCursor? }` |
| `cohost.community.get` | `{ viewerKey }` | `CommunityViewer` (the stats, support, milestones, note, memories, status) |
| `cohost.community.update` | `{ viewerKey, note?, status?: normal\|bot }` | `CommunityViewer` |
| `cohost.community.forget` | `{ viewerKey }` | `{ accepted: true }` |
| `cohost.community.forgetAll` | none | `{ accepted: true }` |
| `cohost.community.memory.delete` | `{ id }` | `{ accepted: true }` |
| `cohost.community.wave` | `{ viewerKey }` | `{ accepted: true }` |

- One event, `cohost.community.changed`, carries the summary.
- `cohost.state` gains `welcomeBack: CohostWelcomeBack[]`, like `sayHi`,
  with `{ authorKey, name, platform, arrival, firstSeenAt }`. It is absent
  while empty.
- Settings gain `cohostSettings.community`:
  `{ enabled: true, regularStreams: 3, welcomeOnStream: true,
  milestoneCards: false, remember: false }`. Every field has a serde
  default.

### Web: `POST /api/cohost/memory` (new, Premium, cookie or bearer)

```jsonc
// request
{
  "promptVersion": 1,
  "sessionClientId": "…",
  "consentToProcessChat": true,
  "persona": { "name": "Buddy" },
  "streamTitle": "…",
  "viewers": [{
    "ref": "v1",
    "name": "Bo",
    "platform": "twitch",
    "messages": [{ "text": "…", "at": "…" }],   // ≤ 20, each ≤ 200
    "memories": [{ "id": "m1", "text": "…" }],  // ≤ 8, each ≤ 100
    "note": "…"                                 // ≤ 300, read-only context
  }]                                            // ≤ 15
}
// 200
{
  "viewers": [{
    "ref": "v1",
    "add": [{ "text": "…" }],                   // ≤ 2
    "update": [{ "id": "m1", "text": "…" }],
    "remove": ["m1"]
  }],
  "usage": { … }
}
```

- Errors use `{ error: { code, message } }` with `private, no-store`.
- The body is never stored.
- Usage kind `cohost-memory` has its own daily quota of 8 passes.
- Capability: `cohost.memory: 1`.

### Web: tick v5 (additive over v4)

- **The request** may add:
  - per message, `arrival: { streams, regular, awayDays?, inARow,
    milestone? }`;
  - `viewers: [{ name, platform, regular, streams, memories: string[] (≤3),
    note? }]` (at most 10);
  - on a banter request, `viewers` with at most 5 entries.
- **The response** may add `welcomes: [{ messageId, text (≤120), mood }]`
  (at most 2).
- **Capability:** `cohost.tick: 5`. The ladder becomes `[5, 4, 3, 2, 1]`. A
  v4 body stays byte-identical.

## Phase A: The community store (desktop, Rust)

- **A1.** Add `community.rs` with the tables, the D1 rules (streamer ids
  from `platform_accounts` plus owner rows; the bot list) and the D2 to D6
  logic as pure functions over a store trait.
  - **Done when:** unit tests cover arrivals, regular, comeback, in-a-row
    across platform-filtered streams, each milestone exactly once, the
    anniversary window, and the D7 precedence when several land.
- **A2.** Backfill (D4): resumable, off-runtime, in time order, YouTube
  limited to 30 days, with progress through `cohost.community.changed`.
  - **Done when:** a fixture database with 3 platforms and 6 sessions gives
    the exact expected counts, a resumed backfill gives the same result as
    an uninterrupted one, and a second run changes nothing.
- **A3.** Live arrivals.
  - Do the lookup and write off the fence (D21), set `arrival` on the
    arrival row, persist `arrival_json`, insert `community_streams` at
    session start, and close the in-a-row counts at session end.
  - Count support totals from Activity rows.
  - **Done when:**
    - tests prove one arrival per viewer per stream and no arrival for
      first-timers, bots or the streamer;
    - delivery with a blocked store still delivers (the existing
      blocked-persistence test pattern);
    - `first_message` behaviour is byte-identical (the existing tests pass
      untouched).
- **A4.** Retention and forgetting (D3, D12).
  - A daily and at-start prune: YouTube 30 days, the others 12 months.
  - `!forgetme`, `!rememberme`, forget and forget-all, and tombstones.
  - **Done when:** tests prove nothing about a YouTube viewer older than 30
    days survives a prune (stats recomputed from the remaining attendance),
    a forgotten viewer is never re-created by later chat, and
    `!rememberme` restores learning.
- **A5.** RPCs, the event, the `community` settings block, strict
  TypeScript schemas and `protocol-fixtures/`.
  - **Done when:** the contract tests and fixtures pass on both sides, and
    no new optional field serializes as `null`.

**Phase A gates:**
- `cargo fmt --check --all`;
- `cargo clippy -p videorc-backend -- -D warnings`;
- targeted `cargo test` for community, live_chat, storage and cohost;
- `pnpm typecheck` and the desktop unit tests.

## Phase B: Gestures on stream (desktop)

- **B1.** Add triggers `regular`, `comeback` and `milestone` with the D7
  defaults, and their rows in Profile → reactions.
- **B2.** Add the D8 kinds and fields, and render them in Chat → Greetings
  with the D8 defaults.
  - The "Welcome regulars on stream" bubble lane is bubble-only in every
    mode. Chat sends follow the mode.
  - **Done when:** tests prove Off never posts, and the bubble shows in Off
    when the switch is on.
- **B3.** The D9 pacing in `cohost_throttle.rs`: a 20 s arrival collapse,
  a 15 s milestone queue, and the fresh window.
  - **Done when:** clock-injected tests cover a 30-regular stream start (one
    wave, one collapsed bubble) and two milestones (two moments, 15 s
    apart).
- **B4.** The milestone card: the renderer variant of the highlight card
  for the horizontal and vertical canvases, Show on stream from the Buddy
  card, and the opt-in automatic cards.
  - **Done when:** a rasterizer test passes, an artifact smoke frame shows
    the card on both legs, and the card never contains the message text.
- **B5.** `cohost.community.wave` and the D16 voice phrases ("wave at",
  "say hi to", "remember that"), with the confirm card for remember.
  - **Done when:** detector tests cover the new grammar, including "thanks
    buddy" still doing nothing, and `smoke:buddy-commands` covers wave.

**Phase B gates:**
- Phase A's gates;
- `pnpm smoke:buddy-pet` (reactions);
- `pnpm smoke:buddy-commands`;
- the highlight artifact smoke in `smoke:recording-studio`.

## Phase C: The Stream Manager (desktop UI)

- **C1.** Arrival chips on chat rows (D10), in priority order, with a hover
  card.
- **C2.** "About {name}" in the row ⋯, opening the viewer card (`Popover`
  at Wide and Medium, `Sheet` at Narrow), with Wave, Greet, Mark as bot and
  Forget.
- **C3.** "Welcome back" in the Buddy pane, under "Say hi".
- **C4.** Extend `pnpm probe:comments-window` for chips, the card and the
  list at 320, 480, 640, 800, 1040 and 1280 px.
  - **Done when:** no overflow, every control is reachable, and the
    screenshots in light and dark are read.

## Phase D: Buddy → Community (desktop UI)

- **D-1.** The tab (D11), the warm-up header, and the backfill progress.
- **D-2.** The list: search, sort and filters, virtualized like chat when
  over 200 rows.
- **D-3.** The viewer sheet, with the D10 card's content at full size.
- **D-4.** Settings: switches, threshold, retention text, "Forget
  everyone…", and the disclosure line with Copy.
- **D-5.** Preview: a sample welcome and milestone on the Buddy preview,
  offline.
- **Done when:**
  - component tests cover empty, warming up, a full list, a forgotten
    viewer and a YouTube viewer's retention text;
  - by-eye screenshots of every state in light and dark have been read.

**Phase D gates** (the TypeScript set):
- `pnpm typecheck`, `pnpm lint` and `pnpm format:check`;
- the desktop unit tests;
- `pnpm build`.

## Phase E: Buddy remembers (Premium; web first, then desktop)

- **E1 (web).** The memory route, its zod schemas and prompt (D14), a
  sanitizer (email, phone and URL filter; caps), the usage kind and quota,
  and route tests.
  - An eval set of at least 40 cases, judged by `typesafe-ai/jev`:
    self-facts kept, hearsay dropped, sensitive facts dropped, injections
    dropped, updates merged, contradictions removed.
  - **Done when:** at least 95 % of cases are labelled right, with zero
    sensitive or injection cases stored.
- **E2 (web).** Tick v5: `arrival`, `viewers`, `welcomes` and banter
  `viewers`.
  - Fix the `firstMessage` wording: it means the author's first message in
    the channel, ever.
  - Bump the capabilities.
  - **Done when:** the v4 golden bodies are unchanged, the v5 parse tests
    pass, and the command eval still passes.
- **E3 (desktop).** The memory job: queue it at session end, retry for 7
  days, apply add, update and remove, keep streamer notes untouched, and
  never send YouTube viewers.
  - **Done when:** tests cover retry, a deleted session and a malformed
    answer (nothing applied).
- **E4 (desktop).** Tick v5 wiring, the 25 s welcome hold (D15) and banter
  viewers.
  - **Done when:** tests prove never two welcomes, and v4 sessions are
    unchanged.
- **E5 (desktop UI).** Memories in the viewer card and sheet, each with a
  delete, the D13 offer card, and the Premium lock copy.

**Phase E gates:**
- web: `pnpm typecheck`, `pnpm lint`, tests, `pnpm build`, and the eval
  report;
- desktop: Phase A's and D's gates, plus `pnpm smoke:cohost-fake`, extended
  to two fake sessions, so session 2 shows the arrival, the welcome and the
  milestone.

## Phase F: Report, privacy, docs, acceptance

- **F1.** The D17 report block, in Reports and in `buddy-report-card.tsx`.
- **F2 (web).** The D18 privacy paragraphs.
- **F3.** Docs:
  - `docs/buddy.md` (a Community section);
  - `docs/ui-copy.md` and `docs/buddy-onboarding-copy.md` (D8 copy);
  - `docs/buddy-commands.md` (D16);
  - the design skill (the Stream Manager chips, the viewer card, the
    Community tab, and the Buddy page's tab list in "Where things live").
- **F4.** Platform terms: read the current Twitch, Kick and X developer
  terms first-hand, record quotes in this plan, and get the owner's legal
  read on D3 and D13. **STOP before release without it.**
- **F5.** Acceptance:
  - `pnpm smoke:local-gates`;
  - `pnpm smoke:recording-studio`;
  - `pnpm probe:comments-window`;
  - by eye in light and dark;
  - two real streams on the live lab (plans 176 and 178), with a second
    account chatting in both. Stream 2 shows "Regular", the wave, a forced
    milestone (threshold 2) and `!forgetme`.

## STOP conditions

- The first-chat marker changes for any existing row or test.
- Chat delivery waits on the community store, or a live chat latency test
  regresses.
- A YouTube viewer's data older than 30 days survives a prune.
- Chat posting Off sends anything to chat.
- A memory or note reaches the stream or chat outside the tick's existing
  safety path and the streamer's mode.
- Community data leaves the computer outside the Premium memory pass and the
  tick, or is stored on Videorc servers.
- A name history is kept anywhere.
- A new optional field serializes as `null` (the serde trap that took the
  app down three times).
- The Buddy page moves, or loses a feature (owner call).

## Out of scope (later)

1. **Linking one person across platforms** ("Same person?" when names match
   exactly, then a manual link).
2. **Syncing the community** across computers through the account. That
   needs the F4 legal read and a server store.
3. **Lurkers** (people who never chat), through Twitch's chatters API
   (`moderator:read:chatters`).
4. **Viewer-facing readouts** (`!buddy` saying what it remembers),
   leaderboards, and an end-of-stream "thanks, regulars" card.
5. **Changing plan 055's chat retention** (Open question 2).
6. **Importing history** from other bots.

## Open questions for the owner

1. **Platform terms.** YouTube data is kept 30 days, Twitch, Kick and X
   data 12 months after the last chat, AI memories are off for YouTube
   viewers, and a legal read happens before release. OK?
   *Recommended: yes.*
2. **YouTube chat today.** Videorc already keeps YouTube chat on the
   computer forever (plan 055), which YouTube's 30-day rule doesn't allow.
   Fix it in a small separate plan? It would prune YouTube chat after 30
   days, and YouTube's "First chat" would then mean "first in 30 days".
   *Recommended: yes, separately.*
3. **Free versus Premium** as in D19: regulars, gestures and milestones are
   free; Buddy remembers is Premium. *Recommended: yes.*
4. **"Buddy remembers" starts OFF**, offered once after the first stream
   with regulars. *Recommended: yes.*
5. **Gestures on by default:** the wave plus the "Welcome back" bubble on
   stream, with no chat posts unless the mode allows. *Recommended: yes.*
6. **The tab** is named Community and sits after Chat. *Recommended: yes.*
7. **`!forgetme` and `!rememberme`** are always on. *Recommended: yes.*
8. **Numbers:** a regular is 3 streams in 90 days; milestones are 5, 10,
   25, 50, 100, 250 and 500 streams, 3, 5, 10 and 20 in a row, and yearly.
   *Recommended: yes.*
9. **Pull requests** as in D20: a new desktop PR, and a web PR stacked on
   #79. *Recommended: yes.*

## Handoff (cold start)

- **Goal:** Buddy knows, celebrates, and (Premium) remembers a streamer's
  regulars, within the platform rules above.
- **State:** nothing is built. The desktop base is `origin/main`
  `3d16f3dc`. The web base is #79 (`e8776912`), where tick v4 lives.
- **Route:** Orchestrator. Phases A and E on `fable-5.1`, Phases B to D on
  `opus` with the design skill.
- **Order:** A, B, C and D (one desktop PR), then E1, E2 and F2 (web PR,
  deployed after #75 and #79), then E3 to E5 and F (a second desktop PR).
- **Read first:**
  - `live_chat.rs:3160-3260` (the first-chat marker);
  - `storage.rs:6763-7260` (schema and migrations);
  - `cohost_greetings.rs`, `cohost_throttle.rs` and `cohost_auto_chat.rs`;
  - `buddy_animator.rs:1040-1110` and `buddy_pet.rs:1330-1375`;
  - `comment_highlight.rs`;
  - `comment-row.tsx:640-930` and `cohost-pane.tsx:1015-1075`;
  - web `lib/ai/cohost.ts` on #79.
- **Verification:** the phase gates above, then F5.
- **Blockers:**
  - Open questions 1 and 3 before Phase E;
  - F4 before release;
  - the #75 and #79 deploy before the second desktop PR.
