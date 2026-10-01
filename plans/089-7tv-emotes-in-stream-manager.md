# Plan 089: 7TV emotes in the Stream Manager

**Status:** EXECUTED 2026-10-01 (S1-S4 on `plan/089-7tv-emotes`; S5 owner
live acceptance, the privacy-page PR merge and the terms skim are owed; see
"Execution notes" at the end). **Priority:** P2 (a feature, not a bug; 7TV is
the emote layer most Twitch and Kick communities type in). **Size:** M, 5
slices. **Planned against:** `26ccbf96` (origin/main; the shared checkout was
184 commits behind, so every reference below is from a clean worktree).
**Owner route:** Implementation (fit 8; the API is proven by live probes and
the seams already exist). **Model lanes:** S1 and S2 `gpt-5.5`; S3 and S4
`opus-4.8` with the `videorc-design` skill; S5 is owner acceptance.
Desktop-only, plus one optional privacy-page paragraph on videorc-web (D3).

## Goal

A viewer types the name of a 7TV emote in Twitch, Kick or YouTube chat, for
example `catJAM`. The Stream Manager shows that emote's image, animated if the
emote is animated, the same way viewers with the 7TV extension see it.
Zero-width emotes such as `RainTime` stack on top of the emote before them.
Plain-text surfaces (Orcle, search, Copy, highlight card, phone remote) keep
the word, which they already have.

## Why this is not like Twitch or Kick emotes

No platform knows about 7TV. The viewer sends plain text (`catJAM`). The 7TV
browser extension or a client like Chatterino swaps the words that match the
channel's 7TV emote set, plus the 7TV global set, for images. Nothing in the
EventSub, Kick relay or YouTube payload marks a 7TV emote. Videorc therefore
has to do three things:

1. Find the 7TV emote set of the streamer's own channel.
2. Match words in incoming messages against it.
3. Draw the image.

Twitch (plan 055) and Kick (plan 085) only needed step 3, because those
platforms send the emote positions themselves.

## Verified facts (live probes, 2026-10-01, no auth)

| What                               | How                                                                                                                                                                               | Result                                                                                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel → 7TV user + active set    | `POST https://7tv.io/v4/gql` with `users { userByConnection(platform: TWITCH \| KICK \| GOOGLE, platformId: …) { id style { activeEmoteSetId } } }`                               | xQc Twitch `71092938` and Kick `676` return the same user and set. A YouTube channel (`GOOGLE`, `UChXKjLEzAB1K7EZQey7Fm1Q`) returns its set. An unknown id returns `null` with HTTP 200.                                     |
| All three platforms in one request | GraphQL aliases (`c0:`, `c1:`, `c2:`)                                                                                                                                             | One request takes about 0.3 s (analyzer complexity 13).                                                                                                                                                                      |
| Set contents + global              | `emoteSets { emoteSets(ids: [...]) { … } global { … } }`, `emotes(perPage: 2500) { totalCount pageCount items { alias flags { zeroWidth } emote { id imagesPending deleted } } }` | Two sets (986 + 737 emotes) plus global (45) come back in 317 KB raw and 0.8 s, one page each.                                                                                                                               |
| Has anything changed?              | `emoteSets(ids) { id updatedAt }`                                                                                                                                                 | 251 B, 0.3 s.                                                                                                                                                                                                                |
| Images                             | `https://cdn.7tv.app/emote/<id>/{1x,2x,3x,4x}.webp`                                                                                                                               | `image/webp`, `cache-control: public, max-age=31536000, immutable`, CORS `*`. WebP is the only format every emote has: animated emotes have no `.png` (404). All 986 emotes of the large set have `2x.webp`.                 |
| Image sizes (986-emote set)        | `host.files` sizes                                                                                                                                                                | 1x.webp: median 22 KB, max 517 KB. 2x.webp: median 49 KB, p99 681 KB, max 1.16 MB. All are under `AVATAR_MAX_BYTES` (2 MB).                                                                                                  |
| Rate limit                         | response headers                                                                                                                                                                  | `x-ratelimit-global-limit: 5000` per 60 s window, per IP.                                                                                                                                                                    |
| v3 REST (the older API)            | `GET /v3/users/{twitch\|kick\|google}/{id}`                                                                                                                                       | It works, but its own OpenAPI (`/v3/docs`) says _"This API is in maintenance mode and will not receive any new features."_ One 986-emote set is 2.4 MB raw. The backend's `reqwest` has no `gzip` feature (`Cargo.toml:26`). |
| EventAPI (live push)               | `wss://events.7tv.io/v3`, op 35 subscribe                                                                                                                                         | It sends hello (heartbeat ~47 s, 500 subscriptions) and heartbeats. It sends **no ack and no error** for subscribes, including a made-up `bogus.type`, so a broken subscription cannot be detected.                          |

**Name and id shapes.**

- **Names are case-sensitive.** They contain any non-whitespace characters: `WHAT?`, `!join`, `:d`, `???`. The longest seen is 77 chars.
- **Viewers type the `alias`.** It can differ from the emote's default name: the global set lists `nanaAYAYA` for `AYAYA`.
- **One set held a duplicate alias.**
- **Every id is a 26-char ULID** (`[0-9A-HJKMNP-TV-Z]{26}`). All 986 of the large set match.
- **Global set flags.** Three of the 45 global emotes are zero-width.

