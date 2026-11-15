# Sidekick voice commands

Ask Sidekick to put a comment on stream, take it down, or remove it from chat
(plan 140). Sidekick never posts in your chat on its own, and it removes a
comment only when you tell it to.

Voice commands are part of Videorc Premium. **Remove from chat** in a
comment's ⋯ menu is free for everyone. The binding shapes live in
[buddy-commands-contract.md](buddy-commands-contract.md); this page is how it
works and how to check it.

## What you can say

Say "Sidekick" first: "Sidekick, highlight the comment from coders X".
"Sidekick" is the word that starts a command (plan 239, owner decision 5):
Sidekick is the one that listens, and the name you gave your avatar is the
character's. Your avatar's own name still wakes it, for streamers who
learned it in plan 164 ("Grum, put this one up"), but Videorc no longer
teaches it. Two phrases also work without "Sidekick", out of the box:
"remove it from our chat" (or "delete this one") and "highlight the comment
from coders X". To always require it, turn on **Commands need “Sidekick”
first**.

| Command   | Examples                                                                                                                                              | What happens                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Highlight | "Sidekick, highlight the comment from coders X", "Sidekick, put this one up", "Sidekick, show the last comment", "Sidekick, show coders X's question" | Puts that comment on your stream.                                                           |
| Clear     | "Sidekick, take it down", "Sidekick, clear the highlight", "Sidekick, remove it from the screen"                                                      | Takes the comment off your stream. "From the screen" clears it; "from our chat" removes it. |
| Remove    | "This one is toxic. Remove it from our chat.", "Sidekick, delete the comment from coders X"                                                           | Shows you the comment first, and removes it from that platform's chat when you confirm.     |
| Answer    | "Yes", "Do it", "Remove it" / "No", "Cancel", "Never mind"                                                                                            | Confirms or stops a removal.                                                                |
| Marker    | "Sidekick, make a marker here for Shadcn New Library", "Sidekick, mark this as Shadcn New Library"                                                    | Saves a titled point on the active recording or livestream timeline.                        |
| On stream | "Sidekick, show up", "Sidekick, come on screen" / "Sidekick, hide", "Sidekick, go away"                                                               | Puts your avatar on the stream, or takes it off: the "{name} on stream" switch.             |

"Sidekick" also wakes it when speech to text writes "side kick" or
"side-kick", even when the two words land in two captions a moment apart.
The hidden "buddy" and "bodhi" aliases expired after 0.26.1. An avatar
deliberately named "Buddy" still wakes it by that name, but "bodhi" is no
longer an automatic transcription alias. "body" is never a built-in wake
word, and neither are real words:
"Oracle database is slow" and "orca whales" are talk. "Sidekick" only wakes
it: "thanks sidekick" or "my sidekick is great" on its own does nothing, and
a command still needs its phrase after the name. Anything else after a clear
"Sidekick" shows "Sidekick didn't catch that: '…'" in the strip.

