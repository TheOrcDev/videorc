# Plan 165: Answer Google's YouTube API ToS report (official YouTube icon at 20px or more)

> **Executor instructions**: Follow this plan slice by slice. Run every "Done
> when" check before moving on. If anything in "STOP conditions" happens, stop
> and report; do not improvise. When done, update this plan's row in
> `plans/README.md` and fill in "As built".
>
> **Drift check (run first)**:
> `git diff --stat 3fcc17e4..origin/main -- apps/desktop/src/renderer/src/components/icons.tsx apps/desktop/src/renderer/src/components/platform-glyph.tsx apps/desktop/src/renderer/src/components/chat-platform-icon.tsx apps/desktop/src/renderer/src/components/stream-manager apps/desktop/src/renderer/src/components/comment-row.tsx apps/desktop/src/renderer/src/components/streaming/destination-card.tsx apps/desktop/src/renderer/src/lib/caption-overlay.ts apps/desktop/src/renderer/src/lib/comment-highlight.ts crates/videorc-backend/remote_web`
> If an anchor quoted below has moved, re-find it by the symbol name. If a
> _behaviour_ changed (not just a line number), that is a STOP condition.

## Status

- **Priority**: P0. Google's "YouTube API Services ToS Violations Report V.1"
  is dated 2026-10-08 (project 244529927041, API client "Uros Miric") and
  says it "required immediate resolution".
- **Effort**: M, 6 slices (S0 is owner-only)
- **Risk**: LOW–MEDIUM. Most of the work is UI. S4 changes pixels burned into
  the outgoing stream (highlight card).
- **Depends on**: none
- **Category**: compliance
- **Planned at**: commit `3fcc17e4` (origin/main), 2026-10-08
- **Route**: UI/Product Design, fit 9, model lane `opus-4.8` (S1–S4). Load the
  `videorc-design` skill. The Orchestrator owns S0 and S5.
- **Scope rule (owner, 2026-10-08)**: fix only what the report names.
  - D and E are "[Confirm]" questions. They get written answers, not code.
  - F is the only violation: the YouTube icon.
  - No data deletion, retention, consent or other-platform logo work is in
    this plan.

## What the report asks

| Clause     | Type          | Google's words                                                                                                                                                              | Our response                                      |
| ---------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| III.D.1c   | Confirm       | "Please confirm if you use multiple project numbers for the given API Client. If so, please provide all the related project numbers."                                       | Written answer (S0, S5)                           |
| III.E.4a-g | Confirm       | "How often do you refresh /update or delete the API Data"                                                                                                                   | Written answer from the code (S5), no code change |
| III.F.2a   | **Violation** | "YouTube logos and icons below do not follow our Branding guidelines … The YouTube icon and logo must follow the shape, color and height should never be smaller than 20dp" | S1–S4                                             |

The report's screenshots flag these surfaces:

1. **Stream Manager chat, platform filter toggle** (top of chat, next to
   "All").
2. **Stream Manager chat rows**: the YouTube badge before the author name
   (for example "@AIDragonMusic", "@orcdev"). This is the reported
   "red dot".
3. **Stream Manager activity pane, platform filter toggle** (top right, next
   to "All").
4. **Stream Manager status bar, bottom-left chat-state chips.**
5. **Livestream tab, Destinations**: the icon on the **YouTube** and
   **YouTube Vertical** rows.
6. **Website hero** (videorc.com, "What are we supporting?" row, a 20 × 14.09
   `path`). That is the website, handled separately and **not in this plan**.

## Branding rules this plan is held to

- **Report:** use the official shape and colour, and never render the icon
  below 20dp tall.