**Docs and terms.** The v4 GraphQL endpoint is documented, with a playground
at `api.7tv.app/v4/gql`. `api.7tv.app` and `7tv.io` serve the same API. The
terms page (`https://7tv.app/legal/terms`) renders only with JavaScript and
could not be read by tooling; see D4.

## Current state checked (code at `26ccbf96`)

- **Fragment model.**
  - `LiveChatMessageFragment { type, text, image_url }` is at `crates/videorc-backend/src/live_chat.rs:105-115`. `type` is a free-form string.
  - The TS mirror is `apps/desktop/src/shared/backend.ts:4261-4265`.
  - Messages reach the renderer through the generic bounded payload schema (`shared/backend-rpc-contract.ts:300`; `sessions.comments.list` at `:2487-2500`). An optional new field needs no schema edit.
- **How each platform builds fragments today.**
  - Twitch passes EventSub fragments through, with a single `text` fragment when there are no emotes (`twitch_chat.rs:237-263`).
  - Kick builds `text`/`emote` from tokens and leaves fragments empty when there are none (`kick_chat.rs:1557-1615`).
  - YouTube and X never build fragments (`youtube_chat.rs:604`, `x_chat.rs:793`, `:838`).
- **One convergence point.** Every connector delivers through `try_deliver_messages` (`live_chat.rs:2735`). The order is:
  1. `mark_first_time_chatters` (`:2743`), an existing async pre-step that mutates messages.
  2. `begin_delivery` (`:2744`).
  3. Ingest into the buffer.
  4. Persist to SQLite (`:2792`).
  5. `liveChat.message` plus the phone projection (`:2836`).
  6. Orcle (`:2839`).

  Connectors retry the same cloned message (e.g. the Twitch loop at `twitch_chat.rs:1082-1115`), so a step here must be pure and idempotent.

- **The streamer's own ids are already known.**
  - Each provider row carries `LiveChatProviderState.account_id` (`live_chat.rs:89-90`), taken from the OAuth profile: Twitch helix user id, Kick `user_id`, YouTube `UC…` channel id (`oauth.rs:2531`, `:2563`, `:2591`).
  - Caveat: the row takes the _first_ account of that platform (`live_chat.rs:1367-1372`).
- **Session state.**
  - `LiveChatCoordinator` (`live_chat.rs:838-869`) holds `tasks` (aborted on stop and restart). `start_session` (`:1067-1082`) resets per-session state.
  - The loader runs from `start_live_chat_after_install` (`:1524`), after `start_session`.
- **Renderer.**
  - `Emote` and `MessageBody` (`apps/desktop/src/renderer/src/components/comment-row.tsx:206-237`) draw any fragment with `imageUrl` through `useCachedAvatar`.
  - Every image has a fixed `size-5` (20×20 px) box, so a wide emote is squashed. At 1x, 7TV has many 57–96 × 32 px emotes.
  - There is no zero-width handling.
- **Image path.**
  - Emotes must go through main's allowlisted avatar cache. The CSP forbids `https:` in `img-src` (test at `apps/desktop/src/main/renderer-security-policy.test.ts:348-350`).
  - `cdn.7tv.app` is refused today, and a test pins that (`avatar-cache.test.ts:62-64`). That test sample is the "non-allowlisted host" case from plan 055, not a product decision against 7TV.
  - `.webp` keeps its extension in the cache file name (`avatar-cache.ts:192-205`).
  - The cache holds 500 files, shared with avatars (`avatar-cache.ts:37`). It runs a synchronous `readdirSync` + `statSync` prune on every write (`main/index.ts:12990-13006`).
- **Consumers that need no change.** These read `messageText`, which already contains the word:
  - Orcle (`cohost.rs:3400`)
  - the on-stream highlight card (`caption-overlay.ts:466-470`)
  - Stream Manager search (`lib/stream-manager-chat.ts:20-31`)
  - Copy (`comment-row.tsx:434-440`)
  - the Activity pane
  - the phone remote. `remote_lan.rs` strips `imageUrl` (test at `:1031-1052`), and `remote_web/app.js` is text only.
- **Settings.**
  - There is no Chat tab. General holds "Open Stream Manager when I go live" (`components/settings/general-settings.tsx:42-61`).
  - The Settings tab is lazy-loaded (`components/app-shell.tsx:61-62`).
  - The backend pattern for a persisted preference is `CohostSettings` in `app_settings` through `cohost.settings.get/set` (`cohost.rs:455-546`, `main.rs:8859-8871`; TS schemas with `allowUnknown: false` at `backend-rpc-contract.ts:1853-1866`).
- **Nothing to reuse or conflict with.** The repo has no 7TV, BTTV or FFZ code (one test string only).

## Design decisions

1. **Use 7TV's v4 GraphQL; not v3 REST, not the EventAPI.**
   - v4 is documented, actively maintained, and models today's 7TV: one active set per user across all linked platforms.
   - It is about 13× smaller than v3 for the same set (190 KB vs 2.4 MB raw, and we have no gzip).
   - It resolves Twitch, Kick and YouTube in one batched request.
   - v3 describes itself as maintenance mode.
   - The EventAPI accepts subscriptions silently (no ack, no error), which conflicts with "explicit diagnostics over silent fallbacks".
   - Pin the query shape with a fixture test plus an `#[ignore]` live test (S1).
