# Plan 085: Kick emotes show as `[emote:ID:name]` text in the Stream Manager

**Status:** EXECUTED 2026-10-01 (S1 + S2 on `fix/085-kick-chat-emotes`;
owner live acceptance owed). **Priority:** P2 (every Kick emote in chat is
unreadable; chat itself works). **Size:** S, 2 slices. **Planned against:**
`9f1a46a3` (0.9.125). **Owner route:** Diagnose → Implementation (fit 8; root
cause proven, fix is a contained parser plus wiring). **Model lane:**
`gpt-5.5`. Desktop-only: no videorc-web change or deploy.

## Symptom

Kick chat rows in the Stream Manager show raw tokens instead of images:

```
dominikdoesdev  [emote:1579033:emojiAstonished]
dominikdoesdev  [emote:1730752:emojiAngel]
```

Twitch emotes render correctly in the same pane.

## Root cause (proven)

Kick sends emotes as inline tokens inside the message `content`, in the form
`[emote:<numeric id>:<name>]`. Nothing between Kick and the pane turns those
tokens into images:

1. **Relay (videorc-web, fine).** `lib/kick-chat/webhook.ts` `parseChat`
   forwards `content` verbatim, plus an `emotes: [{emoteId, positions}]`
   array. The web test fixture confirms the token format:
   `content: "Hello [emote:4148074:HYPERCLAPH]"`
   (`tests/kick-chat-webhook.test.ts:139`).
2. **Desktop connector (the bug).** `relay_event_to_message`
   (`crates/videorc-backend/src/kick_chat.rs:1289`) copies `payload.content`
   straight into `message_text` (line 1350) and leaves `fragments` empty
   (line 1315). `RelayChatPayload` never even deserializes `emotes`.
3. **Renderer (fine, but it needs fragments).** `MessageBody`
   (`apps/desktop/src/renderer/src/components/comment-row.tsx:198`) draws
   images only when a fragment has an `imageUrl`. If no fragment has one, it
   prints `messageText`, which here is the raw token.

Twitch works because EventSub sends structured fragments, and
`twitch_chat.rs:237` `parse_fragments` maps each emote fragment to a CDN URL.
Kick never got the equivalent when it was added in plan 063.

### Everything else is already in place

- **CDN:** `https://files.kick.com/emotes/<id>/fullsize`. Probed 2026-10-01
  without auth: `1579033` returns `200 image/gif` (78 KB) and `1730752`
  returns `200 image/gif` (35 KB).
- **Allowlist:** `files.kick.com` is already on the avatar/emote cache
  allowlist (`apps/desktop/src/main/avatar-cache.ts:24`), and 78 KB is well
  under `AVATAR_MAX_BYTES` (2 MB).
- **Cache file names:** a URL with no file extension gets a `.img` cache
  name. Twitch's `/1.0` emote URLs and YouTube avatars already work this way.
- **Storage and wire:** `fragments` already round-trip through SQLite
  (`fragments_json`), the IPC contract, and the phone-remote projection.

### The raw token also leaks into every plain-text surface

`message_text` is read directly by Orcle's prompt (`cohost.rs:3400`), the
on-stream highlight card (`caption-overlay.ts:468`
`commentHighlightCardText`), the phone remote (`remote_web/app.js:136`), Copy
message, Stream Manager search, and reply parents. All of them currently see
`[emote:1579033:emojiAstonished]`.

## Design decisions

- **Parse the tokens in `content`, not the relay's `positions`.** The tokens
  describe themselves and are exactly what Kick's own client renders. The
  units of `positions` are undocumented (bytes, UTF-16 units or chars;
  inclusive or exclusive end), and the relay can cut `content` at 2,000
  chars, which would leave positions pointing past the end. The relay stays
  unchanged.
- **Parse in Rust at ingest, not in the renderer.** One parser then fixes the
  pane, Orcle, the highlight card, the phone remote, search, copy and replies
  together, matching how Twitch fragments are built on the backend.
- **`message_text` becomes the readable form.** Each token is replaced by its
  emote name (`[emote:1579033:emojiAstonished]` becomes `emojiAstonished`).
  This matches Twitch, where `messageText` already contains `Kappa`.
- **Strict token grammar; anything else stays literal text.** The id must be
  ASCII digits only, 1 to 20 of them, so the CDN URL cannot be steered. The
  name must be 1 to 100 chars with no `[`, `]`, `:` or whitespace. A
  malformed or truncated token is left as plain text. A viewer who types a
  valid token by hand gets an emote, which is what Kick's own client does
  too.
- **No tokens means no fragments.** A message with no emotes keeps
  `fragments: []`, so plain messages render exactly as they do today and the
  stored row size does not change.
- **No new dependencies.** The backend has no `regex` crate. A small
  hand-written scanner is enough.

## Slice S1: backend parses Kick emote tokens into fragments

**Changes** (all in `crates/videorc-backend/src/kick_chat.rs`, unless
noted):

