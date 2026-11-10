# Plan 226: Chat commands (!go, !faq, !commands)

A streamer's request (2026-11-10): viewers type `!go` in chat, and Videorc
answers as the streamer with a reply they wrote, starting with the viewer's
@name. `!commands` lists every command with its one-line description.

Each command has three fields:

| Field       | Example                                         |
| ----------- | ----------------------------------------------- |
| Name        | `!go`                                           |
| Description | why I'm learning Go                             |
| Reply       | the long explanation, sent as `@viewer <reply>` |

## Status and scope

- **Status: PLANNED 2026-11-10, not started.** Base: `origin/main`
  `b62ff1063`. The plan is in `~/projects/videorc-wt-226`, branch
  `plan-226-chat-commands`.
- **Free.** No Premium gate. Every chat bot gives this away, and plan 221
  keeps the free promise.
- **Not in v1:** variables (`{user}`, `{uptime}`), per-command cooldown
  settings, moderator-only commands, timers (posting a line every N minutes),
  aliases, Buddy voice, ⌘K, the phone remote, Stream Deck and agent (MCP)
  tools. Each could come later without changing the data model.
- The cloud version (#727, never merged by agents) touches `live_chat.rs`.
  This plan targets main. #727 picks it up in its next merge from main.

## Owner decisions (2026-11-10)

| #   | Question                       | Decision                                                                                                                                                                 |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | How does Videorc answer `!go`? | **On its own, as you, in the chat the viewer asked in.** A Twitch `!go` gets a Twitch reply only. The reply is only text you wrote, never AI.                            |
| D2  | How long can a reply be?       | **One message.** The reply is up to 170 characters, so `@name reply` fits Videorc's 200-character send. X takes 140, so X gets the reply in 2 parts when it doesn't fit. |
| D3  | Where are commands edited?     | **Setup → Livestream, a "Chat commands" section** under Discord. The Stream Manager's ⋯ menu opens it, and the composer suggests commands after `!`.                     |
| D4  | Free or Premium?               | **Free.**                                                                                                                                                                |

D1 is the first time Videorc posts in chat without a click. The 10-28 rule
("Buddy never posts on its own") still holds: it is about Buddy's AI lines
going out under the streamer's name. A command reply is the streamer's own
text, answering a viewer who asked for it, the way Nightbot works. Buddy's
rules don't change.

### Defaults this plan sets (the owner can change any of them)

| #   | Default                                                                                                                                                                                                                                           | Why                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| D5  | A command fires only when it is the **first word** of the message, in any case: `!go`, `!GO`, `!go please`. `why !go` and `!golang` don't fire.                                                                                                   | The way every chat bot matches. Fewer false fires.                                                                 |
| D6  | **Cooldown: once per 30 s for each command in each chat** (YouTube: 60 s). Triggers during the cooldown are ignored.                                                                                                                              | Ten viewers typing `!go` at once get one answer, not ten.                                                          |
| D7  | **YouTube replies stop at 80 % of the install's daily YouTube budget.** Your own sends keep the last 20 %.                                                                                                                                        | Each YouTube post costs 50 of ~2,500 daily units (plan 094). Command replies must never use up the sends you type. |
| D8  | `!commands` is **built in and reserved.** It lists commands A–Z: `@name Commands: !faq (most asked question), !go (why I'm learning Go), !stream (what today's stream is about)`. A switch turns it off. It stays silent while no command exists. | The streamer's example. A built-in that answers "no commands" would read as broken.                                |
| D9  | **You typing `!go` in the Stream Manager** posts the reply to every chat, without a mention, so everyone sees the answer. `!!go` sends the literal text `!go`, like `//` for slash commands.                                                      | The streamer shares an answer while talking about it.                                                              |
| D10 | **You typing `!go` on the platform's own site** (Twitch, YouTube Studio) gets the reply in that chat, without a mention. Videorc's own posts coming back into chat (its echo) are never answered.                                                 | No @ to yourself, and no reply loops.                                                                              |
| D11 | Messages from **before the chat connected, older than 60 s, edited or deleted** never fire a command.                                                                                                                                             | YouTube hands over recent history on connect. Answering 20 old `!go` messages at Go Live would be spam.            |
| D12 | A reply that fails (no write permission, YouTube limit, provider error) shows **one notice in the Stream Manager per chat and reason**, for example "!go couldn't answer on YouTube: reconnect YouTube to allow chat posts."                      | Never silent (AGENTS.md: explicit status over silent fallbacks).                                                   |

## What exists on main (`b62ff1063`)

| Current main                                                                                                                                                                                                                                                   | What this plan does with it                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `live_chat::try_deliver_messages` (`live_chat.rs:3670`) ingests, persists and emits every viewer message, then calls `cohost::note_messages_under_lifecycle_fence`.                                                                                            | The command engine gets the same persisted messages right after that call, outside every lock.       |
| `send_live_chat_message` (`live_chat.rs:2830`) posts once, with an idempotent operation id, 1–200 characters, to every writable destination or only to `destination_ids`. X is capped at 140 in `send_to_destination`.                                         | Replies go through it, with `destination_ids` set to the chat the viewer asked in. No new send path. |
| `youtube_quota.rs`: `BudgetCall::ChatSend` is shed at 100 % of `DEFAULT_DAILY_BUDGET_UNITS` (2,500).                                                                                                                                                           | Add `BudgetCall::CommandReply`, shed at `ShedExtras` (80 %), for D7.                                 |
| `cohost::note_own_send_started` / `note_own_send_delivered` (`cohost.rs:10900`) track Videorc's own posts so Buddy can tell their echo from new chat.                                                                                                          | The engine uses the same record to skip its own echoes (D10).                                        |
| Viewer names: Twitch `chatter_user_name` (display name), YouTube `displayName` (often already `@handle`), Kick `sender.username`. Roles are normalized to `owner` / `moderator`.                                                                               | Mentions come from one helper per platform (S0 checks each).                                         |
| `banners` and `sounds` tables in `storage.rs` (`migrate`, around line 8181), with `banners.list` / `sounds.list` RPCs in `main.rs`.                                                                                                                            | `chat_commands` follows the same shape.                                                              |
| The Stream Manager has no backend socket. Sounds and banners reach it as a projection the Studio renderer pushes (`pushCommentsSounds`), and the composer resolves `/sound` and `/banner` against it (`classifyComposerDraft` in `shared/session-markers.ts`). | Commands reach it the same way, so `!` completions work.                                             |
| `openDestinationFromCommentsWindow` (`comments-window:open-destination`) opens a main-window page from the Stream Manager.                                                                                                                                     | A twin, `openChatCommandsFromCommentsWindow`, opens the Chat commands section.                       |
| `FakeChatConfig` (`live_chat.rs:2043`) has `authors`, `texts` and `echoSends`.                                                                                                                                                                                 | The smoke drives viewers typing `!go` through the fake chats and reads replies back from the echo.   |

## Product behavior

### Viewer side

| Viewer types (Twitch)     | Videorc posts (Twitch only)                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `!go`                     | `@coder_x I'm learning Go because…`                                                                                |
| `!GO please`              | same reply, unless `!go` answered in this chat in the last 30 s                                                    |
| `!commands`               | `@coder_x Commands: !faq (most asked question), !go (why I'm learning Go), !stream (what today's stream is about)` |
| `!nope` (no such command) | nothing                                                                                                            |
| `I love !go`              | nothing                                                                                                            |

- **Mention:** `@` plus the viewer's name, then a space. A name that already
  starts with `@` (YouTube handles) isn't doubled. If `@name reply` would go
  over 200 characters (a name over 28 characters), the reply goes out
  without the mention rather than cut.
- **X:** the same text in up to 2 posts when it doesn't fit 140, split at a
  word, the mention on the first post only.
- **`!commands` too long:** when the list doesn't fit, it drops the
  descriptions (`Commands: !faq !go !stream …`). If even the names don't fit,
  it ends with `and N more`.
- Disabled commands don't fire and aren't listed.
- Chats Videorc can read but not post to are skipped quietly. The Stream
  Manager's chat strip already says which chats can post.

### Streamer side: the editor (Setup → Livestream → Chat commands)

Read `.claude/skills/videorc-design/SKILL.md`, `docs/ui-copy.md` and
`CONTEXT.md` before building it. shadcn/ui and the shared primitives only.

```
Chat commands
  Answer !commands                           [switch: on]
  Lists your commands in chat.

  !faq     most asked question               [on]  ⋯
  !go      why I'm learning Go               [on]  ⋯
  !stream  what today's stream is about      [on]  ⋯

  [ Add command ]
  Viewers type !name in chat. Videorc answers as you, starting with
  @their name, in the chat they asked in.
```

- `PanelSection` + `GroupedList` / `ListRow`, as the Discord section does.
  Clicking a row opens the dialog. ⋯ holds Edit and Delete. Delete uses
  `ConfirmDialog`.
- **Empty state:** "No commands yet." plus "Add command" (with the
  sentence above).
- **Add/Edit dialog** (shadcn `Dialog`):
  - **Name:** an input with a fixed `!` in front. Letters, digits, `_` and
    `-`, 1–24 characters, stored lowercase. Typing `!` is fine.
    Errors: "!go already exists." and "!commands is built in."
  - **Description:** 1–60 characters, required (it is what `!commands`
    shows).
  - **Reply:** a textarea, 1–170 characters, one line (a pasted line break
    becomes a space as you see it). A counter says how much room is left.
    A note appears when the reply plus a typical mention won't fit X's 140:
    "X gets this in 2 posts."
  - **Preview:** `@viewer <reply>`, the way chat will show it.
- Check it in light and dark (owner rule).
- The section loads lazily, so the main bundle doesn't grow (renderer
  budget, eager gzip ceiling 475,000).