- **Branding Guidelines**
  (https://developers.google.com/youtube/terms/branding-guidelines):
  - Use the **YouTube Icon** when content from several sources is mixed and
    each item needs attribution, which is our combined chat.
  - "You cannot modify the colors of the YouTube logos or YouTube Icons and
    should present those images on a single, solid background color."
  - "It must not be altered or partially covered."
  - "Do not display the logo as the most prominent element."
- **brand.youtube/youtube-icon** (where the report's brand-resources link
  redirects):
  - Variants are full colour, Almost Black and White. "The triangle in the
    full-color red icon must always be white." YouTube Red is `#FF0033`.
  - Clear space equals the triangle; keep other elements out of it.
  - Don'ts: no stroke or outline, no custom colourways, no drop shadow, no
    rotating, squashing or stretching.
- **Height:** this plan sets the floor for the **visible mark**, not the svg
  box: at least 20px, which is 20dp at 1x. The live brand site says "Digital:
  100px" for logos. The report says 20dp, and we follow the report.

## Current state (code read at `3fcc17e4`)

Paths are under `apps/desktop/src/renderer/src/` unless stated.

**Source of the mark:** `components/icons.tsx:277` re-exports Phosphor's
`YoutubeLogo as YoutubeIcon`. It is not the official art:

- It is one `currentColor` path with the play triangle cut out as a
  **transparent hole**, so the triangle is not white.
- Its proportions differ from the official icon.
- The visible mark is 176/256 of the svg box: **9.6px tall at `size-3.5`, and
  8.3px at `size-3`.**

**Wrappers:**

- **`PlatformGlyph`** (`components/platform-glyph.tsx`): a 20px tile tinted
  `bg-platform-youtube/15 text-platform-youtube` with the glyph at
  `size-3.5`.
  - Flagged surface 5: `streaming/destination-card.tsx:311`.
  - Same component, not flagged but the same defect:
    `tabs/streaming-tab.tsx:553` (per-destination accordion),
    `scheduled-streams.tsx:379, 516` (Upcoming), and
    `schedule-stream-dialog.tsx:291` (dialog title).
- **`ChatPlatformIcon`** (`components/chat-platform-icon.tsx`): a bare glyph
  at `size-3.5`, tinted by `CHAT_PLATFORM_TINT` (`text-platform-youtube`).

**Where `ChatPlatformIcon` appears:**

| Flagged | Location                                                                                                                                                                                                                                                                                                                                                          | Size              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 1       | chat filter toggle, `stream-manager/chat-pane.tsx:399`                                                                                                                                                                                                                                                                                                            | 14px              |
| 2       | chat rows, `comment-row.tsx:628`                                                                                                                                                                                                                                                                                                                                  | 14px              |
| 3       | activity filter toggle, `stream-manager/activity-pane.tsx:412`                                                                                                                                                                                                                                                                                                    | 14px              |
| 4       | status bar, `stream-manager/stream-manager-status-bar.tsx:164`, plus provider `Badge` chips in `comments-destination-status.tsx:180, 202`, where `ui/badge.tsx:15` forces `[&>svg]:size-3!`                                                                                                                                                                       | 12px in the chips |
| —       | activity row avatar overlay, `stream-manager/activity-pane.tsx:268-272`, `absolute -right-1 -bottom-1 size-3`                                                                                                                                                                                                                                                     | **12px**          |
| —       | "Show chat from" / "Send to" dropdown items, `chat-pane.tsx:471, 818`. `ui/dropdown-menu.tsx:72/94/132` recolours a `currentColor` icon to `accent-foreground` on hover.                                                                                                                                                                                          | 14px              |
| —       | stats hover card (`stats-bar.tsx:112`), removal cards (`removal-cards.tsx:211, 247`), command cards (`command-cards.tsx:194, 256`), reconnect list (`remove-messages-reconnect.tsx:42`), Orcle pane (`cohost-pane.tsx:871`, `cohost-question-row.tsx:91`), Orcle report (`orcle-report-card.tsx:226, 326`), Orcle voice commands (`orcle-voice-commands.tsx:232`) | 14px              |

The unflagged rows use the same component and fail the same rule, so Google
would flag them next time.

**YouTube look-alikes outside React** (not in the screenshots; same violation
class):

- **The highlight card burned into the stream**
  (`lib/caption-overlay.ts:785-846`, data in
  `lib/comment-highlight.ts:144-171`) draws a red `#FF0033` circle with a
  white play triangle. Its size is `max(12, round(avatarPx*0.42))`, about
  17px at 720p.
- **The LAN phone remote** (`crates/videorc-backend/remote_web/app.js:149`,
  `app.css:234-265`) shows a white letter "Y" on `#e62117`.

**Build facts:**

- No third-party brand file exists in the repo.
- The renderer has no SVG loader. Images are default URL imports, and Vite
  inlines them under 4 KB.
- The pattern to copy is `OrcleIcon` (`icons.tsx:307-331`): an `<svg>` wrapper
  around `<image href>`, `weight` ignored, never tinted. Because the art lives
  in an `<image>`, `currentColor`, tint classes and the dropdown hover
  recolour cannot reach it.
- Eager budget: `pnpm check:renderer-assets`. Headroom was about 185 KB raw /
  35 KB gzip after PR #562.

## Design

1. **One official YouTube mark:** `youtube-icon-red.svg`, converted
   losslessly from the official brand-site file and never hand-edited.
   - It renders through the OrcleIcon pattern, cropped by `viewBox` to the
     mark's own bounds. Cropping is framing only; the art is unchanged.
   - The visible mark is **20px tall or more** (about 29 × 20px) on every
     surface. Sizes below 20 clamp up.
2. **Every YouTube surface either shows that mark at 20px or more, or shows
   the word "YouTube" with no mark.** Never a small mark, never a tint tile
   behind it, never an overlay on an avatar.
3. **Clear space:** at least 8px (`gap-2`) between the mark and its
   neighbours. That is at least the triangle's width at 20px (about 7.4px).
4. **Other platforms are untouched** (Twitch, Kick, X, TikTok, Instagram).
   Only the YouTube branch of each wrapper changes. Where a row's icon slot
   widens for YouTube, the slot widens for all rows so titles stay aligned.

## Slices

### S0: Project-number confirmation (owner, no code)

In Google Cloud Console for project **244529927041**, confirm:

1. Every OAuth client and API key in the project belongs to the Videorc
   desktop app.
2. No other Cloud project holds YouTube Data API credentials for Videorc:
   dev, test or an older project.
3. Which project the website's "Sign in with Google" uses
   (`videorcweb/lib/auth.ts:36-41`). It does not call YouTube APIs. Note the
   answer for the reply anyway.

What the code shows:

- **One client per build.** `oauth.rs:24-31` reads the client ID and secret
  from `VIDEORC_BUNDLED_YOUTUBE_CLIENT_ID/SECRET`, injected from GitHub
  secrets by the macOS, Windows and Linux release workflows. Dev overrides go
  through `VIDEORC_YOUTUBE_CLIENT_ID`.
- **No client ID in source at HEAD.**
- **Two historical client IDs in git history, both in project 244529927041:**
  - `…-cibnpf57…`, commit 847ff2b2
  - `…-oe9n13ur…`, commit e7576750, removed in 2e622b44
- **The project number appears only in docs:**
  - `docs/acceptance/2026-10-02-youtube-efficiency.md:18`
  - `plans/096-youtube-quota-efficiency.md:176`

Done when: the answers are written into S5's reply notes.

### S1: The official YouTube mark

Files:

- `apps/desktop/src/renderer/src/assets/brand/youtube/` (new)
- `components/icons.tsx`
- `components/icons.test.ts`
- `docs/icon-set.md` (`:24`, `:150-155`)

1. **Get the art.**
   - Download the official icon zip linked from
     https://brand.youtube/youtube-icon:
     https://www.gstatic.com/marketing-cms/78/29/3e68a1414bb28d0b7e47b44c3c91/youtube-icon.zip.
     On 2026-10-08 the zip sha256 was
     `ca9b5104387e0f7afcfda3a79c910449561112f1077177dd0d64f8c72f56e476`.
   - The zip has no SVG. Convert `Digital/01 Red/yt_icon_red_digital.ai`
     losslessly with `pdftocairo -svg` (poppler, `brew install poppler`).
   - The result was checked on 2026-10-08:
     - two paths: red `rgb(100%,0%,19.999695%)` = `#FF0033`, and a white
       triangle
     - artboard `602.187 × 515.868`
     - mark bounds about `x 102.69–498.69, y 119.17–396.57` (396 × 277.4,
       aspect ≈ 1.428)
   - Save the output byte-for-byte as `youtube-icon-red.svg`. **Do not
     hand-edit it.**
2. **`README.md`** in that folder records:
   - the source page and zip URL
   - the download date
   - the zip sha256 and the svg sha256
   - the exact conversion command
   - the rules: official colour only, a visible mark of 20px or more, clear
     space equal to the triangle, a solid background
3. **`icons.tsx`**: replace `YoutubeLogo as YoutubeIcon` with a `YoutubeIcon`
   that follows `OrcleIcon`:

   ```tsx
   <svg viewBox="102.69 119.17 396 277.4" data-slot="platform-mark" data-platform="youtube">
     <image href={youtubeIconUrl} width="602.187" height="515.868" />
   </svg>
   ```

   - Take the exact bounds from the converted file's path extremes, not from
     this plan's rounded numbers.
   - `height` comes from the `size` prop and is clamped to
     `YOUTUBE_MARK_MIN_PX = 20` or more. `width = height * 396 / 277.4`.
   - In dev, a `console.warn` fires when a requested size is under 20.
   - `weight` is accepted and ignored. No `fill`, no `currentColor`.
   - Because callers size icons with `className` (`size-3.5`), the component
     also ignores `size-*`/`h-*`/`w-*` in `className`. Simplest way: strip
     those classes, then set width and height attributes plus an inline style
     at the clamped values.

4. **Tests** (`icons.test.ts`):
   - It renders `<image href=…youtube-icon-red…>` and no `<path>`.
   - `size={14}` and `className="size-3"` both give a height of 20 or more.
   - Every weight gives identical markup.
   - The sha256 of the shipped svg matches the README.
   - Phosphor's `YoutubeLogo` is not re-exported anywhere (guard).
5. **`docs/icon-set.md`**: the YouTube entry says "official file, unmodified,
   20px floor, never tinted".

Done when:

- `pnpm --filter @videorc/desktop test icons` passes
- `pnpm typecheck` passes
- `pnpm check:renderer-assets` stays under its ceilings (record the numbers)

STOP if: the `pdftocairo` output is not the two-path shape above, because the
upstream art changed.

### S2: Destinations (flagged surface 5) and the other `PlatformGlyph` uses

Files:

- `components/platform-glyph.tsx`
- `streaming/destination-card.tsx:311`
- `tabs/streaming-tab.tsx:553`
- `scheduled-streams.tsx:379, 516`
- `schedule-stream-dialog.tsx:291`
- tests

1. For `youtube`, `PlatformGlyph` drops the tint tile
   (`PLATFORM_GLYPH_TINT.youtube`) and renders `YoutubeIcon` at a 20px mark
   (about 29 × 20) directly on the row background.
2. **The row's icon slot.** Find `ListRow`'s icon slot. If it is a fixed
   `size-5` square, widen it for every platform to `w-[29px]`-equivalent,
   using a shadcn/Tailwind spacing token (`w-7.5` or the closest token, ≥ 29px),
   with the platform tiles centred inside. Do not shrink the mark.
3. **YouTube Vertical:**
   - Its row shows the same mark. The 9:16 badge stays where it is, at the
     row's right end, so it is nowhere near the mark.
   - Any YouTube label stays "YouTube Vertical".
4. **Upcoming placeholder thumbnail** (`scheduled-streams.tsx:516`):
   - The mark is centred at 20px or more.
   - The box background is one solid colour. Replace `bg-foreground/5` with a
     solid theme token such as `bg-muted` if `/5` reads as a wash in either
     theme.
5. **Tests:** a `platform-glyph.test.tsx` asserting that YouTube renders
   `data-slot="platform-mark"` with a height of 20 or more, and that no
   ancestor carries `bg-platform-youtube`. Other platforms render as before.

Done when:

- the platform-glyph, destination-card, streaming-tab and scheduled-streams
  tests pass
- S5's screenshots show crisp YouTube and YouTube Vertical rows (red icon,
  white triangle) in light and dark

