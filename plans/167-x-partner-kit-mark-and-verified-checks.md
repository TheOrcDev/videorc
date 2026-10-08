# Plan 167: X's partner icon kit (the official X mark everywhere, verified checks in chat)

> **Executor instructions**: Follow this plan slice by slice. Run every "Done
> when" check before moving on. If anything in "STOP conditions" happens, stop
> and report; do not improvise. When done, update this plan's row in
> `plans/README.md` and fill in "As built".
>
> **Drift check (run first)**:
> `git diff --stat 2efe2baf..origin/main -- apps/desktop/src/renderer/src/components/icons.tsx apps/desktop/src/renderer/src/components/platform-glyph.tsx apps/desktop/src/renderer/src/components/chat-platform-icon.tsx apps/desktop/src/renderer/src/components/comment-row.tsx apps/desktop/src/renderer/src/lib/caption-overlay.ts apps/desktop/src/renderer/src/lib/comment-highlight.ts apps/desktop/src/shared/backend.ts crates/videorc-backend/src/x_chat.rs crates/videorc-backend/src/live_chat.rs crates/videorc-backend/src/storage.rs crates/videorc-backend/src/remote_lan.rs crates/videorc-backend/src/remote_lan_server.rs crates/videorc-backend/remote_web`
> If an anchor quoted below has moved, re-find it by the symbol name. If a
> _behaviour_ changed (not just a line number), that is a STOP condition.

## Status

- **Priority**: P2. Brand polish requested by the owner after X's API team
  sent Videorc their partner icon kit (2026-10-08).
- **Effort**: M, 7 slices (S6 is a separate videorcweb PR)
- **Risk**: LOW–MEDIUM.
  - S2 adds a persisted chat field and a SQLite column.
  - S4 changes pixels burned into the outgoing stream (highlight card).
- **Depends on**: none. Plan 165 (#642) is on main; this plan reuses its
  "official file, never redrawn" pattern.
- **Category**: brand / UI
- **Planned at**: commit `2efe2baf` (origin/main), 2026-10-08
- **Route**: UI/Product Design, fit 9, model lane `opus-4.8` for S1, S3, S4,
  S5. Load the `videorc-design` skill. S2 is plumbing: Implementation, fit 8,
  `gpt-5.5`. The Orchestrator owns S6 and S7.

## Owner decisions (answer before S1)

Each has a recommendation. The slices below assume the recommendation.

| #   | Question                                                         | Recommendation                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Which kit mark where in the app?                                 | The bare mark (kit `x-logo-currentColor.svg`) wherever a bare platform icon shows: chat and activity rows, filters, status bar, Orcle. Pure black in light mode, pure white in dark (kit rule), not the `foreground` token. The rounded-square lockup (`x-logo-lockup-*`) replaces the 10 % wash tile in `PlatformGlyph`. |
| D2  | The stream highlight card's X badge                              | Drop the hand-drawn "×" over the avatar. Show the kit mark, white, 20 px, closing the identity row on the right, exactly where YouTube's icon sits (plan 165 owner call). The identity line drops "X ·" when the mark is shown.                                                                                           |
| D3  | Where do verified checks show?                                   | Chat rows (compact rail and Stream Manager), the highlight card, and the phone remote. Premium blue, Business gold, Government gray, using X's own files. Not in Activity: X follow events carry no `verified_type` today.                                                                                                |
| D4  | Website too?                                                     | Yes, a separate small videorcweb PR (S6): swap `X_PATH` in `official-brand-icon.tsx` for the kit path. The current path is a different drawing of the X.                                                                                                                                                                  |
| D5  | The rest of the kit (engagement, live, Spaces, Grok/xAI, follow) | Not used. Nothing in the app needs X's like/repost/Spaces glyphs today.                                                                                                                                                                                                                                                   |

## The kit

Source: `~/Downloads/X-Partner-Icon-Kit/` (the same content as
`~/Downloads/X-Partner-Icon-Kit_(1).zip`, checked with `diff -rq` on
2026-10-08). 88 SVG files from X's XDS design system (`@x-clients/xds` in
x-web). Open `preview.html` to browse.