### Streamer side: the Stream Manager

- **⋯ menu → "Chat commands…"** opens the main window at Setup →
  Livestream, scrolled to the section.
- **Composer:** after `!`, completions list each enabled command as
  `!go · why I'm learning Go`. Enter on a known `!name` posts its reply to
  every chat (D9). The status line says "Posted the !go reply." `!!name`
  sends the literal `!name`. An unknown `!word` is ordinary chat, sent as
  typed.
- **Reply failures** show as the Stream Manager's chat notice (D12), once
  per chat and reason, until the next live session.
- The streamer sees each reply as their own message, the same as anything
  else they post (YouTube, Twitch and Kick echo it back into chat).
- Buddy doesn't treat a `!command` message as a question to answer, so
  Buddy's bubble never answers the same thing twice.

## Data and wire

### Storage (`storage.rs`, `migrate`)

```sql
CREATE TABLE IF NOT EXISTS chat_commands (
  id          TEXT PRIMARY KEY,          -- UUID v4
  name        TEXT NOT NULL UNIQUE,      -- lowercase, no "!"
  description TEXT NOT NULL,
  reply       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

The `!commands` switch is an `app_settings` key,
`chatCommandsListEnabled` (default on).

### RPCs (`main.rs`, `backend-rpc-contract.ts`, protocol fixtures)

Every mutation answers with the whole state, `ChatCommandsState =
{ commands: ChatCommand[] (A–Z), listEnabled: boolean }`.

| Method                           | Params → result                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatCommands.list`              | none → `ChatCommandsState`                                                                                                                                    |
| `chatCommands.save`              | `{ id?, name, description, reply, enabled }` → `ChatCommandsState`. No `id` creates. The backend normalizes the name and refuses with the editor's words.     |
| `chatCommands.delete`            | `{ id }` → `ChatCommandsState`                                                                                                                                |
| `chatCommands.setListEnabled`    | `{ enabled }` → `ChatCommandsState`                                                                                                                           |
| `chatCommands.post`              | `{ sessionId, name }` → `{ sent, failed }`: the streamer's `!go` from the Stream Manager, the reply without a mention to every chat that can take posts (D9). |
| event `chatCommands.changed`     | `ChatCommandsState`, after every change                                                                                                                       |
| event `chatCommands.replyFailed` | `{ sessionId, destinationId, platform, command, reason }`                                                                                                     |

