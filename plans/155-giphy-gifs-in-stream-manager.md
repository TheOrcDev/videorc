# Plan 155: Twitch GIFs (GIPHY) in the Stream Manager

**Status:** EXECUTED 2026-10-05, in review on
`cursor/giphy-gifs-stream-manager-4f7e` (S1–S6 and the S8 code and docs;
S0, S7 and the S8 live acceptance and privacy paragraph stay with the owner,
see "Execution record" below). **Priority:** P2 (a feature; GIF messages
already arrived and showed as bracketed title text, so nothing was broken,
but paying Tier 2/3 subs' perk was invisible in Videorc). **Size:** M, 8
slices. **Planned against:** `671c67d2` (origin/main, 0.9.133). **Owner
route:** Implementation (fit 8; the fragment seam, the image cache, the
settings pattern and the fake-provider harness all exist from plans 055, 085,
089 and 151). Desktop, plus one privacy paragraph on videorc-web.

## Execution record (2026-10-05)

Done on the branch, each slice its own commit:

- **S1–S2** `twitch_chat.rs` keeps a `gif` fragment's `gif.url` only when
  `twitch_gif_asset_url` accepts it (https, no userinfo, ≤ 2048 chars, host
  on `TWITCH_GIF_ASSET_HOSTS`: `giphy.com`, `static-cdn.jtvnw.net`); a
  refused host is logged once per host. Tests for the gate, the stored
  fragment round trip, the phone-remote projection (title only), the
  `eventMessages` contract fixture (`session-fixture:twitch:gif-1`) and a
  reference-shaped EventSub fixture `scripts/fixtures/stream-manager/twitch-chat-gif.json`.
- **S3** `shared/chat-gif.ts` (the TS twin of the gate, `gifTitle`,
  `sniffChatImage`, the mode type); main's `chat-gifs:cache` with its own
  policy (8 MB, 15 s, GIF/WebP/PNG sniff) and `avatarPrunePlan` (1000 files
  and 256 MB); `electron-ipc-contract` validates the URL with the same gate.
- **S4** `ChatGif` in `comment-row.tsx` per D5 (h-16 / h-24 block, title and
  a GIF `Badge` until cached, `data-slot="comment-gif"`), `splitGifFragments`
  in `lib/chat-gifs.tsx`, `useCachedAvatar(url, 'gif')`, Still via a canvas
  first frame, Off never fetches, `prefers-reduced-motion` forces Still.
- **S5** `ChatEmoteSettings.twitch_gifs: TwitchGifMode` (serde default
  Animated; legacy rows read as Animated), the patch field, the RPC schema,
  and a `TwitchGifsFieldView` `Select` under the 7TV row in Settings → General,
  both driven by one `useChatEmoteSettings` client.
- **S6** `cohost::tick_text_with_gifs` (`sent a GIF: <title>` /
  `(GIF: <title>)`); `highlightTokens` names a GIF `GIF: <title>` on the card
  instead of painting it (D8).
- **S8** `FakeChatConfig.gif` delivers one Twitch GIF row; the fake-providers
  smoke asserts its shape; the provider-facts row; this record.

**Deviation from S5 as written.** The Stream Manager window has no backend
socket (every value reaches it through main from the main renderer), so it
cannot read `liveChat.emotes` itself. The mode travels like the viewer-count
relay: the main renderer pushes `chat-gifs:push-mode` on `liveChat.emotes`
(and seeds it once on connect), main caches it and sends `chat-gifs:mode`;
the window reads `chat-gifs:get-mode` on mount. A `ChatGifModeProvider`
context supplies it to rows, so `ChatPane` and `StreamManager` props are
unchanged.

**Owed to the owner (cannot be done from this environment):**
- **S0** capture one real `type: "gif"` fragment from the owner's Twitch
  account and confirm the asset host; if it is not under `giphy.com` or
  `static-cdn.jtvnw.net`, add it to both `TWITCH_GIF_ASSET_HOSTS` and
  `TWITCH_GIF_ASSET_HOST_SUFFIXES` (one line each) and re-run the gates.
- **S7** stays unbuilt (optional, depends on S0's rendition size).
- **S8** the videorc-web privacy paragraph (D15; separate repository), the
  release-note line, and the live acceptance table below.
- Confirm or override D6 (Animated default), D7 (Orcle rewrite), D8 (card
  text) and D14.

**Gates run here (Linux, no display):** `pnpm typecheck`, `pnpm lint` (one
pre-existing warning in `use-studio.tsx`), `pnpm format:check`,
`pnpm --filter @videorc/desktop test`, `cargo fmt --check --all`,
`cargo test -p videorc-backend` for `twitch_chat`, `remote_lan`, `storage`,
`protocol`, `seventv`, `live_chat`, `cohost`, and `cargo clippy`. Not run:
`smoke:live-chat-fake-providers`, `smoke:cohost-fake`, `probe:comments-window`
(they launch the Electron dev app, which needs a display); the owner should
run them on macOS before merge.

## Goal

A Tier 2 or Tier 3 subscriber sends a GIF from Twitch's GIF Keyboard. The
Stream Manager shows the GIF, animated, under the viewer's name, the way
Twitch's own chat does. Plain-text surfaces (Orcle, search, Copy, highlight
card, phone remote) see a readable title, never the raw `[Y A Y Yes GIF]`.
The streamer can make GIFs still or hide them.

## What "Giphy support" means here, and what it does not

Twitch's integration is **Twitch-delivered content**: Twitch hosts the GIF
Keyboard, filters by GIPHY rating, and sends the chosen GIF to every chat
client as a fragment of a normal chat message. Videorc's job is to render
what Twitch sends. This plan needs **no GIPHY API key, no GIPHY search, and
no GIPHY SDK**. Sending GIFs from Videorc's composer is out of scope: the
keyboard is a Twitch web/mobile client feature for subscribers, and Helix
Send Chat Message has no GIF parameter. Kick, YouTube and X have no GIF
feature, so this is Twitch-only.

## Verified facts (2026-10-05)

| What | Fact | Source |
| --- | --- | --- |
| Launch | GIF Keyboard, powered by GIPHY, announced at TwitchCon Rotterdam (2026-05-30), launched 2026-09-01. Tier 2 and Tier 3 paid subs only; one GIF per message; 30 s cooldown per user; on by default; streamer can turn it off (subs are notified) and pick G or PG. Blocking single GIFs has not shipped. Help still says "available to a limited number of channels", Dexerto says all monetized channels: the owner's channel must be Affiliate/Partner and may or may not have it yet. | [Twitch blog](https://blog.twitch.tv/en/2026/05/30/everything-we-announced-at-twitchcon-rotterdam-2026/), [Help: GIF Keyboard](https://help.twitch.tv/s/article/gif-keyboard), [Dexerto](https://www.dexerto.com/twitch/twitch-finally-lets-subscribers-send-gifs-directly-in-chat-3404802/) |
| EventSub | 2026-07-16: `channel.chat.message` fragments gain `type: "gif"`. The fragment carries `text` plus a `gif` object with the GIF id and `url`. **Discrepancy:** the changelog names the id `gif_id`; the reference table names it `id`. | [Changelog](https://dev.twitch.tv/docs/change-log/), [EventSub reference](https://dev.twitch.tv/docs/eventsub/eventsub-reference/) "Channel Chat Message Event" |
| The URL rule | "Applications rendering the GIF must use the full URL provided; it must not be modified." This inverts plan 089's rule (build URLs ourselves). The guard becomes a strict host allowlist plus a content sniff. | EventSub reference |
| The text | A GIF is a normal message whose text is the GIF's title in square brackets, e.g. `[Y A Y Yes GIF]`. Third-party bots exempt it from caps/word filters because the viewer did not type it. | [bytemike.de](https://bytemike.de/en/twitch-chat-gifs/) (third party; confirm in S0) |
| `message_type` | Unchanged: `text`, `channel_points_highlighted`, `channel_points_sub_only`, `user_intro`, `power_ups_*`. No GIF message type; the fragment is the only marker. | EventSub reference |
| Moderation | A GIF message is deleted, timed out and banned like any message. | Help article |
| IRC | 2026-07-17 added a `gif` PRIVMSG tag. Irrelevant: `twitch_chat.rs` is EventSub-only. | Changelog |
| Fallback | Twitch shows the GIF's name where a GIF cannot render, and a static preview when a viewer disables animations. | Help article |

**Unverified, and load-bearing (S0):** the asset **host** of `gif.url`
(GIPHY's `media*.giphy.com` / `i.giphy.com`, or a Twitch proxy such as
`static-cdn.jtvnw.net`), the **rendition** (original `giphy.gif` can be
several MB; a fixed-height rendition is hundreds of KB), the **content type**
(GIF, WebP or MP4), whether `message.text` equals the fragment text, and
whether a GIF can ever share a message with typed text. No public payload
exists; the one example found online was synthesized, not captured.

## Current state (code at `671c67d2`)

- **Backend already keeps the fragment.** `parse_fragments`
  (`twitch_chat.rs:358`) copies any `type` string and sets `image_url` only
  from `emote.id`. A GIF fragment therefore arrives today as
  `{ type: "gif", text: "[Y A Y Yes GIF]", image_url: None }`, and the row
  shows the bracketed title. Rows stored before this plan keep that shape.
- **Fragment model.** `LiveChatMessageFragment { type, text, image_url,
  zero_width }` (`live_chat.rs:132`); TS mirror in `shared/backend.ts`.
  `type` is free-form, so no contract change is needed to carry `gif`.
- **Renderer.** `FragmentText` (`comment-row.tsx:304`) draws images only
  when a fragment has `imageUrl`, through `groupEmoteOverlays`
  (`lib/chat-emotes.ts`), which treats every image as a 20 px emote. A GIF
  needs its own branch, or it renders as a thumbnail.
- **Image path.** The CSP forbids `https:` in `img-src`; every image goes
  through main's allowlisted cache (`main/avatar-cache.ts`, handler in
  `main/index.ts:13317`): https only, host-suffix allowlist, `AVATAR_MAX_BYTES`
  = 2 MB, `AVATAR_FETCH_TIMEOUT_MS` = 4 s (a slice of the highlight relay
  budget), 1000 files pruned by count only, `.gif` extension kept
  (`avatarCacheFileName`). No content sniff. The renderer memo
  (`lib/chat-avatar.tsx`) keeps a failure for the window's lifetime.
- **Virtualizer.** `chat-pane.tsx:211` uses `measureElement` with a 58 px
  estimate; `followChatOnResize` keeps a pinned chat on the newest row.
- **Settings.** `ChatEmoteSettings { seven_tv }` under `app_settings` key
  `chatEmoteSettings` (`seventv.rs:896`), RPC `liveChat.emotes.get/set`, patch
  `deny_unknown_fields`, event `liveChat.emotes`; UI
  `settings/seventv-emotes-field.tsx` with `useChatEmoteSettings`.
- **Plain-text consumers.** Orcle's tick reads `message_text`
  (`cohost.rs:5326`); the highlight card draws emotes from cached bytes ≤ 2 MB
  (`caption-overlay.ts:564`, plan 095); search and Copy read `messageText`;
  the phone remote projects `type` + `text` and strips `imageUrl`
  (`remote_lan.rs:603`).
- **Fakes and probes.** `FakeChatConfig.emote` injects an emote fragment
  (`live_chat.rs:3447`); `scripts/comments-window-probe.mjs` sweeps widths;
  `smoke:live-chat-fake-providers` proves delivery.
- **Docs.** `docs/specs/stream-manager-provider-facts.md` lists Twitch
  fragment types as text, emote, cheermote and mention (plan 151 row).

## Decisions (the recommendation is taken; ⚑ = the owner may override)

- **D1 Scope.** Render Twitch-delivered GIFs. No GIPHY API, no composer
  send, Twitch only.
- **D2 Backend keeps `type: "gif"` and takes the URL only through a gate.**
  `parse_fragments` reads `gif.url` (and `gif.id` or `gif_id`, logged once
  for the S0 fixture, not stored) and sets `image_url` only when
  `twitch_gif_asset_url(url)` accepts it: `https:`, no userinfo, ≤ 2,048
  chars, host on `TWITCH_GIF_ASSET_HOSTS`. A rejected URL leaves `image_url`
  `None` (title text, one deduped `warn` with the host), never a modified
  URL. `text` stays exactly Twitch's. A pure `gif_title("[Y A Y Yes GIF]")
  -> "Y A Y Yes"` strips one pair of brackets and one trailing ` GIF`, else
  returns the text; it feeds Orcle and the card, never `message_text`.
- **D3 Host allowlist, decided by S0, mirrored in Rust and main.** The S0
  capture names the host; both `TWITCH_GIF_ASSET_HOSTS` (Rust) and the main
  allowlist get exactly that suffix with a comment citing the fixture.
  Working assumption until S0: `giphy.com` (covers `media0–4.giphy.com`,
  `i.giphy.com`) and `static-cdn.jtvnw.net`. Because a suffix this wide also
  admits HTML pages, main adds a **magic-byte sniff** for the GIF kind:
  `GIF87a`/`GIF89a`, RIFF/WEBP or PNG, else rejected as `not-an-image`.
- **D4 GIFs get their own caps, not the avatar's.** A new `kind: 'gif'` on
  the cache IPC (schema-validated; roles unchanged): `CHAT_GIF_MAX_BYTES`
  = 8 MB, `CHAT_GIF_FETCH_TIMEOUT_MS` = 15 s (never on the highlight relay
  budget), GIF hosts allowed only for this kind (avatars never come from
  GIPHY). The shared cache gains a byte budget, `AVATAR_CACHE_MAX_BYTES`
  = 256 MB, pruned oldest-first beside the file count, as a pure
  `avatarPrunePlan(entries, limits)`. Fetches stay lazy: only mounted rows
  (viewport + overscan 10) resolve images, so a flood does not download
  every GIF.
- **D5 How a GIF looks** (`videorc-design`): a block under the author line,
  `h-24` (96 px) comfortable / `h-16` compact, `w-auto max-w-full
  object-contain`, `rounded-row`, a hairline, no shadow. Any text fragments
  render as today above it. **The slot keeps its height while loading and
  when the image fails**, showing the title in muted text with an outline
  `Badge` "GIF", so the row never jumps and a pinned chat stays pinned. The
  title is the `alt` and `title`. A left click still means the row (Show on
  stream); no new menu.
- **D6 ⚑ One setting: Settings → General → "GIFs in Twitch chat": Animated
  (default) · Still · Off.** Still draws the first frame once to a `<canvas>`
  (a GIF in `<img>` always animates in Chromium). `prefers-reduced-motion`
  forces Still. Off means the renderer never asks main to fetch, so GIPHY
  never sees the streamer's IP; the backend still stores the URL, so flipping
  back on shows every row, including History. Stored as
  `ChatEmoteSettings.twitch_gifs` through the existing `liveChat.emotes`
  RPC. Override: default Still.
- **D7 ⚑ Orcle hears a GIF as a GIF.** `tick_message_from_chat` rewrites a
  message whose fragments are only GIFs (plus whitespace) to
  `sent a GIF: Y A Y Yes`, and a mixed message replaces each GIF fragment's
  text with `(GIF: title)`. Otherwise Orcle reads `[Y A Y YES GIF]` as the
  viewer shouting. Override: drop GIF-only messages from the tick.
- **D8 ⚑ The highlight card shows the title, not the brackets, in v1.**
  `commentHighlightCardText` uses `gif_title`'s TS twin. Drawing the first
  frame on the card is S7 (optional): it needs the cached bytes under the
  card's 2 MB `readChatAvatar` cap, which S0 tells us. Override: text only,
  no S7.
- **D9 Search and Copy.** Unchanged: `messageText` already holds the title,
  so search finds it and Copy gives `name: [Y A Y Yes GIF]`.
- **D10 Phone remote.** Unchanged: `type: "gif"` and the text project; no new
  field reaches the LAN, so no leak argument is needed.
- **D11 Moderation and Activity.** Unchanged: Remove from chat works on a
  GIF message; a GIF is not an Activity event.
- **D12 History.** Rows stored with `imageUrl` replay with GIFs. Rows stored
  before this plan (type `gif`, no `imageUrl`) stay title text: unlike plan
  085 there is no read-time repair, because we never build a URL.
- **D13 Fake data.** The fake Twitch provider gets one GIF message per
  session, through the same mechanism `FakeChatConfig.emote` uses for its
  image, so dev, the probe and the fake-provider smoke show one.
- **D14 ⚑ No GIPHY mark.** Videorc renders Twitch content as any Twitch
  client does; the outline "GIF" tag on the placeholder is the only label.
  Override: a small "via GIPHY" tooltip suffix.
- **D15 Privacy page.** One paragraph on videorc.com/privacy, next to the
  7TV one: if GIFs are on, Videorc downloads GIF images from the URL Twitch
  supplies (GIPHY's CDN), which receives the streamer's IP; off in Settings.
  Web PR deploys before the desktop release.

## Slices

**S0: capture one real payload (owner + dev build).**
- Needs a second account with a Tier 2 sub to the owner's channel, in a
  channel where the keyboard is enabled. With the dev app connected and
  EventSub frames logged, send one GIF and one GIF plus text if the keyboard
  allows it.
- Record: the fragment JSON (id key name, `url`), `message.text`, the host,
  `content-type`, byte size, dimensions, cache headers.
- Save the reshaped payload as `scripts/fixtures/stream-manager/twitch-chat-gif.json`
  (no account ids). Fill D3 and the D8 size question.
- *Done when:* the fixture exists and D3's host is named. If S0 cannot run,
  S1–S3 proceed on the D3 working assumption, and S8 carries the risk.

**S1: backend parses the GIF fragment (`twitch_chat.rs`, `live_chat.rs`).**
- `parse_fragments`: a `gif` arm using `twitch_gif_asset_url`; a pure
  `gif_title`. Constants `TWITCH_GIF_ASSET_HOSTS`, `TWITCH_GIF_URL_MAX_CHARS`.
- Tests: a GIF-only message gives one `gif` fragment with the URL and
  `message_text` `[Y A Y Yes GIF]`; `gif_id` and `id` both read; `http:`,
  userinfo, a foreign host and a 3,000-char URL each give `image_url: None`
  and one `warn`; `gif_title` table (brackets, trailing ` GIF`, no brackets,
  empty); the S0 fixture replays end to end through `normalize_chat_message`;
  a Twitch `emote` beside a `gif` keeps both.
- *Done when:* `cargo test -p videorc-backend twitch_chat` passes.

**S2: contract and projections.**
- `protocol-fixtures/high-risk-contracts.json`: one Twitch GIF message
  beside the emote example; the fixture parity tests pass in Rust and TS.
- `remote_lan.rs` test: a `gif` fragment projects as `type` + `text`, no
  `imageUrl` (one more case on the existing guarantee).
- `storage.rs` test: a row with a `gif` fragment round-trips `fragments_json`.
- New `lib/chat-gifs.ts`: `gifTitle(text)`, and `splitGifFragments(fragments)
  -> Array<{ kind: 'gif'; url; title } | { kind: 'rest'; fragments }>` so
  non-GIF runs still flow through `groupEmoteOverlays`.
- *Done when:* `pnpm typecheck` and the fixture, `remote_lan` and `storage::`
  tests pass.

**S3: main cache gains the GIF kind (`main/avatar-cache.ts`, `main/index.ts`,
`preload`, `shared/electron-ipc-contract.ts`).**
- `kind: 'avatar' | 'gif'` on `cacheChatAvatar` (schema-validated, default
  `avatar`), per-kind allowlist, caps and deadline per D4, the magic-byte
  sniff per D3 as a pure `sniffChatImage(bytes)`, and `avatarPrunePlan` with
  the byte budget. New rejection kinds `not-an-image` and `kind-host`.
- Tests: GIF host allowed for `gif` and refused for `avatar`; 7TV refused for
  `gif`; a 5 MB body passes `gif` and fails `avatar`; the sniff accepts
  GIF/WebP/PNG and refuses HTML; the prune plan removes oldest files past
  either limit; the rejection messages never carry a path.
- *Done when:* `pnpm --filter @videorc/desktop test -- avatar-cache
  electron-ipc-contract` passes and `oauth`/`chat:open-link` policies are
  untouched.

**S4: the GIF in the row (`videorc-design` first).**
- `comment-row.tsx`: a `ChatGif` component per D5 and D6 (Animated `<img>`,
  Still `<canvas>` first frame, Off title-only), `data-slot="comment-gif"`;
  `FragmentText` runs `splitGifFragments` first.
- `useCachedAvatar` gains the kind argument (one extra parameter, same memo).
- Tests: a GIF-only row renders the slot with the title while pending and
  the image once cached; the slot height equals the density's height in both
  states; Off renders the title only; a mixed row renders text then the GIF;
  `[emote:` and `[… GIF]` never appear beside an image.
- `probe:comments-window`: capture a GIF row at 320/640/1040 and assert no
  overflow and no row-height change between pending and loaded.
- *Done when:* the tests and the probe pass, and
  `pnpm build && pnpm check:renderer-assets` stays under budget (CI Linux is
  authoritative).

**S5: the setting (`seventv.rs`, `backend-rpc-contract.ts`, Settings).**
- `ChatEmoteSettings.twitch_gifs: TwitchGifMode` (`animated` default via
  serde default, `still`, `off`), the patch field, and the TS schema with
  `allowUnknown: false`.
- A `TwitchGifsField` under the 7TV row in General, same visibility rule:
  label "GIFs in Twitch chat", description "GIFs Tier 2 and Tier 3 subscribers
  send from Twitch's GIF Keyboard.", a 28 px `Select` with the three modes.
- The Stream Manager reads the mode from the `liveChat.emotes` event, so a
  change applies to the next render without a reopen.
- Tests: default `animated` when the row is absent; `set` persists and emits;
  a `general-settings` component test for the three modes; the method-policy
  test; the contract rejects an unknown key.
- *Done when:* the gates pass and Off shows no GIF fetch in the backend log
  for a whole session.

**S6: Orcle and the card text (D7, D8).**
- `cohost.rs` `tick_message_from_chat`: the GIF rewrite as a pure
  `tick_text_with_gifs(message)`; tests for GIF-only, mixed and no-GIF rows,
  and that a GIF-only row still reaches the tick.
- `caption-overlay.ts` `commentHighlightCardText`: `gifTitle` for a GIF-only
  message; a test.
- *Done when:* `cargo test -p videorc-backend cohost::tick` and the
  caption-overlay tests pass; `smoke:cohost-fake` still passes.

**S7 (optional, after S0): the first frame on the highlight card.** Only if
the S0 rendition fits the 2 MB bytes cap: `highlightTokens` gets a `gif`
token drawn at card emote height × 3, from `readChatAvatar` bytes decoded
with `createImageBitmap` (frame 0). Otherwise the card keeps D8's text.

**S8: fakes, docs, privacy, live acceptance.**
- D13's fake GIF; `docs/specs/stream-manager-provider-facts.md` gets a
  "GIFs (plan 155)" row and amends the plan 151 row's fragment list;
  `docs/icon-set.md` unchanged (no new glyph).
- The videorc-web privacy paragraph (D15).
- Release note: "Twitch GIFs from Tier 2 and Tier 3 subscribers now show in
  the Stream Manager. Make them still or hide them in Settings → General."
- Live acceptance (owner, dev build, Twitch connected, the S0 account):

| Message | Expected |
| --- | --- |
| a GIF | animates under the name, title on hover; row height unchanged while loading |
| the same GIF again | second row renders at once (cache hit, no fetch) |
| Still | first frame, no motion |
| Off | the title and a GIF tag, no request in the backend log |
| Show on stream | the card reads the title, not the brackets |
| Orcle on | the tick sees `sent a GIF: …`, never the shouting |
| Remove from chat | works as on any message |
| Search for a title word | finds the row |
| Phone remote | title text only |
| relaunch → History | GIFs still render |
| support bundle | the one `warn` for a rejected host, if any |

## Edge cases

- **Fetch fails or times out (15 s).** The slot keeps the title; the memo
  keeps the failure for the window's lifetime (plan 089's known limit).
- **Over 8 MB.** `too-large`, deduped; title stays.
- **A rendition that is MP4.** The sniff refuses it (an `<img>` cannot play
  it); title stays, one `warn`. S0 decides whether to add a `<video>` path.
- **A flood** (hundreds of Tier 2 subs, 30 s cooldown each): lazy fetch by
  mounted rows, in-flight dedupe by URL, the byte budget.
- **Deleted GIF message.** The deletion path clears fragments; the row shows
  the removed state as today.
- **GIF beside text** (if Twitch ever allows it): text above, the block
  below; the probe covers it with the fake.
- **Shared chat** (`source_broadcaster_user_id`): unchanged.
- **The streamer disables the keyboard on Twitch:** nothing arrives.
- **Reduced motion:** Still regardless of the setting.

## Out of scope / follow-ups

- Sending GIFs from the composer, GIPHY search, a GIF picker, a GIPHY key.
- Kick, YouTube and X (no GIF feature).
- Per-GIF blocking (Twitch has not shipped it), a GIFs filter chip, GIF
  counts in the stats bar.
- GIF images on the phone remote.
- IRC `gif` tag parsing.
- Retrying a failed image after ~60 s (shared with plan 089's follow-up).

## Verification gates

Targeted, per the owner's rule, then the broad set once at the end:

- Rust: `cargo fmt --check --all`; `cargo test -p videorc-backend twitch_chat`,
  `live_chat`, `remote_lan`, `storage::`, `cohost::tick`, `seventv`,
  `websocket_method`; `cargo clippy -p videorc-backend -- -D warnings`.
- TS: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`;
  `pnpm --filter @videorc/desktop test`.
- `pnpm build && pnpm check:renderer-assets`.
- `pnpm smoke:live-chat-fake-providers`, `pnpm smoke:remote-lan`,
  `pnpm smoke:cohost-fake`, `pnpm probe:comments-window`.
- No recording, preview or native path is touched: no recording smokes.

## Owner actions

- S0: a Tier 2 sub account and one real GIF, to name the host and rendition.
- Confirm or override D6 (Animated default), D7 (Orcle rewrite), D8/S7
  (card: text now, frame later), D14 (no GIPHY mark).
- Merge and deploy the privacy paragraph before the desktop release.
- Live acceptance table in S8.

## Handoff (cold start)

- **Goal:** Twitch GIF Keyboard messages render as GIFs in the Stream
  Manager, with Animated/Still/Off, and read as titles everywhere text-only.
- **State:** planned only, against `671c67d2`. No branch.
- **Files:** `crates/videorc-backend/src/{twitch_chat,live_chat,seventv,cohost,remote_lan,storage}.rs`;
  `apps/desktop/src/main/{avatar-cache,index}.ts`;
  `apps/desktop/src/shared/{backend,backend-rpc-contract,electron-ipc-contract}.ts`;
  `apps/desktop/src/preload/index.ts`;
  `apps/desktop/src/renderer/src/lib/{chat-gifs,chat-avatar,caption-overlay}.ts*`;
  `apps/desktop/src/renderer/src/components/{comment-row.tsx,settings/*}`;
  `protocol-fixtures/high-risk-contracts.json`;
  `scripts/fixtures/stream-manager/twitch-chat-gif.json`;
  `scripts/comments-window-probe.mjs`;
  `docs/specs/stream-manager-provider-facts.md`.
- **Order:** S0 → S1 → S2 → S3 → S4 → S5 → S6 → (S7) → S8. S1–S3 may start
  before S0 on the D3 assumption; S3's allowlist and S7 wait for S0's answer.
- **Blockers:** S0 needs a Tier 2 sub in a keyboard-enabled channel; without
  it the host allowlist ships on an assumption and S8 is the proof.