2. **Match in Rust at delivery, as one pure step for every platform.** Put it in `try_deliver_messages`, right after `mark_first_time_chatters` and before `begin_delivery`.
   - This is plan 085's rule: build fragments in the backend.
   - Then the buffer, SQLite, the renderer, History mode and a relaunch all agree.
   - Persisted rows keep their emotes, so a past session replays with images.
3. **Never block or delay chat.**
   - The set loads in a task spawned at session start. Messages that arrive before it lands stay text.
   - The delivery step only reads an `Arc` index. It never touches the network.
4. **Platforms: Twitch, Kick and YouTube, the three 7TV supports.** X never: 7TV has no X connection and X viewers never see these emotes.
5. **Which set applies.**
   - Each platform uses the active set of the 7TV account linked to the streamer's account on that platform.
   - A platform with no link borrows the set of the first linked account, in the order Twitch, Kick, YouTube. Viewers on that platform who type the community's emote names mean those emotes.
   - The global set applies on all three platforms, but only when at least one account is linked.
   - **No linked 7TV account means nothing changes** (D1). A streamer who has never used 7TV does not suddenly see `EZ` and `Clap` turn into images.
6. **Matching rules (mirror the 7TV extension).**
   - Split on Unicode whitespace and match a whole token exactly, case-sensitive, against the alias. The channel set wins over global. Within one set, the first occurrence wins.
   - Scan only `text` fragments, or `message_text` when `fragments` is empty. Twitch `emote` / `mention` / `cheermote` fragments and Kick `emote` fragments pass through untouched.
   - Scan only `Message` and `Paid` rows that are not deleted. System, membership, follow and moderation rows contain text Videorc wrote.
   - `message_text` never changes.
   - When nothing matches, `fragments` is left exactly as it was: an empty list stays empty, so plain YouTube and Kick rows are byte-identical to today.
   - Whitespace is kept exactly, inside the surrounding `text` fragments.
   - At most 100 7TV emotes per message; past that, the rest stays text. Platform limits already bound this (≤500 chars); the cap bounds stored row size anyway.
7. **Build the URL ourselves; never take a URL from the API.**
   - URL = `SEVENTV_CDN_EMOTE_PREFIX` (`https://cdn.7tv.app/emote/`) + id + `/2x.webp`.
   - The id must be a ULID (`[0-9A-HJKMNP-TV-Z]{26}`). The alias must be 1–100 chars with no whitespace or control chars. Skip `imagesPending` and `deleted` emotes.
   - Use `2x` because the row draws emotes 20 CSS px tall. On Retina that is 40 device px, and the 32 px `1x` would be upscaled and blurry. The 2x median is 49 KB.
   - WebP because it is the only format every emote has. Chromium animates WebP in `<img>`.
8. **Zero-width emotes get one new optional fragment field.**
   - Rust: `zero_width: bool` with `#[serde(default, skip_serializing_if = "std::ops::Not::not")]` (see the serde-null contract trap).
   - TS: `zeroWidth?: boolean`.
   - The fragment `type` stays `"emote"`, so every consumer, including the phone projection, treats it like any other emote.
   - The renderer stacks a zero-width emote on the emote before it (from any provider) when only whitespace separates them. Otherwise it draws it inline.
9. **Freshness by polling, 30 s.**
   - While a chat session runs, one ~500 B request re-reads each linked connection's `activeEmoteSetId` and the `updatedAt` of the sets and global.
   - Only a change triggers a refetch, and the index is swapped atomically.
   - On failure, back off 30 → 60 → 120 → 300 s.
   - A streamer who adds an emote mid-stream sees it render within about 30 s.
   - EventAPI push is a follow-up.
10. **Diagnostics.**
    - One `state.emit_log` line per load or refresh outcome. On success it is `info` with set name, emote counts and platforms. On failure it is `warn` with a class: `network`, `http 4xx/5xx`, `graphql: <first message, ≤160 chars>`, `decode`, or `too-large`.
    - Distinct failures are deduped per session, as `kick_chat.rs:706-715` does.
    - These lines reach the support bundle through `recent_logs(200)`.
11. **A toggle, default on.**
    - Settings → General → "Show 7TV emotes in chat", persisted in the backend (`app_settings` key `chatEmoteSettings`) (D2).
    - Off means no request to 7TV at all, and new messages are not decorated.
    - Rows already stored keep their emotes.
12. **No new dependencies.** Use `reqwest` (json, rustls), `serde_json` and `tokio`, which are already present. Do not turn on reqwest `gzip`: it would change every client in the backend.

## Owner decisions (recommended defaults; execution can start on them)

- **D1. No linked 7TV account.** Recommended: show no 7TV emotes, global ones included.
  - Alternative: always show global emotes. This matches what viewers with the extension see, but surprises streamers who never chose 7TV.