The wire shapes are pinned in `protocol-fixtures/high-risk-contracts.json`
(`chatCommand`). The rules both languages hold (names, limits, mentions, the
`!commands` text, the X split) are pinned in
`protocol-fixtures/chat-commands.json`.

`ChatCommand = { id, name, description, reply, enabled, createdAt, updatedAt }`.

- `chatCommands.list` goes in every list where `banners.list` is, read-only
  method lists included (`main.rs` ~6037 and ~17122).
- New wire fields go in `backend-rpc-contract.ts`, or main retires its
  event pump (the strict-contract trap). Every `Option` gets
  `skip_serializing_if` (the serde null trap: 3 outages).
- Validation lives in one shared TS module (`shared/chat-commands.ts`) and
  one Rust module, with tests that hold the same cases in both.

### The engine (`crates/videorc-backend/src/chat_commands.rs`)

- `note_messages(state, session_id, messages)` is called at the end of
  `try_deliver_messages`, after the cohost call, with **no lock held.** It
  does the synchronous match under its own short mutex, then
  `tokio::spawn`s each send. Chat delivery never waits for a reply.
- **Matching** (pure, tested): the first word, a case-insensitive name,
  enabled. `commands` resolves to the built-in when `listEnabled` and
  at least one command exist.
- **Gates, in order (pure, tested with a fake clock):** a new message (not
  `Updated`), not deleted, not an echo of a Videorc post, published after
  the chat session started and within 60 s of now (D11), not answered
  already (a bounded per-session set of message ids), and the
  `(destination, command)` cooldown free (D6).