### S3: Stream Manager (flagged surfaces 1–4) and the other `ChatPlatformIcon` uses

Files:

- `components/chat-platform-icon.tsx`
- `comment-row.tsx`
- `stream-manager/chat-pane.tsx`
- `stream-manager/activity-pane.tsx`
- `stream-manager/stream-manager-status-bar.tsx`
- `comments-destination-status.tsx`
- `stream-manager/stats-bar.tsx`
- `removal-cards.tsx`
- `command-cards.tsx`
- `remove-messages-reconnect.tsx`
- `cohost-pane.tsx`
- `cohost-question-row.tsx`
- `orcle-report-card.tsx`
- `orcle-voice-commands.tsx`
- tests

1. **`ChatPlatformIcon` for `youtube`:**
   - Render the S1 `YoutubeIcon` at a 20px mark.
   - Remove `youtube` from `CHAT_PLATFORM_TINT`. Other platforms keep their
     tint.
   - The labelled and decorative modes (`aria-label` / `aria-hidden`) stay as
     they are.
2. **Chat rows (surface 2,** `comment-row.tsx:628`**):**
   - The mark sits inline before the author name with `gap-2`.
   - If the first line grows from 14px to 20px, align the name to the mark's
     centre with existing tokens, and keep the message line where it is.
   - Follow the dense-row rules in the `videorc-design` skill.