1. Add `pub(crate) fn kick_message_parts(content: &str) -> (String,
Vec<LiveChatMessageFragment>)`. It scans for `[emote:` and validates the
   grammar above.
   - On a valid token, close the pending text run as a `type: "text"`
     fragment. Then push `type: "emote"` with `text: <name>` and
     `image_url: Some(format!("https://files.kick.com/emotes/{id}/fullsize"))`,
     and append `<name>` to the plain text.
   - On an invalid token, keep the `[` as literal text and scan on from the
     next char. Never index bytes in the middle of a char.
   - If no valid token was found, return `(content.to_string(), Vec::new())`.
   - Put the CDN prefix in a `KICK_EMOTE_URL_PREFIX` constant next to the
     other Kick constants.
2. `"chat"` arm: replace `message.message_text = payload.content` with the
   parser's output for both `message_text` and `fragments`. Do the
   empty-content check before parsing, as today.
3. `"kicks"` arm: run the viewer's own `message` through the same parser.
   A Kicks gift message can contain emotes.
4. **Rows stored before the fix** (`crates/videorc-backend/src/storage.rs`
   `live_chat_message_from_row`): if `platform == Kick`, `fragments` is empty
   and `message_text` contains `[emote:`, run the parser on load. A Stream
   Manager that rehydrates a session after a relaunch then shows images for
   rows received on 0.9.125 and earlier. This is a read-time step only, with
   no migration.
5. Deleted messages need no change: the deletion path already clears
   `fragments` (`live_chat.rs:1118`).

**Tests** (in `kick_chat.rs` `mod tests`, plus one in `storage.rs`):

- Parser table: one emote alone; text before and after; two adjacent emotes;
  the screenshot's five tokens; a non-digit id (`[emote:abc:x]`), an empty
  name (`[emote:1:]`), a 21-digit id, an unclosed token at the end of the
  string (the 2,000-char cut), a name containing a space, and a multi-byte
  emoji next to a token (must not panic or split a char). For every case,
  assert both `message_text` and the exact fragment list.
- Plain text without tokens returns an empty `fragments` list.
- The mock relay's `chat_event` gets a variant whose content is
  `"hi [emote:1579033:emojiAstonished]"`. Map it through
  `relay_event_to_message`, the function every relay page goes through, and
  assert text `"hi emojiAstonished"`, a `text` fragment and an `emote`
  fragment, and the `files.kick.com` URL. A Kicks gift message gets the same
  treatment.
- `storage.rs`: a Kick row persisted with raw token text and `[]` fragments
  loads back with emote fragments. A Twitch row with the same text is left
  alone.

**Verification:**

```sh
RUSTUP_TOOLCHAIN=1.98.0 cargo test -p videorc-backend kick_chat
RUSTUP_TOOLCHAIN=1.98.0 cargo test -p videorc-backend storage::
RUSTUP_TOOLCHAIN=1.98.0 cargo test -p videorc-backend live_chat
RUSTUP_TOOLCHAIN=1.98.0 cargo clippy -p videorc-backend -- -D warnings
cargo fmt --check --all
```

(The shared `stable` toolchain is broken; see the 0.9.125 release memory.)

**Done when:** the parser table passes; the relay mock test proves that a
Kick chat event becomes `emote` fragments with `files.kick.com` URLs; and
`rg 'message_text = payload.content' crates/` returns nothing.

## Slice S2: renderer proof and live acceptance

The renderer already draws any fragment that has an `imageUrl`, so this
slice proves that path and fixes the comments that say Twitch only.

**Changes:**

1. `apps/desktop/src/renderer/src/lib/stream-manager-chat.test.ts`: add
   `renders Kick emotes from fragments`, mirroring the Twitch case at line 121. Use `platform: 'kick'`, a `files.kick.com/emotes/<id>/fullsize` URL,
   and assert that the name stands in until the cache resolves. Also assert
   that `[emote:` never appears in the markup.
2. `comment-row.tsx:197`: change the doc comment from "(Twitch)" to
   "(Twitch, Kick)". In `avatar-cache.ts:17` and `:24`, note that
   `files.kick.com` also serves Kick chat emotes (plan 085). The allowlist
   itself does not change.
3. Add an `avatar-cache.test.ts` assertion that
   `https://files.kick.com/emotes/1579033/fullsize` is allowed. This pins the
   dependency so a future tightening of the allowlist cannot silently break
   emotes.

**Verification:**

```sh
pnpm --filter @videorc/desktop test -- stream-manager-chat avatar-cache comment-row
pnpm typecheck && pnpm lint && pnpm format:check
```

**Done when:** the new tests pass. Then, for live acceptance on a dev build
with Kick connected: open the Stream Manager, send `hi` plus three emotes
from kick.com chat (one from the global `emoji*` set, one channel emote and
one animated emote), and confirm the following:

- All three render inline at text size.
- Search for the emote name finds the row.
- Copy message gives `name: hi emojiAngel …`, with no tokens.
- Highlighting the row puts readable text on the stream card.
- After a relaunch, the rehydrated rows still show images.

## Out of scope / follow-ups

- **Emote images on the on-stream highlight card.** The card is
  canvas-rendered text for Twitch as well. Drawing emote images there is a
  separate feature for both platforms.
- **An emote picker, or sending emotes from the composer to Kick.** Typing a
  token by hand already works, because Kick parses the content.
- **Mapping Kick's `emoji*` set to Unicode for text-only surfaces** (so the
  card shows 😇 rather than `emojiAngel`). This is optional polish if the
  owner wants it after S2.
- Ship in the next macOS release.