The **On stream** commands are about your avatar itself (the presence
grammar in `cohost_command.rs`): "show up", "come on screen", "appear",
"show yourself" or "get on stream" put it on the stream, and "hide", "go
away", "leave the screen", "get off stream" or "disappear" take it off.
They always need "Sidekick" first, and a sentence that points at a comment
("show coders X's question", "show that comment") stays a highlight. They
flip the same switch as "{name} on stream" in the Stream Manager's Avatar
block, and the strip says what happened ("Flint is on stream.", "Flint is
off the stream.").

Removing a message can't be undone, so an answer has to be clear. "Yes",
"Yes, remove it", "Do it", "Go ahead" or "Sidekick, yes" confirms when you say it
on its own. "Okay", "right", "sure" and "yeah" never confirm, and a sentence
that only starts with "yes" is talk, not an answer. A "no", "cancel", "don't"
or "not" anywhere in what you say cancels. A new "Sidekick, …" command replaces
the open card instead of answering it.

Chat commands come from what Sidekick already hears, so they need Sidekick Live on
and a live stream. Named markers also work during a recording without live
chat: enable Sidekick, Listen and Cloud AI consent. Marker commands always require
the name. Their confirmation and Undo appear locally, and the points are in
Library → Session actions → Markers. `/marker [title]` in Stream Manager is the
manual alternative and does not require Premium or Cloud AI. See
[Session markers](session-markers.md) for timing, limits and stream-only behavior.

## Ask Sidekick to do more (plan 209)

When Videorc offers it, a sentence after "Sidekick" that the commands above
don't cover goes to Sidekick's planner: "Sidekick, switch to BRB and play the drum
roll", "Sidekick, put up the sponsor banner", "Sidekick, end the stream". Sidekick
uses the same tools an AI agent connected to Videorc uses (docs/agents-mcp.md),
but only its own share of them: the Look tools, running the show, arranging
the picture, chat and Sidekick itself. Never the Library, settings,
destinations or scheduling. Videorc checks every step against that list on
your computer, whatever the planner said.

- **It asks out loud first** before going live and before stopping a
  recording or a livestream: 'End the livestream? Say "Sidekick, yes".' Say
  "Sidekick, yes" or press Enter; a bare "yes" (a text-to-speech alert could
  say one) leaves the question open. "No", Esc or 20 seconds without an
  answer and nothing more happens. Removing a message uses the removal card
  above, and showing a comment Sidekick flagged asks "Show it anyway?" as the
  highlight command does (typed, Sidekick says it flagged it instead).
- **Type it** in the Stream Manager: `/sidekick switch to BRB` (`/buddy`
  still works, unlisted, for two releases). No "Sidekick" first and no
  spoken yes, because typing is deliberate. The answer shows under the
  composer.
- **The strip** says what happened: "Switched to BRB. Pressed Drum roll."
- **Activity** (Settings → Remote → Agents) lists everything Sidekick did as
  "Sidekick", the voice commands above included.

It is Premium, needs Cloud AI consent, and follows Videorc's voice-command
switch. Without it, or on a free account ("Sidekick requires Videorc
Premium."), everything above works exactly as before.

## Commands viewers type in chat (plan 225)

These are the viewers' own, typed in your chat on YouTube, Twitch, Kick or
X. They always work: in every talk mode, with "Remember my community" on
or off, free or Premium. They are the deletion path the platforms' rules
and GDPR ask for (D13), so they cannot be turned off. Sidekick never answers
in chat: in Bubble mode its bubble says one line on stream; in Suggest and
Off it says nothing, and the command still runs.

| Command        | Exact, any case, trimmed           | What happens                                                                                                                                                                                                                                                                                                                                                                                      | Bubble (Bubble mode only)                                |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `!forgetme`    | `!forgetme`                        | Deletes the account's attendance, support, memories and link events, its name in past reports and its place in the stream in progress; if it was the person's last account, the person, note and milestones go too. Keeps a tombstone (platform and public id) so the account is never learned again. Counted as an opt-out in the report, never named.                                           | "Done, {name}. I've forgotten you."                      |
| `!rememberme`  | `!rememberme`                      | Lifts the tombstone; the account is learned afresh from its next chat.                                                                                                                                                                                                                                                                                                                            | "Welcome back to the list, {name}."                      |
| `!unlink`      | `!unlink`                          | Splits the sender's account off its person into a new one; both sides' counts come back exactly. An account alone in its person: nothing happens, nothing is said.                                                                                                                                                                                                                                | "Unlinked, {name}."                                      |
| `!link <word>` | one word, 4 to 24 of `a-z 0-9 - _` | The same word in two of your chats on two different platforms within 10 minutes joins the two accounts into one person. The word is single-use and burnt for the rest of its window: a third account saying it undoes the join and lists every pair under Community → "Links that need you"; two accounts on the same platform cancel it and are listed. The streamer's own `!link` does nothing. | "Linked: {name} on {platform} and {name} on {platform}." |

`!link` is the only way an X account is ever linked (the viewer's own two
messages are their consent). Pending words live in memory and die with the
stream. Anything else after `!link` ("!link two words", "!link a") is not a
command, and "hello !forgetme" is talk.

## How Sidekick picks "this one"

- **To highlight:** the comment Sidekick thinks you are talking about. If there
  is none, the newest open question, then the newest comment.
- **To remove:** the comment on your stream, the newest comment Sidekick flagged
  in the last 2 minutes, or the one you are talking about.
- **By name:** the newest comment from that author in the last 10 minutes.
  "Question" prefers their open question.
- **More than one fits:** Sidekick asks which. Say "the first one", or press 1, 2
  or 3. "Remove it" with nothing on stream and no recent flag is a chooser of
  the last three comments, never a guess.

Sidekick never targets your own messages, a removed message, or a platform
notification row.

## Where you see it

In the Stream Manager's Sidekick pane, at the top, above anything that scrolls:

1. **The strip:** "Heard: “…”" and what Sidekick did ("Highlighted coders_x's
   comment."). Not found, refused and unavailable read quietly. A finished
   command fades after a few seconds.
2. **The chooser** (keys 1 to 3, Esc cancels), or **"Show it anyway?"** for a
   comment Sidekick flagged with high severity (Enter shows, Esc cancels).
3. **The removal card:** the author, the platform, the words and the reason
   ("toxic").

A new card brings the Sidekick pane forward without moving your focus. Enter and
the number keys only answer while nothing else has focus, so they never fire
from the chat composer or the search field. Esc works anywhere but a text
field or an open menu. Chooser and highlight cards expire after 20 seconds.

When the Stream Manager is closed, the main window shows the removal card as a
plain toast with Remove and Cancel, and it leaves when the removal ends.

## Confirmation

- **Confirm first** is the default. The card waits for "yes", Enter or a
  click. After 20 seconds it expires and nothing is removed.
- **5-second countdown** (opt-in) removes the comment unless you say "no",
  press Esc or click Cancel. **Remove now** skips the wait. It applies only
  to a command you start with "Sidekick". "Remove it from our chat" without the
  name, or a request Sidekick had to work out in the cloud, always waits for
  your yes.
- **YouTube always asks you to confirm**, in both modes (YouTube API policy:
  express consent before a delete).
- **Remove from chat** in a comment's ⋯ menu, or on a flag in the Sidekick pane
  (⇧⌫), runs at once: the click is the consent.

At most 10 removals a minute, one at a time per message. Every removal is an
audited operation, saved on your computer before the platform is called. After
a restart, a removal still waiting for your answer is cancelled, and one that
was running reads "Check chat to see whether it was removed."

## Platforms

| Platform | Removal                                                               | Permission                                                         |
| -------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| YouTube  | Removes it for everyone.                                              | Already held (`youtube.force-ssl`). Paused with the YouTube quota. |
| Twitch   | Removes it for everyone. Messages over 6 hours old cannot be removed. | Reconnect Twitch once for `moderator:manage:chat_messages`.        |
| Kick     | Removes it for everyone.                                              | Reconnect Kick once for `moderation:chat_message:manage`.          |
| X        | Removes it during a live broadcast, where X allows it.                | Authorize X Live.                                                  |

In every case, if the platform cannot remove it, Sidekick hides it in Videorc and
tells you viewers may still see it. The row then reads **Hidden in Videorc**,
with the reason on hover. A removed row reads **Removed**.

Sidekick → Voice's **Voice commands** section shows each connected platform's
"Remove messages" readiness with its one fix, and the Stream Manager shows a
quiet "Reconnect Twitch to let Sidekick remove messages." row while live.

## Settings

In Sidekick → Voice, **Voice commands**:

- **Commands need “Sidekick” first** (`wakeWordRequired`, default off).
- **Before Sidekick removes a comment:** Confirm first or 5-second countdown
  (`removeConfirm`, default `confirm`).

## Videorc's switches

Videorc can pause either half remotely (desktop service flags, contract part
D). Sidekick → Voice then says so:

- "Voice commands are paused by Videorc." Sidekick stops acting on commands.
- "Removing messages is paused by Videorc." Voice removals are refused.

Remove from chat in the ⋯ menu keeps working.

## Privacy

Sidekick understands commands on your computer, from the words it already hears.
A removal goes from your computer to the platform, with your account. When
Sidekick hears its name but cannot work out the command on your computer, it may
send that sentence and up to 20 recent comments to Videorc's cloud AI to work
out what you meant (only once that parser is turned on); they are not kept
after the response, and Videorc keeps only a usage count. Sidekick's planner
(above) gets the sentence, the names of your scenes, banners, takeovers,
sounds and destinations, what the studio is doing, and recent comments only
when the sentence is about one; nothing is kept, only a usage count.

## Report

The Sidekick report's **Commands** row counts what voice commands did:
highlighted, cleared, removed, hidden in Videorc, cancelled, no answer, failed
and not found. Counts only, never names or words.

## Troubleshooting

| You see                                          | Why                                                                                                                             | Fix                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Nothing happens when you speak                   | Chat commands need Sidekick Live and a live stream. Voice markers need an active recording or stream with authorized listening. | For chat commands, turn on Sidekick Live. For markers, enable Sidekick, Listen and Cloud AI consent; check the listening dot. |
| "Sidekick didn't catch that"                     | The words after "Sidekick" were not a command.                                                                                  | Use a phrase from the table.                                                                                                  |
| "Hidden in Videorc"                              | The platform couldn't remove it (permission, quota, message too old, broadcast ended).                                          | Hover the chip; reconnect the platform if it says so.                                                                         |
| "Not removed" or "Unconfirmed"                   | The platform refused, or didn't answer in time.                                                                                 | Hover for the reason; check the platform's chat.                                                                              |
| A "remove it from our chat" fires while you talk | The wake-word-free phrases are on.                                                                                              | Turn on Commands need “Sidekick” first.                                                                                       |
| "Removing messages is paused by Videorc."        | Videorc's remote switch.                                                                                                        | Use Remove from chat in the ⋯ menu.                                                                                           |

Checks: `pnpm smoke:buddy-commands` (plan 140, S9), `pnpm smoke:buddy-act`
(plan 209 S21: `/buddy`, the subset, and a spoken stop that waits for a
yes) and the removal steps in
[live-chat-live-smoke-checklist.md](live-chat-live-smoke-checklist.md).

The smoke drives the real debug backend with fakes only. Its fake chat lanes
(`liveChat.start` `fakes`, debug input never sent to a renderer) take two
optional fields: `authors` (names to rotate through instead of "Test Viewer
N") and `delete` (`ok`, `missing-scope` or `not-found`: what the platform
answers a removal; absent, a removal mirrors `send`). The fake YouTube API
answers `liveChatMessages.delete` with 204 and meters it at 50 units, and
`smoke:youtube-quota` proves a removal while paused or with the daily budget
used up is hidden in Videorc without a request.