- **Compose (pure, tested):** the mention (D10: none for the owner role),
  the 200 cap, the X split, the `!commands` list and its overflow.
- **Send:** `send_live_chat_message` with a fresh UUID v4 and
  `destination_ids: [message.destination]`. It goes through
  `note_own_send_started` like every send, so the echo is skipped and
  Buddy knows it was yours. YouTube asks `budget_allows(step,
BudgetCall::CommandReply)` first. A refusal, or a failed send, emits
  `chatCommands.replyFailed` once per `(destination, reason)` per session.
- Commands are cached in memory and reloaded on `chatCommands.changed`, so
  matching never reads SQLite on the delivery path (the record-only tick
  trap from plan 223: no sync SQLite on a tokio worker).
- Each fired reply goes into the session log:
  `chat-command: !go answered on twitch` (no viewer text, no reply text).

## Slices

Gates run once at the end (owner rule): write and commit every slice, then
compile and smoke. Run one backend test or clippy build at a time, and
check `df -h ~` first (88 GB free on 2026-11-10).

### S0: check the platform facts (read-only, about 30 min)

1. For each platform, the name a mention needs and where it comes from:
   Twitch `chatter_user_name` against `chatter_user_login` (a localized
   display name won't @-mention), YouTube `displayName` (does it already
   start with `@`?), Kick `sender.username`, X `author.username`. Use the
   fixtures in `scripts/fixtures/stream-manager/` and the connector tests.
2. Whether X chat posts work in production or are read-only.
3. How cohost's own-send record spots an echo, and whether the engine can
   ask it directly or needs its own short ledger.
4. Where YouTube's connect-time history lands, to confirm the D11 gate.

**Done when** the answers are written into this plan's "S0 findings"
section, and any change they need (for example an internal Twitch login
field) is added to S1 or S2.

### S1: storage, RPCs and contract

`storage.rs` table and CRUD, `main.rs` dispatch, Rust validation,
`shared/chat-commands.ts` (types, validation, `!commands` formatting shared
with the Stream Manager), `backend-rpc-contract.ts`, protocol fixtures,
`backend.ts` types.

**Done when** storage and validation Rust tests pass (create, rename,
case-insensitive uniqueness, the reserved name, the length and one-line
rules, delete, the list in A–Z order), the TS validation tests pass on the
same cases, and the contract fixture test passes.

### S2: the reply engine

`chat_commands.rs`, the hook in `try_deliver_messages`,
`BudgetCall::CommandReply` in `youtube_quota.rs`, the Buddy skip in the
cohost note path, the `chatCommands.replyFailed` event.

