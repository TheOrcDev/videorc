# Sidekick

Sidekick is the helper only you see (plan 119 as Orcle, renamed and made
yours in plan 164, called Golem until plan 171 and Buddy until plan 236,
because speech to text heard "Buddy" as "body"). It reads your chat, hears
you, catches questions, drafts replies, flags spam, removes a comment when
you tell it to, takes voice commands and writes a report of each stream. It
is part of Videorc Premium, with Cloud AI.

Until plan 239 the name covered two things. The character on your stream is
now your **avatar**, with its own page and its own doc,
[avatar.md](avatar.md). One rule joins them: **Sidekick writes, the avatar
says.** Sidekick's lines come out in your avatar's bubble, in its voice;
without an avatar on the picture, questions, flags, drafts, removals, voice
commands and reports still work.

The code, wire and storage name is `cohost`, and names a program reads keep
`buddy` (`/api/buddy/*`, `cohost.buddy*`, `buddy_say`, `set_buddy`,
`videorc://buddy`, the page id `ai`, the tab id `live`, saved values, file
names; plan 236 D1). Everything a user reads says Sidekick for the helper
and avatar (or its own name) for the character: never co-host, and
no longer Buddy, Orcle or Golem.
The stone golem creature keeps its own words (plan 171 D2, D4): its official
slug and id are `golem` and `official:golem`, its kind is "Golem", and its
name is Flint (plan 239 D2; it was Sidekick the Golem until then). Saved and
wire values keep `orcle` (plan 170 D22): the moderation source
`orcle-voice`, the service-flags `orcle` key and the `videorc.orcleTab`
storage key.

Sidekick wears its own plain glyph, `BuddyPageIcon` (Phosphor UserSound),
wherever it shows: the sidebar row, ⌘K's Sidekick group, the Stream
Manager pane's header and cards, the Studio's session row, Library's
"Sidekick report", and a `SidekickMark` tile on its page's status row and in
the Sidekick Live consent dialog (plan 239 D7). The owner's stone golem
artwork (`BuddyIcon`, `BuddyEmblem`) belongs to the default avatar, Flint.

## The promise

**Sidekick never posts in your chat on its own** (plan 211 D6). Its lines
show in your avatar's bubble on stream. A Suggest card posts only when you
click it. It removes a comment only when you tell it to.

Everything Sidekick posts goes out **as you**, on your own account, on the
platforms you stream to (D3). There is no bot account.

## Where things live

| Place                                                                              | Job                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sidekick page** (sidebar, Livestream group, under Avatar, ⌘8, or ⌘9 with Guests) | Sets up the helper. **Overview**: the status row with Sidekick's glyph, Sidekick Live and Open Stream Manager; the Sidekick Live section with listening; What Sidekick does; and Cloud AI, its one home. **Chat**: Replies (Answers, Banter, Write greetings with AI, Reply tone) and Moderation. **Community** (plan 225): the people who chat, regulars, links, settings, Export… and Import…. **Voice**: voice commands. **Reports**. **Clean cut**. |
| **Avatar page** (sidebar, Livestream group, above Sidekick, ⌘7, or ⌘8 with Guests) | The character Sidekick speaks through: My avatars, name, personality, About you, the look, reactions, motion and its greeting lines. See [avatar.md](avatar.md).                                                                                                                                                                                                                                                                                        |
| **Stream Manager** (⇧⌘J, the Sidekick pane, ⌘J)                                    | Operates live. The Sidekick block: Sidekick Live, the command strip, Suggest cards, questions, flags, "Welcome back" (the regulars who just arrived, with Wave) and the "Linked … Undo" card. The Avatar block at the foot: "{name} talks" (Off, Bubble, Suggest) with its chips, the Say box, the reactions and "{name} on stream".                                                                                                                    |
| **Scene page** (⌘3, the Live Scene canvas)                                         | Places your avatar. See [overlays.md](overlays.md).                                                                                                                                                                                                                                                                                                                                                                                                     |

Each control has one home. The Sidekick page keeps Community, Reports, Clean
cut and every other feature: it shows what Premium does (owner call
2026-10-10, kept by plan 239). Sidekick Live is the one switch shown twice,
in Sidekick → Overview's status row and in the Sidekick block's header; both
flip the same setting. The page reopens on the tab used last
(`videorc.orcleTab`), and ⌘K lists every tab under "Sidekick".

## Free and Premium