- **D2. Toggle.** Recommended: Settings → General, default on, with a one-line status under it (S4). Without a toggle, there is no way to stop requests to a new third party.
- **D3. Privacy page.** Recommended: add one paragraph to videorc.com/privacy (videorcweb `app/privacy/page.tsx`), next to the Kick and YouTube sections. It is a web PR that ships before the desktop release. Draft:
  > **7TV emotes.** If 7TV emotes are on (Settings → General), Videorc asks 7TV (7tv.app) for the public emote set linked to your connected Twitch, Kick or YouTube channel, and downloads emote images from 7TV's CDN. 7TV receives your IP address and those public channel ids. Videorc sends 7TV nothing else.
- **D4. 7TV terms.** Skim `https://7tv.app/legal/terms` once before release. Tooling could not render it. Chatterino, the 7TV extension and many overlays make these same calls.

## Slice S1: 7TV client and emote index (backend, no wiring)

**Files:** new `crates/videorc-backend/src/seventv.rs`, plus `mod seventv;` in `main.rs`. No other file changes.

**Changes:**

1. **Constants:**
   - `SEVENTV_GQL_URL = "https://7tv.io/v4/gql"`
   - `SEVENTV_CDN_EMOTE_PREFIX = "https://cdn.7tv.app/emote/"`
   - `SEVENTV_IMAGE_FILE = "2x.webp"`
   - `SEVENTV_MAX_BODY_BYTES = 8 * 1024 * 1024`
   - `SEVENTV_MAX_EMOTES_PER_MESSAGE = 100`
   - `SEVENTV_MAX_PAGES = 4`
2. **`SevenTvClient { http, endpoint }`.**
   - `new()` uses `reqwest::Client::builder()` with the `Videorc-Desktop/<version>` user agent (as `kick_chat.rs:1000-1003`), a 10 s request timeout and a 5 s connect timeout.
   - `with_endpoint(url)` exists for tests.
   - It reads the body in chunks and stops past `SEVENTV_MAX_BODY_BYTES`, returning `TooLarge`.
3. **`resolve_connections(&[(StreamPlatform, String)])`.**
   - One aliased query: `c0: userByConnection(platform: TWITCH, platformId: $c0)`.
   - The platform enum literal comes from a `match`: Twitch → `TWITCH`, Kick → `KICK`, YouTube → `GOOGLE`. Any other platform is never sent.
   - Account ids go **only** as GraphQL variables, never interpolated into the query.
   - Returns `Vec<Option<SevenTvLink { user_id, active_set_id }>>`; `null` means not linked.
4. **`fetch_sets(&[set_id])`.**
   - Fetches `emoteSets(ids)` plus `global` with the fields in the facts table.
   - Follows `pageCount` up to `SEVENTV_MAX_PAGES`. If more pages remain, it logs that the set was truncated (explicit, not silent).
5. **`poll_versions(...)`.** The one cheap request from decision 9. Returns the active set id per connection, `updatedAt` per set and the global `updatedAt`.
6. **Pure functions:**
   - `valid_emote_id` and `valid_emote_name`.
   - `build_index(channel: Option<&SevenTvSet>, global: &SevenTvSet) -> SevenTvEmoteIndex`. It skips invalid, pending and deleted entries. The channel set wins over global; within a set, the first occurrence wins.
   - `emote_image_url(id)`.
   - `SevenTvEmoteIndex` is a `HashMap<String, SevenTvEmote { id, zero_width }>` behind an `Arc`.
7. **`SevenTvError`.** Variants: `Network`, `Http(status class)`, `GraphQl(first message, ≤160 chars)`, `Decode`, `TooLarge`. Its `Display` gives the log text.
   - A response with a non-empty `errors` array is a `GraphQl` error even when `data` is present.

**Tests** (`seventv.rs` `mod tests`; small inline JSON trimmed from the 2026-10-01 probes; no large fixture files):

- **Resolve response:** a linked connection, a `null` connection, and three aliased connections mapping back in order.
- **Sets response:**
  - An alias that differs from the default name, read from the `alias` field.
  - `zeroWidth` carried through.
  - Skipped entries: a non-ULID id, `imagesPending: true`, `deleted: true`, an empty alias, and an alias containing a space.
  - Duplicate alias: the first one wins.
  - A channel set entry overrides a global entry with the same name.
- **Errors:** an `errors` array gives `GraphQl`; a body over the cap gives `TooLarge`; a 503 gives `Http("5xx")`; a truncated JSON gives `Decode`.
- **Mock server:** a `TcpListener` mock (the pattern at `kick_chat.rs:1879`). Assert the posted body carries the account ids in `variables` and **not** in `query`, and that the user agent is set.
- **`#[ignore]` live test `seventv_live_schema`:** resolve Twitch `71092938` against the real API, fetch its set plus global, and assert both decode with more than 0 emotes and a ULID id. Run it by hand before release; it is the schema-drift alarm.

**Verification:**

```sh
RUSTUP_TOOLCHAIN=1.98.0 cargo test -p videorc-backend seventv
RUSTUP_TOOLCHAIN=1.98.0 cargo test -p videorc-backend seventv_live_schema -- --ignored
RUSTUP_TOOLCHAIN=1.98.0 cargo clippy -p videorc-backend -- -D warnings
cargo fmt --check --all
```

(Shared `stable` is broken by the `fetch_update` deprecation; use 1.98.0.
Targeted tests, not the full suite, per the owner's CI directive. If other
sessions are building, use `-j 2`.)