**Done when** unit tests cover: first-word matching and its misses, each
gate (an edit, a deletion, an echo, history, a duplicate id, the cooldown on
both sides of 30 s and 60 s), mentions (no `@@`, the owner without one, the
over-200 fallback), the X split, `!commands` formatting and overflow, the
80 % YouTube rung, the reply going only to the asking destination, and
delivery never waiting on a send. Targeted `cargo test -p videorc-backend
chat_commands` and `youtube_quota` pass.

### S3: the editor on Setup → Livestream

The lazy `chat-commands-section.tsx` under the Discord section, its dialog,
and a `use-chat-commands` hook on `chatCommands.list` and
`chatCommands.changed`. Route: UI/Product Design, with the design skill.

**Done when** component tests cover the empty state, add, edit, a
duplicate name, the reserved name, the counter, the X note, toggle and
delete; `pnpm check:renderer-assets` holds the budget; and the section
looks right in both themes (screenshots in the PR).

### S4: the Stream Manager

The projection push (`getCommentsChatCommands` / `pushCommentsChatCommands`
/ `onCommentsChatCommands`, IPC contract and `api-policy.ts`, like sounds),
the `!` completions, `ComposerCommand` `{ kind: 'chatCommand' }` in
`classifyComposerDraft` (Enter posts the reply to every chat, `!!` escape),
the ⋯ "Chat commands…" item with `openChatCommandsFromCommentsWindow`, and
the reply-failed notice.

**Done when** composer tests cover `!go`, `!GO`, `!!go`, an unknown `!word`
and completions; the menu item opens the section; and
`pnpm probe:comments-window` passes.

### S5: smoke, docs and gates

- `scripts/smoke-chat-commands.mjs` and `pnpm smoke:chat-commands`: the dev
  app with an isolated profile. It seeds `!go` and `!faq` over RPC, then
  starts a fake chat session with YouTube, Twitch and Kick fakes
  (`echoSends: true`, `authors`, `texts: ['!go', 'hello', '!GO now',
'!commands', '!nope', '!go']`). It holds: one reply per first `!go`, only
  in the asking chat, starting with `@author`; no reply to `hello` or
  `!nope`; the second `!go` inside the cooldown ignored; `!commands` listing
  both; a send set to `failed` on one fake raising exactly one
  `chatCommands.replyFailed`; the composer `!go` posting to all three; and
  no reply to any echo. It never goes live to a real channel.