| Feature                                                                                   | Needs                                              |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Sidekick Live: reading chat, questions, flags, promises                                   | Premium + Cloud AI consent                         |
| Voice commands, "Sidekick, …" and `/sidekick`                                             | Premium + Cloud AI consent                         |
| Greetings written by AI in your avatar's voice                                            | Premium + Cloud AI consent                         |
| Answers                                                                                   | Premium + Cloud AI consent                         |
| Banter                                                                                    | Premium + Cloud AI consent                         |
| Sidekick remembers (memories, welcomes and the audience summary with them)                | Premium + Cloud AI consent + Sidekick Live consent |
| Community: who comes back, regulars, chips, the person card, linking, the report's counts | Nothing (plan 225 D6)                              |
| Remove from chat in a comment's ⋯ menu, `/marker`                                         | Nothing                                            |
| Community sync                                                                            | Premium (a later update)                           |

(D6, owner decision 2026-10-08; plan 225 D6, owner 2026-11-08; pricing
unchanged by plan 239.) Your avatar is free except a look made with AI and
creating an Alive avatar: [avatar.md](avatar.md#free-and-premium).

## Sidekick Live and the consent

Two separate controls (plan 174 D7): Sidekick Live, Sidekick's own switch,
and "{name} talks", your avatar's (below).

**Sidekick Live** is the on switch: whether Sidekick joins your streams and
reads your chat. It sits in the status row that leads Sidekick → Overview
and in the Sidekick block's header in Stream Manager; both flip the same
setting (`enabled`). It never names the microphone: listening is its own
choice (the listening card, and the Sidekick Live section of Sidekick →
Overview).

Where Cloud AI consent is missing, the Sidekick pane says what consent
covers and "Allow cloud AI…" opens the consent dialog; its Allow grants
consent and turns Sidekick Live on, and the listening card then asks about
the microphone separately.

Sidekick's chat producer starts with the stream's live chat and stops with
it. The status row on Sidekick → Overview says where Sidekick stands: Off;
On ("Joins your next stream"); Reading chat while you're live; or Needs
attention, with a plain reason (sign in, Premium, Cloud AI off, or a pause
or error from the Sidekick server).

## How Sidekick talks through your avatar

**"{name} talks"** (`Off | Bubble | Suggest`) sits in the Avatar block of
the Sidekick pane and is named after your avatar ("Flint talks"). It
governs what is said on its own, the free greeting lines and Sidekick's
lines alike, with the chosen value's meaning as a line under it that names
who speaks. It saves `{autoChat}` alone, so it never turns Sidekick or its
microphone on (plan 174 S0.2). The order runs from least reach to most
(plan 211 D1).

- **Off**: nothing is said on its own.
- **Bubble** (the default): greetings and Sidekick's lines show in your
  avatar's bubble on stream. Nothing goes to chat. Bubble speaks only while
  your avatar is on an output; off the picture a greeting is skipped
  (`no-bubble` in the report), an answer is skipped with a log line, banter
  is never asked for, and no AI call is spent (D9).
- **Suggest**: every line becomes a card in the Sidekick pane; one click (or
  ↵ on the newest) posts it in chat as you, ⌫ dismisses it, and a card
  leaves on its own after 45 s. Nothing shows on stream before the click;
  your avatar says the line in its bubble when it lands.

Each behaviour has one home (plan 174 F-24): the greeting lines are your
avatar's (Avatar → Greetings), and Answers, Banter and Write greetings with
AI are Sidekick's writing (Sidekick → Chat → Replies). The Avatar block
shows them as read-only chips: Greetings opens Avatar → Greetings, Answers
and Banter open Sidekick → Chat. "Greetings on · AI" shows only while
Sidekick may write them (Premium and Cloud AI allowed) and the switch is on.

Bubble asks nothing, because nothing is posted as you. The first time
Suggest is chosen, the consent dialog asks "Let {name} post as you?" and
says: "{name} posts to your chats as you, on the platforms you stream to,
only when you click its card. You can read every message later in Sidekick
→ Reports." The window remembers the consent
(`videorc.buddyAutoChatConsent`). There is no Auto and no second confirm
any more (plan 211 D5).

Where people start (D4): a new install starts in Bubble. A profile saved on
Auto before plan 211 reads as Bubble, which never posts; saved Off stays Off
and saved Suggest stays Suggest. The backend keeps writing the legacy
`autoChat.mode` for older apps (Bubble is written as `off`, never `auto`),
and `autoChat.talk` is the one truth (D3).

### When your avatar is off the picture (plan 239 D3)

On air with your avatar on no output, the Avatar block says "{name} isn't
on stream." with **Show on stream**, the same switch as "{name} on stream".
In Bubble the detail reads "Viewers can't see its bubble, so Bubble says
nothing."; otherwise "Viewers can't see it, its bubbles or its reactions."

While Sidekick Live is on and Sidekick writes lines (Answers, Banter or AI
greetings on) in Bubble, those lines have nowhere to show. The notice then
says "Viewers can't see its bubble, so Sidekick's lines have nowhere to
show. Show it, or use Suggest to post them as cards." and offers **Use
Suggest** beside **Show on stream**. Use Suggest switches "{name} talks" to
Suggest through the same posting consent the control asks (one
`useBuddyTalkRequest` for both). The engine is unchanged: nothing reroutes
by itself, and Bubble still means one thing.

## What Sidekick writes

Your avatar's free greeting lines are in
[avatar.md](avatar.md#greetings-avatar--greetings). Sidekick writes three
kinds of line, all Premium with Cloud AI, all needing Sidekick Live and a
consented tick session:

- **Write greetings with AI** (on by default; Sidekick → Chat → Replies
  since plan 239): Sidekick writes each greeting itself in your avatar's
  voice (`POST /api/ai/cohost/greet`, 3 s budget). Your line on Avatar →
  Greetings is the example and the fallback: if the AI fails, is slow or is
  not allowed, the line goes out instead. The first AI greeting of a stream
  may add that viewers can ask your avatar by name. Reports tag each
  greeting AI or Line.
- **Answers** (on by default since plan 192): when a viewer asks your
  avatar by name (`@<name>` or its name in the message), the drafted reply
  becomes a line. A question that doesn't name it gets a reply only when it
  has been open a minute, you haven't answered it, and your About you
  answers it (`fromNotes`); otherwise it stays a suggestion in the pane. At
  most one per cooldown (default 20 s, 1 to 3,600). Only while the web
  speaks tick contract v4.
- **Banter** (off by default): one short line when your microphone has been
  quiet for 20 s, never within a minute of a greeting or an answer, at most
  one per cooldown (default 4 min). Only on a v4 tick session.

Every utterance has a text and a state. If the overlay is on, it shows in
the bubble; in Suggest the bubble shows only after the card is approved
(D7).

## Posts as you: platforms and caps

A greeting goes only to the platform the event came from, never fanned out.
An answer goes to the platform of the message it answers. Banter and a Say
go to every writable destination (D8).

| Platform | Cap            | Note                                                                |
| -------- | -------------- | ------------------------------------------------------------------- |
| Twitch   | 200 characters | `user:write:chat`                                                   |
| YouTube  | 200 characters | 50 quota units per send; skipped while the plan 094 breaker is open |
| Kick     | 500 graphemes  | `chat:write`                                                        |
| X        | 140 characters | OAuth 1 broadcast chat                                              |

Text is clipped to the strictest platform it reaches with an ellipsis, and
the log says so. Nothing is sent to a destination whose stream leg has
failed (plan 161).

## The throttle (D9)

Per destination, for every automatic line:

| Rule            | Value                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate            | At most 6 automatic sends a minute, never two within 5 s                                                                                                                                                                  |
| Kind cooldown   | first-time welcome 5 s; returning welcome 10 s; follow 10 s; sub, resub, gifted sub, community gift, membership 5 s; cheer, KICKs, Super Chat, Super Sticker 5 s; raid 60 s; watch streak 15 s; Power-up, redemption 10 s |
| Collapse        | More than 3 same-kind events inside a cooldown become one message using `{names}` and `{others}` ("Ana, Bo, Cy and 4 others"); 2 or 3 go out one per cooldown                                                             |
| Community gifts | One greeting to the gifter; the individual gift rows inside it are skipped                                                                                                                                                |
| Dedupe          | One greeting per (destination, viewer, kind) a session                                                                                                                                                                    |
| Fresh only      | An Activity row older than 10 minutes on arrival (a reconnect replay) is never greeted                                                                                                                                    |
| YouTube         | Nothing while the quota breaker is open; automatic sends count against the same budget                                                                                                                                    |
| Failed legs     | Nothing to a destination whose stream has failed                                                                                                                                                                          |
| Answers         | One per `answers.cooldownSeconds` (default 20 s)                                                                                                                                                                          |
| Banter          | One per `banter.cooldownSeconds` (default 240 s), never within 60 s of a greeting or answer                                                                                                                               |

Bubble and Suggest both go through the throttle. In Bubble the bubble is one
destination shared by every platform, so the limits above hold across all
your chats, and a viewer is greeted once per platform a session (plan 211
D7). A Suggest card is the same utterance with `status: proposed`. Held
greetings wait in a bucket and a one-shot pump releases them. How the
bubble paces its lines for reading is in
[avatar.md](avatar.md#your-avatar-on-stream).

An approved card carries a Sidekick-owned `operationId`: its echo in chat is
still yours (the account is yours), but it never counts as "the streamer
replied" (D10). Each send is written to the stream report as it lands, and
each bubble line as it shows.

## Wake words

Say "Sidekick" first: "Sidekick, highlight the comment from coders X".
Speech to text also writes "side kick" or "side-kick", even split over two
captions, and all of them work, as do "sidekicks" and "sidekick's" (plan
236 D2). The app teaches "Sidekick" alone (plan 239, owner decision 5): the
name is your avatar's, and Sidekick is the one that listens. Your avatar's
own name still wakes it, so a streamer who learned "Grum, put this one up"
keeps it: each word of the name (lowercased, ASCII-folded, 3+ letters)
works. The hidden "buddy" and "bodhi" aliases expired after 0.26.1. An
avatar deliberately named "Buddy" still wakes it by that name (D3), without
adding "bodhi" as a transcription alias. "body" is never a built-in wake word, and
the Orcle spellings, "oracle" and "orca" are gone. The commands, with
"Sidekick, show up" and "Sidekick, go away" for your avatar, are in
[buddy-commands.md](buddy-commands.md).

## Reports

**When.** Sidekick saves a report when its session ends: when the stream
stops, or when you turn Sidekick off. Turning it off and on again during
the same stream folds both parts into one report. If the app crashes
mid-stream, that stream has no report. A stream where only greetings ran
still has a report (posts only, `segments: 0`).

**What.** Counts and what became of things, never raw chat or drafts:

- questions caught, answered on air, replied, marked answered, dismissed,
  restored and shown on stream;
- the questions themselves, up to 200: wording, up to five askers,
  platforms, priority and outcome;
- flags raised and dismissed, by kind and severity;
- promises heard, kept, dismissed and reminded, plus up to 20 still open
  when the stream ended;
- first-timers seen and greeted, by voice, in chat or by hand;
- the alerts viewers raised, with the most viewers who said it at once;
- recaps offered, drafted and dismissed;
- **posts** (plan 164): every message Sidekick sent as you, up to 200, with
  the trigger (greeting, answer, banter, say), the text, the platforms and
  the result (sent, partial, failed). Reports → "Posted as you".
- **said** (plan 211 D11): every line your avatar said in its bubble,
  automatic or from the Say box, up to 200, with the trigger and the text.
  Reports → "Said on stream". Omitted while empty, so older reports read
  unchanged.

**Where.** In the local Videorc database (table `cohost_reports`, one row
per session). It is deleted with the recording, and it is never sent to
Videorc. It holds viewer names and question text, so it must never be added
to the support bundle or to any upload.

**Reading it.** Sidekick → Reports shows the newest stream, with a switcher
for recent ones. In Library, a stream's row menu has "Sidekick report",
which opens the tab on that session. A stream Sidekick was off for still
shows its moments and chat totals.

## Community: know your viewers across platforms (plan 225)

**What.** Videorc counts who chats on your streams, on your computer, so
chat shows your regulars and your avatar can welcome them. An **account**
is one identity on one platform (YouTube, Twitch, Kick or X; a Custom RTMP
row is never counted); a **person** owns one or more accounts, and every
count is the person's over the union of their accounts. Per account Videorc
keeps the platform, its public id, the latest display name and avatar link
(never a name history), the first and last chat. Per person: the accounts,
streams chatted in, messages, in a row and best in a row, the support given
(bits, KICKs, gifted subs, sub months, tips by currency, per account and per
stream), the milestones celebrated, your note (300 characters) and the
status (normal, bot, forgotten).

**The numbers (D7, D8).** A **regular** chatted in 3 of your streams in the
last 90 days (set 2 to 10 in Community → Community settings, "Regular
after"). **Back**: the last chat was 30 days or more ago; never for a
YouTube-only person. **Milestones**: the 5th, 10th, 25th, 50th, 100th,
250th and 500th stream; 3, 5, 10 and 20 in a row ("in a row", never
"streak", Twitch's word); one year since the first chat, within a week
after the date, never for a YouTube-only person. Each is celebrated once
per person; when two land together the biggest wins. "In a row" counts only
streams that reached one of the person's platforms.

**Where you see it.**

- **The chat row** carries one quiet chip on the person's first row of the
  stream: "Regular · 14", "Back · 3 wk" (weeks under 8, then "Back · 3 mo")
  or the milestone ("10th stream", "5 in a row", "One year"). "First chat"
  stays as it was (plan 055); a linked person is first-time only when no
  account was seen before. The row's ⋯ menu and a right-click open **About
  {name}**, the person card: the counts, the accounts and their platforms,
  "Same person as…", "Not the same" on a linked account ("Split off"),
  "Mark as bot", "Forget {name}…", your note ("Only you see this. Sidekick
  never changes it.") and, with Premium, what Sidekick remembers.
- **Stream Manager → Sidekick pane → "Welcome back"**: the regulars and
  comebacks who just arrived, 15 minutes at most, with **Wave** (the
  regular reaction on stream and, in Bubble mode, "Hey {name}!" in the
  bubble). A row leaves when you wave, when the bubble welcomed them, or
  when a Suggest welcome card is posted or dismissed. The "Linked {name}
  ({platform}) and {name} ({platform})" card with **Undo** stays 15 minutes
  after a `!link`.
- **Sidekick → Community**: "Your community" (how many people, from how
  many streams, how many regulars), the people list (Everyone, Regulars,
  Linked, Bots; sorted by Streams, Last chat or Name; "Search people"),
  "Links that need you" (name matches Videorc suggests and `!link` words
  that were cancelled or hijacked, each with "Same person" and "Not the
  same"), Community settings and "Your data" (Export…, Import…, the channel
  line with Copy, "Forget everyone…"). The first open reads your past
  streams into the store ("Reading your past streams… 12 of 41").
- **Your avatar on stream.** A regular's arrival makes your avatar wave; in
  Bubble mode the bubble says the regular, comeback or milestone welcome
  (Avatar → Greetings → the welcome kinds). One wave per 20 seconds of
  regulars; every milestone its own moment. "Welcome regulars on stream" off
  makes every arrival the plain returning welcome. "Show milestone cards
  automatically" (off by default) puts the milestone card on stream by
  itself. Nothing goes to chat.
- **Reports** (D15) gain a Community block: regulars back (with the top 10
  names and their linked platforms), new regulars, comebacks, first-timers
  and how many stayed 40 minutes or more, milestones, links made, memories
  learned, opt-outs (counted, never named), and with Premium the audience
  summary.

**Linking one person across platforms (D4).**

- **`!link <word>`**: the viewer types `!link` and one word (4 to 24
  letters, digits, `-` or `_`) in two of your chats on different platforms
  within 10 minutes; Videorc joins the two accounts on your computer. The
  word is single-use and stays burnt for the rest of its window: a third
  account saying it undoes the join and lists all three pairs under "Links
  that need you"; two accounts on the same platform cancel it. This is the
  only way an X account is ever linked. The bubble says "Linked: Ada on
  Twitch and ada_dev on YouTube." in Bubble mode; nothing goes to chat.
- **Same person as…** on the card and in Community: your call, confirmed.
  X accounts are not offered ("X viewers link themselves with !link").
- **Might be the same as {name} on {platform}**: Videorc suggests when two
  names on different platforms match after lowercasing and dropping spaces,
  `_`, `.` and `-`; it never merges on its own, never suggests an X account,
  and never changes a count. "Not the same" dismisses the pair for good.
- **Unlinking**: "Not the same" on the card, Undo on the card in the pane,
  or the viewer's `!unlink`, moves the account into its own person;
  attendance and support are per account, so every count comes back
  exactly. The card's link history shows who linked what and when ("Linked
  with !link", "Linked by you", "Linked from a suggestion").

**How long it is kept (D3).** YouTube accounts: 30 days after their last
chat, rolling; attendance, support, the best run and the milestones they
earned are recomputed daily and at app start, and nothing derived from a
YouTube account leaves the computer. The card says "YouTube viewers are
remembered for 30 days after they chat (YouTube's rules)." Twitch, Kick and
X accounts: 12 months after the last chat. A linked person keeps each
account's own clock and survives while any account does. Deleting a
recording never deletes community data.

**Viewers stay in control (D13).** `!forgetme`, `!rememberme`, `!unlink`
and `!link` always work, in every talk mode, whether or not the store is
on; see [buddy-commands.md](buddy-commands.md#commands-viewers-type-in-chat-plan-225).
`!forgetme` deletes the account's attendance, support, memories and link
events, its name in past reports' Community blocks and its place in the
stream in progress (the chip's row stays as delivered), and keeps a
tombstone (platform and public id only) so the account is never learned
again. "Forget {name}…" and "Forget everyone…" do the same for you;
"Forget everyone" keeps the viewers' own tombstones. The report counts
opt-outs and never names them.

**Sidekick remembers (Premium, D10, off by default).** Offered once after
the first stream regulars came to ("Let Sidekick remember what your
regulars tell it?"). Once per stream, after it ends, the people who chatted
at least twice off YouTube (at most 15, their newest 20 messages each) go to
the memory route with their non-YouTube name, stream count and platforms,
what Sidekick already knows and your note; the answer adds, rewrites or
forgets at most two memories per person (eight in all), each on the account
whose words taught it, and writes two sentences about your audience into
the report. Memories ride a regular's arrival into the welcome your avatar
says and the tick for one delivery, never the wire. You see and delete every
memory on the card ("Forget this memory?").

**Export… and Import…** (Community → Your data) move the whole store as one
JSON file (`videorc-community-<date>.json`, never overwriting the day's
earlier export) through the app's own file pickers. An import merges:
newer names win, attendance and support union, a `!forgetme` tombstone wins
over everything, an account it attaches to a person already here is
recorded as linked by you, and an X account joins an existing person only
when the file held every account of that person.

**Never slow chat down (D14).** The arrival lookup rides the first-chat
marker's blocking read, one read per table per batch; the write is one
transaction after delivery, outside every fence; a store error leaves rows
without a chip and logs once per session.

## Clip that

Say "clip that" while Sidekick hears you (or live captions are on), or
press Mark clip: in the Stream Manager, from a Stream Deck or the phone
remote, or with the Mark clip shortcut from Settings → Shortcuts. The toast
reads "Clip marked at 12:34. It's in your stream report in Sidekick."

Marks are saved only while Videorc records to a file. With Record off, the
toast says the clip can't be saved.

The report shows them as **moments**: every mark, plus up to three chat
peaks, each snapped to the transcript with an excerpt. Moments are worked
out when the report is read and never stored. There is no clip file export.

Session markers ("Sidekick, make a marker here for [title]", or the free
local `/marker [title]`) are covered in [session-markers.md](session-markers.md).

## Where Sidekick works live

Live, Sidekick works in the Stream Manager window (⇧⌘J), in its Sidekick
pane. At Wide (1,040 px and up) the pane is the Sidekick tab of the right
pane, beside Chat (Activity · Sidekick); narrower, it is the third tab after
Chat and Activity. ⌘J opens the Sidekick tab and focuses its list. The pane
is keyboard-first: ↑ and ↓ move, R drafts a reply, H shows the question on
stream, A marks it answered, ⌫ dismisses and ⇧⌫ removes a flagged message
from chat.

The pane is two blocks (plan 239), and nothing shows twice:

- **The Sidekick block** is on top and takes the height. Its header shows
  Sidekick's glyph and name, the Alpha tag, listening, the status and the
  Sidekick Live switch; the command strip, the cards, the listening card and
  the triage list follow.
- **The Avatar block** sits at the foot under one hairline: your avatar's
  identity (the living preview, the name, the bubble while one is up),
  "{name} talks" with its chips, then the Say box, the reaction chips and
  the "{name} on stream" switch, with the off-the-picture notice above them
  when it applies.

In a short window the pane scrolls as a whole. Sidekick → Overview's status
row has "Open Stream Manager" (⇧⌘J).

## Consent: Cloud AI

Cloud AI has one home: the Cloud AI section of Sidekick → Overview ("What
Sidekick, creating avatars and Clean cut send to Videorc's cloud, and what
is kept."). It is the only place to revoke it. The consent dialogs (Sidekick
Live, Clean cut, Chat posting in Stream Manager) can grant it too, and all
write the same stored choice (`videorc.aiConsent`). There is no second
consent store. A change applies to a stream that is already live.

What Cloud AI covers (`CLOUD_AI_USES`, one list everywhere):

- Sidekick reads your live chat with Videorc's cloud AI.
- Sidekick hears you while you're live: your microphone audio goes to
  Videorc's cloud speech-to-text and comes back as text (even with live
  captions off).
- Creating an avatar: your description and any picture you add go to
  Videorc's cloud AI, and the picture is used once and not kept. The avatars
  you create (their pictures, name, personality and About you) are kept in
  your Videorc account so you can use them on any computer, until you delete
  them or your account.
- Creating an Alive avatar: your reference picture and its description go
  to Videorc's cloud AI. Its moves are kept on this computer and, for an
  avatar you made that's in your library, in your Videorc account too, so it
  moves on any computer, until you remove them or delete the avatar or your
  account.
- Sidekick's lines: with Answers, Banter or AI greetings on, they are
  drafted by Videorc's cloud AI. Your avatar says them in its bubble, and
  one is posted on your own account only when you click its card in
  Suggest.
- Clean cut uploads a recording's audio, never the video, in short chunks
  for a word-by-word transcript, and sends its sentences to Videorc's cloud
  AI to find retakes. Neither is kept on Videorc servers after the job
  finishes.

What is kept, and where:

- Videorc servers don't keep your chat or your audio.
- When you record, the transcript is saved next to the recording
  (`<recording>.srt`) on this computer.
- A short report of each stream is saved on this computer.

Posting consent (Suggest) is separate: it lives in the Stream Manager
window's storage (`videorc.buddyAutoChatConsent`) and covers sending, not
cloud use. Bubble needs no consent: nothing is posted.

## For developers

The avatar's side (the persona, the look, the library, the overlay state
machine and the sprite) is in [avatar.md](avatar.md#for-developers).

Settings and live state:

- `cohost.settings.get` and `cohost.settings.set`; a Stream Manager command
  saves `cohostEnableRelayPatch` (`lib/cohost-state.ts`): `enabled` only
  when it changes, `listen: true` only when the command names it with
  Sidekick on, `autoChat` when it carries one. So a mode change from Off
  saves `{enabled: true, listen: true, autoChat: {...}}`, a behaviour switch
  `{autoChat: {...}}`, and Off `{enabled: false, autoChat: {mode: 'off'}}`.
- `cohostSettings.autoChat` holds `talk`, the legacy `mode`, `greetings`
  (the avatar's lines, [avatar.md](avatar.md#for-developers)), `answers
{enabled, cooldownSeconds}` and `banter {enabled, cooldownSeconds}`. Talk
  is Bubble by default (written to the legacy mode as `off`); Greetings and
  Answers are on, Banter is off. It rides
  `cohost.settings.get/set` as a whole object; the backend refuses a bad one
  with `cohost-auto-chat-invalid` (`cohost.rs::validate_auto_chat`).
- The `cohost.state` event carries the live pane, plus `utterances[]`
  (oldest first, at most 20, omitted while empty) and `autoChatSends`
  (omitted while zero).
- Wake words: `cohost_command::WAKE_WORDS` = `["sidekick", "sidekicks"]`
  plus the persona's name tokens, which live in a
  process-wide slot set on every settings change. `joined_wake` turns "side
  kick" and "side-kick" into "sidekick" before anything looks for a wake
  word: inside one final, and across two finals within
  `NAME_CARRY_MAX_GAP`; the marker grammar and the planner's comment check
  join them the same way. The renderer teaches "Sidekick" alone
  (`BUDDY_WAKE_WORDS_LINE`, plan 239).

Automatic chat (Phase D):

- Backend: `cohost_greetings.rs` (facts, templates, collapse),
  `cohost_throttle.rs` (pure, clock-injected), `cohost_auto_chat.rs` (the
  lane: the talk mode, bubble lines, proposals, answers, banter, the Say
  box), the bubble queue in `buddy_overlay.rs` (plan 211 D7), and in
  `cohost.rs` the pump that releases held greetings and `send_approved`, the
  one path from the lane to chat: a clicked Suggest card. The lane has no
  send of its own (`AutoChatPass.send` is gone, D2). The lane is
  engine-wide and follows the live-chat session, not the Premium tick
  session, because greetings are free. `off` produces nothing from any
  method; `bubble` never sends. AI greetings, Answers and Banter need
  Premium, Sidekick Live and a consented tick session (`greet_ai_context`,
  `prepare_tick`, `prepare_banter`).
- Every send is `live_chat::send_live_chat_message` with a Sidekick-owned
  `operationId` registered on the lane; `live_chat.rs` skips
  `note_own_send_delivered` for it (no question closes, nobody is marked
  greeted) but still notes the echo.
- Utterance on the wire: `{id, text, state, trigger: {kind: 'greeting' |
'answer' | 'banter' | 'manual', eventId?, messageId?}, destinationIds,
status: 'proposed' | 'sent' | 'dismissed' | 'bubble-only' | 'failed', at,
expiresAt?}`. Empty `destinationIds` means every writable destination.
- RPCs: `cohost.utterance.approve` / `cohost.utterance.dismiss`
  `{sessionId, utteranceId}` and `cohost.utterance.say {sessionId?, text,
state?}` (mutations). Without a `sessionId` (no live chat) a Say line is
  recorded `bubble-only`; a named session must be the live one
  (`cohost-session-mismatch`).
- Tick v4: the desktop sends `promptVersion: 4` with `persona {name,
personality}` only when `/api/ai/capabilities` reports `cohost.tick: 4`
  (`cohost::set_tick_capability`); otherwise v3 goes out exactly as before.
  The ladder is `[4, 3, 2, 1]`; `prompt-version-unsupported` steps 4 → 3 and
  the persona leaves. v4 replies carry `addressed` and `mood` per question;
  `intent: banter` returns `banter {text, mood}`. Mood → state: amused →
  laugh, thinking → think, neutral → talk.
- Stream Manager relay: `cohost-enable` carries an `autoChat` block (`talk`
  and the three switches; the legacy `mode` is refused at the relay, and
  only the backend's `normalize_talk` writes it); `cohost-action` kinds
  `approve-utterance`, `dismiss-utterance`, `say-utterance` (with `text` and
  `state?`) follow the session kinds (approve sends to chat; say is bubble
  only).
- Reports: `CohostSessionReport.posts[]` (`{id, at, trigger, text,
destinations, result}`, cap 200, omitted while empty) written as each send
  lands through `Database::append_cohost_report_post`, and `said[]` (`{id,
at, trigger, text, source?}`, plan 211 D11, same cap, omitted while empty)
  written as each bubble line shows; `merged_with` unions both by id.

The report:

- `cohost.report.get {sessionId}` returns
  `{sessionId, report, moments, chat: {messages, byPlatform}}`. `report` is
  `null` when Sidekick left none for that session.
- `cohost.report.latest` takes no params and returns the same payload for
  the newest session that has a report, else the newest streamed session, or
  `null` when there is neither.
- The `cohost.report.saved {sessionId}` event fires when a report is written
  or folded into the one already there.

The report format is `CohostSessionReport` with `version: 1`
(`crates/videorc-backend/src/protocol.rs`), mirrored in
`apps/desktop/src/shared/backend.ts` with closed validators in
`apps/desktop/src/shared/backend-rpc-contract.ts` and a fixture in
`protocol-fixtures/high-risk-contracts.json`. A stored report with another
version reads as no report, never as an error. Optional fields are omitted,
never null.

Code:

- Backend: `cohost.rs` owns the engine, the lane and the report (built in
  `stop_session`, saved after the engine lock is released); `moments.rs`
  ranks moments; `transcript.rs` parses the `.srt`; `storage.rs` owns
  `cohost_reports`.
- Renderer, all under `apps/desktop/src/renderer/src/`:
  `components/tabs/buddy-tab.tsx` (the page, id `ai`) with
  `lib/buddy-tab-view.ts` and `lib/buddy-tabs.ts` (tabs Overview, Chat,
  Community, Voice, Reports, Clean cut; the first keeps its id `live`);
  `components/sidekick-mark.tsx`; `components/cohost-settings-section.tsx`
  (Replies, with Write greetings with AI, and Moderation);
  `lib/buddy-auto-chat-view.ts` (the pure side of the talk control and the
  chips, `BUDDY_BEHAVIOUR_HOMES`); `lib/buddy-output-notice.ts` (the
  off-the-picture notice and `sidekickWritesLines`, D3);
  `components/cohost-pane.tsx` and
  `components/stream-manager/buddy-chat-controls.tsx` (the talk control and
  the one posting consent, `useBuddyTalkRequest`) in Stream Manager;
  `components/buddy-report-card.tsx` with `lib/buddy-report-view.ts` and
  `hooks/use-buddy-report.ts`.

Checks:

- `pnpm smoke:cohost-fake` runs Sidekick against a fake server and asserts
  the saved report's counts (it has no capabilities route, so the desktop
  sends v3 there).
- `pnpm smoke:live-chat-fake-providers` ends with the Sidekick scenarios
  (plan 211): in Bubble with your avatar on stream and no lines of the
  user's own, a fake follow's built-in line and five first-time chatters
  across Twitch and Kick show as three bubble lines (the first welcome, a
  collapsed welcome for the burst, the follow), with zero sends, `said[]` in
  the report and no `posts[]`; in Suggest one card, approved over
  `cohost.utterance.approve`, lands as exactly one send and one post; with
  talk `off` nothing is said or sent.
- `pnpm smoke:buddy-commands` covers the wake words.
- `cargo test -p videorc-backend cohost` covers the settings round trip, the
  greeting engine, the throttle (a 50-follow burst: one now, one collapsed at
  +10 s, the rest deduped), the lane and the bubble state machine.
- `node scripts/capture-ui-pages.mjs` captures the pages in its list and
  opens the Sidekick page by its id `ai`; `--theme=light` or `--theme=dark`
  switches the app first and adds the theme to every file name.