**Done when:** all tests above pass, the live test passes against
production, and no other file changed besides the `mod` line.

## Slice S2: decorate messages at delivery, load per session, poll

**Files:** `seventv.rs`, `live_chat.rs`, `live_chat.rs` tests, and the
`LiveChatMessageFragment` field in `live_chat.rs` plus
`apps/desktop/src/shared/backend.ts` (`zeroWidth?: boolean`).

**Changes:**

1. **Contract.** Add `zero_width` to `LiveChatMessageFragment` (decision 8), and `zeroWidth?: boolean` to the TS mirror. Existing constructors use `..` or explicit fields, so fix them with `zero_width: false`; `rg 'LiveChatMessageFragment \{'` lists them.
2. **`seventv::decorate(messages: &mut [LiveChatMessage], indexes: &SevenTvIndexes)`.** Pure, and implements decision 6. `SevenTvIndexes` maps `StreamPlatform → Arc<SevenTvEmoteIndex>`. 7TV emotes become `type: "emote"`, `text: <alias>`, `image_url: Some(emote_image_url(id))`, `zero_width`.
3. **Coordinator.**
   - Add `seventv: SevenTvIndexes` to `LiveChatCoordinator`, cleared in `start_session` and `stop_session`.
   - Add `seventv_status: SevenTvStatus` for S4.
   - The loader and poll task goes into `tasks`, so the existing abort covers it.
4. **Delivery.** In `try_deliver_messages`, after `mark_first_time_chatters`:
   - Take the coordinator lock briefly to clone the index map, but only while `session_id` still matches.
   - Then call `decorate` _outside_ the lock and before `begin_delivery`.
   - Re-delivery of the same message gives the same fragments (idempotent: emote fragments are never re-scanned).
5. **Loader.** In `start_live_chat_after_install`, after `coordinator.start_session` (S4 adds the setting check):
   - Collect distinct `(platform, account_id)` pairs from Twitch, Kick and YouTube provider rows.
   - Spawn the task. It calls `resolve_connections` → `fetch_sets` → builds per-platform indexes by decision 5.
   - It installs them only if `session_generation` is unchanged, then emits the summary log line.
   - It then loops on `poll_versions` every 30 s with decision 9's backoff and refetches on change.
   - With no Twitch, Kick or YouTube rows, it spawns nothing.
   - X attaching later (`start_x_live_chat`) does nothing here.
6. **Logs.**
   - Linked: `7TV emotes: "<set name>" (<n> emotes + <g> global) for Twitch, Kick, YouTube`.
   - Not linked: `7TV emotes: no 7TV account is linked to the connected Twitch/Kick/YouTube channel`.
   - Failures: one `warn` per distinct class per session.

**Tests** (`live_chat.rs` / `seventv.rs`):

- **`decorate` table:**
  - A Twitch text fragment `"hi catJAM there"` becomes text, emote, text, with the exact whitespace kept.
  - A Twitch `emote` fragment named like a 7TV emote is untouched.
  - A `mention` is untouched.
  - YouTube empty fragments plus `message_text` become built fragments.
  - Kick fragments mixing token emotes and text decorate only the text.
  - No match leaves fragments exactly as they were (empty stays empty).
  - Matching is case-sensitive: `catjam` stays text.
  - `catJAM,` stays text; `WHAT?` matches as a whole token.
  - A multi-byte emoji next to an emote does not panic or split a char.
  - The channel set wins over global.
  - `zero_width` is carried through.
  - `Deleted`, `System`, `Membership`, `Follow` and X rows are untouched.
  - The 101st emote stays text.
  - Running `decorate` twice gives the same result as once.
- **Delivery integration.**
  - Install indexes in a test coordinator. Deliver a Twitch, a YouTube, a Kick and an X message through `try_deliver_messages`.
  - Assert the buffer snapshot, the persisted row (read back through `live_chat_message_from_row`) and the emitted `liveChat.message` all carry the 7TV fragment.
  - The X row does not.
  - The phone projection of the decorated message has text-only fragments and no `imageUrl` (the existing `remote_lan.rs` guarantee, one more case).
- **Loader against the mock GQL server:**
  - Linked on Twitch only: Kick and YouTube borrow the set and global applies.
  - Linked nowhere: no indexes are installed and global does not apply (D1).
  - The session is restarted mid-load: the result is discarded.
  - A poll sees a new `updatedAt`: exactly one refetch, and the index is swapped.
  - A poll sees a changed `activeEmoteSetId`: the new set is fetched.
  - A poll fails: back off, with no request storm (count requests).

**Verification:**

```sh
RUSTUP_TOOLCHAIN=1.98.0 cargo test -p videorc-backend seventv
RUSTUP_TOOLCHAIN=1.98.0 cargo test -p videorc-backend live_chat
RUSTUP_TOOLCHAIN=1.98.0 cargo test -p videorc-backend remote_lan
RUSTUP_TOOLCHAIN=1.98.0 cargo test -p videorc-backend storage::
RUSTUP_TOOLCHAIN=1.98.0 cargo clippy -p videorc-backend -- -D warnings
cargo fmt --check --all
pnpm typecheck
pnpm smoke:live-chat-fake-providers
pnpm smoke:remote-lan
```

