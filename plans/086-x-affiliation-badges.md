# Plan 086: Show X organization (affiliation) badges on chat comments

Status: **IMPLEMENTED** 2026-10-01 against `origin/main` `9f1a46a3`, on branch
`plan/086-x-affiliation-badges` (worktree `../videorc-wt-085`), with web PR
`feat/x-chat-author-badges` on videorc-web. Owner live acceptance (S5) is
owed. Priority P2, size S.

## What the owner saw (2026-10-01, live on X)

Dominik Koch commented on the owner's X livestream: "Does it display my neon
twitter badge?" … "aww it doesnt". On X his name carries Neon's affiliation
badge (the company logo X shows next to an employee of a Verified
Organization). In the Stream Manager his rows showed the X glyph, his name and
his avatar, but no badge.

## Diagnosis

X already sends the badge. The XAA `broadcast.chat` payload carries the full
author user object (docs.x.com/x-api/activity/event-payloads; verbatim copy in
videorc-web `tests/fixtures/x-broadcast-chat-event.json`):

```json
"author": { "data": {
  "affiliation": {
    "url": "https://x.com/X",
    "badge_url": "https://pbs.twimg.com/profile_images/…_normal.jpg",
    "description": "X"
  },
  "verified_type": "blue", "verified": true, …
} }
```

The badge was dropped at three points:

1. **Web relay** (`videorc-web lib/x-chat/webhook.ts`). `parseBroadcastChatEvent`
   kept `verifiedType` but never read `affiliation`.
2. **Desktop backend** (`crates/videorc-backend/src/x_chat.rs`). `RelayAuthor`
   parsed only id, username, name and avatar, and `relay_event_to_message`
   hard-coded `author_badges: Vec::new()`.
3. **Renderer** (`comment-row.tsx`). Nothing ever rendered an author badge
   image.

No new X scope, API call or quota is needed.

## Decisions

- **A structured field, not a string in `authorBadges`.** `authorBadges` holds
  platform badge ids (Twitch `subscriber/12`). An affiliation is an image plus
  an organization name, so it is `authorAffiliation?: { badgeUrl, description?,
  url? }` on `LiveChatMessage`.
- **Serde-null safe.** Every new `Option` has `skip_serializing_if`, so plain
  rows serialize exactly as before (the shared fixture round-trip test proves it).
- **https only, and fail soft.** The web relay and the desktop both drop a badge
  that has no `https://` image. The desktop reads `affiliation` as raw JSON, so
  a malformed badge drops only the badge, never the comment or the relay page.
- **Images go through main's avatar cache.** The badge host `pbs.twimg.com` is
  already allowlisted in `main/avatar-cache.ts`. The renderer never hot-links a
  CDN, and it renders nothing until the cache resolves, so there is no empty box.
- **Visual.** A 16 px logo with 4 px rounded corners directly after the
  author's name, as X shows it. `alt`/`title` = the organization name
  ("Affiliated organization" when X sent none). It is not a link: the row
  itself may be a button. The logo is content colour, like an avatar, so it
  does not break the monochrome-chrome rule.
- **Out of scope:** the verified checkmark (`verified_type`), the badge on the
  on-stream comment highlight card, and the Phone remote LAN projection. Each
  is a small follow-up if the owner wants it.

## Slices

### S1. Web relay passes `affiliation` through (videorc-web)

`XChatRelayMessage.author.affiliation: { badgeUrl, description, url } | null`,
with `badgeUrl` required to be https. The rows are `jsonb`, so no migration is
needed, and older desktops ignore the unknown field.

Done when: `pnpm test` passes, including the documented-event test and the new
https-only affiliation test.

### S2. Desktop contract and parser

`LiveChatAuthorAffiliation` and `LiveChatMessage.author_affiliation` in
`live_chat.rs`, mirrored in `shared/backend.ts`. `relay_affiliation` in
`x_chat.rs`. A deletion keeps the original row's affiliation (as it does for
badges). A new X row in `protocol-fixtures/high-risk-contracts.json` is
round-tripped by both languages.

Done when: `cargo test -p videorc-backend -- x_chat shared_high_risk_contract`
and the protocol-contract vitest pass.

### S3. Persistence

`live_chat_messages.author_affiliation_json` (via `ensure_column`), which is
written, upserted and read back. An unreadable stored value degrades to no
badge.

Done when: `storage::tests::live_chat_details_reply_and_first_message_round_trip`
proves the round trip.

### S4. Comment row shows the badge

`AffiliationBadge` in `comment-row.tsx`, used by the Stream Manager chat pane.

Done when: `comment-row-affiliation.test.ts` (happy-dom) proves the logo
renders after the name through the cache, uses the generic label when X sent no
name, and renders nothing without a badge or before the image resolves.

### S5. Owner acceptance (owed)

Deploy web first, then use a build that contains this branch. Go live on X and
have an affiliated account (Dom/Neon) comment. Expect the Neon logo after his
name, with "Neon" on hover. Restart the app mid-session: the badge must survive
the history reload.

## Verification

- Web: `pnpm test`, eslint on the changed files. `pnpm typecheck` fails on
  `origin/main` in an unrelated file (`tests/download.test.ts`).
- Desktop: `cargo fmt --check --all`, clippy, the targeted cargo tests above,
  the focused vitest files, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  and `pnpm build` plus `check:renderer-assets` (the change is in the lazy
  comments chunk).
