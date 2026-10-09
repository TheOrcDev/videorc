# Buddy voice commands

Ask Buddy to put a comment on stream, take it down, or remove it from chat
(plan 140). Buddy never acts on its own. It removes a comment only when you
tell it to.

Voice commands are part of Buddy, which is Videorc Premium. **Remove from
chat** in a comment's ⋯ menu is free for everyone. The binding shapes live in
[buddy-commands-contract.md](buddy-commands-contract.md); this page is how it
works and how to check it.

## What you can say

Say "Buddy" first, or your Buddy's own name (plan 164): "Buddy, highlight
the comment from coders X", or "Grum, highlight the comment from coders X"
when you named it Grum. Every word of the name with three letters or more
works ("Grum the Goblin" answers to Grum and to Goblin); "buddy" always works,
so a name the speech model cannot hear is never a dead end. Two phrases also
work without the name, out of the box: "remove it from our chat" (or "delete
this one") and "highlight the comment from coders X". To always require the
name, turn on **Commands need “Buddy” first**.

| Command   | Examples                                                                                                                                  | What happens                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Highlight | "Buddy, highlight the comment from coders X", "Buddy, put this one up", "Buddy, show the last comment", "Buddy, show coders X's question" | Puts that comment on your stream.                                                           |
| Clear     | "Buddy, take it down", "Buddy, clear the highlight", "Buddy, remove it from the screen"                                                   | Takes the comment off your stream. "From the screen" clears it; "from our chat" removes it. |
| Remove    | "This one is toxic. Remove it from our chat.", "Buddy, delete the comment from coders X"                                                  | Shows you the comment first, and removes it from that platform's chat when you confirm.     |
| Answer    | "Yes", "Do it", "Remove it" / "No", "Cancel", "Never mind"                                                                                | Confirms or stops a removal.                                                                |
| Marker    | "Buddy, make a marker here for Shadcn New Library", "Buddy, mark this as Shadcn New Library"                                                | Saves a titled point on the active recording or livestream timeline.                        |

The old name "Orcle" and its close misses (orkle, orcel, orkel, orcl, orcal)
still wake the Buddy for one release as hidden aliases. Real words never do:
"Oracle database is slow" and "orca whales" are talk. "Buddy" is an everyday
word, so it only wakes the Buddy: "thanks buddy" on its own does nothing, and a
command still needs its phrase after the name. Anything else after a clear
"Buddy" (or your Buddy's name) shows "Buddy didn't catch that: '…'" in the
strip.

Removing a message can't be undone, so an answer has to be clear. "Yes",
"Yes, remove it", "Do it", "Go ahead" or "Buddy, yes" confirms when you say it
on its own. "Okay", "right", "sure" and "yeah" never confirm, and a sentence
that only starts with "yes" is talk, not an answer. A "no", "cancel", "don't"
or "not" anywhere in what you say cancels. A new "Buddy, …" command replaces
the open card instead of answering it.

Chat commands come from what Buddy already hears, so they need Buddy Live on
and a live stream. Named markers also work during a recording without live
chat: enable Buddy, Listen and Cloud AI consent. Marker commands always require
the name. Their confirmation and Undo appear locally, and the points are in
Library → Session actions → Markers. `/marker [title]` in Stream Manager is the
manual alternative and does not require Premium or Cloud AI. See
[Session markers](session-markers.md) for timing, limits and stream-only behavior.

## How Buddy picks "this one"

- **To highlight:** the comment Buddy thinks you are talking about. If there
  is none, the newest open question, then the newest comment.
- **To remove:** the comment on your stream, the newest comment Buddy flagged
  in the last 2 minutes, or the one you are talking about.
- **By name:** the newest comment from that author in the last 10 minutes.
  "Question" prefers their open question.
- **More than one fits:** Buddy asks which. Say "the first one", or press 1, 2
  or 3. "Remove it" with nothing on stream and no recent flag is a chooser of
  the last three comments, never a guess.

Buddy never targets your own messages, a removed message, or a platform
notification row.

## Where you see it

In the Stream Manager's Buddy pane, at the top, above anything that scrolls:

1. **The strip:** "Heard: “…”" and what Buddy did ("Highlighted coders_x's
   comment."). Not found, refused and unavailable read quietly. A finished
   command fades after a few seconds.
2. **The chooser** (keys 1 to 3, Esc cancels), or **"Show it anyway?"** for a
   comment Buddy flagged with high severity (Enter shows, Esc cancels).
3. **The removal card:** the author, the platform, the words and the reason
   ("toxic").

A new card brings the Buddy pane forward without moving your focus. Enter and
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
  to a command you start with "Buddy". "Remove it from our chat" without the
  name, or a request Buddy had to work out in the cloud, always waits for
  your yes.
- **YouTube always asks you to confirm**, in both modes (YouTube API policy:
  express consent before a delete).
- **Remove from chat** in a comment's ⋯ menu, or on a flag in the Buddy pane
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

In every case, if the platform cannot remove it, Buddy hides it in Videorc and
tells you viewers may still see it. The row then reads **Hidden in Videorc**,
with the reason on hover. A removed row reads **Removed**.

The Buddy tab's **Voice commands** section shows each connected platform's
"Remove messages" readiness with its one fix, and the Stream Manager shows a
quiet "Reconnect Twitch to let Buddy remove messages." row while live.

## Settings

Under Buddy Live in the Buddy tab, **Voice commands**:

- **Commands need “Buddy” first** (`wakeWordRequired`, default off).
- **Before Buddy removes a comment:** Confirm first or 5-second countdown
  (`removeConfirm`, default `confirm`).

## Videorc's switches

Videorc can pause either half remotely (desktop service flags, contract part
D). The Buddy tab then says so:

- "Voice commands are paused by Videorc." Buddy stops acting on commands.
- "Removing messages is paused by Videorc." Voice removals are refused.

Remove from chat in the ⋯ menu keeps working.

## Privacy

Buddy understands commands on your computer, from the words it already hears.
A removal goes from your computer to the platform, with your account. When
Buddy hears its name but cannot work out the command on your computer, it may
send that sentence and up to 20 recent comments to Videorc's cloud AI to work
out what you meant (only once that parser is turned on); they are not kept
after the response, and Videorc keeps only a usage count.

## Report

The Buddy report's **Commands** row counts what voice commands did:
highlighted, cleared, removed, hidden in Videorc, cancelled, no answer, failed
and not found. Counts only, never names or words.

## Troubleshooting

| You see                                          | Why                                                                                    | Fix                                                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Nothing happens when you speak                   | Chat commands need Buddy Live and a live stream. Voice markers need an active recording or stream with authorized listening. | For chat commands, turn on Buddy Live. For markers, enable Buddy, Listen and Cloud AI consent; check the listening dot. |
| "Buddy didn't catch that"                        | The words after "Buddy" were not a command.                                            | Use a phrase from the table.                                   |
| "Hidden in Videorc"                              | The platform couldn't remove it (permission, quota, message too old, broadcast ended). | Hover the chip; reconnect the platform if it says so.          |
| "Not removed" or "Unconfirmed"                   | The platform refused, or didn't answer in time.                                        | Hover for the reason; check the platform's chat.               |
| A "remove it from our chat" fires while you talk | The wake-word-free phrases are on.                                                     | Turn on Commands need “Buddy” first.                           |
| "Removing messages is paused by Videorc."        | Videorc's remote switch.                                                               | Use Remove from chat in the ⋯ menu.                            |

Checks: `pnpm smoke:buddy-commands` (plan 140, S9) and the removal steps in
[live-chat-live-smoke-checklist.md](live-chat-live-smoke-checklist.md).

The smoke drives the real debug backend with fakes only. Its fake chat lanes
(`liveChat.start` `fakes`, debug input never sent to a renderer) take two
optional fields: `authors` (names to rotate through instead of "Test Viewer
N") and `delete` (`ok`, `missing-scope` or `not-found`: what the platform
answers a removal; absent, a removal mirrors `send`). The fake YouTube API
answers `liveChatMessages.delete` with 204 and meters it at 50 units, and
`smoke:youtube-quota` proves a removal while paused or with the daily budget
used up is hidden in Videorc without a request.