Files this plan ships, byte-for-byte, with their sha256 on 2026-10-08:

| Kit file                                          | sha256                                                             | Used for                          |
| ------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------- |
| `01-x-logo/x-logo-currentColor.svg`               | `ee66927ea6100266255efe3fee6c413f6ce574ff59a6a46ca3aef413064232e3` | The path source for the bare mark |
| `01-x-logo/x-logo-lockup-white-on-black.svg`      | `97754a489565d5daafa5b05629cb00c206d38c8a630cb2f98c9fb5e78608310d` | `PlatformGlyph` tile, dark mode   |
| `01-x-logo/x-logo-lockup-black-on-white.svg`      | `ae97fa564e551993bc5e34de54626e586f5dd2a41d0267c277253cbcce36e50d` | `PlatformGlyph` tile, light mode  |
| `01-x-logo/x-logo-white.svg`                      | (record at copy time)                                              | Highlight card, phone remote      |
| `03-verified-badges/verified-premium-blue.svg`    | `608ac8ab2dd3a63704aa168fca2e319bf6dd60f17fe55802f3715b1456f2fa60` | `verified_type: blue`             |
| `03-verified-badges/verified-business-gold.svg`   | `725ce3ce0bbd0f5919c69a21511d8032f79b82ba84703e9098b328442976fe1c` | `verified_type: business`         |
| `03-verified-badges/verified-government-gray.svg` | `616479fc4d4bae24718ec51de47a7776677a67767450374b3e8bb435413868da` | `verified_type: government`       |

The mark's path (all `01-x-logo` files share it, 24 × 24 viewBox):
`m21.62 21.5-7.47-10.9 6.97-8.1H18.7l-5.62 6.54L8.6 2.5H2.48L9.68 13l-7.3 8.5H4.8l5.96-6.93 4.76 6.93zM7.8 4.03l10.93 15.94H16.3L5.38 4.03z`

## Rules this plan is held to (kit README)

- The X mark is **one solid colour**: black on light, white on dark. No
  stretch, rotation, gradient or shadow. Give it room.
- **Minimum 16 px**, aspect preserved. Our platform marks are 20 px (plan
  165), so this is already met.
- Verified badges use X's production colours: Premium `#1D9BF0`, Business the
  gold gradient, Government `#829AAB`. **Do not invent a badge colour** and
  never tint them.
- Never show a check X did not send. An unknown or missing `verified_type`
  shows nothing.

## Current state (code read at `2efe2baf`)

Paths are under `apps/desktop/src/renderer/src/` unless stated.

**The X mark today is three different drawings, none of them X's:**

- `components/icons.tsx:280-285` re-exports Phosphor's `XLogo as
XPlatformIcon`. It feeds `ChatPlatformIcon` (`chat-platform-icon.tsx:33`,
  tint `text-foreground` at `:42`) and `PlatformGlyph`
  (`platform-glyph.tsx:19`, tile `bg-foreground/10 text-foreground` at `:33`).
  `ChatPlatformIcon` reaches about 18 files: Stream Manager chat, activity,
  stats bar, status bar and command/removal cards, `comment-row.tsx`, the
  Orcle pane/question rows/report card/voice commands, scheduled streams,
  destination cards and the streaming tab.
- **Highlight card** (burned into the stream): `lib/caption-overlay.ts:842-848`
  strokes two lines, a plain "×", on a `#111111` circle over the avatar
  (`lib/comment-highlight.ts:170`, `{ label: 'X', color: '#111111', glyph:
'x' }`). YouTube already has the better pattern: an official file loaded as
  an image (`loadYoutubeMarkImage`, `caption-overlay.ts:528-547`), drawn
  20 px on the identity row, with the word as fallback.
