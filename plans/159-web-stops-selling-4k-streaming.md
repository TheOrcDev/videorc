# Plan 159: The website stops selling 4K streaming as Premium

- **Repo**: `~/projects/videorcweb` (private sibling, `main` branch-protected,
  PR-per-plan). Nothing in this repo changes except this plan and the Plan 075
  ledger line.
- **Parent**: [Plan 075](075-free-4k-live-streaming.md) W1–W3, never executed.
- **Effort**: S–M (copy + one policy constant + tests). No schema, token, or
  API-shape change.
- **Risk**: LOW. The desktop ignores the web's streaming limits, so no app
  behaviour can change. The risk is copy drift and broken copy tests.
- **Owner route / lane**: Implementation with UI/Product-Design taste,
  fit 8 → `opus-4.8` (cosmetic, user-facing copy).
- **Planned at**: videorcweb `origin/main` `7c355e6e` (2026-10-05), desktop
  `origin/main` as of 2026-10-07.
- **Status**: EXECUTED 2026-10-07: S1–S6 pushed straight to videorcweb `main`
  (owner instruction) and deployed to production; S7 verified. See the ledger.

## Why

Plan 075 (#494) made 4K and 1080p60 live streaming free on every plan. It
shipped in macOS 0.9.122 (2026-09-29) and has been on macOS, Windows, and Linux
since 0.9.136. The desktop enforces one streaming ceiling for every tier:
`crates/videorc-backend/src/entitlements.rs` `entitlement_limits()` and
`apps/desktop/src/renderer/src/lib/entitlements.ts` `STREAMING_LIMITS`
(3840×2160, 60 fps, 30000 kbps, 5 destinations).

The website still sells streaming quality as Premium in about 30 places: the
pricing card, the homepage Premium section, the footer, the FAQ, the account
upsells, metadata, `llms.txt`, five blog posts, and the Terms. Plan 075
required that the web "must not lag a shipped desktop release". It has lagged
by eight days.

## What is true (copy must match this, nothing more)

Source: desktop `capture.ts` `streamPlatformOutputCapabilities` and
`providerSafeSharedProfile`.

| Situation | Every plan gets |
| --- | --- |
| Single stream to YouTube | up to 4K30 (exact `stream-youtube-4k30` profile) or 1080p60 |
| Single stream to Twitch / Kick | up to 1080p60, 6000 kbps |
| Single stream to X / TikTok | up to 1080p30, 6000 kbps |
| Multistream (shared encode) | provider-safe 1080p at 6000 kbps, same picture everywhere |
| 4K60 streaming | not offered on any plan |
| Local recording | up to 4K60 (already free; unchanged) |

Approved one-line claim: **"Free live streaming up to 4K30 on YouTube and
1080p on other platforms."** Keep the site's existing OS framing: macOS Beta
states it, and Windows and Linux Alpha point to their release notes.

Premium is now **live captions (early alpha), Orcle Live, Orcle voice
commands, Clean cut, and Noise cleanup**. It sells nothing about resolution,
frame rate, bitrate, or destinations.

## Out of scope

- The Ed25519 entitlement token and the `/api/ai/capabilities` response shape
  stay as they are. Only the *values* of the Basic streaming limits change (S1).
- The existing "multistreams at 1080p30" claims. The desktop can also send a
  shared 1080p60 encode (`stream-safe-1080p60`), so that claim is
  conservative, not false. Leave it alone; a later copy plan can revisit it.
- Price, intervals, and Creem products. Historical changelog entries
  (`0.9.8-beta.1` "4K streaming stays Premium") stay as history.
- Desktop code.

## Owner decisions (D0, before S6 ships)

1. **Terms wording** (`app/terms/page.tsx:45`): a legal surface. The
   recommended replacement is in S6. The owner approves the exact sentence.
2. **Homepage Premium section**: removing the 4K pillar leaves one card in a
   two-column grid. Recommended: replace it with a **Live captions** pillar,
   using the existing studio screenshot as a stand-in image until a captions
   screenshot exists.
3. **Creem product description**: owner-only dashboard check. If it lists 4K
   or streaming quality, edit it in Creem. There is no repo change for this.

## Slices

Run S1 → S7 in one videorcweb worktree and one PR. Each slice leaves `pnpm test`
green.

### S1 — One streaming ceiling in the policy

`lib/entitlements/policy.ts`:
- Add `STREAMING_LIMITS` (or inline shared values) mirroring the desktop:
  `streamingMaxWidth: 3840`, `streamingMaxHeight: 2160`, `streamingMaxFps: 60`,
  `streamingMaxBitrateKbps: 30000`, `streamingMaxDestinations: 5`. Spread it
  into both `BASIC_LIMITS` and `PREMIUM_LIMITS`. Premium's fps rises from 30 to
  60 to match the desktop. Rewrite the header comment ("Only streaming quality
  is tiered…"): tiers now differ only in cloud features.
- `lib/entitlements/snapshot.ts` needs no change (it reads the policy).

Derived copy that silently changes meaning once the Basic numbers move. Fix it
in the same slice:
- `lib/multistream-guide.ts`: add `MULTISTREAM_SHARED_BITRATE_KBPS = 6000`
  (comment: mirrors the desktop `providerSafeSharedProfile`). Use it at :31
  (free point title) and :158 (the upload-speed FAQ, whose "36 Mbps for six"
  maths depends on 6000). `MULTISTREAM_PLAN_ROWS`: delete the
  "Single-stream ceiling" and "Bitrate ceiling" rows, or set both columns to
  the same value. Recommended: one row, "Single-stream quality", value "4K30 on
  YouTube, 1080p elsewhere" in both columns. FAQ :154: drop "4K30 or 1080p60
  for a single stream" from the Premium answer.
- `lib/structured-data.ts:112-125`: the Basic line would now read
  "multistreaming … up to 3840×2160 at 60 fps", which is false. Rewrite it as
  three facts: free multistreaming to 6+ destinations at 1080p30; free live
  streaming up to 4K30 on YouTube (hard-coded, not derived from the limits);
  free recording up to the recording limits. Delete the "Premium: streaming up
  to …" line.

**Done when**: `tests/entitlements.test.ts` asserts Basic and Premium have
identical streaming limits equal to the desktop values. The multistream guide
still says 6000 kbps and 36 Mbps. `pnpm test` passes.

### S2 — Pricing data, pricing card, account page

- `lib/pricing.ts`: delete `STREAMING_QUALITY_FEATURE` and remove it from
  `PREMIUM_PLAN.features`. Update the comment above it.
- `components/pricing.tsx`: in the Open Source tier, add a bullet after the
  multistream bullet: "macOS Beta: live streaming up to 4K30 on YouTube,
  1080p on other platforms". Heading description :203: "…includes 4K
  recording, 4K streaming to YouTube, and multistreaming to 6+ destinations.
  Premium adds live captions, Orcle Live, and Clean cut…".
- `lib/account/plan-features.ts`: delete the streaming entry from
  `getPremiumAccountFeatures` and the `STREAMING_QUALITY_FEATURE` filter.
  Decide whether the "recording" entry still belongs in a *Premium* list (it is
  free too). Recommended: drop it as well, so the Premium list only names
  Premium things.
- `app/account/page.tsx:115` and
  `components/account/subscription-summary.tsx:91`: change "Unlock 4K
  streaming, live captions, and cloud AI" to "Unlock live captions, Orcle, and
  Clean cut".
- Tests: in `tests/account-plan-features.test.ts:72-75`, replace the
  `features[0]` streaming-title assertion with "no Premium feature mentions
  streaming quality". Rewrite `tests/structured-data.test.ts:228-239` ("Premium
  copy states the truth…") so it asserts that no `PREMIUM_PLAN.features` entry
  matches `/4K|1080p|60 ?fps|stream(ing)? quality|ceiling/i` and that
  `LIVE_COHOST_FEATURE` stays listed.

**Done when**: the pricing card's Premium column has five bullets and none
mentions resolution. The free column mentions 4K streaming. Tests pass.

### S3 — Homepage and shared marketing components

- `components/premium.tsx`: replace the 4K pillar (D0.2). Update the comment
  and the heading description :49 to "…Premium adds live captions and Orcle,
  Videorc's AI…".
- `components/features.tsx:85`: "the free studio records in 4K, streams in 4K
  to YouTube, and multistreams to 6+ platforms at once. Premium adds early live
  captions, Orcle Live, and Clean cut."
- `components/features.tsx:34` (streaming feature body): add the single-stream
  4K30-on-YouTube fact next to the 6+-destination claim.
- `components/final-cta.tsx:153`, `components/blog/blog-final-cta.tsx:16`,
  `components/footer.tsx:69-71`: drop "4K streaming" from every Premium /
  "Upgrade when you need" list.
- `components/faq.tsx:20`: "Premium funds live captions and Orcle, Videorc's
  AI." Consider adding an FAQ entry, "Is 4K streaming free?", with the
  approved one-line claim.
- `app/premium/page.tsx:114`: "…plus the features with a server bill attached."
  (drop "or a quality ceiling").

**Done when**: `git grep -n -i -E 'premium[^.]{0,80}(4k|1080p60)|4k streaming'
-- components app` returns only free-side claims. Read each remaining hit
in context.

### S4 — Metadata, OG, and `llms.txt`

- `lib/metadata.ts:25` (site description), `:370` (Premium description),
  `:375` (Premium keyword "4K streaming": move it to the home or multistream
  keyword list as "free 4K streaming"), and `:383` (Premium title: "Videorc
  Premium: Live Captions, Orcle AI, Clean Cut").
- `public/llms.txt:32-33`: add free streaming up to 4K30 on YouTube to the Free
  line. Remove "4K30 or 1080p60 streaming for a single stream" from the
  Premium line.
- `lib/og-image.tsx`: no change needed (its "1080p30 free" is the multistream
  card). Check the Premium OG variant, if one exists, for 4K.

**Done when**: the rendered `<title>`/description of `/` and `/premium` (curl
`pnpm build && pnpm start`, or the Vercel preview) no longer pairs Premium
with 4K.

### S5 — Blog posts and their FAQ mirrors

These five MDX posts each repeat "Premium is 4K streaming, captions, and AI
publish. Not more destinations.":
`best-free-multistream-software-for-mac.mdx` (:10, :70, :89),
`free-multistream-comparison.mdx` (:14, :68),
`how-to-multistream-for-free.mdx` (:87),
`obs-vs-videorc-for-multistream.mdx` (:15, :53, :118),
`record-and-go-live-same-take.mdx` (:11, :90).

Change each to "Premium is live captions and Orcle, Videorc's AI. Not more
destinations, not more quality." Where a post compares single-stream quality,
state that 4K30 to YouTube is free. Mirror every FAQ change in
`lib/blog/posts.ts` (:158, :202, :259, :354, :411), because `tests/blog.test.ts`
compares them. Keep the phrases that test pins ("Not more destinations",
"free multistream to 6+ at 1080p30", "6+ destinations at 1080p30").

Also update each post's `updatedAt`/`dateModified` front-matter if the blog
uses it, so the structured data shows the change.

**Done when**: `pnpm test` passes (blog tests included), and `git grep -n -i
'4k streaming\|single-stream quality ceiling' -- content lib/blog` only hits
free-side claims.

### S6 — Terms and a regression guard

- `app/terms/page.tsx:45` (after D0.1), recommended: "Livestreaming,
  multistreaming, and streaming quality up to 4K are free and run from your
  computer. A paid Premium subscription adds live captions and Orcle,
  Videorc's AI: Orcle Live for your streams and Clean cut for your
  recordings." If the page has a "last updated" date, bump it.
- New test `tests/premium-copy.test.ts`: scan `components/`, `app/`, `lib/`,
  `content/`, and `public/llms.txt`. Fail on
  `/premium[^.\n]{0,80}\b(4K|1080p60)\b/i` and on `/4K streaming/i` unless the
  same sentence contains "free". Allow-list the historical changelog. Model it
  on the existing "Premium never sells destinations" guards in
  `tests/blog.test.ts`.

**Done when**: reintroducing "Premium adds 4K streaming" anywhere makes
`pnpm test` fail.

### S7 — Ship and verify

1. Gates in the web worktree: `pnpm typecheck`, `pnpm lint`,
   `pnpm format:check`, `pnpm test`, and `pnpm build` (the build runs the DB
   migrate step, so run it with the repo's local env, or rely on the Vercel
   preview build).
2. Open the videorcweb PR. Check by eye on the Vercel preview: `/` (Premium
   section and pricing), `/premium`, `/multistream`, `/account` (signed-in
   Basic), one blog post, `/terms`, and `/llms.txt`.
3. Merge. After deploy, curl production `/`, `/premium`, and `/llms.txt`, and
   grep for "4K".
4. Desktop repo: update the Plan 075 status line (W1–W2 done via this PR; W3
   changelog already published as `0.9.122-alpha.1`). Add a `plans/README.md`
   entry.
5. Owner: the Creem description check (D0.3).

## Verification summary

| Gate | Proves |
| --- | --- |
| `tests/entitlements.test.ts` | Basic = Premium streaming limits = desktop values |
| `tests/structured-data.test.ts`, `tests/account-plan-features.test.ts` | Premium lists sell no quality |
| `tests/blog.test.ts` | FAQ mirrors still match; destination guards still hold |
| `tests/premium-copy.test.ts` (new) | No future copy sells 4K as Premium |
| Vercel preview by eye + production curl | What users actually see |

## Ledger

Owner instruction (2026-10-07): "execute the entire plan, commit and push to
main after each slice". D0.1 and D0.2 used the recommended options.

| Slice | Status | Evidence |
| --- | --- | --- |
| S1 | DONE | videorcweb `641c6e9c`: shared `STREAMING_LIMITS` (3840×2160, 60 fps, 30000 kbps, 5); `MULTISTREAM_SHARED_BITRATE_KBPS` keeps the 6000 kbps / 36 Mbps advice; one "Single-stream quality" row; JSON-LD lists free 4K30 on YouTube; also fixed the `/multistream` "Free vs Premium" heading. |
| S2 | DONE | `a1445d84`: `STREAMING_QUALITY_FEATURE` deleted; free card gains the 4K30-on-YouTube bullet; the account Premium list drops streaming and recording entries; both upgrade prompts reworded. |
| S3 | DONE | `23d570e0`: the 4K pillar became a Live captions pillar (the duplicate captions strip folded in); features, CTAs, footer, FAQ ("What is free?", "Does Videorc record and stream in 4K?"), and the `/premium` heading. |
| S4 | DONE | `fec34916`: `/premium` title "Live Captions, Orcle AI, Clean Cut"; descriptions and keywords; `llms.txt`. The OG images needed no change. |
| S5 | DONE | `16cd32ed`: five posts plus the `posts.ts` FAQ mirrors; the Twitch + YouTube table row relabelled; `updatedAt` 2026-10-07 on six posts. |
| S6 | DONE | `b339c1fb`: Terms (updated October 7, 2026) uses the recommended sentence; `tests/premium-copy.test.ts` fails on the pre-plan tree (`7c355e6e`) and passes now. |
| S7 | DONE | Gates: `pnpm test` 751 pass, `typecheck` and `lint` (0 errors), `next build` green; touched files pass Prettier (`tests/blog.test.ts` was already unformatted on main). The Vercel production deploy of `b339c1fb` succeeded. Production curl of `/`, `/premium`, `/multistream`, `/terms`, `/llms.txt`, and two posts finds no Premium-4K claim. `/changelog` shows the 0.9.122 "4K and 1080p60 streaming are free" entry (Plan 075 W3). |
| D0.3 | OWED | Owner checks the Creem product description for 4K or streaming-quality claims. |

Left as history on purpose: the `0.9.92-beta.1` release note still says
"Premium keeps … 1080p60 / 4K30 streaming". It was true when it shipped.