3. **Filter toggles (surfaces 1 and 3,** `chat-pane.tsx:399`,
   `activity-pane.tsx:412`**):**
   - The toggles are `h-6`. A 20px mark fits with 2px of vertical padding.
     Give the YouTube item the width it needs (about 29px + padding).
   - If the toggle group then overflows at the narrow Stream Manager width
     (320px, plan 047), use the text "YouTube" for that item instead.
     **Never shrink the mark.**
4. **Status bar chips (surface 4):**
   - `stream-manager-status-bar.tsx:164` shows the 20px mark if the bar
     height allows. Check the bar's height first.
   - `comments-destination-status.tsx:180, 202` puts the mark inside `Badge`,
     which forces 12px. For YouTube, render the **text** "YouTube" in the
     chip instead of the mark. Don't override Badge's rule.
5. **Activity avatar overlay** (`activity-pane.tsx:268-272`):
   - Remove the 12px badge that sits over the avatar.
   - Put the 20px mark inline before the author or title text, as in chat
     rows.
   - Update `activity-pane.test.ts:148-158`, which covers the slots around it.
6. **Dropdown items** (`chat-pane.tsx:471, 818`): use the 20px mark. The item
   height fits it. The `<image>` cannot be recoloured by the
   `focus:**:text-accent-foreground` hover rule.