- `docs/chat-commands.md` (behavior and limits), a **Chat command** entry in
  `CONTEXT.md` (Avoid: bot command, and "slash command" for these, which
  stays the composer's `/`), an AGENTS.md gate line, and a
  `plans/README.md` row.

**Done when** every gate below is green, or a red is shown to be on main
too.

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:scripts`,
  `pnpm --filter @videorc/desktop test`, `pnpm build`,
  `pnpm check:renderer-assets`
- `cargo fmt --check --all`; targeted `cargo test -p videorc-backend` for
  `chat_commands`, `storage`, `youtube_quota` and `live_chat`; both clippy
  lines from AGENTS.md (the owner's rule: targeted tests and clippy
  locally, the full suite in CI)
- `pnpm smoke:chat-commands`, `pnpm smoke:live-chat-fake-providers`,
  `pnpm smoke:youtube-quota` (the budget ladder changed),
  `pnpm smoke:buddy-commands` (unchanged), `pnpm probe:comments-window`
- No recording, capture, preview or encoder code changes, so the
  recording-studio and native-preview gates don't apply.
- **Owed after merge:** one live check per platform on the test channels,
  only on the owner's go: a viewer `!go` on YouTube, Twitch and Kick, and a
  real `!commands`.

## Routing (CLAUDE.md)

| Slices                                                          | Owner route (fit)     | Model lane                                                                                            |
| --------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| S0–S2 (backend, the live chat delivery path, the YouTube quota) | Implementation (8)    | `gpt-6.1-sol`. Move up to `fable-5.1` if the delivery-path hook needs more than the post-cohost call. |
| S3–S4 (editor, Stream Manager)                                  | UI/Product Design (9) | `opus-5.5`                                                                                            |
| S5 and the PR                                                   | Orchestrator          | `opus-5.5`                                                                                            |

S1 lands first: S2, S3 and S4 all depend on its types. After S1, S2 and
S3 can run in parallel. S4 needs S1 and the S2 event.

## Risks

- **YouTube's shared quota.** Every install shares one Google project.
  Replies add YouTube posts. D6 and D7 cap one install at roughly 40
  replies a day, and the remote `youtube.dailyBudgetUnits` flag can lower
  that for everyone without a release.
- **Spam and platform rate limits.** Twitch allows about 20 messages per
  30 s for a non-moderator account. D6 keeps replies far below that, and a
  429 is a failed send like any other (D12).
- **A reply loop with another bot** (Nightbot answering with `!go`). Videorc
  only answers a message whose first word is a command, its own echoes are
  skipped, and every reply it sends starts with `@` or is plain reply text.
  The cooldown bounds anything left.
- **Answering as the streamer.** Only the streamer's saved text goes out,
  never AI, never anything the viewer typed. A viewer's name is the only
  outside text in a reply.

## S0 findings

Checked against `b62ff1063` + `592ae4f6d` on 2026-11-10.

1. **The name a mention needs.**
   - **Twitch:** `author_name` is `chatter_user_name`, the display name
     (`twitch_chat.rs` `normalize_chat_message`). For an ASCII name it is
     the login with capitals and @-mentions fine; a localized display name
     (CJK) does not. `chatter_user_login` comes in every
     `channel.chat.message` (fixtures `twitch-chat-gif.json`,
     `twitch-chat-message-intro.json`) but is dropped. **S2:** an internal
     `author_handle` on `LiveChatMessage`, `#[serde(skip)]` like
     `first_in_session` (never on the wire or in SQLite, so no contract
     change), set from `chatter_user_login`. The mention uses the display
     name when it equals the login ignoring case, else the login.
   - **YouTube:** `authorDetails.displayName`, as is. The repo fixtures
     carry plain names (`Tipper`); a channel with a handle gets `@handle`.
     The prefix drops one leading `@`, so it never doubles (fixture case
     `@YouTubeHandle`).
   - **Kick:** `sender.username` (`kick_chat.rs`), the account's username.
     It mentions as is.
   - **X:** `author_name` is `author.name`, the display name ("Viewer
     Name"); `author.username` is kept only on Follow rows. **S2:** the same
     `author_handle`, from `author.username`; the mention uses it.
   - **Owner:** `author_roles` holds `owner` (YouTube) or `broadcaster`
     (Twitch, Kick and the fake echo rows). Both mean the streamer, the way
     `cohost::normalize_role` reads them: no mention.
2. **X posts work in production when X Live is authorized.**
   `chat_capability` gives X `write: Ready` only with the OAuth 1.0a X Live
   credentials (`ChatSenderConfig::X` posts to `/2/broadcasts/:id/chat`),
   else `ReadOnly`, which the engine skips quietly. `send_to_destination`
   refuses more than 140 characters, so the split is needed. Fake X chat is
   always `ReadOnly`, so the S5 smoke can't drive X; the split is unit
   tested only.
3. **Cohost's own-send record can't be asked.** `note_own_send_started`
   reaches `cohost_ack`'s ledger (collapsed text, 120 s, 20 entries) only
   inside a running Buddy session (`session_for_mut`), skips texts under 6
   characters (`!go` is 3), and `is_own_echo` is private. With Buddy off
   nothing is recorded. **S2:** the engine keeps its own short ledger:
   `execute_send_live_chat_message` notes every send's text (the
   streamer's, Buddy's, an agent's and the replies) for the chat session,
   whitespace collapsed, 120 s, 32 entries. A command message whose text
   matches is an echo.
4. **YouTube's history lands as new chat.** The connector's first
   `liveChatMessages.list` (no page token, and again after an invalid page
   token) returns recent chat with its original `snippet.publishedAt`, and
   delivers it through `try_deliver_messages` like any other page, as
   `IngestOutcome::New`. **S2:** the coordinator records
   `session_started_at` in `start_session`; the gate drops anything
   published before it or more than 60 s ago, and the per-session answered
   ids cover a re-fetch.
5. **New against Updated:** `try_deliver_messages` rebuilds its list from
   the persisted rows, which loses the ingest outcome. **S2:** collect the
   ids of `IngestOutcome::New` in the ingest block and pass them on.