`smoke:live-chat-fake-providers` proves the delivery path still converges.
Its fake connector has no 7TV accounts, so no 7TV request is made. Check the
backend log for that.

**Done when:** the tests and both smokes pass; `rg 'decorate' crates/videorc-backend/src/live_chat.rs`
shows exactly one call, in `try_deliver_messages`; and nothing on the
delivery path awaits network I/O.

## Slice S3: images, wide emotes and zero-width stacks (desktop)

Run `videorc-design` first. This is UI.

**Files:**

- `apps/desktop/src/main/avatar-cache.ts`, `avatar-cache.test.ts`
- `apps/desktop/src/main/index.ts` (prune)
- `apps/desktop/src/renderer/src/components/comment-row.tsx`
- `apps/desktop/src/renderer/src/lib/stream-manager-chat.ts`, `stream-manager-chat.test.ts`

**Changes:**

1. **Allowlist** `cdn.7tv.app` in `AVATAR_ALLOWED_HOST_SUFFIXES`, with a comment citing plan 089. Do not allow bare `7tv.app`.
2. **Tests in `avatar-cache.test.ts`.**
   - Flip `:62-64` so that `https://cdn.7tv.app/emote/01FCY771D800007PQ2DF3GDTN6/2x.webp` is allowed.
   - Add a case refusing `https://cdn.7tv.app.evil.example/x.webp`.
   - Keep BTTV refused as the "non-allowlisted CDN" sample.
3. **Cache pressure.** 7TV chats are emote-dense.
   - Raise `AVATAR_CACHE_MAX_FILES` from 500 to 1000.
   - Throttle `pruneAvatarCache` to at most one pass per 5 s plus a trailing pass. Today it runs a synchronous `readdirSync` + `statSync` of the whole directory on the main process for every new file, which is a burst of up to 50k `stat` calls per second when a chat floods new emotes.
   - Put the decision in a pure helper in `avatar-cache.ts`, e.g. `avatarPruneDue(lastPruneAtMs, nowMs)`, and unit-test it.
4. **Wide emotes.** `Emote`'s `<img>` changes from `size-5` to `h-5 w-auto max-w-24 object-contain`.
   - A 3:1 emote shows at 60×20 instead of being squashed.
   - Square Twitch and Kick emotes look the same as today.
   - Row height does not change, so the virtualizer's measurements (`chat-pane.tsx:182-188`) and `followChatOnResize` keep working.
5. **Zero-width.**
   - Add a pure `groupEmoteOverlays(fragments)` to `lib/stream-manager-chat.ts`. It returns the fragments with each zero-width emote folded into the emote before it, when only whitespace text lies between them; that whitespace is dropped.
   - `MessageBody` draws a stack as `<span class="inline-grid place-items-center align-text-bottom" title="catJAM RainTime">`, with every image in `[grid-area:1/1]`.
   - While an overlay's image is still pending it draws nothing. The base still shows its name until its image arrives.
   - A zero-width emote with no emote before it draws inline like any emote.
   - Keep this in the Stream Manager tree (`comments.html`). `chat-avatar.tsx` is in the main window's eager bundle and does not change.
6. **Comment.** In `MessageBody`'s doc comment, write "(Twitch, Kick, 7TV)".

**Tests:**

- `stream-manager-chat.test.ts` gets "renders 7TV emotes from fragments". It mirrors the Kick case at `:141-160` with a `cdn.7tv.app` URL and asserts the alias appears as the pending text.
- `groupEmoteOverlays` table:
  - base + space + overlay → a stack
  - two overlays → one stack with three layers
  - an overlay first → inline
  - an overlay after a word → inline
  - an overlay after an emote plus a word → inline
  - non-emote fragments are untouched
  - flattening the result back to text gives `messageText`
- `avatar-cache.test.ts`: the allowlist changes above, plus the throttle helper.

**Verification:**

```sh
pnpm --filter @videorc/desktop test -- avatar-cache stream-manager-chat comment-row
pnpm typecheck && pnpm lint && pnpm format:check
pnpm build && pnpm check:renderer-assets
pnpm probe:comments-window
```

The renderer budget gate in CI is authoritative (local gzip reads about
1.6 KB high). If it fails, re-split rather than raise the thresholds.

**Done when:**

- The tests and gates pass.
- In a dev build, a message with a wide 7TV emote and `catJAM RainTime` renders unsquashed and stacked. Get this by eye with S2 in place, or with a temporary local fake message that is not committed.
- `probe:comments-window` still passes at its width tiers.

## Slice S4: the toggle and its status line

Run `videorc-design` first. The copy below is a draft for owner taste.

**Files:**

- Backend: `seventv.rs`, `live_chat.rs`, `protocol.rs`, `main.rs`
- Contract: `apps/desktop/src/shared/backend.ts`, `backend-rpc-contract.ts`
- UI: `apps/desktop/src/renderer/src/components/settings/general-settings.tsx`, plus a small hook if the existing settings pattern wants one

**Changes:**

1. **Backend setting.**
   - `ChatEmoteSettings { seven_tv: bool }` defaults `seven_tv` to `true` via a serde default function, so a missing row means on.
   - It is stored under `app_settings` key `chatEmoteSettings` (`Database::load_setting` / `save_setting`, `storage.rs:4853-4876`).
   - S2's loader runs only when the setting is on.