7. **Remaining uses** (stats hover card, removal cards, command cards,
   reconnect list, Orcle pane, Orcle report, Orcle voice commands):
   - Use the 20px mark if the row fits it, otherwise the text "YouTube".
   - `cohost-pane.test.ts:292-293` must still find `aria-label="YouTube"`.
8. **Tests:**
   - `comment-row` renders a YouTube mark with a height of 20 or more.
   - `activity-pane` has no `absolute` platform overlay.
   - `comments-destination-status` renders "YouTube" text and no 12px svg.
   - A grep test or `rg` check finds no `ChatPlatformIcon` call with
     `size-3`/`size-3.5` for YouTube.

Done when:

- the desktop tests for these files pass
- `pnpm lint` and `pnpm typecheck` pass
- `pnpm probe:comments-window` sweeps at 320, 800 and 1280px show no clipped
  or overlapping YouTube marks

### S4: YouTube look-alikes outside React (highlight card, LAN remote)

Neither appears in Google's screenshots. Both are YouTube icons that fail the
same rule, so they are fixed now rather than flagged in a V.2 report.

Files:

- `lib/caption-overlay.ts:785-846`
- `lib/comment-highlight.ts:144-171` and `comment-highlight.test.ts:162-170`
- `crates/videorc-backend/remote_web/{app.js,app.css}`
- the LAN static-asset route in `crates/videorc-backend/src/remote_lan.rs`
  (serve the file the way `icon.svg` is served)

1. **The highlight and activity card painter:**
   - Replace the hand-drawn YouTube circle and play triangle. Load
     `youtube-icon-red.svg` once as an `ImageBitmap` and `drawImage` it
     cropped to the mark bounds.
   - Mark height in **output pixels**:
     `max(20, round(avatarPx * 0.42))`. That gives 20 or more at 720p, about
     25 at 1080p and 1080×1920, and about 50 at 4K.
   - Place it beside the identity text, not overlapping the avatar, with clear
     space of at least the triangle width.
   - Other platforms' badges stay unchanged.
2. `commentHighlightPlatformBadge('youtube')` returns an asset reference
   instead of `{ color: '#FF0033', glyph: 'play' }`. Update the test.
3. **Painter tests:** render a card at 1280×720 and at 1080×1920, and assert
   that the mark's drawn rectangle is 20px tall or more.