- **Phone remote** (`crates/videorc-backend/remote_web/app.js:157-180`): a
  letter "X" on a black tile (`app.css:284`). YouTube gets its file served at
  `/youtube-icon.svg` by `remote_lan_server.rs:44` (`include_bytes!`) and
  `:403`.
- **Website**: `videorcweb components/marketing/official-brand-icon.tsx:46`
  `X_PATH` is the older simple-icons drawing.

**Verified type already arrives, and the desktop drops it:**

- X's `broadcast.chat` payload carries `author.verified_type` (found in plan
  086). The web relay keeps it: `videorcweb lib/x-chat/webhook.ts:155`
  (`verifiedType: boundedString(author.verified_type, 32)`), and the poll
  route returns it (`tests/x-chat-webhook.test.ts:120` has `"blue"`,
  `tests/x-chat-relay.test.ts:233` shows it in the GET body). **No web change
  is needed for the data.**
- Desktop `crates/videorc-backend/src/x_chat.rs:149-162` `RelayAuthor` has
  `id`, `username`, `name`, `avatar_url` and `affiliation`, but no
  `verified_type`. serde ignores the field.
- `LiveChatMessage` (`live_chat.rs:340-370`) has `author_affiliation` (plan
  086), which is the pattern to copy: an optional field with
  `skip_serializing_if`, a column added in `storage.rs:7092-7097`, and kept on
  upsert at `live_chat.rs:1328`.
- TS mirror: `shared/backend.ts:4817-4839` (`LiveChatAuthorAffiliation`,
  `authorAffiliation?`).
- `comment-row.tsx:630-637` renders name → `AffiliationBadge` (16 px) → role
  tags. X's own order is name → check → affiliation logo.
- The phone gets chat through a **whitelist** (`remote_lan.rs:578-589`,
  `CHAT_MESSAGE_FIELDS`). A new field reaches the phone only if it is named
  there.

**Budgets and traps:**

- `pnpm check:renderer-assets` guards the eager renderer JS. Prefer asset
  URLs (`import url from '…svg'`) over inline markup, except the 24 × 24 path
  that must follow the theme.
- Serde null trap: an `Option` without `skip_serializing_if` has broken app
  load three times. Every new optional field gets
  `#[serde(default, skip_serializing_if = "Option::is_none")]`.
- The business-gold SVG has gradient `id`s. Rendering it via `<img>` (or an
  `<image>` inside an svg) keeps those ids out of the page DOM, so two gold
  checks on one screen cannot collide.

## Design

- **Assets** go in `assets/brand/x/` with a `README.md` like
  `assets/brand/youtube/README.md`: where the files came from (X's API team,
  partner kit, 2026-10-08), the sha256 of each, the rules above, and "do not
  hand-edit". `icons.test.ts` checks the hashes.
- **Bare mark** (`XPlatformIcon`): a 24 × 24 svg with the kit path verbatim,
  `fill-black dark:fill-white` (the app's `dark` variant is
  `styles.css:4`). It ignores `weight` and any tint class from a caller, the
  same way `YoutubeIcon` does. 20 px wherever `ChatPlatformIcon` puts it
  today; no size change.
- **Tile** (`PlatformGlyph`, `x`): the kit lockup as an `<img>`,
  white-on-black in dark, black-on-white in light, 24 px, replacing the wash
  tile. The lockup is X's own app-icon form, so no extra background.
- **Verified check**: `<img>` of X's file, 16 px (`size-4`), after the name,
  before the affiliation logo. `alt`/`title`:
  - blue: "Verified on X"
  - business: "Verified organization on X"
  - government: "Government account on X"
- **Data**: `authorVerified?: 'blue' | 'business' | 'government'` on the chat
  message. X is the only source today. A future platform can map into the
  same three values or add its own.

## Slices

### S1: The official X mark and tile

Files:

- `assets/brand/x/` (new): `x-logo-lockup-white-on-black.svg`,
  `x-logo-lockup-black-on-white.svg`, `x-logo-white.svg`, `README.md`