2. **RPCs, modelled on `cohost.settings.get/set`.**
   - `liveChat.emotes.get` → `{ sevenTv: boolean, sevenTvStatus: SevenTvStatus }`.
   - `liveChat.emotes.set` with `{ sevenTv?: boolean }`, which returns the same shape.
   - Classify `get` as an observation and `set` as a mutation in `websocket_method_execution_policy` (`main.rs:5096`). The source-derived test at `main.rs:13922-13960` fails otherwise.
   - TS: add both to `BackendRpcMethodMap` and `runtimeContracts`, with `allowUnknown: false` result and patch schemas.
3. **`SevenTvStatus`.**
   - Fields: `state: 'off' | 'idle' | 'loading' | 'linked' | 'notLinked' | 'error'`, `setName?`, `emoteCount?`, `globalCount?`, `platforms?: StreamPlatform[]`, `error?`.
   - Every Rust `Option` gets `skip_serializing_if` (the serde-null trap).
   - The value is the last outcome in this app run.
4. **Toggling during a session.**
   - Off: clear the indexes, abort the 7TV task, set the status to `off`. New messages are plain; already-decorated rows keep their emotes.
   - On: spawn the loader for the current session.
5. **UI.**
   - The row goes in General, directly after "Open Stream Manager when I go live", with the same `commentsWindowEnabled` visibility rule.
   - It reuses the existing `Field` + `Switch` row (`general-settings.tsx:42-61`).
   - **Label:** "Show 7TV emotes in chat"
   - **Description:** "Your channel's 7TV emotes, in Twitch, Kick and YouTube chat."
   - **Status line, muted text, `text-xs`, one of:**
     - "Loads when you go live." (idle)
     - "Loading…"
     - "“Halloween Emotes 2026” · 986 emotes" (linked)
     - "No 7TV account is linked to your Twitch, Kick or YouTube channel." (notLinked)
     - "7TV couldn't be reached. Chat works without its emotes." (error)
   - Off shows no status line.
   - Settings is lazy-loaded, but the contract entries load eagerly in the main window, so re-run the budget gate.

**Tests:**

- **Rust:**
  - The setting defaults to on when the row is absent, and `set` persists.
  - Turning it off mid-session stops decoration of the next delivered message and aborts the task (the mock server sees no more polls).
  - Turning it on mid-session loads.
  - The method-policy test passes.
- **TS:**
  - Contract schema tests accept a full status and reject an unknown key.
  - A `general-settings` component test: the switch reflects `get`, toggling calls `set`, and each status state renders its copy.

**Verification:**

```sh
RUSTUP_TOOLCHAIN=1.98.0 cargo test -p videorc-backend seventv
RUSTUP_TOOLCHAIN=1.98.0 cargo test -p videorc-backend live_chat
RUSTUP_TOOLCHAIN=1.98.0 cargo test -p videorc-backend websocket_method
RUSTUP_TOOLCHAIN=1.98.0 cargo clippy -p videorc-backend -- -D warnings
cargo fmt --check --all
pnpm --filter @videorc/desktop test -- general-settings backend-rpc-contract
pnpm typecheck && pnpm lint && pnpm format:check
pnpm build && pnpm check:renderer-assets
```

**Done when:** the gates pass and the toggle works in a dev build. Off means
no `7tv.io` request appears in the backend log for a whole session.

## Slice S5: live acceptance, privacy line, release note

**Setup (owner):** link a 7TV account to the Twitch channel at 7tv.app (log
in with Twitch). Add one wide emote and one animated emote to its set.
`RainTime` (global, zero-width) and `EZ` (global) need nothing.

Dev build, Twitch connected, a test stream. From a second account, send:

| Message                         | Expected                               |
| ------------------------------- | -------------------------------------- |
| `catJAM` (or any channel emote) | animated image                         |
| `EZ`                            | global image                           |
| `catJAM RainTime`               | rain stacked on catJAM                 |
| a wide emote                    | unsquashed, about 3:1                  |
| `catJAM,` and `catjam`          | text                                   |
| `Kappa catJAM`                  | Twitch image + 7TV image               |
| `@<streamer> catJAM`            | mention badge still shown, emote drawn |

Also confirm:

- **Live update:** add a new emote on 7tv.app mid-stream; it renders within about 30 s.
- **Status line:** shows the set name and count.
- **Toggle off:** new messages are plain and the log shows no further 7TV requests.
- **Search:** `catJAM` finds the row.
- **Copy:** gives `name: catJAM RainTime`.
- **Highlight card:** shows the words.
- **Phone remote:** shows text.
- **After relaunch:** the session's rows (History) still show images.
- **Support bundle:** contains the `7TV emotes:` line.
- **Kick and YouTube:** if connected, the same emotes render there, linked or borrowed per decision 5.

**Then:**

- **D3:** the videorc-web privacy paragraph PR. Deploy it before the desktop release.
- **D4:** skim the terms.
- **Release note:** "The Stream Manager now shows your channel's 7TV emotes in Twitch, Kick and YouTube chat, including zero-width emotes. Turn it off in Settings → General."
- Run `seventv_live_schema` once more on the release commit.