4. **LAN remote:**
   - Copy `youtube-icon-red.svg` into `remote_web/` and serve it.
   - The YouTube chat-row tile becomes
     `<img src="youtube-icon-red.svg" alt="YouTube" height="20">` on the row
     background.
   - Remove the white letter "Y" on `#e62117`.

Done when:

- the caption-overlay and comment-highlight tests pass
- `cargo test -p videorc-backend remote_lan` passes
- `pnpm probe:comments-window` highlight PNGs show the official icon

STOP if: the SVG will not rasterise sharply into the card's `OffscreenCanvas`.
Report it; do not fall back to a hand-drawn mark.

### S5: Evidence, reply notes, PR

1. **Gates.** The owner rule is to run them once, at the end:
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm format:check`
   - `pnpm --filter @videorc/desktop test`
   - `pnpm check:renderer-assets`
   - `cargo fmt --check --all`
   - `cargo test -p videorc-backend remote_lan`
   - `cargo clippy -p videorc-backend -- -D warnings`
   - `pnpm probe:comments-window`
   - S4 touches the burned-in overlay, so also run `pnpm smoke:recording-studio`.
     If macOS permissions block it, say exactly why, and attach the 720p and
     1080×1920 card PNGs from the painter test instead.
2. **Screenshots, before and after, light and dark.** Use
   `scripts/capture-ui-pages.mjs` / `scripts/ui-theme-screens.mjs` with fake
   YouTube chat (`liveChat.start {"fake":{"platform":"youtube"}}`) and fake
   activity. Capture each of Google's flagged views as they framed it:
   - chat with its filter toggle
   - chat rows
   - the activity filter
   - the status bar
   - the Destinations list with YouTube and YouTube Vertical

   Also capture a highlight card. Save them to
   `docs/acceptance/2026-10-xx-youtube-branding/`.

3. **`docs/compliance/youtube-tos-report-v1-reply.md`**: the reply notes.
   - **III.D.1c**: S0's answer and the facts above.
   - **III.E.4**: the factual answer below, re-checked against the code at
     merge time.
   - **III.F.2a**: what changed and the screenshots.
   - The website icon (flagged surface 6) is answered by the separate website
     fix.
4. **PR:** "Official YouTube icon at 20px or more everywhere (YouTube ToS
   report III.F.2a) (plan 165)". The description includes:
   - changed files by slice
   - asset source and hashes
   - before and after screenshots

   **Do not merge.** The owner merges and ships the release. The fix must be
   in a public build before Google gets the reply.

Done when: CI is green and the reply notes and screenshots are committed.

## III.E.4 answer: "How often do you refresh/update or delete the API Data"

These are facts from the code at `3fcc17e4`. Re-check them in S5 and reword
them for the reply; do not change them. All YouTube calls go directly from the
desktop app to Google; no Videorc server proxies them.

**Refresh:**

| Data                                        | How often                                                                                                                    | Where in code                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Live chat                                   | `max(pollingIntervalMillis, 5 s)`, rising to 10 s on empty pages, up to 30 s on errors. Never faster than Google's interval. | `youtube_chat.rs:944-972, 1335-1360`                         |
| Concurrent viewers (videos.list)            | every 120 s while live                                                                                                       | `viewer_stats.rs:28-31`                                      |
| Subscriber count (channels.list statistics) | every 300 s while live                                                                                                       | `audience.rs:29-33`                                          |
| Broadcast and stream status                 | every 60 s while live                                                                                                        | `platform_stream_watch.rs:23-32`                             |
| Channel identity (channels.list)            | at app start, Settings focus, OAuth connect and Go Live                                                                      | `studio-bootstrap.ts:50`, `use-studio.tsx:7749, 7043, 12724` |
| OAuth access token                          | before expiry                                                                                                                | `main.rs:4392-4402`                                          |

**Deletion:**

- **Disconnect** revokes the token at `https://oauth2.googleapis.com/revoke`,
  then deletes the stored tokens, the connected channel record and its stream
  key (`main.rs:11104-11199`, `storage.rs:6098-6150`).
- **Kept on the user's computer and removed when the user deletes that
  session in the Library:** chat messages and session statistics shown in
  Videorc's history.

Facts the owner should know before wording the reply (not changed by this
plan):

- When a token is revoked from Google's settings page, the app marks the
  account "Needs reconnect" and keeps the stored data
  (`main.rs:2471-2526`).