- `components/icons.tsx` (`:280-285`)
- `components/platform-glyph.tsx` (`:17-34` and the non-YouTube branch)
- `components/chat-platform-icon.tsx` (`:42`, drop the `x` tint)
- `components/icons.test.ts`, `components/platform-glyph` tests if present,
  `youtube-mark-surfaces.test.ts` (it enumerates platform-mark surfaces)
- `docs/icon-set.md` (platform marks section)

1. Copy the kit files above **byte-for-byte**. Record every sha256 in the
   README.
2. Replace `XLogo as XPlatformIcon` with a local `XPlatformIcon: AppIcon`:
   `<svg viewBox="0 0 24 24" data-slot="platform-mark" data-platform="x">`
   with one `<path d="…kit path…" className="fill-black dark:fill-white" />`.
   Accept and ignore `weight`; keep `size`, `aria-*`, `role`, `title`
   children. Drop `'XLogo'` from the Phosphor name union (`icons.tsx:140`).
3. `chat-platform-icon.tsx`: `x` no longer takes `text-foreground`. Keep the
   other tints.
4. `platform-glyph.tsx`: the `x` case renders the lockup `<img>` pair
   (`dark:hidden` / `hidden dark:block`) in the same 30 × 24 slot, 24 px
   square, `alt="X"`, decorative where the row already names X.
5. Tests:
   - `XPlatformIcon` renders exactly one `<path>` whose `d` equals the path in
     the shipped `x-logo-white.svg` (read the file in the test).
   - Its fill classes are `fill-black dark:fill-white`; no `currentColor`.
   - Every Phosphor weight gives identical markup.
   - The README hashes match the shipped files.
   - `PlatformGlyph platform="x"` renders both lockup images and no wash
     tile class.

Done when:

- `pnpm --filter @videorc/desktop test icons platform-glyph chat-platform youtube-mark-surfaces`
- `pnpm typecheck`
- `pnpm check:renderer-assets` stays under its ceilings (record the numbers
  before and after)

### S2: Carry `verified_type` from the relay to the renderer and the phone

Files:

- `crates/videorc-backend/src/x_chat.rs` (`RelayAuthor`, `:149-162`, and the
  message builder near `:818`/`:867`)
- `crates/videorc-backend/src/live_chat.rs` (`LiveChatMessage`, `:340-370`;
  upsert keep-existing, `:1328`)
- `crates/videorc-backend/src/storage.rs` (add-column list `:7092-7097`, the
  insert/upsert/select around `:3485-3545`, `:3649-3668`, `:3921`)
- every `author_affiliation: None` constructor (about 12 files; the compiler
  lists them)
- `crates/videorc-backend/src/remote_lan.rs` (`CHAT_MESSAGE_FIELDS`, `:578`)
- `apps/desktop/src/shared/backend.ts` (`:4817-4839`)
- the fake X provider rows used by `smoke:live-chat-fake-providers` and dev
  fake activity: add `verifiedType` to **existing** X chat rows only. Do not
  add rows: the fake activity counts are hard-coded in several places.

1. `RelayAuthor` gains `#[serde(default)] verified_type: Option<String>`.
2. New `LiveChatAuthorVerified` enum, `#[serde(rename_all = "camelCase")]`:
   `Blue`, `Business`, `Government`. A parser maps `"blue"`, `"business"`,
   `"government"` (case-insensitive) and returns `None` for `"none"`,
   missing, empty or anything else.
3. `LiveChatMessage.author_verified: Option<LiveChatAuthorVerified>` with
   `#[serde(default, skip_serializing_if = "Option::is_none")]`.
4. Storage: column `author_verified TEXT` via the same add-column path as
   `author_affiliation_json`. Write `blue`/`business`/`government` or NULL.
   An upsert that has no value keeps the stored one, like affiliation.
5. TS: `authorVerified?: 'blue' | 'business' | 'government'` on
   `LiveChatMessage`, with a doc comment naming plan 167.
