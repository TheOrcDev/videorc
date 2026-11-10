# Chat commands

Viewers type `!go` in chat and Videorc answers as you, with the reply you
saved, starting with their @name, in the chat they asked in (plan 226).
`!commands` lists every command with its description. Free for everyone.

## Using it

- **Set up** in Setup → Livestream → Chat commands. From the Stream
  Manager: type `!` in the composer and pick "Edit chat commands…", or use
  the bar's **Commands** action (800 px and wider) or ⋯ → "Chat commands…"
  (below 640 px). Each command has:
  - **Name**: `!go`. Letters, numbers, `_` and `-`, up to 24 characters,
    any case in chat.
  - **Description**: "why I'm learning Go", up to 60 characters. `!commands`
    shows it.
  - **Reply**: one line, up to 170 characters, so `@name ` still fits in
    one 200-character message.
  - **On/off**: an off command doesn't answer and isn't listed.
- **What viewers see**: `!go` (or `!GO please`) as the first word gets
  `@coder_x <your reply>`, only in that viewer's chat: a Twitch `!go` is
  answered on Twitch. `why !go`, `!golang` and unknown names get nothing.
- **`!commands`** is built in. It lists your commands A–Z, each with its
  description:

  `@name Commands: !faq (most asked question), !go (why I'm learning Go)`

  When the list doesn't fit one message it drops the descriptions, then
  ends with "and N more". It stays quiet while you have no commands, and
  "Answer !commands" turns it off.

- **From the Stream Manager**: type `!go` and press Enter to post the reply,
  without a mention, to every chat. `!!go` posts the text `!go` itself. The
  composer suggests your commands after `!`.

## Limits

- **Cooldown**: each command answers once every 30 seconds per chat (60 on
  YouTube). Ten viewers typing `!go` at once get one answer.
- **YouTube**: each YouTube post costs 50 of Videorc's daily YouTube units
  (plan 094). Command replies stop at 80 % of the day's budget, so the
  messages you type keep the rest. That allows about 40 YouTube replies a
  day; Twitch and Kick have no such limit.
- **X** takes 140 characters a post, so a longer reply goes out in 2 posts
  there.
- **Never answered**: messages from before the chat connected or older than
  a minute, edits, deleted messages, and Videorc's own posts coming back into
  chat. Your own `!go` typed on the platform's site is answered without a
  mention.
- **Failures**: a reply that can't go out (no permission to post, the
  YouTube limit, a platform error) shows once in the Stream Manager:
  "!go couldn't answer on YouTube: …".
- Buddy doesn't answer a message that starts with one of your commands.

## For developers

- Engine: `crates/videorc-backend/src/chat_commands.rs`, called at the end of
  `live_chat::try_deliver_messages` with no lock held. Matching runs on an
  in-memory copy of the commands; sends are spawned and go through
  `live_chat::send_live_chat_message`, so delivery never waits for a reply.
- Contract: `chatCommands.list | save | delete | setListEnabled | post` and
  the `chatCommands.changed` / `chatCommands.replyFailed` events in
  `apps/desktop/src/shared/backend-rpc-contract.ts`. The wire shapes are
  pinned in `protocol-fixtures/high-risk-contracts.json` (`chatCommand`). The
  rules both languages hold are in `protocol-fixtures/chat-commands.json`.
- Gate: `pnpm smoke:chat-commands` (AGENTS.md).