**Done when:** every row above is confirmed by eye, and D3/D4 are resolved.

## Edge cases

- **7TV down or slow.** The loader logs one `warn`, the status shows the error, and chat is unaffected. Polls back off to 300 s.
- **A 7TV schema change.** GraphQL `errors` or a decode failure means the same as down. The `#[ignore]` live test catches it before a release.
- **A set larger than 2,500 emotes.** The loader follows pages, up to 4. Past that it logs a truncation; nothing is silent.
- **The streamer switches their active set mid-stream.** The poll sees the new `activeEmoteSetId` and refetches.
- **Two accounts on one platform** (e.g. YouTube horizontal + vertical). The first account's row wins (existing caveat, `live_chat.rs:1367-1372`). Both legs of one channel share its set anyway.
- **An emote image fails or times out (4 s).** The renderer memo keeps the failure for the window's lifetime (`chat-avatar.tsx:24-40`), so that emote stays as text until the window reopens. This is a known limit; see the follow-ups.
- **A huge animated emote.** 2x.webp is at most 1.16 MB seen; past 2 MB the cache refuses it and the name stays as text, with a deduped `too-large` log.
- **Word collisions** (`EZ`, `Clap`, `Stare`). This is intended 7TV behaviour. The toggle is the escape.
- **Messages delivered before the set loads** (~1 s after Go Live). They stay text. This is accepted; prefetching before Go Live is a follow-up.

## Out of scope / follow-ups

- **7TV EventAPI push**, for sub-second updates. Revisit if 7TV starts acking subscriptions.
- **7TV personal emotes** (subscriber sets usable in any channel), **badges and name paints**. These need per-chatter entitlement lookups or EventAPI cosmetics.
- **BTTV and FFZ.** They fit the same index and `decorate` seam: one loader each, plus their CDN hosts on the allowlist.
- **Emote images on the on-stream highlight card.** It is text for every platform today (as plan 085 noted).
- **Tab completion of emote names in the composer** (`chat-pane.tsx:570-744`).
- **Decorating rows stored before this feature, at read time.** It would need a process-global index in `storage.rs`.
- **Prefetching the set when an account connects or the app starts**, so the first second after Go Live is covered too.
- **Retrying a failed image URL after ~60 s** instead of never (`chat-avatar.tsx`). This touches the main window's eager bundle.
- **YouTube's own custom emoji** (`:shortcode:` text). It is a separate feature.

## Execution notes (2026-10-01)

Branch `plan/089-7tv-emotes`, one commit per slice: S1 `5a03e34f`, S2
`747966e9`, S3 `290c21c8`, S4 `75b40e70`. The privacy paragraph (D3) is
videorc-web PR #66, open and unmerged. D1 and D2 use the recommended defaults.

**Where the build differs from the plan, and why:**

- **The zero-width helper lives in `lib/chat-emotes.ts`, not `lib/stream-manager-chat.ts`.**
  That module already imports `comment-row`, so putting it there would have made a cycle.
- **The prune throttle helper returns a delay (`avatarPruneDelayMs`), not a boolean.**
  Main needs the delay to schedule the trailing pass.
- **The 7TV loader has its own task handle (`seventv_task`) instead of joining `tasks`.**
  That lets the Settings switch stop it alone. `abort_tasks` still aborts it with the connectors.
- **The Settings row opens its own short-lived backend client, as Upcoming does, instead of going through `use-studio`.**
  The main window's eager bundle is byte-identical in raw size (1,993,737 raw before and after S4).
- **`needs_reload` was added.**
  With nothing linked, the global set is unused, so its edits do not trigger a reload. A link appearing still does.
- **The loading line reads "Loading your 7TV emotes…".**
- **Unit tests start with 7TV off.**
  The coordinator has no 7TV endpoint under `cfg(test)`, so no test reaches the network. Tests that want the loader point it at a mock server.

**Verified locally:**

- **Rust:** 336 targeted backend tests and 260 live-chat-path tests pass, including `seventv`, `live_chat`, `remote_lan`, `storage::`, Kick, Twitch, YouTube, X, Orcle, highlight, and the method-policy inventory. `seventv_live_schema` passes against production 7TV. Clippy `-D warnings` and `cargo fmt --check` are clean, all on Rust 1.98.0.
- **Desktop:** the full desktop suite passes (245 files, 2,513 tests). Typecheck, format and build pass. Lint shows 1 warning, which is pre-existing in `use-studio.tsx`. The renderer budget is 385,065 gzip (local).
- **Smokes:** `smoke:live-chat-fake-providers` passes (375 messages, no 7TV request without accounts). `smoke:remote-lan` passes.
- **Comments window:** `probe:comments-window` passes all 154 assertions.
- **By eye:** a throwaway copy of `probe:comments-window`, deleted afterwards, rendered real 7TV images in the Stream Manager:
  - `catJAM` with `RainTime` stacked on it
  - the 96×32 `yonose`, unsquashed
  - `GAMBA`
- **Settings:** `capture-ui-pages` shows the new General row, on by default, reading "Loads when you go live."

**Still owed:**

- S5 live acceptance by the owner (the table above).
- Merge and deploy web PR #66 before the release.
- D4: skim the terms.
- Run `seventv_live_schema` on the release commit.