6. LAN whitelist: add `"authorVerified"`. It is a word, not an id or a URL,
   so it fits the whitelist's rule.
7. Tests:
   - x_chat: a relay page with `verifiedType` `"blue"`, `"business"`,
     `"government"`, `"none"`, `null`, missing and `"weird"` gives the right
     `author_verified`, and never fails the page.
   - live_chat: serialising a message with `None` emits no `authorVerified`
     key (serde null trap guard).
   - storage: round-trip each value plus NULL; upsert without a value keeps
     it.
   - remote_lan: `project_chat_message` passes `authorVerified` through.

Done when (owner rule: targeted cargo tests, not the whole suite):

- `cargo fmt --check --all`
- `cargo test -p videorc-backend x_chat live_chat storage remote_lan`
  (`-j 2` if other sessions are building)
- `cargo clippy -p videorc-backend -- -D warnings`
- `pnpm typecheck`

STOP if: the relay's poll response no longer contains `author.verifiedType`
(check `videorcweb tests/x-chat-relay.test.ts`). Then a web slice is needed
first.

### S3: Verified check on chat rows

Files:

- `assets/brand/x/` (add the three verified-badge files to the README table)
- `components/comment-row.tsx` (`:266-285` next to `AffiliationBadge`,
  `:630-637`)
- `components/comment-row` tests (or `comments-header.test.ts` /
  `chat-pane` tests, wherever row markup is asserted today)

1. Copy the three badge files byte-for-byte; record their sha256.
2. `VerifiedCheck({ verified })`: an `<img>` of the matching file,
   `size-4 shrink-0`, `data-slot="comment-verified"`, `alt` and `title` from
   the Design section, `draggable={false}`. Nothing for `undefined`.
3. Order in the name line: name → `VerifiedCheck` → `AffiliationBadge` →
   role tags. Same in the compact rail and the Stream Manager density.
4. Tests: each value renders its file and label; `undefined` renders nothing;
   the order is name, check, affiliation.

Done when:

- `pnpm --filter @videorc/desktop test comment-row comments-header`
- `pnpm probe:comments-window` (the 320–420 px fit checks must still pass
  with a check plus an affiliation logo on a long name)

### S4: Highlight card (on-stream pixels)

Files:

- `lib/comment-highlight.ts` (`:150-175`, `commentHighlightIdentity` `:180`)
- `lib/caption-overlay.ts` (`:528-547` loader, `:690-705` render params,
  `:820-848` badge, the YouTube identity-row block after it)
- `lib/caption-overlay-card.test.ts`

1. Turn `loadYoutubeMarkImage` into a per-file cached loader
   (`loadBrandImage(url)`), keeping its tests' injection point
   (`loadYoutubeMark` stays as an alias or is renamed in the test).
2. `x` gets `{ label: 'X', glyph: 'x-mark' }`: no avatar badge. The X mark
   (`x-logo-white.svg`) is drawn on the identity row's right edge at 20 px,
   the same slot and clear-space rules as YouTube's icon. If the image fails
   to load, the identity line keeps "X · name" and no mark is drawn.
3. `commentHighlightIdentity`: drop the "X ·" prefix when the mark is shown
   (generalise the YouTube `markShown` rule to both).
4. Verified check after the author name, square, sized to the name's cap
   height but at least 16 px, from the same badge files, loaded the same way.
   No check if it fails to load. Never a drawn substitute.
5. Both legs: horizontal and vertical renders get the same treatment
   (`render(stream)` and `render(vertical)`).
6. Tests: X renders a `drawImage` of the X mark and no stroked "×";
   identity text is the bare name when the mark loads and "X · name" when it
   does not; each verified value draws its file; `undefined` draws none; the
   vertical canvas matches.

Done when:

- `pnpm --filter @videorc/desktop test caption-overlay comment-highlight`
- `pnpm smoke:comment-highlight-stream` (on-stream path; if local macOS
  permissions block it, say so and run the card unit tests plus a manual PNG
  dump of an X card at 1080p and 1080×1920)