- Local chat history, scheduled-broadcast records and the avatar image cache
  have no 30-day expiry.
- The website privacy policy says YouTube data "is not retained after you
  disconnect" and is deleted on revocation in Google's settings. That is not
  what the app does today.

The owner chose to answer only what was asked. If Google follows up on E.4
retention, that becomes its own plan.

## Out of scope

- **The videorc.com website icon** (flagged surface 6). It is a separate fix.
- **Data deletion, retention, purge-on-revoke, a delete-my-data control, and
  consent recording.** Google did not raise these (owner, 2026-10-08).
- **Twitch, Kick, X, TikTok and Instagram marks.** Google did not raise these.
- **Branding-guideline items the report didn't name:** clickable logos, and
  labels for cross-platform totals.

## STOP conditions

- The official YouTube art from the brand site is not the two-path shape, or
  the conversion is not lossless.
- A flagged surface can fit neither a 20px mark nor the text "YouTube"
  without breaking its layout. Report it with a screenshot.
- The renderer asset budget would be exceeded.
- The recording smoke regresses after S4.

## Verification summary

| Slice | Proof                                                                         |
| ----- | ----------------------------------------------------------------------------- |
| S0    | Console inventory recorded in the reply notes                                 |
| S1    | icons tests (asset hash, ≥ 20 clamp, no path, no Phosphor re-export), budget  |
| S2    | platform-glyph test, screenshots of YouTube and YouTube Vertical rows         |
| S3    | component tests (≥ 20 mark, no overlay, text in Badge), probe sweeps          |
| S4    | painter test with an output-pixel bound, LAN test, probe PNGs, recording gate |
| S5    | full gates, screenshots, reply notes, green CI                                |

## As built (2026-10-08, branch `plan-165-youtube-tos`)

**S0:** the owner's console checks are still open. They are listed in
`docs/compliance/youtube-tos-report-v1-reply.md`.

**S1:**

- `assets/brand/youtube/youtube-icon-red.svg` is converted from the official
  zip. Its hashes and the conversion command are in the folder's README.
- The geometry and the 20 px floor live in `lib/youtube-mark.ts`, shared by
  `YoutubeIcon` (`icons.tsx`) and the stream card.
- `YoutubeIcon` sizes itself with inline styles, so a caller's `size-3.5` can
  no longer shrink it.
- Vite inlines the file as a data URI (1.3 KB).

**S2:**

- `PlatformGlyph` puts every platform in a 30 x 24 slot. YouTube shows its
  official icon at 20 px; the other platforms get a 24 px tile (up from
  20 px) with a 16 px glyph (up from 14 px).
- `ListRow`'s icon slot now grows (`min-h-5 min-w-5`) and never clips a
  platform mark.

**S3:**

- `ChatPlatformIcon` is 20 px for every platform. YouTube is untinted, with a
  4 px trailing margin for clear space.
- Owner feedback mid-run ("too big, make avatars bigger and the other icons
  too"):
  - Chat avatars went from 24 px to 32 px (compact) or 40 px (Stream
    Manager).
  - Activity avatars went from 28 px to 36 px.
  - Every platform's activity mark moved inline on the name line; no platform
    has an avatar overlay any more.
  - A second owner call ("ugly in Stream Manager"): in chat and activity rows,
    the platform mark now closes the name line on the far right, after the
    status chips and time, so names line up beside the avatars. The
    on-stream highlight card follows suit: the mark sits on the card's right
    edge on the name row.
- Badge chips (`comments-destination-status.tsx`) drop the YouTube mark and
  keep the word "YouTube", because a Badge forces 12 px.

**S4:**

- The highlight card draws the official file at 20 px or more (output
  pixels) between the avatar and the name, and the name loses its
  "YouTube ·" prefix.
- If the file fails to load, the card falls back to the words, never to a
  redrawn mark.
- The phone remote serves the same file at `/youtube-icon.svg`
  (`include_str!` of the one copy) and shows it at 20 px in place of the
  letter tile.

**S5:**

- Before and after screenshots are in
  `docs/acceptance/2026-10-08-youtube-branding/`.
- The reply notes are in `docs/compliance/youtube-tos-report-v1-reply.md`.
- The Studio chat rail no longer exists, and the Orcle tab shows no platform
  marks, so neither was captured.