### S5: Phone remote

Files:

- `crates/videorc-backend/src/remote_lan_server.rs` (`:44`, `:403`)
- `crates/videorc-backend/remote_web/app.js` (`:157-198`),
  `remote_web/app.css` (`:284`)

1. Serve `x-logo-white.svg` at `/x-logo.svg` and the three badge files at
   `/x-verified-{blue,business,government}.svg`, with `include_bytes!` from
   `assets/brand/x/` like the YouTube file.
2. `platformGlyph('x')`: the black tile keeps its background and holds the
   white mark (`<img src="/x-logo.svg">`, 14–16 px inside the 24 px tile, at
   least 16 px if the tile grows). No letter.
3. `buildRow`: after the author span, an `<img>` of the verified file when
   `message.authorVerified` is one of the three values. Any other value shows
   nothing.
4. Extend the existing server test that fetches `/youtube-icon.svg` (`:811`)
   to fetch the new paths.

Done when:

- `cargo test -p videorc-backend remote_lan`
- `pnpm smoke:remote-lan`

### S6: Website (videorcweb, separate PR)

Repo: `~/projects/videorcweb`, its own worktree off `origin/main`.

1. `components/marketing/official-brand-icon.tsx:46`: `X_PATH` becomes the
   kit path. The viewBox stays `0 0 24 24`, and `fill-[#000000]
dark:fill-[#FFFFFF]` stays.
2. A comment names the source: X partner icon kit, 2026-10-08.
3. Run the repo's own checks. Known trap: `pnpm typecheck` is red on clean
   main (`tests/download.test.ts`); compare with main before blaming the
   change.

Done when: the PR is open, and the multistream row and footer show the new
mark by eye in light and dark.

### S7: Evidence and PR

1. Owner by-eye, light and dark: Stream Manager chat (an X message with each
   verified type, plus one with an affiliation logo), filters, status bar,
   Livestream → Setup destination tile, the highlight card on both legs, the
   phone remote.
2. Screenshots go to `~/Downloads/videorc-x-kit-screenshots/`, **not** the
   repo or the PR.
3. One desktop PR, `plan-167-x-partner-kit`. Full gates at the end (owner
   rule: write and commit all slices first): `pnpm typecheck`, `pnpm lint`,
   `pnpm format:check`, `pnpm --filter @videorc/desktop test`, `pnpm build`,
   `pnpm check:renderer-assets`, the targeted cargo tests and clippy, plus
   the smokes named in S3–S5.

## Out of scope

- X follow events in Activity with a verified check: the relay's
  `XFollowRelayFollower` has no `verified_type`. A later plan would add it to
  the web relay first.
- The kit's engagement, live, Spaces, follow and Grok/xAI icons.
- Verified badges from other platforms (Twitch partner, YouTube verified).
- Any change to the Twitch, Kick, TikTok or Instagram marks.

## STOP conditions

- The kit files differ from the sha256 table above (a newer kit arrived):
  ask the owner which to ship.
- The relay's poll response lacks `author.verifiedType` (S2).
- `pnpm check:renderer-assets` goes over a ceiling and the overrun is not
  removable by turning inline markup into asset URLs.
- A surface cannot fit the 16 px check without hiding the name (narrow
  compact rail): stop and ask; do not shrink the check below 16 px.

## Verification summary

| Slice | Gate                                                                  |
| ----- | --------------------------------------------------------------------- |
| S1    | desktop unit tests for icons/glyphs, typecheck, renderer asset budget |
| S2    | cargo fmt, targeted cargo tests, clippy, typecheck                    |
| S3    | comment-row tests, `probe:comments-window`                            |
| S4    | caption-overlay tests, `smoke:comment-highlight-stream`               |
| S5    | `remote_lan` cargo tests, `smoke:remote-lan`                          |
| S6    | videorcweb checks, by eye                                             |
| S7    | full desktop gates, owner by-eye in both themes                       |

## As built

(Fill in after execution.)
